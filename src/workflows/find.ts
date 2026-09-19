import { shard, withSplitting } from "../core/batch.ts";
import { hashValue, seededShuffle, stableId } from "../core/hash.ts";
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
import { classifyPath, contentExclusionReason, languageForPath, matchesAnyGlob } from "./classify.ts";
import { requireTask, sortFindings, taskTokens, unjudgedOrFailed } from "./common.ts";
import {
  decisiveLabel,
  EVIDENCE_POLICY,
  massAtLeast,
  round,
  roundedDistribution,
  UNTRUSTED_INSTRUCTION_THRESHOLD,
  untrustedInstructionQuestion,
} from "./policy.ts";
import type { RedactionPort, WorkspaceSource } from "./ports.ts";
import { buildFrame, Run, type RunOptions } from "./run.ts";
import type { EvidenceRef, Exclusion, Finding, Packet, Parked } from "./types.ts";

export interface FindInput {
  task: string;
  paths?: string[];
  top?: number;
  includeExcerpts?: boolean;
  maxFiles?: number;
  mode?: "find" | "code_change_fallback";
}

export const CODE_CHANGE_FALLBACK_NOTICE =
  "Stanley cannot implement or fix code without a coding agent (install Pi to enable delegation); no files were changed; only read-only relevant-code analysis was run";

export const FIND = {
  name: "find",
  version: 1,
  budget: { requests: 600, inputTokens: 1_200_000, wallMs: 120_000 },
} as const;

export const FIND_POLICY = {
  version: "find-policy@3",
  shardSize: 20,
  acceptMetaHighMass: 0.35,
  maxExcerptCandidates: 24,
  strongHighMass: 0.6,
  conflictHighMass: 0.6,
  conflictUnrelated: 0.6,
  cutOff: 0.6,
  missingEvidence: 0.5,
  excerptLines: 160,
  wholeFileLines: 200,
  symbolScanBytes: 64 * 1024,
  maxSymbols: 12,
  maxFileBytes: 2 * 1024 * 1024,
} as const;

const ROLES = ["implementation", "caller", "test", "config", "docs", "unrelated", "cannot_tell"] as const;
const MISSING = ["none", "caller", "callee", "configuration", "tests", "cannot_tell"] as const;
const RELEVANCE_LEVELS = [
  "No specific connection to the artifact or behavior requested by the task.",
  "Shares terminology or a general domain, but relevance is incidental or uncertain.",
  "Provides supporting evidence, such as a caller, test, adapter, example, or configuration.",
  "Defines or coordinates the primary artifact or behavior explicitly requested by the task.",
] as const;

interface Candidate {
  id: string;
  path: string;
  language: string;
  kind: string;
  bytes: number;
  symbols: string[];
  lexical: number;
}

const STEM_SUFFIXES = [
  "ations",
  "ation",
  "itions",
  "ition",
  "ments",
  "ment",
  "ingly",
  "ing",
  "ers",
  "ies",
  "ied",
  "ed",
  "es",
  "er",
  "s",
  "ity",
] as const;

function tokenForms(token: string): string[] {
  const forms = [token];
  for (const suffix of STEM_SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    let stem = token.slice(0, -suffix.length);
    if (suffix === "ies" || suffix === "ied") stem += "y";
    if (stem.length >= 4) forms.push(stem);
    break;
  }
  return forms;
}

function includesToken(text: string, token: string): boolean {
  return tokenForms(token).some((form) => text.includes(form));
}

interface MetaAnswer {
  relevance: ScoreAnswer;
  role: ChoiceAnswer<(typeof ROLES)[number]>;
}

interface ExcerptAnswer {
  relevance: ScoreAnswer;
  targetVisible: number;
  cutOff: number;
  missing: ChoiceAnswer<(typeof MISSING)[number]>;
  untrusted: number;
}

export interface FindResult {
  rank: number | null;
  id: string;
  path: string;
  kind: string;
  language: string;
  disposition: string;
  metadata: {
    highMass: number;
    expected: number;
    role: string;
    roleDistribution: Record<string, number>;
  } | null;
  excerpt: {
    ranges: string[];
    highMass: number;
    expected: number;
    targetDefinitionVisible: number;
    relevantContentCutOff: number;
    missingEvidence: string;
    text?: string;
  } | null;
  relevance: number | null;
  probesRun: string[];
  error: string | null;
}

function lexicalScore(tokens: readonly string[], path: string, symbols: readonly string[]): number {
  const haystack = `${path} ${symbols.join(" ")}`.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return tokens.filter((token) => includesToken(haystack, token)).length;
}

const FACET_STOP_WORDS = new Set([
  "find",
  "implementation",
  "implementations",
  "code",
  "file",
  "files",
  "its",
  "them",
]);

function taskFacets(task: string): string[][] {
  const facets = task
    .split(/\s*(?:[,;]|\b(?:and|or)\b)\s*/i)
    .map((part) => taskTokens(part).filter((token) => !FACET_STOP_WORDS.has(token)))
    .filter((tokens) => tokens.length > 0);
  return facets.length > 1 ? facets.slice(0, 6) : [];
}

function diversify<T>(
  ordered: readonly T[],
  limit: number,
  facets: readonly string[][],
  candidateFor: (item: T) => Candidate,
  priorityFor: (item: T, facet: readonly string[]) => number,
): T[] {
  if (ordered.length <= limit || facets.length === 0) return ordered.slice(0, limit);
  const selected = new Set<T>();
  for (const facet of facets) {
    if (selected.size >= limit) break;
    let best: { item: T; overlap: number; priority: number; index: number } | null = null;
    for (const [index, item] of ordered.entries()) {
      if (selected.has(item)) continue;
      const candidate = candidateFor(item);
      const overlap = lexicalScore(facet, candidate.path, candidate.symbols);
      const priority = priorityFor(item, facet);
      if (
        overlap > 0 &&
        (!best ||
          priority > best.priority ||
          (priority === best.priority && overlap > best.overlap) ||
          (priority === best.priority && overlap === best.overlap && index < best.index))
      ) {
        best = { item, overlap, priority, index };
      }
    }
    if (best) selected.add(best.item);
  }
  for (const item of ordered) {
    if (selected.size >= limit) break;
    selected.add(item);
  }
  return ordered.filter((item) => selected.has(item));
}

function facetRolePriority(result: FindResult, facet: readonly string[]): number {
  const requestedRole = facet.some((token) => ["test", "tests", "testing", "spec", "specs"].includes(token))
    ? "test"
    : facet.some((token) => ["config", "configuration", "settings"].includes(token))
      ? "config"
      : facet.some((token) => ["doc", "docs", "documentation", "guide"].includes(token))
        ? "docs"
        : "implementation";
  if (result.metadata?.role === requestedRole) return 2;
  return requestedRole === "implementation" && result.metadata?.role === "caller" ? 1 : 0;
}

const SYMBOL =
  /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|def|fn|func|struct|trait|const)\s+\*?\s*([A-Za-z_$][\w$]{2,})/g;

async function inventory(source: WorkspaceSource, input: FindInput, tokens: string[]) {
  const all = await source.trackedFiles();
  const excluded: Exclusion[] = [];
  const candidates: Candidate[] = [];
  for (const path of all) {
    const kind = classifyPath(path);
    const reason =
      contentExclusionReason(kind) ??
      (kind === "lockfile" ? "lockfile" : kind === "generated" ? "generated file" : null) ??
      (input.paths && input.paths.length > 0 && !matchesAnyGlob(path, input.paths)
        ? "outside the requested paths"
        : null);
    if (reason) {
      if (reason !== "outside the requested paths") excluded.push({ id: `file:${path}`, path, reason });
      continue;
    }
    const bytes = await source.fileSize(path);
    if (bytes === null) {
      excluded.push({ id: `file:${path}`, path, reason: "deleted or not a regular file in the worktree" });
      continue;
    }
    const symbols: string[] = [];
    if (bytes <= FIND_POLICY.maxFileBytes && kind !== "documentation") {
      const file = await source.readLines(path, FIND_POLICY.maxFileBytes);
      if (file) {
        const head = file.lines.join("\n").slice(0, FIND_POLICY.symbolScanBytes);
        for (const match of head.matchAll(SYMBOL)) {
          if (!symbols.includes(match[1]!)) symbols.push(match[1]!);
          if (symbols.length >= FIND_POLICY.maxSymbols) break;
        }
      }
    }
    candidates.push({
      id: stableId("c", path, 8),
      path,
      language: languageForPath(path),
      kind,
      bytes,
      symbols,
      lexical: lexicalScore(tokens, path, symbols),
    });
  }
  return { tracked: all.length, candidates, excluded };
}

function metaFrame(task: string, shardItems: readonly Candidate[]) {
  const questions: Record<string, ReturnType<typeof score> | ReturnType<typeof choice>> = {};
  for (const candidate of shardItems) {
    questions[`relevance_${candidate.id}`] = score(
      {
        question: `Based only on its metadata, how relevant is candidate ${candidate.id} (${candidate.path}) to the task?`,
        guidance:
          "Judge relevance to the specific artifact requested, not keyword overlap. Reserve the highest level for metadata that identifies the primary requested artifact or behavior. A suggestive filename cannot establish unseen content.",
      },
      [...RELEVANCE_LEVELS],
    );
    questions[`role_${candidate.id}`] = choice(
      {
        question: `Based only on its metadata, what role would candidate ${candidate.id} (${candidate.path}) play for the task?`,
        guidance:
          "Classify the candidate's most likely role for the specific request. Do not treat a test, example, demo, or incidental wrapper as the primary implementation unless that is what the task asks to find. Use cannot_tell when metadata does not establish a role.",
      },
      {
        implementation: "Defines or coordinates the primary behavior requested by the task.",
        caller: "Uses or invokes the relevant behavior.",
        test: "Tests the relevant behavior.",
        config: "Configures the relevant behavior.",
        docs: "Documents the relevant behavior.",
        unrelated: "Has nothing to do with the task.",
        cannot_tell: "Metadata is not enough to tell.",
      },
    );
  }
  const keys = Object.keys(questions);
  return buildFrame<Map<string, MetaAnswer>>({
    template: "candidate_meta@2",
    scope: stableId(
      "shard",
      shardItems.map((item) => item.id),
    ),
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      task,
      candidates: shardItems.map((item) => ({
        id: item.id,
        path: item.path,
        language: item.language,
        kind: item.kind,
        bytes: item.bytes,
        symbols: item.symbols,
      })),
    },
    questions,
    provenance: shardItems.map((item) => ({
      kind: "file_metadata" as const,
      id: item.id,
      path: item.path,
      probe: "git-ls-files+symbol-scan@1",
      truncated: false,
    })),
    parse(answers) {
      expectKeys(answers, keys);
      return new Map(
        shardItems.map((item) => [
          item.id,
          {
            relevance: readScore(answers, `relevance_${item.id}`, 4),
            role: readChoice(answers, `role_${item.id}`, ROLES),
          },
        ]),
      );
    },
  });
}

interface Excerpt {
  startLine: number;
  endLine: number;
  totalLines: number;
  text: string;
}

function occurrences(text: string, value: string): number {
  let count = 0;
  let offset = 0;
  let found = text.indexOf(value, offset);
  while (found >= 0) {
    count++;
    offset = found + value.length;
    found = text.indexOf(value, offset);
  }
  return count;
}

function overlapsShown(start: number, end: number, shown: readonly Excerpt[]): boolean {
  return shown.some((excerpt) => start <= excerpt.endLine && end >= excerpt.startLine);
}

function bestExcerptStart(
  lines: readonly string[],
  tokens: readonly string[],
  span: number,
  shown: readonly Excerpt[],
): number | null {
  const maxStart = Math.max(1, lines.length - span + 1);
  const candidates = new Set<number>([1]);
  for (const [index, line] of lines.entries()) {
    const lower = line.toLowerCase();
    if (tokens.some((token) => includesToken(lower, token))) {
      candidates.add(Math.min(maxStart, Math.max(1, index + 1 - 20)));
    }
  }
  let best: { start: number; score: number } | null = null;
  for (const start of candidates) {
    const end = Math.min(lines.length, start + span - 1);
    if (overlapsShown(start, end, shown)) continue;
    const text = lines
      .slice(start - 1, end)
      .join("\n")
      .toLowerCase();
    const score = tokens.reduce((total, token) => {
      const count = Math.max(...tokenForms(token).map((form) => occurrences(text, form)));
      return total + (count > 0 ? 100 + Math.min(count, 20) : 0);
    }, 0);
    if (!best || score > best.score || (score === best.score && start < best.start)) best = { start, score };
  }
  if (best) return best.start;
  for (let start = 1; start <= lines.length; start += span) {
    const end = Math.min(lines.length, start + span - 1);
    if (!overlapsShown(start, end, shown)) return start;
  }
  return null;
}

async function readExcerpt(
  source: WorkspaceSource,
  redaction: RedactionPort,
  candidate: Candidate,
  tokens: string[],
  shown: readonly Excerpt[] = [],
): Promise<Excerpt | null> {
  const file = await source.readLines(candidate.path, FIND_POLICY.maxFileBytes);
  if (!file) return null;
  const total = file.lines.length;
  const span = total <= FIND_POLICY.wholeFileLines && shown.length === 0 ? total : FIND_POLICY.excerptLines;
  const start = bestExcerptStart(file.lines, tokens, span, shown);
  if (start === null) return null;
  const end = Math.min(total, start + span - 1);
  const text = file.lines
    .slice(start - 1, end)
    .map((line, offset) => `${start + offset}| ${line}`)
    .join("\n");
  return { startLine: start, endLine: end, totalLines: total, text: redaction.text(text).text };
}

function excerptFrame(task: string, candidate: Candidate, excerpt: Excerpt, priorRanges: string[]) {
  const questions = {
    relevance: score(
      {
        question: `How relevant is the shown excerpt of ${candidate.path} to the task?`,
        guidance:
          "Score the excerpt's centrality to the specific request, not mere mentions or shared terminology. When implementation is requested, callers, tests, examples, and adapters are supporting evidence rather than the primary artifact. Do not infer code outside the shown lines.",
      },
      [...RELEVANCE_LEVELS],
    ),
    target_definition_visible: noul(
      `Does the shown excerpt of ${candidate.path} define or coordinate the primary artifact or behavior requested by the task?`,
      {
        true: "The primary requested function, class, handler, configuration, or equivalent behavior is defined in the shown lines.",
        false:
          "The shown lines only mention, call, test, demonstrate, or otherwise support the primary requested artifact.",
      },
    ),
    relevant_content_cut_off: noul(
      `Does relevant content appear to continue beyond the shown lines of ${candidate.path}?`,
      {
        true: "The shown excerpt ends or starts in the middle of relevant code.",
        false: "The relevant content, if any, is fully shown.",
      },
    ),
    missing_evidence: choice(
      {
        question: "What evidence outside this excerpt is most needed for the task?",
        guidance:
          "Choose outside evidence only when it is necessary to establish this candidate's relevance or answer the task, not merely because related code exists. Choose none when the excerpt already establishes the candidate's role.",
      },
      {
        none: "The excerpt already establishes this candidate's role for the task.",
        caller: "A caller is necessary to establish how the shown code participates in the task.",
        callee: "A callee or import is necessary to establish what the shown code actually does.",
        configuration: "Controlling configuration is necessary to establish the relevant behavior.",
        tests: "Tests are necessary to establish the relevant behavior or contract.",
        cannot_tell: "Unclear what evidence would settle the candidate's role.",
      },
    ),
    untrusted_instruction_text: untrustedInstructionQuestion(),
  };
  const keys = Object.keys(questions);
  const ref: EvidenceRef = {
    kind: "file_range",
    id: `${candidate.path}:${excerpt.startLine}-${excerpt.endLine}`,
    path: candidate.path,
    startLine: excerpt.startLine,
    endLine: excerpt.endLine,
    probe: "read-excerpt@1",
    truncated: excerpt.startLine > 1 || excerpt.endLine < excerpt.totalLines,
  };
  return buildFrame<ExcerptAnswer>({
    template: "candidate_excerpt@2",
    scope: candidate.id,
    state: {
      evidencePolicy: EVIDENCE_POLICY,
      task,
      candidate: {
        id: candidate.id,
        path: candidate.path,
        language: candidate.language,
        totalLines: excerpt.totalLines,
        shownLines: `${excerpt.startLine}-${excerpt.endLine}`,
        previouslyShown: priorRanges,
        excerpt: excerpt.text,
      },
    },
    questions,
    provenance: [ref],
    parse(answers) {
      expectKeys(answers, keys);
      return {
        relevance: readScore(answers, "relevance", 4),
        targetVisible: readNoul(answers, "target_definition_visible"),
        cutOff: readNoul(answers, "relevant_content_cut_off"),
        missing: readChoice(answers, "missing_evidence", MISSING),
        untrusted: readNoul(answers, "untrusted_instruction_text"),
      };
    },
  });
}

export async function find(input: FindInput, options: RunOptions): Promise<Packet<FindResult>> {
  const task = requireTask(input.task);
  const readOnlyFallback = input.mode === "code_change_fallback";
  const top = Math.min(Math.max(input.top ?? 10, 1), 50);
  const maxFiles = input.maxFiles ?? 3000;
  const tokens = taskTokens(task);
  const facets = taskFacets(task);
  const inv = await inventory(options.dependencies.source, input, tokens);
  const run = await Run.start(FIND, options, {
    taskHash: hashValue(task),
    paths: input.paths ?? [],
    top,
    maxFiles,
    tracked: inv.tracked,
    mode: input.mode ?? "find",
  });
  const limits: string[] = readOnlyFallback ? [CODE_CHANGE_FALLBACK_NOTICE] : [];
  const findings: Finding[] = [];
  const parked: Parked[] = [];
  const gaps: string[] = [];
  for (const item of inv.excluded) run.setDisposition(item.id, "excluded");

  // Every candidate participates in metadata screening up to the policy file limit. Above that, a
  // deterministic lexical order decides who is screened and the rest are reported unjudged.
  const ordered = [...inv.candidates].sort((a, b) => b.lexical - a.lexical || a.path.localeCompare(b.path));
  const screened = ordered.slice(0, maxFiles);
  const unscreened = ordered.slice(maxFiles);
  if (unscreened.length > 0) {
    limits.push(
      `${unscreened.length} of ${ordered.length} candidates exceeded the policy file limit ${maxFiles} and were not screened (lowest lexical overlap first)`,
    );
  }
  const results = new Map<string, FindResult>();
  for (const candidate of ordered) {
    results.set(candidate.id, {
      rank: null,
      id: candidate.id,
      path: candidate.path,
      kind: candidate.kind,
      language: candidate.language,
      disposition: "unjudged",
      metadata: null,
      excerpt: null,
      relevance: null,
      probesRun: [],
      error: unscreened.includes(candidate) ? "not screened: policy file limit" : null,
    });
    run.setDisposition(candidate.id, "unjudged");
  }
  await run.candidates({ tracked: inv.tracked, candidates: ordered, excluded: inv.excluded });

  // Round 1: metadata shards in a seeded order so position bias is not tied to path order.
  const shuffled = seededShuffle(screened, `find:${hashValue(task)}`);
  const shards = shard(shuffled, FIND_POLICY.shardSize);
  const metaAnswers = new Map<string, MetaAnswer>();
  const shardRuns = await Promise.all(
    shards.map((items) =>
      withSplitting(items, async (subset) => {
        const outcome = await run.judge(metaFrame(task, subset));
        if (!outcome.ok && outcome.reason === "too_large") return { tooLarge: true };
        return { tooLarge: false, value: outcome };
      }),
    ),
  );
  for (const pieces of shardRuns) {
    for (const piece of pieces) {
      for (const candidate of piece.items) {
        const result = results.get(candidate.id)!;
        const outcome = piece.value;
        if (!outcome) {
          result.error = "metadata frame too large even for one candidate";
          result.disposition = "failed";
          run.setDisposition(candidate.id, "failed");
          continue;
        }
        if (!outcome.ok) {
          result.error = `${outcome.reason}: ${outcome.detail}`;
          const disposition = unjudgedOrFailed(outcome.reason);
          result.disposition = disposition;
          run.setDisposition(candidate.id, disposition);
          continue;
        }
        const answer = outcome.value.get(candidate.id)!;
        metaAnswers.set(candidate.id, answer);
        result.metadata = {
          highMass: massAtLeast(answer.relevance, 2),
          expected: round(answer.relevance.score),
          role: answer.role.choice,
          roleDistribution: roundedDistribution(answer.role.probabilities),
        };
        result.relevance = result.metadata.highMass;
        result.disposition = "judged";
        run.setDisposition(candidate.id, "judged");
      }
    }
  }

  // Round 2: bounded excerpts for accepted candidates only (fail open on recall).
  const accepted = screened
    .filter(
      (candidate) => (results.get(candidate.id)?.metadata?.highMass ?? 0) >= FIND_POLICY.acceptMetaHighMass,
    )
    .sort(
      (a, b) =>
        results.get(b.id)!.metadata!.expected - results.get(a.id)!.metadata!.expected ||
        results.get(b.id)!.metadata!.highMass - results.get(a.id)!.metadata!.highMass ||
        a.path.localeCompare(b.path),
    );
  const excerptLimit = Math.min(FIND_POLICY.maxExcerptCandidates, Math.max(top * 2, top));
  const toRead = diversify(
    accepted,
    excerptLimit,
    facets,
    (candidate) => candidate,
    (candidate, facet) => facetRolePriority(results.get(candidate.id)!, facet),
  );
  if (accepted.length > toRead.length) {
    limits.push(
      `${accepted.length - toRead.length} accepted candidates were ranked by metadata only (excerpt limit ${excerptLimit})`,
    );
  }
  const excerptTexts = new Map<string, string>();
  await Promise.all(
    toRead.map(async (candidate) => {
      const result = results.get(candidate.id)!;
      let excerpt = await readExcerpt(
        options.dependencies.source,
        options.dependencies.redaction,
        candidate,
        tokens,
      );
      if (!excerpt) {
        result.error = "excerpt unreadable (binary, too large, or missing)";
        return;
      }
      const shown: Excerpt[] = [];
      const ranges: string[] = [];
      let answer: ExcerptAnswer | null = null;
      for (let round_ = 0; round_ < 2 && excerpt; round_++) {
        const outcome = await run.judge(excerptFrame(task, candidate, excerpt, [...ranges]));
        shown.push(excerpt);
        ranges.push(`${excerpt.startLine}-${excerpt.endLine}`);
        result.probesRun.push(round_ === 0 ? "read-excerpt@1" : "read-next-region@1");
        if (!outcome.ok) {
          result.error = `excerpt ${outcome.reason}: ${outcome.detail}`;
          break;
        }
        answer = outcome.value;
        excerptTexts.set(
          candidate.id,
          [excerptTexts.get(candidate.id), excerpt.text].filter(Boolean).join("\n…\n"),
        );
        const moreExists =
          shown.reduce((total, item) => total + item.endLine - item.startLine + 1, 0) < excerpt.totalLines;
        if (round_ === 0 && answer.cutOff >= FIND_POLICY.cutOff && moreExists) {
          excerpt = await readExcerpt(
            options.dependencies.source,
            options.dependencies.redaction,
            candidate,
            tokens,
            shown,
          );
          continue;
        }
        break;
      }
      if (!answer) return;
      const highMass = massAtLeast(answer.relevance, 2);
      result.excerpt = {
        ranges,
        highMass,
        expected: round(answer.relevance.score),
        targetDefinitionVisible: round(answer.targetVisible),
        relevantContentCutOff: round(answer.cutOff),
        missingEvidence: decisiveLabel(answer.missing, FIND_POLICY.missingEvidence) ?? "uncertain",
      };
      result.relevance = highMass;
      const meta = metaAnswers.get(candidate.id);
      if (
        meta &&
        highMass >= FIND_POLICY.conflictHighMass &&
        meta.role.probabilities.unrelated >= FIND_POLICY.conflictUnrelated
      ) {
        result.disposition = "parked";
        run.setDisposition(candidate.id, "parked");
        parked.push({
          id: candidate.id,
          path: candidate.path,
          reason: "conflict: excerpt relevant vs metadata role unrelated",
        });
      }
      const missing = result.excerpt.missingEvidence;
      if (
        highMass >= FIND_POLICY.strongHighMass &&
        missing !== "none" &&
        missing !== "uncertain" &&
        missing !== "cannot_tell"
      ) {
        gaps.push(`${candidate.path}: ${missing} not shown`);
      }
      if (answer.untrusted >= UNTRUSTED_INSTRUCTION_THRESHOLD) {
        findings.push({
          flag: "untrusted_instruction_text",
          id: candidate.id,
          source: "jev",
          severity: "info",
          path: candidate.path,
          lines: ranges.join(","),
          detail: { p: round(answer.untrusted) },
        });
      }
      await run.decision(
        candidate.id,
        "candidate_excerpt",
        result.excerpt as unknown as JsonObject,
        FIND_POLICY.version,
      );
    }),
  );

  const ranked = [...results.values()]
    .filter(
      (result) =>
        result.relevance !== null &&
        result.relevance >= FIND_POLICY.acceptMetaHighMass &&
        result.disposition !== "parked",
    )
    .sort(
      (a, b) =>
        (b.excerpt?.expected ?? b.metadata?.expected ?? 0) -
          (a.excerpt?.expected ?? a.metadata?.expected ?? 0) ||
        b.relevance! - a.relevance! ||
        Number(b.excerpt !== null) - Number(a.excerpt !== null) ||
        a.path.localeCompare(b.path),
    );
  const candidatesById = new Map(ordered.map((candidate) => [candidate.id, candidate]));
  const selected = diversify(
    ranked,
    top,
    facets,
    (result) => candidatesById.get(result.id)!,
    facetRolePriority,
  );
  const shortlist = selected.map((result, index) => {
    result.rank = index + 1;
    if (input.includeExcerpts && excerptTexts.has(result.id)) {
      return {
        ...result,
        excerpt: result.excerpt ? { ...result.excerpt, text: excerptTexts.get(result.id)! } : null,
      };
    }
    return result;
  });
  const noStrongCandidate = !ranked.some((result) => (result.relevance ?? 0) >= FIND_POLICY.strongHighMass);
  if (noStrongCandidate && run.coverage().judged > 0) {
    findings.push({
      flag: "no_strong_candidate",
      id: "task",
      source: "policy",
      severity: "warn",
      detail: { note: "next step likely needs a new search string or different paths chosen by the host" },
    });
  }
  const parkedResults = [...results.values()].filter((result) => result.disposition === "parked");
  const failedResults = [...results.values()].filter((result) => result.disposition === "failed");
  return run.finish({
    findings: sortFindings(findings),
    parked,
    excluded: inv.excluded,
    limits,
    notChecked: [
      "this is a ranked shortlist, not an answer to the task",
      "untracked files are not candidates",
      "files were ranked by metadata unless an excerpt was read",
      "content beyond shown excerpt ranges",
      ...(readOnlyFallback ? ["implementation and bug fixing"] : []),
    ],
    results: [...shortlist, ...parkedResults, ...failedResults],
    summary: {
      task: { tokens: tokens.slice(0, 20), facets },
      tracked: inv.tracked,
      candidates: ordered.length,
      screened: screened.length,
      excerpted: toRead.length,
      ranked: ranked.length,
      returned: shortlist.length,
      noStrongCandidate,
      gaps,
      ...(readOnlyFallback
        ? { readOnlyFallback: { requested: "code_change", performed: "find", changedFiles: false } }
        : {}),
    },
  });
}
