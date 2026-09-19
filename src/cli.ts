#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { configuredModel, jevFromEnvironment, MODEL_ENV } from "./adapters/config.ts";
import { createWorkflowDependencies } from "./adapters/dependencies.ts";
import { GitError, repoRoot } from "./adapters/git.ts";
import {
  CANDIDATE_DIRECTORY,
  enqueueImprovement,
  IMPROVEMENT_DIRECTORY,
  listCandidates,
  PromotionError,
  pendingImprovements,
  promoteCandidate,
  quarantineWorkflowFiles,
  runImprovementWorker,
  spawnImprovementWorker,
  WORKER_FLAG,
  workerRunning,
} from "./adapters/improvements.ts";
import { MissingCredentialError } from "./adapters/jev.ts";
import { readStdin, readWorkspaceFile } from "./adapters/paths.ts";
import {
  AGENT_ENV,
  AGENT_MODEL_ENV,
  type AgentAvailability,
  agentFromEnvironment,
  NESTED_ENV,
  PI_BINARY_ENV,
} from "./adapters/pi.ts";
import { safeMessage } from "./adapters/redact.ts";
import {
  cleanupWorkflows,
  type LoadedWorkflow,
  WORKFLOW_DIRECTORY,
  workflowDirectoryChanges,
  workflowDirectoryFingerprint,
} from "./adapters/workflows.ts";
import { BUILTINS, builtinWorkflows, inputText, isBuiltinName, runBuiltin } from "./cli/builtins.ts";
import { createWorkflowJudge } from "./cli/judge.ts";
import { EXIT, UsageError } from "./cli/output.ts";
import {
  jsonPromptResult,
  promptResultExitCode,
  renderPromptResult,
  unsupportedPromptResult,
} from "./cli/prompt-result.ts";
import { createRegistry, registerRepositoryWorkflows } from "./cli/registry.ts";
import { type RoutingDecision, RoutingError, routeIntent } from "./cli/router.ts";
import { type FallbackReason, WorkflowRuntime } from "./cli/runtime.ts";
import { Budget, type BudgetLimits } from "./core/budget.ts";
import type { JevPort } from "./core/types.ts";
import {
  type DiffPresence,
  type InputShape,
  isWorkflowValue,
  type PromptResult,
  type RoutingFacts,
  type WorkflowValue,
} from "./core/workflow.ts";
import {
  AGENT_LIMITS,
  type CodingAgentPort,
  delegationInstructions,
  delegationResult,
} from "./workflows/agent.ts";
import { diffPresence } from "./workflows/common.ts";
import { InputError } from "./workflows/errors.ts";
import { CODE_CHANGE_FALLBACK_NOTICE } from "./workflows/find.ts";
import { createImprovementJob } from "./workflows/improve.ts";
import type { DiffSelection, WorkflowDependencies } from "./workflows/ports.ts";
import type { RunOptions } from "./workflows/run.ts";
import { DEFAULT_MODEL } from "./workflows/types.ts";

export interface CliIO {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
  stdin: NodeJS.ReadableStream;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * The whole public option surface. Everything semantic comes from the request; these are the host controls
 * that cannot be expressed safely in prose: where the repository is, what external evidence to read, the exact
 * Git selection, output format, privacy, and whether an agent may run. Workflows cannot add to this list.
 */
const OPTIONS = {
  input: { type: "string" },
  scope: { type: "string" },
  base: { type: "string" },
  repo: { type: "string" },
  json: { type: "boolean" },
  "no-persist": { type: "boolean" },
  "no-agent": { type: "boolean" },
  "improve-worker": { type: "boolean" },
  "promote-candidate": { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

export const DIFF_SCOPES = ["worktree", "staged", "branch"] as const;

/** The exact Git selection from `--scope` and `--base`; nested prompts inherit it. */
function diffSelection(scope: string | undefined, base: string | undefined): DiffSelection {
  if (scope !== undefined && !DIFF_SCOPES.includes(scope as (typeof DIFF_SCOPES)[number])) {
    throw new UsageError(`--scope must be one of ${DIFF_SCOPES.join(", ")}`);
  }
  return { scope: (scope as DiffSelection["scope"] | undefined) ?? "worktree", ...(base ? { base } : {}) };
}

const USAGE = 'stanley "<request>" [options]';

function version(): string {
  try {
    return (
      JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    ).version;
  } catch {
    return "unknown";
  }
}

function mainHelp(): string {
  return `stanley ${version()} - Jev-first, self-improving coding agent

Usage: ${USAGE}

Describe what you need in plain language. The request is the task: Jev routes the request to one available
workflow, and that workflow reads it as its instructions. Built-ins can:
  find relevant code
  check the current diff against the request, and against acceptance criteria or project rules given as input
  review the current diff for correctness, test gaps, security, performance, or compatibility
  summarize the current diff as structured change categories
  triage supplied test or CI failures
  triage supplied review comments
Trusted repository workflows from ${WORKFLOW_DIRECTORY}/ extend this list. Requests no workflow supports are
delegated to the installed Pi coding agent, and Stanley then queues a bounded attempt to write a workflow for
next time.

Examples:
  stanley "Find the code that retries webhook deliveries"
  stanley "Check whether these changes fix null config values"
  stanley "Check the staged changes against these acceptance criteria" --scope staged --input acceptance.md
  stanley "Review these changes for bugs"
  stanley "Are there security issues in this diff?"
  stanley "Summarize what changed on this branch" --scope branch --base main
  npm test 2>&1 | stanley "Triage these test failures"
  stanley "Triage the review comments" --input comments.json

Options:
  --input <path|->     External evidence for the workflow: acceptance criteria, a project-rules file, a test or
                       CI log, review-comment JSON, or any text a repository workflow expects. Piped stdin is
                       read automatically. One input per run; a workflow that does not use it rejects it.
  --scope <kind>       Exact Git selection: worktree (default), staged, or branch
  --base <ref>         Base ref for a branch diff (default main)
  --repo <dir>         Repository root (default: the current Git repository)
  --json               Emit a versioned result (schema stanley.prompt-result/v1)
  --no-persist         Do not write .stanley/runs records
  --no-agent           Never delegate to the coding agent or queue improvements (also ${AGENT_ENV}=off)
  -h, --help           Show help
  -v, --version        Print the version

Administrative (self-improvement):
  ${WORKER_FLAG}     Run queued improvement jobs in the foreground, then exit (no request)
  --promote-candidate <id>  Activate a validated candidate from ${CANDIDATE_DIRECTORY}/ into ${WORKFLOW_DIRECTORY}/

Environment: TYPESAFE_API_KEY (required); ${MODEL_ENV} (Jev model, default ${DEFAULT_MODEL});
             ${PI_BINARY_ENV}, ${AGENT_MODEL_ENV} (Pi binary path and optional Pi model).
Limits (request budgets, hunk and item caps, agent time limits) are fixed policy, not flags.

Exit codes: 0 complete; 10 incomplete coverage; 12 budget exhausted;
            64 usage or unsupported request; 65 invalid input; 70 internal error
Bundled results are advisory and read-only. Trusted repository workflows and the coding agent may change files.
Delegated results are reported as the agent's own account and are never verified by Stanley.
Without an agent, unsupported implement or fix requests return exit 64 after a read-only relevant-code analysis.
Every bundled report lists what was not checked. "No flags" is not an approval.
`;
}

function classifyInput(text: string | null, dependencies: WorkflowDependencies): InputShape {
  if (!text?.trim()) return "none";
  try {
    dependencies.evidence.reviewComments(text);
    return "review_comments";
  } catch {
    // It is not review-comment JSON; test failure parsing is intentionally more permissive.
  }
  try {
    if (dependencies.evidence.failureLog(text).blocks.length > 0) return "failure_log";
  } catch {
    // The workflow will report detailed parser errors if this input is selected explicitly.
  }
  return "text";
}

function clarification(diff: DiffPresence, input: InputShape): string {
  const context =
    input === "text"
      ? " The supplied input was not recognized as failures or review-comment JSON."
      : diff === "absent" && input === "none"
        ? " There is no current diff or recognized input to disambiguate the request."
        : "";
  return (
    "cannot tell what analysis you want. Should Stanley find relevant code; check, review, or summarize the current diff; " +
    `inspect its test, security, performance, or compatibility risks; or triage supplied failures or comments?${context}`
  );
}

type UnsupportedAction = "code_change" | "external_action" | null;

function unsupportedAction(request: string): UnsupportedAction {
  const normalized = request
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:please|can you|could you|would you|i (?:need|want) you to|help me|let's)\s+)+/, "");
  if (
    /^(?:fix|implement|build|create|develop|refactor|edit|modify|update|write|add|remove|make|solve|apply)\b/.test(
      normalized,
    )
  ) {
    return "code_change";
  }
  if (
    /^(?:commit|push|deploy|reply|resolve|merge|revert)\b/.test(normalized) ||
    /^(?:run|execute)\s+(?:the\s+)?(?:tests?|build|lint|typecheck|command|script)\b/.test(normalized)
  ) {
    return "external_action";
  }
  return null;
}

const DEFAULT_TREE_BUDGET = {
  requests: 600,
  inputTokens: 1_200_000,
  wallMs: 180_000,
} as const;

/** Why the top-level request was not routed to a workflow. */
type RouteReason = RoutingDecision["reason"] | "no_candidates" | "routing_error" | "action_guard" | "skipped";

export interface CliInjections {
  adapter?: JevPort;
  signal?: AbortSignal;
  /** Overrides the shared invocation budget. For tests and embedders; there is no CLI flag for it. */
  budget?: Partial<BudgetLimits>;
  /** The coding agent; `null` disables delegation. Defaults to Pi from the environment. */
  agent?: CodingAgentPort | null;
  /** Starts the detached improvement worker. Defaults to spawning `node cli.js --improve-worker`. */
  spawnWorker?: (root: string) => void;
}

function workflowInput(text: string | null): WorkflowValue | undefined {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (isWorkflowValue(parsed)) return parsed;
  } catch {
    // Plain text is a valid workflow input.
  }
  return text;
}

function writePromptResult(result: PromptResult, json: boolean, io: CliIO): number {
  io.stdout.write(
    json ? `${JSON.stringify(jsonPromptResult(result), null, 2)}\n` : renderPromptResult(result),
  );
  return promptResultExitCode(result);
}

export async function runCli(argv: string[], io: CliIO, injected: CliInjections = {}): Promise<number> {
  const wantsJson = argv.includes("--json");
  let selected: string | null = null;
  let loadedWorkflows: readonly LoadedWorkflow[] = [];
  const signal = injected.signal ?? new AbortController().signal;
  const warnWorkflow = (message: string) => {
    io.stderr.write(`${safeMessage(message)}\n`);
  };
  const nested = Boolean(io.env[NESTED_ENV]?.trim());
  try {
    if (argv.length === 0) {
      io.stdout.write(mainHelp());
      return EXIT.usage;
    }
    const { values, positionals } = parseArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    const v = values;
    if (v.help || (positionals.length === 1 && positionals[0] === "help")) {
      io.stdout.write(mainHelp());
      return EXIT.ok;
    }
    if (v.version) {
      io.stdout.write(`${version()}\n`);
      return EXIT.ok;
    }

    const request = positionals.join(" ").trim();
    const workerMode = Boolean(v["improve-worker"]);
    const promotion = typeof v["promote-candidate"] === "string" ? v["promote-candidate"] : null;
    if (workerMode && promotion !== null) {
      throw new UsageError(`use either ${WORKER_FLAG} or --promote-candidate, not both`);
    }
    if ((workerMode || promotion !== null) && request) {
      throw new UsageError(`${workerMode ? WORKER_FLAG : "--promote-candidate"} does not take a request`);
    }
    if (!request && !workerMode && promotion === null) {
      throw new UsageError("a natural-language request is required");
    }
    if (request.includes("\0") || Buffer.byteLength(request) > 16 * 1024) {
      throw new UsageError("the request must be at most 16384 bytes and contain no null bytes");
    }
    const selection = diffSelection(v.scope, v.base);

    const jev = injected.adapter ?? jevFromEnvironment(io.env);
    const root = v.repo !== undefined ? await repoRoot(v.repo) : await repoRoot(io.cwd);
    const dependencies = createWorkflowDependencies(root, jev);
    const model = configuredModel(undefined, io.env);
    // One fixed, safe budget for the whole invocation tree; workflows carry their own policy limits.
    const sharedBudget = new Budget({ ...DEFAULT_TREE_BUDGET, ...injected.budget });
    const options: RunOptions = {
      root,
      dependencies,
      persist: !v["no-persist"],
      sharedBudget,
      signal,
      ...(model === undefined ? {} : { model }),
    };

    const availability: AgentAvailability = nested
      ? { agent: null, reason: "nested" }
      : v["no-agent"]
        ? { agent: null, reason: "disabled" }
        : injected.agent !== undefined
          ? injected.agent
            ? { agent: injected.agent }
            : { agent: null, reason: "disabled" }
          : agentFromEnvironment(io.env);
    const agent = availability.agent;
    let workerStarted = false;
    const startWorker = () => {
      if (workerStarted) return;
      workerStarted = true;
      if (injected.spawnWorker) injected.spawnWorker(root);
      else spawnImprovementWorker({ root, cliPath: fileURLToPath(import.meta.url), env: io.env });
    };
    const judgeFor = () =>
      createWorkflowJudge({
        jev: dependencies.jev,
        model: model ?? DEFAULT_MODEL,
        sharedBudget,
        redaction: dependencies.redaction,
        classifyError: dependencies.classifyError,
        signal,
      });

    // The one generic input: `--input <path>`, `--input -`, or automatically detected piped stdin.
    let supplied: { text: string; source: string } | null = null;
    if (!workerMode && promotion === null) {
      if (v.input === "-") supplied = { text: await readStdin(io.stdin), source: "stdin" };
      else if (v.input !== undefined) {
        const file = await readWorkspaceFile(root, v.input);
        if (file.text.length === 0) throw new InputError("input file is empty");
        supplied = { text: file.text, source: file.path };
      } else if (!(io.stdin as NodeJS.ReadableStream & { isTTY?: boolean }).isTTY) {
        const text = await readStdin(io.stdin);
        if (text.trim()) supplied = { text, source: "stdin" };
      }
    }
    const topInput = workflowInput(supplied?.text ?? null);

    const facts = async (input: InputShape): Promise<RoutingFacts> => ({
      diff: await diffPresence(dependencies, selection),
      input,
    });
    const registry = createRegistry(
      builtinWorkflows({
        run: options,
        selection,
        supplied:
          supplied && topInput !== undefined ? { text: inputText(topInput)!, source: supplied.source } : null,
      }),
    );
    loadedWorkflows = (await registerRepositoryWorkflows(registry, { root, signal, warn: warnWorkflow }))
      .loaded;

    if (workerMode || promotion !== null) {
      if (promotion !== null) {
        const promoted = await promoteCandidate(root, promotion, registry.ids());
        const summary = {
          schema: "stanley.promotion/v1",
          candidate: promotion,
          workflow: promoted.workflowId,
          path: promoted.destination,
        };
        io.stdout.write(
          v.json
            ? `${JSON.stringify(summary, null, 2)}\n`
            : `stanley: activated candidate ${promotion} as workflow ${promoted.workflowId} at ${promoted.destination}; review and commit it like any repository script\n`,
        );
        return EXIT.ok;
      }
      if (!agent) {
        io.stderr.write(`stanley: improvement worker not started: agent ${availability.reason}\n`);
        return EXIT.usage;
      }
      const workerFacts = await facts("none");
      const summary = await runImprovementWorker({
        root,
        agent,
        reservedIds: registry.ids(),
        signal,
        routeCheck: async (candidate, candidateRequest) => {
          try {
            const decision = await routeIntent(
              {
                request: candidateRequest,
                ...workerFacts,
                capabilities: { ...registry.capabilities(workerFacts), [candidate.id]: true },
                candidates: [...registry.candidates(), candidate],
              },
              dependencies,
              model ?? DEFAULT_MODEL,
              undefined,
              signal,
            );
            return decision.outcome === candidate.id;
          } catch (error) {
            if (error instanceof RoutingError) return null;
            throw error;
          }
        },
      });
      const report = { schema: "stanley.improvement-worker/v1", ...summary };
      io.stdout.write(
        v.json
          ? `${JSON.stringify(report, null, 2)}\n`
          : summary.ran
            ? `stanley: improvement worker processed ${summary.processed.length} job(s)${summary.processed.map((job) => `\n  ${job.id}: ${job.status}`).join("")}\n`
            : "stanley: improvement worker already running for this repository\n",
      );
      return EXIT.ok;
    }

    const validatedCandidates = (await listCandidates(root)).filter((c) => c.status === "validated");
    if (validatedCandidates.length > 0) {
      io.stderr.write(
        `stanley: ${validatedCandidates.length} validated improvement candidate(s) await review under ${CANDIDATE_DIRECTORY}/ (activate with --promote-candidate <id>)\n`,
      );
    }
    if (agent && (await pendingImprovements(root)).length > 0 && !(await workerRunning(root))) startWorker();
    const decide = async (
      childRequest: string,
      childInput: WorkflowValue | undefined,
      excluded: ReadonlySet<string>,
    ): Promise<{ selected: string | null; reason: RouteReason }> => {
      const childFacts = await facts(classifyInput(inputText(childInput), dependencies));
      const candidates = registry.candidates().filter((candidate) => !excluded.has(candidate.id));
      if (candidates.length === 0) return { selected: null, reason: "no_candidates" };
      try {
        const decision = await routeIntent(
          {
            request: childRequest,
            ...childFacts,
            capabilities: registry.capabilities(childFacts, excluded),
            candidates,
          },
          dependencies,
          model ?? DEFAULT_MODEL,
          sharedBudget,
          signal,
        );
        if (decision.outcome === "cannot_tell") return { selected: null, reason: decision.reason };
        if (unsupportedAction(childRequest) && registry.kindOf(decision.outcome) !== "repository") {
          return { selected: null, reason: "action_guard" };
        }
        return { selected: decision.outcome, reason: "selected" };
      } catch (error) {
        if (error instanceof RoutingError) {
          signal.throwIfAborted();
          return { selected: null, reason: "routing_error" };
        }
        throw error;
      }
    };
    const action = unsupportedAction(request);
    const topDecision: { selected: string | null; reason: RouteReason } =
      action && loadedWorkflows.length === 0
        ? { selected: null, reason: "skipped" }
        : await decide(request, topInput, new Set());
    selected = topDecision.selected;
    const selectedWorkflow = selected ? registry.get(selected) : undefined;
    const delegate = async (): Promise<PromptResult> => {
      const text = inputText(topInput);
      // The workflow directory is the trust boundary: a task agent may edit the repository, but nothing it
      // writes there is activated. Added files are quarantined; other changes are reported for review.
      const workflowsBefore = await workflowDirectoryFingerprint(root);
      const result = await agent!.run(
        { kind: "delegate", instructions: delegationInstructions(request, text), cwd: root },
        { signal, timeoutMs: AGENT_LIMITS.defaultTimeoutMs },
      );
      signal.throwIfAborted();
      const caveats: string[] = [];
      const changes = workflowDirectoryChanges(workflowsBefore, await workflowDirectoryFingerprint(root));
      if (changes.added.length > 0) {
        const quarantine = await quarantineWorkflowFiles(root, changes.added);
        caveats.push(
          `the agent added ${changes.added.length} file(s) under ${WORKFLOW_DIRECTORY}/; they were moved to ${quarantine}/ and are not active (${changes.added.join(", ")})`,
        );
      }
      if (changes.modified.length > 0 || changes.removed.length > 0) {
        caveats.push(
          `the agent changed trusted workflow files that were not restored; review them with git before the next run (modified: ${changes.modified.join(", ") || "none"}; removed: ${changes.removed.join(", ") || "none"})`,
        );
      }
      for (const caveat of caveats) io.stderr.write(`stanley: warning: ${safeMessage(caveat)}\n`);
      const job = createImprovementJob(
        dependencies.redaction.text(request).text,
        classifyInput(text, dependencies),
      );
      const queued = await enqueueImprovement(root, job);
      if (queued === "queued") startWorker();
      else if (queued === "already_queued" && !(await workerRunning(root))) startWorker();
      const note: Record<typeof queued, string> = {
        queued: `queued improvement job ${job.id} under ${IMPROVEMENT_DIRECTORY}/`,
        already_queued: `improvement job ${job.id} is already queued`,
        already_attempted: `an improvement for this request was already attempted (${CANDIDATE_DIRECTORY}/${job.id})`,
        queue_full: "the improvement queue is full; no job was queued",
      };
      io.stderr.write(`stanley: delegated to the coding agent; ${note[queued]}\n`);
      return delegationResult(result, dependencies.redaction, caveats);
    };
    const fallback = async (
      fallbackRequest: string,
      fallbackInput: WorkflowValue | undefined,
      reason: FallbackReason,
    ): Promise<PromptResult> => {
      signal.throwIfAborted();
      const requestedAction = unsupportedAction(fallbackRequest);
      if (requestedAction === "code_change" && !sharedBudget.exhausted) {
        const analysis = await runBuiltin(
          "find",
          {
            task: `Identify repository code relevant to planning this requested change: ${fallbackRequest}`,
            includeExcerpts: true,
            mode: "code_change_fallback",
          },
          options,
        );
        return {
          status: "unsupported",
          output: {
            text: `${CODE_CHANGE_FALLBACK_NOTICE}\n\n${
              typeof analysis.output === "object" &&
              analysis.output !== null &&
              !Array.isArray(analysis.output) &&
              typeof analysis.output.text === "string"
                ? analysis.output.text
                : ""
            }`.trimEnd(),
            data: { reason, requested: requestedAction, analysis: analysis.output },
          },
        };
      }
      const detail = {
        reason,
        ...(requestedAction ? { requested: requestedAction } : {}),
        ...(fallbackInput === undefined ? {} : { inputProvided: true }),
      };
      if (sharedBudget.exhausted) {
        return {
          status: "budget_exhausted",
          output: {
            text: `The request could not be routed because the shared ${sharedBudget.exhausted} budget was exhausted.`,
            data: detail,
          },
        };
      }
      if (requestedAction === "external_action") {
        return unsupportedPromptResult(
          "No installed workflow can perform this action. Built-in workflows are read-only and cannot run commands, commit, push, deploy, reply, or resolve.",
          detail,
        );
      }
      const messages: Record<Exclude<FallbackReason, "unroutable">, string> = {
        unavailable: "The selected capability is not currently available.",
        cycle: "The request was stopped because it would re-enter an active workflow.",
        depth: "The request was stopped at the nested prompt depth limit.",
        calls: "The request was stopped at the child prompt call limit.",
      };
      if (reason !== "unroutable") return unsupportedPromptResult(messages[reason], detail);
      const fallbackFacts = await facts(classifyInput(inputText(fallbackInput), dependencies));
      return unsupportedPromptResult(
        `No installed workflow can confidently handle the complete request. ${clarification(
          fallbackFacts.diff,
          fallbackFacts.input,
        )}`,
        detail,
      );
    };
    if (!selectedWorkflow || (action && selectedWorkflow.kind !== "repository")) {
      // Delegate only what is confidently unsupported: an action no repository workflow claims, or a request
      // the router explicitly placed outside every workflow. Uncertain or capability-gated requests ask for
      // clarification.
      const unsupported = action !== null || topDecision.reason === "cannot_tell";
      if (agent && unsupported && !sharedBudget.exhausted) {
        return writePromptResult(await delegate(), Boolean(v.json), io);
      }
      return writePromptResult(await fallback(request, topInput, "unroutable"), Boolean(v.json), io);
    }
    // Repository workflows always receive the input; a built-in that has no use for it must not swallow it.
    if (supplied && isBuiltinName(selectedWorkflow.id) && !BUILTINS[selectedWorkflow.id].acceptsInput) {
      throw new UsageError(
        `supplied input is not used when the request routes to ${selectedWorkflow.id.replace("_", " ")}`,
      );
    }

    const runtime = new WorkflowRuntime({
      root,
      registry,
      signal,
      route: async (childRequest, childInput, excluded) =>
        (await decide(childRequest, childInput, excluded)).selected,
      fallback,
      judge: judgeFor,
    });
    return writePromptResult(await runtime.run(selectedWorkflow.id, request, topInput), Boolean(v.json), io);
  } catch (error) {
    const usage =
      error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS");
    const input =
      error instanceof MissingCredentialError ||
      error instanceof InputError ||
      error instanceof GitError ||
      error instanceof PromotionError;
    const code = usage ? EXIT.usage : input ? EXIT.input : EXIT.internal;
    const kind = usage ? "usage" : input ? "input" : "internal";
    const message = safeMessage(error);
    if (wantsJson) {
      io.stdout.write(
        `${JSON.stringify(
          {
            schema: "stanley.error/v1",
            error: { kind, message },
          },
          null,
          2,
        )}\n`,
      );
    }
    io.stderr.write(`stanley${selected ? ` ${selected}` : ""}: ${kind} error: ${message}\n`);
    if (usage) io.stderr.write(`usage: ${USAGE}\n`);
    return code;
  } finally {
    await cleanupWorkflows(loadedWorkflows, warnWorkflow);
  }
}

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const code = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
  });
  process.exitCode = code;
}
