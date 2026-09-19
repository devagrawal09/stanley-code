# Architecture

Stanley is a Jev-first, self-improving coding agent. The hot path is deterministic code plus bounded Jev
judgment; a general coding agent (Pi) is the fallback for unsupported requests, and every fallback queues a
bounded attempt to write a workflow so the next such request avoids the agent. Design decisions and their
alternatives are recorded in [decision-log.md](decision-log.md).

The code in `src/` is split into four folders. Imports only point one way:

```text
cli  ->  adapters  ->  workflows  ->  core
```

A folder may import itself and anything to its right, never anything to its left. When a lower folder needs
something from the outside world, such as Git, the TypeSafe SDK, or a coding agent, it declares an interface
(a "port") and a higher folder supplies the implementation. `test/architecture.test.ts` scans every import,
including `import type`, dynamic `import()` and `require()`, and fails the build on a wrong-way import.

## One job per folder

| Folder      | Job                                                                                                     | Must not use                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `core`      | Send structured questions to Jev safely: validate answers, enforce budgets, batch, retry; the workflow contract | npm packages, `fs`, `child_process`, the SDK; only `node:` built-ins |
| `workflows` | Product logic: gather evidence, run exact checks, ask questions, turn answers into a report; agent port and improvement model | any package or Node built-in, `process.env`, the SDK                 |
| `adapters`  | Real implementations of the ports: read-only Git, file reads, parsers, redaction, SDK client, Pi, the improvement queue | the `cli` folder                                                     |
| `cli`       | Parse arguments, wire adapters into workflows, route, delegate, print output, choose the exit code      | nothing                                                              |

`src/cli.ts` (the `stanley` binary) and `src/index.ts` (package exports) belong to `cli`. Every other
production file must live in one of the four folders. Tests and scripts may import anything.

## What happens in a run

Using `check` as the example:

1. **cli** parses the natural-language request and the few host options (`--input`, `--scope`, `--base`,
   `--repo`, `--json`, `--no-persist`, `--no-agent`), reads `TYPESAFE_API_KEY` and `TYPESAFE_MODEL`
   through `adapters/config.ts`, builds the dependencies in `adapters/dependencies.ts`, and resolves the
   coding agent from the environment (`adapters/pi.ts`): `null` when `--no-agent`, `STANLEY_AGENT=off`,
   `STANLEY_NESTED` is set, or no `pi` binary is installed.
2. **registration** (`cli/builtins.ts`, `cli/registry.ts`, `adapters/workflows.ts`) builds the ten built-ins as
   ordinary workflow objects bound to this invocation, then discovers trusted `.ts`, `.js`, and package
   workflows under `.stanley/workflows/`, imports them through `tsx`, awaits their factories, quarantines
   individual failures, and registers valid ones beside the built-ins. Duplicate IDs fail registration. If
   validated improvement candidates await review, one stderr line says so; if improvement jobs are pending and
   no worker is alive, a worker is started (see below).
3. **routing** (`cli/router.ts`) receives the redacted request plus deterministic facts: diff presence
   (`workflows/common.ts#diffPresence`, which counts safe untracked files exactly as workflows load them;
   `cli/facts.ts` loads it once per routing decision and lets the fallback explanation reuse it),
   input shape, and, from the registry, every workflow's JSON routing metadata and its
   `available` verdict on those facts. One validated choice selects a candidate or `cannot_tell`. Fixed
   confidence thresholds (`ROUTING_POLICY`) and the capability verdicts turn uncertain or unavailable choices
   into the built-in fallback; the *reason* is kept because it decides whether the agent may be used.
4. **workflow** (`workflows/check.ts`) validates every input, asks the source port for the diff once, and
   has the evidence port parse it into hunks (changed blocks). It skips secret-shaped paths, binaries and
   vendored files, starts one `Run`, and hands the diff to its sections.
5. **Exact checks** run in code first (`workflows/hunks.ts`, `classify.ts`): skip markers, removed assertions,
   deleted tests, whitespace-only edits, lockfile, CI and config changes. Lockfile and generated hunks are
   settled here and never reach Jev; every other signal, including `formatting_only`, is an observation that
   accompanies the hunk to Jev rather than a reason to skip it.
6. **Questions.** For each remaining piece, the workflow builds a request: a small JSON state plus
   fixed-choice questions (yes/no, choice or score). `workflows/run.ts` redacts it and hands it to
   `core/executor.ts`, which reserves budget, calls the Jev port, validates the answer shape and retries
   transient failures or invalid model responses. If the budget is exhausted or Jev is unavailable during a
   run, the piece is marked unjudged instead. This lives in `core`, so it is the same for every workflow.
7. **Decisions** are made in code with fixed, versioned thresholds (`workflows/policy.ts`), not by the model.
   Unclear answers are "parked" for a human to look at.
8. **Result.** `Run` builds an internal `stanley.packet/v1` packet. `cli/prompt-result.ts` projects built-in
   output to workflow-neutral `{ status, output: { text, data } }`; JSON CLI output uses
   `stanley.prompt-result/v1` and omits workflow and run identity. A repository workflow's raw text/JSON is
   normalized to `{ status: "complete", output }`, or kept as-is when it returns its own `{ status, output }`.

On this path the coding agent is never invoked, nothing is queued, and no worker is started; the smoke test and
`test/agent.test.ts` assert exactly that.

## The agent fallback

When step 3 finds no workflow, `cli.ts` decides between two fallbacks:

- **Delegate** (`workflows/agent.ts`, `adapters/pi.ts`) when an agent is available, the shared budget is not
  exhausted, and the request is *confidently* unsupported: an action request (`implement`, `fix`, `deploy`,
  `run the tests`, …) that no repository workflow claims, or a request the router explicitly placed outside
  every workflow.
  The agent receives `delegationInstructions(request, input)` on stdin, the invocation's abort signal, and a
  wall-clock limit (600 s, fixed policy). `delegationResult()` turns the run into the
  same `PromptResult` envelope: `complete` only when the agent finished its turn, `incomplete` on timeout,
  cancellation or failure, always prefixed "handled by an external coding agent; Stanley did not verify the
  result", with `output.data.handledBy = "coding_agent"` and a `notChecked` list. Exit codes follow the status.
- **Explain** (unchanged) for everything else: uncertain routing, capability-gated routing (for example `check`
  with no diff), routing errors, budget exhaustion, `--no-agent`, nested invocations, or no installed agent.
  Implement/fix requests still get the read-only relevant-code analysis with `status: "unsupported"`.

Nested `prompt()` calls never delegate; an agent is not a composable sub-workflow. Every agent subprocess runs
with `STANLEY_NESTED=1`, so an agent that runs `stanley` itself gets a Stanley that cannot delegate or queue.

The workflow directory is guarded around every delegation: `cli.ts` fingerprints `.stanley/workflows/` before
and after the agent run. Files and symlinks the agent added are moved to `.stanley/quarantine/<stamp>/` (never
deleted; a symlink is moved as a link, not followed) and files it modified or removed are reported; both appear
as stderr warnings and in the result's `notChecked`. A
task agent can therefore edit the repository but cannot silently activate a workflow; activation stays with
`--promote-candidate`.

`CodingAgentPort` is the seam: `adapters/pi.ts` spawns `pi --mode json --print --no-session --no-approve`
and reads Pi's JSON event lines (`tool_execution_start` counts tool calls; the last assistant `message_end`
is the result; `stopReason: "error"` is a failure). `adapters/fake-agent.ts` is the deterministic port used by
every test and the smoke run. No test runs Pi or any model.

## The improvement loop

After a delegated run, `cli.ts` creates an `ImprovementJob` (`workflows/improve.ts`) from the redacted
request and hands it to `adapters/improvements.ts`:

```text
.stanley/improvements/pending/<job>.json   written before the CLI returns; exclusive create, one per request
.stanley/improvements/active/<job>.json    claimed by a worker with a pid + lease; stale leases are re-queued
.stanley/improvements/done/<job>.json      finished; never queued again automatically
.stanley/improvements/worker.lock          one worker per repository (pid-stamped, dead pids are stale)
.stanley/improvements/worker.log           append-only worker diary
.stanley/candidates/<job>/                 the agent's workflow file plus host-written candidate.json
```

**Lifecycle.** The CLI starts `node cli.js --improve-worker --repo <root>` detached (`stdio: "ignore"`,
`unref()`), so the worker outlives the CLI process. The worker acquires the lock, re-queues abandoned jobs,
claims pending jobs one at a time, and exits when the queue is empty. Any later CLI run that sees pending jobs
and no live worker starts one, so a killed worker never strands the queue. `stanley --improve-worker` runs the
same loop in the foreground; that is what the smoke test and `test/improvements.test.ts` use.

**One job.** The worker snapshots `git status` and the worktree diff, runs the agent with
`improvementInstructions()`, a brief that states the workflow contract, the Jev-first design rule, the reserved
ids, the active repository workflows as examples, and the shipped reference workflow
(`examples/workflows/stale-todo-audit.ts`, byte-identical to the embedded copy), and tells the agent to write
exactly one file under `.stanley/candidates/<job>/` or nothing. It then validates:

1. the candidate directory loads through `loadWorkflows()` with exactly one valid workflow and no quarantine;
2. the id is not a built-in or active repository workflow id, nor a router label such as `cannot_tell`;
3. nothing outside the candidate directory changed (new status entries or a changed worktree diff), checked
   after the agent run *and again after the candidate module was imported and its factory awaited*, because
   loading executes agent-authored top-level code; such changes are reported, never reverted;
4. optionally, the router selects the candidate for the original request (`routeCheck`), routed on the job's
   request and recorded input shape, beside every registered workflow, with the candidate's own `available`
   gate applied to those facts, exactly as it would be routed once promoted.

The record `candidate.json` is `validated` or `rejected` with reasons. A job whose agent timed out or crashed
without writing outside its directory is retried once; every other outcome is final. A candidate's `run` never
executes before promotion; its module top level and factory execute during validation and promotion, exactly as
any repository workflow load does.

**Activation is explicit.** `stanley --promote-candidate <id>` re-validates the candidate, refuses duplicate
ids and existing destinations, and moves the file into `.stanley/workflows/`, the only part of `.stanley/` that
Git sees. From then on the promoted workflow is an ordinary trusted repository workflow: the router selects it,
it runs deterministic code, and it asks Jev through `judge`. Nothing is activated automatically.

## One workflow contract: registry, runtime, `prompt`, and `judge`

`core/workflow.ts` defines the single `Workflow` contract: `id`, `run(context)`, and optional
`available(facts)` (a deterministic eligibility gate over diff presence and input shape) and `cleanup`; every
other field is JSON routing metadata, and an `options` field is rejected because workflows cannot add CLI
flags. Built-ins (`cli/builtins.ts`) are typed descriptions (info, routing text, gate, whether input is
consumed, typed run, renderer, and how to derive typed input from the request and input) turned into
`Workflow` objects bound to one invocation; repository workflows and
promoted candidates are the file-based form of the same contract. All of them live in one `WorkflowRegistry`
(`cli/registry.ts`), which is the only source of routing candidates, capability verdicts, and executables. One
`WorkflowRuntime` (`cli/runtime.ts`) runs whichever workflow was selected and composes child prompts. A
workflow `run` receives `{ request, input, root, prompt, judge, signal, log }` and nothing else; the request
is the task and the semantic instructions, the input is the one piece of external evidence:

- `prompt(instructions, input?)` composes by intent: the router picks whichever available workflow fits.
- `judge({ scope, state, questions })` asks Jev bounded fixed-choice questions (`noul`, `choice`, `score`)
  about evidence the workflow supplies. `cli/judge.ts` builds it on the same `FrameExecutor` built-ins use,
  with request validation (`core/workflow.ts`), redaction, the shared budget, answer validation
  (`core/validation.ts#readAnswers`), and a cap of 64 calls per run and 8 questions per call. It returns
  `{ ok: true, answers }` or `{ ok: false, reason }` and never throws.
- `log` is the structured workflow log. `warn` and `error` records from initialization and `run` are written
  to stderr as `stanley: workflow <source> <level>: <message>`, redacted and bounded like host warnings;
  `debug` and `info` records are discarded.

A repository whose workflows collide on an id, with each other or with a built-in, or claim a router label is
reported as an input error (exit 65), not an internal failure.

## Why core is thin

`core` knows nothing about diffs, logs, tests, findings, files, redaction rules, agents or the SDK. It only
knows how to send a question set through a `JevPort`, check the reply against the questions asked, stay within
request, token and time budgets, and validate the workflow control envelope. Keeping product meaning out of
`core` means every workflow and every `judge` call gets the same budget, retry and validation behavior, and
`core` can be tested with a fake port and no I/O.

Built-ins use Jev as a probabilistic zero-shot classifier and ranker, not as a code-writing or free-form review
agent. Frames present bounded evidence and explicit labels. Built-ins retain distributions and combine related
probability mass in code; deterministic pattern matches (a `formatting_only` hunk, a compiler-error or network
signature in a log) travel with the evidence as observations and never replace a judgment. The separate intent
router may select a trusted action-capable repository workflow.

## Safety boundaries

- **Built-ins are read-only on the repository.** The Git adapter runs read-only commands (`status` included).
  File reads stay inside the workspace and refuse credential-shaped paths. Built-in writes are run records
  under `.stanley/`.
- **Built-in workflows cannot reach the outside world directly.** They cannot import `fs`, `child_process`, the
  SDK or `process.env`, so every side effect goes through a port that the architecture test can see.
- **Host-managed routing, built-in evidence, `judge` state, agent output, and improvement records are redacted
  first**, through `RedactionPort` and the recorder. Redaction is best effort, not a secret scanner; trusted
  repository workflows control their own I/O.
- **Repository text is untrusted evidence.** Workflows ask Jev whether a piece contains text aimed at an
  automated reviewer and flag it. That is a hint, not a prompt-injection defense. Built-in evidence answers never
  trigger actions; only intent routing can select an explicitly trusted repository workflow.
- **Repository workflows are explicitly trusted.** They run in-process and may use filesystem, shell, network,
  environment, and Git APIs directly. They are offered mutating requests before the fallback. Users must review
  workflow source as they would any repository script. Promotion is the moment an agent-authored candidate
  becomes trusted, which is why it is manual.
- **The coding agent is trusted like a repository workflow and bounded like a built-in.** It is enabled only by installing
  Pi (or `STANLEY_PI_BIN`), can be disabled per run or per environment, receives a hard time limit and the
  invocation's abort signal, and cannot recurse into another delegation. Stanley never claims to have
  verified its work.
- **Fallbacks do not claim completion.** Without an agent, unsupported implementation requests may run bounded
  `find` analysis, but the outer status remains `unsupported`. With an agent, the status reflects only whether
  the agent finished, and the text says so.
- **Budgets are shared hard stops.** Routing, every nested built-in executor, and every `judge` call reserve
  from one top-level request-count, input-token, and wall-clock budget. One tree also allows at most eight
  nested prompt levels and 32 child calls, with active-stack cycle detection.
- **Improvement work is confined and reviewed.** The improvement agent may only write into its candidate
  directory; writes elsewhere, including writes made while the candidate module is imported for validation,
  reject the candidate (and are reported, not reverted). A candidate's `run` never executes until promoted.
- **What is and is not redacted.** Instructions handed to an agent are verbatim (the agent needs the exact
  task and runs as the user); everything that comes back and is shown or persisted is redacted.

## Records

For built-in workflow runs, unless `--no-persist` is set, `adapters/recorder.ts` writes
`.stanley/runs/<run-id>/`: `manifest.json`, `inputs.json`, `candidates.json`, `packet.json`, and when relevant
`decisions.ndjson`, `events.ndjson` and `frames.ndjson` (every Jev request and response). Files are `0600`,
directories `0700`. `.stanley/.gitignore` ignores generated state (`runs/`, `improvements/`, `candidates/`)
while explicitly allowing `workflows/` to be committed.

## Built-in workflows and sections

The public CLI has no workflow subcommands or explicit route override. Its ten built-ins are described once
each in `cli/builtins.ts` (`BUILTINS`) and registered as ordinary workflows; repository workflows and promoted
candidates join the same registry dynamically. There is no static list of router outcomes anywhere else:

| Built-in id            | Module                       | Function                | Packet `workflow`         |
| ---------------------- | ---------------------------- | ----------------------- | ------------------------- |
| `find`                 | `workflows/find.ts`          | `find()`                | `find@1`                  |
| `check`                | `workflows/check.ts`         | `check()`               | `check@1`                 |
| `triage_failures`      | `workflows/triage.ts`        | `triageFailures()`      | `triage@1`                |
| `triage_comments`      | `workflows/triage.ts`        | `triageComments()`      | `triage@1`                |
| `review`               | `workflows/analyze-diff.ts` | `review()`              | `review@1`                |
| `test_gaps`            | `workflows/analyze-diff.ts` | `testGaps()`            | `test_gaps@1`             |
| `summarize`            | `workflows/analyze-diff.ts` | `summarize()`           | `summarize@1`             |
| `security_review`      | `workflows/analyze-diff.ts` | `securityReview()`      | `security_review@1`       |
| `performance_review`   | `workflows/analyze-diff.ts` | `performanceReview()`   | `performance_review@1`    |
| `compatibility_review` | `workflows/analyze-diff.ts` | `compatibilityReview()` | `compatibility_review@1`  |

`cannot_tell` is the router's own reserved label, not a workflow result; no workflow may claim it. It invokes
the fallback described above. `test/cli.test.ts` fixes the built-in set and exercises each typed entry point;
`test/workflow.test.ts` covers the contract, registry, and runtime.

`check` and `triage` are built from **sections**. A section is not a workflow: it has no `WorkflowInfo`, never
starts a `Run`, and never loads a diff. The workflow does those once and passes them in. A section plans its
candidates first, then judges, and returns a `SectionReport` (`workflows/common.ts`) that the workflow merges
into the single packet.

- `check` always runs `check-task.ts` (task alignment, test safety, exact checks). `check-rules.ts` runs when
  rules are supplied and `check-criteria.ts` when criteria are. Sections judge in that fixed order and share
  one budget. Each result row carries `section`; `summary` has one entry per section.
- `triageFailures()` and `triageComments()` fix the input kind before calling the shared `triage` workflow,
  which runs exactly one of `triage-failures.ts` or `triage-comments.ts`. Parsing and classification are
  specific to the kind. Each result row carries `kind`.
- Six diff-analysis entry points share `analyze-diff.ts`, but each fixes a distinct taxonomy, policy, run name
  and router target. Jev classifies one hunk at a time. Code combines probability mass across related concern
  labels, applies importance and evidence gates, and parks material concerns that need outside context. A
  deterministic mode-specific priority controls runs bounded by the policy hunk cap.

Thresholds stay with the section that uses them, each with its own policy version (for example
`check-task-policy@1`), so a decision record always names the policy that made it.

## Adding a workflow

The preferred way is a repository workflow: write `.stanley/workflows/<id>.ts` in the shape of
`examples/workflows/stale-todo-audit.ts` (deterministic evidence, `judge` for the fixed-choice parts, code for
the decision), or let the improvement loop draft one and promote it after review. Declare `available` if it
needs a deterministic gate; it cannot declare CLI flags, so anything it needs comes from the request and the
input. Add a built-in only when the workflow needs typed sections or a persisted run record:

1. Add `src/workflows/<name>.ts`. Export a `WorkflowInfo` and a typed run function that uses only ports from
   `workflows/ports.ts` and the `Run` helper. Put thresholds in code with a policy version. Prefer a new section
   of an existing workflow over a new built-in.
2. If it needs a new kind of outside input, add a method to a port and implement it in `adapters/`.
3. Describe it once in `src/cli/builtins.ts`: routing text, `available` gate, whether it consumes input, how to
   derive typed input from the request and input, and the human renderer. Nothing else needs to change.
4. Add routing and workflow tests with the fake Jev adapter (`adapters/fake-jev.ts`) and, where an agent is
   involved, the fake agent (`adapters/fake-agent.ts`), then run `npm run check`.
