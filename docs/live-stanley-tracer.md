# Live Stanley tracer (real Pi, real Jev)

> **Historical report.** This run predates decision D-16 in [decision-log.md](decision-log.md): repository
> plugins are now called repository workflows and live in `.stanley/workflows/` (then `.stanley/plugins/`),
> `candidate.json` records `workflowId` (then `pluginId`), and the reference example is
> `examples/workflows/stale-todo-audit.ts`. Paths and field names below are quoted as observed at the time.

**Run:** 2026-09-19, 14:03–14:07 UTC · **Host:** macOS (Darwin 25.5), Node v24.18.0 · **Stanley:** this worktree's
uncommitted `stanley-code@0.1.0`, built with `npm run build` · **Jev:** TypeSafe `jev-1.13.0` via `TYPESAFE_API_KEY`
(redacted) · **Coding agent:** Pi `@earendil-works/pi-coding-agent` 0.85.1, provider `openai-codex` (OAuth,
`pi auth check` → `{"status":"ready","provider":"openai-codex","authType":"oauth"}`), model
**`openai-codex/gpt-5.5`**.

**Result: the complete workflow-learning loop succeeded live.** A built-in hot path ran twice with zero Pi
processes; an unsupported request was delegated to real Pi; the improvement worker had real Pi write a workflow
candidate; the candidate was validated, explicitly promoted, and a later differently phrased request was handled
by the promoted workflow with zero new Pi processes.

This report separates **live observations** (what actually happened in this run) from **automated-test
guarantees** (what `npm run check` proves on every run with fakes). Decisions referenced: D-04…D-08, D-11,
D-13, D-14 in [decision-log.md](decision-log.md). No new product decision was needed; no product source changed.

## Model and environment facts

- `openai-codex/gpt-5.4` was requested by the task owner in an earlier attempt. A live call returned
  `Codex error: The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account.` (recorded
  2026-09-19 01:10 UTC). This run therefore used the account-supported `openai-codex/gpt-5.5`, as instructed.
- **Sandbox workarounds (harness, not product):**
  1. Pi cannot create `~/.pi/agent/auth.json.lock` in this sandbox (`EPERM`), so `auth.json` and
     `settings.json` were copied (mode 0600) to a temporary directory and `PI_CODING_AGENT_DIR` pointed at it.
     Contents were never printed; the copy was deleted at the end of the run.
  2. Node's `fetch` ignores the sandbox's `HTTPS_PROXY`; `NODE_USE_ENV_PROXY=1` was set so the TypeSafe SDK could
     reach `api.typesafe.ai` (verified with one direct SDK call before the run).
  3. The harness's stdin is a never-closing non-TTY pipe; Stanley auto-reads piped stdin as input by design, so
     every command used `< /dev/null`.
  4. The sandbox grants network per shell command. A detached worker that outlives its spawning command loses
     network (observed in an earlier attempt: both worker attempts failed with `fetch failed` and the job was
     rejected within the documented two-attempt bound). In this run the auto-spawned worker was made to exit
     immediately by holding `worker.lock` with the shell's pid during the delegation command, and the worker was
     run in the foreground instead (`--improve-worker`, the documented mode).
- Pi was invoked through a thin logging wrapper set as `STANLEY_PI_BIN`: it appends one line per invocation to
  `invocations.log`, tees Pi's JSON event stream, and bounds each Pi process with `perl -e 'alarm 500'`. The
  wrapper `exec`s the real `pi` binary; nothing was simulated.

## Disposable target

`rsync` of this worktree (excluding `node_modules`, `dist`, `.stanley`) to a unique
`$TMPDIR/stanley-tracer.XXXXXX/repo`, committed as baseline `0bdcfc1`, then one harmless real edit: a JSDoc line
added above `MODEL_ENV` in `src/adapters/config.ts` (`git status` → ` M src/adapters/config.ts`). All commands
below ran with `cwd` = that copy and `node <worktree>/dist/cli.js` as `stanley`.

Common environment for every command (values redacted where secret):

```sh
export NODE_USE_ENV_PROXY=1 STANLEY_PI_BIN=<tmp>/wrap/pi STANLEY_AGENT_MODEL=openai-codex/gpt-5.5 \
       PI_CODING_AGENT_DIR=<tmp>/pi-agent PI_OFFLINE=1 TYPESAFE_API_KEY=<redacted>
```

## Phase 1 — built-in hot path, real Jev, no Pi (live)

```sh
stanley "Find the code that decides when Stanley delegates a request to the coding agent" --top 5 --json < /dev/null
stanley "Review the current changes for correctness bugs" --json < /dev/null
```

| Request | Exit | Status | Evidence |
| --- | --- | --- | --- |
| find (14:04:10–14:04:15) | 0 | `complete` | 96 candidates, 95 judged, 1 excluded; top 5: `src/cli/router.ts` (0.95), `test/agent.test.ts` (0.99), `src/cli.ts` (0.78), `test/cli.test.ts` (0.90), `src/workflows/agent.ts` (0.67). Run record `find-20260919T140412Z-531070`: 16 frames, all `ok`, resolved model `jev-1.13.0`. |
| review (14:04:15–14:04:17) | 0 | `complete` | 1 hunk (`src/adapters/config.ts:1-7`) judged, no findings, no parked. Run record `review-20260919T140416Z-0867c5`: 1 frame `ok`, `jev-1.13.0`. |

Identity-free output: top-level keys `schema, status, output` only; no workflow or run id in `output.data`.
**No-Pi proof:** `invocations.log` had **0 lines** after both runs; `.stanley/` contained only `runs/` (no
`improvements/`, no `candidates/`); stderr empty.

## Phase 2 — unsupported request delegated to live Pi

```sh
stanley "Add docs/conventions.md describing the repository convention named Tracer Notes: files under docs/ whose name starts with live- are generated evidence reports and must not be hand-edited. Keep the file under 12 lines. Do not run tests and do not commit; finish with a two-sentence summary." --json --agent-timeout-seconds 120 < /dev/null
```

- 14:04:54–14:05:08, exit 0, `status: "complete"`, `output.data`: `handledBy: "coding_agent"`,
  `outcome: "finished"`, `toolCalls: 2`, `durationMs: 14803`, `notChecked` = ["Stanley did not verify the agent's
  work…", "no deterministic or Jev workflow handled this request…"]. `output.text` begins
  "complete - handled by an external coding agent; Stanley did not verify the result" followed by Pi's own
  summary ("Changed `docs/conventions.md` … did not run tests …").
- The request is action-shaped (`Add …`) with no plugin installed, so it was delegated **without a routing call**
  (design D-05).
- **Live Pi evidence:** `invocations.log` line 1: `pid=75504 … args=--mode json --print --no-session --no-approve
  --model openai-codex/gpt-5.5 …`; captured event stream: tools `bash` ×1, `write` ×1, assistant messages from
  `openai-codex`/`gpt-5.5`, stop reasons `toolUse` ×2, `stop` ×1.
- **Repository change:** `git status` → `?? docs/conventions.md` (6 lines, correct content); the pre-existing
  edit untouched. **Plugin-directory guard:** no changes under `.stanley/plugins/`, no `.stanley/quarantine/`,
  no warnings.
- **Durable job:** stderr `stanley: delegated to the coding agent; queued improvement job imp_cf8e89b4ee22 under
  .stanley/improvements/`; `.stanley/improvements/pending/imp_cf8e89b4ee22.json` (schema
  `stanley.improvement-job/v1`, `attempts: 0`, request stored verbatim).
- The auto-spawned detached worker saw the held lock and exited without a diary entry (worker.log absent).

## Phase 3 — foreground improvement worker with live Pi

```sh
perl -e 'alarm 540; exec @ARGV' stanley --improve-worker --json < /dev/null
```

- 14:05:29–14:06:18, exit 0. Report: `{"schema":"stanley.improvement-worker/v1","ran":true,"processed":[{"id":"imp_cf8e89b4ee22","status":"validated"}]}`.
- `worker.log`: `start imp_cf8e89b4ee22 attempt 1 …` → `validated imp_cf8e89b4ee22 plugin tracer_notes_convention: ok`.
- **Live Pi evidence:** `invocations.log` line 2 (`pid=75922`, same fixed args, `--model openai-codex/gpt-5.5`);
  event stream: tools `bash` ×1, `write` ×1; final text "Wrote
  `.stanley/candidates/imp_cf8e89b4ee22/tracer_notes_convention.ts` … a bounded workflow for creating
  `docs/conventions.md` …". Agent `durationMs: 48296`.
- **Candidate record** (`candidate.json`, schema `stanley.candidate/v1`): `status: "validated"`,
  `pluginId: "tracer_notes_convention"`, checks `{loaded: true, quarantined: [], duplicateId: false,
  outsideWrites: [], routing: "selected"}` — the router (real Jev) selected the candidate for the original
  request during validation. Job moved to `improvements/done/` with `attempts: 1`.
- **Candidate inspected (agent-authored, not edited):** 4453-byte plugin `tracer_notes_convention.ts` with
  `instructions`/`examples` routing metadata, a deterministic phrase match on the request, a bounded `judge`
  fallback (`choice` question, threshold 0.8) when the phrases do not match, path containment relative to
  `root`, a <12-line guard, and a `{ text, data: { file, lineCount, verified, notChecked } }` result.

## Phase 4 — explicit promotion and the later matching prompt, no Pi

```sh
stanley --promote-candidate imp_cf8e89b4ee22 --json < /dev/null
```

14:06:34, exit 0 → `{"schema":"stanley.promotion/v1","candidate":"imp_cf8e89b4ee22","workflow":"tracer_notes_convention","path":".stanley/plugins/tracer_notes_convention.ts"}`;
`candidate.json` now `status: "promoted"`. `docs/conventions.md` was then deleted so the repeat would have to do real work.

```sh
stanley "Create a short docs/conventions.md that documents the Tracer Notes convention: docs/live-* files are generated evidence reports and are never hand-edited. No tests, no commit." --json < /dev/null
```

- 14:06:57–14:06:59 (2 s), exit 0, `status: "complete"`, output exactly the promoted plugin's result:
  `text: "Created docs/conventions.md with the Tracer Notes convention in under 12 lines. Per request, I did not run
  tests or commit."`, `data: { file: "docs/conventions.md", lineCount: 6, verified: true, notChecked: [...] }`.
  `docs/conventions.md` exists again with the plugin's content. stderr empty; no delegation notice; no new job
  (`improvements/` still holds only `done/imp_cf8e89b4ee22.json`).
- **Route evidence:** the request is action-shaped, so only plugins were eligible; the text and `data` shape are
  unique to the promoted workflow; no delegation line was printed; the phrasing ("are never hand-edited") does not
  satisfy the plugin's deterministic phrase list, so by the plugin's code its `judge` path (real Jev) decided the
  match. No new `.stanley/runs/` record exists because plugin runs do not persist records.
- **No-Pi proof:** `invocations.log` still has exactly **2 lines** (phase 2 and phase 3); no `events-*.jsonl` was
  added; `.stanley/plugins/` unchanged.

## Live observations versus automated guarantees

| Claim | Live in this run | Automated tests (fakes) |
| --- | --- | --- |
| Hot path never starts Pi | 0 wrapper invocations across find/review | `test/agent.test.ts`, smoke case asserts 0 agent calls |
| Delegation is truthful and identity-free | `handledBy: "coding_agent"`, unverified caveats, no ids | `test/agent.test.ts` |
| Job is durable before exit | pending file present after the CLI returned | `test/improvements.test.ts` |
| Worker validates with the plugin loader and router | `checks` all pass, `routing: "selected"` | `test/improvements.test.ts`, `test/containment.test.ts` |
| Promotion is explicit | `--promote-candidate` moved the file | `test/improvements.test.ts` |
| Promoted workflow handles the next request without Pi | 2 s, plugin output, invocation count unchanged | smoke closed-loop case |
| Plugin-directory guard around delegation | not triggered (agent behaved) | `test/containment.test.ts` |
| Worker bounds (2 attempts, requeue only after timeout/crash) | seen in the earlier failed attempt: `requeued … agent failed (fetch failed)` then `rejected` | `test/improvements.test.ts` |

## Failures and retries in this run

None in the final run. Earlier attempts on the same day: (1) two CLI runs hung on the harness's open stdin
pipe (fixed with `< /dev/null`); (2) a delegation with the default 600 s limit timed out at 5 tool calls
(`incomplete`, exit 10, job still queued); (3) the detached worker lost network and rejected the job after two
`fetch failed` attempts. All three are harness artifacts; Stanley's behavior in each was the documented one.

## Residual risks and observations

1. **Promoted plugins are Git-invisible in repositories whose root `.gitignore` ignores `.stanley/` entirely.**
   This repository's own `.gitignore` contains `.stanley/`, so `git status` did not list
   `.stanley/plugins/tracer_notes_convention.ts` (`git check-ignore -v` → `.gitignore:3:.stanley/`). The
   `.stanley/.gitignore` negation cannot re-include a path under an excluded parent. The README's "where Git can
   see it" holds only when the root ignore is `.stanley/*` with `!.stanley/plugins/`. Not changed in this run
   (documentation/config follow-up, no code defect); the smoke test passes because its temp repo has no root
   ignore file.
2. The promoted workflow is narrow (one convention, fixed content) and overwrites `docs/conventions.md` on every
   matching request; that is what the agent produced and what review-before-promotion is for.
3. Whether the repeat prompt used `judge` is inferred from the plugin's code path, not from a persisted record:
   plugin `judge` calls are budgeted but not written to `.stanley/runs/`.
4. The detached worker path was deliberately neutralized in this sandbox (network grant is per command); its
   real behavior was observed only in the failure mode described above and in `test/improvements.test.ts`.
5. Pi ran with the user's full environment (including `TYPESAFE_API_KEY`), as documented in D-11.

## Cleanup

Deleted after the run: the temp root (disposable repo, outputs, wrapper, event captures, and the Pi
config/credential copy) and the temp material from the earlier attempts. The source worktree was not modified
by the live test; `git diff --check` is clean.
