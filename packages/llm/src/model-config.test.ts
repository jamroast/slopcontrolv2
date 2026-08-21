import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toMastraModelConfig } from "./index.js";
import type { LlmEndpoint } from "@slopcontrol/types";

const ENDPOINT: LlmEndpoint = {
  id: "ep-design",
  baseUrl: "http://127.0.0.1:9/v1",
  apiType: "openai-chat",
  modelId: "deepseek-v4-pro:cloud",
};

describe("toMastraModelConfig", () => {
  it("forwards endpoint defaultParams for agent modelSettings", () => {
    const cfg = toMastraModelConfig({
      ...ENDPOINT,
      defaultParams: { maxTokens: 32768, temperature: 0.4, topP: 0.95 },
    });
    assert.deepEqual(cfg.defaultParams, {
      maxTokens: 32768,
      temperature: 0.4,
      topP: 0.95,
    });
  });

  it("leaves defaultParams undefined when the endpoint has none", () => {
    const cfg = toMastraModelConfig(ENDPOINT);
    assert.equal(cfg.defaultParams, undefined);
  });
});
