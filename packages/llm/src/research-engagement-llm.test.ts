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
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /overclaims=true/);
    assert.match(RESEARCH_ENGAGEMENT_SYSTEM_PROMPT, /overclaims=false/);
  });

  it("parses an overclaim verdict with a suggested residual-risk line", () => {
    const verdict = ResearchEngagementVerdictSchema.parse({
      overclaims: true,
      gaps: ["Research claims ~90% already works with no residual risk."],
      suggestedLines: [
        "Note the live AI SDK type: tool-<name> gap is unverified — parseToolResult never derives toolName.",
      ],
    });
    assert.equal(verdict.overclaims, true);
    assert.match(verdict.suggestedLines[0] ?? "", /parseToolResult/);
  });

  it("parses a not-overclaiming verdict", () => {
    const verdict = parseResearchEngagementVerdictPayload({
      overclaims: false,
      gaps: [],
      suggestedLines: [],
    });
    assert.equal(verdict.overclaims, false);
    assert.deepEqual(verdict.gaps, []);
  });

  it("fails closed on a messy payload", () => {
    const verdict = parseResearchEngagementVerdictPayload("garbage");
    assert.equal(verdict.overclaims, true);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);

    const missing = parseResearchEngagementVerdictPayload({ gaps: [] });
    assert.equal(missing.overclaims, true);
  });

  it("drops blank gap/suggestion entries", () => {
    const verdict = parseResearchEngagementVerdictPayload({
      overclaims: true,
      gaps: ["real overclaim", "   ", ""],
      suggestedLines: ["fix it", ""],
    });
    assert.deepEqual(verdict.gaps, ["real overclaim"]);
    assert.deepEqual(verdict.suggestedLines, ["fix it"]);
  });
});
