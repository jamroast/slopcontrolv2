import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosisForRunStage } from "./index.js";
import type { PersistedDiagnosis } from "./diagnosis.js";

const completeStub: PersistedDiagnosis = {
  audience: "coding",
  operatorActions: [],
  class: "product",
  confidence: "high",
  title: "Phase complete",
  rootCause: "Development completed successfully.",
  evidence: "",
  nextActions: "None — phase is complete.",
  fingerprint: "complete",
  codingAgentShouldFix: false,
  updatedAt: new Date().toISOString(),
};

describe("diagnosisForRunStage", () => {
  it("hides complete stubs while the run is still at a gate stage", () => {
    assert.equal(diagnosisForRunStage(completeStub, "in_review"), null);
    assert.equal(diagnosisForRunStage(completeStub, "accepted"), null);
    assert.equal(diagnosisForRunStage(completeStub, "developing"), null);
  });

  it("keeps complete stubs when the run is actually complete", () => {
    assert.equal(diagnosisForRunStage(completeStub, "complete"), completeStub);
  });

  it("keeps non-complete diagnosis at any stage", () => {
    const planning: PersistedDiagnosis = {
      ...completeStub,
      fingerprint: "planning-draft",
      title: "Draft gate failed",
    };
    assert.equal(diagnosisForRunStage(planning, "in_review"), planning);
  });
});
