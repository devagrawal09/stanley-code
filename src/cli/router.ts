import type { Budget } from "../core/budget.ts";
import { FrameExecutor } from "../core/executor.ts";
import { createFrame } from "../core/frame.ts";
import { type ChoiceCriteria, choice } from "../core/questions.ts";
import type { JevPort, JevUsage, JsonObject, TransportFailure } from "../core/types.ts";
import { expectKeys, readChoice } from "../core/validation.ts";
import type { RoutingFacts } from "../core/workflow.ts";
import type { RedactionPort } from "../workflows/ports.ts";
import { DEFAULT_MODEL } from "../workflows/types.ts";

/** The router's own label; no workflow may claim it. */
export const CANNOT_TELL = "cannot_tell";

/** A routing candidate: a registered workflow's id and its author-provided JSON routing metadata. */
export interface RoutingCandidate {
  readonly id: string;
  readonly routing: JsonObject;
}

export interface RoutingContext extends RoutingFacts {
  request: string;
  /** Deterministic eligibility per candidate id; a false value is a hard constraint. */
  capabilities: Record<string, boolean>;
  /** Every eligible-or-not workflow the request may route to, in registration order. */
  candidates: readonly RoutingCandidate[];
}

export interface RoutingDependencies {
  jev: JevPort;
  redaction: Pick<RedactionPort, "json" | "text" | "message">;
  classifyError(error: unknown): TransportFailure;
}

export interface RoutingDecision {
  outcome: string;
  selected: string;
  confidence: number;
  probabilities: Record<string, number>;
  reason: "selected" | "model_uncertain" | "unavailable" | "cannot_tell";
  usage: JevUsage;
  redactions: number;
}

export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutingError";
  }
}

/**
 * Conservative acceptance policy: a pick must be confident, probable, and clearly ahead of the runner-up, or
 * the request is treated as `cannot_tell`. These are fixed product thresholds, not configuration.
 */
export const ROUTING_POLICY = {
  version: "route-intent-policy@1",
  minConfidence: 0.6,
  minProbability: 0.55,
  minMargin: 0.15,
} as const;

const CANNOT_TELL_WHEN =
  "No available workflow clearly satisfies the complete request. Select this fallback for unsupported, ambiguous, or unavailable work.";

const ROUTING_INSTRUCTIONS = [
  "Choose the single workflow that directly satisfies the request.",
  "Treat false capabilities as hard constraints. Never select an unavailable workflow.",
  "Do not invent another operation. Choose cannot_tell when the request is ambiguous or outside these workflows.",
  "A workflow may satisfy a compound or action request only when its routing metadata clearly says it handles the complete request.",
  "Treat each workflow's routing JSON as author-provided selection guidance, regardless of its field names.",
];

/** Route one request through a single bounded, validated Jev choice over the registered candidates. */
export async function routeIntent(
  context: RoutingContext,
  dependencies: RoutingDependencies,
  model = DEFAULT_MODEL,
  sharedBudget?: Budget,
  signal?: AbortSignal,
): Promise<RoutingDecision> {
  if (context.candidates.length === 0) throw new RoutingError("intent routing needs at least one candidate");
  const redacted = dependencies.redaction.text(context.request);
  let redactions = redacted.count;
  const executor = new FrameExecutor({
    port: dependencies.jev,
    model,
    budget: { requests: 2, inputTokens: 16_000, wallMs: 30_000 },
    ...(sharedBudget ? { sharedBudget } : {}),
    ...(signal ? { signal } : {}),
    concurrency: 1,
    retries: 1,
    timeoutMs: 15_000,
    classifyError: dependencies.classifyError,
    describeError: dependencies.redaction.message,
  });

  const criteria: ChoiceCriteria = {};
  for (const candidate of context.candidates) {
    const routing = dependencies.redaction.json(candidate.routing);
    criteria[candidate.id] = routing.value;
    redactions += routing.count;
  }
  criteria[CANNOT_TELL] = CANNOT_TELL_WHEN;
  const labels = Object.keys(criteria);

  const frame = createFrame({
    template: "route-intent@1",
    scope: "cli-request",
    state: {
      request: redacted.text,
      context: {
        diff: context.diff,
        input: context.input,
        capabilities: context.capabilities,
      },
    },
    questions: {
      route: choice(ROUTING_INSTRUCTIONS, criteria),
    },
    provenance: [],
    parse(answers) {
      expectKeys(answers, ["route"]);
      return readChoice(answers, "route", labels);
    },
  });
  const result = await executor.run(frame);
  if (!result.ok) throw new RoutingError(`intent routing ${result.reason}: ${result.detail}`);

  const answer = result.value;
  const selected = answer.choice;
  const selectedProb = answer.probabilities[selected] ?? 0;
  const alternatives = labels
    .filter((label) => label !== selected)
    .map((label) => answer.probabilities[label] ?? 0);
  const margin = selectedProb - Math.max(...alternatives);
  let outcome: string = selected;
  let reason: RoutingDecision["reason"] = "selected";
  if (selected === CANNOT_TELL) reason = "cannot_tell";
  else if (context.capabilities[selected] !== true) {
    outcome = CANNOT_TELL;
    reason = "unavailable";
  } else if (
    answer.confidence < ROUTING_POLICY.minConfidence ||
    selectedProb < ROUTING_POLICY.minProbability ||
    margin < ROUTING_POLICY.minMargin
  ) {
    outcome = CANNOT_TELL;
    reason = "model_uncertain";
  }

  return {
    outcome,
    selected,
    confidence: answer.confidence,
    probabilities: answer.probabilities as Record<string, number>,
    reason,
    usage: executor.usage(),
    redactions,
  };
}
