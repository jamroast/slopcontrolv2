import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMarketingQualityVerdictPayload } from "./marketing-quality-llm.js";

describe("marketing quality verdict parse", () => {
  it("fails closed when ok is missing", () => {
    const verdict = parseMarketingQualityVerdictPayload({ gaps: [] });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.gaps[0]?.includes("could not be verified"));
  });

  it("keeps gaps and suggested fixes", () => {
    const verdict = parseMarketingQualityVerdictPayload({
      ok: false,
      gaps: ["No source URL"],
      suggestedFixes: ["Cite the fetched page"],
      evidenceFaults: ["No source URL"],
      draftFaults: [],
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.suggestedFixes, ["Cite the fetched page"]);
    assert.deepEqual(verdict.evidenceFaults, ["No source URL"]);
  });

  it("accepts an explicit pass", () => {
    const verdict = parseMarketingQualityVerdictPayload({
      ok: true,
      gaps: [],
      suggestedFixes: [],
      evidenceFaults: [],
      draftFaults: [],
    });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.gaps, []);
  });
});