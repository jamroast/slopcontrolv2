import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_RESUME_SYSTEM_PROMPT,
  AskResumeClassificationSchema,
} from "./ask-resume-llm.js";

describe("ask-resume-llm", () => {
  it("system prompt is intent-based JSON, fail-closed to new", () => {
    assert.ok(ASK_RESUME_SYSTEM_PROMPT.includes("continue"));
    assert.ok(ASK_RESUME_SYSTEM_PROMPT.includes("new"));
    assert.ok(ASK_RESUME_SYSTEM_PROMPT.includes("Judge intent, not keywords"));
    assert.ok(ASK_RESUME_SYSTEM_PROMPT.includes("decision=new"));
    assert.equal(ASK_RESUME_SYSTEM_PROMPT.includes("please do"), false);
  });

  it("schema accepts continue | new only", () => {
    assert.equal(
      AskResumeClassificationSchema.parse({ decision: "continue" }).decision,
      "continue",
    );
    assert.equal(
      AskResumeClassificationSchema.parse({ decision: "new" }).decision,
      "new",
    );
    assert.throws(() =>
      AskResumeClassificationSchema.parse({ decision: "maybe" }),
    );
  });
});
