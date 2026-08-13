import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolveEndpointSecrets, type LlmEndpoint } from "@slopcontrol/llm";
import { EndpointsConfigSchema, type EndpointsConfig } from "@slopcontrol/types";

export interface EndpointModelList {
  endpointId: string;
  /** Currently configured default model. */
  configuredModel: string;
  /** Models advertised by the provider (or [configuredModel] when unlistable). */
  models: string[];
  source: "live" | "configured";
  error?: string;
}

type FetchLike = typeof fetch;

function endpointOrigin(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

function isLocalOllama(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1):11434\b/i.test(baseUrl);
}

/**
 * List the models a bound provider exposes for an endpoint.
 * - Ollama (local :11434): GET {origin}/api/tags
 * - OpenAI-compatible (openai-*, incl. Ollama Cloud /v1): GET {baseUrl}/models
 * - anthropic-messages: GET {baseUrl}/v1/models (x-api-key auth)
 * Unknown/unreachable providers degrade to the configured modelId.
 */
export async function listEndpointModels(
  endpoint: LlmEndpoint,
  fetchFn: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<EndpointModelList> {
  const resolved = resolveEndpointSecrets(endpoint);
  const base: EndpointModelList = {
    endpointId: endpoint.id,
    configuredModel: resolved.modelId,
    models: [resolved.modelId],
    source: "configured",
  };

  try {
    if (isLocalOllama(resolved.baseUrl)) {
      const res = await fetchFn(`${endpointOrigin(resolved.baseUrl)}/api/tags`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models?: { name?: string }[] };
      const models = (data.models ?? [])
        .map((m) => m.name)
        .filter((n): n is string => Boolean(n));
      if (models.length === 0) throw new Error("no models reported");
      return { ...base, models, source: "live" };
    }

    if (resolved.apiType === "anthropic-messages") {
      const root = resolved.baseUrl.replace(/\/v1\/?$/, "");
      const res = await fetchFn(`${root}/v1/models`, {
        headers: {
          ...(resolved.apiKey ? { "x-api-key": resolved.apiKey } : {}),
          "anthropic-version": "2023-06-01",
          ...resolved.headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: { id?: string }[] };
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((n): n is string => Boolean(n));
      if (models.length === 0) throw new Error("no models reported");
      return { ...base, models, source: "live" };
    }

    // OpenAI-compatible: GET {baseUrl}/models
    const res = await fetchFn(`${resolved.baseUrl.replace(/\/$/, "")}/models`, {
      headers: {
        ...(resolved.apiKey
          ? { Authorization: `Bearer ${resolved.apiKey}` }
          : {}),
        ...resolved.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((n): n is string => Boolean(n));
    if (models.length === 0) throw new Error("no models reported");
    return { ...base, models, source: "live" };
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Persist a new default model for an endpoint in endpoints.json.
 * Atomic write (tmp + rename); callers should re-resolve the registry
 * (LlmRegistry.fromFile) to pick up the change.
 */
export function updateEndpointModel(opts: {
  endpointsPath: string;
  endpointId: string;
  modelId: string;
}): EndpointsConfig {
  const raw = JSON.parse(readFileSync(opts.endpointsPath, "utf-8")) as unknown;
  const config = EndpointsConfigSchema.parse(raw);
  const endpoint = config.endpoints.find((e) => e.id === opts.endpointId);
  if (!endpoint) {
    throw new Error(`Unknown endpoint: ${opts.endpointId}`);
  }
  endpoint.modelId = opts.modelId;
  const tmp = `${opts.endpointsPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmp, opts.endpointsPath);
  return config;
}
