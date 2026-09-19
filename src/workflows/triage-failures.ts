import { choice, noul } from "../core/questions.ts";
import type { JsonObject } from "../core/types.ts";
import { type ChoiceAnswer, expectKeys, readChoice, readNoul } from "../core/validation.ts";
import { type DiffEvidence, hunkEvidence, type Section, unjudgedOrFailed } from "./common.ts";
import { type FailureBlock, type Hunk, type ParsedLog, resolveStackPath } from "./evidence.ts";
import { declaredIdentifiers } from "./hunks.ts";
import {
  decisiveLabel,
  EVIDENCE_POLICY,
  round,
  roundedDistribution,
  UNTRUSTED_INSTRUCTION_THRESHOLD,
  untrustedInstructionQuestion,
} from "./policy.ts";
import type { WorkspaceSource } from "./ports.ts";
import { buildFrame, type Run } from "./run.ts";
import type { EvidenceRef, Finding, Parked } from "./types.ts";

/** The failures section of `triage`: one parsed test or CI log, judged failure by failure. */
export interface FailuresSectionInput {
  log: ParsedLog;
  /** Where the log came from; shown in evidence references. */
  source: string;
  task: string | null;
  maxItems: number;
  /** Tracked paths, used to relate stack locations to the workspace. */
  tracked: ReadonlySet<string>;
  root: string;
  workspace: WorkspaceSource;
}

export const TRIAGE_FAILURES_POLICY = {
  version: "triage-failures-policy@3",
  defaultMaxItems: 40,
  decisive: 0.6,
  unrelatedConflict: 0.7,
  nondeterminism: 0.7,
  probeMissingEvidence: 0.5,
  untrusted: UNTRUSTED_INSTRUCTION_THRESHOLD,
  probeContextLines: 15,
} as const;

const RELATIONS = [
  "caused_by_diff",
  "unrelated_to_diff",
  "environment_or_infrastructure",
  "cannot_tell",
] as const;
const KINDS = [
  "assertion_mismatch",
  "runtime_exception",
  "compile_or_type_error",
  "timeout",
  "environment_or_setup",
  "snapshot_mismatch",
  "cannot_tell",
] as const;
const MISSING = [
  "none",
  "full_stack_trace",
  "test_source",
  "changed_code",
  "prior_run_history",
  "cannot_tell",
] as const;

interface RelationAnswers {
  relation: ChoiceAnswer<(typeof RELATIONS)[number]> | null;
  kind: ChoiceAnswer<(typeof KINDS)[number]>;
  nondeterminism: number;
  missing: ChoiceAnswer<(typeof MISSING)[number]>;
  untrusted: number;
}

export interface FailureResult {
  id: string;
  family: string;
  duplicateOf: string | null;
  lines: string;
  testName: string | null;
  message: string | null;
  keyLines: Array<{ n: number; text: string }>;
  omittedLines: number;
  stackLocations: Array<{ path: string; line: number | null; tracked: string | null }>;
  observed: {
    stackTouchesChangedFile: boolean | null;
    envSignature: string | null;
    compileError: boolean;
    missingModule: boolean;
    timeoutSignature: boolean;
  };
  relation: { label: string; determinedBy: "code" | "jev"; distribution: Record<string, number> | null };
  failureKind: { label: string; determinedBy: "code" | "jev"; distribution: Record<string, number> | null };
  nondeterminismSignature: number | null;
  missingEvidence: { label: string; distribution: Record<string, number> } | null;
  wouldSettle: string[];
  probesRun: string[];
  disposition: string;
  error: string | null;
}

const RELATION_EXAMPLES = [
  {
    failure: "expect(formatPrice(5)).toBe('$5.00') received '$5.0' at src/price.test.ts:12",
    diff: "src/price.ts changed: formatPrice now uses toFixed(1)",
    answer: "caused_by_diff",
  },
  {
    failure: "test_parse_csv failed: KeyError 'delimiter' in tests/test_csv.py:40",
    diff: "docs/README.md and src/auth/login.py changed",
    answer: "unrelated_to_diff",
  },
  {
    failure: "getaddrinfo ENOTFOUND registry.example.com during npm install",
    diff: "src/cart.ts changed",
    answer: "environment_or_infrastructure",
  },
  {
    failure: "Test suite failed to run (no further output)",
    diff: "src/cart.ts and src/api.ts changed",
    answer: "cannot_tell",
  },
  {
    failure: "worker test failed: process exited with code 1 at src/runner.ts:42",
    diff: "src/runner.ts changed to add a new execution mode",
    answer: "cannot_tell",
  },
];

function relationFrame(
  block: FailureBlock,
  task: string | null,
  diffSummary: JsonObject | null,
  observed: FailureResult["observed"],
  additionalEvidence: JsonObject | null,
  refs: EvidenceRef[],
) {
  const questions = {
    ...(diffSummary
      ? {
          relation_to_diff: choice(
            {
              question: `How does failure ${block.id} relate to the changes in the diff summary?`,
              guidance:
                "Choose the best-supported relation, not one that is merely possible. caused_by_diff requires a concrete bridge from a changed path, symbol, or behavior to the shown failure mechanism. A generic exit code, temporal proximity, shared task vocabulary, or path overlap alone is insufficient. Choose cannot_tell when multiple relations remain viable; lack of overlap alone does not prove unrelated_to_diff.",
              workedExamples: RELATION_EXAMPLES,
            },
            {
              caused_by_diff:
                "Shown evidence supports a concrete causal chain from changed code or behavior to this failure.",
              unrelated_to_diff:
                "Shown evidence positively ties the failure to unchanged behavior independent of the diff.",
              environment_or_infrastructure:
                "Shown evidence identifies network, resources, tooling, or setup as the failure mechanism.",
              cannot_tell:
                "The shown evidence is generic, incomplete, or compatible with more than one relation.",
            },
          ),
        }
      : {}),
    failure_kind: choice(`What kind of failure is ${block.id}?`, {
      assertion_mismatch: "A test assertion compared values and they differed.",
      runtime_exception: "Code threw or panicked at runtime.",
      compile_or_type_error: "Compilation, type checking, or syntax failed.",
      timeout: "A test or step exceeded a time limit.",
      environment_or_setup: "Setup, dependencies, network, or resources failed.",
      snapshot_mismatch: "A stored snapshot differs from output.",
      cannot_tell: "The shown lines do not identify the kind of failure.",
    }),
    nondeterminism_signature: noul(
      `Does failure ${block.id} show signs of timing, ordering, randomness, or shared-state dependence?`,
      {
        true: "The evidence mentions races, timeouts, random values, ordering, or intermittent behavior.",
        false: "Nothing in the evidence points to nondeterminism.",
      },
    ),
    missing_evidence: choice(`What evidence is most needed to classify failure ${block.id}?`, {
      none: "The shown evidence is enough to classify the failure.",
      full_stack_trace: "The stack trace or error output is cut off or absent.",
      test_source: "The failing test's source code is needed.",
      changed_code: "The changed code the failure touches is needed.",
      prior_run_history: "Results from the base branch or reruns are needed.",
      cannot_tell: "Unclear what would help.",
    }),
    untrusted_instruction_text: untrustedInstructionQuestion(),
  };
  const keys = Object.keys(questions);
  return buildFrame<RelationAnswers>({
    template: "failure_relation@2",
    scope: block.id,
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      ...(task ? { task } : {}),
      failure: {
        id: block.id,
        testName: block.testName,
        message: block.message,
        logLines: block.lines.map((line) => `${line.n}| ${line.text}`).join("\n"),
        omittedLines: block.omittedLines,
      },
      ...(diffSummary ? { diffSummary } : {}),
      observed,
      ...(additionalEvidence ? { additionalEvidence } : {}),
    },
    questions,
    provenance: refs,
    parse(answers) {
      expectKeys(answers, keys);
      return {
        relation: diffSummary ? readChoice(answers, "relation_to_diff", RELATIONS) : null,
        kind: readChoice(answers, "failure_kind", KINDS),
        nondeterminism: readNoul(answers, "nondeterminism_signature"),
        missing: readChoice(answers, "missing_evidence", MISSING),
        untrusted: readNoul(answers, "untrusted_instruction_text"),
      };
    },
  });
}

export function failuresSection(
  run: Run,
  diff: DiffEvidence | null,
  input: FailuresSectionInput,
): Section<FailureResult> {
  const { log: parsed, task, maxItems: maxFailures, tracked } = input;

  const changedPaths = diff ? [...new Set(diff.hunks.map((hunk) => hunk.path))] : [];
  const diffSummary: JsonObject | null = diff
    ? {
        changedPaths: changedPaths.slice(0, 200),
        omittedPaths: Math.max(0, changedPaths.length - 200),
        hunkHeaders: diff.hunks
          .slice(0, 100)
          .map((hunk) => `${hunk.path} @@ -${hunk.oldStart} +${hunk.newStart} @@ ${hunk.section}`.trim()),
        declaredSymbols: [...new Set(diff.hunks.flatMap((hunk) => [...declaredIdentifiers(hunk)]))].slice(
          0,
          100,
        ),
      }
    : null;
  const limits: string[] = [];
  if (changedPaths.length > 200)
    limits.push(`diff summary lists 200 of ${changedPaths.length} changed paths`);
  if (parsed.blocks.length === 0)
    limits.push("no failure anchors were recognized; the log format may be unsupported");
  if (parsed.blocks.length > maxFailures) {
    limits.push(
      `only the first ${maxFailures} of ${parsed.blocks.length} failure blocks are judged (policy item limit)`,
    );
  }
  const overlong = parsed.blocks.filter((block) => block.omittedLines > 0).length;
  if (overlong > 0)
    limits.push(`${overlong} failure block(s) exceeded the window cap; omitted line counts are reported`);

  const findings: Finding[] = [];
  const parked: Parked[] = [];
  const results: FailureResult[] = [];
  const firstByFingerprint = new Map<string, string>();
  const toJudge: Array<{ block: FailureBlock; result: FailureResult }> = [];

  for (const [index, block] of parsed.blocks.entries()) {
    const locations = block.stackLocations.map((location) => ({
      ...location,
      tracked: resolveStackPath(location.path, input.root, tracked),
    }));
    const touched = diff
      ? locations.some((location) => location.tracked && changedPaths.includes(location.tracked))
      : null;
    const result: FailureResult = {
      id: block.id,
      family: block.signature,
      duplicateOf: firstByFingerprint.get(block.fingerprint) ?? null,
      lines: `${block.startLine}-${block.endLine}`,
      testName: block.testName,
      message: block.message,
      keyLines: keyLines(block),
      omittedLines: block.omittedLines,
      stackLocations: locations,
      observed: {
        stackTouchesChangedFile: touched,
        envSignature: block.envSignature,
        compileError: block.compileError,
        missingModule: block.missingModule,
        timeoutSignature: block.timeout,
      },
      relation: diff
        ? { label: "unjudged", determinedBy: "code", distribution: null }
        : { label: "unknown_no_diff_context", determinedBy: "code", distribution: null },
      failureKind: { label: "unjudged", determinedBy: "code", distribution: null },
      nondeterminismSignature: null,
      missingEvidence: null,
      wouldSettle: ["rerun the failing test to check repeatability", "run the same test on the base commit"],
      probesRun: [],
      disposition: "unjudged",
      error: null,
    };
    results.push(result);
    if (!firstByFingerprint.has(block.fingerprint)) firstByFingerprint.set(block.fingerprint, block.id);
    // Pattern matches on the log text are observations for the reader and for Jev (they sit in every frame's
    // `observed` state); they never decide the failure kind or its relation to the diff.
    if (block.compileError) {
      findings.push({
        flag: "compile_error_signature",
        id: block.id,
        source: "deterministic",
        severity: "info",
        lines: result.lines,
        detail: { log: input.source },
      });
    }
    if (block.envSignature) {
      findings.push({
        flag: "environment_signature",
        id: block.id,
        source: "deterministic",
        severity: "info",
        lines: result.lines,
        detail: { signature: block.envSignature },
      });
    }
    if (result.duplicateOf) {
      result.disposition = "deterministic";
      result.error = null;
      run.setDisposition(block.id, "deterministic");
      continue;
    }
    if (index >= maxFailures) {
      result.error = "not judged: failure limit";
      run.setDisposition(block.id, "unjudged");
      continue;
    }
    toJudge.push({ block, result });
  }
  return { candidates: { totalLines: parsed.totalLines, failures: results }, judge };

  async function judge() {
    const logRef = (block: FailureBlock): EvidenceRef => ({
      kind: "log_window",
      id: block.id,
      path: input.source,
      startLine: block.startLine,
      endLine: block.endLine,
      probe: "log-anchor-window@1",
      truncated: block.omittedLines > 0,
    });
    const first = await run.judgeAll(
      toJudge.map(({ block, result }) =>
        relationFrame(block, task, diffSummary, result.observed, null, [logRef(block)]),
      ),
    );

    // One allowlisted follow-up probe per failure, chosen by code from the missing-evidence answer.
    const outcomes = await Promise.all(
      toJudge.map(async ({ block, result }, index) => {
        const outcome = first[index]!;
        if (!outcome.ok) return outcome;
        const missing = outcome.value.missing;
        const label = decisiveLabel(missing, TRIAGE_FAILURES_POLICY.probeMissingEvidence);
        const probe = await probeEvidence(label, result, diff?.hunks ?? [], input.workspace);
        if (!probe) return outcome;
        result.probesRun.push(probe.name);
        const followUp = await run.judge(
          relationFrame(block, task, diffSummary, result.observed, probe.evidence, [
            logRef(block),
            ...probe.refs,
          ]),
        );
        if (!followUp.ok) {
          result.error = `follow-up ${followUp.reason}: ${followUp.detail}`;
          return outcome;
        }
        return followUp;
      }),
    );

    for (const [index, { block, result }] of toJudge.entries()) {
      const outcome = outcomes[index]!;
      if (!outcome.ok) {
        result.error = `${outcome.reason}: ${outcome.detail}`;
        const disposition = unjudgedOrFailed(outcome.reason);
        result.disposition = disposition;
        run.setDisposition(block.id, disposition);
        continue;
      }
      const answers = outcome.value;
      result.disposition = "judged";
      run.setDisposition(block.id, "judged");
      result.nondeterminismSignature = round(answers.nondeterminism);
      result.missingEvidence = {
        label: answers.missing.choice,
        distribution: roundedDistribution(answers.missing.probabilities),
      };
      result.failureKind = {
        label: decisiveLabel(answers.kind, TRIAGE_FAILURES_POLICY.decisive) ?? "uncertain",
        determinedBy: "jev",
        distribution: roundedDistribution(answers.kind.probabilities),
      };
      if (answers.relation) {
        const unrelated = answers.relation.probabilities.unrelated_to_diff;
        const distribution = roundedDistribution(answers.relation.probabilities);
        // The one structural cross-check: a stack frame in a changed file contradicts "unrelated". Regex
        // signatures (environment, compile, timeout) never park or override Jev; they are evidence only.
        if (
          result.observed.stackTouchesChangedFile &&
          unrelated >= TRIAGE_FAILURES_POLICY.unrelatedConflict
        ) {
          const conflict = "conflict: stack touches a changed file vs unrelated_to_diff";
          result.relation = { label: "conflict", determinedBy: "code", distribution };
          result.disposition = "parked";
          run.setDisposition(block.id, "parked");
          parked.push({ id: block.id, reason: conflict });
          await run.decision(block.id, "hard_conflict", conflict, TRIAGE_FAILURES_POLICY.version);
        } else {
          result.relation = {
            label: decisiveLabel(answers.relation, TRIAGE_FAILURES_POLICY.decisive) ?? "uncertain",
            determinedBy: "jev",
            distribution,
          };
        }
      }
      result.wouldSettle = wouldSettle(result, answers);
      if (result.relation.label === "caused_by_diff") {
        findings.push({
          flag: "failure_likely_caused_by_diff",
          id: block.id,
          source: "jev",
          severity: "warn",
          lines: result.lines,
          detail: { p: result.relation.distribution?.caused_by_diff ?? 0, test: block.testName ?? "" },
        });
      }
      if (answers.nondeterminism >= TRIAGE_FAILURES_POLICY.nondeterminism) {
        findings.push({
          flag: "nondeterminism_signature_present",
          id: block.id,
          source: "jev",
          severity: "info",
          lines: result.lines,
          detail: { p: round(answers.nondeterminism), note: "not a flakiness verdict; one run only" },
        });
      }
      if (answers.untrusted >= TRIAGE_FAILURES_POLICY.untrusted) {
        findings.push({
          flag: "untrusted_instruction_text",
          id: block.id,
          source: "jev",
          severity: "info",
          lines: result.lines,
          detail: { p: round(answers.untrusted) },
        });
      }
      await run.decision(
        block.id,
        "failure_relation",
        { relation: result.relation.label, kind: result.failureKind.label },
        TRIAGE_FAILURES_POLICY.version,
      );
    }

    const families = new Map<string, number>();
    for (const result of results) families.set(result.family, (families.get(result.family) ?? 0) + 1);
    return {
      results,
      findings,
      parked,
      limits,
      notChecked: [
        "tests were not executed or rerun",
        "flakiness cannot be established from a single log",
        "root causes outside recognized failure windows",
        ...(diff ? [] : ["relation to code changes (no diff context)"]),
      ],
      summary: {
        logLines: parsed.totalLines,
        failureBlocks: parsed.blocks.length,
        families: families.size,
        duplicates: results.filter((result) => result.duplicateOf).length,
      },
      incomplete: parsed.blocks.length === 0,
    };
  }
}

function keyLines(block: FailureBlock): Array<{ n: number; text: string }> {
  const important = block.lines.filter(
    (line) =>
      /FAIL|not ok|Error|Exception|panic|Traceback|expected|received|assert/i.test(line.text) &&
      line.text.trim(),
  );
  return (important.length > 0 ? important : block.lines)
    .slice(0, 8)
    .map((line) => ({ n: line.n, text: line.text.slice(0, 300) }));
}

async function probeEvidence(
  label: string | null,
  result: FailureResult,
  hunks: readonly Hunk[],
  source: WorkspaceSource,
): Promise<{ name: string; evidence: JsonObject; refs: EvidenceRef[] } | null> {
  if (label === "test_source") {
    const location = result.stackLocations.find((entry) => entry.tracked && entry.line);
    if (!location?.tracked || !location.line) return null;
    const file = await source.readLines(location.tracked);
    if (!file) return null;
    const start = Math.max(1, location.line - TRIAGE_FAILURES_POLICY.probeContextLines);
    const end = Math.min(file.lines.length, location.line + TRIAGE_FAILURES_POLICY.probeContextLines);
    const text = file.lines
      .slice(start - 1, end)
      .map((line, offset) => `${start + offset}| ${line}`)
      .join("\n");
    return {
      name: "read-stack-source@1",
      evidence: { kind: "source_excerpt", path: location.tracked, startLine: start, endLine: end, text },
      refs: [
        {
          kind: "file_range",
          id: `${location.tracked}:${start}-${end}`,
          path: location.tracked,
          startLine: start,
          endLine: end,
          probe: "read-stack-source@1",
          truncated: start > 1 || end < file.lines.length,
        },
      ],
    };
  }
  if (label === "changed_code") {
    const paths = new Set(result.stackLocations.map((entry) => entry.tracked).filter(Boolean));
    const related = hunks.filter((hunk) => paths.has(hunk.path)).slice(0, 2);
    if (related.length === 0) return null;
    return {
      name: "changed-hunks-for-stack@1",
      evidence: { kind: "changed_hunks", hunks: related.map(hunkEvidence) },
      refs: related.map((hunk) => ({
        kind: "git_hunk" as const,
        id: hunk.id,
        path: hunk.path,
        startLine: hunk.newStart,
        endLine: hunk.newStart + Math.max(hunk.newLines - 1, 0),
        probe: "changed-hunks-for-stack@1",
        truncated: hunk.part !== null,
      })),
    };
  }
  return null;
}

function wouldSettle(result: FailureResult, answers: RelationAnswers): string[] {
  const steps = new Set<string>();
  const missing = answers.missing.choice;
  if (missing === "full_stack_trace" || result.omittedLines > 0)
    steps.add("provide a log with the complete error output");
  if (missing === "test_source") steps.add("inspect the failing test's source");
  if (missing === "changed_code") steps.add("inspect the changed code on the stack");
  if (missing === "prior_run_history" || answers.nondeterminism >= TRIAGE_FAILURES_POLICY.nondeterminism) {
    steps.add("rerun the failing test at least three times");
    steps.add("run the same test on the base commit");
  }
  if (result.relation.label === "uncertain" || result.relation.label === "conflict") {
    steps.add("run the same test on the base commit");
  }
  return [...steps];
}
