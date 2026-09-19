import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import type { JevRequest } from "../src/core/types.ts";
import { find } from "../src/workflows/find.ts";
import { fake, options, tempRepo } from "./helpers.ts";

const ROLES = ["implementation", "caller", "test", "config", "docs", "unrelated", "cannot_tell"];
const MISSING = ["none", "caller", "callee", "configuration", "tests", "cannot_tell"];

function setup() {
  const files: Record<string, string> = {
    ".env": "TOKEN=abc",
    "package-lock.json": "{}",
    "src/webhooks/retry.ts": `// webhook delivery\nexport function scheduleRetry(event) {\n${Array.from({ length: 560 }, (_, i) => `  // step ${i}`).join("\n")}\n  return chargeOnce(event);\n}\n`,
    "src/billing/charge.ts": "export function chargeOnce(event) {\n  return event.id;\n}\n",
  };
  for (let index = 0; index < 43; index++)
    files[`src/misc/module${index}.ts`] = `export const value${index} = ${index};\n`;
  return tempRepo(files);
}

function candidatesIn(request: JevRequest) {
  return (request.state as { candidates?: Array<{ id: string; path: string }> }).candidates ?? [];
}

describe("find", () => {
  test("screens every candidate by metadata, reads excerpts only for accepted ones, and ranks them", async () => {
    const repo = setup();
    try {
      let excerptCalls = 0;
      const adapter = fake((name, _q, request) => {
        const candidates = candidatesIn(request);
        if (candidates.length > 0) {
          const id = name.replace(/^(relevance|role)_/, "");
          const path = candidates.find((candidate) => candidate.id === id)?.path ?? "";
          const relevant = path.includes("webhooks") || path.includes("billing");
          if (name.startsWith("relevance_")) return fakeScore(4, relevant ? 3 : 0, 0.8);
          return fakeChoice(ROLES, relevant ? "implementation" : "unrelated", 0.8);
        }
        const candidate = (request.state as { candidate: { path: string; previouslyShown: string[] } })
          .candidate;
        const retry = candidate.path.includes("webhooks");
        if (name === "relevance") return retry ? fakeScore(4, 3, 0.65) : fakeScore(4, 2, 0.95);
        if (name === "relevant_content_cut_off") {
          excerptCalls++;
          return fakeNoul(retry && candidate.previouslyShown.length === 0 ? 0.9 : 0.1);
        }
        if (name === "target_definition_visible") return fakeNoul(retry ? 0.9 : 0.4);
        if (name === "missing_evidence") return fakeChoice(MISSING, retry ? "callee" : "none", 0.7);
        return undefined;
      });
      const packet = await find(
        { task: "Webhook retries double-charge customers", top: 5, includeExcerpts: true },
        options(repo.root, adapter),
      );

      const metadataRequests = adapter.requests.filter((request) => candidatesIn(request).length > 0);
      const screened = metadataRequests.flatMap((request) =>
        candidatesIn(request).map((candidate) => candidate.path),
      );
      assert.equal(screened.length, 45, "every eligible tracked file is screened once");
      assert.ok(metadataRequests.every((request) => candidatesIn(request).length <= 20));
      assert.ok(!screened.includes(".env") && !screened.includes("package-lock.json"));
      assert.ok(
        metadataRequests.every((request) => !JSON.stringify(request.state).includes("step 1")),
        "no content in metadata frames",
      );

      assert.equal(packet.results[0]!.path, "src/webhooks/retry.ts");
      assert.equal(packet.results[0]!.rank, 1);
      assert.deepEqual(packet.results[0]!.probesRun, ["read-excerpt@1", "read-next-region@1"]);
      assert.equal(packet.results[0]!.excerpt!.ranges.length, 2);
      assert.ok(Number(packet.results[0]!.excerpt!.ranges[1]!.split("-")[0]) > 300);
      assert.ok(packet.results[0]!.excerpt!.text!.includes("scheduleRetry"));
      assert.equal(packet.results[1]!.path, "src/billing/charge.ts");
      assert.equal(excerptCalls, 3);
      assert.equal(packet.summary.noStrongCandidate, false);
      assert.deepEqual(packet.summary.gaps, ["src/webhooks/retry.ts: callee not shown"]);
      assert.ok(packet.excluded.some((item) => item.path === ".env"));
      assert.equal(packet.status, "complete");
    } finally {
      repo.cleanup();
    }
  });

  test("metadata order is seeded and independent of the adapter; no strong candidate is escalated", async () => {
    const repo = setup();
    try {
      const first = fake();
      const second = fake();
      const one = await find({ task: "unrelated task about fonts" }, options(repo.root, first));
      await find({ task: "unrelated task about fonts" }, options(repo.root, second));
      assert.deepEqual(
        first.requests.map((request) => candidatesIn(request).map((c) => c.id)),
        second.requests.map((request) => candidatesIn(request).map((c) => c.id)),
      );
      assert.equal(one.summary.noStrongCandidate, true);
      assert.ok(one.findings.some((finding) => finding.flag === "no_strong_candidate"));
      assert.equal(one.results.length, 0, "irrelevant candidates do not pad the shortlist");
    } finally {
      repo.cleanup();
    }
  });

  test("path filters and file limits are explicit", async () => {
    const repo = setup();
    try {
      const filtered = await find({ task: "charge", paths: ["src/billing/**"] }, options(repo.root, fake()));
      assert.equal(filtered.summary.candidates, 1);
      const limited = await find({ task: "charge", maxFiles: 10 }, options(repo.root, fake()));
      assert.equal(limited.coverage.complete, false);
      assert.ok(limited.limits[0]!.includes("policy file limit"));
    } finally {
      repo.cleanup();
    }
  });

  test("oversized metadata shards are split rather than dropped", async () => {
    const repo = setup();
    try {
      const adapter = fake();
      const splitting = {
        requests: adapter.requests,
        async ask(request: JevRequest, opts: { timeoutMs: number }) {
          if (candidatesIn(request).length > 5)
            throw Object.assign(new Error("max_tokens_exceeded"), { status: 400 });
          return adapter.ask(request, opts);
        },
      };
      const packet = await find({ task: "charge" }, options(repo.root, splitting as ReturnType<typeof fake>));
      assert.equal(packet.coverage.failed, 0);
      assert.equal(packet.coverage.unjudged, 0);
      const answered = adapter.requests.flatMap((request) => candidatesIn(request));
      assert.equal(new Set(answered.map((c) => c.id)).size, 45);
    } finally {
      repo.cleanup();
    }
  });

  test("failed candidates are returned with their errors", async () => {
    const repo = setup();
    try {
      const adapter = fake();
      let rejected = false;
      const failing = {
        requests: adapter.requests,
        async ask(request: JevRequest, opts: { timeoutMs: number }) {
          if (!rejected && candidatesIn(request).length > 0) {
            rejected = true;
            return { model: request.model, answers: {}, usage: { input_tokens: 1, output_tokens: 1 } };
          }
          return adapter.ask(request, opts);
        },
      };
      const packet = await find({ task: "charge" }, options(repo.root, failing));
      const failed = packet.results.filter((result) => result.disposition === "failed");
      assert.equal(failed.length, packet.coverage.failed);
      assert.ok(failed.length > 0);
      assert.ok(failed.every((result) => result.error));
    } finally {
      repo.cleanup();
    }
  });

  test("compound tasks reserve shortlist space for each requested facet", async () => {
    const files: Record<string, string> = {
      "src/session-store.ts": "export class PersistentSessionStore {}\n",
      "src/subagent-runtime.ts": "export class SubagentRuntime {}\n",
      "test/subagent-orchestration.test.ts": "test('subagent orchestration', () => {});\n",
    };
    for (let index = 0; index < 12; index++)
      files[`src/daemon-${index}.ts`] = `export class DaemonLifecycle${index} {}\n`;
    const repo = tempRepo(files);
    try {
      const adapter = fake((name, _question, request) => {
        const candidates = candidatesIn(request);
        if (candidates.length > 0) {
          const id = name.replace(/^(relevance|role)_/, "");
          const path = candidates.find((candidate) => candidate.id === id)?.path ?? "";
          if (name.startsWith("relevance_"))
            return fakeScore(4, path.includes("daemon") || path.startsWith("test/") ? 3 : 2, 0.9);
          return fakeChoice(ROLES, path.startsWith("test/") ? "test" : "implementation", 0.9);
        }
        const path = (request.state as { candidate: { path: string } }).candidate.path;
        if (name === "relevance") return fakeScore(4, path.includes("daemon") ? 3 : 2, 0.9);
        if (name === "target_definition_visible") return fakeNoul(0.9);
        if (name === "relevant_content_cut_off") return fakeNoul(0.1);
        if (name === "missing_evidence") return fakeChoice(MISSING, "none", 0.9);
        return undefined;
      });
      const packet = await find(
        {
          task: "Find session persistence, subagent orchestration, and daemon lifecycle",
          top: 3,
        },
        options(repo.root, adapter),
      );
      assert.ok(packet.results.some((result) => result.path === "src/session-store.ts"));
      assert.ok(packet.results.some((result) => result.path === "src/subagent-runtime.ts"));
      assert.ok(packet.results.some((result) => result.path.startsWith("src/daemon-")));
      assert.ok(!packet.results.some((result) => result.path.startsWith("test/")));
      assert.deepEqual(
        packet.results.map((result) => result.rank),
        [1, 2, 3],
      );

      const testsPacket = await find(
        { task: "Find session persistence and subagent tests", top: 2 },
        options(repo.root, adapter),
      );
      assert.ok(testsPacket.results.some((result) => result.path === "src/session-store.ts"));
      assert.ok(testsPacket.results.some((result) => result.path === "test/subagent-orchestration.test.ts"));
    } finally {
      repo.cleanup();
    }
  });
});
