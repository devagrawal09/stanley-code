import type { DiffPresence, InputShape, RoutingFacts } from "../core/workflow.ts";

export interface RoutingFactsSource {
  /** Facts for a new routing decision. The diff is loaded afresh so a workflow's own edits are seen. */
  forDecision(input: InputShape): Promise<RoutingFacts>;
  /**
   * Facts for the fallback explanation of the decision that immediately preceded it. Nothing runs between a
   * decision and its explanation, so the diff presence that decision loaded is reused instead of loading the
   * full diff again; with no prior decision, it is loaded once.
   */
  forExplanation(input: InputShape): Promise<RoutingFacts>;
}

/** Routing facts for one invocation, loading the diff once per routing decision rather than once per use. */
export function routingFactsSource(loadDiffPresence: () => Promise<DiffPresence>): RoutingFactsSource {
  let current: Promise<DiffPresence> | undefined;
  const facts = async (input: InputShape, diff: Promise<DiffPresence>): Promise<RoutingFacts> => ({
    diff: await diff,
    input,
  });
  return {
    forDecision(input) {
      current = loadDiffPresence();
      return facts(input, current);
    },
    forExplanation(input) {
      current ??= loadDiffPresence();
      return facts(input, current);
    },
  };
}
