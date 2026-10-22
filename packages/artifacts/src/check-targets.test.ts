import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  extractCheckTargetPaths,
  formatCheckTargetsPromptBlock,
  formatGrepTokenMismatchesBlock,
  verifyCheckTargets,
  verifyGrepTokens,
} from "./check-targets.js";

const doc = `# Phase 9 — demo

## File Changes

| Path | Action |
| --- | --- |
| tests/integration/discovery.test.ts | NEW |
| scripts/verify-docs.mjs | exists |

Prose mention of src/prose-only.ts must be ignored.

\`\`\`bash
set -euo pipefail
grep -qF 'createApp' src/index.ts || exit 1
node scripts/verify-docs.mjs || exit 1
npx vitest run tests/integration/discovery.test.ts tests/unit/missing.test.ts || exit 1
grep -qF '/auth' docs/api/oidc.md || exit 1
grep -qE 'a.*b' 'glob/**/*.ts' || exit 1
curl -sS https://example.com/remote.md || exit 1
\`\`\`

~~~bash
grep -q 'ignored-not-a-shell-fence-marker' package.json || exit 1
~~~
`;

describe("extractCheckTargetPaths", () => {
  it("collects repo-relative paths from shell fences only", () => {
    const paths = extractCheckTargetPaths(doc);
    assert.deepEqual(paths, [
      "docs/api/oidc.md",
      "scripts/verify-docs.mjs",
      "src/index.ts",
      "tests/integration/discovery.test.ts",
      "tests/unit/missing.test.ts",
    ]);
    // Only ``` shells are Automated Check cells; ~~~ blocks are prose.
    assert.ok(!paths.includes("package.json"));
    assert.ok(!paths.includes("src/prose-only.ts"));
    assert.ok(!paths.some((p) => p.includes("*")));
    assert.ok(!paths.some((p) => p.includes("example.com")));
  });

  it("dedupes repeated targets", () => {
    const body = "```bash\ngrep -q x src/a.ts || exit 1\ngrep -q y src/a.ts || exit 1\n```";
    assert.deepEqual(extractCheckTargetPaths(body), ["src/a.ts"]);
  });
});

describe("verifyCheckTargets + prompt block", () => {
  it("marks existing and missing targets against the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-check-targets-"));
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests/integration"), { recursive: true });
    writeFileSync(join(root, "src/index.ts"), "export const x = 1;\n");
    mkdirSync(join(root, "tests/integration"), { recursive: true });
    writeFileSync(
      join(root, "tests/integration/discovery.test.ts"),
      "// test\n",
    );

    const targets = verifyCheckTargets(root, doc);
    const byPath = new Map(targets.map((t) => [t.path, t.exists]));
    assert.equal(byPath.get("src/index.ts"), true);
    assert.equal(byPath.get("tests/integration/discovery.test.ts"), true);
    assert.equal(byPath.get("scripts/verify-docs.mjs"), false);

    const block = formatCheckTargetsPromptBlock(targets);
    assert.match(block, /Automated Check targets \(verified by SlopControl/);
    assert.match(block, /- exists: src\/index\.ts/);
    // Declared in ## File Changes but not on disk yet → NEW, not MISSING.
    assert.match(block, /- NEW: scripts\/verify-docs\.mjs/);
    assert.match(block, /do not fail it for being absent from the research excerpt/);
    assert.match(block, /this phase creates it/);
  });

  it("keeps an undeclared absent path as MISSING", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-check-targets-missing-"));
    const targets = verifyCheckTargets(
      root,
      "## File Changes\n\n| Path | Action |\n| - | - |\n| src/a.ts | NEW |\n\n```bash\ngrep -q x src/a.ts || exit 1\ngrep -q y src/b.ts || exit 1\n```",
    );
    const block = formatCheckTargetsPromptBlock(targets);
    assert.match(block, /- NEW: src\/a\.ts/);
    assert.match(block, /- MISSING: src\/b\.ts/);
  });

  it("returns an empty block when no repo targets are referenced", () => {
    assert.equal(formatCheckTargetsPromptBlock([]), "");
  });
});

describe("verifyGrepTokens + mismatch block", () => {
  it("flags literal grep tokens absent from their target file", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-tokens-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "index.ts"),
      "export function createApp() {}\n",
    );

    const doc = "```bash\n" +
      "grep -qF 'createApp' src/index.ts || exit 1\n" +
      "grep -qF 'missingToken' src/index.ts || exit 1\n" +
      "grep -qE 'create(App|Widget)' src/index.ts || exit 1\n" +
      "```\n";

    const tokens = verifyGrepTokens(root, doc);
    const createApp = tokens.find((t) => t.token === "createApp");
    const missing = tokens.find((t) => t.token === "missingToken");
    assert.ok(createApp, "createApp should be extracted");
    assert.equal(createApp!.found, true);
    assert.ok(missing, "missingToken should be extracted");
    assert.equal(missing!.found, false);
    // Alternation / regex-group tokens are skipped (need a real engine).
    assert.ok(!tokens.some((t) => t.token.includes("create(App")));

    const block = formatGrepTokenMismatchesBlock(tokens);
    assert.match(block, /missingToken/);
    assert.doesNotMatch(block, /createApp/);
  });

  it("returns an empty block when every literal token is grounded", () => {
    assert.equal(formatGrepTokenMismatchesBlock([]), "");
    assert.equal(
      formatGrepTokenMismatchesBlock([
        { token: "x", path: "src/a.ts", found: true },
      ]),
      "",
    );
  });

  it("skips not-yet-created files and verifies root-level targets", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-newfile-"));
    writeFileSync(join(root, "package.json"), '{"name": "demo"}\n');
    mkdirSync(join(root, "src"), { recursive: true });

    const doc = "```bash\n" +
      "grep -qF 'export const Foo' src/new.ts || exit 1\n" +
      "grep -qF 'name' package.json || exit 1\n" +
      "```\n";

    const tokens = verifyGrepTokens(root, doc);
    // src/new.ts is declared-NEW and absent on disk → not a token mismatch.
    assert.ok(
      !tokens.some((t) => t.path === "src/new.ts"),
      "not-yet-created files must not emit a token mismatch",
    );
    // package.json is a root-level target and must be verified.
    const pkg = tokens.find((t) => t.path === "package.json");
    assert.ok(pkg, "root-level targets must be verified");
    assert.equal(pkg!.found, true);
    assert.equal(formatGrepTokenMismatchesBlock(tokens), "");
  });
});
