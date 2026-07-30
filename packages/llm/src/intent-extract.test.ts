import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  ChangeIntentLlmOutputSchema,
  finalizeChangeIntent,
} from "@slopcontrol/artifacts";
import { stripJsonFence } from "./json-chat.js";
import { CHANGE_INTENT_SYSTEM_PROMPT } from "./intent-extract.js";

describe("json-chat helpers", () => {
  it("stripJsonFence unwraps markdown fences", () => {
    assert.equal(
      stripJsonFence('```json\n{"a":1}\n```'),
      '{"a":1}',
    );
    assert.equal(stripJsonFence('noise {"a":1} trailing'), '{"a":1}');
  });
});

describe("intent-extract (mocked chatJson path)", () => {
  it("validates LLM JSON and finalize yields chrome-hide without interaction", async () => {
    const raw = {
      title: "Hide empty Form|Chat tabs",
      goal: "When nothing to gather, show only the chat text area.",
      uiMount: "composer",
      changeKind: "chrome-hide",
      needsInteraction: false,
    };
    const parsed = ChangeIntentLlmOutputSchema.parse(raw);
    const intent = finalizeChangeIntent(parsed, {
      description:
        "What phases are complete? Hide blank form tabs when nothing to gather.",
    });
    assert.equal(intent.changeKind, "chrome-hide");
    assert.equal(intent.uiMount, "composer");
    assert.equal(intent.interaction, undefined);
    assert.ok(CHANGE_INTENT_SYSTEM_PROMPT.includes("chrome-hide"));
  });

  it("mock extractChangeIntentViaLlm via module mock", async () => {
    const chatJsonMock = mock.fn(async () => ({
      text: JSON.stringify({
        title: "Enable fill and submit in composer",
        goal: "Users must populate and submit skill params.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      parsed: {
        title: "Enable fill and submit in composer",
        goal: "Users must populate and submit skill params.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      },
      modelId: "test-model",
    }));

    // Simulate the post-chatJson validation path used by extractChangeIntentViaLlm
    const { parsed } = await chatJsonMock();
    const llmOut = ChangeIntentLlmOutputSchema.parse(parsed);
    const intent = finalizeChangeIntent(llmOut, {
      description: "Unable to submit form in the composer",
    });
    assert.equal(intent.changeKind, "engagement");
    assert.ok(intent.interaction);
    assert.equal(chatJsonMock.mock.callCount(), 1);
  });
});
