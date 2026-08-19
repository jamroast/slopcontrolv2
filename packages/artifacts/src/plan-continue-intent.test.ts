import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackPlanContinueIntentFromText,
  normalizePlanContinueIntentStructured,
  formatPlanContinueIntentPromptBlock,
  textSignalsPlanExpand,
  textSignalsPlanInvestigate,
} from "./plan-continue-intent.js";

const CHAT_EXTEND_MSG = `I need you to now please investigate the project JamPress, and JamRoast.
First component a complex chat system for ai. Please research this, and present me with a plan`;

describe("plan-continue-intent", () => {
  it("expand: first component + present a plan → expand_scope", () => {
    assert.equal(textSignalsPlanExpand(CHAT_EXTEND_MSG), true);
    const fb = fallbackPlanContinueIntentFromText(CHAT_EXTEND_MSG);
    assert.equal(fb.scope, "expand_scope");
    assert.ok(fb.sections.length >= 3);
  });

  it("not only workflows must not force narrow_scope", () => {
    const msg =
      "vision of dealing with not only workflows, but CRM entity management";
    const fb = fallbackPlanContinueIntentFromText(msg);
    assert.notEqual(fb.scope, "narrow_scope");
  });

  it("structured normalize does not promote scope from text expand cues", () => {
    const weak = normalizePlanContinueIntentStructured({
      scope: "narrow_scope",
      sections: [],
      focus: "management",
      preserve: ["unrelated modules"],
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
      notes: "add chat",
    });
    assert.equal(expanded.scope, "expand_scope");
    assert.ok(expanded.sections.length >= 3);
  });

  it("format block reopens locks on expand/full_revise", () => {
    const block = formatPlanContinueIntentPromptBlock({
      scope: "expand_scope",
      sections: ["Goal", "In scope"],
      notes: "add chat",
    });
    assert.match(block, /REOPENED/i);
    assert.match(block, /expand_scope/);
  });

  it("textSignalsPlanInvestigate detects repo walk requests", () => {
    assert.equal(
      textSignalsPlanInvestigate(
        "Please investigate the JamPress codebase and flesh out Likely areas with real paths",
      ),
      true,
    );
    assert.equal(textSignalsPlanInvestigate("What does In scope mean?"), false);
  });
});
