import { hashValue } from "../core/hash.ts";
import { noul, score } from "../core/questions.ts";
import { expectKeys, readNoul, readScore, type ScoreAnswer } from "../core/validation.ts";
import {
  type DiffEvidence,
  hunkEvidence,
  hunkRef,
  type Section,
  taskTokens,
  unjudgedOrFailed,
} from "./common.ts";
import { InputError } from "./errors.ts";
import type { Hunk, TestRecord } from "./evidence.ts";
import { EVIDENCE_POLICY, inBand, round } from "./policy.ts";
import { buildFrame, type Run } from "./run.ts";
import type { Finding, Parked } from "./types.ts";

export interface Criterion {
  id: string;
  index: number;
  text: string;
  line: number;
}

/** The criteria section of `check`: which acceptance criteria have code or test evidence in the diff. */
export interface CriteriaSectionInput {
  criteria: readonly Criterion[];
  /** Supplied test records; empty when no test results were given. */
  tests: readonly TestRecord[];
  maxEvidenceUnits: number;
}

export const CHECK_CRITERIA_POLICY = {
  version: "check-criteria-policy@1",
  defaultMaxEvidenceUnits: 80,
  maxCriteria: 20,
  maxCriterionChars: 300,
  accept: 0.6,
  unsupportedBelow: 0.3,
  maxEvidencePerCriterion: 3,
  decisiveLevel: 0.5,
} as const;

/** Split numbered, bulleted, or checkbox list items. Prose is never split by a model. */
export function parseCriteria(text: string): Criterion[] {
  const items: Criterion[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    const value = match[1];
    if (value.length > CHECK_CRITERIA_POLICY.maxCriterionChars) {
      throw new InputError(
        `criterion on line ${index + 1} is ${value.length} characters; the limit is ${CHECK_CRITERIA_POLICY.maxCriterionChars}`,
      );
    }
    const position = items.length + 1;
    items.push({
      id: `c${position}_${hashValue(value).slice(0, 6)}`,
      index: position,
      text: value,
      line: index + 1,
    });
  }
  if (items.length === 0)
    throw new InputError("no list items found; write criteria as a numbered or bulleted list");
  if (items.length > CHECK_CRITERIA_POLICY.maxCriteria) {
    throw new InputError(`${items.length} criteria found; the limit is ${CHECK_CRITERIA_POLICY.maxCriteria}`);
  }
  return items;
}

const STRENGTH_LEVELS = [
  "No shown evidence addresses the criterion.",
  "The criterion is only mentioned (names, comments, docs) without implementing behavior.",
  "The shown code implements the criterion, but no shown test exercises it.",
  "The shown code implements the criterion and a shown test asserts that behavior.",
] as const;

const STRENGTH_EXAMPLES = [
  { criterion: "Return 404 for unknown ids", evidence: "README: 'unknown ids return 404'", level: 1 },
  {
    criterion: "Return 404 for unknown ids",
    evidence: "+ if (!item) return res.status(404).end()",
    level: 2,
  },
  {
    criterion: "Return 404 for unknown ids",
    evidence: "+ if (!item) return res.status(404).end()\n+ expect((await get('/items/x')).status).toBe(404)",
    level: 3,
  },
  { criterion: "Log each retry", evidence: "+ const MAX_RETRIES = 3", level: 0 },
];

function addressesFrame(criteria: readonly Criterion[], hunk: Hunk, ref: ReturnType<typeof hunkRef>) {
  const questions = Object.fromEntries(
    criteria.map((criterion) => [
      `addresses_${criterion.id}`,
      noul(
        {
          question: `Does diff hunk ${hunk.id} contain code or tests that address criterion ${criterion.id}?`,
          criterion: criterion.text,
        },
        {
          true: "The hunk implements, changes, or tests behavior the criterion describes.",
          false: "The hunk does not address this criterion.",
        },
      ),
    ]),
  );
  const keys = Object.keys(questions);
  return buildFrame<Map<string, number>>({
    template: "criterion_evidence@1",
    scope: hunk.id,
    state: { evidencePolicy: EVIDENCE_POLICY, hunk: hunkEvidence(hunk) },
    questions,
    provenance: [ref],
    parse(answers) {
      expectKeys(answers, keys);
      return new Map(
        criteria.map((criterion) => [criterion.id, readNoul(answers, `addresses_${criterion.id}`)]),
      );
    },
  });
}

function strengthFrame(
  criterion: Criterion,
  evidence: readonly Hunk[],
  refs: ReturnType<typeof hunkRef>[],
  tests: TestRecord[],
) {
  return buildFrame<ScoreAnswer>({
    template: "criterion_strength@1",
    scope: criterion.id,
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      criterion: { id: criterion.id, text: criterion.text },
      evidence: evidence.map(hunkEvidence),
      linkedTestRecords: tests.map((test) => ({ name: test.name, status: test.status, file: test.file })),
    },
    questions: {
      evidence_strength: score(
        {
          question: `How strongly does the shown evidence establish criterion ${criterion.id}?`,
          note: "Judge only the shown hunks and test records. Claims in prose are not evidence of behavior.",
          workedExamples: STRENGTH_EXAMPLES,
        },
        [...STRENGTH_LEVELS],
      ),
    },
    provenance: refs,
    parse(answers) {
      expectKeys(answers, ["evidence_strength"]);
      return readScore(answers, "evidence_strength", 4);
    },
  });
}

export interface CriterionResult {
  id: string;
  text: string;
  line: number;
  status: "supported" | "partial" | "unsupported" | "unclear";
  determinedBy: "jev" | "policy";
  evidence: Array<{ hunk: string; path: string; lines: string; p: number }>;
  bandEvidence: Array<{ hunk: string; path: string; p: number }>;
  strength: { level: number | null; expected: number; distribution: number[] } | null;
  cappedBy: string | null;
  linkedTests: Array<{ name: string; status: string }>;
  disposition: string;
  error: string | null;
}

export function criteriaSection(
  run: Run,
  diff: DiffEvidence,
  input: CriteriaSectionInput,
): Section<CriterionResult> {
  const { criteria, tests, maxEvidenceUnits: maxUnits } = input;
  const limits: string[] = [];
  const parked: Parked[] = [];
  const findings: Finding[] = [];
  const units = diff.hunks.filter((hunk) => hunk.kind !== "lockfile" && hunk.kind !== "generated");
  const judgedUnits = units.slice(0, maxUnits);
  if (units.length > maxUnits) {
    limits.push(
      `only ${maxUnits} of ${units.length} diff hunks were used as evidence (policy evidence limit)`,
    );
  }
  if (diff.hunks.length === 0) limits.push("the diff is empty; no criterion evidence exists");
  return {
    candidates: {
      criteria,
      testRecords: tests.length,
      units: units.map((hunk) => ({ id: hunk.id, path: hunk.path })),
    },
    judge,
  };

  async function judge() {
    const unitOutcomes = await run.judgeAll(
      judgedUnits.map((hunk) => addressesFrame(criteria, hunk, hunkRef(hunk, diff.source))),
    );
    const failedUnits = unitOutcomes.filter((outcome) => !outcome.ok);
    if (failedUnits.length > 0)
      limits.push(`${failedUnits.length} evidence unit request(s) did not produce valid answers`);

    const results: CriterionResult[] = [];
    const strengthJobs: Array<{
      result: CriterionResult;
      criterion: Criterion;
      evidence: Hunk[];
      linked: TestRecord[];
    }> = [];
    for (const criterion of criteria) {
      const accepted: Array<{ hunk: Hunk; p: number }> = [];
      const band: Array<{ hunk: Hunk; p: number }> = [];
      for (const [index, hunk] of judgedUnits.entries()) {
        const outcome = unitOutcomes[index]!;
        if (!outcome.ok) continue;
        const p = outcome.value.get(criterion.id) ?? 0;
        if (p >= CHECK_CRITERIA_POLICY.accept) accepted.push({ hunk, p });
        else if (inBand(p, CHECK_CRITERIA_POLICY.unsupportedBelow, CHECK_CRITERIA_POLICY.accept))
          band.push({ hunk, p });
      }
      accepted.sort((a, b) => b.p - a.p || a.hunk.path.localeCompare(b.hunk.path));
      const tokens = taskTokens(criterion.text);
      const evidencePaths = new Set(accepted.map((entry) => entry.hunk.path));
      const linked = tests.filter(
        (test) =>
          (test.file !== null &&
            [...evidencePaths].some((path) => path.endsWith(test.file!) || test.file!.endsWith(path))) ||
          (tokens.length > 0 &&
            tokens.filter((token) => test.name.toLowerCase().includes(token)).length >=
              Math.min(2, tokens.length)),
      );
      const result: CriterionResult = {
        id: criterion.id,
        text: criterion.text,
        line: criterion.line,
        status: "unclear",
        determinedBy: "policy",
        evidence: accepted.map(({ hunk, p }) => ({
          hunk: hunk.id,
          path: hunk.path,
          lines: `${hunk.newStart}-${hunk.newStart + Math.max(hunk.newLines - 1, 0)}`,
          p: round(p),
        })),
        bandEvidence: band.map(({ hunk, p }) => ({ hunk: hunk.id, path: hunk.path, p: round(p) })),
        strength: null,
        cappedBy: null,
        linkedTests: linked.slice(0, 10).map((test) => ({ name: test.name, status: test.status })),
        disposition: "unjudged",
        error: null,
      };
      results.push(result);
      const answeredUnits = unitOutcomes.filter((outcome) => outcome.ok).length;
      if (accepted.length === 0) {
        if (answeredUnits < judgedUnits.length || units.length > judgedUnits.length) {
          result.status = "unclear";
          result.error = "not all evidence units were judged";
          const disposition = answeredUnits === 0 && judgedUnits.length > 0 ? "unjudged" : "parked";
          result.disposition = disposition;
          run.setDisposition(criterion.id, disposition);
          if (disposition === "parked")
            parked.push({ id: criterion.id, reason: "incomplete evidence coverage" });
        } else if (band.length > 0) {
          result.status = "unclear";
          result.disposition = "parked";
          run.setDisposition(criterion.id, "parked");
          parked.push({ id: criterion.id, reason: "evidence probabilities only in the uncertain band" });
        } else {
          result.status = "unsupported";
          result.disposition = judgedUnits.length === 0 ? "deterministic" : "judged";
          run.setDisposition(criterion.id, result.disposition as "deterministic" | "judged");
        }
        await run.decision(
          criterion.id,
          "no_accepted_evidence",
          result.status,
          CHECK_CRITERIA_POLICY.version,
        );
        continue;
      }
      strengthJobs.push({
        result,
        criterion,
        evidence: accepted.slice(0, CHECK_CRITERIA_POLICY.maxEvidencePerCriterion).map((e) => e.hunk),
        linked,
      });
    }

    const strengthOutcomes = await run.judgeAll(
      strengthJobs.map(({ criterion, evidence, linked }) =>
        strengthFrame(
          criterion,
          evidence,
          evidence.map((hunk) => hunkRef(hunk, diff.source)),
          linked.slice(0, 10),
        ),
      ),
    );
    for (const [index, { result, criterion, linked }] of strengthJobs.entries()) {
      const outcome = strengthOutcomes[index]!;
      if (!outcome.ok) {
        result.error = `${outcome.reason}: ${outcome.detail}`;
        const disposition = unjudgedOrFailed(outcome.reason);
        result.disposition = disposition;
        run.setDisposition(criterion.id, disposition);
        continue;
      }
      const answer = outcome.value;
      const best = answer.probabilities.reduce(
        (top, value, level) => (value > answer.probabilities[top]! ? level : top),
        0,
      );
      const level = answer.probabilities[best]! >= CHECK_CRITERIA_POLICY.decisiveLevel ? best : null;
      result.strength = {
        level,
        expected: round(answer.score),
        distribution: answer.probabilities.map((value) => round(value)),
      };
      result.disposition = "judged";
      result.determinedBy = "jev";
      run.setDisposition(criterion.id, "judged");
      const passing = linked.some((test) => test.status === "passed");
      if (level === null) {
        result.status = "unclear";
        result.disposition = "parked";
        run.setDisposition(criterion.id, "parked");
        parked.push({ id: criterion.id, reason: "evidence strength distribution is diffuse" });
      } else if (level === 3 && passing) {
        result.status = "supported";
      } else if (level >= 2) {
        result.status = "partial";
        if (level === 3) {
          result.cappedBy = tests.length === 0 ? "no test results supplied" : "no linked passing test record";
        }
      } else {
        result.status = "unsupported";
      }
      await run.decision(
        criterion.id,
        "criterion_strength",
        { level, status: result.status, cappedBy: result.cappedBy },
        CHECK_CRITERIA_POLICY.version,
      );
    }

    for (const result of results) {
      if (result.status === "unsupported" || result.status === "unclear") {
        findings.push({
          flag: result.status === "unsupported" ? "criterion_unevidenced" : "criterion_unclear",
          id: result.id,
          source: result.determinedBy === "jev" ? "jev" : "policy",
          severity: "warn",
          detail: { criterion: result.text.slice(0, 120) },
        });
      }
    }
    const counts = { supported: 0, partial: 0, unsupported: 0, unclear: 0 };
    for (const result of results) counts[result.status]++;
    const order = { unsupported: 0, unclear: 1, partial: 2, supported: 3 } as const;
    return {
      results: [...results].sort((a, b) => order[a.status] - order[b.status] || a.line - b.line),
      findings,
      parked,
      limits,
      notChecked: [
        "criteria satisfied by unchanged code are not detected",
        "only supplied test records are considered as test evidence",
        "agent summaries or PR prose are never treated as evidence",
      ],
      summary: {
        ...counts,
        criteria: criteria.length,
        evidenceUnits: units.length,
        testRecords: tests.length,
      },
      incomplete: units.length > judgedUnits.length,
    };
  }
}
