/**
 * The public workflow contract and control-envelope validation.
 *
 * One contract covers built-in workflows and trusted repository workflow modules under `.stanley/workflows/`
 * (see docs/workflow-design-decisions.md):
 *
 *  - A workflow module default-exports an asynchronous factory. The host awaits it with an initialization
 *    context containing only `root`, `signal`, and structured `log`.
 *  - The workflow object requires only `id` and `run`. It may declare an `available` eligibility gate over
 *    deterministic routing facts and an asynchronous `cleanup`. It cannot declare CLI flags: everything a
 *    workflow needs to know comes from the natural-language request and its optional input.
 *  - Every other own enumerable field is JSON routing metadata; `instructions` is the documented convention.
 *  - `run` receives `{ request, input, root, prompt, judge, signal, log }` and returns text or JSON.
 *    A plain value becomes `{ status: "complete", output }`; returning `{ status, output }` sets the status.
 *  - `judge` asks Jev bounded fixed-choice questions about evidence the workflow supplies. It is the same
 *    primitive built-in workflows use: validated, redacted, and charged to the shared budget by the host.
 *
 * This module is pure: no filesystem, process, or module-loading access.
 */

import type { FrameFailure } from "./executor.ts";
import type { Questions } from "./questions.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import type { TypedAnswer } from "./validation.ts";

/**
 * Opaque workflow input or output: text or arbitrary JSON. Text is the `string` case of JsonValue, so both share
 * one type. The host does not interpret its contents.
 */
export type WorkflowValue = JsonValue;

export const WORKFLOW_STATUSES = ["complete", "incomplete", "budget_exhausted", "unsupported"] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowLogLevel = "debug" | "info" | "warn" | "error";

/** Structured log handed to workflows at initialization and at run time. */
export interface WorkflowLog {
  debug(message: string, data?: JsonValue): void;
  info(message: string, data?: JsonValue): void;
  warn(message: string, data?: JsonValue): void;
  error(message: string, data?: JsonValue): void;
}

/** One structured log record emitted by a workflow, attributed by the host to its source. */
export interface WorkflowLogRecord {
  readonly level: WorkflowLogLevel;
  readonly source: string;
  readonly message: string;
  readonly data?: JsonValue;
}

/** Initialization context: only canonical repository root, cancellation, and structured log. */
export interface WorkflowInitContext {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly log: WorkflowLog;
}

/** Workflow-agnostic result of a prompt. The selected workflow identity is never exposed. */
export interface PromptResult {
  readonly status: WorkflowStatus;
  readonly output: WorkflowValue;
}

/** Compose by intent through the router. Never names a target workflow. */
export type PromptFn = (instructions: string, input?: WorkflowValue) => Promise<PromptResult>;

/** One bounded Jev judgment: a short scope label, JSON evidence, and fixed-choice questions about it. */
export interface JudgeRequest {
  readonly scope: string;
  readonly state: JsonObject;
  readonly questions: Questions;
}

export type JudgeFailure = FrameFailure | "limit";

export type JudgeResult =
  | { readonly ok: true; readonly answers: Record<string, TypedAnswer>; readonly model: string }
  | { readonly ok: false; readonly reason: JudgeFailure; readonly detail: string };

/** Ask Jev about supplied evidence. Answers are validated against the questions; failures never throw. */
export type JudgeFn = (request: JudgeRequest) => Promise<JudgeResult>;

/** What the host has established deterministically about a request before Jev routes it. */
export const INPUT_SHAPES = ["none", "failure_log", "review_comments", "text"] as const;
export type InputShape = (typeof INPUT_SHAPES)[number];
export type DiffPresence = "present" | "absent";

export function isInputShape(value: unknown): value is InputShape {
  return INPUT_SHAPES.includes(value as InputShape);
}

export interface RoutingFacts {
  /** Whether the selected scope has a diff, counting safe untracked files the way workflows load them. */
  readonly diff: DiffPresence;
  /** What the supplied input looks like, if any. */
  readonly input: InputShape;
}

/** The run context: the request, optional input, and the host primitives. Nothing else is exposed. */
export interface WorkflowRunContext {
  readonly request: string;
  readonly input?: WorkflowValue;
  readonly root: string;
  readonly prompt: PromptFn;
  readonly judge: JudgeFn;
  readonly signal: AbortSignal;
  readonly log: WorkflowLog;
}

export const JUDGE_LIMITS = {
  /** Judge calls one workflow run may make; the shared request budget still applies underneath. */
  maxCallsPerRun: 64,
  maxQuestions: 8,
  maxStateBytes: 32 * 1024,
  maxScopeLength: 120,
} as const;

/** Runtime-validate a workflow's judge request: the host never sends unchecked shapes to Jev. */
export function validateJudgeRequest(value: unknown): JudgeRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowValidationError(`judge request must be an object (got ${describe(value)})`);
  }
  const { scope, state, questions } = value as Record<string, unknown>;
  if (typeof scope !== "string" || !scope.trim() || scope.length > JUDGE_LIMITS.maxScopeLength) {
    throw new WorkflowValidationError(
      `judge scope must be non-empty text of at most ${JUDGE_LIMITS.maxScopeLength} characters`,
    );
  }
  if (typeof state !== "object" || state === null || Array.isArray(state) || !isWorkflowValue(state)) {
    throw new WorkflowValidationError("judge state must be a JSON object");
  }
  if (JSON.stringify(state).length > JUDGE_LIMITS.maxStateBytes) {
    throw new WorkflowValidationError(`judge state must be at most ${JUDGE_LIMITS.maxStateBytes} bytes`);
  }
  if (typeof questions !== "object" || questions === null || Array.isArray(questions)) {
    throw new WorkflowValidationError("judge questions must be an object of questions");
  }
  const names = Object.keys(questions);
  if (names.length === 0 || names.length > JUDGE_LIMITS.maxQuestions) {
    throw new WorkflowValidationError(`judge needs between 1 and ${JUDGE_LIMITS.maxQuestions} questions`);
  }
  for (const name of names) {
    const question = (questions as Record<string, unknown>)[name];
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new WorkflowValidationError(`judge question names must be lowercase identifiers (got ${name})`);
    }
    if (
      typeof question !== "object" ||
      question === null ||
      Array.isArray(question) ||
      !isWorkflowValue(question)
    ) {
      throw new WorkflowValidationError(`judge question ${name} must be a JSON object`);
    }
    const { type, criteria } = question as Record<string, unknown>;
    if (type === "noul") continue;
    if (type === "choice") {
      if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
        throw new WorkflowValidationError(`judge question ${name}: choice criteria must be an object`);
      }
      const labels = Object.keys(criteria);
      if (labels.length < 2 || labels.some((label) => !/^[a-z][a-z0-9_]{0,63}$/.test(label))) {
        throw new WorkflowValidationError(
          `judge question ${name}: choice needs at least two lowercase identifier labels`,
        );
      }
      continue;
    }
    if (type === "score") {
      if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) {
        throw new WorkflowValidationError(`judge question ${name}: score criteria need 2 to 10 levels`);
      }
      continue;
    }
    throw new WorkflowValidationError(`judge question ${name}: type must be noul, choice, or score`);
  }
  return { scope: scope.trim(), state: state as JsonObject, questions: questions as Questions };
}

/**
 * A workflow. Only `id` and `run` are required control fields; `available` and `cleanup` are optional control
 * fields. Every other own, enumerable field must be JSON and is supplied to Jev as routing metadata.
 */
export interface Workflow {
  readonly id: string;
  /** Deterministic eligibility gate. A workflow without one is always eligible. */
  available?(facts: RoutingFacts): boolean;
  run(context: WorkflowRunContext): WorkflowValue | PromptResult | Promise<WorkflowValue | PromptResult>;
  /** Release resources created during initialization. */
  cleanup?(): Promise<void> | void;
  readonly [field: string]: unknown;
}

/** The default export of a workflow module. */
export type WorkflowFactory = (context: WorkflowInitContext) => Promise<Workflow>;

/** Workflow ids: lowercase, start with a letter, at most 64 characters of `a-z`, `0-9`, `_`, `-`. */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Fields the host interprets; they are never routing metadata. */
export const CONTROL_FIELDS: ReadonlySet<string> = new Set(["id", "run", "cleanup", "available"]);

/** A field workflows may not declare: the CLI surface is fixed, and workflows cannot add flags to it. */
export const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(["options"]);

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return JSON.stringify(value.length > 80 ? `${value.slice(0, 80)}…` : value);
  return typeof value;
}

/** Runtime-validate a workflow module's default export as a factory function. */
export function validateWorkflowFactory(value: unknown): WorkflowFactory {
  if (typeof value !== "function") {
    throw new WorkflowValidationError(
      `default export must be an async factory function (got ${describe(value)})`,
    );
  }
  return value as WorkflowFactory;
}

/**
 * Runtime-validate the workflow control envelope. Returns the original object so fields outside the control
 * envelope are preserved exactly. Throws WorkflowValidationError on violations.
 */
export function validateWorkflow(value: unknown): Workflow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkflowValidationError(`factory must resolve to a workflow object (got ${describe(value)})`);
  }
  const workflow = value as Record<string, unknown>;
  if (typeof workflow.id !== "string" || !WORKFLOW_ID_PATTERN.test(workflow.id)) {
    throw new WorkflowValidationError(
      `workflow.id must match ${WORKFLOW_ID_PATTERN} (got ${describe(workflow.id)})`,
    );
  }
  if (typeof workflow.run !== "function") {
    throw new WorkflowValidationError(`workflow.run must be a function (got ${describe(workflow.run)})`);
  }
  for (const field of ["cleanup", "available"]) {
    if (workflow[field] !== undefined && typeof workflow[field] !== "function") {
      throw new WorkflowValidationError(
        `workflow.${field} must be a function when present (got ${describe(workflow[field])})`,
      );
    }
  }
  for (const [field, metadata] of Object.entries(workflow)) {
    if (FORBIDDEN_FIELDS.has(field)) {
      throw new WorkflowValidationError(
        `workflow.${field} is not supported: workflows cannot declare CLI options; read the request and input instead`,
      );
    }
    if (CONTROL_FIELDS.has(field)) continue;
    if (!isWorkflowValue(metadata)) {
      throw new WorkflowValidationError(
        `workflow.${field} must be JSON routing metadata (got ${describe(metadata)})`,
      );
    }
  }
  return value as Workflow;
}

/** Collect all non-control fields exactly as the router should present them to Jev. */
export function workflowRoutingMetadata(workflow: Workflow): JsonObject {
  return Object.fromEntries(
    Object.entries(workflow).filter(([field]) => !CONTROL_FIELDS.has(field)),
  ) as JsonObject;
}

/** Whether a value is the `{ status, output }` envelope a workflow may return to set its own status. */
export function isPromptResult(value: unknown): value is PromptResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "output" || keys[1] !== "status") return false;
  const { status, output } = value as Record<string, unknown>;
  return WORKFLOW_STATUSES.includes(status as WorkflowStatus) && isWorkflowValue(output);
}

/** Validate and normalize one workflow return value into the prompt-result envelope. */
export function workflowResult(value: unknown): PromptResult {
  if (isPromptResult(value)) return value;
  if (!isWorkflowValue(value)) {
    throw new WorkflowValidationError(`workflow.run must return text or JSON (got ${describe(value)})`);
  }
  return { status: "complete", output: value };
}

/**
 * Whether a value is opaque text or JSON: strings, finite numbers, booleans, null, arrays, and plain objects
 * thereof, without cycles.
 */
export function isWorkflowValue(value: unknown): value is WorkflowValue {
  const active = new Set<object>();
  const visit = (current: unknown): boolean => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return true;
    if (typeof current === "number") return Number.isFinite(current);
    if (typeof current !== "object") return false;
    if (active.has(current)) return false;
    if (!Array.isArray(current)) {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) return false;
    }
    active.add(current);
    const ok = Array.isArray(current)
      ? current.every(visit)
      : Object.values(current as Record<string, unknown>).every(visit);
    active.delete(current);
    return ok;
  };
  return visit(value);
}

/** A structured workflow log that forwards attributed records to a host sink. */
export function createWorkflowLog(source: string, sink: (record: WorkflowLogRecord) => void): WorkflowLog {
  const emit =
    (level: WorkflowLogLevel) =>
    (message: string, data?: JsonValue): void => {
      sink(
        data === undefined
          ? { level, source, message: String(message) }
          : { level, source, message: String(message), data },
      );
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
