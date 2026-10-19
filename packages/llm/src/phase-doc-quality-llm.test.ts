import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  PHASE_DOC_QUALITY_SYSTEM_PROMPT,
  judgePhaseDocQualityViaLlm,
  parsePhaseDocQualityVerdictPayload,
} from "./phase-doc-quality-llm.js";

const endpoint: LlmEndpoint = {
  id: "test",
  label: "test",
  baseUrl: "http://example.test/v1",
  apiType: "openai-chat",
  modelId: "test-model",
  capabilities: { chat: true, vision: false, imageGen: false },
};

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

  it("accepts a verdict that omits the fault lists", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":false,"gaps":["missing checks"]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const verdict = await judgePhaseDocQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
        phaseDocExcerpt: "phase doc",
      });
      assert.equal(verdict.ok, false);
      assert.deepEqual(verdict.gaps, ["missing checks"]);
      assert.deepEqual(verdict.researchFaults, []);
      assert.deepEqual(verdict.draftFaults, []);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
