import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INTENT_ALIGNMENT_SYSTEM_PROMPT,
  IntentAlignmentVerdictSchema,
  parseIntentAlignmentVerdictPayload,
} from "./intent-alignment-llm.js";

describe("intent-alignment-llm", () => {
  it("system prompt teaches the bubble-mount vocabulary the regex misses", () => {
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /FormBubble/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /sendFormAnswer/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /composerMode/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /composer-form/);
  });

  it("system prompt judges semantics, not keywords, and fails closed", () => {
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /SEMANTICS/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /fail closed/i);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /genuineGap=true/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /genuineGap=false/);
  });

  it("system prompt rejects chip/taxonomy-only and mount conflicts", () => {
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /Chip\/taxonomy-only/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /getFormPartState/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /OPPOSITE mount/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /Scope and Blueprint Deltas/);
  });

  it("parses a genuine-gap verdict with a suggested check", () => {
    const verdict = IntentAlignmentVerdictSchema.parse({
      genuineGap: true,
      reason: "PHASE only greps the summary chip; no fillable mount proof.",
      suggestedCheck:
        "grep -q 'sendFormAnswer' src/FormBubble.tsx && grep -q 'data-testid=\"form-bubble\"' src/FormBubble.tsx",
    });
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.suggestedCheck ?? "", /sendFormAnswer/);
  });

  it("parses a rejected-gap verdict with existing proof", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      genuineGap: false,
      reason: "Playwright test fills and submits the FormBubble at the bubble mount.",
      existingProof: "pnpm exec playwright test form-bubble.spec.ts",
    });
    assert.equal(verdict.genuineGap, false);
    assert.match(verdict.existingProof ?? "", /playwright/);
  });

  it("fails closed on a messy payload", () => {
    const verdict = parseIntentAlignmentVerdictPayload("garbage");
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.reason, /no reason/i);

    const missing = parseIntentAlignmentVerdictPayload({ reason: "unsure" });
    assert.equal(missing.genuineGap, true);
  });

  it("drops blank optional fields", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      genuineGap: true,
      reason: "gap is real",
      existingProof: "   ",
      suggestedCheck: "",
    });
    assert.equal(verdict.existingProof, undefined);
    assert.equal(verdict.suggestedCheck, undefined);
  });
});
