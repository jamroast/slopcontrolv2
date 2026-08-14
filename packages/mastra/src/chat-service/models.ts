import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolveEndpointSecrets, roleBindingInfo, type LlmEndpoint } from "@slopcontrol/llm";
import {
  AgentRoleSchema,
  EndpointsConfigSchema,
  LlmEndpointSchema,
  type AgentRole,
  type EndpointsConfig,
} from "@slopcontrol/types";

export interface EndpointModelList {
  endpointId: string;
  /** Currently configured default model. */
  configuredModel: string;
  /** Models advertised by the provider (or [configuredModel] when unlistable). */
  models: string[];
  source: "live" | "configured";
  error?: string;
}

export const LLM_FUNCTION_DESCRIPTIONS: Record<AgentRole, string> = {
  research: "Research agent (RESEARCH.md)",
  planning: "Planning / SPEC / PLAN drafting",
  supervisor: "Supervisor / orchestration",
  coding: "Coding / development agent",
  design: "UI-SPEC / design tokens (falls back to planning when unbound)",
  designVision: "Multimodal design review — needs a vision-capable model",
  designImage: "Raster image generation — needs an imageGen-capable model",
  classification:
    "Structured JSON classification (intent, confirm, etc.; falls back to planning when unbound)",
  chat: "Operator chat agent (falls back to supervisor when unbound)",
  ask: "Ask agent — read-only codebase investigation (falls back to research when unbound)",
  agent:
    "Agent chat — inspect/verify with shell (falls back to research when unbound)",
  judge:
    "Post-investigate / post-coding synthesis judge (falls back to ask, then research)",
};

export interface FunctionCurrentBinding {
  modelId: string;
  endpointId: string;
  /** True when this function has its own roles[] entry (not a fallback). */
  explicit: boolean;
  fallbackFrom?: AgentRole;
}

export interface FunctionMapping {
  function: AgentRole;
  description: string;
  current: FunctionCurrentBinding | null;
}

export interface AvailableModel {
  modelId: string;
  /** Display name — same as modelId. UIs that render `label` must show the model, not the provider. */
  label: string;
  /** Provider display name (e.g. "Local Ollama", "Ollama Cloud"). */
  provider: string;
  /** Provider handle — pass as endpointId when the same model exists on more than one provider. */
  endpointId: string;
  baseUrl: string;
  /** True when this endpoint's configured modelId is already this model. */
  mapped: boolean;
}

export interface ProviderCatalog {
  /** Template handle for this provider — pass as endpointId when binding a new model. */
  endpointId: string;
  /** Provider display name (e.g. "Local Ollama", "Ollama Cloud"). */
  label: string;
  provider: string;
  baseUrl: string;
  apiType: string;
  models: string[];
  source: "live" | "configured";
  error?: string;
  /** Model ids that already have an endpoint mapping on this provider. */
  mappedModelIds: string[];
}

export interface FunctionMappingList {
  functions: FunctionMapping[];
  models: AvailableModel[];
  providers: ProviderCatalog[];
}

export interface BindFunctionResult {
  config: EndpointsConfig;
  function: AgentRole;
  modelId: string;
  endpointId: string;
  createdEndpoint: boolean;
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
  try {
    const url = new URL(baseUrl);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === "11434"
    );
  } catch {
    return false;
  }
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function providerKey(endpoint: { baseUrl: string; apiType: string }): string {
  return `${normalizeUrl(endpoint.baseUrl)}|${endpoint.apiType}`;
}

function sameProvider(a: LlmEndpoint, b: LlmEndpoint): boolean {
  return providerKey(a) === providerKey(b);
}

function providerDisplayName(endpoint: LlmEndpoint): string {
  if (isLocalOllama(endpoint.baseUrl)) return "Local Ollama";
  try {
    const host = new URL(endpoint.baseUrl).hostname;
    if (/ollama\.com$|ollama\.cloud$/i.test(host)) return "Ollama Cloud";
    return host;
  } catch {
    return endpoint.label ?? endpoint.id;
  }
}

function writeEndpointsConfig(path: string, config: EndpointsConfig): EndpointsConfig {
  const parsed = EndpointsConfigSchema.parse(config);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(parsed, null, 2), "utf-8");
  renameSync(tmp, path);
  return parsed;
}

function loadEndpointsFile(path: string): EndpointsConfig {
  const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  return EndpointsConfigSchema.parse(raw);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "model";
}

function allocateEndpointId(
  config: EndpointsConfig,
  template: LlmEndpoint,
  modelId: string,
): string {
  let host = "provider";
  try {
    host = new URL(template.baseUrl).hostname.replace(/\./g, "-");
  } catch {
    /* keep default */
  }
  const base = `${slugify(host)}-${slugify(modelId)}`;
  const used = new Set(config.endpoints.map((e) => e.id));
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function capabilitiesForRole(
  template: LlmEndpoint,
  role: AgentRole,
): LlmEndpoint["capabilities"] {
  const capabilities = {
    chat: template.capabilities?.chat ?? true,
    vision: template.capabilities?.vision ?? false,
    imageGen: template.capabilities?.imageGen ?? false,
  };
  if (role === "designVision") capabilities.vision = true;
  if (role === "designImage") capabilities.imageGen = true;
  return capabilities;
}

function cloneEndpointForModel(
  template: LlmEndpoint,
  id: string,
  modelId: string,
  role: AgentRole,
): LlmEndpoint {
  return LlmEndpointSchema.parse({
    ...template,
    id,
    label: modelId,
    modelId,
    capabilities: capabilitiesForRole(template, role),
  });
}

function modelsForEndpoint(
  endpoint: LlmEndpoint,
  providers: EndpointModelList[],
): string[] {
  const listed = providers.find((p) => p.endpointId === endpoint.id);
  const models = new Set<string>(listed?.models ?? []);
  models.add(endpoint.modelId);
  return [...models];
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
  const config = loadEndpointsFile(opts.endpointsPath);
  const endpoint = config.endpoints.find((e) => e.id === opts.endpointId);
  if (!endpoint) {
    throw new Error(`Unknown endpoint: ${opts.endpointId}`);
  }
  endpoint.modelId = opts.modelId;
  return writeEndpointsConfig(opts.endpointsPath, config);
}

export function buildFunctionMappingList(
  config: EndpointsConfig,
  providers: EndpointModelList[],
): FunctionMappingList {
  const byId = new Map(config.endpoints.map((e) => [e.id, e]));
  const functions: FunctionMapping[] = AgentRoleSchema.options.map((role) => {
    const info = roleBindingInfo(config.roles, role);
    const endpoint = info.binding
      ? byId.get(info.binding.endpointId)
      : undefined;
    const current: FunctionCurrentBinding | null =
      info.binding && endpoint
        ? {
            modelId: info.binding.modelId ?? endpoint.modelId,
            endpointId: endpoint.id,
            explicit: info.explicit,
            ...(info.fallbackFrom ? { fallbackFrom: info.fallbackFrom } : {}),
          }
        : null;
    return {
      function: role,
      description: LLM_FUNCTION_DESCRIPTIONS[role],
      current,
    };
  });

  const groups = new Map<string, LlmEndpoint[]>();
  for (const endpoint of config.endpoints) {
    const key = providerKey(endpoint);
    const group = groups.get(key) ?? [];
    group.push(endpoint);
    groups.set(key, group);
  }

  const models: AvailableModel[] = [];
  const providerViews: ProviderCatalog[] = [];

  for (const group of groups.values()) {
    const representative = group[0]!;
    const listings = group
      .map((ep) => providers.find((p) => p.endpointId === ep.id))
      .filter((p): p is EndpointModelList => Boolean(p));
    const live = listings.find((p) => p.source === "live");
    const listed = live ?? listings[0];
    const modelIds = new Set<string>(listed?.models ?? []);
    for (const ep of group) modelIds.add(ep.modelId);

    const mappedByModel = new Map(
      group.map((ep) => [ep.modelId, ep] as const),
    );

    for (const modelId of modelIds) {
      const mappedEp = mappedByModel.get(modelId);
      const provider = providerDisplayName(mappedEp ?? representative);
      models.push({
        modelId,
        label: modelId,
        provider,
        endpointId: mappedEp?.id ?? representative.id,
        baseUrl: representative.baseUrl,
        mapped: Boolean(mappedEp),
      });
    }

    const provider = providerDisplayName(representative);
    providerViews.push({
      endpointId: representative.id,
      label: provider,
      provider,
      baseUrl: representative.baseUrl,
      apiType: representative.apiType,
      models: [...modelIds],
      source: listed?.source ?? "configured",
      ...(listed?.error ? { error: listed.error } : {}),
      mappedModelIds: group.map((ep) => ep.modelId),
    });
  }

  return { functions, models, providers: providerViews };
}

/**
 * Fetch live model catalogs once per unique provider (baseUrl + apiType),
 * then stamp the catalog onto every endpoint of that provider.
 */
export async function listUniqueProviderModels(
  endpoints: LlmEndpoint[],
  fetchFn: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<EndpointModelList[]> {
  const firstByKey = new Map<string, LlmEndpoint>();
  for (const endpoint of endpoints) {
    const key = providerKey(endpoint);
    if (!firstByKey.has(key)) firstByKey.set(key, endpoint);
  }
  const catalogs = await Promise.all(
    [...firstByKey.entries()].map(async ([key, endpoint]) => {
      const listed = await listEndpointModels(endpoint, fetchFn, timeoutMs);
      return [key, listed] as const;
    }),
  );
  const byKey = new Map(catalogs);
  return endpoints.map((endpoint) => {
    const listed = byKey.get(providerKey(endpoint));
    if (!listed) {
      return {
        endpointId: endpoint.id,
        configuredModel: endpoint.modelId,
        models: [endpoint.modelId],
        source: "configured" as const,
      };
    }
    return {
      ...listed,
      endpointId: endpoint.id,
      configuredModel: endpoint.modelId,
    };
  });
}

function findTemplate(
  config: EndpointsConfig,
  providers: EndpointModelList[],
  modelId: string,
  endpointId?: string,
): { template: LlmEndpoint; existing: LlmEndpoint | null } {
  if (endpointId) {
    const template = config.endpoints.find((e) => e.id === endpointId);
    if (!template) {
      throw new Error(`Unknown endpoint: ${endpointId}`);
    }
    const existing =
      template.modelId === modelId
        ? template
        : (config.endpoints.find(
            (e) => sameProvider(e, template) && e.modelId === modelId,
          ) ?? null);
    return { template, existing };
  }

  const exact = config.endpoints.filter((e) => e.modelId === modelId);
  const listing = config.endpoints.filter((e) =>
    modelsForEndpoint(e, providers).includes(modelId),
  );

  if (exact.length === 1) {
    return { template: exact[0]!, existing: exact[0]! };
  }
  if (exact.length > 1) {
    const ids = exact.map((e) => e.id).join(", ");
    throw new Error(
      `Model "${modelId}" is mapped on more than one endpoint (${ids}). Pass endpointId to choose the provider.`,
    );
  }

  const providerKeys = new Set(
    listing.map((e) => `${normalizeUrl(e.baseUrl)}|${e.apiType}`),
  );
  if (providerKeys.size === 1) {
    return { template: listing[0]!, existing: null };
  }
  if (providerKeys.size > 1) {
    const ids = listing.map((e) => e.id).join(", ");
    throw new Error(
      `Model "${modelId}" is available from more than one provider (${ids}). Pass endpointId to choose the provider.`,
    );
  }

  throw new Error(
    `Model "${modelId}" is not in endpoints.json and no provider listed it. Pass endpointId of the provider to create the mapping.`,
  );
}

/**
 * Bind a platform function (agent role) to a model.
 * Reuses an endpoint that already has that modelId; otherwise clones the
 * provider endpoint into a new mapping and points the function at it.
 */
export function bindFunctionToModel(opts: {
  endpointsPath: string;
  function: AgentRole;
  modelId: string;
  endpointId?: string;
  providers: EndpointModelList[];
}): BindFunctionResult {
  const role = AgentRoleSchema.parse(opts.function);
  const modelId = opts.modelId.trim();
  if (!modelId) {
    throw new Error("modelId required");
  }

  const config = loadEndpointsFile(opts.endpointsPath);
  const { template, existing } = findTemplate(
    config,
    opts.providers,
    modelId,
    opts.endpointId,
  );

  let endpointId: string;
  let createdEndpoint = false;
  if (existing) {
    endpointId = existing.id;
    if (role === "designVision" || role === "designImage") {
      existing.capabilities = capabilitiesForRole(existing, role);
    }
  } else {
    endpointId = allocateEndpointId(config, template, modelId);
    config.endpoints.push(
      cloneEndpointForModel(template, endpointId, modelId, role),
    );
    createdEndpoint = true;
  }

  config.roles = {
    ...config.roles,
    [role]: { endpointId, modelId },
  };

  const written = writeEndpointsConfig(opts.endpointsPath, config);
  return {
    config: written,
    function: role,
    modelId,
    endpointId,
    createdEndpoint,
  };
}
