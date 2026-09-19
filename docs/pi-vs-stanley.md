# Direct Pi CLI versus Stanley: a live comparison

> **Historical report.** This run predates decision D-16 in [decision-log.md](decision-log.md): repository
> plugins are now called repository workflows and live in `.stanley/workflows/` (then `.stanley/plugins/`),
> `candidate.json` records `workflowId` (then `pluginId`), and the reference example is
> `examples/workflows/stale-todo-audit.ts`. Paths and field names below are quoted as observed at the time.

**Run:** 2026-09-19, 14:21–14:26 UTC · **Pi:** `@earendil-works/pi-coding-agent` 0.85.1, provider `openai-codex`
(OAuth; `pi auth check --provider openai-codex --json --no-refresh` → `{"status":"ready",…,"authType":"oauth"}`),
model `openai-codex/gpt-5.5` · **Stanley reference:** the live tracer of the same day,
[live-stanley-tracer.md](live-stanley-tracer.md) (real Jev `jev-1.13.0`, real Pi `gpt-5.5`).

Every number in the "Direct Pi" rows below is a **live observation** from invoking the installed `pi` binary
directly. Every Stanley number is copied from the tracer report. No fakes, no simulated output. Product source
was not modified; nothing was committed.

## Setup (identical target, identical harness workarounds)

- Two disposable copies of this real codebase (`rsync` excluding `node_modules`, `dist`, `.stanley`), each
  committed as a baseline and given the same one-line JSDoc edit in `src/adapters/config.ts` as the tracer
  (`git status` → ` M src/adapters/config.ts`). Prompts 1–3 ran in copy A; prompt 4 ran in isolated copy B so
  the Pi-authored plugin could never touch a Stanley candidate queue (neither copy had a `.stanley/` directory).
- Same sandbox workarounds as the tracer: Pi's `auth.json`/`settings.json` copied (0600, never printed) into a
  temporary `PI_CODING_AGENT_DIR` and deleted afterwards; `PI_OFFLINE=1`; stdin from a prompt file; every Pi
  process bounded with `perl -e 'alarm <seconds>'`. Node's `NODE_USE_ENV_PROXY` is irrelevant here (Pi handles
  the proxy itself).
- Exact command for every direct-Pi prompt (only the prompt file, cwd, and alarm differ):

```sh
perl -e 'alarm <limit>; exec @ARGV' pi --mode json --print --no-session --no-approve --model openai-codex/gpt-5.5 \
  "Your complete instructions were delivered on standard input. Follow them exactly." < <prompt-file>
```

The JSON event stream was captured to a file and summarized (tool calls = `tool_execution_start` events;
model/provider and stop reasons from assistant `message_end` events; file changes = `git status` diff before/after).

## Direct Pi results (live)

| # | Prompt (abridged; full text below) | Wall | Exit | Events | Tools | Files changed | Task completed? | Ran tests/checks |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Find the code that decides when Stanley delegates…; explain the routing path; rank five files | 93 s | 0 | 2237 | 22 (`read` 14, `bash` 8) | none | Yes: correct, detailed explanation | none (read-only) |
| 2 | Review the current changes for correctness bugs; report findings, tests run/not run, uncertainty | 12 s | 0 | 165 | 1 (`bash` 1) | none | Yes: "Findings: none", checks listed | ran `git diff`; no tests/typecheck/lint |
| 3 | Add `docs/conventions.md` (Tracer Notes)…; <12 lines; no tests; no commit; 2-sentence summary | 12 s | 0 | 145 | 3 (`bash` 2, `write` 1) | `?? docs/conventions.md` (8 lines) | Yes | none, as instructed |
| 4 | Create a Stanley plugin for that request class using the documented API; explain what you validated | 66 s | 0 | 1725 | 7 (`read` 4, `write` 1, `edit` 2) | `.stanley/plugins/tracer_notes_convention.ts` (4761 B; Git-ignored by the root `.gitignore`, so not in `git status`) | Yes (file written; see validation) | "Did not run tests. Did not type-check or lint. Did not load or execute the plugin." |

All four: provider `openai-codex`, model `gpt-5.5`, no error events, empty stderr, no timeouts. Reported usage
(last assistant message, provider-attributed): #1 31,549 tokens / $0.061; #2 1,657 / $0.013; #3 1,430 / $0.008;
#4 12,836 / $0.015.

**Full prompts.**
1. "Find the code that decides when Stanley delegates a request to the coding agent. Identify the relevant files
   (with paths) and explain the routing path from a CLI request to the delegation decision, citing the functions
   or constants involved. Do not modify any files. Finish with a ranked list of the five most relevant files."
2. "Review the current changes for correctness bugs. Inspect the real uncommitted diff in this repository
   (git diff) and report concrete findings with file and line references, state which tests or checks you ran
   (if any) and which you did not, and state your uncertainty. Do not modify any files and do not commit."
3. Identical to the tracer's delegated request: "Add docs/conventions.md describing the repository convention
   named Tracer Notes: files under docs/ whose name starts with live- are generated evidence reports and must not
   be hand-edited. Keep the file under 12 lines. Do not run tests and do not commit; finish with a two-sentence
   summary."
4. "Create a repository-local Stanley plugin (workflow) that handles this request class: … Read the documented
   plugin API first: README.md section 'Repository plugins', docs/plugin-design-decisions.md, and the reference
   workflow examples/plugins/stale-todo-audit.ts. Follow that contract exactly … Use deterministic matching of the
   request first and a bounded judge() fixed-choice question only when the deterministic match is inconclusive.
   The plugin must stay inside root and write only docs/conventions.md. Write exactly one file:
   .stanley/plugins/tracer_notes_convention.ts. Do not modify any other file, do not run tests, do not commit.
   Then explain in your final message what you validated about the plugin … and what you did not validate."

**Final responses (bounded excerpts).**
- #1 ended: "Ranked five most relevant files: 1. `src/cli.ts` — main routing/delegation decision, including
  `unsupportedAction`, `decide`, `delegate`, and final fallback condition. 2. `src/cli/router.ts` … 3.
  `src/workflows/agent.ts` … 4. `src/adapters/pi.ts` … 5. `src/cli/registry.ts` …". The body correctly quoted
  the delegation condition (`action !== null || topDecision.reason === "cannot_tell"`, agent available, budget
  not exhausted), the router thresholds (0.6 / 0.55 / 0.15), and the post-delegation improvement enqueue.
- #2: "Findings: none. The only uncommitted change is a comment addition in `src/adapters/config.ts:4` … Checks
  run: `git diff --stat`, `git diff --no-ext-diff --unified=80`. Checks not run: Unit tests, Typecheck, Lint.
  Uncertainty: low."
- #3: "Created `docs/conventions.md` documenting the Tracer Notes convention. No tests were run and no commit was
  made." File content: heading, "Tracer Notes" section, the rule, and a regenerate note (8 lines).
- #4: "Created `.stanley/plugins/tracer_notes_convention.ts`. Validated: Read the required plugin API docs and
  reference workflow. Inspected the written plugin file for the required factory/run shape. Confirmed by
  inspection that the workflow writes only `docs/conventions.md` and uses deterministic matching before a bounded
  fixed-choice `judge()` fallback. Not validated: Did not run tests. Did not type-check or lint. Did not load or
  execute the plugin."

**Reference check on #4 (Stanley's loader, used only as a validator, not as a run):** `loadPlugins()` on copy B
loaded exactly one plugin, id `tracer_notes_convention`, routing metadata `instructions` + `examples`, zero
quarantined. By inspection the plugin: keeps paths inside `root`, writes only `docs/conventions.md`, has a
three-way deterministic matcher (`match`/`miss`/`inconclusive`) and a `judge` `choice` question with a 0.7
threshold for the inconclusive case, and declares `notChecked`. It was **not** loaded or executed by Pi itself,
and it is not registered anywhere: nothing activates it.

## Stanley results for the same prompts (from the tracer)

| # | Stanley path | Wall | Pi processes | Jev requests | Output | Verification stance |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | built-in `find` (deterministic candidate ranking + Jev) | 5 s | 0 | 16 frames | ranked shortlist: `src/cli/router.ts` 0.95, `test/agent.test.ts` 0.99, `src/cli.ts` 0.78, `test/cli.test.ts` 0.90, `src/workflows/agent.ts` 0.67; `notChecked` states "a ranked shortlist, not an answer" | code-decided thresholds; run record persisted |
| 2 | built-in `review` (hunk classification + Jev) | 2 s | 0 | 1 frame | `findings: []`, `parked: []`, `notChecked`: runtime behavior, style, whether tests pass | code-decided; persisted |
| 3 | agent fallback → Pi (delegated, `--agent-timeout-seconds 120`) | 15 s | 1 (2 tools) | 0 | `complete`, `handledBy: "coding_agent"`, unverified caveats, 6-line file | explicitly unverified; improvement job queued |
| 4 | improvement worker → Pi writes candidate; host validates | 49 s | 1 (2 tools) | routing check | `validated` (loaded, no outside writes, unique id, router selected); then explicit `--promote-candidate`; later prompt handled in 2 s with 0 Pi | host-verified load/containment/routing; human promotion |

## Comparison

| Dimension | Direct Pi (live) | Stanley (live) | Reading |
| --- | --- | --- | --- |
| **Latency** | 93 s / 12 s / 12 s / 66 s | 5 s / 2 s / 15 s / 49 s (+2 s repeat) | On analysis prompts Stanley is 6–19× faster because it never opens an agent loop; on the write task the two are comparable (Stanley adds ~0.2 s of host work around the same Pi call). |
| **Tool use** | 22 / 1 / 3 / 7 tool calls; free-form `bash`/`read` exploration | 0 / 0 / 2 / 2 Pi tool calls; built-ins use fixed Git/file ports only | Pi decides what to read; Stanley's built-ins read a fixed, bounded evidence set. |
| **Determinism / repeatability** | Prompt-dependent; #1's 22-call exploration and answer structure are not reproducible run to run; #2/#3 were short and stable in this run | Candidate set, hunk splitting, thresholds and output shape are code; only Jev's probabilities vary, and they are recorded | Stanley's hot path is reproducible by construction; Pi's is reproducible only in the sense that a competent model tends to reach similar answers. |
| **Structured output** | Free-form Markdown; structure only if asked for in the prompt; no schema, no stable field names | `stanley.prompt-result/v1` with `status`, `output.text`, `output.data` (`findings`, `parked`, `notChecked`, `coverage`, results with paths/lines) | Stanley's output is machine-consumable without parsing prose; Pi's is human-first. |
| **Quality of the analysis** | #1 was the richer answer: a correct, line-cited walkthrough of the whole routing path, exactly what a human wants to read | #1 returned a ranked file list with relevance scores and no narrative | Pi answered "explain"; Stanley answered "find". Stanley's built-in cannot explain; Pi's explanation cannot be scored or bounded. Both top-5 lists agree on four of five files. |
| **Verification boundary** | Self-reported: "Checks run: git diff …; not run: tests, typecheck, lint"; #4 "did not load or execute the plugin" | Host-asserted: `notChecked` is generated by code; delegated results carry "Stanley did not verify"; candidates are loaded, containment-checked and route-checked by the host | Pi is honest when asked; Stanley is honest by construction and can prove what it did *not* do. |
| **Safety / trust** | Runs with the user's privileges and `--no-approve`; nothing bounds which files it may write except the prompt; #4 wrote straight into `.stanley/plugins/` because it was told to | Same privileges for delegated runs, but: hard time limit, `STANLEY_NESTED` recursion guard, plugin-directory fingerprint + quarantine, candidates staged and only promoted by a person | Both trust the model with the repo; only Stanley has host-side guards around the trust boundary. |
| **Persistence / audit** | Nothing unless `--no-session` is dropped (then a Pi session file); the event stream exists only because this test captured it | `.stanley/runs/<id>/` frames for built-ins; job, candidate and worker records for the loop | Stanley leaves an audit trail by default. |
| **Self-improvement** | None: prompt #3 will cost a full agent run every time; prompt #4 produced a plugin, but nothing validated, registered, or routed to it | The same #3 produced a job → validated candidate → promoted workflow → the next matching request ran in 2 s with zero Pi | This is the categorical difference: Stanley converts a task class into a deterministic path; Pi does not accumulate anything. |
| **Flexibility / capability** | Answered an "explain" question, a review, a doc write, and a plugin-authoring task with one interface and no configuration | Built-ins cover ten analysis shapes; anything else needs a plugin or the agent fallback (which *is* Pi) | Pi is strictly more general; Stanley narrows the general agent to the fallback role and grows the deterministic surface over time. |
| **Cost (provider-reported)** | $0.061 / $0.013 / $0.008 / $0.015 | Jev calls only for #1/#2 (16 and 1 frame); #3/#4 cost one Pi run each, then $0 Pi for repeats | Not directly comparable (different vendors); the structural point is the zero-Pi repeat. |
| **What each could prove** | That it ran and what it said; file changes via `git status` | All of that plus: no agent process on the hot path (invocation log), what was not checked, where the candidate came from and that it changed nothing outside its directory | |

### Analysis

- **Do not read this as "Pi is worse".** Prompt #1 is the clearest counter-example: the direct Pi answer is a
  better artifact for a human than Stanley's ranked list, because the question asked for an explanation and the
  built-in only ranks. Stanley's `find` is faster and scored, but it does not understand the code. Prompt #2 is a
  wash on a trivial diff; both said "no findings" and both listed what they did not run.
- **The hot-path guarantees are real and were measured, not asserted.** Stanley's #1 and #2 started no Pi
  process (wrapper log: 0 lines) and finished in 5 s and 2 s with recorded Jev frames. Direct Pi needs an agent
  loop even for a one-hunk review (12 s, 1 tool call) and spent 93 s and 22 tool calls exploring for #1.
- **On the write task the systems are equivalent in execution and different in envelope.** Same model, same
  file, same two-sentence summary; Stanley added a hard timeout, an unverified-status envelope, the
  plugin-directory guard, and a durable improvement job. Direct Pi added nothing and forgot the task.
- **On workflow authoring, Pi wrote a plugin as good as the one Stanley's worker obtained** (same id, same
  deterministic-then-`judge` structure, containment, `notChecked`), and it loads cleanly. The difference is what
  happens next: Pi's file sits in a directory with no validation, no route check, no promotion record and no
  guard; Stanley's went through load/containment/routing checks, a human promotion step, and then actually
  handled the next request without Pi. Pi could be scripted to do these steps; Stanley is those steps.
- **Repeatability is the practical gap.** A team running prompt #3 daily pays a Pi run each time with direct
  Pi; with Stanley it paid once, then 2 s and zero Pi thereafter.

## Residual risks and limits of this comparison

1. Single run per prompt, one model, one small repository; latency and tool counts vary with model load and
   with what the agent chooses to read. Direct-Pi numbers are indicative, not benchmarks.
2. Prompt #1 is not identical across arms: Stanley's built-in cannot "explain", so the Pi prompt asked for both
   the file list and the explanation; the file-ranking part is the comparable piece.
3. The Pi-authored plugin (#4) was validated only by Stanley's loader as a reference check; it was not run, and
   its `judge` path was not exercised.
4. Provider-reported usage/cost fields come from Pi's event stream and were not independently verified.
5. Both arms ran with the harness workarounds described above (temporary Pi config dir, alarm bounds); a normal
   shell needs none of them.
6. Pi's session persistence was disabled (`--no-session`) in both arms to match Stanley's adapter; with
   sessions on, direct Pi would keep a transcript.

## Cleanup

Deleted after the run: both disposable copies, prompt files, event captures, summaries, the helper script, and
the Pi config/credential copy. The source worktree was not modified except for adding this report;
`git diff --check` is clean.
