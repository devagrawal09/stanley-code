import type { Budget } from "../core/budget.ts";
import { FrameExecutor } from "../core/executor.ts";
import { createFrame } from "../core/frame.ts";
import type { JevPort, JsonObject, TransportFailure } from "../core/types.ts";
import { readAnswers } from "../core/validation.ts";
import {
  JUDGE_LIMITS,
  type JudgeFn,
  validateJudgeRequest,
  WorkflowValidationError,
} from "../core/workflow.ts";
import type { RedactionPort } from "../workflows/ports.ts";

export interface WorkflowJudgeOptions {
  readonly jev: JevPort;
  readonly model: string;
  readonly sharedBudget: Budget;
  readonly redaction: Pick<RedactionPort, "json" | "message">;
  readonly classifyError: (error: unknown) => TransportFailure;
  readonly signal: AbortSignal;
  readonly concurrency?: number;
}

/**
 * The `judge` primitive handed to workflow runs: the same budgeted, validated, redacted frame executor built-ins
 * use, with a per-run call cap. Requests are validated before anything reaches Jev; answers are validated
 * against the questions asked; failures are returned, never thrown.
 */
export function createWorkflowJudge(options: WorkflowJudgeOptions): JudgeFn {
  const executor = new FrameExecutor({
    port: options.jev,
    model: options.model,
    budget: { requests: 200, inputTokens: 400_000, wallMs: 120_000 },
    sharedBudget: options.sharedBudget,
    signal: options.signal,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    retries: 1,
    timeoutMs: 30_000,
    prepare(request) {
      const state = options.redaction.json(request.state);
      const questions = options.redaction.json(request.questions as unknown as JsonObject);
      return {
        request: {
          ...request,
          state: state.value,
          questions: questions.value as unknown as typeof request.questions,
        },
        changes: state.count + questions.count,
      };
    },
    classifyError: options.classifyError,
    describeError: options.redaction.message,
  });
  let calls = 0;
  return async (value) => {
    let request: ReturnType<typeof validateJudgeRequest>;
    try {
      request = validateJudgeRequest(value);
    } catch (error) {
      if (error instanceof WorkflowValidationError)
        return { ok: false, reason: "invalid", detail: error.message };
      throw error;
    }
    calls++;
    if (calls > JUDGE_LIMITS.maxCallsPerRun) {
      return {
        ok: false,
        reason: "limit",
        detail: `at most ${JUDGE_LIMITS.maxCallsPerRun} judge calls per run`,
      };
    }
    const frame = createFrame({
      template: "workflow-judge@1",
      scope: request.scope,
      state: request.state,
      questions: request.questions,
      provenance: [],
      parse: (answers) => readAnswers(answers, request.questions),
    });
    const outcome = await executor.run(frame);
    if (!outcome.ok) return { ok: false, reason: outcome.reason, detail: outcome.detail };
    return { ok: true, answers: outcome.value, model: outcome.model };
  };
}
