import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildAgentModelChain,
  LlmRegistry,
  type MastraModelConfig,
} from "./index.js";

const model = (name: string, url = "http://example.test/v1"): MastraModelConfig => ({
  id: `openai/${name}`,
  url,
  apiKey: "test-key",
});

const registry = (
  primary: MastraModelConfig,
  fallback: MastraModelConfig | null,
) => ({
  resolve: () => primary,
  resolveFallback: () => fallback,
});

describe("buildAgentModelChain", () => {
  it("returns the primary config when no distinct fallback resolves", () => {
    const primary = model("primary");
    assert.deepEqual(
      buildAgentModelChain(registry(primary, null), "planning"),
      primary,
    );
  });

  it("builds a Mastra model chain with per-model retries", () => {
    const primary = model("primary");
    const fallback = model("fallback");
    assert.deepEqual(
      buildAgentModelChain(registry(primary, fallback), "planning"),
      [
        { model: primary, maxRetries: 2 },
        { model: fallback, maxRetries: 1 },
      ],
    );
  });

  it("does not duplicate a fallback that is the same model", () => {
    const primary = model("primary");
    const sameModelDifferentKey = model("primary");
    assert.deepEqual(
      buildAgentModelChain(registry(primary, sameModelDifferentKey), "planning"),
      primary,
    );
  });

  it("treats the same model id at a different endpoint as a real fallback", () => {
    const primary = model("primary", "http://a.test/v1");
    const fallback = model("primary", "http://b.test/v1");
    assert.deepEqual(
      buildAgentModelChain(registry(primary, fallback), "planning"),
      [
        { model: primary, maxRetries: 2 },
        { model: fallback, maxRetries: 1 },
      ],
    );
  });
});

describe("buildAgentModelChain with a real registry", () => {
  const endpoints = (primaryModel: string, secondaryModel: string) => [
    {
      id: "a",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiType: "openai-chat" as const,
      modelId: primaryModel,
      capabilities: { chat: true, vision: false, imageGen: false },
    },
    {
      id: "b",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiType: "openai-chat" as const,
      modelId: secondaryModel,
      capabilities: { chat: true, vision: false, imageGen: false },
    },
  ];

  it("derives the fallback from the role graph (supervisor model)", () => {
    const registry = new LlmRegistry({
      endpoints: endpoints("model-a", "model-b"),
      roles: {
        planning: { endpointId: "a" },
        research: { endpointId: "a" },
        supervisor: { endpointId: "b" },
        coding: { endpointId: "b" },
      },
    });
    const chain = buildAgentModelChain(registry, "planning");
    assert.ok(Array.isArray(chain), "expected a fallback chain");
    assert.match(chain[0]!.model.id, /model-a$/);
    assert.equal(chain[0]!.maxRetries, 2);
    assert.match(chain[1]!.model.id, /model-b$/);
    assert.equal(chain[1]!.maxRetries, 1);
  });

  it("stays a single model when every role shares one model", () => {
    const registry = new LlmRegistry({
      endpoints: endpoints("model-a", "model-b"),
      roles: {
        planning: { endpointId: "a" },
        research: { endpointId: "a" },
        supervisor: { endpointId: "a" },
        coding: { endpointId: "a" },
      },
    });
    const chain = buildAgentModelChain(registry, "planning");
    assert.ok(!Array.isArray(chain), "expected the plain model config");
  });
});
