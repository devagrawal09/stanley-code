import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRedaction } from "../src/adapters/dependencies.ts";
import { createFakeAdapter, fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { classifyError } from "../src/adapters/jev.ts";
import { createWorkflowJudge } from "../src/cli/judge.ts";
import { Budget } from "../src/core/budget.ts";
import { JUDGE_LIMITS, validateJudgeRequest } from "../src/core/workflow.ts";

const LIMITS = { requests: 500, inputTokens: 1_000_000, wallMs: 60_000 };

function judgeWith(adapter: ReturnType<typeof createFakeAdapter>, budget = new Budget(LIMITS)) {
  return createWorkflowJudge({
    jev: adapter,
    model: "jev-1.13.0",
    sharedBudget: budget,
    redaction: createRedaction(),
    classifyError,
    signal: new AbortController().signal,
  });
}

const questions = {
  stale: { type: "noul", instructions: "Is the comment stale?" },
  kind: { type: "choice", instructions: "Classify", criteria: { bug: "a bug", chore: "a chore" } },
  risk: { type: "score", instructions: "Risk", criteria: ["none", "low", "high"] },
} as const;

describe("workflow judge", () => {
  test("validates answers of every question type and redacts state before it is sent", async () => {
    const adapter = createFakeAdapter((name) =>
      name === "stale"
        ? fakeNoul(0.9)
        : name === "kind"
          ? fakeChoice(["bug", "chore"], "bug", 0.8)
          : fakeScore(3, 2, 1),
    );
    const judge = judgeWith(adapter);
    const token = `ghp_${"b".repeat(36)}`;
    const result = await judge({ scope: "src/a.ts:1", state: { comment: `TODO ${token}` }, questions });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.model, "jev-1.13.0");
    assert.deepEqual(Object.keys(result.answers), ["stale", "kind", "risk"]);
    assert.deepEqual(result.answers.stale, { type: "noul", probability: 0.9 });
    assert.equal(result.answers.kind?.type === "choice" && result.answers.kind.choice, "bug");
    assert.equal(result.answers.risk?.type === "score" && result.answers.risk.score, 2);
    assert.equal(adapter.requests.length, 1);
    assert.ok(!JSON.stringify(adapter.requests[0]!.state).includes(token), "state must be redacted");
  });

  test("rejects malformed requests before anything reaches Jev", async () => {
    const adapter = createFakeAdapter();
    const judge = judgeWith(adapter);
    for (const value of [
      null,
      { scope: "", state: {}, questions },
      { scope: "x", state: [], questions },
      { scope: "x", state: {}, questions: {} },
      { scope: "x", state: {}, questions: { Bad: { type: "noul" } } },
      { scope: "x", state: {}, questions: { q: { type: "choice", criteria: { only: "one" } } } },
      { scope: "x", state: {}, questions: { q: { type: "score", criteria: ["one"] } } },
      { scope: "x", state: {}, questions: { q: { type: "essay" } } },
      { scope: "x", state: { f: () => 1 }, questions },
    ]) {
      const result = await judge(value as never);
      assert.ok(!result.ok && result.reason === "invalid", JSON.stringify(value));
    }
    assert.equal(adapter.requests.length, 0);
    assert.throws(() => validateJudgeRequest({ scope: "x".repeat(200), state: {}, questions }), /scope/);
  });

  test("invalid model answers become failures, never thrown errors", async () => {
    const adapter = createFakeAdapter((name) =>
      name === "kind" ? fakeChoice(["bug", "chore"], "nope", 0.8) : undefined,
    );
    const result = await judgeWith(adapter)({ scope: "x", state: {}, questions });
    assert.ok(!result.ok && result.reason === "invalid");
  });

  test("shares the invocation budget and caps calls per run", async () => {
    const budget = new Budget({ ...LIMITS, requests: 1 });
    const judge = judgeWith(createFakeAdapter(), budget);
    assert.ok((await judge({ scope: "a", state: {}, questions })).ok);
    const denied = await judge({ scope: "b", state: {}, questions });
    assert.ok(!denied.ok && denied.reason === "budget");
    assert.equal(budget.exhausted, "requests");

    const capped = judgeWith(createFakeAdapter());
    let last: Awaited<ReturnType<typeof capped>> | undefined;
    for (let index = 0; index <= JUDGE_LIMITS.maxCallsPerRun; index++) {
      last = await capped({ scope: `call-${index}`, state: {}, questions });
    }
    assert.ok(last && !last.ok && last.reason === "limit");
  });
});
