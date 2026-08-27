import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RESEARCH_QUALITY_SYSTEM_PROMPT,
  parseResearchQualityVerdictPayload,
} from "./research-quality-llm.js";

describe("research-quality-llm", () => {
  it("system prompt requires concrete research before drafting", () => {
    assert.match(RESEARCH_QUALITY_SYSTEM_PROMPT, /Proposed Automated Checks/);
    assert.match(RESEARCH_QUALITY_SYSTEM_PROMPT, /fail closed/i);
  });

  it("parses an ok verdict", () => {
    const verdict = parseResearchQualityVerdictPayload({
      ok: true,
      gaps: [],
      suggestedFixes: [],
    });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.gaps, []);
  });

  it("fails closed on unreadable payload", () => {
    const verdict = parseResearchQualityVerdictPayload("not json");
    assert.equal(verdict.ok, false);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);
  });
});
