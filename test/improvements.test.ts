import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { createFakeAgent } from "../src/adapters/fake-agent.ts";
import { fakeChoice, fakeNoul } from "../src/adapters/fake-jev.ts";
import {
  CANDIDATE_DIRECTORY,
  type CandidateRoute,
  EXAMPLE_WORKFLOW,
  enqueueImprovement,
  IMPROVEMENT_DIRECTORY,
  listCandidates,
  PromotionError,
  pendingImprovements,
  promoteCandidate,
  readCandidate,
  runImprovementWorker,
  spawnImprovementWorker,
  workerRunning,
} from "../src/adapters/improvements.ts";
import { loadWorkflows, WORKFLOW_DIRECTORY } from "../src/adapters/workflows.ts";
import { runCli } from "../src/cli.ts";
import {
  createImprovementJob,
  IMPROVEMENT_LIMITS,
  type ImprovementJob,
  improvementInstructions,
  improvementJobId,
} from "../src/workflows/improve.ts";
import { fake, tempRepo } from "./helpers.ts";

const REQUEST = "Audit the TODO comments in this repository";
const RESERVED = ["find", "check", "summarize"];

const candidateWorkflow = (id = "todo_audit") => `export default async () => ({
  id: "${id}",
  instructions: "Use when the user asks to audit or list TODO comments in the repository.",
  examples: ["Audit the TODO comments"],
  async run({ request, judge }) {
    const verdict = await judge({
      scope: "todo",
      state: { request },
      questions: { stale: { type: "noul", instructions: "Is the TODO stale?" } },
    });
    return { text: "audited", data: { judged: verdict.ok, answer: verdict.ok ? verdict.answers.stale : null } };
  },
});
`;

/** A fake improvement agent that writes `files` (relative to the repository) when it runs. */
function writer(files: (id: string) => Record<string, string>, extra: Record<string, unknown> = {}) {
  return createFakeAgent((task) => {
    const match = /\.stanley\/candidates\/(imp_[0-9a-f]{12})/.exec(task.instructions);
    assert.ok(match, "instructions name the candidate directory");
    for (const [path, content] of Object.entries(files(match[1]!))) {
      mkdirSync(join(task.cwd, path, ".."), { recursive: true });
      writeFileSync(join(task.cwd, path), content);
    }
    return { text: "wrote the workflow", toolCalls: 2, ...extra };
  });
}

const worker = (
  root: string,
  agent: ReturnType<typeof createFakeAgent>,
  extra: Record<string, unknown> = {},
) => runImprovementWorker({ root, agent, reservedIds: RESERVED, log: () => {}, ...extra });

const list = (root: string, state: string) => {
  const directory = join(root, IMPROVEMENT_DIRECTORY, state);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
};

describe("improvement jobs", () => {
  test("ids are stable across trivial rephrasing and the brief names every contract the agent needs", () => {
    assert.equal(
      improvementJobId("Audit the TODO comments"),
      improvementJobId("  audit   THE todo comments "),
    );
    assert.notEqual(improvementJobId("a"), improvementJobId("b"));
    const job = createImprovementJob(REQUEST, "none", () => new Date("2026-09-18T00:00:00Z"));
    assert.match(job.id, /^imp_[0-9a-f]{12}$/);
    const brief = improvementInstructions(job, {
      candidateDirectory: `.stanley/candidates/${job.id}`,
      workflowDirectory: WORKFLOW_DIRECTORY,
      existingWorkflows: [".stanley/workflows/notes.ts"],
      reservedIds: RESERVED,
      exampleWorkflow: EXAMPLE_WORKFLOW,
    });
    for (const needle of [
      `.stanley/candidates/${job.id}/<workflow-id>.ts`,
      "judge({ scope, state, questions })",
      "prompt(instructions, input?)",
      ".stanley/workflows/notes.ts",
      "find, check, summarize",
      REQUEST,
      "write NO file",
      "stale_todo_audit",
    ]) {
      assert.ok(brief.includes(needle), needle);
    }
  });

  test("queues once per request and refuses duplicates, attempted requests, and a full queue", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob(REQUEST, "none");
      assert.equal(await enqueueImprovement(r.root, job), "queued");
      assert.equal(await enqueueImprovement(r.root, job), "already_queued");
      assert.deepEqual(await pendingImprovements(r.root), [job.id]);
      assert.equal(r.git("status", "--porcelain", "--untracked-files=all"), "");
      for (let index = 1; index < IMPROVEMENT_LIMITS.maxPendingJobs; index++) {
        assert.equal(
          await enqueueImprovement(r.root, createImprovementJob(`request ${index}`, "none")),
          "queued",
        );
      }
      assert.equal(await enqueueImprovement(r.root, createImprovementJob("one more", "none")), "queue_full");
    } finally {
      r.cleanup();
    }
  });

  test("concurrent exclusive creates in one process never collide on their temporary files", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      for (let round = 0; round < 5; round++) {
        const job = createImprovementJob(`race ${round}`, "none");
        const outcomes = await Promise.all(Array.from({ length: 8 }, () => enqueueImprovement(r.root, job)));
        assert.equal(outcomes.filter((outcome) => outcome === "queued").length, 1, outcomes.join(", "));
        assert.ok(outcomes.every((outcome) => outcome === "queued" || outcome === "already_queued"));
      }
      const pending = readdirSync(join(r.root, IMPROVEMENT_DIRECTORY, "pending"));
      assert.equal(pending.length, 5);
      assert.deepEqual(
        pending.filter((name) => !name.endsWith(".json")),
        [],
        "no temporary files are left behind",
      );
    } finally {
      r.cleanup();
    }
  });
});

describe("improvement worker", () => {
  test("runs a queued job, validates the agent's workflow with the workflow loader, and records a candidate", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const job = createImprovementJob(REQUEST, "none");
      await enqueueImprovement(r.root, job);
      const agent = writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/todo_audit.ts`]: candidateWorkflow() }));
      const checked: unknown[] = [];
      const summary = await worker(r.root, agent, {
        routeCheck: async (candidate: CandidateRoute, checkedJob: ImprovementJob) => {
          checked.push([
            candidate.id,
            candidate.routing,
            candidate.available({ diff: "absent", input: "none" }),
            checkedJob.request,
            checkedJob.inputShape,
          ]);
          return true;
        },
        log: undefined,
      });
      assert.deepEqual(summary, { ran: true, processed: [{ id: job.id, status: "validated" }] });
      // The router sees the job and the candidate's routing metadata (control fields excluded), not its code.
      assert.deepEqual(checked, [
        [
          "todo_audit",
          {
            instructions: "Use when the user asks to audit or list TODO comments in the repository.",
            examples: ["Audit the TODO comments"],
          },
          true,
          REQUEST,
          "none",
        ],
      ]);
      assert.equal(agent.calls[0]!.task.kind, "improve");
      assert.equal(agent.calls[0]!.options.timeoutMs, IMPROVEMENT_LIMITS.jobTimeoutMs);

      const record = await readCandidate(r.root, job.id);
      assert.ok(record);
      assert.equal(record.status, "validated");
      assert.equal(record.workflowId, "todo_audit");
      assert.equal(record.source, `${CANDIDATE_DIRECTORY}/${job.id}/todo_audit.ts`);
      assert.deepEqual(record.checks, {
        loaded: true,
        quarantined: [],
        duplicateId: false,
        outsideWrites: [],
        routing: "selected",
      });
      assert.deepEqual(record.reasons, []);
      assert.equal(record.summary, "wrote the workflow");
      assert.deepEqual(list(r.root, "pending"), []);
      assert.deepEqual(list(r.root, "active"), []);
      assert.deepEqual(list(r.root, "done"), [`${job.id}.json`]);
      const done = JSON.parse(
        readFileSync(join(r.root, IMPROVEMENT_DIRECTORY, "done", `${job.id}.json`), "utf8"),
      );
      assert.equal(done.attempts, 1);
      assert.equal(done.result.status, "validated");
      assert.ok(!existsSync(join(r.root, IMPROVEMENT_DIRECTORY, "worker.lock")));
      assert.match(readFileSync(join(r.root, IMPROVEMENT_DIRECTORY, "worker.log"), "utf8"), /validated imp_/);
      assert.equal((await listCandidates(r.root)).length, 1);
      assert.equal(r.git("status", "--porcelain", "--untracked-files=all"), "", "candidates stay out of Git");
      assert.equal(await enqueueImprovement(r.root, job), "already_attempted");
    } finally {
      r.cleanup();
    }
  });

  test("rejects candidates that write outside their directory, load nothing, fail validation, or collide", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const cases: Array<{
        request: string;
        files: (id: string) => Record<string, string>;
        expect: RegExp;
        check?: (record: NonNullable<Awaited<ReturnType<typeof readCandidate>>>) => void;
      }> = [
        {
          request: "outside",
          files: (id) => ({
            [`${CANDIDATE_DIRECTORY}/${id}/todo_audit.ts`]: candidateWorkflow("outside_writer"),
            "src/a.ts": "export const a = 2;\n",
            "src/new.ts": "export const n = 1;\n",
          }),
          expect: /outside the candidate directory: src\/a\.ts, src\/new\.ts/,
          check: (record) => assert.deepEqual(record.checks.outsideWrites, ["src/a.ts", "src/new.ts"]),
        },
        { request: "nothing", files: () => ({}), expect: /no loadable workflow/ },
        {
          request: "broken",
          files: (id) => ({
            [`${CANDIDATE_DIRECTORY}/${id}/broken.ts`]: "export default async () => ({ id: 'x'",
          }),
          expect: /quarantined/,
          check: (record) => assert.equal(record.checks.quarantined.length, 1),
        },
        {
          request: "duplicate",
          files: (id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/find.ts`]: candidateWorkflow("find") }),
          expect: /workflow id find is reserved or already registered/,
          check: (record) => assert.equal(record.checks.duplicateId, true),
        },
        {
          request: "two",
          files: (id) => ({
            [`${CANDIDATE_DIRECTORY}/${id}/one.ts`]: candidateWorkflow("one"),
            [`${CANDIDATE_DIRECTORY}/${id}/two.ts`]: candidateWorkflow("two"),
          }),
          expect: /more than one workflow/,
        },
      ];
      for (const { request, files, expect, check } of cases) {
        const job = createImprovementJob(request, "none");
        await enqueueImprovement(r.root, job);
        const summary = await worker(r.root, writer(files));
        assert.deepEqual(summary.processed, [{ id: job.id, status: "rejected" }], request);
        const record = await readCandidate(r.root, job.id);
        assert.ok(record, request);
        assert.equal(record.status, "rejected");
        assert.match(record.reasons.join("\n"), expect, request);
        check?.(record);
      }
      assert.equal(
        readFileSync(join(r.root, "src/a.ts"), "utf8"),
        "export const a = 2;\n",
        "never reverts user work",
      );
      assert.ok(existsSync(join(r.root, "src/new.ts")));

      const notSelected = createImprovementJob("unroutable", "none");
      await enqueueImprovement(r.root, notSelected);
      await worker(
        r.root,
        writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/todo_audit.ts`]: candidateWorkflow("unselected") })),
        { routeCheck: async () => false },
      );
      const record = await readCandidate(r.root, notSelected.id);
      assert.equal(record?.status, "rejected");
      assert.equal(record?.checks.routing, "not_selected");
    } finally {
      r.cleanup();
    }
  });

  test("retries once after an agent timeout, then records the attempt count", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob(REQUEST, "none");
      await enqueueImprovement(r.root, job);
      let calls = 0;
      const agent = createFakeAgent((task) => {
        calls++;
        if (calls === 1) return { outcome: "timeout" };
        const id = /imp_[0-9a-f]{12}/.exec(task.instructions)![0];
        mkdirSync(join(task.cwd, CANDIDATE_DIRECTORY, id), { recursive: true });
        writeFileSync(join(task.cwd, CANDIDATE_DIRECTORY, id, "todo_audit.ts"), candidateWorkflow());
        return { text: "second try" };
      });
      const summary = await worker(r.root, agent);
      assert.deepEqual(summary.processed, [
        { id: job.id, status: "requeued" },
        { id: job.id, status: "validated" },
      ]);
      const done = JSON.parse(
        readFileSync(join(r.root, IMPROVEMENT_DIRECTORY, "done", `${job.id}.json`), "utf8"),
      );
      assert.equal(done.attempts, 2);

      const stubborn = createImprovementJob("always fails", "none");
      await enqueueImprovement(r.root, stubborn);
      const failing = createFakeAgent(() => ({ outcome: "failed", detail: "no credentials" }));
      const second = await worker(r.root, failing);
      assert.deepEqual(
        second.processed.map((p) => p.status),
        ["requeued", "rejected"],
      );
      assert.equal(failing.calls.length, IMPROVEMENT_LIMITS.maxAttempts);
      assert.match(
        (await readCandidate(r.root, stubborn.id))?.reasons.join() ?? "",
        /agent failed: no credentials/,
      );
    } finally {
      r.cleanup();
    }
  });

  test("one worker per repository; stale locks and leases are recovered", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob(REQUEST, "none");
      await enqueueImprovement(r.root, job);
      const lock = join(r.root, IMPROVEMENT_DIRECTORY, "worker.lock");
      writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      assert.equal(await workerRunning(r.root), true);
      const agent = writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/todo_audit.ts`]: candidateWorkflow() }));
      assert.deepEqual(await worker(r.root, agent), { ran: false, reason: "locked", processed: [] });
      assert.equal(agent.calls.length, 0);

      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 1, startedAt: new Date().toISOString() }));
      assert.equal(await workerRunning(r.root), false);
      // A job abandoned by a dead worker: its lease names a pid that no longer exists.
      mkdirSync(join(r.root, IMPROVEMENT_DIRECTORY, "active"), { recursive: true });
      writeFileSync(
        join(r.root, IMPROVEMENT_DIRECTORY, "active", `${job.id}.json`),
        JSON.stringify({ ...job, attempts: 1, lease: { pid: 2 ** 22 - 1, until: "2020-01-01T00:00:00Z" } }),
      );
      const summary = await worker(r.root, agent);
      assert.equal(summary.ran, true);
      assert.deepEqual(
        summary.processed.map((p) => p.status),
        ["validated"],
      );
      assert.ok(!existsSync(lock));
    } finally {
      r.cleanup();
    }
  });

  test("the CLI routes a candidate on the job's input shape with its own gate, and refuses router labels", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const gated = `export default async () => ({
  id: "gated_audit",
  instructions: "Use when the user asks to audit supplied test failures for flaky tests.",
  available: (facts) => facts.input === "failure_log",
  async run() { return "audited"; },
});
`;
      const withLog = createImprovementJob("Audit these failures for flaky tests", "failure_log");
      const withoutLog = createImprovementJob("Audit for flaky tests", "none");
      const label = createImprovementJob("Claim the router label", "none");
      for (const job of [withLog, withoutLog, label])
        assert.equal(await enqueueImprovement(r.root, job), "queued");
      const files: Record<string, string> = {
        [withLog.id]: gated,
        [withoutLog.id]: gated,
        [label.id]: candidateWorkflow("cannot_tell"),
      };
      const agent = writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/candidate.ts`]: files[id]! }));
      const jev = fake((name, question) => {
        if (name !== "route" || question.type !== "choice") return undefined;
        const labels = Object.keys(question.criteria);
        return fakeChoice(labels, labels.includes("gated_audit") ? "gated_audit" : "cannot_tell", 0.9);
      });
      let stdout = "";
      const code = await runCli(
        ["--improve-worker", "--json"],
        {
          stdout: { write: (t: string) => (stdout += t) },
          stderr: { write: () => {} },
          stdin: Readable.from([""]),
          cwd: r.root,
          env: {},
        },
        { adapter: jev, agent },
      );
      assert.equal(code, 0);
      const processed = JSON.parse(stdout).processed as Array<{ id: string; status: string }>;
      const statusOf = (job: ImprovementJob) => processed.find((entry) => entry.id === job.id)?.status;
      assert.equal(statusOf(withLog), "validated");
      assert.equal(statusOf(withoutLog), "rejected");
      assert.equal(statusOf(label), "rejected");

      // The router saw each job's own input shape and the candidate's gate verdict on it.
      const contexts = jev.requests
        .filter((request) => request.questions.route !== undefined)
        .map((request) => request.state.context as { input: string; capabilities: Record<string, boolean> })
        .map((context) => [context.input, context.capabilities.gated_audit]);
      assert.deepEqual(contexts.sort(), [
        ["failure_log", true],
        ["none", false],
      ]);
      assert.equal((await readCandidate(r.root, withLog.id))?.checks.routing, "selected");
      const ungated = await readCandidate(r.root, withoutLog.id);
      assert.equal(ungated?.checks.routing, "not_selected");
      assert.match(ungated?.reasons.join("\n") ?? "", /router did not select/);

      // A candidate claiming the router's own label is rejected before it is ever offered to the router.
      const reserved = await readCandidate(r.root, label.id);
      assert.equal(reserved?.checks.duplicateId, true);
      assert.equal(reserved?.checks.routing, "skipped");
      assert.match(
        reserved?.reasons.join("\n") ?? "",
        /workflow id cannot_tell is reserved or already registered/,
      );
    } finally {
      r.cleanup();
    }
  });

  test("spawns a detached worker process that outlives the CLI", () => {
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    let unrefs = 0;
    const pid = spawnImprovementWorker({
      root: "/repo",
      cliPath: "/pkg/dist/cli.js",
      env: { X: "1" },
      spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { pid: 4242, unref: () => unrefs++ };
      }) as never,
    });
    assert.equal(pid, 4242);
    assert.equal(unrefs, 1);
    assert.equal(calls[0]!.command, process.execPath);
    assert.deepEqual(calls[0]!.args, ["/pkg/dist/cli.js", "--improve-worker", "--repo", "/repo"]);
    assert.equal(calls[0]!.options.detached, true);
    assert.equal(calls[0]!.options.stdio, "ignore");
    assert.deepEqual(calls[0]!.options.env, { X: "1" });
  });
});

describe("candidate promotion and the closed loop", () => {
  test("a promoted candidate handles the next matching request with deterministic code and Jev, not the agent", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const jev = fake((name, question) => {
        if (name === "stale") return fakeNoul(0.9);
        if (name !== "route" || question.type !== "choice") return undefined;
        const labels = Object.keys(question.criteria);
        return fakeChoice(labels, labels.includes("todo_audit") ? "todo_audit" : "cannot_tell", 0.9);
      });
      const io = (stdin = "") => {
        let stdout = "";
        let stderr = "";
        return {
          io: {
            stdout: { write: (t: string) => (stdout += t) },
            stderr: { write: (t: string) => (stderr += t) },
            stdin: Readable.from([stdin]),
            cwd: r.root,
            env: {},
          },
          out: () => ({ stdout, stderr }),
        };
      };

      // 1. The request is unsupported: the agent handles it and an improvement is queued.
      const delegating = createFakeAgent(() => ({ text: "Listed 3 TODOs by hand." }));
      const spawned: string[] = [];
      const first = io();
      const firstCode = await runCli([REQUEST, "--json", "--no-persist"], first.io, {
        adapter: jev,
        agent: delegating,
        spawnWorker: (root) => spawned.push(root),
      });
      assert.equal(firstCode, 0, first.out().stderr);
      assert.equal(JSON.parse(first.out().stdout).output.data.handledBy, "coding_agent");
      assert.equal(delegating.calls.length, 1);
      assert.equal(spawned.length, 1);
      const id = improvementJobId(REQUEST);
      assert.deepEqual(await pendingImprovements(r.root), [id]);

      // 2. The worker (normally the detached process) turns the request into a validated candidate.
      const improving = writer((jobId) => ({
        [`${CANDIDATE_DIRECTORY}/${jobId}/todo_audit.ts`]: candidateWorkflow(),
      }));
      const workerIo = io();
      const workerCode = await runCli(["--improve-worker", "--json"], workerIo.io, {
        adapter: jev,
        agent: improving,
      });
      assert.equal(workerCode, 0, workerIo.out().stderr);
      const report = JSON.parse(workerIo.out().stdout);
      assert.equal(report.schema, "stanley.improvement-worker/v1");
      assert.deepEqual(report.processed, [{ id, status: "validated" }]);
      assert.equal((await readCandidate(r.root, id))?.checks.routing, "selected");

      // 3. Nothing is active until a person promotes the candidate.
      const beforePromotion = io();
      await runCli([REQUEST, "--json", "--no-persist"], beforePromotion.io, {
        adapter: jev,
        agent: delegating,
        spawnWorker: () => {},
      });
      assert.equal(delegating.calls.length, 2, "still delegated while the candidate is only staged");
      assert.match(beforePromotion.out().stderr, /1 validated improvement candidate/);
      assert.match(beforePromotion.out().stderr, /already attempted/);

      const promotion = io();
      const promotionCode = await runCli(["--promote-candidate", id], promotion.io, {
        adapter: jev,
        agent: null,
      });
      assert.equal(promotionCode, 0, promotion.out().stderr);
      assert.match(
        promotion.out().stdout,
        /activated candidate .* as workflow todo_audit at \.stanley\/workflows\/todo_audit\.ts/,
      );
      assert.equal(
        r.git("status", "--porcelain", "--untracked-files=all"),
        "?? .stanley/workflows/todo_audit.ts\n",
      );
      assert.equal((await readCandidate(r.root, id))?.status, "promoted");

      // 4. The same request now runs the workflow: routing plus one bounded Jev judgment, no agent.
      const after = io();
      const afterCode = await runCli([REQUEST, "--json", "--no-persist"], after.io, {
        adapter: jev,
        agent: delegating,
        spawnWorker: () => assert.fail("no worker"),
      });
      assert.equal(afterCode, 0, after.out().stderr);
      const envelope = JSON.parse(after.out().stdout);
      assert.equal(envelope.status, "complete");
      assert.deepEqual(envelope.output, {
        text: "audited",
        data: { judged: true, answer: { type: "noul", probability: 0.9 } },
      });
      assert.equal(delegating.calls.length, 2, "the agent was not invoked");
      assert.equal(after.out().stderr, "");

      await assert.rejects(promoteCandidate(r.root, id, []), /is promoted, not validated/);
      await assert.rejects(promoteCandidate(r.root, "imp_000000000000", []), PromotionError);
      await assert.rejects(promoteCandidate(r.root, "../etc", []), /invalid candidate id/);
    } finally {
      r.cleanup();
    }
  });

  test("promotion refuses id collisions and existing destinations", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob(REQUEST, "none");
      await enqueueImprovement(r.root, job);
      await worker(
        r.root,
        writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/todo_audit.ts`]: candidateWorkflow() })),
      );
      await assert.rejects(promoteCandidate(r.root, job.id, ["todo_audit"]), /already registered/);
      r.write({
        [`${WORKFLOW_DIRECTORY}/todo_audit.ts`]: "export default async () => ({ id: 'other', run() {} });\n",
      });
      await assert.rejects(promoteCandidate(r.root, job.id, []), /already exists/);
      assert.equal((await readCandidate(r.root, job.id))?.status, "validated");
    } finally {
      r.cleanup();
    }
  });

  test("the shipped example workflow is the brief's reference and loads through the workflow loader", async () => {
    const root = join(import.meta.dirname, "..");
    assert.equal(
      readFileSync(join(root, "examples/workflows/stale-todo-audit.ts"), "utf8"),
      EXAMPLE_WORKFLOW,
    );
    const result = await loadWorkflows({ root, directory: "examples/workflows", warn: () => {} });
    assert.deepEqual(result.quarantined, []);
    assert.deepEqual(
      result.loaded.map(({ workflow }) => workflow.id),
      ["stale_todo_audit"],
    );
  });
});
