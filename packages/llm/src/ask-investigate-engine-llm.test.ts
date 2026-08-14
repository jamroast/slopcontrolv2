import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT,
  AskInvestigateEngineClassificationSchema,
} from "./ask-investigate-engine-llm.js";

describe("ask-investigate-engine-llm", () => {
  it("system prompt is intent-based JSON, fail-closed to auto", () => {
    assert.ok(ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT.includes("Judge intent, not keywords"));
    assert.ok(ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT.includes("decision=auto"));
    assert.ok(ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT.includes('"pi" | "mastra" | "auto"'));
    assert.equal(ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT.includes("please do"), false);
  });

  it("schema accepts pi | mastra | auto only", () => {
    assert.equal(
      AskInvestigateEngineClassificationSchema.parse({ decision: "pi" }).decision,
      "pi",
    );
    assert.equal(
      AskInvestigateEngineClassificationSchema.parse({ decision: "mastra" })
        .decision,
      "mastra",
    );
    assert.equal(
      AskInvestigateEngineClassificationSchema.parse({ decision: "auto" })
        .decision,
      "auto",
    );
    assert.throws(() =>
      AskInvestigateEngineClassificationSchema.parse({ decision: "opencode" }),
    );
  });
});
