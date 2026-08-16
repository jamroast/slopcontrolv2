import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ProviderConfigSchema,
  ProvidersConfigSchema,
  type LlmEndpoint,
  type ProviderConfig,
  type ProvidersConfig,
} from "@slopcontrol/types";

export function defaultProvidersPath(dataDir?: string): string {
  const root = dataDir ?? join(homedir(), ".slopcontrol");
  return join(root, "providers.json");
}

export function defaultProvidersConfig(): ProvidersConfig {
  return { providers: {} };
}

export function loadProvidersConfig(configPath?: string): ProvidersConfig {
  const path = configPath ?? defaultProvidersPath(process.env.SLOPCONTROL_DATA_DIR);
  if (!existsSync(path)) {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    const defaults = defaultProvidersConfig();
    writeFileSync(path, JSON.stringify(defaults, null, 2), "utf-8");
    return defaults;
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return ProvidersConfigSchema.parse(raw);
}

/**
 * Env-var fallback name for a provider: "openrouter" → "OPENROUTER_API_KEY",
 * "ollama-cloud" → "OLLAMA_CLOUD_API_KEY", "local-ollama" → "LOCAL_OLLAMA_API_KEY".
 */
export function providerEnvVarName(providerName: string): string {
  return `${providerName.toUpperCase().replace(/-/g, "_")}_API_KEY`;
}

/**
 * Resolve a provider's API key. Priority:
 * 1. providers.json entry (explicit config wins)
 * 2. ${PROVIDER_NAME}_API_KEY env var (backward compat / quick override)
 * 3. undefined (local provider with no key)
 */
export function resolveProviderKey(
  providerName: string,
  config: ProvidersConfig,
): string | undefined {
  const entry = config.providers[providerName];
  if (entry?.apiKey !== undefined && entry.apiKey !== null) {
    return entry.apiKey;
  }
  const envVar = providerEnvVarName(providerName);
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}

/**
 * Merge provider config into an endpoint. The endpoint's own fields win
 * on conflict — the provider is the default, not the override.
 */
export function mergeEndpointWithProvider(
  endpoint: LlmEndpoint,
  provider: ProviderConfig,
): LlmEndpoint {
  return {
    ...endpoint,
    baseUrl: endpoint.baseUrl || provider.defaultBaseUrl || endpoint.baseUrl,
    // Provider key fills in when the endpoint has no explicit apiKey
    apiKey: endpoint.apiKey ?? provider.apiKey ?? undefined,
    // Provider headers are defaults; endpoint headers override per-key
    headers: endpoint.headers
      ? { ...provider.headers, ...endpoint.headers }
      : provider.headers,
    timeoutMs: endpoint.timeoutMs ?? provider.timeoutMs,
    defaultParams: endpoint.defaultParams
      ? { ...provider.defaultParams, ...endpoint.defaultParams }
      : provider.defaultParams,
  };
}

/**
 * Resolve an endpoint's secrets using providers.json when the endpoint has a
 * `provider` field, falling back to env-var substitution for ${VAR} patterns.
 */
export function resolveEndpointWithProviders(
  endpoint: LlmEndpoint,
  providers: ProvidersConfig,
): LlmEndpoint {
  if (!endpoint.provider) {
    return endpoint;
  }
  const provider = providers.providers[endpoint.provider];
  if (!provider) {
    // Provider not in providers.json — try env-var fallback for the key
    const envVar = providerEnvVarName(endpoint.provider);
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv) {
      return { ...endpoint, apiKey: fromEnv };
    }
    return endpoint;
  }
  return mergeEndpointWithProvider(endpoint, provider);
}

/** Merge a partial provider update into an existing entry (PUT / provider_set). */
export function mergeProviderUpdate(
  existing: ProviderConfig | undefined,
  body: Record<string, unknown>,
): ProviderConfig {
  const next: ProviderConfig = { ...(existing ?? {}) };
  if (body.apiKey !== undefined) {
    next.apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
  }
  if (typeof body.defaultBaseUrl === "string") {
    next.defaultBaseUrl = body.defaultBaseUrl;
  }
  if (
    typeof body.headers === "object" &&
    body.headers !== null &&
    !Array.isArray(body.headers)
  ) {
    next.headers = body.headers as Record<string, string>;
  }
  if (typeof body.timeoutMs === "number") {
    next.timeoutMs = body.timeoutMs;
  }
  if (
    typeof body.defaultParams === "object" &&
    body.defaultParams !== null &&
    !Array.isArray(body.defaultParams)
  ) {
    next.defaultParams = body.defaultParams as ProviderConfig["defaultParams"];
  }
  return ProviderConfigSchema.parse(next);
}
