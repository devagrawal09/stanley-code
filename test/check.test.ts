import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createWorkflowDependencies } from "../src/adapters/dependencies.ts";
import { fakeChoice, fakeNoul, fakeScore } from "../src/adapters/fake-jev.ts";
import { exitCodeFor } from "../src/cli/output.ts";
import { CHECK, type CheckResult, check } from "../src/workflows/check.ts";
import type { Packet } from "../src/workflows/types.ts";
import { fake, fixture, options, stateText, tempRepo } from "./helpers.ts";

function section<S extends CheckResult["section"]>(packet: Packet<CheckResult>, name: S) {
  return packet.results.filter(
    (result): result is Extract<CheckResult, { section: S }> => result.section === name,
  );
}

const KINDS = [
  "behavior_change",
  "refactor_no_behavior_change",
  "formatting_or_comments",
  "test_change",
  "config_or_dependency",
  "documentation",
  "cannot_tell",
];

function setup() {
  const repo = tempRepo({
    "src/cart.ts":
      "export function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\n",
    "src/format.ts": "export function money(value) {\n  return '$' + value;\n}\n",
    "test/cart.test.ts":
      'import { total } from "../src/cart";\ntest("total", () => {\n  expect(total([{ price: 10 }])).toBe(10);\n});\n',
    "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
    "src/style.ts": "const x = {a:1};\n",
  });
  repo.write({
    "src/cart.ts":
      'import { applyDiscount } from "./discount";\nexport function total(items, code) {\n  const subtotal = items.reduce((sum, item) => sum + item.price, 0);\n  return applyDiscount(subtotal, code);\n}\n',
    "src/discount.ts":
      "export function applyDiscount(value, code) {\n  return code === 'SAVE10' ? value * 0.9 : value;\n}\n",
    "src/format.ts": "export function money(value) {\n  return `$${value.toFixed(2)}`;\n}\n",
    "test/cart.test.ts":
      'import { total } from "../src/cart";\ntest("total", () => {\n  expect(total([{ price: 10 }])).toBeDefined();\n});\n',
    "package-lock.json": '{\n  "lockfileVersion": 3,\n  "name": "x"\n}\n',
    "src/style.ts": "const x = { a: 1 };\n",
  });
  repo.git("add", "-N", "src/discount.ts");
  return repo;
}

const pathOf = (state: unknown) =>
  (state as { hunk?: { path?: string }; candidateHunk?: { path?: string } }).hunk?.path;

describe("check: task section", () => {
  test("flags weak hunks and weakened tests, clears enabler hunks, skips deterministic hunks", async () => {
    const repo = setup();
    try {
      const adapter = fake((name, _question, request) => {
        const path = pathOf(request.state);
        if (name === "task_relation") {
          return path === "src/format.ts" || path === "src/discount.ts"
            ? fakeScore(4, 0, 0.85)
            : fakeScore(4, 3, 0.85);
        }
        if (name === "change_kind")
          return fakeChoice(KINDS, path?.startsWith("test/") ? "test_change" : "behavior_change", 0.8);
        if (name === "weakens_expectation") return fakeNoul(0.92);
        if (name === "expectation_change_stated_in_task") return fakeNoul(0.1);
        if (name === "enables_other_hunk") return fakeNoul(0.85);
        if (name === "untrusted_instruction_text") return fakeNoul(0.99);
        return undefined;
      });
      const packet = await check(
        { task: "Apply discount codes to cart totals" },
        options(repo.root, adapter),
      );

      assert.equal(packet.status, "complete");
      assert.equal(exitCodeFor(packet), 0);
      assert.equal(packet.advisory, true);
      assert.ok(packet.notChecked.length > 0);
      const flags = packet.findings.map((finding) => `${finding.flag}:${finding.path ?? ""}`);
      assert.ok(flags.includes("weak_task_relation:src/format.ts"), flags.join(" "));
      assert.ok(flags.includes("test_expectation_weakened:test/cart.test.ts"));
      assert.ok(flags.includes("lockfile_changed:package-lock.json"));
      assert.ok(!flags.includes("weak_task_relation:src/discount.ts"), "enabler hunk should be cleared");
      assert.ok(!flags.some((flag) => flag.startsWith("untrusted_instruction_text:")));
      assert.equal(packet.workflow, "check@1");
      assert.deepEqual(packet.summary.sections, ["task"]);
      assert.ok(packet.notChecked.includes("project rules (no rules supplied)"));
      assert.ok(packet.notChecked.includes("acceptance criteria (no criteria supplied)"));
      const discount = section(packet, "task").find((result) => result.path === "src/discount.ts")!;
      assert.ok(discount.flags.includes("enables_linked_hunk"));

      const sentPaths = adapter.requests.map((request) => pathOf(request.state)).filter(Boolean);
      assert.ok(!sentPaths.includes("package-lock.json"), "lockfile hunks are deterministic only");
      assert.ok(sentPaths.includes("src/style.ts"), "formatting-looking hunks are still judged");
      const style = section(packet, "task").find((result) => result.path === "src/style.ts")!;
      assert.equal(style.disposition, "judged");
      assert.deepEqual(style.deterministicFlags, ["formatting_only"], "the observation is kept");
      assert.equal(packet.coverage.deterministic, 1);
      assert.equal(packet.coverage.judged, 5);

      const intent = adapter.requests.find(
        (request) => pathOf(request.state) === "src/cart.ts" && "diffManifest" in request.state,
      )!;
      assert.ok("special_cases_literal_input" in intent.questions, "source hunks ask about special-casing");
      assert.match(JSON.stringify(intent.state), /untrusted evidence/);
      assert.equal(intent.model, "jev-1.13.0");
      const testFrame = adapter.requests.find((request) => "weakens_expectation" in request.questions)!;
      assert.deepEqual(Object.keys(testFrame.state).sort(), ["evidencePolicy", "hunk", "task"]);
      const instructions = testFrame.questions.weakens_expectation!.instructions as {
        workedExamples: unknown[];
      };
      assert.equal(instructions.workedExamples.length, 6);
    } finally {
      repo.cleanup();
    }
  });

  test("whitespace-only hunks reach Jev, so indentation that changes behavior can be flagged", async () => {
    // Python: moving `return total` out of the loop by dedenting changes behavior but squashes to the same text.
    const repo = tempRepo({
      "src/sum.py":
        "def sum(items):\n    total = 0\n    for item in items:\n        total += item\n        return total\n",
    });
    try {
      repo.write({
        "src/sum.py":
          "def sum(items):\n    total = 0\n    for item in items:\n        total += item\n    return total\n",
      });
      const adapter = fake((name) => {
        if (name === "task_relation") return fakeScore(4, 0, 0.9);
        if (name === "change_kind") return fakeChoice(KINDS, "behavior_change", 0.9);
        if (name.startsWith("rule_")) return fakeChoice(RULE_LABELS, "applicable_and_violated", 0.9);
        return undefined;
      });
      const packet = await check(
        { task: "Rename the sum helper", rules: { text: fixture("rules.json"), source: "rules.json" } },
        options(repo.root, adapter),
      );
      const hunk = section(packet, "task").find((result) => result.path === "src/sum.py")!;
      assert.deepEqual(hunk.deterministicFlags, ["formatting_only"]);
      assert.equal(hunk.disposition, "judged");
      assert.ok(hunk.flags.includes("weak_task_relation"));
      assert.ok(
        packet.findings.some((finding) => finding.flag === "formatting_only"),
        "kept as an observation",
      );
      const intent = adapter.requests.find((request) => "diffManifest" in request.state)!;
      assert.deepEqual(intent.state.deterministicFlags, ["formatting_only"], "Jev sees the observation");
      assert.ok(section(packet, "rules").length > 0, "rules are judged against the hunk too");
      assert.ok(packet.findings.some((finding) => finding.flag === "rule_violation"));
      assert.ok(!packet.notChecked.some((note) => note.includes("formatting-only")));
    } finally {
      repo.cleanup();
    }
  });

  test("hard conflicts are parked and vague tasks produce a single insufficiency finding", async () => {
    const repo = setup();
    try {
      const conflicted = fake((name, _q, request) => {
        if (name === "task_relation")
          return pathOf(request.state) === "src/format.ts" ? fakeScore(4, 3, 0.9) : fakeScore(4, 0, 0.9);
        if (name === "change_kind") return fakeChoice(KINDS, "formatting_or_comments", 0.9);
        if (name === "enables_other_hunk") return fakeNoul(0.1);
        return undefined;
      });
      const packet = await check({ task: "Improve things" }, options(repo.root, conflicted));
      assert.deepEqual(
        packet.parked.map((item) => item.path),
        ["src/format.ts"],
      );
      assert.equal(packet.coverage.parked, 1);

      const vague = fake((name) => {
        if (name === "task_relation") return fakeScore(4, 0, 0.9);
        if (name === "change_kind") return fakeChoice(KINDS, "behavior_change", 0.9);
        if (name === "enables_other_hunk") return fakeNoul(0.1);
        return undefined;
      });
      const vaguePacket = await check({ task: "Improve things" }, options(repo.root, vague));
      const flags = vaguePacket.findings.map((finding) => finding.flag);
      assert.ok(flags.includes("task_text_insufficient"));
      assert.ok(!flags.includes("weak_task_relation"));
    } finally {
      repo.cleanup();
    }
  });

  test("invalid responses make coverage incomplete", async () => {
    const repo = setup();
    try {
      const broken = fake((name) => (name === "task_relation" ? { type: "score", score: 9 } : undefined));
      const packet = await check({ task: "Apply discount codes" }, options(repo.root, broken));
      assert.equal(packet.status, "incomplete");
      assert.equal(exitCodeFor(packet), 10);
      assert.ok(packet.coverage.failed > 0);
    } finally {
      repo.cleanup();
    }
  });

  test("hunk limits are reported, not silent; staged and branch scopes work", async () => {
    const repo = setup();
    try {
      const limited = await check({ task: "Apply discount codes", maxHunks: 1 }, options(repo.root, fake()));
      assert.equal(limited.coverage.complete, false);
      assert.ok(limited.limits.some((limit) => limit.includes("policy hunk limit")));
      assert.ok(section(limited, "task").some((result) => result.error === "not judged: hunk limit"));

      const staged = await check({ task: "x", scope: "staged" }, options(repo.root, fake()));
      assert.equal(staged.results.length, 0);
      assert.equal(staged.status, "complete");

      repo.git("checkout", "-q", "-b", "feature");
      repo.commit("feature work");
      const branch = await check(
        { task: "Apply discount codes", scope: "branch", base: "main" },
        options(repo.root, fake()),
      );
      assert.ok(section(branch, "task").some((result) => result.path === "src/discount.ts"));
      await assert.rejects(
        check({ task: "x", scope: "branch", base: "--upload-pack=evil" }, options(repo.root, fake())),
        /unsupported ref/,
      );
      await assert.rejects(check({ task: "   " }, options(repo.root, fake())), /task text is required/);
    } finally {
      repo.cleanup();
    }
  });

  test("worktree scope includes safe untracked files and excludes secret paths", async () => {
    const repo = tempRepo({ "src/existing.ts": "export const existing = true;\n" });
    try {
      repo.write({
        "src/new-feature.ts": "export function newFeature() { return true; }\n",
        "src/new feature.ts": "export const spacedPath = true;\n",
        ".env": "TOKEN=secret\n",
      });
      const packet = await check({ task: "Add the new feature module" }, options(repo.root, fake()));
      const added = section(packet, "task").find((result) => result.path === "src/new-feature.ts");
      assert.equal(added?.fileStatus, "added");
      assert.ok(section(packet, "task").some((result) => result.path === "src/new feature.ts"));
      assert.ok(packet.excluded.some((item) => item.path === ".env"));
      assert.ok(!packet.notChecked.some((note) => note.includes("untracked")));
      assert.equal((packet.summary.diff as { probe: string }).probe, "git-diff-U3:worktree+untracked-files");
      assert.equal(packet.status, "complete");
    } finally {
      repo.cleanup();
    }
  });
});

const RULE_LABELS = ["not_applicable", "applicable_and_followed", "applicable_and_violated", "cannot_tell"];
const TASK = "Return 404 for unknown ids";
/** Task-section answers that raise no flags, so rules and criteria assertions stand alone. */
const aligned = (name: string) => (name === "task_relation" ? fakeScore(4, 3, 0.9) : undefined);
const asks = (request: { questions: object }, prefix: string) =>
  Object.keys(request.questions).some((key) => key.startsWith(prefix));

function criteriaRepo() {
  const repo = tempRepo({
    "src/api.ts": "export function get(id) {\n  return db[id];\n}\n",
    "test/api.test.ts": "test('get', () => {});\n",
  });
  repo.write({
    "src/api.ts":
      "export function get(id, res) {\n  const item = db[id];\n  if (!item) return res.status(404).end();\n  return item;\n}\n",
    "test/api.test.ts":
      "test('returns 404 for unknown ids', async () => {\n  expect((await get('x')).status).toBe(404);\n});\n",
  });
  return repo;
}

const CRITERIA =
  "1. Returns 404 for unknown ids\n2. Logs each retry attempt\n3. Supports cursor pagination\n";

function criteriaAdapter() {
  return fake((name, question, request) => {
    if (name.startsWith("addresses_")) {
      const criterion = (question.instructions as { criterion: string }).criterion;
      const content = stateText(request);
      if (criterion.includes("404")) return fakeNoul(content.includes("404") ? 0.9 : 0.05);
      if (criterion.includes("retry")) return fakeNoul(0.45);
      return fakeNoul(0.05);
    }
    if (name === "evidence_strength") return fakeScore(4, 3, 0.8);
    return aligned(name);
  });
}

describe("check: criteria section", () => {
  test("maps criteria to evidence and caps support without linked passing tests", async () => {
    const repo = criteriaRepo();
    try {
      const adapter = criteriaAdapter();
      const packet = await check(
        { task: TASK, criteria: { text: CRITERIA, source: "argument" } },
        options(repo.root, adapter),
      );
      assert.deepEqual(packet.summary.sections, ["task", "criteria"]);
      const criteria = section(packet, "criteria");
      const byText = Object.fromEntries(criteria.map((result) => [result.text, result]));
      const notFound = byText["Returns 404 for unknown ids"]!;
      assert.equal(notFound.status, "partial");
      assert.equal(notFound.cappedBy, "no test results supplied");
      assert.equal(notFound.evidence.length, 2);
      assert.equal(byText["Logs each retry attempt"]!.status, "unclear");
      assert.equal(byText["Supports cursor pagination"]!.status, "unsupported");
      assert.equal(criteria[0]!.status, "unsupported", "unevidenced criteria are listed first");
      assert.ok(packet.parked.some((item) => item.reason.includes("uncertain band")));
      assert.ok(packet.findings.some((finding) => finding.flag === "criterion_unevidenced"));

      const unitRequests = adapter.requests.filter((request) => asks(request, "addresses_"));
      assert.equal(unitRequests.length, 2, "one request per evidence unit");
      assert.equal(Object.keys(unitRequests[0]!.questions).length, 3, "one Noul per criterion");
      const strength = adapter.requests.find((request) => "evidence_strength" in request.questions)!;
      assert.equal(
        (strength.questions.evidence_strength!.instructions as { workedExamples: unknown[] }).workedExamples
          .length,
        4,
      );
    } finally {
      repo.cleanup();
    }
  });

  test("linked passing test records allow supported; test results need criteria", async () => {
    const repo = criteriaRepo();
    try {
      const testResults = {
        text: '<testsuite><testcase classname="api" name="returns 404 for unknown ids"/></testsuite>',
        source: "junit.xml",
      };
      const packet = await check(
        { task: TASK, criteria: { text: CRITERIA, source: "argument" }, testResults },
        options(repo.root, criteriaAdapter()),
      );
      const notFound = section(packet, "criteria").find((result) => result.text.includes("404"))!;
      assert.equal(notFound.status, "supported");
      assert.equal(notFound.cappedBy, null);
      assert.deepEqual(notFound.linkedTests, [{ name: "api returns 404 for unknown ids", status: "passed" }]);
      await assert.rejects(
        check({ task: TASK, testResults }, options(repo.root, fake())),
        /supply criteria with them/,
      );
    } finally {
      repo.cleanup();
    }
  });
});

describe("check: rules section", () => {
  test("judges only semantic rules on in-scope hunks and flags or parks by policy", async () => {
    const repo = tempRepo({ "src/client.ts": "export const x = 1;\n", "docs/guide.md": "# Guide\n" });
    try {
      repo.write({
        "src/client.ts": 'export const x = 1;\nconsole.log("key=" + process.env.TYPESAFE_API_KEY);\n',
        "docs/guide.md": "# Guide\nMore docs.\n",
      });
      const adapter = fake((name, question, request) => {
        const rule = (question.instructions as { rule?: string }).rule ?? "";
        if (rule.includes("TYPESAFE_API_KEY")) {
          return stateText(request).includes("console.log")
            ? fakeChoice(RULE_LABELS, "applicable_and_violated", 0.9)
            : fakeChoice(RULE_LABELS, "not_applicable", 0.9);
        }
        if (rule.includes("user-specific")) return fakeChoice(RULE_LABELS, "cannot_tell", 0.6);
        return aligned(name);
      });
      const packet = await check(
        { task: "Log the key", rules: { text: fixture("rules.json"), source: "rules.json" } },
        options(repo.root, adapter),
      );
      const ruleRequests = adapter.requests.filter((request) => asks(request, "rule_"));
      assert.equal(ruleRequests.length, 1, "docs/guide.md is out of every rule's scope");
      assert.equal(Object.keys(ruleRequests[0]!.questions).length, 2, "deterministic rules are not sent");
      const instructions = Object.values(ruleRequests[0]!.questions)[0]!.instructions as {
        workedExamples?: unknown[];
      };
      assert.equal(instructions.workedExamples?.length, 3);
      assert.deepEqual(
        packet.findings.map((finding) => [finding.flag, finding.detail?.rule]),
        [["rule_violation", "api-key-server-side"]],
      );
      assert.equal(packet.parked.length, 1);
      assert.ok(packet.parked[0]!.reason.includes("cannot_tell"));
      assert.ok(packet.notChecked.some((note) => note.includes("prettier-format")));
      assert.ok(!JSON.stringify(packet).includes('"compliant"'));
    } finally {
      repo.cleanup();
    }
  });

  test("more than twelve applicable rules are split across requests", async () => {
    const repo = tempRepo({ "src/a.ts": "export const a = 1;\n" });
    try {
      repo.write({ "src/a.ts": "export const a = 2;\n" });
      const rules = {
        version: 1,
        rules: Array.from({ length: 13 }, (_, index) => ({
          id: `r${index}`,
          class: "semantic",
          text: `Rule ${index}`,
        })),
      };
      const adapter = fake(aligned);
      const packet = await check(
        { task: "Set a to two", rules: { text: JSON.stringify(rules), source: "rules.json" } },
        options(repo.root, adapter),
      );
      assert.deepEqual(
        adapter.requests
          .filter((request) => asks(request, "rule_"))
          .map((request) => Object.keys(request.questions).length),
        [12, 1],
      );
      assert.equal(section(packet, "rules").length, 13);
      assert.equal(packet.coverage.candidates, 14, "one hunk plus thirteen rule-hunk pairs");
    } finally {
      repo.cleanup();
    }
  });
});

describe("check: one workflow", () => {
  test("gathers the diff once and reports every section in one packet and one run", async () => {
    const repo = criteriaRepo();
    try {
      const adapter = criteriaAdapter();
      const base = options(repo.root, adapter, { persist: true });
      let diffs = 0;
      const before = repo.git("status", "--porcelain");
      const dependencies = createWorkflowDependencies(repo.root, adapter);
      const source = {
        ...dependencies.source,
        collectDiff: (...args: Parameters<typeof dependencies.source.collectDiff>) => {
          diffs++;
          return dependencies.source.collectDiff(...args);
        },
      };
      const packet = await check(
        {
          task: TASK,
          rules: { text: fixture("rules.json"), source: "rules.json" },
          criteria: { text: CRITERIA, source: "argument" },
        },
        { ...base, dependencies: { ...dependencies, source } },
      );
      assert.equal(diffs, 1, "the diff is collected once for all sections");
      assert.equal(CHECK.name, "check");
      assert.equal(packet.workflow, "check@1");
      assert.match(packet.runId, /^check-/);
      assert.deepEqual(packet.summary.sections, ["task", "rules", "criteria"]);
      assert.deepEqual(
        [...new Set(packet.results.map((result) => result.section))],
        ["task", "rules", "criteria"],
      );
      for (const name of ["task", "rules", "criteria"]) assert.ok(packet.summary[name], name);
      assert.equal(new Set(packet.notChecked).size, packet.notChecked.length, "notChecked has no repeats");
      assert.ok(!packet.notChecked.some((note) => note.includes("supplied)")));
      // Dispositions from every section share one coverage count: 2 hunks + 2 rule pairs + 3 criteria.
      assert.equal(packet.coverage.candidates, 7);
      assert.equal(repo.git("status", "--porcelain"), before, "only ignored .stanley artifacts are written");
      assert.ok(packet.artifact?.startsWith(".stanley/runs/check-"));
    } finally {
      repo.cleanup();
    }
  });

  test("malformed optional inputs are rejected before any request is made", async () => {
    const repo = criteriaRepo();
    try {
      const adapter = fake();
      await assert.rejects(
        check({ task: TASK, rules: { text: "not json", source: "rules.json" } }, options(repo.root, adapter)),
        /rules file must be JSON/,
      );
      await assert.rejects(
        check(
          { task: TASK, criteria: { text: "just prose", source: "argument" } },
          options(repo.root, adapter),
        ),
        /no list items found/,
      );
      assert.equal(adapter.requests.length, 0);
    } finally {
      repo.cleanup();
    }
  });
});
