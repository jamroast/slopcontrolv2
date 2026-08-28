import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildDevelopPhaseChecksRevisionFeedback,
  developFaultLegFromDiagnosis,
  developPhaseChecksSelfHealEligible,
  isPhaseChecksProcessFault,
  MAX_DEVELOP_PHASE_CHECKS_SELF_HEAL,
} from "./develop-fault-routing.js";

describe("develop fault routing", () => {
  it("routes duplicate-infra process failures to phase-checks", () => {
    const d = {
      class: "process",
      audience: "coding" as const,
      title: "Duplicate infra bring-up (container name conflict)",
      rootCause: "check re-upped postgres",
      nextActions: "Edit PHASE.md Automated Checks",
      tags: ["duplicate-infra", "container-conflict"],
      codingAgentShouldFix: true,
    };
    assert.equal(developFaultLegFromDiagnosis(d), "phase-checks");
    assert.ok(isPhaseChecksProcessFault(d));
    assert.ok(developPhaseChecksSelfHealEligible(d, { attemptsUsed: 0 }));
    assert.ok(
      !developPhaseChecksSelfHealEligible(d, {
        attemptsUsed: MAX_DEVELOP_PHASE_CHECKS_SELF_HEAL,
      }),
    );
  });

  it("routes api-routing process failures to product, not phase-checks", () => {
    const d = {
      class: "process",
      audience: "coding" as const,
      title: "Stream started hang — api-routing-complete-gate",
      rootCause: "missing model-resolver",
      nextActions: "implement routing files",
      tags: ["process"],
      codingAgentShouldFix: true,
    };
    assert.equal(developFaultLegFromDiagnosis(d), "product");
    assert.ok(!isPhaseChecksProcessFault(d));
  });

  it("routes operator infra to infra leg", () => {
    const d = {
      class: "infra",
      audience: "operator" as const,
      title: "Runtime dependency unavailable",
      rootCause: "ECONNREFUSED",
      nextActions: "restore postgres",
      codingAgentShouldFix: false,
    };
    assert.equal(developFaultLegFromDiagnosis(d), "infra");
    assert.ok(!developPhaseChecksSelfHealEligible(d));
  });

  it("routes phase-doc-validation step to phase-checks", () => {
    const d = {
      class: "process",
      audience: "coding" as const,
      title: "generic",
      rootCause: "",
      nextActions: "",
      codingAgentShouldFix: true,
    };
    assert.equal(
      developFaultLegFromDiagnosis(d, { failingStepName: "phase-doc-validation" }),
      "phase-checks",
    );
  });

  it("buildDevelopPhaseChecksRevisionFeedback includes diagnosis fields", () => {
    const fb = buildDevelopPhaseChecksRevisionFeedback({
      class: "process",
      audience: "coding",
      title: "CHECK_TIMEOUT on check 15",
      rootCause: "docker compose up hung",
      nextActions: "Remove docker compose up from Automated Checks.",
      codingAgentShouldFix: true,
    });
    assert.match(fb, /CHECK_TIMEOUT on check 15/);
    assert.match(fb, /Remove docker compose up/);
    assert.match(fb, /Preserve ## Scope/);
  });
});
