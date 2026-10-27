import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PLAN_PROMOTE_GATE_SYSTEM_PROMPT } from "./plan-promote-gate-llm.js";

describe("plan-promote-gate-llm", () => {
  it("system prompt defines blocking as operator-decision vs research-resolvable", () => {
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /OPERATOR DECISION/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /BLOCKING/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /product, scope, or policy/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /research in the repo can resolve it/i);
  });

  it("system prompt demands exact-copy output and an all-clear shape", () => {
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /EXACTLY/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /never invent, paraphrase/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /"blocking": \[\]/);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /JSON/);
  });

  it("system prompt names the options-pick signal", () => {
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /option A vs B/i);
    assert.match(PLAN_PROMOTE_GATE_SYSTEM_PROMPT, /stop until resolved/i);
  });
});
