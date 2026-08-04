import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fallbackPlanContinueIntentFromText,
  normalizePlanContinueIntent,
  formatPlanContinueIntentPromptBlock,
  textSignalsPlanExpand,
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

  it("normalize promotes weak sections/narrow to expand on clear expand cues", () => {
    const weak = normalizePlanContinueIntent(
      {
        scope: "narrow_scope",
        sections: [],
        focus: "management",
        preserve: ["unrelated modules"],
        notes: "",
      },
      CHAT_EXTEND_MSG,
    );
    assert.equal(weak.scope, "expand_scope");
    assert.equal(weak.focus, undefined);
    assert.equal(weak.preserve, undefined);
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
});
