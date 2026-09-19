/**
 * Stale-name audit. The product is Stanley; "Jev" may appear only where it names TypeSafe's Jev model, SDK,
 * API, or the Jev-first architecture. Product-owned identifiers derived from the old name are forbidden except
 * for historical package references and the decision log.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SCANNED = [
  "README.md",
  "package.json",
  "package-lock.json",
  "biome.json",
  ".gitignore",
  "docs",
  "src",
  "test",
  "scripts",
  "examples",
  ".github",
];
const TEXT = /\.(?:ts|js|json|md|yml|yaml|txt)$|^\.gitignore$/;

/** Product-owned uses of the old name. Case-insensitive; matches `jev-code`, `jev_code`, `jevcode`, `.jev-code`. */
const FORBIDDEN = /jev[-_]?code/gi;

/** Tolerated occurrences are historical package references; the repository URL uses Stanley. */
const ALLOWED_CONTEXT = [
  /package name must be exactly stanley-code/,
  /"jev-code", "@devagrawal09\/stanley"/,
  /someone\/jev-code/,
  /`jev-code`\s+(?:package|placeholder|name)/i,
  /\(formerly jev-code\)/i,
];

function walk(path: string): string[] {
  const info = statSync(path);
  if (info.isFile()) return TEXT.test(path.split(sep).at(-1)!) ? [path] : [];
  // The decision log is the historical record of the rename and must be able to name the old identifiers.
  const skipped = new Set(["node_modules", "fixtures", "naming.test.ts", "decision-log.md"]);
  return readdirSync(path)
    .filter((name) => !skipped.has(name))
    .flatMap((name) => walk(join(path, name)));
}

describe("naming", () => {
  test("no product-owned surface still uses the jev-code name", () => {
    const offenders: string[] = [];
    for (const entry of SCANNED) {
      for (const file of walk(join(ROOT, entry))) {
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, index) => {
          if (!FORBIDDEN.test(line)) return;
          FORBIDDEN.lastIndex = 0;
          if (ALLOWED_CONTEXT.some((pattern) => pattern.test(line))) return;
          offenders.push(`${relative(ROOT, file)}:${index + 1}: ${line.trim()}`);
        });
        FORBIDDEN.lastIndex = 0;
      }
    }
    assert.deepEqual(offenders, []);
  });

  test("package, binary, state directory, and schemas carry the Stanley name", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
      description: string;
    };
    assert.equal(manifest.name, "stanley-code");
    assert.deepEqual(manifest.bin, { stanley: "dist/cli.js" });
    assert.match(manifest.description, /Stanley/);
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      name: string;
      packages: Record<string, { name?: string; bin?: Record<string, string> }>;
    };
    assert.equal(lock.name, "stanley-code");
    assert.equal(lock.packages[""]?.name, "stanley-code");
    assert.deepEqual(lock.packages[""]?.bin, { stanley: "dist/cli.js" });
    const source = [
      "src/workflows/types.ts",
      "src/cli/prompt-result.ts",
      "src/workflows/improve.ts",
      "src/adapters/recorder.ts",
      "src/adapters/workflows.ts",
    ].map((path) => readFileSync(join(ROOT, path), "utf8"));
    for (const schema of ["stanley.packet/v1", "stanley.run/v1", "stanley.prompt-result/v1"]) {
      assert.ok(
        source.some((text) => text.includes(`"${schema}"`)),
        schema,
      );
    }
    assert.ok(source.some((text) => text.includes('STATE_DIRECTORY = ".stanley"')));
    assert.ok(source.some((text) => text.includes('WORKFLOW_DIRECTORY = ".stanley/workflows"')));
    assert.match(readFileSync(join(ROOT, ".gitignore"), "utf8"), /^\.stanley\/$/m);
  });

  test("Jev remains only as the TypeSafe technology name", () => {
    // These identifiers are correct and must not be renamed just to remove the vendor's brand.
    const keep = [
      ["src/core/types.ts", "JevPort"],
      ["src/adapters/jev.ts", "TypeSafeClient"],
      ["src/adapters/fake-jev.ts", "createFakeAdapter"],
      ["src/adapters/config.ts", "jevFromEnvironment"],
      ["src/workflows/types.ts", 'DEFAULT_MODEL = "jev-'],
    ] as const;
    for (const [path, needle] of keep) {
      assert.ok(readFileSync(join(ROOT, path), "utf8").includes(needle), `${path} keeps ${needle}`);
    }
  });
});
