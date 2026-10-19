import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAgentModelChain, type MastraModelConfig } from "./index.js";

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
