import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { createFakeAgent } from "../src/adapters/fake-agent.ts";
import { fakeChoice, fakeScore } from "../src/adapters/fake-jev.ts";
import { CANDIDATE_DIRECTORY, IMPROVEMENT_DIRECTORY } from "../src/adapters/improvements.ts";
import { NESTED_ENV } from "../src/adapters/pi.ts";
import type { BuiltinName } from "../src/cli/builtins.ts";
import { type CliInjections, runCli } from "../src/cli.ts";
import { DELEGATION_NOT_CHECKED, delegationInstructions, delegationResult } from "../src/workflows/agent.ts";
import { CANDIDATE_SCHEMA, improvementJobId } from "../src/workflows/improve.ts";
import { fake, type Responder, tempRepo } from "./helpers.ts";

async function cli(
  root: string,
  args: string[],
  injected: CliInjections,
  extra: { stdin?: string; env?: NodeJS.ProcessEnv } = {},
) {
  let stdout = "";
  let stderr = "";
  const code = await runCli(
    args,
    {
      stdout: { write: (text: string) => (stdout += text) },
      stderr: { write: (text: string) => (stderr += text) },
      stdin: Readable.from([extra.stdin ?? ""]),
      cwd: root,
      env: extra.env ?? {},
    },
    injected,
  );
  return { code, stdout, stderr };
}

const routed = (route: BuiltinName | "cannot_tell", confidence = 0.9, respond: Responder = () => undefined) =>
  fake((name, question, request) =>
    name === "route" && question.type === "choice"
      ? fakeChoice(Object.keys(question.criteria), route, confidence)
      : respond(name, question, request),
  );

function repo() {
  const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
  r.write({ "src/a.ts": "export const a = 2;\n" });
  return r;
}

const pending = (root: string) => {
  const directory = join(root, IMPROVEMENT_DIRECTORY, "pending");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
};

describe("delegation result", () => {
  test("instructions carry the request and input; results are truthful, redacted, and identity-free", () => {
    const instructions = delegationInstructions("Deploy the docs site", "extra context");
    assert.match(instructions, /Task:\nDeploy the docs site/);
    assert.match(instructions, /Supplied input:\nextra context/);
    assert.match(instructions, /Do not commit/);
    assert.doesNotMatch(delegationInstructions("x", null), /Supplied input/);

    const token = `ghp_${"c".repeat(36)}`;
    const redaction = { text: (value: string) => ({ text: value.replaceAll(token, "[X]"), count: 1 }) };
    const finished = delegationResult(
      {
        outcome: "finished",
        text: `changed src/a.ts using ${token}`,
        exitCode: 0,
        durationMs: 5,
        toolCalls: 3,
      },
      redaction,
    );
    assert.equal(finished.status, "complete");
    const output = finished.output as { text: string; data: Record<string, unknown> };
    assert.match(output.text, /^complete - handled by an external coding agent; Stanley did not verify/);
    assert.ok(!output.text.includes(token));
    assert.equal(output.data.handledBy, "coding_agent");
    assert.deepEqual(output.data.notChecked, [...DELEGATION_NOT_CHECKED]);
    assert.ok(!("workflow" in output.data) && !("agent" in output.data) && !("pi" in output.data));

    const timedOut = delegationResult(
      { outcome: "timeout", text: "", exitCode: null, durationMs: 5, toolCalls: 0, detail: "stopped" },
      redaction,
    );
    assert.equal(timedOut.status, "incomplete");
    assert.match((timedOut.output as { text: string }).text, /stopped at the time limit/);
    assert.match((timedOut.output as { text: string }).text, /no final summary/);
  });
});

describe("agent fallback", () => {
  test("delegates an unsupported action to the agent without routing, then durably queues an improvement", async () => {
    const r = repo();
    try {
      const jev = fake();
      const agent = createFakeAgent(() => ({
        text: "Deployed nothing; this repo has no deploy target.",
        toolCalls: 4,
      }));
      const spawned: string[] = [];
      const result = await cli(r.root, ["Deploy this branch", "--json", "--no-persist"], {
        adapter: jev,
        agent,
        spawnWorker: (root) => spawned.push(root),
      });
      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.schema, "stanley.prompt-result/v1");
      assert.equal(envelope.status, "complete");
      assert.equal(envelope.output.data.handledBy, "coding_agent");
      assert.equal(envelope.output.data.toolCalls, 4);
      assert.match(envelope.output.text, /Deployed nothing/);
      assert.ok(!("workflow" in envelope));
      assert.equal(jev.requests.length, 0, "an action with no repository workflow never consults the router");
      assert.equal(agent.calls.length, 1);
      assert.equal(agent.calls[0]!.task.kind, "delegate");
      assert.match(agent.calls[0]!.task.instructions, /Task:\nDeploy this branch/);
      assert.equal(agent.calls[0]!.options.timeoutMs, 600_000);

      const id = improvementJobId("Deploy this branch");
      assert.deepEqual(pending(r.root), [`${id}.json`]);
      assert.deepEqual(spawned, [agent.calls[0]!.task.cwd]);
      assert.match(result.stderr, new RegExp(`queued improvement job ${id}`));
      assert.equal(
        r.git("status", "--porcelain", "--untracked-files=all"),
        " M src/a.ts\n",
        "queue state is ignored by Git; only the fixture's own change is visible",
      );

      const again = await cli(r.root, ["deploy  THIS branch", "--json", "--no-persist"], {
        adapter: jev,
        agent,
        spawnWorker: (root) => spawned.push(root),
      });
      assert.equal(again.code, 0);
      assert.match(again.stderr, /already queued/);
      assert.deepEqual(pending(r.root), [`${id}.json`]);
      assert.equal(spawned.length, 2, "a queued job with no live worker starts one again");
    } finally {
      r.cleanup();
    }
  });

  test("delegates when the router confidently places a request outside every workflow", async () => {
    const r = repo();
    try {
      const jev = routed("cannot_tell");
      const agent = createFakeAgent(() => ({ text: "Explained." }));
      const result = await cli(
        r.root,
        ["Explain the deployment topology of this service", "--json", "--no-persist"],
        {
          adapter: jev,
          agent,
          spawnWorker: () => {},
        },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "complete");
      assert.equal(jev.requests.length, 1);
      assert.equal(agent.calls.length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("never delegates uncertain or capability-gated requests", async () => {
    const changed = repo();
    const clean = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const agent = createFakeAgent();
      const uncertain = await cli(changed.root, ["Find the relevant code", "--json"], {
        adapter: routed("find", 0.4),
        agent,
        spawnWorker: () => assert.fail("no worker"),
      });
      assert.equal(uncertain.code, 64);
      assert.match(JSON.parse(uncertain.stdout).output.text, /No installed workflow can confidently handle/);

      const unavailable = await cli(clean.root, ["Check my current changes", "--json"], {
        adapter: routed("check"),
        agent,
        spawnWorker: () => assert.fail("no worker"),
      });
      assert.equal(unavailable.code, 64);
      assert.equal(agent.calls.length, 0);
      assert.deepEqual(pending(changed.root), []);
      assert.ok(!existsSync(join(clean.root, IMPROVEMENT_DIRECTORY)));
    } finally {
      changed.cleanup();
      clean.cleanup();
    }
  });

  test("the hot path never invokes the agent, queues nothing, and starts no worker", async () => {
    const r = repo();
    try {
      const agent = createFakeAgent();
      const result = await cli(r.root, ["Check whether the change sets a to two", "--json", "--no-persist"], {
        adapter: routed("check", 0.9, (name) =>
          name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
        ),
        agent,
        spawnWorker: () => assert.fail("the hot path must not start a worker"),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "complete");
      assert.equal(agent.calls.length, 0);
      assert.equal(result.stderr, "");
      assert.ok(!existsSync(join(r.root, IMPROVEMENT_DIRECTORY)));
      assert.ok(!existsSync(join(r.root, CANDIDATE_DIRECTORY)));
    } finally {
      r.cleanup();
    }
  });

  test("--no-agent, a nested invocation, and a missing agent keep the read-only fallback", async () => {
    const r = repo();
    try {
      const agent = createFakeAgent();
      for (const [args, env] of [
        [["Implement overflow protection", "--json", "--no-persist", "--no-agent"], {}],
        [["Implement overflow protection", "--json", "--no-persist"], { [NESTED_ENV]: "1" }],
      ] as const) {
        const result = await cli(
          r.root,
          [...args],
          { adapter: fake(), agent, spawnWorker: () => assert.fail() },
          { env },
        );
        assert.equal(result.code, 64, result.stderr);
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.status, "unsupported");
        assert.match(envelope.output.text, /cannot implement or fix code/);
      }
      const noAgent = await cli(r.root, ["Deploy this branch", "--json"], { adapter: fake(), agent: null });
      assert.equal(noAgent.code, 64);
      assert.match(JSON.parse(noAgent.stdout).output.text, /cannot run commands/);
      assert.equal(agent.calls.length, 0);
      assert.deepEqual(pending(r.root), []);
    } finally {
      r.cleanup();
    }
  });

  test("agent failures are reported as incomplete, redacted, and still queue an improvement", async () => {
    const r = repo();
    try {
      const token = `ghp_${"d".repeat(36)}`;
      const agent = createFakeAgent(() => ({ outcome: "timeout", text: `partial ${token}`, detail: "slow" }));
      const result = await cli(
        r.root,
        ["Deploy this branch", "--json", "--no-persist"],
        { adapter: fake(), agent, spawnWorker: () => {} },
        { stdin: "target: staging" },
      );
      assert.equal(result.code, 10);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.status, "incomplete");
      assert.equal(envelope.output.data.outcome, "timeout");
      assert.ok(!result.stdout.includes(token));
      assert.equal(agent.calls[0]!.options.timeoutMs, 600_000, "the agent time limit is fixed policy");
      assert.match(agent.calls[0]!.task.instructions, /Supplied input:\ntarget: staging/);
      assert.equal(pending(r.root).length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("a later run restarts an idle queue and announces validated candidates", async () => {
    const r = repo();
    try {
      mkdirSync(join(r.root, IMPROVEMENT_DIRECTORY, "pending"), { recursive: true });
      writeFileSync(join(r.root, IMPROVEMENT_DIRECTORY, "pending", "imp_000000000000.json"), "{}");
      const candidate = join(r.root, CANDIDATE_DIRECTORY, "imp_111111111111");
      mkdirSync(candidate, { recursive: true });
      writeFileSync(
        join(candidate, "candidate.json"),
        JSON.stringify({ schema: CANDIDATE_SCHEMA, id: "imp_111111111111", status: "validated" }),
      );
      const agent = createFakeAgent();
      const spawned: string[] = [];
      const result = await cli(r.root, ["Check whether the change sets a to two", "--json", "--no-persist"], {
        adapter: routed("check", 0.9, (name) =>
          name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
        ),
        agent,
        spawnWorker: (root) => spawned.push(root),
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(agent.calls.length, 0);
      assert.equal(spawned.length, 1);
      assert.match(result.stderr, /1 validated improvement candidate\(s\) await review/);
      assert.match(result.stderr, /--promote-candidate/);
    } finally {
      r.cleanup();
    }
  });
});
