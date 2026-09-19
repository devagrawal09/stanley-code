import { hashValue } from "../core/hash.ts";
import {
  boundedTask,
  describeScope,
  diffNotChecked,
  loadDiff,
  type Section,
  sortFindings,
} from "./common.ts";
import { InputError } from "./errors.ts";
import type { DiffScope } from "./ports.ts";
import { Run, type RunOptions } from "./run.ts";
import { type CommentResult, commentsSection, TRIAGE_COMMENTS_POLICY } from "./triage-comments.ts";
import { type FailureResult, failuresSection, TRIAGE_FAILURES_POLICY } from "./triage-failures.ts";
import type { Packet } from "./types.ts";

export const TRIAGE_KINDS = ["failures", "comments"] as const;
export type TriageKind = (typeof TRIAGE_KINDS)[number];

export interface TriageInput {
  /** What `text` holds: a test or CI log (`failures`), or exported review comments as JSON (`comments`). */
  kind: TriageKind;
  text: string;
  /** Where `text` came from: a path or "stdin". */
  source: string;
  /** Optional task text. Context for failures only. */
  task?: string;
  /** Diff context; `null` disables diff collection. */
  diff?: { scope: DiffScope; base?: string } | null;
  /** Failure blocks or comment threads eligible for Jev judgment. */
  maxItems?: number;
}

export const TRIAGE = {
  name: "triage",
  version: 1,
  budget: { requests: 100, inputTokens: 200_000, wallMs: 60_000 },
} as const;

/** One triaged item. `kind` matches the input kind; every result in a packet has the same kind. */
export type TriageResult = ({ kind: "failures" } & FailureResult) | ({ kind: "comments" } & CommentResult);
export type TriageFailuresInput = Omit<TriageInput, "kind">;
export type TriageCommentsInput = Omit<TriageInput, "kind" | "task">;
export type TriageFailuresResult = Extract<TriageResult, { kind: "failures" }>;
export type TriageCommentsResult = Extract<TriageResult, { kind: "comments" }>;

/** Typed routing target for failure logs. */
export async function triageFailures(
  input: TriageFailuresInput,
  options: RunOptions,
): Promise<Packet<TriageFailuresResult>> {
  return triage({ ...input, kind: "failures" }, options) as Promise<Packet<TriageFailuresResult>>;
}

/** Typed routing target for exported review comments. */
export async function triageComments(
  input: TriageCommentsInput,
  options: RunOptions,
): Promise<Packet<TriageCommentsResult>> {
  return triage({ ...input, kind: "comments" }, options) as Promise<Packet<TriageCommentsResult>>;
}

/**
 * Sort incoming items that need attention: test failures from a log, or review comments.
 * Parsing and classification are specific to the kind; the run, diff context, and packet are shared.
 */
export async function triage(input: TriageInput, options: RunOptions): Promise<Packet<TriageResult>> {
  const { kind } = input;
  if (!TRIAGE_KINDS.includes(kind)) throw new InputError(`kind must be one of ${TRIAGE_KINDS.join(", ")}`);
  const trimmedTask = input.task?.trim();
  const task = trimmedTask ? boundedTask(trimmedTask) : null;
  if (task && kind !== "failures") throw new InputError("task text is only used when triaging failures");
  const { evidence, source: workspace } = options.dependencies;
  const parsed =
    kind === "failures"
      ? { kind, log: evidence.failureLog(input.text) }
      : { kind, comments: evidence.reviewComments(input.text) };
  const maxItems =
    input.maxItems ??
    (kind === "failures" ? TRIAGE_FAILURES_POLICY.defaultMaxItems : TRIAGE_COMMENTS_POLICY.defaultMaxItems);

  // An empty diff is no diff context: relation questions are only asked when there is something to relate to.
  const loaded =
    input.diff === null ? null : await loadDiff(options.dependencies, input.diff ?? { scope: "worktree" });
  const diff = loaded && loaded.hunks.length === 0 && !loaded.source.text.trim() ? null : loaded;
  const tracked = new Set(await workspace.trackedFiles());
  const run = await Run.start(TRIAGE, options, {
    kind,
    source: input.source,
    inputHash: hashValue(input.text),
    items: parsed.kind === "failures" ? parsed.log.blocks.length : parsed.comments.length,
    taskHash: task ? hashValue(task) : null,
    diff: diff ? describeScope(diff.source) : null,
    maxItems,
  });

  const section: Section<FailureResult | CommentResult> =
    parsed.kind === "failures"
      ? failuresSection(run, diff, {
          log: parsed.log,
          source: input.source,
          task,
          maxItems,
          tracked,
          root: options.root,
          workspace,
        })
      : await commentsSection(run, diff, {
          comments: parsed.comments,
          source: input.source,
          maxItems,
          tracked,
          workspace,
        });
  await run.candidates({ kind, source: input.source, ...section.candidates });
  const report = await section.judge();

  return run.finish({
    findings: sortFindings(report.findings),
    parked: report.parked,
    excluded: report.excluded ?? [],
    limits: report.limits,
    notChecked: [...report.notChecked, ...(diff ? diffNotChecked(diff.source) : [])],
    results: report.results.map((result) => ({ kind, ...result }) as TriageResult),
    summary: {
      kind,
      source: input.source,
      ...report.summary,
      diff: diff ? describeScope(diff.source) : null,
    },
    ...(report.incomplete ? { incomplete: true } : {}),
  });
}
