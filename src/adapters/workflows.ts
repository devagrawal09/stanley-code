/**
 * Repository workflow discovery and loading.
 *
 * Discovery follows OpenCode's model inside `.stanley/workflows/`: direct `.ts` and `.js` files are workflows,
 * and each subdirectory is a workflow package whose entrypoint comes from its package.json (`exports`, `module`,
 * `main`) or falls back to `index.ts` / `index.js`. Modules are imported through `tsx`, so ordinary TypeScript
 * works.
 *
 * Any workflow that cannot be resolved, fails to import, whose factory throws, or whose result fails
 * control-envelope validation is quarantined: a diagnostic is returned, a visible warning is emitted, and loading
 * continues. Duplicate ids are not handled here; registration rejects them.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, readlink, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { sha256 } from "../core/hash.ts";
import {
  createWorkflowLog,
  validateWorkflow,
  validateWorkflowFactory,
  type Workflow,
  type WorkflowLogRecord,
} from "../core/workflow.ts";
import { safeMessage } from "./redact.ts";

/** Repository-relative workflow directory. */
export const WORKFLOW_DIRECTORY = ".stanley/workflows";

const DIRECT_EXTENSIONS = new Set([".ts", ".js"]);
const INDEX_ENTRIES = ["index.ts", "index.js"];

export interface WorkflowSource {
  /** Repository-relative POSIX path of the workflow file or package directory. */
  readonly path: string;
  readonly kind: "file" | "package";
  /** Absolute path of the module to import. */
  readonly entry: string;
}

export type WorkflowLoadPhase = "discover" | "import" | "factory" | "validate";

export interface WorkflowDiagnostic {
  readonly source: string;
  readonly phase: WorkflowLoadPhase;
  readonly message: string;
}

export interface LoadedWorkflow {
  readonly workflow: Workflow;
  readonly source: WorkflowSource;
}

export interface WorkflowDiscovery {
  readonly sources: readonly WorkflowSource[];
  readonly diagnostics: readonly WorkflowDiagnostic[];
}

export interface WorkflowLoadResult {
  readonly loaded: readonly LoadedWorkflow[];
  readonly quarantined: readonly WorkflowDiagnostic[];
}

export interface LoadWorkflowsOptions {
  /** Repository root. It is canonicalized before being handed to workflows. */
  readonly root: string;
  /** Repository-relative directory to discover in. Defaults to the active workflow directory. */
  readonly directory?: string;
  readonly signal?: AbortSignal;
  /** Receives structured workflow log records. Defaults to discarding them. */
  readonly log?: (record: WorkflowLogRecord) => void;
  /** Receives visible warnings for quarantined workflows. Defaults to stderr. */
  readonly warn?: (message: string) => void;
}

const toPosix = (path: string) => path.split(sep).join("/");
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isContained = (parent: string, child: string) => {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
const defaultWarn = (message: string) => {
  process.stderr.write(`${safeMessage(message, 2_000)}\n`);
};

export function formatWorkflowDiagnostic(diagnostic: WorkflowDiagnostic): string {
  return `stanley: warning: workflow ${diagnostic.source} quarantined (${diagnostic.phase}): ${diagnostic.message}`;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** The package.json-declared entry, if any: `exports` (string or "." with import/default), `module`, `main`. */
function declaredEntry(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const pkg = manifest as Record<string, unknown>;
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const conditions = value as Record<string, unknown>;
      if ("." in conditions) return pick(conditions["."]);
      return pick(conditions.import) ?? pick(conditions.default);
    }
    return undefined;
  };
  return pick(pkg.exports) ?? pick(pkg.module) ?? pick(pkg.main);
}

async function packageEntry(directory: string): Promise<{ entry?: string; error?: string }> {
  const packageRoot = await realpath(directory);
  const entryIfContained = async (name: string) => {
    const candidate = resolve(directory, name);
    if (!isContained(directory, candidate)) return undefined;
    if (!(await isFile(candidate))) return undefined;
    const resolved = await realpath(candidate);
    if (!isContained(packageRoot, resolved)) return undefined;
    return candidate;
  };
  const manifestPath = join(directory, "package.json");
  if (await isFile(manifestPath)) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      return { error: `invalid package.json: ${messageOf(error)}` };
    }
    const declared = declaredEntry(manifest);
    if (declared !== undefined) {
      const entry = await entryIfContained(declared);
      return entry
        ? { entry }
        : { error: `package entrypoint not found or escapes its directory: ${declared}` };
    }
  }
  for (const name of INDEX_ENTRIES) {
    const entry = await entryIfContained(name);
    if (entry) return { entry };
  }
  return {
    error: `no package entrypoint (package.json exports/module/main, or ${INDEX_ENTRIES.join(" / ")})`,
  };
}

/**
 * Discover workflow sources in `<root>/<relativeDirectory>` (default `.stanley/workflows`), sorted by name. A
 * missing directory yields none. Improvement candidates are discovered the same way from their staging directory.
 */
export async function discoverWorkflows(
  root: string,
  relativeDirectory: string = WORKFLOW_DIRECTORY,
): Promise<WorkflowDiscovery> {
  const directory = join(root, relativeDirectory);
  let names: string[];
  try {
    names = (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sources: [], diagnostics: [] };
    return {
      sources: [],
      diagnostics: [{ source: relativeDirectory, phase: "discover", message: messageOf(error) }],
    };
  }
  let canonicalRoot: string;
  let workflowRoot: string;
  try {
    canonicalRoot = await realpath(root);
    workflowRoot = await realpath(directory);
  } catch (error) {
    return {
      sources: [],
      diagnostics: [{ source: relativeDirectory, phase: "discover", message: messageOf(error) }],
    };
  }
  if (!isContained(canonicalRoot, workflowRoot)) {
    return {
      sources: [],
      diagnostics: [
        {
          source: relativeDirectory,
          phase: "discover",
          message: "workflow directory escapes the repository",
        },
      ],
    };
  }
  const sources: WorkflowSource[] = [];
  const diagnostics: WorkflowDiagnostic[] = [];
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const path = join(directory, name);
    const source = toPosix(relative(root, path));
    let info: Awaited<ReturnType<typeof stat>>;
    let physical: string;
    try {
      info = await stat(path);
      physical = await realpath(path);
    } catch (error) {
      diagnostics.push({ source, phase: "discover", message: messageOf(error) });
      continue;
    }
    if (!isContained(workflowRoot, physical)) {
      diagnostics.push({ source, phase: "discover", message: "workflow source escapes its directory" });
      continue;
    }
    if (info.isFile()) {
      if (DIRECT_EXTENSIONS.has(extname(name)) && !name.endsWith(".d.ts")) {
        sources.push({ path: source, kind: "file", entry: path });
      }
    } else if (info.isDirectory()) {
      try {
        const resolved = await packageEntry(path);
        if (resolved.entry) sources.push({ path: source, kind: "package", entry: resolved.entry });
        else {
          diagnostics.push({
            source,
            phase: "discover",
            message: resolved.error ?? "unresolvable package",
          });
        }
      } catch (error) {
        diagnostics.push({ source, phase: "discover", message: messageOf(error) });
      }
    }
  }
  return { sources, diagnostics };
}

/**
 * Content hashes of every file under the workflow directory, keyed by repository-relative POSIX path. A symlink
 * is fingerprinted by its target and never followed, so a link an agent plants there is detected like a file.
 */
export async function workflowDirectoryFingerprint(
  root: string,
  relativeDirectory: string = WORKFLOW_DIRECTORY,
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) fingerprint.set(toPosix(relative(root, path)), sha256(await readFile(path)));
      else if (entry.isSymbolicLink()) {
        fingerprint.set(toPosix(relative(root, path)), sha256(`symlink:${await readlink(path)}`));
      }
    }
  };
  await walk(join(root, relativeDirectory));
  return fingerprint;
}

export interface WorkflowDirectoryChanges {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly removed: readonly string[];
}

/** Paths that differ between two fingerprints. */
export function workflowDirectoryChanges(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WorkflowDirectoryChanges {
  const added: string[] = [];
  const modified: string[] = [];
  const removed: string[] = [];
  for (const [path, hash] of after) {
    const previous = before.get(path);
    if (previous === undefined) added.push(path);
    else if (previous !== hash) modified.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) removed.push(path);
  return { added, modified, removed };
}

/**
 * The module's default export. A `.ts` file outside an ESM package is compiled as CommonJS, in which case the
 * namespace default is `module.exports`; for transpiled ES modules (`__esModule`) the author's default export sits
 * one level deeper. A plain CommonJS `module.exports = factory` is used as-is.
 */
function defaultExport(namespace: Record<string, unknown>): unknown {
  const value = namespace.default;
  if (
    "module.exports" in namespace &&
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__esModule === true
  ) {
    return (value as Record<string, unknown>).default;
  }
  return value;
}

async function discardPartial(value: unknown): Promise<void> {
  if (typeof value !== "object" || value === null) return;
  try {
    const cleanup = (value as Record<string, unknown>).cleanup;
    if (typeof cleanup !== "function") return;
    await cleanup.call(value);
  } catch {
    // The workflow is already quarantined; its original failure is the diagnostic that matters.
  }
}

/** Run every loaded workflow's cleanup, in reverse load order. Failures are reported but do not stop others. */
export async function cleanupWorkflows(
  loaded: readonly LoadedWorkflow[],
  warn: (message: string) => void = defaultWarn,
): Promise<void> {
  for (const { workflow, source } of [...loaded].reverse()) {
    try {
      const cleanup = workflow.cleanup;
      if (typeof cleanup !== "function") continue;
      await cleanup.call(workflow);
    } catch (error) {
      warn(`stanley: warning: workflow ${source.path} cleanup failed: ${messageOf(error)}`);
    }
  }
}

/**
 * Discover, import, initialize, and validate repository workflows in name order. Failures are quarantined with a
 * visible warning. If the signal aborts, already-initialized workflows are cleaned up and the abort is rethrown.
 */
export async function loadWorkflows(options: LoadWorkflowsOptions): Promise<WorkflowLoadResult> {
  const warn = options.warn ?? defaultWarn;
  const sink = options.log ?? (() => {});
  const signal = options.signal ?? new AbortController().signal;
  const root = await realpath(options.root);
  const discovery = await discoverWorkflows(root, options.directory);
  const loaded: LoadedWorkflow[] = [];
  const quarantined: WorkflowDiagnostic[] = [...discovery.diagnostics];
  const quarantine = (diagnostic: WorkflowDiagnostic) => {
    quarantined.push(diagnostic);
    warn(formatWorkflowDiagnostic(diagnostic));
  };
  for (const diagnostic of discovery.diagnostics) warn(formatWorkflowDiagnostic(diagnostic));

  try {
    for (const source of discovery.sources) {
      signal.throwIfAborted();
      let namespace: Record<string, unknown>;
      try {
        namespace = await tsImport(pathToFileURL(source.entry).href, { parentURL: import.meta.url });
      } catch (error) {
        quarantine({ source: source.path, phase: "import", message: messageOf(error) });
        continue;
      }
      let factory: ReturnType<typeof validateWorkflowFactory>;
      try {
        factory = validateWorkflowFactory(defaultExport(namespace));
      } catch (error) {
        quarantine({ source: source.path, phase: "validate", message: messageOf(error) });
        continue;
      }
      let value: unknown;
      try {
        const initialized: unknown = factory({ root, signal, log: createWorkflowLog(source.path, sink) });
        if (
          (typeof initialized !== "object" && typeof initialized !== "function") ||
          initialized === null ||
          typeof (initialized as { then?: unknown }).then !== "function"
        ) {
          throw new Error("default factory must return a Promise");
        }
        value = await initialized;
      } catch (error) {
        signal.throwIfAborted();
        quarantine({ source: source.path, phase: "factory", message: messageOf(error) });
        continue;
      }
      try {
        loaded.push({ workflow: validateWorkflow(value), source });
      } catch (error) {
        await discardPartial(value);
        quarantine({ source: source.path, phase: "validate", message: messageOf(error) });
      }
    }
    signal.throwIfAborted();
  } catch (error) {
    await cleanupWorkflows(loaded, warn);
    throw error;
  }
  return { loaded, quarantined };
}
