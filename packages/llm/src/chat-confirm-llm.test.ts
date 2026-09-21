import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CHAT_CONFIRM_SYSTEM_PROMPT,
  ChatConfirmClassificationSchema,
  normalizeChatConfirmClassification,
} from "./chat-confirm-llm.js";

describe("chat-confirm-llm", () => {
  it("system prompt is intent-based JSON, not a keyword list", () => {
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("decision"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("approve"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("deny"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("unrelated"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("Judge intent, not keywords"));
    assert.equal(CHAT_CONFIRM_SYSTEM_PROMPT.includes("please do"), false);
    assert.equal(CHAT_CONFIRM_SYSTEM_PROMPT.includes("/yes/"), false);
  });

  it("schema accepts approve/deny/unrelated and optional token", () => {
    assert.deepEqual(
      ChatConfirmClassificationSchema.parse({ decision: "approve" }),
      { decision: "approve" },
    );
    assert.equal(
      ChatConfirmClassificationSchema.parse({
        decision: "deny",
        token: "abc",
      }).token,
      "abc",
    );
    assert.equal(
      ChatConfirmClassificationSchema.parse({ decision: "unrelated" }).decision,
      "unrelated",
    );
    assert.throws(() =>
      ChatConfirmClassificationSchema.parse({ decision: "maybe" }),
    );
  });

  it("schema accepts a tokens array for blanket decisions", () => {
    assert.deepEqual(
      ChatConfirmClassificationSchema.parse({
        decision: "approve",
        tokens: ["a", "b"],
      }),
      { decision: "approve", tokens: ["a", "b"] },
    );
  });

  it("system prompt teaches blanket-approval tokens", () => {
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("tokens"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("Blanket go-aheads"));
    assert.ok(CHAT_CONFIRM_SYSTEM_PROMPT.includes("ALL"));
  });

  it("implies token when exactly one action is parked", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve" },
      [{ token: "tok-1", tool: "agent" }],
    );
    assert.deepEqual(out, { decision: "approve", tokens: ["tok-1"] });
  });

  it("blanket approve resolves every parked token", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve", tokens: ["a", "b"] },
      [
        { token: "a", tool: "design_element_extract" },
        { token: "b", tool: "design_element_extract" },
      ],
    );
    assert.deepEqual(out, { decision: "approve", tokens: ["a", "b"] });
  });

  it("merges token and tokens, deduped", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve", token: "a", tokens: ["a", "b"] },
      [
        { token: "a", tool: "agent" },
        { token: "b", tool: "promote_ask" },
      ],
    );
    assert.deepEqual(out, { decision: "approve", tokens: ["a", "b"] });
  });

  it("drops unknown tokens but keeps valid parked ones", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve", tokens: ["a", "nope"] },
      [
        { token: "a", tool: "agent" },
        { token: "b", tool: "promote_ask" },
      ],
    );
    assert.deepEqual(out, { decision: "approve", tokens: ["a"] });
  });

  it("fails closed when every listed token is unknown", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve", tokens: ["x", "y"] },
      [
        { token: "a", tool: "agent" },
        { token: "b", tool: "promote_ask" },
      ],
    );
    assert.equal(out.decision, "unrelated");
  });

  it("fails closed when several parked actions have no token", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "approve" },
      [
        { token: "a", tool: "agent" },
        { token: "b", tool: "promote_ask" },
      ],
    );
    assert.equal(out.decision, "unrelated");
  });

  it("fails closed on a token that is not parked", () => {
    const out = normalizeChatConfirmClassification(
      { decision: "deny", token: "nope" },
      [{ token: "tok-1", tool: "agent" }],
    );
    assert.equal(out.decision, "unrelated");
  });
});
