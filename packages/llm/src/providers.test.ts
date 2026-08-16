import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultProvidersConfig,
  defaultProvidersPath,
  loadProvidersConfig,
  mergeEndpointWithProvider,
  mergeProviderUpdate,
  providerEnvVarName,
  resolveProviderKey,
  resolveEndpointWithProviders,
} from "./providers.js";

describe("providerEnvVarName", () => {
  it("maps provider names to env var names", () => {
    assert.equal(providerEnvVarName("openrouter"), "OPENROUTER_API_KEY");
    assert.equal(providerEnvVarName("ollama-cloud"), "OLLAMA_CLOUD_API_KEY");
    assert.equal(providerEnvVarName("local-ollama"), "LOCAL_OLLAMA_API_KEY");
    assert.equal(providerEnvVarName("xai"), "XAI_API_KEY");
  });
});

describe("resolveProviderKey", () => {
  it("prefers providers.json entry over env var", () => {
    const config = {
      providers: {
        openrouter: { apiKey: "sk-or-from-json" },
      },
    };
    // Even if env var were set, JSON wins
    assert.equal(resolveProviderKey("openrouter", config), "sk-or-from-json");
  });

  it("falls back to env var when not in providers.json", () => {
    const config = { providers: {} };
    process.env.TEST_PROVIDER_API_KEY = "sk-test-from-env";
    try {
      assert.equal(resolveProviderKey("test-provider", config), "sk-test-from-env");
    } finally {
      delete process.env.TEST_PROVIDER_API_KEY;
    }
  });

  it("returns undefined for local provider with no key", () => {
    const config = {
      providers: {
        "local-ollama": { apiKey: null },
      },
    };
    assert.equal(resolveProviderKey("local-ollama", config), undefined);
  });

  it("returns undefined when nothing is configured", () => {
    const config = { providers: {} };
    assert.equal(resolveProviderKey("unknown", config), undefined);
  });
});

describe("mergeEndpointWithProvider", () => {
  it("endpoint fields win over provider defaults", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://custom.example.com/v1",
      apiKey: "sk-explicit",
      apiType: "openai-chat" as const,
      modelId: "model-a",
      timeoutMs: 5000,
    };
    const provider = {
      apiKey: "sk-provider",
      defaultBaseUrl: "https://default.example.com/v1",
      timeoutMs: 10_000,
      headers: { "X-Provider": "true" },
    };
    const merged = mergeEndpointWithProvider(endpoint, provider);
    assert.equal(merged.apiKey, "sk-explicit");
    assert.equal(merged.baseUrl, "https://custom.example.com/v1");
    assert.equal(merged.timeoutMs, 5000);
    assert.deepEqual(merged.headers, { "X-Provider": "true" });
  });

  it("provider fills in missing endpoint fields", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://custom.example.com/v1",
      apiType: "openai-chat" as const,
      modelId: "model-a",
    };
    const provider = {
      apiKey: "sk-provider",
      timeoutMs: 10_000,
      defaultParams: { temperature: 0.7 },
    };
    const merged = mergeEndpointWithProvider(endpoint, provider);
    assert.equal(merged.apiKey, "sk-provider");
    assert.equal(merged.timeoutMs, 10_000);
    assert.deepEqual(merged.defaultParams, { temperature: 0.7 });
  });

  it("inherits defaultBaseUrl when endpoint baseUrl is empty", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "",
      apiType: "openai-chat" as const,
      modelId: "model-a",
    };
    const provider = {
      defaultBaseUrl: "https://openrouter.ai/api/v1",
    };
    const merged = mergeEndpointWithProvider(endpoint, provider);
    assert.equal(merged.baseUrl, "https://openrouter.ai/api/v1");
  });
});

describe("resolveEndpointWithProviders", () => {
  it("returns endpoint unchanged when no provider is set", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://example.com/v1",
      apiKey: "${MY_API_KEY}",
      apiType: "openai-chat" as const,
      modelId: "model-a",
    };
    const config = defaultProvidersConfig();
    const resolved = resolveEndpointWithProviders(endpoint, config);
    assert.equal(resolved.apiKey, "${MY_API_KEY}");
  });

  it("merges provider config when provider is set", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
      apiType: "openai-chat" as const,
      modelId: "anthropic/claude-3.5-sonnet",
    };
    const config = {
      providers: {
        openrouter: { apiKey: "sk-or-resolved" },
      },
    };
    const resolved = resolveEndpointWithProviders(endpoint, config);
    assert.equal(resolved.apiKey, "sk-or-resolved");
  });

  it("falls back to env var when provider not in providers.json", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://openrouter.ai/api/v1",
      provider: "openrouter",
      apiType: "openai-chat" as const,
      modelId: "anthropic/claude-3.5-sonnet",
    };
    const config = { providers: {} };
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    try {
      const resolved = resolveEndpointWithProviders(endpoint, config);
      assert.equal(resolved.apiKey, "sk-or-env");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
    }
  });

  it("keeps explicit endpoint apiKey over provider key", () => {
    const endpoint = {
      id: "e1",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-explicit",
      provider: "openrouter",
      apiType: "openai-chat" as const,
      modelId: "anthropic/claude-3.5-sonnet",
    };
    const config = {
      providers: {
        openrouter: { apiKey: "sk-provider" },
      },
    };
    const resolved = resolveEndpointWithProviders(endpoint, config);
    assert.equal(resolved.apiKey, "sk-explicit");
  });
});

describe("mergeProviderUpdate", () => {
  it("preserves apiKey when updating other fields", () => {
    const merged = mergeProviderUpdate(
      { apiKey: "sk-keep", defaultBaseUrl: "https://old.example/v1" },
      { defaultBaseUrl: "https://new.example/v1" },
    );
    assert.equal(merged.apiKey, "sk-keep");
    assert.equal(merged.defaultBaseUrl, "https://new.example/v1");
  });

  it("allows clearing apiKey when explicitly set to null", () => {
    const merged = mergeProviderUpdate({ apiKey: "sk-old" }, { apiKey: null });
    assert.equal(merged.apiKey, null);
  });
});

describe("loadProvidersConfig", () => {
  it("returns defaults when file does not exist", () => {
    const config = loadProvidersConfig("/tmp/nonexistent-providers.json");
    assert.deepEqual(config, { providers: {} });
  });
});
