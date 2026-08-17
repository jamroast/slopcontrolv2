import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAN_START_INTENT_SYSTEM_PROMPT } from "./plan-start-intent-llm.js";

describe("plan-start-intent-llm", () => {
  it("prompt requires JSON-only output", () => {
    assert.match(PLAN_START_INTENT_SYSTEM_PROMPT, /needsInvestigation/);
    assert.match(PLAN_START_INTENT_SYSTEM_PROMPT, /investigateEngine/);
    assert.match(PLAN_START_INTENT_SYSTEM_PROMPT, /siblingInvestigation/);
  });
});
