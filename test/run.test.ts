import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { createWorkflowDependencies } from "../src/adapters/dependencies.ts";
import { createFakeAdapter } from "../src/adapters/fake-jev.ts";
import { exitCodeFor } from "../src/cli/output.ts";
import { noul } from "../src/core/questions.ts";
import type { JevPort as JevAdapter } from "../src/core/types.ts";
import { expectKeys, readNoul } from "../src/core/validation.ts";
import { buildFrame, Run } from "../src/workflows/run.ts";
import { tempRepo } from "./helpers.ts";

const WORKFLOW = {
  name: "test-flow",
  version: 1,
  budget: { requests: 10, inputTokens: 100_000, wallMs: 60_000 },
};

function runOptions(root: string, adapter: JevAdapter, extra: Record<string, unknown> = {}) {
  return { root, dependencies: createWorkflowDependencies(root, adapter), persist: false, ...extra };
}

function frame(scope: string, state: Record<string, string> = { text: scope }) {
  return buildFrame<number>({
    template: "test@1",
    scope,
    state,
    questions: { yes: noul("Is it yes?") },
    provenance: [{ kind: "comment", id: scope, probe: "test", truncated: false }],
    parse(answers) {
      expectKeys(answers, ["yes"]);
      return readNoul(answers, "yes");
    },
  });
}

async function finish(run: Run) {
  return run.finish({
    findings: [],
    parked: [],
    excluded: [],
    limits: [],
    notChecked: ["test"],
    results: [],
    summary: {},
  });
}

describe("run executor", () => {
  test("frame IDs are stable and content-derived", () => {
    assert.equal(frame("a").id, frame("a").id);
    assert.notEqual(frame("a").id, frame("b").id);
    assert.match(frame("a").id, /^f_[0-9a-f]{16}$/);
  });

  test("retries transient failures within the cap, then succeeds", async () => {
    let calls = 0;
    const adapter: JevAdapter = {
      async ask(request) {
        calls++;
        if (calls < 3) throw Object.assign(new Error("service busy"), { status: 503 });
        return createFakeAdapter(() => ({ type: "noul", noul: 0.9 })).ask(request, { timeoutMs: 1000 });
      },
    };
    const run = await Run.start(WORKFLOW, runOptions("/tmp", adapter, { retries: 2 }), {});
    const outcome = await run.judge(frame("x"));
    assert.equal(outcome.ok, true);
    assert.equal(calls, 3);
    assert.equal(run.jevUsage().requests, 3);
    assert.equal(run.jevUsage().failedRequests, 2);
  });

  test("authentication failure stops further calls and yields an incomplete packet", async () => {
    let calls = 0;
    const adapter: JevAdapter = {
      async ask() {
        calls++;
        throw Object.assign(new Error("invalid key"), { status: 401 });
      },
    };
    const run = await Run.start(WORKFLOW, runOptions("/tmp", adapter, { concurrency: 1 }), {});
    const outcomes = await run.judgeAll([frame("a"), frame("b"), frame("c")]);
    for (const [index, outcome] of outcomes.entries()) {
      assert.equal(outcome.ok, false);
      run.setDisposition(String(index), outcome.ok ? "judged" : "unjudged");
    }
    assert.equal(calls, 1, "authentication failure must short-circuit later frames");
    const packet = await finish(run);
    assert.equal(packet.status, "incomplete");
    assert.equal(packet.jev.status, "unavailable");
    assert.equal(exitCodeFor(packet), 10);
  });

  test("invalid answers are rejected, not consumed", async () => {
    const adapter = createFakeAdapter(() => ({ type: "noul", noul: 7 }));
    const run = await Run.start(WORKFLOW, runOptions("/tmp", adapter, { retries: 0 }), {});
    const outcome = await run.judge(frame("x"));
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.reason, "invalid");
    assert.equal(run.jevUsage().invalidResponses, 1);
  });

  test("budget exhaustion is reported and stops requests", async () => {
    const adapter = createFakeAdapter(() => ({ type: "noul", noul: 0.5 }));
    const run = await Run.start(WORKFLOW, runOptions("/tmp", adapter, { budget: { requests: 2 } }), {});
    const outcomes = await run.judgeAll([frame("a"), frame("b"), frame("c")]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.ok),
      [true, true, false],
    );
    assert.equal(adapter.requests.length, 2);
    for (const [index, outcome] of outcomes.entries())
      run.setDisposition(String(index), outcome.ok ? "judged" : "unjudged");
    const packet = await finish(run);
    assert.equal(packet.status, "budget_exhausted");
    assert.equal(exitCodeFor(packet), 12);
    assert.ok(packet.limits.some((limit) => limit.includes("budget exhausted (requests)")));
  });

  test("identical frames are asked once per run", async () => {
    const adapter = createFakeAdapter(() => ({ type: "noul", noul: 0.5 }));
    const run = await Run.start(WORKFLOW, runOptions("/tmp", adapter), {});
    await Promise.all([run.judge(frame("same")), run.judge(frame("same"))]);
    assert.equal(adapter.requests.length, 1);
  });

  test("model defaults to jev-1.13.0 and honors explicit overrides", async () => {
    const adapter = createFakeAdapter();
    assert.equal((await Run.start(WORKFLOW, runOptions("/tmp", adapter), {})).model, "jev-1.13.0");
    assert.equal(
      (await Run.start(WORKFLOW, runOptions("/tmp", adapter, { model: "jev-9" }), {})).model,
      "jev-9",
    );
    assert.equal(
      (await Run.start(WORKFLOW, runOptions("/tmp", adapter, { model: "jev-2" }), {})).model,
      "jev-2",
    );
    await assert.rejects(Run.start(WORKFLOW, runOptions("/tmp", adapter, { model: "../evil" }), {}));
  });

  test("persisted artifacts are complete, private, and redacted", async () => {
    const repo = tempRepo({ "README.md": "x" });
    repo.write({ ".stanley/.gitignore": "*\n" });
    const secret = "tsk_test_ABCDEFGH12345678";
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = secret;
    try {
      const adapter = createFakeAdapter(() => ({ type: "noul", noul: 0.9 }));
      const run = await Run.start(WORKFLOW, runOptions(repo.root, adapter, { persist: true }), {
        note: `key ${secret}`,
      });
      const outcome = await run.judge(frame("x", { text: `leaked ${secret} and ghp_${"a".repeat(36)}` }));
      assert.equal(outcome.ok, true);
      run.setDisposition("x", "judged");
      await run.decision("x", "rule", "ok", "policy@1");
      const packet = await finish(run);
      assert.equal(packet.redactions, 2);
      const sent = JSON.stringify(adapter.requests[0]!.state);
      assert.ok(!sent.includes(secret) && !sent.includes("ghp_aaaa"), "secrets must not be sent");

      const directory = join(repo.root, packet.artifact!);
      const files = readdirSync(directory).sort();
      assert.deepEqual(files, [
        "decisions.ndjson",
        "frames.ndjson",
        "inputs.json",
        "manifest.json",
        "packet.json",
      ]);
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      for (const file of files) {
        assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600, file);
        const text = readFileSync(join(directory, file), "utf8");
        assert.ok(!text.includes(secret), `${file} contains the API key`);
        assert.ok(!text.includes("ghp_aaaa"), `${file} contains a token`);
      }
      const record = JSON.parse(readFileSync(join(directory, "frames.ndjson"), "utf8").trim());
      assert.equal(record.result, "ok");
      assert.equal(record.requestedModel, "jev-1.13.0");
      assert.equal(record.template, "test@1");
      const ignore = join(repo.root, ".stanley/.gitignore");
      assert.ok(existsSync(ignore));
      assert.equal(readFileSync(ignore, "utf8"), "*\n!workflows/\n!workflows/**\n");
      assert.equal(repo.git("status", "--porcelain"), "");
      repo.write({ ".stanley/workflows/example.ts": "export default async () => ({});\n" });
      assert.equal(
        repo.git("status", "--porcelain", "--untracked-files=all"),
        "?? .stanley/workflows/example.ts\n",
      );
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      repo.cleanup();
    }
  });
});
