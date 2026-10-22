import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectBuildToolchain,
  resolveProjectToolchain,
} from "./build-toolchain.js";
import {
  extractCheckTargetPaths,
  verifyCheckTargets,
  verifyGrepTokens,
  formatCheckTargetsPromptBlock,
  formatGrepTokenMismatchesBlock,
} from "./check-targets.js";
import {
  renderAutomatedChecksRules,
  validatePhaseDocForDev,
} from "./index.js";
import {
  collectProjectConventions,
  readProjectConventionsPromptBlock,
} from "./project-conventions.js";

/**
 * Rust pilot: drive the generic verification machinery (detection → spec →
 * rendered rules → check-target/grep-token gates → conventions) against a
 * real Rust project shape. Proves none of the planning-loop surface leaks
 * node-estate vocabulary or node-specific assumptions for a cargo project.
 */

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "rust-cli-project",
);
const PHASE_ID = "01-replay";
const phaseDoc = readFileSync(
  join(FIXTURE, ".slopcontrol", "phases", PHASE_ID, "PHASE.md"),
  "utf-8",
);

describe("rust pilot fixture", () => {
  it("detects rust-cargo from Cargo.toml and resolves the default spec", () => {
    const hint = detectBuildToolchain(FIXTURE);
    assert.equal(hint.kind, "rust-cargo");
    assert.equal(hint.hasDefaultSpec, true);
    assert.ok(hint.matched.includes("Cargo.toml"));

    const { spec, source } = resolveProjectToolchain({ projectRoot: FIXTURE });
    assert.equal(source, "default");
    assert.equal(spec?.kind, "rust-cargo");
    assert.deepEqual(spec?.targetedTestCmd, ["cargo", "test", "{ref}"]);
    assert.deepEqual(spec?.typecheckCmd, ["cargo", "check"]);
  });

  it("renders the check-authoring rules in cargo vocabulary", () => {
    const { spec } = resolveProjectToolchain({ projectRoot: FIXTURE });
    const rules = renderAutomatedChecksRules({
      toolchain: spec,
      hasTestServices: false,
    });
    assert.match(rules, /cargo test <test_name>/);
    assert.match(rules, /cargo check/);
    // No node-estate vocabulary — neither the test-runner wording nor the
    // JS-web UI guards (shared shell / mock class) may leak into a cargo render.
    assert.doesNotMatch(rules, /vitest|pnpm|npm test|next dev/);
    assert.doesNotMatch(rules, /App\.tsx|Menubar|\.env-pane|bg-muted/);
  });

  it("extracts check targets from a cargo-flavoured PHASE.md (paths only — a cargo test NAME is not a path)", () => {
    const targets = verifyCheckTargets(FIXTURE, phaseDoc);
    const byPath = new Map(targets.map((t) => [t.path, t]));
    // Existing file asserted by greps.
    assert.equal(byPath.get("src/lib.rs")?.exists, true);
    // Files this phase creates are marked NEW, not MISSING.
    const replay = byPath.get("src/replay.rs");
    assert.equal(replay?.exists, false);
    assert.equal(replay?.declared, true);
    const integration = byPath.get("tests/replay.rs");
    assert.equal(integration?.exists, false);
    assert.equal(integration?.declared, true);
    // The targeted test name (no slash, no extension) is never a target.
    assert.ok(!byPath.has("replay_counter_counts"));
    // Nothing is MISSING in a well-formed phase (entry lines, not the legend).
    const block = formatCheckTargetsPromptBlock(targets);
    assert.doesNotMatch(block, /^- MISSING:/m);
    assert.match(block, /^- NEW: src\/replay\.rs$/m);
  });

  it("extractCheckTargetPaths stays generic across ecosystems", () => {
    const paths = extractCheckTargetPaths(phaseDoc);
    assert.ok(paths.includes("src/lib.rs"));
    assert.ok(paths.includes("src/replay.rs"));
  });

  it("grep-token gate: present tokens ground, post-edit tokens on declared files do NOT false-flag", () => {
    const tokens = verifyGrepTokens(FIXTURE, phaseDoc);
    // 'pub fn parse_packet' exists on disk → positively grounded.
    const grounded = tokens.find((t) => t.token === "pub fn parse_packet");
    assert.equal(grounded?.found, true);
    // 'pub mod replay' is post-edit content on a declared-EDIT file → not a
    // mismatch (the old behaviour flagged it as a speculative string).
    assert.equal(tokens.some((t) => t.token === "pub mod replay"), false);
    assert.equal(formatGrepTokenMismatchesBlock(tokens), "");
  });

  it("grep-token gate still flags speculative strings in files the phase does NOT touch", () => {
    const speculative = phaseDoc.replace(
      "grep -q 'pub mod replay' src/lib.rs || exit 1",
      "grep -q 'tokio runtime' Cargo.toml || exit 1",
    );
    const tokens = verifyGrepTokens(FIXTURE, speculative);
    const bad = tokens.find((t) => t.token === "tokio runtime");
    assert.equal(bad?.found, false);
    assert.match(formatGrepTokenMismatchesBlock(tokens), /tokio runtime/);
  });

  it("structural gate accepts the rust PHASE.md", () => {
    const gate = validatePhaseDocForDev(phaseDoc, {
      projectRoot: FIXTURE,
      phaseId: PHASE_ID,
    });
    assert.deepEqual(gate.issues, []);
  });

  it("collects the project's declared conventions (AGENTS.md + CI run commands)", () => {
    const c = collectProjectConventions(FIXTURE);
    assert.ok(c);
    assert.ok(c.sources.includes("AGENTS.md"));
    assert.ok(
      c.sources.some((s) => s.startsWith(".github/workflows/")),
      "CI workflow cited as a source",
    );
    assert.match(c.docExcerpts[0]!.excerpt, /cargo test <test_name>/);
    assert.ok(c.ciCheckCommands.includes("cargo test --workspace"));
    assert.ok(
      c.ciCheckCommands.some((cmd) => cmd.includes("cargo clippy")),
      "block-scalar run commands extracted",
    );
  });

  it("conventions prompt block cites the committed artifact, phrased generically", () => {
    // The fixture commits the onboarding-produced artifact; prompts cite it.
    const block = readProjectConventionsPromptBlock(FIXTURE);
    assert.match(block, /The project's declared conventions/);
    assert.match(block, /cargo test <test_name>/);
    assert.match(block, /cargo clippy/);
    // The block's own prose names no ecosystem — only quoted project content does.
    const prose = block.split("\n").slice(0, 3).join("\n");
    assert.doesNotMatch(prose, /cargo|pnpm|pytest|vitest/i);
  });
});
