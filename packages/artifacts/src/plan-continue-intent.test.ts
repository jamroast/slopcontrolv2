import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PlanContinueIntentSchema,
  PLAN_CONTINUE_INTENT_FALLBACK,
  normalizePlanContinueIntentStructured,
  formatPlanContinueIntentPromptBlock,
} from "./plan-continue-intent.js";

describe("plan-continue-intent", () => {
  it("schema requires needsInvestigation, defaulting to false", () => {
    const parsed = PlanContinueIntentSchema.parse({ scope: "sections" });
    assert.equal(parsed.needsInvestigation, false);
    const withWalk = PlanContinueIntentSchema.parse({
      scope: "expand_scope",
      sections: ["Likely areas"],
      needsInvestigation: true,
    });
    assert.equal(withWalk.needsInvestigation, true);
  });

  it("classifier-failure fallback is neutral clarify_only (no investigation)", () => {
    assert.equal(PLAN_CONTINUE_INTENT_FALLBACK.scope, "clarify_only");
    assert.equal(PLAN_CONTINUE_INTENT_FALLBACK.needsInvestigation, false);
  });

  it("structured normalize does not promote scope from text expand cues", () => {
    const weak = normalizePlanContinueIntentStructured({
      scope: "narrow_scope",
      sections: [],
      focus: "management",
      preserve: ["unrelated modules"],
      needsInvestigation: false,
      notes: "",
    });
    // LLM/fallback already chose narrow — structured normalize must not re-scan chat.
    assert.equal(weak.scope, "narrow_scope");
    assert.equal(weak.focus, "management");
    assert.deepEqual(weak.preserve, ["unrelated modules"]);
  });

  it("structured normalize fills sections on expand_scope", () => {
    const expanded = normalizePlanContinueIntentStructured({
      scope: "expand_scope",
      sections: [],
      needsInvestigation: false,
      notes: "add chat",
    });
    assert.equal(expanded.scope, "expand_scope");
    assert.ok(expanded.sections.length >= 3);
  });

  it("structured normalize preserves needsInvestigation from classifier", () => {
    const withWalk = normalizePlanContinueIntentStructured({
      scope: "sections",
      sections: ["Likely areas"],
      needsInvestigation: true,
      notes: "flesh out paths",
    });
    assert.equal(withWalk.needsInvestigation, true);
    assert.deepEqual(withWalk.sections, ["Likely areas"]);
  });

  it("format block reopens locks on expand/full_revise", () => {
    const block = formatPlanContinueIntentPromptBlock({
      scope: "expand_scope",
      sections: ["Goal", "In scope"],
      needsInvestigation: false,
      notes: "add chat",
    });
    assert.match(block, /REOPENED/i);
    assert.match(block, /expand_scope/);
  });

});
