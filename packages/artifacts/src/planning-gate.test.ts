import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  restorePhaseDocSnapshot,
  restoreResearchSnapshot,
  writePhaseDoc,
  writeResearch,
  readPhaseDoc,
  readResearch,
} from "./index.js";
import {
  buildPhaseDocRepairPrompt,
  renderAutomatedChecksRules,
  PLANNING_AUTOMATED_CHECKS_RULES,
} from "./planning-gate.js";
import { defaultToolchainSpec } from "./build-toolchain.js";
import { buildPlanningGateBlockedDiagnosis } from "./revision-outcome.js";

describe("planning gate helpers", () => {
  it("restorePhaseDocSnapshot reverts corrupted on-disk PHASE.md", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-plan-gate-"));
    try {
      const prior = "# Phase\n\n## Scope\nok\n";
      writePhaseDoc(root, "01-test", prior);
      writePhaseDoc(root, "01-test", "# bad\n\ndocker compose up -d\n");
      restorePhaseDocSnapshot(root, "01-test", prior);
      assert.equal(readPhaseDoc(root, "01-test").trim(), prior.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restoreResearchSnapshot reverts corrupted RESEARCH.md", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-plan-gate-"));
    try {
      const prior = "# Research\n\nEvidence\n";
      writeResearch(root, "01-test", prior);
      writeResearch(root, "01-test", "too thin");
      restoreResearchSnapshot(root, "01-test", prior);
      assert.equal(readResearch(root, "01-test").trim(), prior.trim());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("buildPhaseDocRepairPrompt includes automated checks contract", () => {
    const prompt = buildPhaseDocRepairPrompt({
      issues: ["long-lived server in check"],
      intentBlock: "intent",
      canonicalPath: ".slopcontrol/phases/x/PHASE.md",
      phaseDescription: "desc",
      research: "research",
    });
    assert.ok(prompt.includes("test-services"));
    assert.ok(
      !prompt.includes("MUST use:"),
      "contract no longer mandates docker bring-up",
    );
  });

  it("automated-checks contract requires a shared-shell regression guard", () => {
    assert.match(PLANNING_AUTOMATED_CHECKS_RULES, /Shared shell regression guard/);
    assert.match(PLANNING_AUTOMATED_CHECKS_RULES, /vendor, remove, or structurally rewrite/);
    assert.match(PLANNING_AUTOMATED_CHECKS_RULES, /Mock class fidelity guard/);
    assert.match(PLANNING_AUTOMATED_CHECKS_RULES, /componentStyles/);
    const prompt = buildPhaseDocRepairPrompt({
      issues: ["missing section"],
      intentBlock: "intent",
      canonicalPath: ".slopcontrol/phases/x/PHASE.md",
      phaseDescription: "desc",
      research: "research",
    });
    assert.match(prompt, /Shared shell regression guard/);
  });

  it("buildPhaseDocRepairPrompt instructs a `# Phase …` title (matches validatePhaseDocForDev)", () => {
    const prompt = buildPhaseDocRepairPrompt({
      issues: ["missing section"],
      intentBlock: "intent",
      canonicalPath: ".slopcontrol/phases/x/PHASE.md",
      phaseDescription: "desc",
      research: "research",
    });
    assert.match(prompt, /starting with `# Phase …`/);
    assert.doesNotMatch(prompt, /starting with # Title/);
  });

  it("buildPlanningGateBlockedDiagnosis tags planning gate blocked", () => {
    const d = buildPlanningGateBlockedDiagnosis({
      issues: ["Automated Checks: long-lived server"],
      phaseId: "p1",
      runId: "r1",
      restoredSnapshot: true,
    });
    assert.ok(d.tags?.includes("planning-gate-blocked"));
    assert.match(d.title, /restored/i);
  });
});

describe("renderAutomatedChecksRules toolchain rendering", () => {
  it("node-pnpm default keeps legacy vitest vocabulary", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("node-pnpm"),
      hasTestServices: true,
    });
    assert.match(rules, /npx vitest run <file>/);
    assert.match(rules, /tsc --noEmit/);
    assert.match(rules, /next dev/);
    assert.match(rules, /Shared shell regression guard/);
  });

  it("every render carries the grep-token grounding contract", () => {
    // The drafter must ground tokens itself (RESEARCH quotes or read_file
    // verification) and re-scope rather than re-assert flagged tokens — the
    // judge enforces grounding, so the drafter's contract must state it.
    for (const kind of ["node-pnpm", "rust-cargo", "go", "python"] as const) {
      const rules = renderAutomatedChecksRules({
        toolchain: defaultToolchainSpec(kind),
        hasTestServices: true,
      });
      assert.match(rules, /Ground every grep token/, `${kind} render`);
      assert.match(rules, /## Check targets \(verified\)/, `${kind} render`);
      assert.match(rules, /never re-assert the flagged token/, `${kind} render`);
    }
  });

  it("rust-cargo renders cargo vocabulary and no node-estate commands", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("rust-cargo"),
      hasTestServices: true,
    });
    assert.match(rules, /cargo test <test_name>/);
    assert.match(rules, /cargo check/);
    assert.match(rules, /cargo run/);
    assert.doesNotMatch(rules, /vitest/);
    assert.doesNotMatch(rules, /pnpm/);
    assert.doesNotMatch(rules, /next dev/);
    // Universal invariants still present.
    assert.match(rules, /grep -q/);
    // UI guards are node-web-only (design-verify is JS today) — they must
    // not leak estate vocabulary into a cargo render.
    assert.doesNotMatch(rules, /Shared shell regression guard/);
    assert.doesNotMatch(rules, /Mock class fidelity guard/);
  });

  it("go renders go test / go vet vocabulary", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("go"),
      hasTestServices: true,
    });
    assert.match(rules, /go test/);
    assert.match(rules, /go vet/);
    assert.doesNotMatch(rules, /vitest/);
    assert.doesNotMatch(rules, /cargo/);
  });

  it("python renders pytest vocabulary", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("python"),
      hasTestServices: true,
    });
    assert.match(rules, /pytest <file>::<test_name>/);
    assert.doesNotMatch(rules, /vitest/);
    assert.doesNotMatch(rules, /cargo/);
  });

  it("hasTestServices=false switches to self-contained probe guidance", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("node-pnpm"),
      hasTestServices: false,
    });
    assert.match(rules, /self-contained/);
    assert.match(rules, /docker compose up -d <svc>/);
    assert.doesNotMatch(
      rules,
      /SlopControl verify already brings up test-services/,
    );
  });

  it("hasTestServices=true bans infra restarts", () => {
    const rules = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("rust-cargo"),
      hasTestServices: true,
    });
    assert.match(rules, /verify already brings up test-services/);
    assert.match(rules, /Do NOT `docker compose up`/);
  });

  it("buildPhaseDocRepairPrompt honours a checkRules override", () => {
    const custom = renderAutomatedChecksRules({
      toolchain: defaultToolchainSpec("rust-cargo"),
      hasTestServices: true,
    });
    const prompt = buildPhaseDocRepairPrompt({
      issues: ["x"],
      intentBlock: "intent",
      canonicalPath: ".slopcontrol/phases/x/PHASE.md",
      phaseDescription: "desc",
      research: "research",
      checkRules: custom,
    });
    assert.match(prompt, /cargo test <test_name>/);
    assert.doesNotMatch(prompt, /npx vitest run/);
  });
});
