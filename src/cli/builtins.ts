/**
 * The built-in workflows, described once each and turned into ordinary `Workflow` objects. Each built-in owns
 * its routing text, its eligibility gate, whether it consumes supplied input, how it derives typed input from
 * the request and that input, its typed run function, and its human rendering. Nothing else in the CLI knows
 * which built-ins exist, and nothing but the request and the generic input reaches a built-in.
 */
import type {
  PromptResult,
  RoutingFacts,
  Workflow,
  WorkflowRunContext,
  WorkflowValue,
} from "../core/workflow.ts";
import {
  COMPATIBILITY_REVIEW,
  compatibilityReview,
  type DiffAnalysisInput,
  type DiffAnalysisKind,
  type DiffAnalysisResult,
  PERFORMANCE_REVIEW,
  performanceReview,
  REVIEW,
  review,
  SECURITY_REVIEW,
  SUMMARIZE,
  securityReview,
  summarize,
  TEST_GAPS,
  testGaps,
} from "../workflows/analyze-diff.ts";
import { CHECK, type CheckInput, type CheckResult, check } from "../workflows/check.ts";
import { FIND, type FindInput, type FindResult, find } from "../workflows/find.ts";
import type { DiffSelection } from "../workflows/ports.ts";
import type { RunOptions, WorkflowInfo } from "../workflows/run.ts";
import {
  TRIAGE,
  type TriageCommentsInput,
  type TriageCommentsResult,
  type TriageFailuresInput,
  type TriageFailuresResult,
  triageComments,
  triageFailures,
} from "../workflows/triage.ts";
import type { Packet } from "../workflows/types.ts";
import type { HumanSection } from "./output.ts";
import { packetPromptResult, unsupportedPromptResult } from "./prompt-result.ts";

/** Text supplied to a workflow: plain text as-is, JSON serialized. */
export function inputText(value: WorkflowValue | undefined): string | null {
  if (value === undefined) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** What the CLI provides so built-ins can run. Everything else comes from the request and the input. */
export interface BuiltinHost {
  readonly run: RunOptions;
  /** The exact Git selection of this invocation (`--scope`, `--base`); nested prompts inherit it. */
  readonly selection: DiffSelection;
  /** The normalized text supplied with `--input` or stdin, with where it came from, if any. */
  readonly supplied: { text: string; source: string } | null;
}

/** One invocation as a built-in sees it: the natural-language request, its input text, and the selection. */
export interface BuiltinInvocation {
  readonly request: string;
  readonly text: string | null;
  /** Where the input text came from: a path, "stdin", or "workflow prompt". */
  readonly source: string;
  readonly selection: DiffSelection;
}

/** The typed description one built-in workflow is built from. */
export interface Builtin<I, R> {
  readonly info: WorkflowInfo;
  readonly description: string;
  /** Choice criteria the router presents for this workflow. */
  readonly instructions: string;
  /** Whether supplied input means anything to this workflow; unused input is a usage error, never ignored. */
  readonly acceptsInput: boolean;
  available?(facts: RoutingFacts): boolean;
  run(input: I, options: RunOptions): Promise<Packet<R>>;
  render(packet: Packet<R>): HumanSection[];
  /** Typed input from the invocation, or null when the invocation cannot supply what the workflow needs. */
  input(invocation: BuiltinInvocation): I | null;
}

const needsDiff = (facts: RoutingFacts) => facts.diff === "present";

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "-" : value.toFixed(2);

/** Results of one `check` section, in report order. */
function sectionOf<S extends CheckResult["section"]>(packet: Packet<CheckResult>, section: S) {
  return packet.results.filter(
    (result): result is Extract<CheckResult, { section: S }> => result.section === section,
  );
}

/** Whether supplied text is a project-rules document (`{ "version": 1, "rules": [...] }`) rather than criteria. */
function looksLikeRules(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as { version?: unknown }).version === 1 &&
      Array.isArray((value as { rules?: unknown }).rules)
    );
  } catch {
    return false;
  }
}

const checkBuiltin: Builtin<CheckInput, CheckResult> = {
  info: CHECK,
  description: "Check a diff against its task, and optionally project rules or acceptance criteria",
  instructions:
    "Evaluate the current Git diff against the stated coding task and, when supplied as input, project rules or acceptance criteria.",
  acceptsInput: true,
  available: needsDiff,
  run: check,
  // The request is the task. Supplied input is project rules when it has the rules shape, else criteria.
  input: ({ request, text, source, selection }) => ({
    task: request,
    ...(text === null
      ? {}
      : looksLikeRules(text)
        ? { rules: { text, source } }
        : { criteria: { text, source } }),
    ...selection,
  }),
  render: (packet) => [
    {
      title: "task: hunks needing attention",
      lines: sectionOf(packet, "task")
        .filter((result) => result.flags.length > 0 || result.error)
        .slice(0, 30)
        .map(
          (result) =>
            `${result.path}:${result.lines} [${result.disposition}] ${result.flags.join(",") || "-"} low=${pct(result.taskRelation?.lowMass)}${result.error ? ` (${result.error})` : ""}`,
        ),
    },
    {
      title: "rules: pairs needing attention",
      lines: sectionOf(packet, "rules")
        .filter(
          (result) =>
            result.verdict === "violation_flagged" || result.verdict === "uncertain" || result.error,
        )
        .slice(0, 30)
        .map(
          (result) =>
            `${result.verdict} ${result.rule} @ ${result.path}:${result.lines}${result.error ? ` (${result.error})` : ""}`,
        ),
    },
    {
      title: "criteria",
      lines: sectionOf(packet, "criteria").map(
        (result) =>
          `${result.status.padEnd(11)} ${result.text.slice(0, 100)}${result.cappedBy ? ` (capped: ${result.cappedBy})` : ""}${
            result.evidence.length > 0
              ? ` ← ${result.evidence
                  .map((e) => `${e.path}:${e.lines}`)
                  .slice(0, 3)
                  .join(", ")}`
              : ""
          }`,
      ),
    },
  ],
};

/** Triage needs the supplied text; the diff is attached whenever the selection has one. */
const triageInput = ({ text, source, selection }: BuiltinInvocation) =>
  text === null ? null : { text, source, diff: selection };

const triageFailuresBuiltin: Builtin<TriageFailuresInput, TriageFailuresResult> = {
  info: TRIAGE,
  description: "Sort test failures and show which need attention",
  instructions: "Classify failures from supplied test or CI output.",
  acceptsInput: true,
  available: (facts) => facts.input === "failure_log",
  run: triageFailures,
  input: (invocation) => {
    const input = triageInput(invocation);
    return input === null ? null : { ...input, task: invocation.request };
  },
  render: (packet) => [
    {
      title: "failures",
      lines: packet.results
        .slice(0, 30)
        .flatMap((result) => [
          `${result.testName ?? result.id} (log ${result.lines}) relation=${result.relation.label} kind=${result.failureKind.label}${result.duplicateOf ? ` duplicate-of=${result.duplicateOf}` : ""}`,
          ...(result.message ? [`    ${result.message.slice(0, 140)}`] : []),
          ...(result.wouldSettle.length > 0 ? [`    would settle: ${result.wouldSettle.join("; ")}`] : []),
        ]),
    },
  ],
};

const triageCommentsBuiltin: Builtin<TriageCommentsInput, TriageCommentsResult> = {
  info: TRIAGE,
  description: "Sort review comments and show which need attention",
  instructions: "Classify supplied review comments using the current repository.",
  acceptsInput: true,
  available: (facts) => facts.input === "review_comments",
  run: triageComments,
  input: triageInput,
  render: (packet) => [
    {
      title: "comments",
      lines: packet.results
        .slice(0, 40)
        .map(
          (result) =>
            `${result.classification.padEnd(17)} ${result.path ? `${result.path}${result.line ? `:${result.line}` : ""} ` : ""}"${result.excerpt.slice(0, 90)}"${result.duplicateOf ? ` duplicate-of=${result.duplicateOf}` : ""}`,
        ),
    },
  ],
};

const findBuiltin: Builtin<FindInput, FindResult> = {
  info: FIND,
  description: "Find files that may be relevant to a task",
  instructions: "Rank existing repository files that are relevant to a task or question.",
  acceptsInput: false,
  run: find,
  input: ({ request }) => ({ task: request, mode: "find" }),
  render: (packet) => [
    {
      title: "ranked candidates",
      lines: packet.results
        .filter((result) => result.rank !== null)
        .map(
          (result) =>
            `${result.rank}. ${result.path}${result.excerpt ? `:${result.excerpt.ranges.join(",")}` : ""} relevance=${pct(result.relevance)} role=${result.metadata?.role ?? "-"}${result.excerpt ? ` missing=${result.excerpt.missingEvidence}` : ""}`,
        ),
    },
    {
      title: "gaps",
      lines: Array.isArray(packet.summary.gaps) ? packet.summary.gaps.map(String) : [],
    },
  ],
};

function diffAnalysis<K extends DiffAnalysisKind>(
  info: WorkflowInfo,
  description: string,
  instructions: string,
  run: (input: DiffAnalysisInput, options: RunOptions) => Promise<Packet<DiffAnalysisResult<K>>>,
): Builtin<DiffAnalysisInput, DiffAnalysisResult<K>> {
  return {
    info,
    description,
    instructions,
    acceptsInput: false,
    available: needsDiff,
    run,
    input: ({ request, selection }) => ({ request, ...selection }),
    render: (packet) => [
      {
        title: description.toLowerCase(),
        lines: packet.results
          .filter(
            (result) =>
              result.flag ||
              result.disposition === "parked" ||
              (result.error !== null && result.error !== "not judged: hunk limit") ||
              (result.analysis === "summarize" && result.classification !== null),
          )
          .sort(
            (a, b) =>
              Number(b.flag !== null) - Number(a.flag !== null) ||
              Number(b.disposition === "parked") - Number(a.disposition === "parked"),
          )
          .slice(0, 50)
          .map(
            (result) =>
              `${result.path}:${result.lines} [${result.disposition}] ${result.classification?.label ?? "-"}${result.analysis === "summarize" ? "" : ` concern=${pct(result.classification?.concernMass)}`} importance=${pct(result.importance?.highMass)} evidence=${pct(result.evidenceSufficient)}${result.flag ? ` flag=${result.flag}` : ""}${result.error ? ` (${result.error})` : ""}`,
          ),
      },
    ],
  };
}

/** The built-in workflows by id, in registration order. */
export const BUILTINS = {
  find: findBuiltin,
  check: checkBuiltin,
  triage_failures: triageFailuresBuiltin,
  triage_comments: triageCommentsBuiltin,
  review: diffAnalysis(
    REVIEW,
    "Review findings",
    "Review the current Git diff for concrete correctness, error-handling, state, concurrency, or data-integrity risks without requiring a stated task.",
    review,
  ),
  test_gaps: diffAnalysis(
    TEST_GAPS,
    "Test gaps",
    "Identify concrete changed behavior in the current Git diff that lacks visible test evidence.",
    testGaps,
  ),
  summarize: diffAnalysis(
    SUMMARIZE,
    "Change summary",
    "Classify and summarize what the current Git diff, changes, or commit does; do not explain unchanged repository code or review quality.",
    summarize,
  ),
  security_review: diffAnalysis(
    SECURITY_REVIEW,
    "Security review findings",
    "Review the current Git diff specifically for concrete security vulnerabilities or regressions.",
    securityReview,
  ),
  performance_review: diffAnalysis(
    PERFORMANCE_REVIEW,
    "Performance review findings",
    "Review the current Git diff specifically for concrete performance regressions.",
    performanceReview,
  ),
  compatibility_review: diffAnalysis(
    COMPATIBILITY_REVIEW,
    "Compatibility review findings",
    "Review the current Git diff specifically for breaking API, behavior, data, wire-format, or configuration changes.",
    compatibilityReview,
  ),
} as const;

export type BuiltinName = keyof typeof BUILTINS;

/** Input type of one built-in workflow, keyed by its id. */
export type BuiltinInput<K extends BuiltinName> =
  (typeof BUILTINS)[K] extends Builtin<infer I, unknown> ? I : never;

export function isBuiltinName(id: string): id is BuiltinName {
  return Object.hasOwn(BUILTINS, id);
}

/** Run one built-in with typed input and render its packet as a prompt result. */
export async function runBuiltin<K extends BuiltinName>(
  name: K,
  input: BuiltinInput<K>,
  options: RunOptions,
): Promise<PromptResult> {
  const builtin = BUILTINS[name] as unknown as Builtin<BuiltinInput<K>, unknown>;
  const packet = await builtin.run(input, options);
  return packetPromptResult(packet, builtin.render(packet));
}

/** The invocation a built-in sees for one run context. Input that matches the CLI's keeps its source label. */
function invocationOf(context: WorkflowRunContext, host: BuiltinHost): BuiltinInvocation {
  const text = inputText(context.input);
  const source = host.supplied && text === host.supplied.text ? host.supplied.source : "workflow prompt";
  return { request: context.request, text, source, selection: host.selection };
}

/** Every built-in as an ordinary workflow object, bound to one invocation's host. */
export function builtinWorkflows(host: BuiltinHost): Workflow[] {
  return (Object.keys(BUILTINS) as BuiltinName[]).map((name) => {
    const builtin = BUILTINS[name];
    return {
      id: name,
      description: builtin.description,
      instructions: builtin.instructions,
      ...(builtin.available ? { available: builtin.available } : {}),
      async run(context) {
        const typed = BUILTINS[name] as unknown as Builtin<BuiltinInput<typeof name>, unknown>;
        const input = typed.input(invocationOf(context, host));
        if (input === null) {
          return unsupportedPromptResult("The selected capability is not currently available.", {
            reason: "unavailable",
          });
        }
        return runBuiltin(name, input, host.run);
      },
    } satisfies Workflow;
  });
}
