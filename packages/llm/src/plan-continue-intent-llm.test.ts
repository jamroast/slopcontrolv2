import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAN_CONTINUE_INTENT_SYSTEM_PROMPT } from "./plan-continue-intent-llm.js";

describe("plan-continue-intent-llm", () => {
  it("system prompt covers expand / first-component and forbids not-only narrow", () => {
    assert.match(PLAN_CONTINUE_INTENT_SYSTEM_PROMPT, /expand_scope/);
    assert.match(PLAN_CONTINUE_INTENT_SYSTEM_PROMPT, /first component/i);
    assert.match(PLAN_CONTINUE_INTENT_SYSTEM_PROMPT, /present me with a plan/i);
    assert.match(PLAN_CONTINUE_INTENT_SYSTEM_PROMPT, /not only/i);
    assert.match(PLAN_CONTINUE_INTENT_SYSTEM_PROMPT, /JSON/);
  });
});
