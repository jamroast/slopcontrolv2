import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  faultLegFromPhaseQualityVerdict,
  isPlanningJudgeInfraIssue,
  isIntentEngagementContradiction,
  mergeFaultLegs,
  planningGateIssueFingerprint,
  shouldContinuePlanningSelfHeal,
  shouldReclassifyIntentForPlanningSelfHeal,
  MAX_PLANNING_SELF_HEAL_ROUNDS,
  callPlanningJudgeWithInfraRetry,
  PlanningJudgeInfraError,
  phaseQualityRetryPrompt,
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

  it("phaseQualityRetryPrompt instructs a `# Phase …` title (matches validatePhaseDocForDev)", () => {
    const prompt = phaseQualityRetryPrompt({
      canonicalPath: ".slopcontrol/phases/25-x/PHASE.md",
      intentBlock: "intent",
      description: "desc",
      research: "research",
      judgeFeedback: "feedback",
    });
    assert.match(prompt, /starting with `# Phase …`/);
    assert.doesNotMatch(prompt, /starting with # Title/);
  });

  it("callPlanningJudgeWithInfraRetry surfaces the underlying cause on total failure", async () => {
    await assert.rejects(
      () =>
        callPlanningJudgeWithInfraRetry(
          async () => {
            throw new Error("JSON chat parse failed at position 1");
          },
          () => [],
          2,
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlanningJudgeInfraError);
        assert.ok(
          (err as Error).message.includes("JSON chat parse failed at position 1"),
          `message must carry the cause, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  it("callPlanningJudgeWithInfraRetry returns judgeInfraFailed on verdict-shaped infra issues", async () => {
    const { result, judgeInfraFailed } = await callPlanningJudgeWithInfraRetry(
      async () => ({ gaps: ["LLM judge failed"] }),
      (r: { gaps: string[] }) => r.gaps,
      2,
    );
    assert.equal(judgeInfraFailed, true);
    assert.deepEqual(result.gaps, ["LLM judge failed"]);
  });

  it("planningGateIssueFingerprint is stable for equivalent issue sets", () => {
    const a = planningGateIssueFingerprint([
      "No fill+submit proof at page mount",
      "Spec-only phase",
    ]);
    const b = planningGateIssueFingerprint([
      "  Spec-only phase  ",
      "No fill+submit proof at page mount",
    ]);
    assert.equal(a, b);
    assert.notEqual(a, "");
  });

  it("isIntentEngagementContradiction detects spec description vs fill+submit gate", () => {
    assert.equal(
      isIntentEngagementContradiction({
        gateIssues: ["No fill+submit proof at the page mount"],
        description: "Specify the foundation end-user authentication layer",
      }),
      true,
    );
    assert.equal(
      isIntentEngagementContradiction({
        gateIssues: ["Missing ## Scope section"],
        description: "Specify the auth layer",
      }),
      false,
    );
  });

  it("shouldReclassifyIntentForPlanningSelfHeal after repeated engagement faults", () => {
    const issues = ["No fill+submit proof at the page mount"];
    const fp = planningGateIssueFingerprint(issues);
    assert.equal(
      shouldReclassifyIntentForPlanningSelfHeal({
        gateIssues: issues,
        description: "Build the sign-up form",
        priorGateFingerprints: [fp],
        round: 1,
      }),
      true,
    );
    assert.equal(
      shouldReclassifyIntentForPlanningSelfHeal({
        gateIssues: issues,
        description: "Build the sign-up form",
        priorGateFingerprints: [],
        round: 0,
      }),
      false,
      "first round should not reclassify on repetition alone",
    );
  });
});
