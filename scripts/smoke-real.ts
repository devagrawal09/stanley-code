/**
 * Minimal live smoke test against TypeSafe Jev. Requires TYPESAFE_API_KEY in the environment
 * and makes a handful of small requests. Prints a sanitized summary only.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.env.TYPESAFE_API_KEY?.trim()) {
  console.log("smoke:real skipped: TYPESAFE_API_KEY is not set");
  process.exit(0);
}

const cli = resolve(import.meta.dirname, "../dist/cli.js");
const root = mkdtempSync(join(tmpdir(), "stanley-real-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
const write = (path: string, text: string) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};

try {
  git("init", "-q", "-b", "main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "smoke");
  write("src/price.js", "export function price(base) {\n  return base;\n}\n");
  write(
    "test/price.test.js",
    'import { price } from "../src/price.js";\ntest("price", () => {\n  expect(price(10)).toBe(10);\n});\n',
  );
  git("add", "-A");
  git("commit", "-qm", "init");
  write("src/price.js", "export function price(base, member) {\n  return member ? base * 0.9 : base;\n}\n");
  write(
    "test/price.test.js",
    'import { price } from "../src/price.js";\ntest("price", () => {\n  expect(price(10)).toBeDefined();\n});\n',
  );

  const result = spawnSync(process.execPath, [cli, "Give members a 10% discount", "--json", "--no-persist"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
  });
  const packet = JSON.parse(result.stdout) as {
    status: string;
    coverage: Record<string, unknown>;
    findings: Array<{ flag: string; path?: string; detail?: Record<string, unknown> }>;
    jev: Record<string, unknown>;
    results: Array<{
      section: string;
      path: string;
      taskRelation: { highMass: number } | null;
      changeKind: { label: string } | null;
      testExpectation: unknown;
      error: string | null;
    }>;
  };
  const key = process.env.TYPESAFE_API_KEY;
  if (result.stdout.includes(key) || result.stderr.includes(key))
    throw new Error("API key appeared in output");
  console.log(
    JSON.stringify(
      {
        exitCode: result.status,
        status: packet.status,
        coverage: packet.coverage,
        findings: packet.findings.map((finding) => ({
          flag: finding.flag,
          path: finding.path,
          detail: finding.detail,
        })),
        hunks: packet.results
          .filter((r) => r.section === "task")
          .map((r) => ({
            path: r.path,
            highMass: r.taskRelation?.highMass ?? null,
            changeKind: r.changeKind?.label ?? null,
            testExpectation: r.testExpectation,
            error: r.error,
          })),
        jev: packet.jev,
      },
      null,
      2,
    ),
  );
  process.exitCode = result.status === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
