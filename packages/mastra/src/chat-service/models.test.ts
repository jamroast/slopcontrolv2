import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/llm";
import { LlmRegistry } from "@slopcontrol/llm";
import {
  bindFunctionToModel,
  buildFunctionMappingList,
  listConfiguredProviderCatalogs,
  listEndpointModels,
  listUniqueProviderModels,
  resolveConversationModelOverride,
  updateEndpointModel,
  type EndpointModelList,
  type ProviderCatalog,
} from "./models.js";

function legacyCatalog(
  endpoint: LlmEndpoint,
  models: string[],
  source: "live" | "configured" = "live",
): ProviderCatalog {
  return {
    providerName: endpoint.provider ?? endpoint.id,
    endpointId: endpoint.id,
    label: endpoint.id,
    provider: endpoint.provider ?? endpoint.id,
    baseUrl: endpoint.baseUrl,
    apiType: endpoint.apiType,
    models,
    source,
    mappedModelIds: [endpoint.modelId],
  };
}

const baseEndpoint: LlmEndpoint = {
  id: "e1",
  baseUrl: "http://localhost:11434/v1",
  apiType: "openai-chat",
  modelId: "glm-5.2",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("listEndpointModels", () => {
  it("uses /api/tags for local Ollama endpoints", async () => {
    let calledUrl = "";
    const result = await listEndpointModels(baseEndpoint, (async (url) => {
      calledUrl = String(url);
      return jsonResponse({ models: [{ name: "qwen3:32b" }, { name: "glm-5.2" }] });
    }) as typeof fetch);
    assert.equal(calledUrl, "http://localhost:11434/api/tags");
    assert.deepEqual(result.models, ["qwen3:32b", "glm-5.2"]);
    assert.equal(result.source, "live");
  });

  it("uses {baseUrl}/models with bearer auth for OpenAI-compatible endpoints", async () => {
    let calledUrl = "";
    let auth = "";
    const endpoint: LlmEndpoint = {
      ...baseEndpoint,
      id: "cloud",
      baseUrl: "https://ollama.com/v1",
      apiKey: "secret",
    };
    const result = await listEndpointModels(endpoint, (async (url, init) => {
      calledUrl = String(url);
      auth = String(
        (init?.headers as Record<string, string>)?.Authorization ?? "",
      );
      return jsonResponse({ data: [{ id: "glm-5.2:cloud" }] });
    }) as typeof fetch);
    assert.equal(calledUrl, "https://ollama.com/v1/models");
    assert.equal(auth, "Bearer secret");
    assert.deepEqual(result.models, ["glm-5.2:cloud"]);
    assert.equal(result.source, "live");
  });

  it("degrades to the configured model when the provider is unreachable", async () => {
    const result = await listEndpointModels(baseEndpoint, (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    assert.deepEqual(result.models, ["glm-5.2"]);
    assert.equal(result.source, "configured");
    assert.match(result.error ?? "", /ECONNREFUSED/);
  });

  it("degrades to the configured model on non-200 responses", async () => {
    const result = await listEndpointModels(
      baseEndpoint,
      (async () => jsonResponse({}, 401)) as typeof fetch,
    );
    assert.deepEqual(result.models, ["glm-5.2"]);
    assert.equal(result.source, "configured");
    assert.match(result.error ?? "", /401/);
  });
});

describe("listUniqueProviderModels", () => {
  it("fetches the live catalog once per provider, not once per endpoint clone", async () => {
    let calls = 0;
    const cloud = (id: string, modelId: string): LlmEndpoint => ({
      ...baseEndpoint,
      id,
      baseUrl: "https://ollama.com/v1",
      apiKey: "secret",
      modelId,
    });
    const result = await listUniqueProviderModels(
      [
        cloud("a", "kimi-k2.7-code"),
        cloud("b", "glm-5.2:cloud"),
        { ...baseEndpoint, id: "local" },
      ],
      (async (url) => {
        calls += 1;
        const href = String(url);
        if (href.includes("ollama.com")) {
          return jsonResponse({ data: [{ id: "kimi-k2.7-code" }, { id: "glm-5.2:cloud" }] });
        }
        return jsonResponse({ data: [{ id: "glm-5.2" }] });
      }) as typeof fetch,
    );
    assert.equal(calls, 2);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0]!.models, ["kimi-k2.7-code", "glm-5.2:cloud"]);
    assert.deepEqual(result[1]!.models, ["kimi-k2.7-code", "glm-5.2:cloud"]);
    assert.deepEqual(result[2]!.models, ["glm-5.2"]);
  });
});

describe("updateEndpointModel", () => {
  it("rewrites the endpoint modelId atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-endpoints-"));
    try {
      const path = join(dir, "endpoints.json");
      writeFileSync(
        path,
        JSON.stringify({
          endpoints: [baseEndpoint],
          roles: {
            research: { endpointId: "e1" },
            planning: { endpointId: "e1" },
            supervisor: { endpointId: "e1" },
            coding: { endpointId: "e1" },
          },
        }),
      );
      const updated = updateEndpointModel({
        endpointsPath: path,
        endpointId: "e1",
        modelId: "qwen3:32b",
      });
      assert.equal(updated.endpoints[0]!.modelId, "qwen3:32b");
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      assert.equal(onDisk.endpoints[0].modelId, "qwen3:32b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on unknown endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-endpoints-"));
    try {
      const path = join(dir, "endpoints.json");
      writeFileSync(
        path,
        JSON.stringify({
          endpoints: [baseEndpoint],
          roles: {
            research: { endpointId: "e1" },
            planning: { endpointId: "e1" },
            supervisor: { endpointId: "e1" },
            coding: { endpointId: "e1" },
          },
        }),
      );
      assert.throws(
        () =>
          updateEndpointModel({
            endpointsPath: path,
            endpointId: "nope",
            modelId: "x",
          }),
        /Unknown endpoint/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const requiredRoles = {
  research: { endpointId: "e1" },
  planning: { endpointId: "e1" },
  supervisor: { endpointId: "e1" },
  coding: { endpointId: "e1" },
};

function writeConfig(
  dir: string,
  extra?: {
    endpoints?: LlmEndpoint[];
    roles?: Record<string, { endpointId: string; modelId?: string }>;
  },
): string {
  const path = join(dir, "endpoints.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoints: extra?.endpoints ?? [baseEndpoint],
      roles: extra?.roles ?? requiredRoles,
    }),
  );
  return path;
}

describe("resolveConversationModelOverride", () => {
  it("resolves a providers.json key from chat_models_list", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-override-"));
    try {
      const endpointsPath = writeConfig(dir, {
        endpoints: [
          {
            ...baseEndpoint,
            id: "ollama-cloud-deepseek",
            baseUrl: "https://ollama.com/v1",
            modelId: "deepseek-v4-pro:cloud",
            provider: "ollama-cloud",
          },
        ],
      });
      writeFileSync(
        join(dir, "providers.json"),
        JSON.stringify({
          providers: {
            "ollama-cloud": {
              apiKey: "test-key",
              defaultBaseUrl: "https://ollama.com/v1",
            },
          },
        }),
      );
      const registry = LlmRegistry.fromFile(endpointsPath, join(dir, "providers.json"));
      const model = resolveConversationModelOverride(registry, {
        endpointId: "ollama-cloud",
        modelId: "deepseek-v4-pro:0813",
      });
      assert.equal(model.url, "https://ollama.com/v1");
      assert.equal(model.apiKey, "test-key");
      assert.match(model.id, /deepseek-v4-pro:0813/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still resolves concrete endpoints.json ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-override-"));
    try {
      const endpointsPath = writeConfig(dir);
      const registry = LlmRegistry.fromFile(endpointsPath);
      const model = resolveConversationModelOverride(registry, {
        endpointId: "e1",
        modelId: "glm-5.2",
      });
      assert.match(model.id, /glm-5\.2/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildFunctionMappingList", () => {
  it("lists functions with current model and fallbacks", () => {
    const config = {
      endpoints: [baseEndpoint],
      roles: requiredRoles,
    };
    const catalogs: ProviderCatalog[] = [
      legacyCatalog(baseEndpoint, ["glm-5.2", "kimi-k2.7-code"]),
    ];
    const listed = buildFunctionMappingList(config, catalogs);
    const classification = listed.functions.find((f) => f.function === "classification");
    assert.ok(classification);
    assert.equal(classification.current?.modelId, "glm-5.2");
    assert.equal(classification.current?.explicit, false);
    assert.equal(classification.current?.fallbackFrom, "planning");
    const coding = listed.functions.find((f) => f.function === "coding");
    assert.equal(coding?.current?.explicit, true);
    assert.equal(coding?.current?.modelId, "glm-5.2");
    const vision = listed.functions.find((f) => f.function === "designVision");
    assert.equal(vision?.current, null);
    const ask = listed.functions.find((f) => f.function === "ask");
    assert.ok(ask);
    assert.equal(ask.current?.modelId, "glm-5.2");
    assert.equal(ask.current?.explicit, false);
    assert.equal(ask.current?.fallbackFrom, "research");
    const agent = listed.functions.find((f) => f.function === "agent");
    assert.ok(agent);
    assert.equal(agent.current?.modelId, "glm-5.2");
    assert.equal(agent.current?.explicit, false);
    assert.equal(agent.current?.fallbackFrom, "research");
    assert.ok(listed.models.some((m) => m.modelId === "kimi-k2.7-code" && !m.mapped));
    assert.ok(listed.models.some((m) => m.modelId === "glm-5.2" && m.mapped));
    for (const model of listed.models) {
      assert.equal(model.label, model.modelId);
      assert.equal(model.providerName, "e1");
    }
  });

  it("dedupes the live catalog when several endpoints share a provider", () => {
    const catalog = [
      "kimi-k2.7-code",
      "glm-5.2:cloud",
      "qwen3:32b",
      "deepseek-v3",
      "llama3.2",
    ];
    const cloud = (id: string, modelId: string): LlmEndpoint => ({
      ...baseEndpoint,
      id,
      baseUrl: "https://ollama.com/v1",
      modelId,
    });
    const config = {
      endpoints: [
        cloud("ollama-cloud-kimi", "kimi-k2.7-code"),
        cloud("ollama-cloud-glm", "glm-5.2:cloud"),
        cloud("ollama-cloud-qwen", "qwen3:32b"),
      ],
      roles: {
        research: { endpointId: "ollama-cloud-kimi" },
        planning: { endpointId: "ollama-cloud-kimi" },
        supervisor: { endpointId: "ollama-cloud-kimi" },
        coding: { endpointId: "ollama-cloud-glm" },
      },
    };
    const catalogs: ProviderCatalog[] = [
      {
        providerName: "ollama-cloud-kimi",
        endpointId: "ollama-cloud-kimi",
        label: "Ollama Cloud",
        provider: "Ollama Cloud",
        baseUrl: "https://ollama.com/v1",
        apiType: "openai-chat",
        models: catalog,
        source: "live",
        mappedModelIds: config.endpoints.map((e) => e.modelId),
      },
    ];
    const listed = buildFunctionMappingList(config, catalogs);
    const modelIds = listed.models.map((m) => m.modelId);
    assert.deepEqual([...new Set(modelIds)].sort(), [...catalog].sort());
    assert.equal(listed.models.length, catalog.length);
    assert.equal(listed.providers.length, 1);
    assert.equal(listed.providers[0]!.label, "Ollama Cloud");
    assert.equal(listed.providers[0]!.baseUrl, "https://ollama.com/v1");
    for (const model of listed.models) {
      assert.equal(model.label, model.modelId);
      assert.equal(model.provider, "Ollama Cloud");
    }
    assert.equal(
      listed.models.find((m) => m.modelId === "glm-5.2:cloud")?.mapped,
      true,
    );
    assert.equal(
      listed.models.find((m) => m.modelId === "llama3.2")?.mapped,
      false,
    );
  });

  it("keeps the same model twice when two providers advertise it", () => {
    const config = {
      endpoints: [
        baseEndpoint,
        {
          ...baseEndpoint,
          id: "cloud",
          baseUrl: "https://ollama.com/v1",
          modelId: "glm-5.2:cloud",
        },
      ],
      roles: requiredRoles,
    };
    const listed = buildFunctionMappingList(config, [
      legacyCatalog(baseEndpoint, ["glm-5.2"]),
      legacyCatalog(config.endpoints[1]!, ["glm-5.2:cloud", "glm-5.2"]),
    ]);
    const glm = listed.models.filter((m) => m.modelId === "glm-5.2");
    assert.equal(glm.length, 2);
    assert.equal(listed.providers.length, 2);
    assert.equal(glm[0]!.label, "glm-5.2");
    assert.equal(glm[1]!.label, "glm-5.2");
    assert.deepEqual(
      new Set(glm.map((m) => m.providerName)),
      new Set(["e1", "cloud"]),
    );
  });
});

describe("bindFunctionToModel", () => {
  it("reuses an endpoint that already has the model and sets the function mapping", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir);
      const result = bindFunctionToModel({
        endpointsPath: path,
        function: "classification",
        modelId: "glm-5.2",
        catalogs: [legacyCatalog(baseEndpoint, ["glm-5.2"])],
      });
      assert.equal(result.createdEndpoint, false);
      assert.equal(result.endpointId, "e1");
      assert.equal(result.config.roles.classification?.endpointId, "e1");
      assert.equal(result.config.roles.classification?.modelId, "glm-5.2");
      assert.equal(result.config.endpoints.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds ask and agent as their own function mappings", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir);
      const ask = bindFunctionToModel({
        endpointsPath: path,
        function: "ask",
        modelId: "glm-5.2",
        catalogs: [legacyCatalog(baseEndpoint, ["glm-5.2"])],
      });
      assert.equal(ask.createdEndpoint, false);
      assert.equal(ask.config.roles.ask?.endpointId, "e1");
      assert.equal(ask.config.roles.ask?.modelId, "glm-5.2");
      const agent = bindFunctionToModel({
        endpointsPath: path,
        function: "agent",
        modelId: "glm-5.2",
        catalogs: [legacyCatalog(baseEndpoint, ["glm-5.2"])],
      });
      assert.equal(agent.config.roles.agent?.endpointId, "e1");
      assert.equal(agent.config.roles.agent?.modelId, "glm-5.2");
      const judge = bindFunctionToModel({
        endpointsPath: path,
        function: "judge",
        modelId: "glm-5.2",
        catalogs: [legacyCatalog(baseEndpoint, ["glm-5.2"])],
      });
      assert.equal(judge.config.roles.judge?.endpointId, "e1");
      assert.equal(judge.config.roles.judge?.modelId, "glm-5.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates an endpoint mapping when the model is only listed by a provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir, {
        endpoints: [
          {
            ...baseEndpoint,
            id: "ollama-cloud-kimi",
            label: "Ollama Cloud Kimi",
            baseUrl: "https://ollama.com/v1",
            modelId: "kimi-k2.7-code",
            apiKey: "${OLLAMA_API_KEY}",
          },
        ],
        roles: {
          research: { endpointId: "ollama-cloud-kimi" },
          planning: { endpointId: "ollama-cloud-kimi" },
          supervisor: { endpointId: "ollama-cloud-kimi" },
          coding: { endpointId: "ollama-cloud-kimi" },
        },
      });
      const result = bindFunctionToModel({
        endpointsPath: path,
        function: "classification",
        modelId: "glm-5.2:cloud",
        catalogs: [
          legacyCatalog(
            {
              ...baseEndpoint,
              id: "ollama-cloud-kimi",
              baseUrl: "https://ollama.com/v1",
              modelId: "kimi-k2.7-code",
            },
            ["kimi-k2.7-code", "glm-5.2:cloud"],
          ),
        ],
      });
      assert.equal(result.createdEndpoint, true);
      assert.equal(result.modelId, "glm-5.2:cloud");
      const created = result.config.endpoints.find((e) => e.id === result.endpointId);
      assert.ok(created);
      assert.equal(created.modelId, "glm-5.2:cloud");
      assert.equal(created.baseUrl, "https://ollama.com/v1");
      assert.equal(created.apiKey, "${OLLAMA_API_KEY}");
      assert.equal(result.config.roles.classification?.endpointId, result.endpointId);
      assert.equal(result.config.endpoints.length, 2);
      const original = result.config.endpoints.find((e) => e.id === "ollama-cloud-kimi");
      assert.equal(original?.modelId, "kimi-k2.7-code");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates from a specified provider even when the model is not listed yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir);
      const result = bindFunctionToModel({
        endpointsPath: path,
        function: "coding",
        modelId: "qwen3:32b",
        endpointId: "e1",
        catalogs: [legacyCatalog(baseEndpoint, ["glm-5.2"])],
      });
      assert.equal(result.createdEndpoint, true);
      assert.equal(result.config.roles.coding.endpointId, result.endpointId);
      assert.notEqual(result.endpointId, "e1");
      assert.equal(result.config.endpoints[0]!.modelId, "glm-5.2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires provider when the model is unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir);
      assert.throws(
        () =>
          bindFunctionToModel({
            endpointsPath: path,
            function: "chat",
            modelId: "mystery-model",
            catalogs: [],
          }),
        /Pass provider/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds by providers.json key and sets endpoint.provider", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-bind-"));
    try {
      const path = writeConfig(dir);
      const result = bindFunctionToModel({
        endpointsPath: path,
        function: "research",
        modelId: "anthropic/claude-3.5-sonnet",
        provider: "openrouter",
        providersConfig: {
          providers: {
            openrouter: {
              apiKey: "sk-or-test",
              defaultBaseUrl: "https://openrouter.ai/api/v1",
            },
          },
        },
        catalogs: [
          {
            providerName: "openrouter",
            endpointId: "openrouter",
            label: "openrouter",
            provider: "openrouter",
            baseUrl: "https://openrouter.ai/api/v1",
            apiType: "openai-chat",
            models: ["anthropic/claude-3.5-sonnet"],
            source: "live",
            mappedModelIds: [],
          },
        ],
      });
      assert.equal(result.provider, "openrouter");
      assert.equal(result.createdEndpoint, true);
      const created = result.config.endpoints.find((e) => e.id === result.endpointId);
      assert.ok(created);
      assert.equal(created.provider, "openrouter");
      assert.equal(created.modelId, "anthropic/claude-3.5-sonnet");
      assert.equal(created.baseUrl, "https://openrouter.ai/api/v1");
      assert.equal(created.apiKey, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
