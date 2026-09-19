/**
 * Coding-agent port and the delegation fallback built on it.
 *
 * Stanley is Jev-first: deterministic code plus bounded Jev judgment is the hot path. A general coding agent is
 * the fallback for requests no installed workflow supports. This module declares the port (`CodingAgentPort`)
 * and turns an agent run into a truthful, workflow-neutral `PromptResult`. `adapters/pi.ts` implements the port
 * with Pi; `adapters/fake-agent.ts` implements it deterministically for tests.
 */
import type { JsonObject } from "../core/types.ts";
import type { PromptResult } from "../core/workflow.ts";
import type { RedactionPort } from "./ports.ts";

export type AgentTaskKind = "delegate" | "improve";

export interface AgentTask {
  readonly kind: AgentTaskKind;
  /**
   * Complete instructions for the agent, sent verbatim. The agent runs with the user's own privileges and
   * environment and needs the exact task; redaction applies to what comes back (agent text, job and
   * candidate records), not to what goes in. See docs/decision-log.md, D-14.
   */
  readonly instructions: string;
  /** Repository root the agent works in. */
  readonly cwd: string;
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  /** Hard wall-clock limit; the adapter terminates the agent when it elapses. */
  readonly timeoutMs: number;
}

export type AgentOutcome = "finished" | "failed" | "timeout" | "aborted";

export interface AgentRunResult {
  readonly outcome: AgentOutcome;
  /** The agent's final message, bounded by the adapter. Empty when it produced none. */
  readonly text: string;
  readonly exitCode: number | null;
  readonly durationMs: number;
  /** Tool executions the adapter observed; a coarse effort measure for diagnostics. */
  readonly toolCalls: number;
  /** Adapter-level failure detail (bounded, redacted by the caller before display). */
  readonly detail?: string;
}

/** A general coding agent behind a port. Implementations own process, credential, and cancellation handling. */
export interface CodingAgentPort {
  /** Adapter name for diagnostics and records only; it never appears in public output. */
  readonly name: string;
  run(task: AgentTask, options: AgentRunOptions): Promise<AgentRunResult>;
}

export const AGENT_LIMITS = {
  /** Default wall-clock limit for one delegated task. */
  defaultTimeoutMs: 10 * 60_000,
  maxTimeoutMs: 60 * 60_000,
  /** Final agent text kept in results and records. */
  maxTextBytes: 64 * 1024,
  maxInstructionBytes: 128 * 1024,
} as const;

export const DELEGATION_NOT_CHECKED = [
  "Stanley did not verify the agent's work: run tests and review the diff before relying on it",
  "no deterministic or Jev workflow handled this request; it was delegated to a general coding agent",
] as const;

/** The instructions handed to the agent for a delegated request. */
export function delegationInstructions(request: string, input: string | null): string {
  const lines = [
    "You are completing a task that Stanley delegated to you because none of its installed workflows",
    "supports it. Work inside the current repository only.",
    "",
    "Rules:",
    "- Do the task described below and nothing more.",
    "- Do not commit, push, deploy, or modify anything outside this repository.",
    "- Do not create or edit files under .stanley/; Stanley manages that directory.",
    "- Do not run the `stanley` command.",
    "- Finish with a short plain-text summary: what you changed (file paths), what you verified, and what you",
    "  could not do. Be explicit if the task was not completed.",
    "",
    "Task:",
    request.trim(),
  ];
  if (input?.trim()) lines.push("", "Supplied input:", input.trimEnd());
  return lines.join("\n");
}

/**
 * Project an agent run into the workflow-neutral result envelope. The status is truthful about what is known:
 * `complete` only means the agent finished its turn, never that Stanley verified the outcome.
 */
export function delegationResult(
  result: AgentRunResult,
  redaction: Pick<RedactionPort, "text">,
  /** Host-observed caveats to add to `notChecked`, for example a guarded workflow-directory change. */
  caveats: readonly string[] = [],
): PromptResult {
  const status = result.outcome === "finished" ? "complete" : "incomplete";
  const redacted = redaction.text(result.text.slice(0, AGENT_LIMITS.maxTextBytes));
  const headline =
    result.outcome === "finished"
      ? "complete - handled by an external coding agent; Stanley did not verify the result"
      : `incomplete - the external coding agent ${describeOutcome(result.outcome)}; review the repository state`;
  const summary = redacted.text.trim();
  const notChecked = [...DELEGATION_NOT_CHECKED, ...caveats.map((note) => redaction.text(note).text)];
  const data: JsonObject = {
    handledBy: "coding_agent",
    outcome: result.outcome,
    toolCalls: result.toolCalls,
    durationMs: result.durationMs,
    summary,
    notChecked,
    ...(result.detail === undefined ? {} : { detail: redaction.text(result.detail.slice(0, 2_000)).text }),
  };
  const text = [headline, "", summary || "(the agent produced no final summary)", "", "not checked:"]
    .concat(notChecked.map((note) => `  - ${note}`))
    .join("\n");
  return { status, output: { text, data } };
}

function describeOutcome(outcome: AgentOutcome): string {
  switch (outcome) {
    case "timeout":
      return "was stopped at the time limit";
    case "aborted":
      return "was cancelled";
    case "failed":
      return "exited with an error";
    case "finished":
      return "finished";
  }
}
