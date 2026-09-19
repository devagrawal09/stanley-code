import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { BUILTINS, type BuiltinName } from "../src/cli/builtins.ts";
import { CANNOT_TELL } from "../src/cli/router.ts";
import { runCli } from "../src/cli.ts";
import type { JevPort as JevAdapter } from "../src/core/types.ts";
import { fake, fixture, type Responder, tempRepo } from "./helpers.ts";

async function cli(
  root: string,
  args: string[],
  extra: {
    adapter?: JevAdapter;
    stdin?: string;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    budget?: { requests?: number };
  } = {},
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
    {
      ...(extra.adapter ? { adapter: extra.adapter } : {}),
      ...(extra.signal ? { signal: extra.signal } : {}),
      ...(extra.budget ? { budget: extra.budget } : {}),
    },
  );
  return { code, stdout, stderr };
}

/** The router's choice labels: every built-in plus the reserved fallback. */
const ROUTE_LABELS = [...Object.keys(BUILTINS), CANNOT_TELL];

function routed(route: BuiltinName, respond: Responder = () => undefined, confidence = 0.9) {
  return fake((name, question, request) =>
    name === "route" && question.type === "choice"
      ? fakeChoice(Object.keys(question.criteria), route, confidence)
      : respond(name, question, request),
  );
}

function repo() {
  const r = tempRepo({
    "src/a.ts": "export const a = 1;\n",
    "notes/criteria.md": "- a is two\n",
    "notes/rules.json": JSON.stringify(
      {
        version: 1,
        rules: [{ id: "no-magic", class: "semantic", text: "No magic numbers.", scope: ["src/**"] }],
      },
      null,
      2,
    ),
  });
  r.write({ "src/a.ts": "export const a = 2;\n" });
  return r;
}

describe("cli", () => {
  test("the built-in routing targets are the ten typed workflows", () => {
    assert.deepEqual(Object.keys(BUILTINS), [
      "find",
      "check",
      "triage_failures",
      "triage_comments",
      "review",
      "test_gaps",
      "summarize",
      "security_review",
      "performance_review",
      "compatibility_review",
    ]);
    assert.equal(BUILTINS.find.run.name, "find");
    assert.equal(BUILTINS.check.run.name, "check");
    assert.equal(BUILTINS.triage_failures.run.name, "triageFailures");
    assert.equal(BUILTINS.triage_comments.run.name, "triageComments");
    assert.equal(BUILTINS.review.run.name, "review");
    assert.equal(BUILTINS.test_gaps.run.name, "testGaps");
    assert.equal(BUILTINS.summarize.run.name, "summarize");
  });

  test("help exposes one natural-language entry point and no command or override grammar", async () => {
    const r = repo();
    try {
      const help = await cli(r.root, ["--help"]);
      assert.equal(help.code, 0);
      assert.ok(help.stdout.includes('Usage: stanley "<request>" [options]'));
      assert.match(help.stdout, /Jev routes the request/);
      assert.doesNotMatch(help.stdout, /Commands:|<command>|--as|--kind|--offline/);
      assert.equal((await cli(r.root, [])).code, 64);
      assert.match((await cli(r.root, ["--version"])).stdout, /^\d+\.\d+\.\d+\n$/);
      assert.equal((await cli(r.root, ["help"])).code, 0);
      assert.equal((await cli(r.root, ["find relevant code", "--bogus"])).code, 64);
      assert.equal((await cli(r.root, ["find relevant code", "--as", "find"])).code, 64);
      assert.equal((await cli(r.root, ["find relevant code", "--offline"])).code, 64);

      const missingKey = await cli(r.root, ["find relevant code"]);
      assert.equal(missingKey.code, 65);
      assert.match(missingKey.stderr, /TYPESAFE_API_KEY/);
    } finally {
      r.cleanup();
    }
  });

  test("routes natural requests with diff, input shape, and capabilities as bounded context", async () => {
    const r = repo();
    try {
      const adapter = routed("check", (name) =>
        name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
      );
      const result = await cli(r.root, ["Check whether the change sets a to two", "--json", "--no-persist"], {
        adapter,
      });
      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.schema, "stanley.prompt-result/v1");
      assert.equal(envelope.status, "complete");
      assert.ok(!("workflow" in envelope));
      const routing = adapter.requests[0]!;
      assert.deepEqual(Object.keys(routing.questions), ["route"]);
      const routeQuestion = routing.questions.route!;
      assert.equal(routeQuestion.type, "choice");
      if (routeQuestion.type !== "choice") assert.fail("route must be a choice question");
      assert.deepEqual(Object.keys(routeQuestion.criteria), ROUTE_LABELS);
      assert.deepEqual(routing.state.context, {
        diff: "present",
        input: "none",
        capabilities: {
          find: true,
          check: true,
          triage_failures: false,
          triage_comments: false,
          review: true,
          test_gaps: true,
          summarize: true,
          security_review: true,
          performance_review: true,
          compatibility_review: true,
        },
      });
      assert.equal(routing.state.request, "Check whether the change sets a to two");
    } finally {
      r.cleanup();
    }
  });

  test("dispatches every specialized diff request to its typed workflow", async () => {
    const r = repo();
    const cases: Array<[BuiltinName, string]> = [
      ["review", "Review these changes for correctness bugs"],
      ["test_gaps", "What important tests are missing from this diff?"],
      ["summarize", "Summarize what changed"],
      ["security_review", "Review this diff for security vulnerabilities"],
      ["performance_review", "Look for performance regressions in these changes"],
      ["compatibility_review", "Could this diff break existing API consumers?"],
    ];
    try {
      for (const [workflow, request] of cases) {
        const result = await cli(r.root, [request, "--json", "--no-persist"], {
          adapter: routed(workflow),
        });
        assert.equal(result.code, 0, `${workflow}: ${result.stderr}`);
        const envelope = JSON.parse(result.stdout);
        assert.equal(envelope.status, "complete");
        assert.equal(envelope.output.data.summary.analysis, workflow);
        assert.ok(!("workflow" in envelope) && !("runId" in envelope.output.data));
      }
    } finally {
      r.cleanup();
    }
  });

  test("routes action requests to repository workflows and always cleans them up", async () => {
    const r = repo();
    r.write({
      ".stanley/workflows/fixer.ts": `
        import { writeFile } from "node:fs/promises";
        import { join } from "node:path";
        export default async ({ root, signal: initSignal }: { root: string; signal: AbortSignal }) => ({
          id: "fixer",
          instructions: "Use for requests to fix or modify code.",
          examples: ["Fix the security issue"],
          authorization: "sensitive-routing-value",
          async run({ request, input, signal }: { request: string; input?: unknown; signal: AbortSignal }) {
            return { request, input: input ?? null, changed: true, sameSignal: signal === initSignal };
          },
          async cleanup() { await writeFile(join(root, "workflow-cleaned"), "yes"); },
        });
      `,
    });
    try {
      const adapter = fake((name, question) => {
        if (name !== "route" || question.type !== "choice") return undefined;
        return fakeChoice(Object.keys(question.criteria), "fixer", 0.9);
      });
      const result = await cli(r.root, ["Fix the security issue", "--input", "notes/criteria.md", "--json"], {
        adapter,
      });
      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.schema, "stanley.prompt-result/v1");
      assert.equal(envelope.status, "complete");
      assert.deepEqual(envelope.output, {
        request: "Fix the security issue",
        input: "- a is two\n",
        changed: true,
        sameSignal: true,
      });
      assert.ok(!("workflow" in envelope));
      assert.equal(readFileSync(`${r.root}/workflow-cleaned`, "utf8"), "yes");
      const route = adapter.requests[0]!.questions.route;
      assert.equal(route?.type, "choice");
      if (route?.type === "choice") {
        assert.deepEqual(route.criteria.fixer, {
          instructions: "Use for requests to fix or modify code.",
          examples: ["Fix the security issue"],
          authorization: "[REDACTED:field]",
        });
      }
    } finally {
      r.cleanup();
    }
  });

  test("repository workflows compose built-ins through late-bound nested prompts", async () => {
    const r = tempRepo({
      "src/a.ts": "export const a = 1;\n",
      ".stanley/workflows/orchestrator.ts": `
        import { writeFile } from "node:fs/promises";
        import { join } from "node:path";
        export default async ({ root }: { root: string }) => ({
          id: "orchestrator",
          instructions: "Use to prepare a release summary by composing repository analysis.",
          async run({ request, prompt }: { request: string; prompt: (request: string) => Promise<unknown> }) {
            await writeFile(join(root, "src/a.ts"), "export const a = 2;\\n");
            const child = request.includes("nested action")
              ? "Fix the nested issue"
              : "Summarize the current diff";
            return { child: await prompt(child) };
          },
        });
      `,
    });
    try {
      const adapter = fake((name, question) => {
        if (name !== "route" || question.type !== "choice") return undefined;
        const labels = Object.keys(question.criteria);
        return fakeChoice(labels, labels.includes("orchestrator") ? "orchestrator" : "summarize", 0.9);
      });
      const result = await cli(r.root, ["Prepare a release summary", "--json", "--no-persist"], { adapter });
      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.status, "complete");
      assert.equal(envelope.output.child.status, "complete");
      assert.match(envelope.output.child.output.text, /^complete - advisory only/);
      assert.ok(!("workflow" in envelope.output.child));
      const routes = adapter.requests.filter((request) => request.questions.route !== undefined);
      assert.equal(routes.length, 2);
      assert.equal((routes[0]!.state.context as { diff: string }).diff, "absent");
      assert.equal((routes[1]!.state.context as { diff: string }).diff, "present");
      const childRoute = routes[1]!.questions.route!;
      assert.equal(childRoute.type, "choice");
      if (childRoute.type === "choice") {
        assert.ok(!("orchestrator" in childRoute.criteria));
      }

      const blocked = await cli(r.root, ["Prepare nested action", "--json", "--no-persist"], { adapter });
      assert.equal(blocked.code, 0, blocked.stderr);
      const blockedChild = JSON.parse(blocked.stdout).output.child;
      assert.equal(blockedChild.status, "unsupported");
      assert.match(blockedChild.output.text, /cannot implement or fix code/i);
    } finally {
      r.cleanup();
    }
  });

  test("returns the built-in fallback when routing is ambiguous, unsupported, or unavailable", async () => {
    const changed = repo();
    const clean = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      const ambiguous = await cli(changed.root, ["Take a look", "--json"], { adapter: fake() });
      assert.equal(ambiguous.code, 64);
      const ambiguousResult = JSON.parse(ambiguous.stdout);
      assert.equal(ambiguousResult.status, "unsupported");
      assert.match(ambiguousResult.output.text, /No installed workflow can confidently handle/);
      assert.equal(ambiguous.stderr, "");

      const uncertain = await cli(changed.root, ["Find the relevant code"], {
        adapter: routed("find", () => undefined, 0.4),
      });
      assert.equal(uncertain.code, 64);
      assert.match(uncertain.stdout, /No installed workflow can confidently handle/);

      const unavailable = await cli(clean.root, ["Check my current changes"], { adapter: routed("check") });
      assert.equal(unavailable.code, 64);
      assert.match(unavailable.stdout, /no current diff/i);

      const mutationAdapter = routed("security_review");
      const mutating = await cli(changed.root, ["Fix the security issue", "--json", "--no-persist"], {
        adapter: mutationAdapter,
      });
      assert.equal(mutating.code, 64);
      assert.equal(mutating.stderr, "");
      const mutationResult = JSON.parse(mutating.stdout);
      assert.equal(mutationResult.status, "unsupported");
      assert.equal(mutationResult.output.data.requested, "code_change");
      assert.match(mutationResult.output.text, /cannot implement or fix code/i);
      assert.ok(!("workflow" in mutationResult));
      assert.ok(mutationAdapter.requests.length > 0);
      assert.ok(mutationAdapter.requests.every((request) => request.questions.route === undefined));

      const actionAdapter = routed("find");
      const external = await cli(changed.root, ["Deploy this branch", "--json"], { adapter: actionAdapter });
      assert.equal(external.code, 64);
      assert.match(JSON.parse(external.stdout).output.text, /cannot run commands/);
      assert.equal(actionAdapter.requests.length, 0);

      const wrongShape = await cli(changed.root, ["Triage these failures"], {
        adapter: routed("triage_failures"),
        stdin: "ordinary prose, not a failure log",
      });
      assert.equal(wrongShape.code, 64);
      assert.match(wrongShape.stdout, /not recognized as failures/);
    } finally {
      changed.cleanup();
      clean.cleanup();
    }
  });

  test("treats safe untracked files as a present diff, exactly as the workflows load them", async () => {
    const r = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      // Only untracked changes: a new source file and a secret-shaped file that workflows exclude.
      r.write({ "src/new.ts": "export const fresh = true;\n", ".env": "TOKEN=secret\n" });
      const adapter = routed("summarize");
      const result = await cli(r.root, ["Summarize what changed", "--json", "--no-persist"], { adapter });
      assert.equal(result.code, 0, result.stderr);
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.status, "complete");
      assert.equal((adapter.requests[0]!.state.context as { diff: string }).diff, "present");
      assert.ok(
        envelope.output.data.results.some((row: { path: string }) => row.path === "src/new.ts"),
        "the untracked file is what gets summarized",
      );

      // A repository whose only untracked file is excluded has no diff to route to.
      const secretOnly = tempRepo({ "src/a.ts": "export const a = 1;\n" });
      try {
        secretOnly.write({ ".env": "TOKEN=secret\n" });
        const gated = routed("summarize");
        const absent = await cli(secretOnly.root, ["Summarize what changed", "--json"], { adapter: gated });
        assert.equal(absent.code, 64);
        assert.equal((gated.requests[0]!.state.context as { diff: string }).diff, "absent");
        assert.match(JSON.parse(absent.stdout).output.text, /no current diff/i);
      } finally {
        secretOnly.cleanup();
      }
    } finally {
      r.cleanup();
    }
  });

  test("falls back when route answers are outside the candidate set", async () => {
    const r = repo();
    try {
      const outsideRoute: Responder = (name) =>
        name === "route"
          ? {
              type: "choice",
              choice: "deploy",
              confidence: 0.9,
              probabilities: {
                find: 0.01,
                check: 0.01,
                triage_failures: 0.01,
                triage_comments: 0.01,
                cannot_tell: 0.01,
                deploy: 0.95,
              },
            }
          : undefined;
      const adapter = fake(outsideRoute);
      const result = await cli(r.root, ["Explain this code", "--json"], { adapter });
      assert.equal(result.code, 64);
      assert.equal(JSON.parse(result.stdout).status, "unsupported");
      assert.equal(adapter.requests.length, 2);

      const budgetAdapter = fake(outsideRoute);
      const exhausted = await cli(r.root, ["Explain this code", "--json"], {
        adapter: budgetAdapter,
        budget: { requests: 1 },
      });
      assert.equal(exhausted.code, 12);
      const budgetResult = JSON.parse(exhausted.stdout);
      assert.equal(budgetResult.status, "budget_exhausted");
      assert.match(budgetResult.output.text, /shared requests budget was exhausted/);
      assert.equal(budgetAdapter.requests.length, 1);
    } finally {
      r.cleanup();
    }
  });

  test("built-in output is versioned, useful, advisory, and implementation-neutral", async () => {
    const r = repo();
    try {
      const adapter = routed("check", (name) =>
        name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined,
      );
      // The request is the task; the one generic input is read as acceptance criteria here.
      const json = await cli(
        r.root,
        ["Check that a is set to two", "--input", "notes/criteria.md", "--json", "--no-persist"],
        { adapter },
      );
      assert.equal(json.code, 0, json.stderr);
      const envelope = JSON.parse(json.stdout);
      assert.equal(envelope.schema, "stanley.prompt-result/v1");
      assert.equal(envelope.status, "complete");
      assert.deepEqual(envelope.output.data.summary.sections, ["task", "criteria"]);
      assert.deepEqual(
        [...new Set(envelope.output.data.results.map((result: { section: string }) => result.section))],
        ["task", "criteria"],
      );
      const taskFrame = adapter.requests.find((request) => "diffManifest" in request.state)!;
      assert.equal((taskFrame.state.task as { text: string }).text, "Check that a is set to two");

      // The same input slot carries a project-rules document when it has the rules shape.
      const rules = await cli(
        r.root,
        ["Check that a is set to two", "--input", "notes/rules.json", "--json"],
        { adapter },
      );
      assert.equal(rules.code, 0, rules.stderr);
      assert.deepEqual(JSON.parse(rules.stdout).output.data.summary.sections, ["task", "rules"]);
      const [runDirectory] = readdirSync(join(r.root, ".stanley/runs"));
      const inputs = JSON.parse(
        readFileSync(join(r.root, ".stanley/runs", runDirectory!, "inputs.json"), "utf8"),
      );
      assert.equal(inputs.inputs.rules.source, "notes/rules.json");
      assert.match(envelope.output.text, /^complete - advisory only/);
      for (const key of [
        "coverage",
        "findings",
        "parked",
        "excluded",
        "limits",
        "notChecked",
        "results",
        "summary",
      ]) {
        assert.ok(key in envelope.output.data, key);
      }
      assert.ok(!("workflow" in envelope) && !("artifact" in envelope.output.data));
      assert.ok(!("jev" in envelope.output.data) && !("runId" in envelope.output.data));

      const human = await cli(r.root, ["Check whether a is set to two", "--no-persist"], { adapter });
      assert.equal(human.code, 0);
      assert.match(human.stdout, /^complete - advisory only/);
      assert.match(human.stdout, /advisory only/);
      assert.match(human.stdout, /not an approval/);
      assert.match(human.stdout, /project rules \(no rules supplied\)/);
      assert.match(human.stdout, /not checked:/);
    } finally {
      r.cleanup();
    }
  });

  test("routes recognized failure logs and review-comment JSON from stdin", async () => {
    const r = repo();
    try {
      const failures = routed("triage_failures", (name) =>
        name === "nondeterminism_signature" ? fakeNoul(0.1) : undefined,
      );
      const stdin = await cli(r.root, ["Triage these test failures", "--json", "--no-persist"], {
        adapter: failures,
        stdin: fixture("go-failure.txt"),
      });
      assert.equal(stdin.code, 0, stdin.stderr);
      const triaged = JSON.parse(stdin.stdout).output.data;
      assert.equal(triaged.summary.kind, "failures");
      assert.equal(triaged.summary.source, "stdin");
      assert.ok(triaged.results.every((result: { kind: string }) => result.kind === "failures"));
      assert.equal((failures.requests[0]!.state.context as { input: string }).input, "failure_log");

      const comments = await cli(r.root, ["Sort these review comments", "--no-persist"], {
        adapter: routed("triage_comments"),
        stdin: JSON.stringify([{ id: 1, body: "a should be 3", path: "src/a.ts", line: 1 }]),
      });
      assert.equal(comments.code, 0, comments.stderr);
      assert.match(comments.stdout, /^complete - advisory only/);
      assert.match(comments.stdout, /\ncomments:\n/);
    } finally {
      r.cleanup();
    }
  });

  test("the public option surface is fixed and minimal; removed workflow flags are rejected", async () => {
    const r = repo();
    try {
      const help = await cli(r.root, ["--help"]);
      const documented = [...help.stdout.matchAll(/^\s+(?:-\w, )?(--[a-z-]+)/gm)].map((m) => m[1]);
      assert.deepEqual(documented, [
        "--input",
        "--scope",
        "--base",
        "--repo",
        "--json",
        "--no-persist",
        "--no-agent",
        "--help",
        "--version",
        "--improve-worker",
        "--promote-candidate",
      ]);
      const removed = [
        ["--task", "x"],
        ["--task-file", "notes/criteria.md"],
        ["--task-source", "user"],
        ["--rules", "notes/rules.json"],
        ["--criteria", "1. a"],
        ["--criteria-file", "notes/criteria.md"],
        ["--test-results", "notes/criteria.md"],
        ["--max-hunks", "1"],
        ["--max-pairs", "1"],
        ["--max-evidence", "1"],
        ["--max-items", "1"],
        ["--max-files", "1"],
        ["--top", "3"],
        ["--excerpts"],
        ["--paths", "src/**"],
        ["--no-diff"],
        ["--model", "jev-9"],
        ["--concurrency", "2"],
        ["--max-requests", "1"],
        ["--max-input-tokens", "1"],
        ["--timeout-seconds", "1"],
        ["--agent-timeout-seconds", "1"],
      ];
      for (const flag of removed) {
        const adapter = routed("check");
        const result = await cli(r.root, ["Check the change", ...flag], { adapter });
        assert.equal(result.code, 64, flag.join(" "));
        assert.match(result.stderr, /usage error/, flag.join(" "));
        assert.equal(adapter.requests.length, 0, `${flag[0]} must fail before anything is routed`);
      }
      assert.equal((await cli(r.root, ["Check the change", "--scope", "index"])).code, 64);

      // Input goes only to workflows that use it; a built-in with no use for it never swallows it silently.
      const unused = await cli(r.root, ["Find the relevant code", "--input", "notes/criteria.md"], {
        adapter: routed("find"),
      });
      assert.equal(unused.code, 64);
      assert.match(unused.stderr, /supplied input is not used when the request routes to find/);
    } finally {
      r.cleanup();
    }
  });

  test("enforces workspace containment for the input and the repository", async () => {
    const r = repo();
    try {
      const escaped = await cli(r.root, ["Triage these failures", "--input", "../../etc/passwd", "--json"], {
        adapter: routed("triage_failures"),
      });
      assert.equal(escaped.code, 65);
      const escapedError = JSON.parse(escaped.stdout);
      assert.equal(escapedError.error.kind, "input");
      assert.ok(!("workflow" in escapedError));

      const secret = await cli(r.root, ["Check the criteria", "--input", ".env"], {
        adapter: routed("check"),
      });
      assert.equal(secret.code, 65);

      const outside = await cli("/", ["Check whether a changed", "--repo", r.root, "--no-persist"], {
        adapter: routed("check"),
      });
      assert.equal(outside.code, 0);
    } finally {
      r.cleanup();
    }
  });

  test("errors never print the API key", async () => {
    const r = repo();
    const key = "tsk_live_SUPERSECRET_0123456789";
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = key;
    try {
      const leaky = fake(() => {
        throw new Error(`request failed for key ${key}`);
      });
      const result = await cli(r.root, ["Check whether a changed", "--json", "--no-persist"], {
        adapter: leaky,
        env: { TYPESAFE_API_KEY: key },
      });
      assert.equal(result.code, 64);
      assert.equal(JSON.parse(result.stdout).status, "unsupported");
      assert.ok(!result.stdout.includes(key) && !result.stderr.includes(key));

      const crash: JevAdapter = {
        ask: () => {
          throw new TypeError(`boom ${key}`);
        },
      };
      const crashed = await cli(r.root, ["Find code", "--no-persist"], {
        adapter: crash,
        env: { TYPESAFE_API_KEY: key },
      });
      assert.ok(!crashed.stdout.includes(key) && !crashed.stderr.includes(key));
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
      r.cleanup();
    }
  });

  test("passes the invocation signal through intent routing", async () => {
    const r = repo();
    const controller = new AbortController();
    let routedSignal: AbortSignal | undefined;
    const adapter: JevAdapter = {
      ask: (_request, options) => {
        routedSignal = options.signal;
        controller.abort(new Error("stop"));
        throw controller.signal.reason;
      },
    };
    try {
      const result = await cli(r.root, ["Find relevant code", "--json"], {
        adapter,
        signal: controller.signal,
      });
      assert.equal(result.code, 70);
      assert.equal(routedSignal, controller.signal);
      assert.ok(!("workflow" in JSON.parse(result.stdout)));
    } finally {
      r.cleanup();
    }
  });
});
