import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_NARRATION_SYSTEM_PROMPT,
  NarrationJudgeResultSchema,
  parseNarrationJudgePayload,
} from "./ask-narration-llm.js";

describe("ask-narration-llm", () => {
  it("system prompt distinguishes narration from substantive answers", () => {
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /narrationOnly=true/);
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /narrationOnly=false/);
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /Let me check/);
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /root cause/);
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /toolCallCount/);
  });

  it("system prompt errs toward keeping the reply (synthesis is expensive)", () => {
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /prefer narrationOnly=false/);
    assert.match(ASK_NARRATION_SYSTEM_PROMPT, /synthesis pass is expensive/);
  });

  it("parses a well-formed verdict", () => {
    const verdict = NarrationJudgeResultSchema.parse({
      narrationOnly: false,
      reason: "Reply names the root cause in src/auth.ts.",
    });
    assert.equal(verdict.narrationOnly, false);
  });

  it("defaults to narrationOnly=true on a messy payload (current behavior)", () => {
    const verdict = parseNarrationJudgePayload(42);
    assert.equal(verdict.narrationOnly, true);
    assert.match(verdict.reason, /no reason/i);

    const missing = parseNarrationJudgePayload({ reason: "unsure" });
    assert.equal(missing.narrationOnly, true);
  });

  it("trims and drops blank reasons", () => {
    const verdict = parseNarrationJudgePayload({
      narrationOnly: false,
      reason: "  ",
    });
    assert.equal(verdict.narrationOnly, false);
    assert.match(verdict.reason, /no reason/i);
  });
});
