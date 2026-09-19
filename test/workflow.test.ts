import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import {
  cleanupWorkflows,
  discoverWorkflows,
  formatWorkflowDiagnostic,
  loadWorkflows,
  WORKFLOW_DIRECTORY,
} from "../src/adapters/workflows.ts";
import { BUILTINS, builtinWorkflows } from "../src/cli/builtins.ts";
import {
  createRegistry,
  DuplicateWorkflowIdError,
  ReservedWorkflowIdError,
  registerRepositoryWorkflows,
  WorkflowRegistry,
} from "../src/cli/registry.ts";
import { PROMPT_LIMITS, WorkflowRuntime } from "../src/cli/runtime.ts";
import {
  createWorkflowLog,
  isPromptResult,
  isWorkflowValue,
  validateWorkflow,
  validateWorkflowFactory,
  type Workflow,
  type WorkflowLogRecord,
  WorkflowValidationError,
  workflowResult,
  workflowRoutingMetadata,
} from "../src/core/workflow.ts";
import { fake, options, tempRepo } from "./helpers.ts";

const run = async () => "ok";

/** The built-ins bound to a throwaway host; enough to register and route, never run. */
function builtins() {
  const repo = tempRepo();
  roots.push(repo.root);
  return builtinWorkflows({
    run: options(repo.root, fake()),
    selection: { scope: "worktree" },
    supplied: null,
  });
}

// ---------------------------------------------------------------------------
// Control-envelope validation
// ---------------------------------------------------------------------------

describe("workflow control envelope", () => {
  test("requires only id and run, and preserves arbitrary JSON routing fields", () => {
    const routing = {
      purpose: "release notes",
      examples: ["write a changelog"],
      weight: 2,
      nested: { a: null },
    };
    const value = { id: "release-notes", run, routing, anything: "else" };
    const workflow = validateWorkflow(value);
    assert.equal(workflow, value);
    assert.deepEqual(workflow.routing, routing);
    assert.deepEqual(workflowRoutingMetadata(workflow), { routing, anything: "else" });
    assert.doesNotThrow(() => validateWorkflow({ id: "minimal", run }));
  });

  test("available is a control field, not routing metadata", () => {
    const workflow = validateWorkflow({
      id: "gated",
      run,
      available: (facts: { diff: string }) => facts.diff === "present",
      instructions: "when gated",
    });
    assert.deepEqual(workflowRoutingMetadata(workflow), { instructions: "when gated" });
    assert.throws(() => validateWorkflow({ id: "a", run, available: true }), /workflow\.available must be/);
  });

  test("workflows cannot declare CLI options", () => {
    for (const options of [["input"], [], "top", { top: 3 }]) {
      assert.throws(
        () => validateWorkflow({ id: "a", run, options }),
        /workflow\.options is not supported: workflows cannot declare CLI options/,
        JSON.stringify(options),
      );
    }
  });

  test("rejects non-JSON routing fields and non-JSON run results", () => {
    assert.throws(
      () => validateWorkflow({ id: "bad-metadata", run, helper: () => null }),
      /workflow\.helper must be JSON routing metadata/,
    );
    assert.deepEqual(workflowResult({ ok: true }), { status: "complete", output: { ok: true } });
    assert.throws(() => workflowResult(undefined), /workflow\.run must return text or JSON/);
  });

  test("a returned { status, output } envelope sets the status; anything else is a complete value", () => {
    assert.deepEqual(workflowResult({ status: "incomplete", output: "partial" }), {
      status: "incomplete",
      output: "partial",
    });
    assert.ok(isPromptResult({ status: "unsupported", output: { text: "no" } }));
    for (const value of [
      { status: "ok", output: 1 },
      { status: "complete", output: 1, extra: true },
      { status: "complete" },
      { status: "complete", output: undefined },
    ]) {
      assert.ok(!isPromptResult(value), JSON.stringify(value));
    }
    assert.deepEqual(workflowResult({ status: "ok", output: 1 }), {
      status: "complete",
      output: { status: "ok", output: 1 },
    });
  });

  test("accepts class instances whose run lives on the prototype", () => {
    class Notes {
      readonly id = "classy";
      run() {
        return "ok";
      }
    }
    assert.doesNotThrow(() => validateWorkflow(new Notes()));
  });

  test("accepts an optional cleanup function and rejects a non-function cleanup", () => {
    assert.doesNotThrow(() => validateWorkflow({ id: "a", run, cleanup: async () => {} }));
    assert.doesNotThrow(() => validateWorkflow({ id: "a", run, cleanup: undefined }));
    for (const cleanup of [null, "close", 1, {}]) {
      assert.throws(
        () => validateWorkflow({ id: "a", run, cleanup }),
        /workflow\.cleanup must be a function/,
      );
    }
  });

  test("rejects non-object workflows", () => {
    for (const value of [null, undefined, "workflow", 42, [], true, run]) {
      assert.throws(() => validateWorkflow(value), WorkflowValidationError);
    }
  });

  test("accepts lowercase ids up to 64 characters and rejects others", () => {
    for (const id of ["a", "my-workflow", "check_task", "a0-b1_c2", "z".repeat(64)]) {
      assert.doesNotThrow(() => validateWorkflow({ id, run }), id);
    }
    for (const id of ["", "UPPER", "has space", "0digit", "-dash", "a".repeat(65), "a.b", null, 42, {}]) {
      assert.throws(() => validateWorkflow({ id, run }), /workflow\.id must match/, String(id));
    }
  });

  test("rejects a missing or non-function run", () => {
    for (const value of [undefined, "run", null, {}]) {
      assert.throws(() => validateWorkflow({ id: "a", run: value }), /workflow\.run must be a function/);
    }
  });

  test("factories must be functions", () => {
    const factory = async () => ({ id: "a", run });
    assert.equal(validateWorkflowFactory(factory), factory);
    for (const value of [undefined, null, { id: "a", run }, "factory"]) {
      assert.throws(() => validateWorkflowFactory(value), /default export must be an async factory function/);
    }
  });
});

describe("opaque workflow values", () => {
  test("text and arbitrary JSON are workflow values", () => {
    for (const value of [
      "",
      "text",
      0,
      -1.5,
      true,
      null,
      [],
      {},
      [1, "a", { b: [null] }],
      { deep: { x: [1] } },
    ]) {
      assert.ok(isWorkflowValue(value), JSON.stringify(value));
    }
    const shared = { x: 1 };
    assert.ok(isWorkflowValue({ a: shared, b: shared }), "shared acyclic references are fine");
    assert.ok(isWorkflowValue(Object.create(null)));
  });

  test("non-JSON values are rejected", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      undefined,
      run,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      1n,
      Symbol("s"),
      new Date(),
      new Map(),
      cyclic,
      [undefined],
      { f: run },
    ]) {
      assert.ok(!isWorkflowValue(value), String(typeof value));
    }
  });
});

describe("workflow log", () => {
  test("emits structured records attributed to the workflow source", () => {
    const records: WorkflowLogRecord[] = [];
    const log = createWorkflowLog(".stanley/workflows/a.ts", (record) => records.push(record));
    log.info("started", { files: 2 });
    log.warn("careful");
    log.debug("d");
    log.error("e", null);
    assert.deepEqual(records, [
      { level: "info", source: ".stanley/workflows/a.ts", message: "started", data: { files: 2 } },
      { level: "warn", source: ".stanley/workflows/a.ts", message: "careful" },
      { level: "debug", source: ".stanley/workflows/a.ts", message: "d" },
      { level: "error", source: ".stanley/workflows/a.ts", message: "e", data: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Workflow registry
// ---------------------------------------------------------------------------

describe("workflow registry", () => {
  test("registers and retrieves candidates in insertion order", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "alpha", run, instructions: "when Alpha" }, "builtin");
    registry.register({ id: "beta", run, examples: ["Beta"] }, "repository", "beta.ts");

    assert.equal(registry.size, 2);
    assert.ok(registry.has("alpha"));
    assert.ok(!registry.has("gamma"));
    assert.deepEqual(registry.ids(), ["alpha", "beta"]);
    assert.equal(registry.kindOf("alpha"), "builtin");
    assert.equal(registry.kindOf("beta"), "repository");
    assert.equal(registry.kindOf("gamma"), undefined);
    assert.deepEqual(registry.candidates(), [
      { id: "alpha", routing: { instructions: "when Alpha" } },
      { id: "beta", routing: { examples: ["Beta"] } },
    ]);
    assert.equal(registry.get("beta")?.origin, "beta.ts");
  });

  test("capabilities come from each workflow's own available gate, minus exclusions", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "always", run }, "repository", "a.ts");
    registry.register(
      { id: "needs_diff", run, available: (facts) => facts.diff === "present" },
      "repository",
      "b.ts",
    );
    registry.register(
      { id: "needs_log", run, available: (facts) => facts.input === "failure_log" },
      "repository",
      "c.ts",
    );
    assert.deepEqual(registry.capabilities({ diff: "absent", input: "none" }), {
      always: true,
      needs_diff: false,
      needs_log: false,
    });
    assert.deepEqual(registry.capabilities({ diff: "present", input: "failure_log" }, new Set(["always"])), {
      always: false,
      needs_diff: true,
      needs_log: true,
    });
  });

  test("rejects duplicate ids", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "x", run, instructions: "when X" }, "builtin");
    assert.throws(
      () => registry.register({ id: "x", run, instructions: "when X2" }, "repository"),
      /duplicate workflow id: x/,
    );
    assert.equal(registry.size, 1);
  });

  test("a repository workflow cannot replace a built-in", () => {
    const registry = createRegistry(builtins());
    const builtin = registry.get("find");
    assert.throws(
      () => registry.register({ id: "find", run }, "repository", ".stanley/workflows/find.ts"),
      (error: unknown) =>
        error instanceof DuplicateWorkflowIdError &&
        error.id === "find" &&
        error.origins.join(",") === "builtin,.stanley/workflows/find.ts",
    );
    assert.equal(registry.get("find"), builtin);
    assert.equal(registry.size, 10);
  });

  test("repository workflows cannot replace each other", () => {
    const registry = new WorkflowRegistry();
    registry.register({ id: "notes", run }, "repository", ".stanley/workflows/a.ts");
    assert.throws(
      () => registry.register({ id: "notes", run }, "repository", ".stanley/workflows/b.ts"),
      DuplicateWorkflowIdError,
    );
    assert.equal(registry.get("notes")?.origin, ".stanley/workflows/a.ts");
  });

  test("batch registration is atomic", () => {
    const registry = new WorkflowRegistry();
    assert.throws(
      () =>
        registry.registerAll([
          { workflow: { id: "one", run }, origin: "a.ts" },
          { workflow: { id: "two", run }, origin: "b.ts" },
          { workflow: { id: "one", run }, origin: "c.ts" },
        ]),
      /duplicate workflow id: one \(registered by a\.ts and c\.ts\)/,
    );
    assert.equal(registry.size, 0);
  });

  test("router labels are reserved", () => {
    const registry = new WorkflowRegistry();
    assert.throws(
      () => registry.register({ id: "cannot_tell", run }, "repository", "x.ts"),
      ReservedWorkflowIdError,
    );
    assert.throws(() => registry.register({ id: "cannot_tell", run }, "builtin"), ReservedWorkflowIdError);
  });

  test("registered workflows are validated and retained", () => {
    const registry = new WorkflowRegistry();
    assert.throws(
      () => registry.register({ id: "Bad", run } as Workflow, "repository", "x.ts"),
      WorkflowValidationError,
    );
    const workflow = { id: "native", run, routing: { any: "json" } };
    registry.register(workflow, "builtin");
    assert.deepEqual(registry.get("native"), {
      id: "native",
      kind: "builtin",
      origin: "builtin",
      workflow,
      routing: { routing: { any: "json" } },
    });
  });

  test("all JSON fields become routing metadata", () => {
    const registry = createRegistry(builtins());
    registry.register(
      { id: "notes", run, instructions: "Use for release notes", examples: ["Write a changelog"] },
      "repository",
      ".stanley/workflows/notes.ts",
    );
    assert.equal(registry.size, 11);
    assert.deepEqual(registry.candidates().at(-1), {
      id: "notes",
      routing: { instructions: "Use for release notes", examples: ["Write a changelog"] },
    });
    assert.equal(registry.ids().at(-1), "notes");
  });
});

// ---------------------------------------------------------------------------
// Built-in workflows
// ---------------------------------------------------------------------------

describe("built-in workflows", () => {
  test("the registry holds the ten built-ins, in order, as ordinary workflows", () => {
    const registry = createRegistry(builtins());
    assert.equal(registry.size, 10);
    assert.deepEqual(registry.ids(), Object.keys(BUILTINS));
    for (const name of Object.keys(BUILTINS)) assert.equal(registry.kindOf(name), "builtin", name);
  });

  test("each built-in owns its routing metadata and eligibility, and none declares options", () => {
    const registry = createRegistry(builtins());
    for (const candidate of registry.candidates()) {
      const builtin = BUILTINS[candidate.id as keyof typeof BUILTINS];
      assert.deepEqual(candidate.routing, {
        description: builtin.description,
        instructions: builtin.instructions,
      });
      assert.ok(!("options" in registry.get(candidate.id)!.workflow));
    }
    assert.deepEqual(
      Object.entries(BUILTINS)
        .filter(([, builtin]) => builtin.acceptsInput)
        .map(([id]) => id),
      ["check", "triage_failures", "triage_comments"],
    );
    assert.deepEqual(registry.capabilities({ diff: "absent", input: "none" }), {
      find: true,
      check: false,
      triage_failures: false,
      triage_comments: false,
      review: false,
      test_gaps: false,
      summarize: false,
      security_review: false,
      performance_review: false,
      compatibility_review: false,
    });
    const withLog = registry.capabilities({ diff: "present", input: "failure_log" });
    assert.equal(withLog.triage_failures, true);
    assert.equal(withLog.triage_comments, false);
    assert.equal(withLog.check, true);
  });
});

describe("workflow runtime", () => {
  const fallback = (reasons: string[]) => async (_request: string, _input: unknown, reason: string) => {
    reasons.push(reason);
    return { status: "unsupported" as const, output: { reason } };
  };
  const runtime = (registry: WorkflowRegistry, route: (excluded: ReadonlySet<string>) => string) =>
    new WorkflowRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async (_request, _input, excluded) => route(excluded),
      fallback: fallback([]),
    });

  test("routes child prompts without exposing workflow identity; the context is request, input, and primitives", async () => {
    const registry = new WorkflowRegistry();
    const seen: string[][] = [];
    registry.register(
      {
        id: "parent",
        instructions: "orchestrate",
        async run(context) {
          seen.push(Object.keys(context).sort());
          return (await context.prompt("do child work", { value: 2 })).output;
        },
      },
      "repository",
      "parent.ts",
    );
    registry.register(
      {
        id: "child",
        instructions: "child work",
        async run(context) {
          seen.push(Object.keys(context).sort());
          return { received: context.input ?? null };
        },
      },
      "repository",
      "child.ts",
    );
    const exclusions: string[][] = [];
    const result = await runtime(registry, (excluded) => {
      exclusions.push([...excluded]);
      return "child";
    }).run("parent", "start");
    assert.deepEqual(result, { status: "complete", output: { received: { value: 2 } } });
    assert.deepEqual(exclusions, [["parent"]]);
    const primitives = ["judge", "log", "prompt", "request", "root", "signal"];
    assert.deepEqual(seen, [primitives, ["input", ...primitives].sort()]);
  });

  test("a workflow may return its own status envelope", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      { id: "partial", run: () => ({ status: "incomplete", output: { text: "half" } }) },
      "repository",
      "partial.ts",
    );
    assert.deepEqual(await runtime(registry, () => "partial").run("partial", "go"), {
      status: "incomplete",
      output: { text: "half" },
    });
  });

  test("validates top-level and nested prompt control envelopes", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      {
        id: "invalid-caller",
        async run({ prompt }) {
          await prompt("child", new Date() as never);
          return null;
        },
      },
      "repository",
      "invalid.ts",
    );
    const invalid = runtime(registry, () => assert.fail("invalid child input must not be routed"));
    await assert.rejects(invalid.run("invalid-caller", ""), /prompt instructions must be non-empty text/);
    await assert.rejects(invalid.run("invalid-caller", "start"), /prompt input must be text or JSON/);
  });

  test("stops active-stack cycles and depth overflow", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      {
        id: "loop",
        async run({ prompt }) {
          return (await prompt("again")).output;
        },
      },
      "repository",
      "loop.ts",
    );
    const cycleReasons: string[] = [];
    const cycle = new WorkflowRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => "loop",
      fallback: fallback(cycleReasons),
    });
    await cycle.run("loop", "start");
    assert.deepEqual(cycleReasons, ["cycle"]);

    for (let index = 0; index <= PROMPT_LIMITS.maxDepth; index++) {
      const id = `step-${index}`;
      registry.register(
        {
          id,
          async run({ prompt }) {
            return (await prompt("next")).output;
          },
        },
        "repository",
        `${id}.ts`,
      );
    }
    const depthReasons: string[] = [];
    let next = 1;
    const depth = new WorkflowRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => `step-${next++}`,
      fallback: fallback(depthReasons),
    });
    await depth.run("step-0", "start");
    assert.deepEqual(depthReasons, ["depth"]);
  });

  test("limits a tree to 32 child prompt calls", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      {
        id: "fanout",
        async run({ prompt }) {
          let output: unknown = null;
          for (let index = 0; index <= PROMPT_LIMITS.maxChildCalls; index++) {
            output = (await prompt(`child ${index}`)).output;
          }
          return output as null;
        },
      },
      "repository",
      "fanout.ts",
    );
    registry.register({ id: "leaf", run: () => "ok", instructions: "leaf" }, "builtin");
    const reasons: string[] = [];
    const fanout = new WorkflowRuntime({
      root: "/repo",
      registry,
      signal: new AbortController().signal,
      route: async () => "leaf",
      fallback: fallback(reasons),
    });
    await fanout.run("fanout", "start");
    assert.deepEqual(reasons, ["calls"]);
  });
});

// ---------------------------------------------------------------------------
// Discovery and loading
// ---------------------------------------------------------------------------

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A temporary repository with the given files under `.stanley/workflows/`. */
function repository(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "stanley-workflows-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, WORKFLOW_DIRECTORY, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

interface Events {
  __stanleyWorkflowEvents?: string[];
}
const events = () => {
  const store = globalThis as Events;
  store.__stanleyWorkflowEvents = [];
  return store.__stanleyWorkflowEvents;
};
const record = (event: string) =>
  `(globalThis as any).__stanleyWorkflowEvents?.push(${JSON.stringify(event)});`;

const module = (id: string, extra = "") =>
  `export default async () => ({ id: ${JSON.stringify(id)}, async run() { return "ok"; }${extra} });\n`;

describe("workflow discovery", () => {
  test("a repository without a workflow directory has no workflows", async () => {
    const root = repository({});
    assert.deepEqual(await discoverWorkflows(root), { sources: [], diagnostics: [] });
  });

  test("finds direct .ts/.js files and package directories in name order", async () => {
    const root = repository({
      "b.ts": module("b"),
      "a.js": module("a"),
      "types.d.ts": "export {};",
      "README.md": "# notes",
      "config.json": "{}",
      ".hidden.ts": module("hidden"),
      "pkg-main/package.json": JSON.stringify({ main: "lib/entry.ts" }),
      "pkg-main/lib/entry.ts": module("pkg-main"),
      "pkg-exports/package.json": JSON.stringify({
        exports: { ".": { import: "./src/p.js" } },
        main: "nope.js",
      }),
      "pkg-exports/src/p.js": module("pkg-exports"),
      "pkg-index/index.ts": module("pkg-index"),
      "pkg-index/package.json": JSON.stringify({ name: "pkg-index" }),
      "node_modules/dep/index.js": module("dep"),
    });
    const { sources, diagnostics } = await discoverWorkflows(root);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(
      sources.map(({ path, kind, entry }) => [path, kind, entry.slice(root.length + 1)]),
      [
        [".stanley/workflows/a.js", "file", ".stanley/workflows/a.js"],
        [".stanley/workflows/b.ts", "file", ".stanley/workflows/b.ts"],
        [".stanley/workflows/pkg-exports", "package", ".stanley/workflows/pkg-exports/src/p.js"],
        [".stanley/workflows/pkg-index", "package", ".stanley/workflows/pkg-index/index.ts"],
        [".stanley/workflows/pkg-main", "package", ".stanley/workflows/pkg-main/lib/entry.ts"],
      ],
    );
  });

  test("unresolvable package directories become discovery diagnostics", async () => {
    const root = repository({
      "empty/notes.txt": "",
      "escape/package.json": JSON.stringify({ main: "../outside.ts" }),
      "missing/package.json": JSON.stringify({ main: "gone.ts" }),
      "broken/package.json": "{",
    });
    const { sources, diagnostics } = await discoverWorkflows(root);
    assert.deepEqual(sources, []);
    assert.deepEqual(
      diagnostics.map(({ source, phase }) => [source, phase]),
      [
        [".stanley/workflows/broken", "discover"],
        [".stanley/workflows/empty", "discover"],
        [".stanley/workflows/escape", "discover"],
        [".stanley/workflows/missing", "discover"],
      ],
    );
    assert.match(diagnostics[0]!.message, /invalid package\.json/);
    assert.match(diagnostics[1]!.message, /no package entrypoint/);
    assert.match(
      diagnostics[2]!.message,
      /package entrypoint not found or escapes its directory: \.\.\/outside\.ts/,
    );
    assert.match(diagnostics[3]!.message, /package entrypoint not found or escapes its directory: gone\.ts/);
  });

  test("package entrypoint symlinks cannot escape the package directory", async () => {
    const root = repository({
      "linked/package.json": JSON.stringify({ main: "entry.ts" }),
    });
    const outside = join(root, "outside.ts");
    writeFileSync(outside, module("outside"));
    symlinkSync(outside, join(root, WORKFLOW_DIRECTORY, "linked/entry.ts"));

    const discovery = await discoverWorkflows(root);
    assert.deepEqual(discovery.sources, []);
    assert.equal(discovery.diagnostics[0]?.source, ".stanley/workflows/linked");
    assert.match(discovery.diagnostics[0]?.message ?? "", /escapes its directory/);
  });

  test("direct files and package directories cannot be symlinked outside the workflow directory", async () => {
    const root = repository({ "notes.txt": "" });
    const outsideFile = join(root, "outside.ts");
    const outsidePackage = join(root, "outside-package");
    writeFileSync(outsideFile, module("outside-file"));
    mkdirSync(outsidePackage);
    writeFileSync(join(outsidePackage, "index.ts"), module("outside-package"));
    symlinkSync(outsideFile, join(root, WORKFLOW_DIRECTORY, "escaped.ts"));
    symlinkSync(outsidePackage, join(root, WORKFLOW_DIRECTORY, "linked-package"));

    const discovery = await discoverWorkflows(root);
    assert.deepEqual(discovery.sources, []);
    assert.deepEqual(
      discovery.diagnostics.map(({ source, message }) => [source, message]),
      [
        [".stanley/workflows/escaped.ts", "workflow source escapes its directory"],
        [".stanley/workflows/linked-package", "workflow source escapes its directory"],
      ],
    );
  });
});

describe("workflow loading", () => {
  test("imports TypeScript through tsx and awaits factories with only root, signal, and log", async () => {
    const root = repository({
      "enum.ts": [
        "enum Kind { Notes = 'notes' }",
        "export default async function (context: { root: string; signal: AbortSignal; log: any }) {",
        "  (globalThis as any).__stanleyInit = { keys: Object.keys(context).sort(), root: context.root, aborted: context.signal.aborted };",
        "  context.log.info('initialized', { kind: Kind.Notes });",
        "  await new Promise((resolve) => setTimeout(resolve, 5));",
        "  return { id: Kind.Notes, run: async () => 'ok', routing: { purpose: 'notes' } };",
        "}",
      ].join("\n"),
      "esm/package.json": JSON.stringify({ type: "module", main: "index.js" }),
      "esm/index.js": module("esm-js"),
      "plain.js": "module.exports = async () => ({ id: 'plain-cjs', run() {} });",
    });
    const logs: WorkflowLogRecord[] = [];
    const warnings: string[] = [];
    const result = await loadWorkflows({
      root,
      log: (entry) => logs.push(entry),
      warn: (w) => warnings.push(w),
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(result.quarantined, []);
    assert.deepEqual(
      result.loaded.map(({ workflow, source }) => [workflow.id, source.path, source.kind]),
      [
        ["notes", ".stanley/workflows/enum.ts", "file"],
        ["esm-js", ".stanley/workflows/esm", "package"],
        ["plain-cjs", ".stanley/workflows/plain.js", "file"],
      ],
    );
    assert.deepEqual(result.loaded[0]!.workflow.routing, { purpose: "notes" });
    const init = (globalThis as { __stanleyInit?: unknown }).__stanleyInit;
    assert.deepEqual(init, { keys: ["log", "root", "signal"], root: realpathSync(root), aborted: false });
    assert.deepEqual(logs, [
      {
        level: "info",
        source: ".stanley/workflows/enum.ts",
        message: "initialized",
        data: { kind: "notes" },
      },
    ]);
  });

  test("quarantines import, factory, and validation failures with visible warnings and keeps the rest", async () => {
    const seen = events();
    const root = repository({
      "a-syntax.ts": "export default async () => ({ id: 'x', run() {",
      "b-throws.ts": "export default async () => { throw new Error('factory exploded'); };",
      "c-invalid.ts": `export default async () => ({ id: 'Invalid Id', run: async () => 'ok', cleanup: async () => { ${record("cleanup:c")} } });`,
      "d-no-default.ts": "export const workflow = { id: 'd', run() {} };",
      "e-object.ts": "export default { id: 'e', run() {} };",
      "f-sync.ts": "export default () => ({ id: 'sync', run() {} });",
      "g-good.ts": module("good"),
    });
    mkdirSync(join(root, WORKFLOW_DIRECTORY, "h-dir"));
    const warnings: string[] = [];
    const result = await loadWorkflows({ root, warn: (warning) => warnings.push(warning) });

    assert.deepEqual(
      result.loaded.map(({ workflow }) => workflow.id),
      ["good"],
    );
    assert.deepEqual(
      result.quarantined.map(({ source, phase }) => [source, phase]),
      [
        [".stanley/workflows/h-dir", "discover"],
        [".stanley/workflows/a-syntax.ts", "import"],
        [".stanley/workflows/b-throws.ts", "factory"],
        [".stanley/workflows/c-invalid.ts", "validate"],
        [".stanley/workflows/d-no-default.ts", "validate"],
        [".stanley/workflows/e-object.ts", "validate"],
        [".stanley/workflows/f-sync.ts", "factory"],
      ],
    );
    assert.equal(result.quarantined[2]!.message, "factory exploded");
    assert.match(result.quarantined[3]!.message, /workflow\.id must match/);
    assert.match(
      result.quarantined[4]!.message,
      /default export must be an async factory function \(got undefined\)/,
    );
    assert.match(result.quarantined[5]!.message, /\(got object\)/);
    assert.match(result.quarantined[6]!.message, /default factory must return a Promise/);
    assert.deepEqual(warnings, result.quarantined.map(formatWorkflowDiagnostic));
    assert.match(
      warnings[2]!,
      /^stanley: warning: workflow \.stanley\/workflows\/b-throws\.ts quarantined \(factory\): factory exploded$/,
    );
    assert.deepEqual(seen, ["cleanup:c"], "an invalid workflow's cleanup still runs");
  });

  test("an aborted load cleans up initialized workflows and rethrows", async () => {
    const seen = events();
    const controller = new AbortController();
    (globalThis as { __stanleyAbort?: AbortController }).__stanleyAbort = controller;
    const root = repository({
      "a.ts": module("a", `, cleanup: async () => { ${record("cleanup:a")} }`),
      "b.ts": `export default async () => { (globalThis as any).__stanleyAbort.abort(new Error("stop")); return { id: "b", run() {}, cleanup() { ${record("cleanup:b")} } }; };`,
      "c.ts": `export default async () => { ${record("init:c")} return { id: "c", run() {} }; };`,
    });
    await assert.rejects(loadWorkflows({ root, signal: controller.signal, warn: () => {} }), /stop/);
    assert.deepEqual(seen, ["cleanup:b", "cleanup:a"]);
  });

  test("cleanup runs in reverse order and reports failures without stopping", async () => {
    const order: string[] = [];
    const source = (path: string) => ({ path, kind: "file" as const, entry: path });
    const warnings: string[] = [];
    await cleanupWorkflows(
      [
        { workflow: { id: "a", run, cleanup: async () => void order.push("a") }, source: source("a.ts") },
        { workflow: { id: "b", run }, source: source("b.ts") },
        {
          workflow: {
            id: "c",
            run,
            cleanup: async () => {
              order.push("c");
              throw new Error("busy");
            },
          },
          source: source("c.ts"),
        },
      ],
      (warning) => warnings.push(warning),
    );
    assert.deepEqual(order, ["c", "a"]);
    assert.deepEqual(warnings, ["stanley: warning: workflow c.ts cleanup failed: busy"]);
  });
});

describe("repository workflow registration", () => {
  test("registers loaded workflows beside built-ins as routing candidates", async () => {
    const root = repository({ "notes.ts": module("release_notes") });
    const registry = createRegistry(builtins());
    const candidates = registry.candidates();
    const result = await registerRepositoryWorkflows(registry, { root, warn: () => {} });
    assert.equal(result.loaded.length, 1);
    assert.equal(registry.size, 11);
    assert.equal(registry.get("release_notes")?.kind, "repository");
    assert.equal(registry.get("release_notes")?.origin, ".stanley/workflows/notes.ts");
    assert.equal(registry.get("release_notes")?.workflow, result.loaded[0]!.workflow);
    assert.deepEqual(registry.candidates(), [...candidates, { id: "release_notes", routing: {} }]);
  });

  test("a workflow claiming a built-in id fails registration and is cleaned up", async () => {
    const seen = events();
    const root = repository({
      "find.ts": module("find", `, cleanup() { ${record("cleanup:find")} }`),
      "other.ts": module("other", `, cleanup() { ${record("cleanup:other")} }`),
    });
    const registry = createRegistry(builtins());
    await assert.rejects(
      registerRepositoryWorkflows(registry, { root, warn: () => {} }),
      /duplicate workflow id: find \(registered by builtin and \.stanley\/workflows\/find\.ts\)/,
    );
    assert.equal(registry.size, 10);
    assert.equal(registry.kindOf("find"), "builtin");
    assert.deepEqual(seen, ["cleanup:other", "cleanup:find"]);
  });

  test("two workflows with the same id fail registration rather than choosing one", async () => {
    const root = repository({ "a.ts": module("same"), "b/index.ts": module("same") });
    const registry = new WorkflowRegistry();
    await assert.rejects(
      registerRepositoryWorkflows(registry, { root, warn: () => {} }),
      (error: unknown) =>
        error instanceof DuplicateWorkflowIdError &&
        error.origins.join(",") === ".stanley/workflows/a.ts,.stanley/workflows/b",
    );
    assert.equal(registry.size, 0);
  });
});
