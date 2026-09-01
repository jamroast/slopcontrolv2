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
  roleBindingInfo,
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

  it("falls classification role back to planning when unbound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "plan",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "deepseek",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "plan" },
        planning: { endpointId: "plan" },
        supervisor: { endpointId: "plan" },
        coding: { endpointId: "plan" },
      },
    });
    const cls = registry.resolveEndpointForRole("classification");
    assert.equal(cls.endpoint.id, "plan");
    const info = roleBindingInfo(registry.getRoleBindings(), "classification");
    assert.equal(info.explicit, false);
    assert.equal(info.fallbackFrom, "planning");
    assert.equal(info.binding?.endpointId, "plan");
  });

  it("resolves classification to its own endpoint when bound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "plan",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "deepseek",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "plan" },
        planning: { endpointId: "plan" },
        supervisor: { endpointId: "plan" },
        coding: { endpointId: "plan" },
        classification: { endpointId: "glm" },
      },
    });
    const cls = registry.resolveEndpointForRole("classification");
    assert.equal(cls.endpoint.id, "glm");
    assert.equal(cls.modelId, "glm-5.2");
  });

  it("falls ask and agent roles back to research when unbound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "research",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "kimi-k2.7-code",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
        {
          id: "plan",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "deepseek",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "research" },
        planning: { endpointId: "plan" },
        supervisor: { endpointId: "plan" },
        coding: { endpointId: "plan" },
      },
    });
    for (const role of ["ask", "agent"] as const) {
      const resolved = registry.resolveEndpointForRole(role);
      assert.equal(resolved.endpoint.id, "research");
      assert.equal(resolved.modelId, "kimi-k2.7-code");
      const info = roleBindingInfo(registry.getRoleBindings(), role);
      assert.equal(info.explicit, false);
      assert.equal(info.fallbackFrom, "research");
      assert.equal(registry.hasRoleBinding(role), true);
    }
    const judgeUnbound = registry.resolveEndpointForRole("judge");
    assert.equal(judgeUnbound.endpoint.id, "research");
    assert.equal(
      roleBindingInfo(registry.getRoleBindings(), "judge").fallbackFrom,
      "research",
    );
  });

  it("resolves ask and agent to their own endpoints when bound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "research",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "kimi-k2.7-code",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "research" },
        planning: { endpointId: "research" },
        supervisor: { endpointId: "research" },
        coding: { endpointId: "research" },
        ask: { endpointId: "glm" },
        agent: { endpointId: "glm" },
      },
    });
    const ask = registry.resolveEndpointForRole("ask");
    const agent = registry.resolveEndpointForRole("agent");
    assert.equal(ask.endpoint.id, "glm");
    assert.equal(ask.modelId, "glm-5.2");
    assert.equal(agent.endpoint.id, "glm");
    assert.equal(agent.modelId, "glm-5.2");
    assert.equal(roleBindingInfo(registry.getRoleBindings(), "ask").explicit, true);
    assert.equal(roleBindingInfo(registry.getRoleBindings(), "agent").explicit, true);
    const judgeViaAsk = registry.resolveEndpointForRole("judge");
    assert.equal(judgeViaAsk.endpoint.id, "glm");
    assert.equal(
      roleBindingInfo(registry.getRoleBindings(), "judge").fallbackFrom,
      "ask",
    );
  });

  it("resolves judge to its own endpoint when bound", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
        {
          id: "kimi",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "kimi-k2.5",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "glm" },
        planning: { endpointId: "glm" },
        supervisor: { endpointId: "glm" },
        coding: { endpointId: "glm" },
        ask: { endpointId: "glm" },
        judge: { endpointId: "kimi" },
      },
    });
    const judge = registry.resolveEndpointForRole("judge");
    assert.equal(judge.endpoint.id, "kimi");
    assert.equal(judge.modelId, "kimi-k2.5");
    assert.equal(roleBindingInfo(registry.getRoleBindings(), "judge").explicit, true);
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

  it("resolve() uses providers.json when the endpoint has provider only", () => {
    const registry = new LlmRegistry(
      {
        endpoints: [
          {
            id: "or",
            baseUrl: "https://openrouter.ai/api/v1",
            provider: "openrouter",
            apiType: "openai-chat",
            modelId: "anthropic/claude-3.5-sonnet",
          },
        ],
        roles: {
          research: { endpointId: "or" },
          planning: { endpointId: "or" },
          supervisor: { endpointId: "or" },
          coding: { endpointId: "or" },
        },
      },
      {
        providers: {
          openrouter: { apiKey: "sk-or-from-providers-json" },
        },
      },
    );
    const model = registry.resolve("research");
    assert.equal(model.apiKey, "sk-or-from-providers-json");
  });

  it("fromFile loads providers.json from the endpoints directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "slopcontrol-llm-providers-"));
    const configPath = join(dir, "endpoints.json");
    const providersPath = join(dir, "providers.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          endpoints: [
            {
              id: "or",
              baseUrl: "https://openrouter.ai/api/v1",
              provider: "openrouter",
              apiType: "openai-chat",
              modelId: "anthropic/claude-3.5-sonnet",
            },
          ],
          roles: {
            research: { endpointId: "or" },
            planning: { endpointId: "or" },
            supervisor: { endpointId: "or" },
            coding: { endpointId: "or" },
          },
        }),
        "utf-8",
      );
      writeFileSync(
        providersPath,
        JSON.stringify({
          providers: {
            openrouter: { apiKey: "sk-or-from-file" },
          },
        }),
        "utf-8",
      );
      const registry = LlmRegistry.fromFile(configPath);
      const model = registry.resolve("research");
      assert.equal(model.apiKey, "sk-or-from-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveFallback prefers the supervisor's model when it is a different endpoint", () => {
    const registry = new LlmRegistry({
      endpoints: [
        {
          id: "deepseek",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "deepseek-v4-pro",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
        {
          id: "glm",
          baseUrl: "http://localhost:11434/v1",
          apiType: "openai-chat",
          modelId: "glm-5.2",
          capabilities: { chat: true, vision: false, imageGen: false },
        },
      ],
      roles: {
        research: { endpointId: "deepseek" },
        planning: { endpointId: "deepseek" },
        supervisor: { endpointId: "glm" },
        coding: { endpointId: "deepseek" },
      },
    });

    const fallback = registry.resolveFallback("planning");
    assert.ok(fallback, "expected a fallback model");
    assert.equal(fallback.id, "openai/glm-5.2");
  });

  it("resolveFallback returns null when every role shares one endpoint", () => {
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

    assert.equal(registry.resolveFallback("planning"), null);
  });
});
