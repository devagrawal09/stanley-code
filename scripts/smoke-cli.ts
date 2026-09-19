/**
 * Smoke test the built CLI with a deterministic test Jev and a deterministic test coding agent. No network
 * calls are made and no real agent runs.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { createFakeAgent } from "../src/adapters/fake-agent.ts";
import { createFakeAdapter, fakeChoice, fakeNoul } from "../src/adapters/fake-jev.ts";
import { improvementJobId } from "../src/workflows/improve.ts";

const TODO_REQUEST = "Audit the TODO notes in src";

type RunCli = typeof import("../src/cli.ts").runCli;
type Injections = Parameters<RunCli>[2];

const built = (await import(pathToFileURL(resolve(import.meta.dirname, "../dist/cli.js")).href)) as {
  runCli: RunCli;
};
const root = mkdtempSync(join(tmpdir(), "stanley-smoke-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const adapter = createFakeAdapter((name, question, request) => {
  if (name === "stale") return fakeNoul(0.9);
  if (name !== "route") return undefined;
  if (question.type !== "choice") return undefined;
  const labels = Object.keys(question.criteria);
  const prompt = String(request.state.request).toLowerCase();
  let route = "cannot_tell";
  if (prompt.includes("smoke workflow")) route = "smoke_workflow";
  else if (prompt.includes("todo") && labels.includes("todo_audit")) route = "todo_audit";
  else if (prompt.includes("failure")) route = "triage_failures";
  else if (prompt.includes("comment")) route = "triage_comments";
  else if (prompt.includes("security")) route = "security_review";
  else if (prompt.includes("performance")) route = "performance_review";
  else if (prompt.includes("compatib") || prompt.includes("consumer")) route = "compatibility_review";
  else if (prompt.includes("missing test")) route = "test_gaps";
  else if (prompt.includes("summar")) route = "summarize";
  else if (prompt.includes("review")) route = "review";
  else if (prompt.includes("find") || prompt.includes("where")) route = "find";
  else if (prompt.includes("check")) route = "check";
  return fakeChoice(labels, route, 0.9);
});

/** The delegated agent: answers tasks; the improvement agent: writes one workflow into its candidate dir. */
const agent = createFakeAgent((task) => {
  if (task.kind === "delegate") return { text: "Implemented nothing; smoke agent.", toolCalls: 1 };
  const match = /\.stanley\/candidates\/(imp_[0-9a-f]{12})/.exec(task.instructions);
  if (!match) return { outcome: "failed", detail: "no candidate directory in brief" };
  if (!task.instructions.includes("TODO")) return { text: "not a reusable workflow; wrote nothing" };
  const directory = join(task.cwd, ".stanley/candidates", match[1]!);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "todo_audit.ts"),
    `export default async () => ({
  id: "todo_audit",
  instructions: "Use when asked to audit TODO comments.",
  async run({ request, judge }) {
    const verdict = await judge({ scope: "todo", state: { request }, questions: { stale: { type: "noul" } } });
    return { text: "audited", data: { judged: verdict.ok, request } };
  },
});
`,
  );
  return { text: "wrote todo_audit.ts", toolCalls: 3 };
});
const spawned: string[] = [];

async function invoke(
  args: string[],
  injected: Injections = { adapter, agent, spawnWorker: (r) => spawned.push(r) },
) {
  let stdout = "";
  let stderr = "";
  const code = await built.runCli(
    args,
    {
      stdout: { write: (text) => (stdout += text) },
      stderr: { write: (text) => (stderr += text) },
      stdin: Readable.from([]),
      cwd: root,
      env: {},
    },
    injected,
  );
  return { code, stdout, stderr };
}

interface Case {
  args: string[];
  expect: number;
  json?: boolean;
  repository?: boolean;
  error?: RegExp;
  sections?: string[];
  injected?: Injections;
  /** Extra check on the parsed JSON envelope. */
  verify?: (envelope: Record<string, unknown>, result: { stderr: string }) => boolean;
}

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "smoke");
  write("src/math.js", "export function add(a, b) {\n  return a + b;\n}\n");
  write(
    ".stanley/workflows/smoke.ts",
    'export default async () => ({ id: "smoke_workflow", instructions: "Use for the smoke workflow request.", async run({ request }) { return { repository: true, request }; } });\n',
  );
  write(
    "test/math.test.js",
    'import { add } from "../src/math.js";\ntest("adds", () => {\n  expect(add(1, 2)).toEqual(3);\n});\n',
  );
  git("add", "-A");
  git("commit", "-qm", "init");
  write("src/math.js", "export function add(a, b) {\n  if (a === 41) return 42;\n  return a + b;\n}\n");
  write(
    "test/math.test.js",
    'import { add } from "../src/math.js";\ntest.skip("adds", () => {\n  expect(add(1, 2)).toBeDefined();\n});\n',
  );
  write(
    "ci.txt",
    "FAIL test/math.test.js\n  adds\n    Expected: 3\n    Received: 4\n      at test/math.test.js:3:20\n",
  );
  write("criteria.md", "- add returns the sum\n- add handles overflow\n");
  write(
    "rules.json",
    JSON.stringify({
      version: 1,
      rules: [
        { id: "no-magic", class: "semantic", text: "No magic-number special cases.", scope: ["src/**"] },
      ],
    }),
  );
  write(
    "comments.json",
    JSON.stringify([{ id: 1, body: "This returns 42 for 41, why?", path: "src/math.js", line: 2 }]),
  );
  const noAgent: Injections = { adapter, agent: null };
  const delegated = (envelope: Record<string, unknown>) =>
    (envelope.output as { data?: { handledBy?: string } })?.data?.handledBy === "coding_agent";
  const cases: Case[] = [
    { args: ["--help"], expect: 0 },
    { args: [], expect: 64 },
    // The hot path: routed to a built-in; the agent is never invoked and no worker is started.
    {
      args: ["Check whether the change fixes add overflow", "--json"],
      expect: 0,
      json: true,
      verify: (_envelope, result) => spawned.length === 0 && agent.calls.length === 0 && result.stderr === "",
    },
    { args: ["Do something vague"], expect: 64, injected: noAgent },
    { args: ["Run the smoke workflow", "--json", "--no-persist"], expect: 0, json: true, repository: true },
    // The one generic input: acceptance criteria or a project-rules document, recognized by shape.
    {
      args: ["Check the add overflow fix against these requirements", "--input", "criteria.md", "--json"],
      expect: 0,
      json: true,
      sections: ["task", "criteria"],
    },
    {
      args: ["Check the add overflow fix against the project rules", "--input", "rules.json", "--json"],
      expect: 0,
      json: true,
      sections: ["task", "rules"],
    },
    // The exact Git selection is a host control; nothing is staged here, so the diff-gated check is unavailable.
    { args: ["Check the staged changes", "--scope", "staged", "--json"], expect: 64, json: true },
    ...(
      [
        "Review these changes for bugs",
        "Find missing tests in this diff",
        "Summarize what changed",
        "Review this diff for security issues",
        "Review this diff for performance regressions",
        "Could this break existing consumers?",
      ] as const
    ).map((request) => ({
      args: [request, "--json"],
      expect: 0,
      json: true,
    })),
    {
      args: ["Triage these failures", "--input", "ci.txt", "--json"],
      expect: 0,
      json: true,
    },
    {
      args: ["Triage these comments", "--input", "comments.json", "--json"],
      expect: 0,
      json: true,
    },
    { args: ["Triage these failures", "--input", "../outside.log"], expect: 65 },
    {
      args: ["Find where add is implemented", "--json"],
      expect: 0,
      json: true,
    },
    // Without an agent, unsupported actions stay read-only and truthful.
    {
      args: ["Implement overflow protection", "--json", "--no-persist"],
      expect: 64,
      json: true,
      injected: noAgent,
    },
    { args: ["Deploy this branch"], expect: 64, injected: noAgent },
    { args: ["Deploy this branch", "--no-agent"], expect: 64 },
    // With an agent, unsupported requests are delegated and an improvement is queued durably.
    {
      args: ["Do something vague", "--json", "--no-persist"],
      expect: 0,
      json: true,
      verify: (envelope, result) => delegated(envelope) && /queued improvement job imp_/.test(result.stderr),
    },
    {
      args: [TODO_REQUEST, "--json", "--no-persist"],
      expect: 0,
      json: true,
      verify: (envelope, result) =>
        delegated(envelope) &&
        /queued improvement job imp_/.test(result.stderr) &&
        spawned.length === 2 &&
        existsSync(join(root, ".stanley/improvements/pending")),
    },
    // The worker (in-process here; detached in production) rejects the vague job and validates the TODO one.
    {
      args: ["--improve-worker", "--json"],
      expect: 0,
      json: true,
      verify: (envelope) =>
        envelope.schema === "stanley.improvement-worker/v1" &&
        JSON.stringify((envelope as { processed?: unknown }).processed) ===
          JSON.stringify(
            [
              { id: improvementJobId(TODO_REQUEST), status: "validated" },
              { id: improvementJobId("Do something vague"), status: "rejected" },
            ].sort((a, b) => a.id.localeCompare(b.id)),
          ),
    },
    // Workflow-specific flags do not exist; every semantic instruction lives in the request.
    { args: ["Find add", "--input", "criteria.md"], expect: 64 },
    { args: ["Find add", "--top", "5"], expect: 64 },
    { args: ["Check the change", "--task", "fix add overflow"], expect: 64 },
    { args: ["Check the change", "--rules", "rules.json"], expect: 64 },
    { args: ["Check the change", "--max-hunks", "10"], expect: 64 },
    { args: ["Check the change", "--model", "jev-9"], expect: 64 },
    { args: ["Triage these failures", "--input", "ci.txt", "--no-diff"], expect: 64 },
    { args: ["Deploy this branch", "--agent-timeout-seconds", "5"], expect: 64 },
    { args: ["Find add", "--as", "find"], expect: 64 },
    { args: ["Triage failures", "--kind", "failures", "--input", "ci.txt"], expect: 64 },
    { args: ["Check the change", "--offline"], expect: 64 },
  ];

  let failures = 0;
  const run = async (test: Case) => {
    const result = await invoke(test.args, test.injected);
    let ok = result.code === test.expect && (!test.error || test.error.test(result.stderr));
    let note = "";
    if (ok && test.json) {
      try {
        const envelope = JSON.parse(result.stdout) as {
          schema?: string;
          status?: string;
          output?: {
            text?: string;
            data?: { notChecked?: unknown[]; summary?: { sections?: string[] } };
          };
        };
        if (envelope.schema === "stanley.prompt-result/v1") {
          const expectedStatus = test.expect === 64 ? "unsupported" : "complete";
          ok = envelope.status === expectedStatus;
          if (ok && test.repository) {
            ok =
              (envelope.output as unknown as { repository?: boolean; request?: string })?.repository ===
                true &&
              (envelope.output as unknown as { request?: string })?.request === "Run the smoke workflow";
          } else if (
            ok &&
            expectedStatus === "complete" &&
            !delegated(envelope as Record<string, unknown>) &&
            typeof envelope.output?.data === "object" &&
            envelope.output.data !== null &&
            "coverage" in envelope.output.data
          ) {
            // Built-in packets always list what was not checked; repository workflow output is checked by `verify`.
            ok =
              typeof envelope.output?.text === "string" &&
              Array.isArray(envelope.output.data?.notChecked) &&
              envelope.output.data.notChecked.length > 0 &&
              (!test.sections ||
                JSON.stringify(envelope.output.data.summary?.sections) === JSON.stringify(test.sections));
          }
        }
        if (ok && test.verify) ok = test.verify(envelope as Record<string, unknown>, result);
        if (!ok) note = " (result shape)";
      } catch {
        ok = false;
        note = " (invalid JSON)";
      }
    }
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} exit=${result.code} stanley ${test.args.join(" ")}${note}`);
    if (!ok) console.log(result.stdout.slice(0, 2000), result.stderr.slice(0, 2000));
  };
  for (const test of cases) await run(test);

  // Close the loop: promote the staged candidate, then the same request runs without the agent.
  const agentCallsBefore = agent.calls.length;
  await run({
    args: ["--promote-candidate", improvementJobId(TODO_REQUEST)],
    expect: 0,
    injected: noAgent,
  });
  await run({
    args: [TODO_REQUEST, "--json", "--no-persist"],
    expect: 0,
    json: true,
    verify: (envelope, result) =>
      JSON.stringify(envelope.output) ===
        JSON.stringify({ text: "audited", data: { judged: true, request: TODO_REQUEST } }) &&
      agent.calls.length === agentCallsBefore &&
      result.stderr === "",
  });

  const status = execFileSync("git", ["status", "--porcelain", "--ignored"], {
    cwd: root,
    encoding: "utf8",
  });
  if (!status.includes(".stanley/")) {
    failures++;
    console.log("FAIL expected persisted .stanley/ artifacts to exist and be ignored");
  }
  if (!status.includes("?? .stanley/workflows/todo_audit.ts")) {
    failures++;
    console.log("FAIL expected the promoted workflow to be visible to Git for review");
  }
  const total = cases.length + 2;
  console.log(failures === 0 ? `smoke: all ${total} cases passed` : `smoke: ${failures} failure(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
