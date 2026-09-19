/**
 * The self-improvement model: after the agent fallback handles a request, Stanley queues a bounded attempt to
 * turn that kind of request into a reusable workflow. This module is pure: job and candidate records, the job
 * identity function, and the authoring brief handed to the improvement agent. Durable storage, the worker loop,
 * and candidate validation live in `adapters/improvements.ts`.
 */
import { stableId } from "../core/hash.ts";
import type { JsonObject } from "../core/types.ts";
import { type InputShape, isInputShape } from "../core/workflow.ts";
import type { AgentOutcome } from "./agent.ts";

export const IMPROVEMENT_JOB_SCHEMA = "stanley.improvement-job/v1";
export const CANDIDATE_SCHEMA = "stanley.candidate/v1";

export const IMPROVEMENT_LIMITS = {
  /** Attempts per job; a second attempt happens only after an agent timeout or crash. */
  maxAttempts: 2,
  /** Wall-clock limit for one improvement agent run. */
  jobTimeoutMs: 15 * 60_000,
  /** A claimed job whose lease is older than this is considered abandoned and re-queued. */
  leaseMs: 20 * 60_000,
  /** Queue depth cap; further fallbacks are handled but not queued. */
  maxPendingJobs: 20,
  /** Final agent text kept in candidate records. */
  maxSummaryBytes: 16 * 1024,
} as const;

export interface ImprovementJob {
  readonly schema: typeof IMPROVEMENT_JOB_SCHEMA;
  readonly id: string;
  /** The redacted request the fallback handled. */
  readonly request: string;
  /** Shape of any supplied input; the router sees the same fact when the candidate is checked. */
  readonly inputShape: InputShape;
  readonly source: "agent_fallback";
  readonly createdAt: string;
  readonly attempts: number;
}

export type CandidateStatus = "validated" | "rejected" | "promoted";

export interface CandidateChecks {
  /** The candidate directory contained exactly one loadable workflow. */
  readonly loaded: boolean;
  readonly quarantined: readonly string[];
  readonly duplicateId: boolean;
  /** Repository paths the agent changed outside its candidate directory. */
  readonly outsideWrites: readonly string[];
  /** Whether the router selected the candidate for the original request; `skipped` when not checked. */
  readonly routing: "selected" | "not_selected" | "skipped";
}

export interface CandidateRecord {
  readonly schema: typeof CANDIDATE_SCHEMA;
  readonly id: string;
  readonly status: CandidateStatus;
  readonly workflowId: string | null;
  /** Repository-relative path of the workflow file or package directory inside the candidate directory. */
  readonly source: string | null;
  readonly request: string;
  readonly createdAt: string;
  readonly checks: CandidateChecks;
  readonly reasons: readonly string[];
  readonly agent: { readonly outcome: AgentOutcome; readonly toolCalls: number; readonly durationMs: number };
  readonly summary: string;
}

/** Normalize a request so trivially different phrasings share one job. */
export function normalizeRequest(request: string): string {
  return request.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Stable job id derived from the request. */
export function improvementJobId(request: string): string {
  return stableId("imp", normalizeRequest(request), 12);
}

export function createImprovementJob(
  request: string,
  inputShape: InputShape,
  now: () => Date = () => new Date(),
): ImprovementJob {
  return {
    schema: IMPROVEMENT_JOB_SCHEMA,
    id: improvementJobId(request),
    request,
    inputShape,
    source: "agent_fallback",
    createdAt: now().toISOString(),
    attempts: 0,
  };
}

export function isImprovementJob(value: unknown): value is ImprovementJob {
  if (typeof value !== "object" || value === null) return false;
  const job = value as Record<string, unknown>;
  return (
    job.schema === IMPROVEMENT_JOB_SCHEMA &&
    typeof job.id === "string" &&
    /^imp_[0-9a-f]{12}$/.test(job.id) &&
    typeof job.request === "string" &&
    isInputShape(job.inputShape) &&
    job.source === "agent_fallback" &&
    typeof job.createdAt === "string" &&
    typeof job.attempts === "number"
  );
}

export interface ImprovementContext {
  /** Repository-relative directory the agent must write into. */
  readonly candidateDirectory: string;
  /** Repository-relative directory of active repository workflows, offered as examples. */
  readonly workflowDirectory: string;
  /** Repository-relative paths of currently active repository workflows. */
  readonly existingWorkflows: readonly string[];
  /** Workflow ids already taken by built-ins and repository workflows. */
  readonly reservedIds: readonly string[];
  /** Source of a complete reference workflow in the required shape (see `examples/workflows/`). */
  readonly exampleWorkflow: string;
}

/** The authoring brief for the improvement agent. */
export function improvementInstructions(job: ImprovementJob, context: ImprovementContext): string {
  const examples =
    context.existingWorkflows.length > 0
      ? [
          "Active workflows in this repository (read them as examples of the same API):",
          ...context.existingWorkflows.map((path) => `  - ${path}`),
        ]
      : [`There are no repository workflows yet under ${context.workflowDirectory}/.`];
  return [
    "You are improving Stanley, a Jev-first coding agent. Stanley just handled the request below by falling",
    "back to a general coding agent, which is slow and unverified. Your job: create ONE reusable Stanley",
    "workflow so future requests of this kind are handled by deterministic code plus bounded Jev judgment",
    "instead of an agent.",
    "",
    "Deliverable:",
    `- Write exactly one workflow file at ${context.candidateDirectory}/<workflow-id>.ts (create the directory if`,
    "  needed). Write nothing else anywhere. Do not modify, create, or delete any other file in the repository,",
    "  do not run git commands that change state, and do not run the `stanley` command.",
    "- If this kind of request cannot be turned into a bounded, reusable workflow (for example it needs",
    "  interactive judgment, external systems, or open-ended code generation), write NO file and explain why",
    "  in your final message.",
    "",
    "Workflow contract:",
    "- The module default-exports an async factory: `export default async ({ root, signal, log }) => workflow`.",
    "- The workflow object needs `id` (lowercase, /^[a-z][a-z0-9_-]{0,63}$/) and `async run(context)`.",
    "- Every other enumerable field must be JSON and is routing metadata Jev reads to decide when to select the",
    "  workflow. Use `instructions` (when to select it) and `examples` (sample requests), and make them",
    "  specific enough that the original request below would clearly select this workflow.",
    "- `run` receives `{ request, input, root, prompt, judge, signal, log }`:",
    "  - `judge({ scope, state, questions })` asks Jev bounded fixed-choice questions about JSON evidence you",
    "    supply. Question types: `noul` (a probability that a statement is true), `choice` (labeled criteria;",
    "    the answer has `choice`, `confidence`, and `probabilities`), and `score` (an ordered rubric). It",
    "    returns `{ ok: true, answers }` or `{ ok: false, reason }`; never assume it succeeded.",
    "  - `prompt(instructions, input?)` delegates a sub-request to whichever installed workflow fits.",
    "  - `run` returns text or JSON. Prefer `{ text, data }` with `data.notChecked` listing what was not done.",
    "- Design rule: deterministic code gathers bounded evidence and makes decisions with fixed thresholds; Jev",
    "  answers small fixed-choice questions; nothing free-form. Keep every loop bounded.",
    "- Workflows are trusted repository code and may use Node APIs, but must stay inside `root`, must never",
    "  write files unless the request is explicitly about writing, and must never claim completion they did",
    "  not verify.",
    `- The id must not be one of: ${context.reservedIds.join(", ")}.`,
    "",
    ...examples,
    "",
    "Reference workflow (complete, follows the required shape):",
    "```ts",
    context.exampleWorkflow.trimEnd(),
    "```",
    "",
    "The request Stanley could not handle:",
    job.request,
    `Supplied input shape: ${job.inputShape}`,
    "",
    "Finish with a short plain-text summary naming the file you wrote (or stating that you wrote none) and why.",
  ].join("\n");
}

/** Public, identity-free description of a candidate for CLI notices. */
export function describeCandidate(record: CandidateRecord): JsonObject {
  return {
    id: record.id,
    status: record.status,
    request: record.request,
    reasons: [...record.reasons],
  };
}
