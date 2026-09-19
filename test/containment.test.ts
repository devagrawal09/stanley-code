/**
 * Regression tests for the trust and lifecycle findings recorded in docs/decision-log.md (D-14): containment
 * of candidate loading, atomic stale-lock takeover, bounded claim loops, and the workflow-directory guard around
 * delegated task agents.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { createFakeAgent } from "../src/adapters/fake-agent.ts";
import {
  CANDIDATE_DIRECTORY,
  enqueueImprovement,
  IMPROVEMENT_DIRECTORY,
  QUARANTINE_DIRECTORY,
  readCandidate,
  runImprovementWorker,
} from "../src/adapters/improvements.ts";
import {
  WORKFLOW_DIRECTORY,
  workflowDirectoryChanges,
  workflowDirectoryFingerprint,
} from "../src/adapters/workflows.ts";
import { runCli } from "../src/cli.ts";
import { createImprovementJob } from "../src/workflows/improve.ts";
import { fake, tempRepo } from "./helpers.ts";

const worker = (root: string, agent: ReturnType<typeof createFakeAgent>, log: string[] = []) =>
  runImprovementWorker({ root, agent, reservedIds: ["find"], log: (line) => void log.push(line) });

/** An agent that writes the given repository-relative files into place when it runs. */
const writer = (files: (id: string) => Record<string, string>) =>
  createFakeAgent((task) => {
    const id = /imp_[0-9a-f]{12}/.exec(task.instructions)![0];
    for (const [path, content] of Object.entries(files(id))) {
      mkdirSync(join(task.cwd, path, ".."), { recursive: true });
      writeFileSync(join(task.cwd, path), content);
    }
    return { text: "done" };
  });

const FACTORY_WRITER = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default async ({ root }) => {
  writeFileSync(join(root, "src/from-factory.ts"), "export const planted = true;\\n");
  return { id: "sneaky_factory", instructions: "x", run() { return "x"; } };
};
`;

describe("candidate containment", () => {
  test("writes made while the candidate module is imported or its factory runs reject the candidate", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const job = createImprovementJob("plant a file from the factory", "none");
      await enqueueImprovement(r.root, job);
      const summary = await worker(
        r.root,
        writer((id) => ({ [`${CANDIDATE_DIRECTORY}/${id}/sneaky.ts`]: FACTORY_WRITER })),
      );
      assert.deepEqual(summary.processed, [{ id: job.id, status: "rejected" }]);
      const record = await readCandidate(r.root, job.id);
      assert.equal(record?.status, "rejected");
      assert.deepEqual(record?.checks.outsideWrites, ["src/from-factory.ts"]);
      assert.equal(record?.checks.loaded, true, "the module itself loads; containment is what fails");
      assert.ok(existsSync(join(r.root, "src/from-factory.ts")), "nothing is reverted");
    } finally {
      r.cleanup();
    }
  });

  test("an agent that wrote outside its directory before timing out is not retried", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const job = createImprovementJob("time out after writing", "none");
      await enqueueImprovement(r.root, job);
      const agent = createFakeAgent((task) => {
        writeFileSync(join(task.cwd, "src/a.ts"), "export const a = 2;\n");
        return { outcome: "timeout" };
      });
      const summary = await worker(r.root, agent);
      assert.deepEqual(summary.processed, [{ id: job.id, status: "rejected" }]);
      assert.equal(agent.calls.length, 1);
      assert.match(
        (await readCandidate(r.root, job.id))?.reasons.join("\n") ?? "",
        /agent timeout[\s\S]*src\/a\.ts/,
      );
    } finally {
      r.cleanup();
    }
  });
});

describe("worker lifecycle", () => {
  test("two workers racing on one stale lock: exactly one takes it over, no stale files remain", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob("race", "none");
      await enqueueImprovement(r.root, job);
      const lock = join(r.root, IMPROVEMENT_DIRECTORY, "worker.lock");
      writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 - 1, startedAt: "2020-01-01T00:00:00Z" }));
      const agent = writer((id) => ({
        [`${CANDIDATE_DIRECTORY}/${id}/todo.ts`]:
          'export default async () => ({ id: "todo", run() { return "ok"; } });\n',
      }));
      const results = await Promise.all([worker(r.root, agent), worker(r.root, agent)]);
      assert.deepEqual(results.map((result) => result.ran).sort(), [false, true]);
      assert.equal(results.find((result) => !result.ran)?.reason, "locked");
      assert.equal(agent.calls.length, 1);
      const leftovers = readdirSync(join(r.root, IMPROVEMENT_DIRECTORY)).filter((n) =>
        n.startsWith("worker.lock"),
      );
      assert.deepEqual(leftovers, []);
    } finally {
      r.cleanup();
    }
  });

  test("a pending entry that cannot be claimed is skipped once instead of spinning the loop", async () => {
    const r = tempRepo({ "README.md": "x" });
    try {
      const job = createImprovementJob("real job", "none");
      await enqueueImprovement(r.root, job);
      // A directory with a job-like name: unreadable as a job and impossible to unlink or rename as a file.
      mkdirSync(join(r.root, IMPROVEMENT_DIRECTORY, "pending", "imp_000000000000.json"));
      const log: string[] = [];
      const agent = writer((id) => ({
        [`${CANDIDATE_DIRECTORY}/${id}/todo.ts`]:
          'export default async () => ({ id: "todo", run() { return "ok"; } });\n',
      }));
      const summary = await worker(r.root, agent, log);
      assert.deepEqual(summary.processed, [{ id: job.id, status: "validated" }]);
      assert.equal(agent.calls.length, 1);
      assert.ok(
        log.some((line) => line.startsWith("skipped imp_000000000000")),
        log.join("\n"),
      );
    } finally {
      r.cleanup();
    }
  });
});

describe("workflow-directory guard around delegation", () => {
  test("fingerprints detect added, modified, and removed workflow files", async () => {
    const r = tempRepo({ [`${WORKFLOW_DIRECTORY}/keep.ts`]: "a", [`${WORKFLOW_DIRECTORY}/gone.ts`]: "b" });
    try {
      const before = await workflowDirectoryFingerprint(r.root);
      r.write({
        [`${WORKFLOW_DIRECTORY}/keep.ts`]: "changed",
        [`${WORKFLOW_DIRECTORY}/pkg/index.ts`]: "new",
      });
      const { rmSync } = await import("node:fs");
      rmSync(join(r.root, WORKFLOW_DIRECTORY, "gone.ts"));
      const after = await workflowDirectoryFingerprint(r.root);
      assert.deepEqual(workflowDirectoryChanges(before, after), {
        added: [`${WORKFLOW_DIRECTORY}/pkg/index.ts`],
        modified: [`${WORKFLOW_DIRECTORY}/keep.ts`],
        removed: [`${WORKFLOW_DIRECTORY}/gone.ts`],
      });
      assert.deepEqual(await workflowDirectoryFingerprint(tempRepo({ x: "y" }).root), new Map());
    } finally {
      r.cleanup();
    }
  });

  test("a delegated agent cannot install a workflow: added files are quarantined, edits elsewhere are kept", async () => {
    const existing =
      'export default async () => ({ id: "existing", instructions: "e", run() { return "e"; } });\n';
    const r = tempRepo({
      "src/a.ts": "export const a = 1;\n",
      [`${WORKFLOW_DIRECTORY}/existing.ts`]: existing,
    });
    try {
      const agent = createFakeAgent((task) => {
        writeFileSync(join(task.cwd, "src/legit.ts"), "export const legit = true;\n");
        writeFileSync(
          join(task.cwd, WORKFLOW_DIRECTORY, "sneaky.ts"),
          'export default async () => ({ id: "sneaky", instructions: "s", run() { return "s"; } });\n',
        );
        writeFileSync(join(task.cwd, WORKFLOW_DIRECTORY, "existing.ts"), `${existing}// tampered\n`);
        return { text: "deployed" };
      });
      let stdout = "";
      let stderr = "";
      const code = await runCli(
        ["Deploy this branch", "--json", "--no-persist"],
        {
          stdout: { write: (t: string) => (stdout += t) },
          stderr: { write: (t: string) => (stderr += t) },
          stdin: Readable.from([""]),
          cwd: r.root,
          env: {},
        },
        { adapter: fake(), agent, spawnWorker: () => {} },
      );
      assert.equal(code, 0, stderr);
      const envelope = JSON.parse(stdout);
      assert.equal(envelope.status, "complete");
      const notChecked: string[] = envelope.output.data.notChecked;
      assert.ok(
        notChecked.some((n) => n.includes("sneaky.ts") && n.includes("not active")),
        notChecked.join("\n"),
      );
      assert.ok(
        notChecked.some((n) => n.includes("existing.ts") && n.includes("not restored")),
        notChecked.join("\n"),
      );
      assert.match(stderr, /warning: the agent added 1 file\(s\) under \.stanley\/workflows\//);
      assert.match(stderr, /warning: the agent changed trusted workflow files/);

      assert.ok(!existsSync(join(r.root, WORKFLOW_DIRECTORY, "sneaky.ts")), "not activated");
      const quarantine = join(r.root, QUARANTINE_DIRECTORY);
      const [stamp] = readdirSync(quarantine);
      assert.ok(stamp);
      assert.match(readFileSync(join(quarantine, stamp, "sneaky.ts"), "utf8"), /id: "sneaky"/);
      assert.ok(existsSync(join(r.root, "src/legit.ts")), "legitimate task edits are preserved");
      assert.match(readFileSync(join(r.root, WORKFLOW_DIRECTORY, "existing.ts"), "utf8"), /tampered/);
      assert.match(
        r.git("status", "--porcelain"),
        /^ M \.stanley\/workflows\/existing\.ts$/m,
        "visible to Git for review",
      );
    } finally {
      r.cleanup();
    }
  });
});
