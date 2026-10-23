import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  extractCheckTargetPaths,
  fileChangesDeclaresProductCode,
  formatCheckTargetsPromptBlock,
  formatGrepTokenMismatchesBlock,
  formatResearchMandatedTokensBlock,
  formatVerifiedGrepTokensBlock,
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

  it("captures single-quoted patterns containing inner double quotes", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-quoted-"));
    writeFileSync(join(root, "ACCEPTANCE.json"), '{"version": 2}\n');

    // The phase-201 "unquoted JSON token" shape: the pattern is a JSON token
    // with inner double quotes, wrapped in shell single quotes.
    const doc = "```bash\n" +
      "grep -qF '\"version\": 2' ACCEPTANCE.json || exit 1\n" +
      "grep -qF '\"version\": 3' ACCEPTANCE.json || exit 1\n" +
      "```\n";

    const tokens = verifyGrepTokens(root, doc);
    const present = tokens.find((t) => t.token === '"version": 2');
    const absent = tokens.find((t) => t.token === '"version": 3');
    assert.ok(present, "inner-quoted pattern must be extracted");
    assert.equal(present!.found, true);
    assert.ok(absent, "absent inner-quoted pattern must be extracted");
    assert.equal(absent!.found, false);

    const block = formatGrepTokenMismatchesBlock(tokens);
    assert.match(block, /"version": 3/);
    assert.doesNotMatch(block, /"version": 2/);
  });
});

describe("formatVerifiedGrepTokensBlock", () => {
  it("lists found tokens as grounded and omits mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-verified-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "src", "island.tsx"),
      'const onMessage = (event: MessageEvent) => {\n' +
        "  if (!isReadyMessage(event.data)) return;\n" +
        "};\n" +
        'window.addEventListener("message", onMessage);\n',
    );

    // The shapes that actually looped in practice: plain `grep -q` (BRE)
    // patterns containing parens/dots — literal in BRE, dot self-matches.
    const doc = "```bash\n" +
      "grep -q 'isReadyMessage(event.data)' src/island.tsx || exit 1\n" +
      "grep -q 'window.addEventListener(\"message\", onMessage)' src/island.tsx || exit 1\n" +
      "grep -qF 'speculativeToken' src/island.tsx || exit 1\n" +
      "```\n";
    const tokens = verifyGrepTokens(root, doc);

    const block = formatVerifiedGrepTokensBlock(tokens);
    assert.match(block, /## Verified grep tokens/);
    assert.match(block, /isReadyMessage\(event\.data\)/);
    assert.match(block, /window\.addEventListener/);
    assert.match(block, /src\/island\.tsx/);
    assert.match(block, /treat them as grounded/);
    assert.doesNotMatch(block, /speculativeToken/);
    // The same tokens still feed the mismatch block independently.
    assert.match(formatGrepTokenMismatchesBlock(tokens), /speculativeToken/);
  });

  it("verifies BRE-literal parens in both directions and keeps ERE groups skipped", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-bre-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "timer.ts"), "void signIn(\"jamauth\");\n");

    const doc = "```bash\n" +
      "grep -q 'signIn(' src/timer.ts || exit 1\n" +
      "grep -q 'removedCall(' src/timer.ts || exit 1\n" +
      "grep -qE 'create(App|Widget)' src/timer.ts || exit 1\n" +
      "```\n";
    const tokens = verifyGrepTokens(root, doc);
    // BRE-literal paren, no dot: both directions are sound.
    assert.equal(
      tokens.find((t) => t.token === "signIn(")?.found,
      true,
    );
    assert.equal(
      tokens.find((t) => t.token === "removedCall(")?.found,
      false,
    );
    // ERE groups still need a real engine — never extracted.
    assert.ok(!tokens.some((t) => t.token.includes("create(App")));
  });

  it("verifies dot-bearing BRE patterns found-only (absent verdict unsound)", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-dotonly-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "event.data\n");

    const doc = "```bash\n" +
      "grep -q 'event.data' src/a.ts || exit 1\n" +
      "grep -q 'missing.token' src/a.ts || exit 1\n" +
      "```\n";
    const tokens = verifyGrepTokens(root, doc);
    assert.equal(tokens.find((t) => t.token === "event.data")?.found, true);
    // Absent dot-only pattern is skipped, never a false mismatch.
    assert.ok(!tokens.some((t) => t.token === "missing.token"));
    assert.equal(formatGrepTokenMismatchesBlock(tokens), "");
  });

  it("returns an empty block when nothing verified on disk", () => {
    assert.equal(formatVerifiedGrepTokensBlock([]), "");
    assert.equal(
      formatVerifiedGrepTokensBlock([
        { token: "x", path: "src/a.ts", found: false },
      ]),
      "",
    );
  });

  it("caps the rendered list", () => {
    const tokens = Array.from({ length: 50 }, (_, i) => ({
      token: `token${i}`,
      path: "src/a.ts",
      found: true,
    }));
    const block = formatVerifiedGrepTokensBlock(tokens);
    assert.match(block, /token39/);
    assert.doesNotMatch(block, /token40/);
  });
});

describe("File Changes fence handling", () => {
  // jamauth phase-202 shape: File Changes item 1 carries a mandated
  // implementation fence; every item after that fence is still a declaration.
  const fencedDoc =
    "## File Changes\n\n" +
    "1. **`src/first.ts`** — edit the relay.\n" +
    "   ```ts\n" +
    "   const mandated = snippet();\n" +
    "   ```\n" +
    "2. **`src/schema.ts`** — add the `widgets` table.\n\n" +
    "## Automated Checks\n\n" +
    "```bash\n" +
    "grep -q \"pgTable('widgets'\" src/schema.ts || exit 1\n" +
    "```\n";

  it("keeps the declared-file exemption for items after the first fence", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-fence-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "schema.ts"), "export const existing = 1;\n");

    const tokens = verifyGrepTokens(root, fencedDoc);
    // Post-edit token in a file declared AFTER the first File Changes fence:
    // expected post-edit content, not a mismatch.
    assert.ok(!tokens.some((t) => t.token === "pgTable('widgets'"));
    assert.equal(formatGrepTokenMismatchesBlock(tokens), "");
  });

  it("classifies paths declared after the first fence as declared", () => {
    const declared = verifyCheckTargets("/nonexistent-root", fencedDoc);
    const schema = declared.find((t) => t.path === "src/schema.ts");
    assert.ok(schema, "src/schema.ts should be extracted as a target");
    assert.equal(schema!.declared, true);
    assert.equal(schema!.exists, false);
  });
});

describe("negated grep assertions", () => {
  it("never reports absence assertions as token mismatches", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-grep-neg-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "schema.ts"), "export const t = 1;\n");

    const doc =
      "```bash\n" +
      "grep -q 'export const t' src/schema.ts || exit 1\n" +
      "! grep -q \"text('token')\" src/schema.ts || exit 1\n" +
      "if ! grep -q 'forbiddenColumn' src/schema.ts; then\n" +
      "  exit 1\n" +
      "fi\n" +
      "```\n";

    const tokens = verifyGrepTokens(root, doc);
    // Negated greps assert ABSENCE — token existence is not their grounding
    // question; they must never appear in verification results at all.
    assert.ok(!tokens.some((t) => t.token === "text('token')"));
    assert.ok(!tokens.some((t) => t.token === "forbiddenColumn"));
    // The positive assertion is still verified.
    assert.equal(tokens.find((t) => t.token === "export const t")?.found, true);
    assert.equal(formatGrepTokenMismatchesBlock(tokens), "");
  });
});

describe("research-mandated partition", () => {
  it("routes absent research-quoted tokens to the mandated block, not mismatches", () => {
    const tokens = [
      {
        token: "pgTable('auth_events'",
        path: "src/lib/db/schema.ts",
        found: false,
      },
      { token: "speculativeToken", path: "src/lib/oidc/embed.ts", found: false },
      { token: "onDisk", path: "src/a.ts", found: true },
    ];
    const research =
      "## 5. Check targets (verified)\n\n" +
      "| 5 | `src/lib/db/schema.ts` (new table) | to-be-created | `pgTable('auth_events'` with `text('event_type')` |\n";

    const mandated = formatResearchMandatedTokensBlock(tokens, research);
    assert.match(mandated, /Research-mandated new-content tokens/);
    assert.match(mandated, /pgTable\('auth_events'/);
    assert.match(mandated, /absence on disk is expected/);
    assert.match(mandated, /do NOT fail them as unverified/);
    assert.doesNotMatch(mandated, /speculativeToken/);
    assert.doesNotMatch(mandated, /onDisk/);

    const mismatches = formatGrepTokenMismatchesBlock(tokens, research);
    assert.match(mismatches, /speculativeToken/);
    assert.doesNotMatch(mismatches, /pgTable/);
    // Residual wording: judge on evidence; never re-assert unchanged, never
    // demand an on-disk token for content the phase creates.
    assert.match(mismatches, /never ask the drafter to re-assert/);
    assert.match(mismatches, /never demand an on-disk token/);
  });

  it("stays backward-compatible without research text", () => {
    const tokens = [
      { token: "absent", path: "src/a.ts", found: false },
    ];
    const legacy = formatGrepTokenMismatchesBlock(tokens);
    assert.match(legacy, /absent/);
    assert.equal(formatResearchMandatedTokensBlock(tokens, ""), "");
  });

  it("grounds research-quoted post-edit tokens even in undeclared files", () => {
    // Drafter greps post-edit content in an existing file it failed to
    // declare; RESEARCH quoted the exact literal → mandated block, not a
    // mismatch. The unquoted token stays in the fail-closed residual.
    const root = mkdtempSync(join(tmpdir(), "slop-grep-mandated-"));
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "schema.ts"), "export const existing = 1;\n");

    const doc =
      "```bash\n" +
      "grep -q \"pgTable('widgets'\" src/schema.ts || exit 1\n" +
      "grep -q 'mysteryToken' src/schema.ts || exit 1\n" +
      "```\n";
    const research =
      "## Check targets (verified)\n\n" +
      "- `pgTable('widgets'` — to-be-created in `src/schema.ts`\n";

    const tokens = verifyGrepTokens(root, doc);
    assert.equal(
      tokens.find((t) => t.token === "pgTable('widgets'")?.found,
      false,
    );
    assert.equal(tokens.find((t) => t.token === "mysteryToken")?.found, false);

    const mandated = formatResearchMandatedTokensBlock(tokens, research);
    assert.match(mandated, /pgTable\('widgets'/);
    assert.doesNotMatch(mandated, /mysteryToken/);

    const mismatches = formatGrepTokenMismatchesBlock(tokens, research);
    assert.match(mismatches, /mysteryToken/);
    assert.doesNotMatch(mismatches, /pgTable/);
  });
});

describe("fileChangesDeclaresProductCode", () => {
  it("true when File Changes declares code paths", () => {
    const doc = `# Phase

## File Changes

| Path | Action |
| --- | --- |
| src/lib/db/schema.ts | EDIT |
| tests/embedding-constraint.test.ts | NEW |

## Success Criteria
`;
    assert.equal(fileChangesDeclaresProductCode(doc), true);
  });

  it("true for declarations after a fenced snippet (the phase-202 truncation)", () => {
    const doc = `# Phase

## File Changes

\`\`\`ts
// mandated implementation snippet (NOT a declaration)
import { pgTable } from "drizzle-orm";
\`\`\`

Then: EDIT src/lib/oidc/embed.ts with the narrowed cookie relay.
Also: EDIT package.json (add @playwright/test devDependency).

## Success Criteria
`;
    assert.equal(fileChangesDeclaresProductCode(doc), true);
  });

  it("false when only planning artifacts are declared", () => {
    const doc = `# Phase

## File Changes

| Path | Action |
| --- | --- |
| .slopcontrol/phases/01-x/PHASE.md | EDIT |
| .slopcontrol/RESEARCH.md | NEW |

## Success Criteria
`;
    assert.equal(fileChangesDeclaresProductCode(doc), false);
  });

  it("false for an empty File Changes section", () => {
    const doc = `# Phase

## File Changes

None.

## Success Criteria
`;
    assert.equal(fileChangesDeclaresProductCode(doc), false);
  });
});
