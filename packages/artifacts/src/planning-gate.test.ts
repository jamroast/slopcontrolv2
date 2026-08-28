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
} from "./planning-gate.js";
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
