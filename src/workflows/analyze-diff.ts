import { hashValue } from "../core/hash.ts";
import { choice, noul, score } from "../core/questions.ts";
import type { JsonObject } from "../core/types.ts";
import {
  type ChoiceAnswer,
  expectKeys,
  readChoice,
  readNoul,
  readScore,
  type ScoreAnswer,
} from "../core/validation.ts";
import {
  boundedTask,
  describeScope,
  diffNotChecked,
  hunkEvidence,
  hunkRef,
  loadDiff,
  requireTask,
  sortFindings,
  taskTokens,
  unjudgedOrFailed,
} from "./common.ts";
import type { Hunk } from "./evidence.ts";
import { hunkText, lineRange } from "./hunks.ts";
import {
  EVIDENCE_POLICY,
  massAtLeast,
  round,
  roundedDistribution,
  UNTRUSTED_INSTRUCTION_THRESHOLD,
  untrustedInstructionQuestion,
} from "./policy.ts";
import type { DiffScope } from "./ports.ts";
import { buildFrame, Run, type RunOptions, type WorkflowInfo } from "./run.ts";
import type { EvidenceRef, Finding, Packet, Parked } from "./types.ts";

export const DIFF_ANALYSIS_KINDS = [
  "review",
  "test_gaps",
  "summarize",
  "security_review",
  "performance_review",
  "compatibility_review",
] as const;

export type DiffAnalysisKind = (typeof DIFF_ANALYSIS_KINDS)[number];

export interface DiffAnalysisInput {
  /** The natural-language request that selected this bounded analysis. */
  request: string;
  /** Optional exact implementation task, when useful as context. */
  task?: string;
  scope?: DiffScope;
  base?: string;
  maxHunks?: number;
}

export interface DiffAnalysisResult<K extends DiffAnalysisKind = DiffAnalysisKind> {
  analysis: K;
  id: string;
  path: string;
  lines: string;
  kind: string;
  fileStatus: string;
  added: number;
  removed: number;
  disposition: string;
  classification: {
    label: string;
    confidence: number;
    concernMass: number;
    distribution: Record<string, number>;
  } | null;
  importance: {
    score: number;
    highMass: number;
    distribution: number[];
  } | null;
  evidenceSufficient: number | null;
  untrustedInstructionText: number | null;
  flag: string | null;
  error: string | null;
}

interface ModeConfig {
  summary: string;
  classificationQuestion: string;
  guidance: string;
  criteria: Record<string, string>;
  importanceQuestion: string;
  importanceLevels: readonly [string, string, string, string];
  concerns: readonly string[];
  findingPrefix: string;
  notChecked: string[];
}

const RISK_LEVELS = [
  "No meaningful risk or required follow-up is visible in this hunk.",
  "Minor or localized concern; normal implementation review can settle it.",
  "Material concern that could affect behavior, users, or maintainability and should be investigated.",
  "High-impact concern with a plausible failure, vulnerability, regression, or breaking change visible in the evidence.",
] as const;

const MODES: Record<DiffAnalysisKind, ModeConfig> = {
  review: {
    summary: "Review changed code for concrete correctness risks",
    classificationQuestion: "What is the most important review disposition for this changed hunk?",
    guidance:
      "Flag only a concrete behavioral risk supported by the shown diff. Do not report style preferences, speculative problems that require unseen code, or the mere absence of unrelated hardening. A refactor is not a defect by itself.",
    criteria: {
      correctness_risk:
        "The shown logic plausibly computes, branches, validates, or returns the wrong result.",
      error_handling_risk: "A concrete shown error, cleanup, retry, or fallback path is mishandled.",
      state_or_concurrency_risk:
        "The shown state transition, ordering, synchronization, or lifecycle can misbehave.",
      data_integrity_risk: "The shown change can lose, corrupt, duplicate, or inconsistently persist data.",
      maintainability_only:
        "There may be a readability or design concern, but no concrete behavioral defect is visible.",
      no_issue_visible: "No concrete issue is visible in the shown evidence.",
      cannot_tell: "The shown evidence is insufficient to classify the hunk.",
    },
    importanceQuestion: "How serious is the most plausible concrete review concern in this hunk?",
    importanceLevels: RISK_LEVELS,
    concerns: ["correctness_risk", "error_handling_risk", "state_or_concurrency_risk", "data_integrity_risk"],
    findingPrefix: "review",
    notChecked: [
      "runtime behavior outside the shown diff",
      "style-only and subjective design preferences",
      "whether tests, builds, or linters pass",
    ],
  },
  test_gaps: {
    summary: "Identify concrete changed behavior that lacks visible test evidence",
    classificationQuestion:
      "What test-coverage disposition best fits this implementation hunk and the shown test changes?",
    guidance:
      "A missing-test label requires a concrete changed behavior or boundary visible in the implementation hunk. Unchanged tests may exist outside the diff, so use cannot_tell unless the diff itself supports the gap. Do not demand tests for formatting, mechanical wiring, or behavior-neutral refactors.",
    criteria: {
      missing_behavior_test:
        "A concrete changed user-visible or domain behavior has no visible matching test evidence.",
      missing_edge_case_test:
        "A newly introduced boundary, branch, or special case lacks visible test evidence.",
      missing_error_path_test:
        "A changed failure, validation, retry, fallback, or cleanup path lacks visible test evidence.",
      missing_integration_test:
        "A changed cross-component contract or integration boundary lacks visible end-to-end evidence.",
      test_evidence_present: "The shown test changes directly exercise the changed behavior or contract.",
      not_test_relevant: "The hunk does not change behavior that reasonably needs distinct test evidence.",
      cannot_tell: "The diff does not establish whether suitable tests exist or are needed.",
    },
    importanceQuestion:
      "How important is the potentially missing test for preventing a meaningful regression?",
    importanceLevels: RISK_LEVELS,
    concerns: [
      "missing_behavior_test",
      "missing_edge_case_test",
      "missing_error_path_test",
      "missing_integration_test",
    ],
    findingPrefix: "test_gap",
    notChecked: [
      "unchanged tests outside the diff",
      "runtime coverage measurements",
      "whether the test suite passes",
    ],
  },
  summarize: {
    summary: "Classify the purpose and centrality of each changed hunk",
    classificationQuestion: "What kind of change does this hunk primarily make?",
    guidance:
      "Classify only what is visible. Choose the primary purpose of the hunk rather than inferring an unstated project goal. Use mixed when two purposes are equally central.",
    criteria: {
      feature: "Adds a new externally observable capability or supported behavior.",
      bug_fix: "Corrects behavior that was previously wrong or unsafe.",
      refactor: "Restructures implementation without an intended behavior change.",
      test_change: "Adds or changes tests, fixtures, or test infrastructure.",
      configuration: "Changes configuration, build, CI, packaging, or dependencies.",
      documentation: "Changes documentation or explanatory comments.",
      cleanup: "Removes dead code or makes a narrow mechanical cleanup.",
      mixed: "Two or more change purposes are equally central in this hunk.",
      cannot_tell: "The primary change purpose is not clear from the hunk.",
    },
    importanceQuestion: "How central is this hunk to the overall diff?",
    importanceLevels: [
      "Incidental or purely mechanical support for another change.",
      "A secondary supporting change.",
      "A material part of the overall change.",
      "One of the primary changes that defines the diff.",
    ],
    concerns: [],
    findingPrefix: "summary",
    notChecked: [
      "a prose change description or release note",
      "the motivation beyond what the diff shows",
      "runtime correctness",
    ],
  },
  security_review: {
    summary: "Review changed code for concrete security risks",
    classificationQuestion: "What security disposition best fits this changed hunk?",
    guidance:
      "Distinguish a concrete vulnerability introduced or exposed by the shown code from code that merely touches a security-sensitive area. Do not flag hypothetical hardening opportunities without a plausible attack path in evidence.",
    criteria: {
      authorization_or_authentication:
        "The shown change can bypass or weaken identity, permission, or access checks.",
      injection_or_unsafe_execution:
        "Untrusted data can plausibly reach a command, query, template, parser, or evaluator unsafely.",
      secret_or_sensitive_data_exposure:
        "The shown change can disclose credentials, private data, or sensitive metadata.",
      path_or_resource_access:
        "The shown path, file, URL, redirect, or resource selection can cross a trust boundary unsafely.",
      cryptography_or_session_risk:
        "The shown cryptographic, token, cookie, or session behavior is concretely weakened.",
      credential_policy_risk: "The shown password, credential, or account policy is concretely weakened.",
      dependency_or_supply_chain_risk:
        "The shown dependency or build change creates a concrete supply-chain concern.",
      security_hardening: "The hunk improves security or reduces an existing risk.",
      security_relevant_no_issue: "The hunk is security-sensitive, but no concrete weakness is visible.",
      no_security_relevance: "No meaningful security boundary or behavior is touched.",
      cannot_tell: "A security judgment requires evidence outside the shown diff.",
    },
    importanceQuestion: "How severe is the most plausible security impact visible in this hunk?",
    importanceLevels: RISK_LEVELS,
    concerns: [
      "authorization_or_authentication",
      "injection_or_unsafe_execution",
      "secret_or_sensitive_data_exposure",
      "path_or_resource_access",
      "cryptography_or_session_risk",
      "credential_policy_risk",
      "dependency_or_supply_chain_risk",
    ],
    findingPrefix: "security",
    notChecked: [
      "dependencies or configuration outside the diff",
      "dynamic exploitability or penetration testing",
      "a complete security audit",
    ],
  },
  performance_review: {
    summary: "Review changed code for concrete performance risks",
    classificationQuestion: "What performance disposition best fits this changed hunk?",
    guidance:
      "Flag only a concrete cost change visible in the shown code and likely to matter on a plausible hot or scaling path. Do not equate every allocation, loop, await, or database call with a regression.",
    criteria: {
      algorithmic_complexity_risk: "The shown change materially worsens work as input size grows.",
      repeated_io_or_query_risk:
        "The shown change adds plausibly repeated file, network, or database operations.",
      blocking_or_serialization_risk:
        "The shown change unnecessarily blocks, serializes, or removes useful concurrency on a relevant path.",
      memory_or_retention_risk:
        "The shown change can materially increase allocation, buffering, caching, or retention.",
      cache_or_batching_regression:
        "The shown change defeats effective caching, batching, pagination, or reuse.",
      performance_improvement: "The hunk concretely reduces meaningful work, latency, memory, or contention.",
      performance_relevant_no_issue:
        "The hunk affects a performance-sensitive path, but no concrete regression is visible.",
      no_performance_relevance: "No meaningful performance behavior is changed.",
      cannot_tell: "Impact depends on runtime evidence or context outside the diff.",
    },
    importanceQuestion: "How material is the most plausible performance impact visible in this hunk?",
    importanceLevels: RISK_LEVELS,
    concerns: [
      "algorithmic_complexity_risk",
      "repeated_io_or_query_risk",
      "blocking_or_serialization_risk",
      "memory_or_retention_risk",
      "cache_or_batching_regression",
    ],
    findingPrefix: "performance",
    notChecked: [
      "runtime profiles, benchmarks, or production traffic",
      "performance behavior outside the changed lines",
      "whether the observed cost is acceptable for the deployment",
    ],
  },
  compatibility_review: {
    summary: "Review changed code for concrete compatibility risks",
    classificationQuestion: "What compatibility disposition best fits this changed hunk?",
    guidance:
      "A breaking label requires a visible contract used across a boundary, not merely an internal refactor. Consider source APIs, runtime behavior, persisted data, configuration, and wire formats separately.",
    criteria: {
      breaking_source_api:
        "A public or externally consumed signature, export, type, or call contract is incompatibly changed.",
      breaking_behavior: "Existing valid callers can observe an incompatible semantic behavior change.",
      breaking_data_or_wire_format:
        "Persisted data, schemas, events, or network payloads are incompatibly changed.",
      breaking_configuration:
        "Existing configuration, environment variables, flags, or defaults become incompatible.",
      migration_or_deprecation:
        "The hunk adds or performs an explicit migration, fallback, alias, or deprecation path.",
      additive_compatible: "The visible contract change is additive and preserves existing valid consumers.",
      internal_only: "The change is confined to an internal implementation contract.",
      no_compatibility_relevance: "No consumer-facing or persisted contract is touched.",
      cannot_tell: "Whether this is a public or persisted contract is not established by the diff.",
    },
    importanceQuestion: "How severe is the most plausible compatibility impact visible in this hunk?",
    importanceLevels: RISK_LEVELS,
    concerns: [
      "breaking_source_api",
      "breaking_behavior",
      "breaking_data_or_wire_format",
      "breaking_configuration",
    ],
    findingPrefix: "compatibility",
    notChecked: [
      "external consumers not represented in the repository",
      "persisted data or deployed versions outside the diff",
      "a full semantic-versioning decision",
    ],
  },
};

export const DIFF_ANALYSIS_POLICY = {
  version: "diff-analysis-policy@2",
  defaultMaxHunks: 150,
  concernMass: 0.7,
  summaryClassification: 0.45,
  cannotTell: 0.5,
  important: 0.6,
  evidence: 0.5,
  maxManifestFiles: 100,
  maxRelatedTests: 2,
} as const;

interface AnalysisAnswers {
  classification: ChoiceAnswer<string>;
  importance: ScoreAnswer;
  evidenceSufficient: number;
  untrusted: number;
}

function relatedTestHunks(hunk: Hunk, tests: readonly Hunk[]): Hunk[] {
  const tokens = taskTokens(`${hunk.path} ${hunkText(hunk)}`);
  return [...tests]
    .map((test) => ({
      test,
      overlap: tokens.filter((token) => `${test.path} ${hunkText(test)}`.toLowerCase().includes(token))
        .length,
    }))
    .filter(({ overlap }) => overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || a.test.path.localeCompare(b.test.path))
    .slice(0, DIFF_ANALYSIS_POLICY.maxRelatedTests)
    .map(({ test }) => test);
}

function analysisFrame(
  kind: DiffAnalysisKind,
  request: string,
  task: string | null,
  manifest: JsonObject,
  hunk: Hunk,
  relatedTests: readonly Hunk[],
  refs: EvidenceRef[],
) {
  const config = MODES[kind];
  const labels = Object.keys(config.criteria);
  const questions = {
    classification: choice(
      {
        question: `${config.classificationQuestion} Candidate: ${hunk.id} (${hunk.path}).`,
        guidance: config.guidance,
      },
      config.criteria,
    ),
    importance: score(config.importanceQuestion, [...config.importanceLevels]),
    evidence_sufficient: noul(
      {
        question: "Is the shown diff evidence sufficient for the selected classification?",
        guidance:
          "Choose false when the classification depends on unseen callers, unchanged tests, runtime behavior, production scale, external consumers, or surrounding implementation that is not shown.",
      },
      {
        true: "The classification is directly supported by the shown diff evidence.",
        false: "Material outside evidence is needed before making the classification.",
      },
    ),
    untrusted_instruction_text: untrustedInstructionQuestion(),
  };
  const keys = Object.keys(questions);
  return buildFrame<AnalysisAnswers>({
    template: `diff-${kind}@1`,
    scope: hunk.id,
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      analysis: kind,
      request,
      task,
      diffManifest: manifest,
      hunk: hunkEvidence(hunk),
      relatedTestHunks: relatedTests.map(hunkEvidence),
    },
    questions,
    provenance: refs,
    parse(answers) {
      expectKeys(answers, keys);
      return {
        classification: readChoice(answers, "classification", labels),
        importance: readScore(answers, "importance", 4),
        evidenceSufficient: readNoul(answers, "evidence_sufficient"),
        untrusted: readNoul(answers, "untrusted_instruction_text"),
      };
    },
  });
}

function flagFor(kind: DiffAnalysisKind, label: string): string {
  if (kind === "test_gaps") return label;
  return `${MODES[kind].findingPrefix}_${label}`;
}

const PRIORITY_TERMS: Partial<Record<DiffAnalysisKind, readonly string[]>> = {
  review: ["catch", "throw", "return", "delete", "update", "null", "undefined", "await"],
  test_gaps: ["if", "else", "switch", "catch", "throw", "validate", "fallback", "retry"],
  security_review: [
    "auth",
    "permission",
    "role",
    "token",
    "secret",
    "password",
    "session",
    "cookie",
    "exec",
    "query",
    "redirect",
    "crypto",
  ],
  performance_review: [
    "for ",
    "while ",
    ".map(",
    ".filter(",
    "await ",
    "query",
    "fetch",
    "cache",
    "batch",
    "render",
  ],
  compatibility_review: ["export", "public", "api", "schema", "config", "version", "deprecated", "migration"],
};

function analysisPriority(kind: DiffAnalysisKind, hunk: Hunk): number {
  if (kind === "summarize") return 0;
  let priority =
    hunk.kind === "source"
      ? 40
      : hunk.kind === "config" || hunk.kind === "ci"
        ? 25
        : hunk.kind === "test"
          ? 10
          : hunk.kind === "documentation"
            ? -20
            : 0;
  const pathText = `${hunk.path} ${hunk.section}`.toLowerCase();
  const text = hunkText(hunk).toLowerCase();
  const changedText = hunk.lines
    .filter((line) => line.type !== " ")
    .map((line) => line.text)
    .join("\n")
    .toLowerCase();
  const removedText = hunk.lines
    .filter((line) => line.type === "-")
    .map((line) => line.text)
    .join("\n")
    .toLowerCase();
  let pathHits = 0;
  let changedHits = 0;
  let contextHits = 0;
  for (const term of PRIORITY_TERMS[kind] ?? []) {
    if (pathText.includes(term)) pathHits++;
    if (changedText.includes(term)) changedHits++;
    else if (text.includes(term)) contextHits++;
  }
  priority += Math.min(pathHits, 3) * 8;
  priority += Math.min(changedHits, 4) * 8;
  priority += Math.min(contextHits, 2) * 2;
  if (
    kind === "security_review" &&
    /(?:^|[^a-z])(?:auth(?:entication|orization)?|permission|role|token|secret|password|session|cookie|crypto(?:graphy|graphic)?)(?:[^a-z]|$)/.test(
      removedText,
    ) &&
    /\b(?:if|require|assert|validate|verify|authorize|deny|allow)\b|===|!==|\blength\s*[<>]=?/.test(
      removedText,
    )
  ) {
    priority += 60;
  }
  if (
    kind === "compatibility_review" &&
    /\b(?:export|public|api|schema|config|version)\b/.test(removedText)
  ) {
    priority += 20;
  }
  priority += Math.min(hunk.added + hunk.removed, 40) / 40;
  return priority;
}

async function analyzeDiff<K extends DiffAnalysisKind>(
  info: WorkflowInfo,
  kind: K,
  input: DiffAnalysisInput,
  options: RunOptions,
): Promise<Packet<DiffAnalysisResult<K>>> {
  const request = requireTask(input.request, "request");
  const task = input.task?.trim() ? boundedTask(input.task.trim()) : null;
  const maxHunks = input.maxHunks ?? DIFF_ANALYSIS_POLICY.defaultMaxHunks;
  const diff = await loadDiff(options.dependencies, {
    scope: input.scope ?? "worktree",
    ...(input.base ? { base: input.base } : {}),
  });
  const config = MODES[kind];
  const eligible =
    kind === "test_gaps"
      ? diff.hunks.filter((hunk) => hunk.kind !== "test" && hunk.kind !== "documentation")
      : diff.hunks;
  const testHunks = diff.hunks.filter((hunk) => hunk.kind === "test");
  const manifestByPath = new Map<
    string,
    { path: string; kind: string; fileStatus: string; hunks: number; added: number; removed: number }
  >();
  for (const hunk of diff.hunks) {
    const current = manifestByPath.get(hunk.path);
    manifestByPath.set(hunk.path, {
      path: hunk.path,
      kind: hunk.kind,
      fileStatus: hunk.fileStatus,
      hunks: (current?.hunks ?? 0) + 1,
      added: (current?.added ?? 0) + hunk.added,
      removed: (current?.removed ?? 0) + hunk.removed,
    });
  }
  const manifestEntries = [...manifestByPath.values()].slice(0, DIFF_ANALYSIS_POLICY.maxManifestFiles);
  const manifest: JsonObject = {
    files: manifestEntries,
    omittedFromManifest: Math.max(0, manifestByPath.size - manifestEntries.length),
  };
  const run = await Run.start(info, options, {
    analysis: kind,
    requestHash: hashValue(request),
    taskHash: task ? hashValue(task) : null,
    diff: describeScope(diff.source),
    maxHunks,
  });
  for (const item of diff.excluded) run.setDisposition(item.id, "excluded");

  const limits: string[] = [];
  if (manifestByPath.size > DIFF_ANALYSIS_POLICY.maxManifestFiles) {
    limits.push(
      `diff manifest lists the first ${DIFF_ANALYSIS_POLICY.maxManifestFiles} of ${manifestByPath.size} files`,
    );
  }
  if (eligible.length > maxHunks) {
    limits.push(
      `only ${maxHunks} highest-priority hunks of ${eligible.length} eligible hunks were judged (policy hunk limit)`,
    );
  }

  const results = new Map<string, DiffAnalysisResult<K>>();
  const toJudge = eligible
    .map((hunk, index) => ({ hunk, index, priority: analysisPriority(kind, hunk) }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, maxHunks)
    .map(({ hunk }) => hunk);
  const judgedIds = new Set(toJudge.map((hunk) => hunk.id));
  for (const hunk of eligible) {
    const result: DiffAnalysisResult<K> = {
      analysis: kind,
      id: hunk.id,
      path: hunk.path,
      lines: lineRange(hunk),
      kind: hunk.kind,
      fileStatus: hunk.fileStatus,
      added: hunk.added,
      removed: hunk.removed,
      disposition: "unjudged",
      classification: null,
      importance: null,
      evidenceSufficient: null,
      untrustedInstructionText: null,
      flag: null,
      error: judgedIds.has(hunk.id) ? null : "not judged: hunk limit",
    };
    results.set(hunk.id, result);
    run.setDisposition(hunk.id, "unjudged");
  }
  await run.candidates({
    analysis: kind,
    hunks: [...results.values()],
    contextTestHunks: kind === "test_gaps" ? testHunks.map((hunk) => hunk.id) : [],
    excluded: diff.excluded,
  });

  const relatedById = new Map(
    toJudge.map((hunk) => [hunk.id, kind === "test_gaps" ? relatedTestHunks(hunk, testHunks) : []]),
  );
  const frames = toJudge.map((hunk) => {
    const related = relatedById.get(hunk.id) ?? [];
    return analysisFrame(kind, request, task, manifest, hunk, related, [
      hunkRef(hunk, diff.source),
      ...related.map((item) => hunkRef(item, diff.source)),
    ]);
  });
  const outcomes = await run.judgeAll(frames);
  const findings: Finding[] = [];
  const parked: Parked[] = [];
  for (const [index, hunk] of toJudge.entries()) {
    const result = results.get(hunk.id)!;
    const outcome = outcomes[index]!;
    if (!outcome.ok) {
      result.error = `${outcome.reason}: ${outcome.detail}`;
      result.disposition = unjudgedOrFailed(outcome.reason);
      run.setDisposition(hunk.id, result.disposition as "unjudged" | "failed");
      continue;
    }
    const answer = outcome.value;
    const orderedLabels = Object.entries<number>(answer.classification.probabilities).sort(
      (a, b) => b[1] - a[1],
    );
    const [topLabel, topProbability] = orderedLabels[0]!;
    const concernMass = round(
      config.concerns.reduce((total, label) => total + (answer.classification.probabilities[label] ?? 0), 0),
    );
    const topConcern = orderedLabels.find(([label]) => config.concerns.includes(label))?.[0] ?? null;
    const concern = concernMass >= DIFF_ANALYSIS_POLICY.concernMass;
    const label = concern && topConcern ? topConcern : topLabel;
    const highMass = massAtLeast(answer.importance, 2);
    result.classification = {
      label,
      confidence: round(topProbability),
      concernMass,
      distribution: roundedDistribution(answer.classification.probabilities),
    };
    result.importance = {
      score: round(answer.importance.score),
      highMass,
      distribution: answer.importance.probabilities.map((value) => round(value)),
    };
    result.evidenceSufficient = round(answer.evidenceSufficient);
    result.untrustedInstructionText = round(answer.untrusted);
    const cannotTell = answer.classification.probabilities.cannot_tell ?? 0;
    const materialConcern = concern && highMass >= DIFF_ANALYSIS_POLICY.important;
    const uncertain =
      cannotTell >= DIFF_ANALYSIS_POLICY.cannotTell ||
      (kind === "summarize" && topProbability < DIFF_ANALYSIS_POLICY.summaryClassification) ||
      (materialConcern && answer.evidenceSufficient < DIFF_ANALYSIS_POLICY.evidence);
    if (uncertain) {
      result.disposition = "parked";
      run.setDisposition(hunk.id, "parked");
      parked.push({
        id: hunk.id,
        path: hunk.path,
        reason:
          cannotTell >= DIFF_ANALYSIS_POLICY.cannotTell ||
          (kind === "summarize" && topProbability < DIFF_ANALYSIS_POLICY.summaryClassification)
            ? `${kind}: classification uncertain`
            : `${kind}: material concern needs evidence outside the diff`,
      });
    } else {
      result.disposition = "judged";
      run.setDisposition(hunk.id, "judged");
    }
    if (materialConcern && answer.evidenceSufficient >= DIFF_ANALYSIS_POLICY.evidence) {
      result.flag = flagFor(kind, label);
      findings.push({
        flag: result.flag,
        id: hunk.id,
        source: "jev",
        severity: "warn",
        path: hunk.path,
        lines: result.lines,
        detail: {
          classification: label,
          probability: round(answer.classification.probabilities[label] ?? 0),
          concernMass,
          importanceHighMass: highMass,
          evidenceSufficient: result.evidenceSufficient,
        },
      });
    }
    if (answer.untrusted >= UNTRUSTED_INSTRUCTION_THRESHOLD) {
      findings.push({
        flag: "untrusted_instruction_text",
        id: hunk.id,
        source: "jev",
        severity: "info",
        path: hunk.path,
        lines: result.lines,
        detail: { p: result.untrustedInstructionText },
      });
    }
    await run.decision(
      hunk.id,
      `diff_${kind}`,
      {
        classification: result.classification,
        importance: result.importance,
        evidenceSufficient: result.evidenceSufficient,
        flag: result.flag,
      } as JsonObject,
      DIFF_ANALYSIS_POLICY.version,
    );
  }

  const counts: Record<string, number> = {};
  for (const result of results.values()) {
    const label = result.classification?.label ?? "unjudged";
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return run.finish({
    findings: sortFindings(findings),
    parked,
    excluded: diff.excluded,
    limits,
    notChecked: [...config.notChecked, ...diffNotChecked(diff.source)],
    results: [...results.values()],
    summary: {
      analysis: kind,
      description: config.summary,
      diff: describeScope(diff.source),
      eligibleHunks: eligible.length,
      contextTestHunks: kind === "test_gaps" ? testHunks.length : 0,
      classifications: counts,
    },
  });
}

const BUDGET = { requests: 200, inputTokens: 400_000, wallMs: 120_000 } as const;
export const REVIEW = { name: "review", version: 1, budget: BUDGET } as const;
export const TEST_GAPS = { name: "test_gaps", version: 1, budget: BUDGET } as const;
export const SUMMARIZE = { name: "summarize", version: 1, budget: BUDGET } as const;
export const SECURITY_REVIEW = { name: "security_review", version: 1, budget: BUDGET } as const;
export const PERFORMANCE_REVIEW = { name: "performance_review", version: 1, budget: BUDGET } as const;
export const COMPATIBILITY_REVIEW = { name: "compatibility_review", version: 1, budget: BUDGET } as const;

export const review = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(REVIEW, "review", input, options);
export const testGaps = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(TEST_GAPS, "test_gaps", input, options);
export const summarize = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(SUMMARIZE, "summarize", input, options);
export const securityReview = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(SECURITY_REVIEW, "security_review", input, options);
export const performanceReview = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(PERFORMANCE_REVIEW, "performance_review", input, options);
export const compatibilityReview = (input: DiffAnalysisInput, options: RunOptions) =>
  analyzeDiff(COMPATIBILITY_REVIEW, "compatibility_review", input, options);
