import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESEARCH_ENGAGEMENT_SYSTEM_PROMPT,
  ResearchEngagementVerdictSchema,
  parseResearchEngagementVerdictPayload,
} from "./research-engagement-llm.js";

describe("research-engagement-llm", () => {
  it("system prompt teaches overclaim vs residual-risk semantics", () => {
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /~90%/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /already works/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /residual/i);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /hypothesis/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /parseToolResult/);
  });

  it("system prompt judges semantics, not keywords, and fails closed", () => {
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /SEMANTICS/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /fail closed/i);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /genuineGap=true/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /genuineGap=false/);
  });

  it("parses a genuine overclaim verdict with a suggested residual-risk line", () => {
    const verdict = ResearchEngagementVerdictSchema.parse({
      genuineGap: true,
      reason: "Research claims ~90% already works with no residual risk.",
      suggestedCheck:
        "Note the live AI SDK type: tool-<name> gap is unverified — parseToolResult never derives toolName.",
    });
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.suggestedCheck ?? "", /parseToolResult/);
  });

  it("parses a rejected-overclaim verdict with existing proof", () => {
    const verdict = parseResearchEngagementVerdictPayload({
      genuineGap: false,
      reason: "Research names a blocking gap in different words.",
      existingProof: "The form does not survive a reload; that is an open gap.",
    });
    assert.equal(verdict.genuineGap, false);
    assert.match(verdict.existingProof ?? "", /does not survive/);
  });

  it("fails closed on a messy payload", () => {
    const verdict = parseResearchEngagementVerdictPayload("garbage");
    assert.equal(verdict.genuineGap, true);
    assert.match(verdict.reason, /no reason/i);

    const missing = parseResearchEngagementVerdictPayload({ reason: "unsure" });
    assert.equal(missing.genuineGap, true);
  });

  it("drops blank optional fields", () => {
    const verdict = parseResearchEngagementVerdictPayload({
      genuineGap: true,
      reason: "overclaim is real",
      existingProof: "   ",
      suggestedCheck: "",
    });
    assert.equal(verdict.existingProof, undefined);
    assert.equal(verdict.suggestedCheck, undefined);
  });
});
