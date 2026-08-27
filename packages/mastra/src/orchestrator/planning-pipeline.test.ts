import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  faultLegFromPhaseQualityVerdict,
  isPlanningJudgeInfraIssue,
  mergeFaultLegs,
  shouldContinuePlanningSelfHeal,
  MAX_PLANNING_SELF_HEAL_ROUNDS,
} from "./planning-pipeline.js";

describe("planning-pipeline", () => {
  it("detects judge infra issues", () => {
    assert.equal(
      isPlanningJudgeInfraIssue("LLM judge failed"),
      true,
    );
    assert.equal(
      isPlanningJudgeInfraIssue("Missing /sign-in route"),
      false,
    );
  });

  it("merges fault legs", () => {
    assert.equal(mergeFaultLegs("research", "draft"), "both");
    assert.equal(mergeFaultLegs("draft", "none"), "draft");
  });

  it("derives fault leg from phase quality verdict", () => {
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: false,
        researchFaults: ["Thin RESEARCH — no route named"],
        draftFaults: [],
      }),
      "research",
    );
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: false,
        researchFaults: [],
        draftFaults: ["PHASE omitted grep proofs"],
      }),
      "draft",
    );
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: true,
        researchFaults: [],
        draftFaults: [],
      }),
      "none",
    );
  });

  it("shouldContinuePlanningSelfHeal advances content faults only", () => {
    const max = MAX_PLANNING_SELF_HEAL_ROUNDS;
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: 0,
        maxRounds: max,
      }),
      true,
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        judgeInfraFailed: true,
        round: 0,
        maxRounds: max,
      }),
      false,
      "infra failure must not burn self-heal rounds",
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "none",
        round: 0,
        maxRounds: max,
      }),
      false,
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: max - 1,
        maxRounds: max,
      }),
      false,
      "last round must not continue",
    );
  });
});
