import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/types";
import { aiSdkModelFor } from "./json-chat.js";

const endpoint = (patch: Partial<LlmEndpoint>): LlmEndpoint =>
  ({
    id: "test",
    label: "test",
    baseUrl: "http://127.0.0.1:11434/v1",
    apiType: "openai-chat",
    modelId: "test-model",
    capabilities: { chat: true, vision: false, imageGen: false },
    ...patch,
  }) as LlmEndpoint;

const metaOf = (model: unknown): { modelId?: string; provider?: string } =>
  model as { modelId?: string; provider?: string };

describe("aiSdkModelFor transport selection", () => {
  it("maps openai-chat endpoints to the OpenAI chat model", () => {
    const model = aiSdkModelFor(endpoint({}), "deepseek-v4-pro:cloud");
    assert.ok(model);
    assert.equal(metaOf(model).modelId, "deepseek-v4-pro:cloud");
    assert.match(String(metaOf(model).provider), /openai/);
  });

  it("maps openai-completions endpoints to the OpenAI chat model", () => {
    const model = aiSdkModelFor(
      endpoint({ apiType: "openai-completions" }),
      "glm-5.2:cloud",
    );
    assert.ok(model);
    assert.equal(metaOf(model).modelId, "glm-5.2:cloud");
    assert.match(String(metaOf(model).provider), /openai/);
  });

  it("maps anthropic-messages endpoints to the Anthropic model", () => {
    const model = aiSdkModelFor(
      endpoint({
        apiType: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
      }),
      "claude-sonnet-4",
    );
    assert.ok(model);
    assert.equal(metaOf(model).modelId, "claude-sonnet-4");
    assert.match(String(metaOf(model).provider), /anthropic/);
  });

  it("declines api types the AI SDK transport does not serve", () => {
    // openai-responses and openai-images fall back to the direct transport.
    assert.equal(
      aiSdkModelFor(endpoint({ apiType: "openai-responses" }), "m"),
      null,
    );
    assert.equal(
      aiSdkModelFor(endpoint({ apiType: "openai-images" }), "m"),
      null,
    );
  });

  it("declines an endpoint with no base URL", () => {
    assert.equal(aiSdkModelFor(endpoint({ baseUrl: "" }), "m"), null);
  });
});
