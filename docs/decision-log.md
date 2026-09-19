# Decision log

Durable record of product, architecture, and security decisions, newest last. Each entry states the decision,
the alternatives considered, and why. Entries are never edited after the fact; a later entry supersedes an
earlier one by reference. Workflow-system decisions that predate this log live in
[workflow-design-decisions.md](workflow-design-decisions.md) (entries before D-16 call repository workflows
"plugins" and their directory `.stanley/plugins/`; both were renamed in D-16).

## D-01 (2026-09-18) Product name: Stanley

**Decision.** The product, CLI binary, help, schemas, runtime state directory, diagnostics, docs, tests, and
package metadata use the name Stanley. The word "Jev" remains wherever it accurately names TypeSafe's Jev
model, SDK, API, or the Jev-first architecture (`JevPort`, `jevFromEnvironment`, `jev-1.13.0`, "Jev routes the
request").

**Alternatives.** Keep `jev-code` (rejected: brand confusion with TypeSafe's Jev); rename Jev integration
identifiers too (rejected: they are technically accurate and renaming them would hide what the code talks to).

**Enforcement.** `test/naming.test.ts` fails on any product-owned `jev-code`/`jev_code`/`jevcode` identifier
outside an explicit allowlist, and asserts that the technology identifiers are kept.

## D-02 (2026-09-18) npm package `stanley-code`, binary `stanley`, repository URL unchanged

**Decision.** The npm package is `stanley-code` and the binary is `stanley`. The GitHub repository stays
`devagrawal09/jev-code`; `package.json` `repository.url`, badges, clone instructions, the release workflow's
repository guard, and the trusted-publisher instructions keep it.

**Verification.** `https://registry.npmjs.org/stanley` returns an unrelated package (`stanley@0.0.1`,
"hammer dependencies into a package json file"), so the bare name is not available. `stanley-code`,
`stanley-agent`, `stanley-cli`, and `@stanley-ai/stanley` all returned 404 (available) on 2026-09-18. The
`jev-code@0.0.1` placeholder on npm remains published and unrelated to Stanley.

**Alternatives.** `stanley-agent` (viable; `-code` was kept because it mirrors the previous name and the
"coding agent" positioning); scoped `@devagrawal09/stanley` (guaranteed available, but scoped names are less
discoverable and would change the trusted-publisher setup); renaming the GitHub repository (not done: a
repository rename cannot be assumed safe from this worktree and redirects are outside this change).

**Consequences.** `scripts/release-checks.ts` requires `name === "stanley-code"` and the historical repository.
The trusted publisher on npmjs.com must be configured for the new package before the first release.

## D-03 (2026-09-18) Positioning: Jev-first, self-improving coding agent

**Decision.** The hot path is deterministic code plus bounded Jev judgment (built-ins and plugins). A general
coding agent is a fallback only for requests no installed workflow supports, and every fallback triggers a
bounded attempt to write a workflow so the next such request avoids the agent.

**Alternatives.** Agent-first with Jev as a checker (rejected: slow, expensive, unverifiable by default);
no agent at all (rejected: unsupported requests would stay unsupported forever).

## D-04 (2026-09-18) Coding agents are integrated through a port; Pi is the production adapter

**Decision.** `workflows/agent.ts` declares `CodingAgentPort` (`run(task, { signal, timeoutMs })`).
`adapters/pi.ts` implements it by spawning the installed `pi` binary (`@earendil-works/pi-coding-agent`,
0.85 verified locally) with `--mode json --print --no-session --no-approve`, instructions on stdin, and a
JSON-lines event reader. `adapters/fake-agent.ts` is the deterministic implementation for tests and smoke.

**Alternatives.** Link Pi's SDK (`createAgentSession`) in-process (rejected: pulls Pi's dependency tree,
credentials, and settings into Stanley's process, and Pi's engine floor is Node 22.19 versus Stanley's 22.18);
Pi RPC mode (rejected for now: more surface than a one-shot print run needs); a generic "any agent CLI" adapter
(rejected: no stable contract to test against).

**Why stdin.** Instructions can contain repository text; passing them on stdin keeps them out of process
listings. The argv message only tells Pi to read stdin.

**Not a test prerequisite.** No test or smoke case runs Pi or any model. `test/pi.test.ts` uses a stand-in
`pi` script that speaks the JSON event protocol, so process handling (timeouts, cancellation, crashes, env)
is covered deterministically.

## D-05 (2026-09-18) When Stanley delegates

**Decision.** At the top level only, and only when the request is *confidently* unsupported: an action
request (`implement`, `fix`, `deploy`, `run the tests`, …) that no plugin claims, or a request the router
explicitly placed outside every workflow (`cannot_tell` with adequate confidence). Uncertain routing
(`model_uncertain`), capability-gated routing (for example `check` with no diff), routing errors, and
exhausted budgets never delegate; they ask for clarification as before. Nested `prompt()` calls never
delegate: an agent is not a composable sub-workflow.

**Alternatives.** Delegate everything unroutable (rejected: an ambiguous "take a look" would start an
unbounded agent run); require an explicit opt-in flag per run (rejected: the whole point is a fallback the
caller does not have to think about; `--no-agent` and `STANLEY_AGENT=off` provide the opt-out).

**Trust.** Delegation is action-capable and runs with the user's privileges, like a trusted plugin. It is
enabled only when the user has installed Pi (or set `STANLEY_PI_BIN`).

## D-06 (2026-09-18) Delegated results are truthful and workflow-neutral

**Decision.** A delegated run returns `status: "complete"` only when the agent finished its turn, and
`incomplete` on timeout, cancellation, or failure. `output.text` starts with "handled by an external coding
agent; Stanley did not verify the result"; `output.data` carries `handledBy: "coding_agent"`, the outcome,
tool-call count, duration, the redacted agent summary, and a `notChecked` list. No adapter name, workflow id,
or run id appears in public output.

**Alternatives.** Return `unsupported` even when the agent did the work (rejected: untruthful); claim
`complete` after verifying the diff with a built-in review (deferred: a good follow-up, but it would spend
budget on every fallback and still not prove the task was done).

## D-07 (2026-09-18) Improvement attempts are a durable on-disk queue with a detached worker

**Decision.** After a delegated run, the CLI writes `.stanley/improvements/pending/<job>.json` (exclusive
create, one job per normalized request) *before* returning, then starts `node cli.js --improve-worker --repo
<root>` detached with stdio ignored and `unref()`. The worker takes a pid-stamped lock, re-queues jobs whose
lease expired or whose worker pid is dead, claims jobs one at a time (`pending` → `active` with a lease →
`done`), and stops when the queue is empty. Any later CLI run that finds pending jobs and no live worker
restarts one. `--improve-worker` runs the same loop in the foreground for CI, debugging, and tests.

**Alternatives.** Fire an unreferenced promise before exit (rejected: the CLI exits and the work is lost);
process the queue lazily on the next CLI run only (rejected: not asynchronous, and the next run pays for it);
an OS service or cron entry (rejected: installation burden for a repository-local tool); a long-lived daemon
(rejected: more lifecycle than a CLI should own).

**Bounds.** One worker per repository; 20 pending jobs; 15 minutes per agent run; two attempts per job and
only when the agent timed out or crashed; a job is never re-queued automatically once it reaches `done`
(delete the record to retry).

## D-08 (2026-09-18) Agent-authored workflows are staged and validated, never auto-activated

**Decision.** The improvement agent writes into `.stanley/candidates/<job>/` only. The worker then loads the
directory with the same loader used for active plugins, requires exactly one valid plugin, rejects reserved
or duplicate ids, checks with `git status`/diff snapshots that nothing outside the candidate directory
changed (without reverting anything), optionally asks the router whether the candidate would be selected for
the original request, and writes `candidate.json` (`validated` or `rejected`). Activation is an explicit
`stanley --promote-candidate <id>`, which re-validates and moves the file into `.stanley/plugins/`, where it
is visible to Git for review and commit. Each normal run prints a one-line stderr notice while validated
candidates await review.

**Alternatives.** Auto-promote validated candidates (rejected: agent-authored code would run with full user
privileges without a human ever reading it; the plugin model requires review); keep candidates in a separate
"untrusted" runtime with fewer privileges (rejected for this slice: there is no sandbox for in-process
plugins, so a candidate that runs is a trusted plugin by definition).

**Consequences.** `.stanley/.gitignore` ignores `improvements/` and `candidates/` and allows `plugins/`, so a
promoted workflow is the only artifact that reaches version control.

## D-09 (2026-09-18) `judge` joins `prompt` as a plugin primitive

**Decision.** Plugin `run` contexts receive `judge({ scope, state, questions })`: the same budgeted,
validated, redacted frame executor built-ins use, capped at 64 calls per run and eight questions per call,
returning validated typed answers or a failure reason (never throwing). This supersedes the earlier
"raw Jev is not exposed" principle in spirit only: `judge` is not raw Jev. The host validates the request
shape, redacts state, charges the shared budget, and validates answers against the questions asked.

**Alternatives.** Plugins compose only whole built-ins through `prompt()` (rejected: agent-authored workflows
need small fixed-choice questions about their own evidence, otherwise "deterministic code plus Jev judgment"
is impossible for new task kinds); expose the `FrameExecutor` directly (rejected: unbounded and unvalidated).

## D-10 (2026-09-18) Built-ins, repository plugins, and candidates are one workflow model

**Decision.** Everything Jev can route to lives in one `WorkflowRegistry`, produces one `PromptResult`
envelope, and shares one budget tree. Built-ins stay typed TypeScript entry points (they take CLI options such
as `--rules`), repository plugins and promoted candidates are the file-based form of the same contract, and
`examples/plugins/stale-todo-audit.ts` is the canonical reference: it is byte-identical to the example embedded
in every improvement brief (enforced by a test).

**Alternatives.** Rewrite built-ins as plugin files (rejected for this slice: they need typed options and
sections, and the rewrite would be a platform change rather than a vertical slice).

## D-11 (2026-09-18) Recursion, budgets, cancellation, and redaction across the agent boundary

**Decision.** Every agent subprocess receives `STANLEY_NESTED=1`; a nested `stanley` never delegates or queues
improvements. The delegated run gets the invocation's `AbortSignal` (SIGTERM, then SIGKILL after a grace
period) and a wall-clock limit (`--agent-timeout-seconds`, default 600). Agent output and improvement
records pass through the redactor before display or persistence. Jev budgets are unaffected by agent runs;
routing and `judge` calls inside promoted workflows draw from the shared budget as before.

**Alternatives.** Strip `TYPESAFE_API_KEY` from the agent environment (rejected: the agent runs with the
user's own environment, and a candidate workflow may need Jev to be exercised; documented instead).

## D-12 (2026-09-18) The old `jev-code` package name gets no compatibility layer

**Decision.** No aliases, deprecated re-exports, or `.jev-code/` migration. Nothing with the old name was
released with working behavior (`jev-code@0.0.1` is an empty placeholder), so there is no persisted data or
external consumer to protect. The recorder still migrates the one-line `.stanley/.gitignore` it may have
written itself under the new name.

## D-13 (2026-09-18) Verification status of the live Pi interface

**Decision.** The Pi contract is verified three ways, none of which the test suite depends on a model for:
(1) Pi 0.85's shipped `docs/json.md`, `print-mode.js`, and `--help` were read for the flag set and event
shapes; (2) `test/pi.test.ts` drives the real adapter against a stand-in `pi` executable that speaks the same
protocol (finished, model error, crash, timeout, cancellation, missing binary, env, argv, stdin); (3) one live
invocation of the installed `pi` through `createPiAgent` in this worktree accepted
`--mode json --print --no-session --no-approve --no-tools`, merged stdin, emitted the JSON session header, and
then stopped at "No API key found for the selected model" because the sandbox in which this work ran cannot
access Pi's credential store (Pi's provider readiness check reported `ready` outside that path). The adapter
reported that truthfully as `outcome: "failed"` with the message as `detail`, which is the behavior wanted.

**Residual risk.** A full model-backed delegation has not been observed end to end from this worktree. The
first real run should be done by a person with Pi credentials: `stanley "Deploy nothing; reply OK" --json` in a
scratch repository, then `stanley --improve-worker` to watch a candidate being staged.

## D-14 (2026-09-18) Review findings: containment, lock takeover, claim loop, plugin-directory guard, and what is not redacted

An independent review of the slice found five defects; all are fixed and tested (`test/improvements.test.ts`,
`test/agent.test.ts`).

1. **Containment covers candidate loading.** Validating a candidate imports its module and awaits its factory
   (never `run`), which executes agent-authored top-level code inside the worker. The outside-write check is
   now taken again after loading and cleanup, so a factory that writes elsewhere rejects the candidate. An
   agent whose run already wrote outside its directory is not retried. Precise statement of the boundary:
   a candidate's `run` never executes before promotion; its module top level and factory execute during
   validation and promotion, exactly as any plugin load does.
2. **Atomic stale-lock takeover.** A stale `worker.lock` (dead pid or too old) is taken over by `rename` to a
   unique name before a new lock is created, so two workers racing on the same stale lock cannot both hold it.
3. **No claim spin.** A pending entry that cannot be claimed (unreadable, not a file, rename refused) is
   skipped once per worker run and logged, bounding the loop.
4. **Plugin-directory guard around delegation.** A delegated task agent runs with the user's privileges and
   could write straight into `.stanley/plugins/`, bypassing the staged-candidate boundary (D-08). The CLI now
   fingerprints the plugin directory before and after delegation. Files the agent *added* are moved to
   `.stanley/quarantine/<stamp>/` (never deleted); files it *modified or removed* are reported (the previous
   content is not restored, but `.stanley/plugins/` is visible to Git so the change can be reviewed there). Both
   cases print a stderr warning and are listed in the result's `notChecked`. Legitimate edits elsewhere in the
   repository are untouched. Alternatives: block loading of changed plugins on later runs (rejected: needs a
   persistent trust manifest); revert modifications from a content backup (deferred: the fingerprint keeps
   hashes, not content).
5. **Instructions are not redacted; outputs are.** `AgentTask.instructions` (the request and any supplied
   input) are handed to the agent verbatim: the agent runs in the user's own environment and needs the exact
   task, and redacting it would corrupt the work. The redactor is applied to everything that comes back and is
   shown or persisted: agent text and detail, improvement job requests, candidate reasons and summaries. The
   earlier doc comment claiming callers redact instructions was wrong and has been corrected.

## D-15 (2026-09-19) GitHub repository renamed to `stanley-code`

**Decision.** The GitHub repository is renamed from `devagrawal09/jev-code` to
`devagrawal09/stanley-code`. Product-facing badges, clone instructions, package metadata, release guards, and
trusted-publisher instructions use the new URL. The old repository name remains only in this historical decision
log and in the statement that the placeholder package was previously published under that name.

**Reason.** The product name is Stanley and the repository should no longer reinforce the old brand. The
repository rename is now explicitly authorized, unlike the earlier D-02 decision.

## D-16 (2026-09-19) One workflow contract; "plugins" become repository workflows

**Decision.** Stanley has one workflow concept. The public `Plugin` contract and the internal built-in
`WorkflowDefinition` are merged into a single `Workflow` (`src/core/workflow.ts`): `id`, `run(context)`,
optional `options` (accepted CLI option names), optional `available(facts)` (a deterministic eligibility gate
over diff presence and input shape), optional `cleanup`, and JSON routing metadata for everything else.
Built-ins are constructed as ordinary `Workflow` objects (`src/cli/builtins.ts`) and registered in the same
`WorkflowRegistry` as repository workflows; one `WorkflowRuntime` executes both. The registry is the sole
source of routing metadata, capabilities, and executables: the router's static outcome list, the separate
built-in dispatch tables, and the per-workflow option map in the CLI are gone. Repository workflows are
discovered from `.stanley/workflows/` (formerly `.stanley/plugins/`); every plugin-named identifier, file, doc,
and message is renamed, with no aliases, because nothing with the old names was released (D-12).

Two contract additions follow from unification. First, `run` may return `{ status, output }` to set its own
status; built-ins need this for `incomplete` and `budget_exhausted`, so repository workflows get it too.
Second, the top-level `run` receives `context.options`, the values of the options the workflow declared.
Nested prompts still inherit operational context only. This supersedes the earlier principle that parsed CLI
options are never exposed: they are exposed only when declared, and a repository workflow that declares none
keeps the previous behavior (`--input`, `--scope`, `--base`).

**Correctness fixes in the same change.** (1) `check` no longer skips Jev for hunks whose added and removed
lines squash to the same text; whitespace can change behavior (indentation, templates, literals), so
`formatting_only` is now an info-level observation Jev also sees, not a reason to skip the task or rules
sections. (2) Failure triage no longer lets regex signatures decide: a compile-error match no longer forces
`failureKind`, and an environment match no longer forces `relation` or parks a conflict. They remain in
`observed`, in the frame state, and as info findings (`compile_error_signature`, `environment_signature`).
The structural stack-touches-changed-file conflict stays. Policy version `triage-failures-policy@3`. (3)
Routing's "diff present" fact is computed with `diffPresence()`, which loads the diff exactly as workflows do,
so safe untracked files count and secret-shaped ones do not.

**Alternatives.** Keep two contracts and adapt built-ins into plugin objects at registration (rejected: two
sources of truth for options and eligibility remain); pass a `depth` flag instead of `context.options`
(rejected: less useful and still needs the CLI to own per-workflow option parsing); expose all parsed options to
every workflow (rejected: undeclared options are usage errors and should stay that way); a JSON manifest per
workflow (rejected: the module is the manifest; no configuration language).

**Enforcement.** `test/workflow.test.ts` (contract, registry, runtime), `test/cli.test.ts` (untracked-only
routing), `test/check.test.ts` (whitespace-sensitive hunks are judged), `test/triage.test.ts` (regex hints do
not override Jev), and `test/naming.test.ts` (`WORKFLOW_DIRECTORY`).

## D-17 (2026-09-19) The command line is minimal; workflows cannot add flags

**Decision.** The public CLI is reduced to host controls that cannot be stated safely in prose: `--input`,
`--scope`, `--base`, `--repo`, `--json`, `--no-persist`, `--no-agent`, `--help`, `--version`, plus the
administrative `--improve-worker` and `--promote-candidate`. Every workflow-specific flag is gone
(`--task`, `--task-file`, `--task-source`, `--rules`, `--criteria`, `--criteria-file`, `--test-results`,
`--max-hunks`, `--max-pairs`, `--max-evidence`, `--max-items`, `--max-files`, `--top`, `--excerpts`,
`--paths`, `--no-diff`), and so are the tuning flags (`--model`, `--concurrency`, `--max-requests`,
`--max-input-tokens`, `--timeout-seconds`, `--agent-timeout-seconds`). The request is the task and the
semantic instructions; one generic `--input` (or piped stdin) is the only external evidence. The `Workflow`
contract loses the `options` control field introduced in D-16, `WorkflowRunContext.options` is gone, and a
workflow that declares `options` fails validation. Built-ins derive typed input from the request and the input
alone: `check` reads a rules document or acceptance criteria by shape, triage reads a log or comment JSON,
and the diff is attached whenever the selection has one.

**Retained, and why.** `--scope`/`--base` name exact Git refs; guessing a ref from prose would be unsafe and
would reintroduce intent parsing. `--repo` is where the repository is. `--input` is the one evidence slot.
`--json` and `--no-persist` are output and privacy controls. `--no-agent` is an explicit safety switch (the
environment variable `STANLEY_AGENT=off` does the same). The model stays selectable through `TYPESAFE_MODEL`;
Pi through `STANLEY_PI_BIN` and `STANLEY_AGENT_MODEL`.

**Fixed instead of flags.** The invocation budget (`DEFAULT_TREE_BUDGET`), per-workflow budgets and hunk,
pair, evidence, item, and file caps (each section's policy), the agent time limit (`AGENT_LIMITS`), and
executor concurrency are policy constants. Embedders and tests may override the shared budget through
`CliInjections.budget`; that is a library seam, not a flag.

**Given up.** Test records as evidence for criteria need two inputs at once, so they are no longer reachable
from the CLI; `check()` still accepts `testResults` for TypeScript workflows. Exact task text that differs from
the request is no longer separable: the request is the task.

**Alternatives.** Keep a small allowlist of workflow flags (rejected: every flag is a second way to say
something the request should say); let workflows declare flags (rejected: the surface would grow with every
workflow and nothing would keep it minimal); parse scope, limits, or criteria out of the request with patterns
(rejected: intent parsing by regex is exactly what bounded Jev judgment replaces); a config file for defaults
(rejected: no configuration language).

**Enforcement.** `test/cli.test.ts` asserts the documented option list, that every removed flag exits 64
before anything is routed, and that unused input is a usage error; `test/workflow.test.ts` asserts that a
workflow declaring `options` is rejected; the smoke run covers criteria and rules through `--input`.
