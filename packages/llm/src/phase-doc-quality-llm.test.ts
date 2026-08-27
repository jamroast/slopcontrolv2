import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PHASE_DOC_QUALITY_SYSTEM_PROMPT,
  parsePhaseDocQualityVerdictPayload,
} from "./phase-doc-quality-llm.js";

describe("phase-doc-quality-llm", () => {
  it("system prompt attributes faults to research vs draft", () => {
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /researchFaults/);
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /draftFaults/);
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /NO interaction block.*fill\/submit/i,
    );
  });

  it("parses fault attribution lists", () => {
    const verdict = parsePhaseDocQualityVerdictPayload({
      ok: false,
      gaps: ["Missing /sign-in route in File Changes"],
      suggestedFixes: ["Add src/routes/sign-in.tsx"],
      researchFaults: [],
      draftFaults: ["Missing /sign-in route in File Changes"],
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.draftFaults, [
      "Missing /sign-in route in File Changes",
    ]);
    assert.deepEqual(verdict.researchFaults, []);
  });

  it("fails closed on unreadable payload", () => {
    const verdict = parsePhaseDocQualityVerdictPayload({});
    assert.equal(verdict.ok, false);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);
  });
});
