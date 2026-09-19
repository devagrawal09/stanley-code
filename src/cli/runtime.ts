import {
  createWorkflowLog,
  isWorkflowValue,
  type JudgeFn,
  type PromptResult,
  type WorkflowLogRecord,
  WorkflowValidationError,
  type WorkflowValue,
  workflowResult,
} from "../core/workflow.ts";
import type { RegisteredWorkflow, WorkflowRegistry } from "./registry.ts";

export const PROMPT_LIMITS = { maxDepth: 8, maxChildCalls: 32 } as const;

export type FallbackReason = "unroutable" | "unavailable" | "cycle" | "depth" | "calls";

export interface WorkflowRuntimeOptions {
  readonly root: string;
  readonly registry: WorkflowRegistry;
  readonly signal: AbortSignal;
  readonly route: (
    request: string,
    input: WorkflowValue | undefined,
    excluded: ReadonlySet<string>,
  ) => Promise<string | null>;
  readonly fallback: (
    request: string,
    input: WorkflowValue | undefined,
    reason: FallbackReason,
  ) => Promise<PromptResult> | PromptResult;
  /** Builds the bounded `judge` primitive for one workflow run. Defaults to an always-unavailable judge. */
  readonly judge?: (workflow: RegisteredWorkflow) => JudgeFn;
  readonly log?: (record: WorkflowLogRecord) => void;
}

const noJudge: JudgeFn = async () => ({
  ok: false,
  reason: "unavailable",
  detail: "judge is not configured",
});

/**
 * Runs registered workflows, built-in and repository alike, and composes child prompts through the same
 * late-bound router. Every run, top-level or nested, sees only its request, its input, and the host primitives.
 */
export class WorkflowRuntime {
  private childCalls = 0;
  private readonly options: WorkflowRuntimeOptions;

  constructor(options: WorkflowRuntimeOptions) {
    this.options = options;
  }

  /** Execute an already-routed top-level workflow. */
  async run(id: string, request: string, input?: WorkflowValue): Promise<PromptResult> {
    validatePromptCall(request, input);
    return this.execute(id, request, input, [], 0);
  }

  private async execute(
    id: string,
    request: string,
    input: WorkflowValue | undefined,
    stack: readonly string[],
    depth: number,
  ): Promise<PromptResult> {
    this.options.signal.throwIfAborted();
    if (stack.includes(id)) return this.options.fallback(request, input, "cycle");
    const registered = this.options.registry.get(id);
    if (!registered) return this.options.fallback(request, input, "unavailable");

    const active = [...stack, id];
    const prompt = async (instructions: string, childInput?: WorkflowValue): Promise<PromptResult> => {
      validatePromptCall(instructions, childInput);
      this.options.signal.throwIfAborted();
      if (depth >= PROMPT_LIMITS.maxDepth) {
        return this.options.fallback(instructions, childInput, "depth");
      }
      this.childCalls++;
      if (this.childCalls > PROMPT_LIMITS.maxChildCalls) {
        return this.options.fallback(instructions, childInput, "calls");
      }
      const selected = await this.options.route(instructions, childInput, new Set(active));
      if (!selected) return this.options.fallback(instructions, childInput, "unroutable");
      return this.execute(selected, instructions, childInput, active, depth + 1);
    };

    const value = await registered.workflow.run({
      request,
      ...(input === undefined ? {} : { input }),
      root: this.options.root,
      prompt,
      judge: this.options.judge?.(registered) ?? noJudge,
      signal: this.options.signal,
      log: createWorkflowLog(registered.origin, this.options.log ?? (() => {})),
    });
    return workflowResult(value);
  }
}

function validatePromptCall(request: unknown, input: unknown): asserts request is string {
  if (
    typeof request !== "string" ||
    !request.trim() ||
    request.includes("\0") ||
    Buffer.byteLength(request) > 16 * 1024
  ) {
    throw new WorkflowValidationError(
      "prompt instructions must be non-empty text of at most 16384 bytes with no null bytes",
    );
  }
  if (input !== undefined && !isWorkflowValue(input)) {
    throw new WorkflowValidationError("prompt input must be text or JSON");
  }
}
