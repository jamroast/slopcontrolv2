import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  extractCheckTargetPaths,
  formatCheckTargetsPromptBlock,
  verifyCheckTargets,
} from "./check-targets.js";

const doc = `# Phase 9 — demo

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
    assert.match(block, /- MISSING: scripts\/verify-docs\.mjs/);
    assert.match(block, /do not fail it for being absent from the research excerpt/);
  });

  it("returns an empty block when no repo targets are referenced", () => {
    assert.equal(formatCheckTargetsPromptBlock([]), "");
  });
});
