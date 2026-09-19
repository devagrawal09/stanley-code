import { readFile } from "node:fs/promises";
import { join } from "node:path";

// A Stanley workflow: an async factory that returns { id, routing metadata..., run }.
export default async ({ root, log }) => ({
  id: "stale_todo_audit",
  // Routing metadata: Jev reads every JSON field to decide when to select this workflow.
  instructions:
    "Use when the user asks to audit, list, or review TODO or FIXME comments in the repository " +
    "and decide which are stale or still needed.",
  examples: ["Audit the TODO comments", "Which FIXME notes are stale?"],
  async run({ request, judge }) {
    // 1. Deterministic evidence gathering (bounded).
    const text = await readFile(join(root, "src/app.ts"), "utf8").catch(() => "");
    const todos = text
      .split("\n")
      .map((line, index) => ({ line: index + 1, text: line.trim() }))
      .filter((entry) => /\b(TODO|FIXME)\b/.test(entry.text))
      .slice(0, 20);
    log.info("todo candidates", { count: todos.length });

    // 2. Bounded Jev judgment: one small fixed-choice question per piece of evidence.
    const results = [];
    for (const todo of todos) {
      const verdict = await judge({
        scope: `src/app.ts:${todo.line}`,
        state: { request, comment: todo.text },
        questions: {
          stale: {
            type: "choice",
            instructions: "Is this TODO comment still actionable?",
            criteria: {
              actionable: "Describes concrete remaining work.",
              stale: "Refers to work that is clearly done or no longer relevant.",
              cannot_tell: "The comment alone does not say.",
            },
          },
        },
      });
      // 3. Code, not the model, decides using fixed thresholds.
      const answer = verdict.ok ? verdict.answers.stale : null;
      const label =
        answer && answer.type === "choice" && answer.probabilities[answer.choice] >= 0.7
          ? answer.choice
          : "parked";
      results.push({ line: todo.line, text: todo.text, label });
    }
    return {
      text: results.map((r) => `${r.label.padEnd(11)} src/app.ts:${r.line} ${r.text}`).join("\n"),
      data: { results, notChecked: ["only src/app.ts was scanned"] },
    };
  },
});
