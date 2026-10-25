import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INTENT_ALIGNMENT_SYSTEM_PROMPT,
  IntentAlignmentVerdictSchema,
  parseIntentAlignmentVerdictPayload,
} from "./intent-alignment-llm.js";

describe("intent-alignment-llm", () => {
  it("system prompt teaches mount and interaction vocabulary", () => {
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /composer vs bubble vs page/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /faultLeg/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /NO interaction block/);
  });

  it("system prompt sanctions a non-live-server fill/submit proof for node", () => {
    // The intent judge used to name playwright as canonical proof evidence,
    // which let it recommend a `webServer` harness the Automated Checks rules
    // forbid — the two gates then fought forever.
    assert.doesNotMatch(INTENT_ALIGNMENT_SYSTEM_PROMPT, /grep\/playwright\/vitest commands/);
    assert.doesNotMatch(INTENT_ALIGNMENT_SYSTEM_PROMPT, /grep\/playwright/);
    assert.match(
      INTENT_ALIGNMENT_SYSTEM_PROMPT,
      /build\/typecheck or a short Node one-shot/,
    );
  });

  it("system prompt judges semantics, not keywords, and fails closed", () => {    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /SEMANTICS/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /fail closed/i);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /aligned=true/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /aligned=false/);
  });

  it("system prompt rejects chip/taxonomy-only and mount conflicts", () => {
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /chip\/taxonomy-only/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /getFormPartState/);
    assert.match(INTENT_ALIGNMENT_SYSTEM_PROMPT, /OPPOSITE mount/);
  });

  it("parses an aligned verdict", () => {
    const verdict = IntentAlignmentVerdictSchema.parse({
      aligned: true,
      gaps: [],
      suggestedLines: [],
    });
    assert.equal(verdict.aligned, true);
    assert.deepEqual(verdict.gaps, []);
  });

  it("parses a not-aligned verdict with gaps and suggested lines", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      aligned: false,
      gaps: ["PHASE only greps the summary chip; no fillable mount proof."],
      suggestedLines: [
        "grep -q 'sendFormAnswer' src/FormBubble.tsx && grep -q 'data-testid=\"form-bubble\"' src/FormBubble.tsx",
      ],
    });
    assert.equal(verdict.aligned, false);
    assert.match(verdict.gaps[0] ?? "", /summary chip/);
    assert.match(verdict.suggestedLines[0] ?? "", /sendFormAnswer/);
  });

  it("fails closed on a messy payload", () => {
    const verdict = parseIntentAlignmentVerdictPayload("garbage");
    assert.equal(verdict.aligned, false);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);

    const missing = parseIntentAlignmentVerdictPayload({ gaps: [] });
    assert.equal(missing.aligned, false);
  });

  it("parses faultLeg on misaligned verdict", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      aligned: false,
      gaps: ["PHASE lacks mount proof"],
      suggestedLines: ["grep SignIn"],
      faultLeg: "research",
    });
    assert.equal(verdict.faultLeg, "research");
  });

  it("defaults faultLeg to draft when misaligned without leg", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      aligned: false,
      gaps: ["PHASE lacks mount proof"],
      suggestedLines: [],
    });
    assert.equal(verdict.faultLeg, "draft");
  });

  it("drops blank gap/suggestion entries", () => {
    const verdict = parseIntentAlignmentVerdictPayload({
      aligned: false,
      gaps: ["real gap", "   ", ""],
      suggestedLines: ["fix it", ""],
    });
    assert.deepEqual(verdict.gaps, ["real gap"]);
    assert.deepEqual(verdict.suggestedLines, ["fix it"]);
  });
});
