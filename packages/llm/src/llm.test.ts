import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LlmRegistry,
  assertVisionCapable,
  endpointSupportsVision,
  loadEndpointsConfig,
  resolveEndpointSecrets,
  substituteEnv,
} from "./index.js";

describe("@slopcontrol/llm", () => {
  it("substitutes env vars in endpoint config", () => {
    process.env.TEST_LLM_KEY = "secret-key";
    assert.equal(substituteEnv("${TEST_LLM_KEY}"), "secret-key");
    delete process.env.TEST_LLM_KEY;
  });

  it("loads and resolves endpoints by role", () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcontrol-llm-"));
    const configPath = join(dir, "endpoints.json");

    try {
      const config = loadEndpointsConfig(configPath);
      const registry = new LlmRegistry(config);
      const endpoint = registry.getEndpoint("local-ollama");

      assert.equal(endpoint.apiType, "openai-chat");
      assert.equal(registry.getRoleBindings().research.endpointId, "local-ollama");

      const resolved = resolveEndpointSecrets({
        ...endpoint,
        apiKey: undefined,
      });
      assert.equal(resolved.modelId, "llama3.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls design role back to planning when unbound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "glm" },
        planning: { endpointId: "glm" },
        supervisor: { endpointId: "glm" },
        coding: { endpointId: "glm" },
      },
    });

    const design = registry.resolveEndpointForRole("design");
    assert.equal(design.endpoint.id, "glm");
    assert.equal(endpointSupportsVision(design.endpoint), false);
  });

  it("refuses vision on non-vision endpoints", () => {
    const endpoint = {
      id: "glm",
      baseUrl: "http://localhost:11434/v1",
      apiType: "openai-chat" as const,
      modelId: "glm-5.2",
      capabilities: { chat: true, vision: false, imageGen: false },
    };
    assert.throws(() => assertVisionCapable(endpoint), /does not support vision/);
  });

  it("tryResolveDesignVision returns null without vision capability", () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcontrol-llm-vis-"));
    try {
      const configPath = join(dir, "endpoints.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          endpoints: [
            {
              id: "glm",
              baseUrl: "http://localhost:11434/v1",
              apiType: "openai-chat",
              modelId: "glm-5.2",
              capabilities: { chat: true, vision: false, imageGen: false },
            },
          ],
          roles: {
            research: { endpointId: "glm" },
            planning: { endpointId: "glm" },
            supervisor: { endpointId: "glm" },
            coding: { endpointId: "glm" },
            designVision: { endpointId: "glm" },
          },
        }),
        "utf-8",
      );
      const registry = new LlmRegistry(loadEndpointsConfig(configPath));
      assert.equal(registry.tryResolveDesignVision(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses openai-images endpoints with imageGen capability", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "img",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-images",
          modelId: "x/z-image-turbo",
          capabilities: { chat: false, vision: false, imageGen: true },
        },
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
        },
      ],
      roles: {
        research: { endpointId: "glm" },
        planning: { endpointId: "glm" },
        supervisor: { endpointId: "glm" },
        coding: { endpointId: "glm" },
        designImage: { endpointId: "img" },
      },
    });
    const img = registry.tryResolveDesignImage();
    assert.ok(img);
    assert.equal(img!.endpoint.apiType, "openai-images");
  });
});
