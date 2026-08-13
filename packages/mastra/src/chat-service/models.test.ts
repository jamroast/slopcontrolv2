import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/llm";
import { listEndpointModels, updateEndpointModel } from "./models.js";

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
