import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import {
  resolveEndpointSecrets,
  roleBindingInfo,
  type LlmEndpoint,
} from "@slopcontrol/llm";
import {
  AgentRoleSchema,
  EndpointsConfigSchema,
  LlmEndpointSchema,
  type AgentRole,
  type EndpointsConfig,
  type ProvidersConfig,
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
  /** providers.json key when the endpoint uses a configured provider. */
  provider?: string;
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
  /** providers.json key — pass as `provider` when binding. */
  providerName: string;
  /** Legacy endpoint handle; for configured providers this equals providerName. */
  endpointId: string;
  baseUrl: string;
  /** True when this endpoint's configured modelId is already this model. */
  mapped: boolean;
}

export interface ProviderCatalog {
  /** providers.json key, or legacy endpoint id for unlisted providers. */
  providerName: string;
  /** UI handle — same as providerName for configured providers. */
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
  /** providers.json key when bound via configured provider. */
  provider?: string;
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
  if (endpoint.provider) return endpoint.provider;
  if (isLocalOllama(endpoint.baseUrl)) return "Local Ollama";
  try {
    const host = new URL(endpoint.baseUrl).hostname;
    if (/ollama\.com$|ollama\.cloud$/i.test(host)) return "Ollama Cloud";
    if (/openrouter\.ai$/i.test(host)) return "openrouter";
    return host;
  } catch {
    return endpoint.label ?? endpoint.id;
  }
}

export function providersPathFromEndpoints(endpointsPath: string): string {
  return join(dirname(endpointsPath), "providers.json");
}

/** Synthetic endpoint used to probe a providers.json entry. */
export function syntheticEndpointForProvider(
  providerName: string,
  providersConfig: ProvidersConfig,
  apiType: LlmEndpoint["apiType"] = "openai-chat",
): LlmEndpoint {
  const entry = providersConfig.providers[providerName];
  if (!entry?.defaultBaseUrl?.trim()) {
    throw new Error(
      `Provider "${providerName}" is not configured or has no defaultBaseUrl`,
    );
  }
  return LlmEndpointSchema.parse({
    id: providerName,
    label: providerName,
    baseUrl: entry.defaultBaseUrl,
    provider: providerName,
    apiType,
    modelId: "probe",
  });
}

/** Live model catalogs for every entry in providers.json. */
export async function listConfiguredProviderCatalogs(
  providersConfig: ProvidersConfig,
  fetchFn: FetchLike = fetch,
  timeoutMs = 10_000,
): Promise<ProviderCatalog[]> {
  const catalogs: ProviderCatalog[] = [];
  for (const providerName of Object.keys(providersConfig.providers)) {
    const entry = providersConfig.providers[providerName];
    if (!entry?.defaultBaseUrl?.trim()) continue;
    const synthetic = syntheticEndpointForProvider(providerName, providersConfig);
    const listed = await listEndpointModels(
      synthetic,
      fetchFn,
      timeoutMs,
      providersConfig,
    );
    catalogs.push({
      providerName,
      endpointId: providerName,
      label: providerDisplayName(synthetic),
      provider: providerDisplayName(synthetic),
      baseUrl: synthetic.baseUrl,
      apiType: synthetic.apiType,
      models: listed.models,
      source: listed.source,
      ...(listed.error ? { error: listed.error } : {}),
      mappedModelIds: [],
    });
  }
  return catalogs;
}

function endpointsForCatalog(
  config: EndpointsConfig,
  catalog: ProviderCatalog,
): LlmEndpoint[] {
  const byProvider = config.endpoints.filter(
    (e) => e.provider === catalog.providerName,
  );
  if (byProvider.length > 0) return byProvider;
  return config.endpoints.filter(
    (e) =>
      providerKey(e) ===
      providerKey({
        baseUrl: catalog.baseUrl,
        apiType: catalog.apiType as LlmEndpoint["apiType"],
      }),
  );
}

/**
 * Merge providers.json catalogs with legacy endpoint-only providers
 * (e.g. openai-images endpoints not declared in providers.json).
 */
export async function buildProviderCatalogs(opts: {
  endpoints: LlmEndpoint[];
  providersConfig: ProvidersConfig;
  fetchFn?: FetchLike;
  timeoutMs?: number;
}): Promise<{ catalogs: ProviderCatalog[]; endpointListings: EndpointModelList[] }> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const jsonCatalogs = await listConfiguredProviderCatalogs(
    opts.providersConfig,
    fetchFn,
    timeoutMs,
  );
  const coveredKeys = new Set(
    jsonCatalogs.map((c) =>
      providerKey({
        baseUrl: c.baseUrl,
        apiType: c.apiType as LlmEndpoint["apiType"],
      }),
    ),
  );
  const configuredProviderNames = new Set(
    Object.entries(opts.providersConfig.providers)
      .filter(([, e]) => e.defaultBaseUrl?.trim())
      .map(([name]) => name),
  );

  const endpointListings = await listUniqueProviderModels(
    opts.endpoints,
    fetchFn,
    timeoutMs,
    opts.providersConfig,
  );

  const legacyCatalogs: ProviderCatalog[] = [];
  const groups = new Map<string, LlmEndpoint[]>();
  for (const endpoint of opts.endpoints) {
    if (endpoint.provider && configuredProviderNames.has(endpoint.provider)) {
      continue;
    }
    const key = providerKey(endpoint);
    if (coveredKeys.has(key)) continue;
    const group = groups.get(key) ?? [];
    group.push(endpoint);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const representative = group[0]!;
    const listed = await listEndpointModels(
      representative,
      fetchFn,
      timeoutMs,
      opts.providersConfig,
    );
    const modelIds = new Set(listed.models);
    for (const ep of group) modelIds.add(ep.modelId);
    legacyCatalogs.push({
      providerName: representative.provider ?? representative.id,
      endpointId: representative.id,
      label: providerDisplayName(representative),
      provider: providerDisplayName(representative),
      baseUrl: representative.baseUrl,
      apiType: representative.apiType,
      models: [...modelIds],
      source: listed.source,
      ...(listed.error ? { error: listed.error } : {}),
      mappedModelIds: group.map((e) => e.modelId),
    });
  }

  const configLike = { endpoints: opts.endpoints, roles: {} as EndpointsConfig["roles"] };
  for (const catalog of jsonCatalogs) {
    catalog.mappedModelIds = endpointsForCatalog(configLike, catalog).map(
      (e) => e.modelId,
    );
  }

  return { catalogs: [...jsonCatalogs, ...legacyCatalogs], endpointListings };
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


export async function listEndpointModels(
  endpoint: LlmEndpoint,
  fetchFn: FetchLike = fetch,
  timeoutMs = 10_000,
  providers?: ProvidersConfig,
): Promise<EndpointModelList> {
  const resolved = resolveEndpointSecrets(endpoint, providers);
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
  catalogs: ProviderCatalog[],
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
            provider: endpoint.provider,
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

  const models: AvailableModel[] = [];
  const providerViews: ProviderCatalog[] = [];

  for (const catalog of catalogs) {
    const group = endpointsForCatalog(config, catalog);
    const mappedByModel = new Map(group.map((ep) => [ep.modelId, ep] as const));

    for (const modelId of catalog.models) {
      const mappedEp = mappedByModel.get(modelId);
      models.push({
        modelId,
        label: modelId,
        provider: catalog.provider,
        providerName: catalog.providerName,
        endpointId: mappedEp?.id ?? catalog.endpointId,
        baseUrl: catalog.baseUrl,
        mapped: Boolean(mappedEp),
      });
    }

    providerViews.push({
      ...catalog,
      mappedModelIds: group.map((e) => e.modelId),
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
  providers?: ProvidersConfig,
): Promise<EndpointModelList[]> {
  const firstByKey = new Map<string, LlmEndpoint>();
  for (const endpoint of endpoints) {
    const key = providerKey(endpoint);
    if (!firstByKey.has(key)) firstByKey.set(key, endpoint);
  }
  const catalogs = await Promise.all(
    [...firstByKey.entries()].map(async ([key, endpoint]) => {
      const listed = await listEndpointModels(
        endpoint,
        fetchFn,
        timeoutMs,
        providers,
      );
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
  catalogs: ProviderCatalog[],
  modelId: string,
  opts: { endpointId?: string },
): { template: LlmEndpoint; existing: LlmEndpoint | null } {
  if (opts.endpointId) {
    const template = config.endpoints.find((e) => e.id === opts.endpointId);
    if (!template) {
      throw new Error(`Unknown endpoint: ${opts.endpointId}`);
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
    catalogs.some(
      (c) =>
        c.models.includes(modelId) &&
        (e.provider === c.providerName ||
          providerKey(e) ===
            providerKey({
              baseUrl: c.baseUrl,
              apiType: c.apiType as LlmEndpoint["apiType"],
            })),
    ),
  );

  if (exact.length === 1) {
    return { template: exact[0]!, existing: exact[0]! };
  }
  if (exact.length > 1) {
    const ids = exact.map((e) => e.id).join(", ");
    throw new Error(
      `Model "${modelId}" is mapped on more than one endpoint (${ids}). Pass provider to choose the provider.`,
    );
  }

  const providerKeys = new Set(
    listing.map((e) => `${normalizeUrl(e.baseUrl)}|${e.apiType}`),
  );
  if (providerKeys.size === 1) {
    return { template: listing[0]!, existing: null };
  }
  if (providerKeys.size > 1) {
    const names = [...new Set(listing.map((e) => e.provider ?? e.id))].join(
      ", ",
    );
    throw new Error(
      `Model "${modelId}" is available from more than one provider (${names}). Pass provider to choose the provider.`,
    );
  }

  throw new Error(
    `Model "${modelId}" is not listed by any configured provider. Pass provider (from chat_models_list) to bind it.`,
  );
}

function bindByProvider(opts: {
  config: EndpointsConfig;
  role: AgentRole;
  modelId: string;
  provider: string;
  providersConfig: ProvidersConfig;
}): { endpointId: string; createdEndpoint: boolean } {
  const template = syntheticEndpointForProvider(
    opts.provider,
    opts.providersConfig,
  );
  const existing =
    opts.config.endpoints.find(
      (e) => e.provider === opts.provider && e.modelId === opts.modelId,
    ) ?? null;

  if (existing) {
    if (opts.role === "designVision" || opts.role === "designImage") {
      existing.capabilities = capabilitiesForRole(existing, opts.role);
    }
    return { endpointId: existing.id, createdEndpoint: false };
  }

  const endpointId = allocateEndpointId(opts.config, template, opts.modelId);
  opts.config.endpoints.push(
    cloneEndpointForModel(template, endpointId, opts.modelId, opts.role),
  );
  return { endpointId, createdEndpoint: true };
}

/**
 * Bind a platform function (agent role) to a model on a provider.
 * Prefer `provider` (providers.json key) + modelId.
 */
export function bindFunctionToModel(opts: {
  endpointsPath: string;
  function: AgentRole;
  modelId: string;
  provider?: string;
  endpointId?: string;
  providersConfig?: ProvidersConfig;
  catalogs?: ProviderCatalog[];
}): BindFunctionResult {
  const role = AgentRoleSchema.parse(opts.function);
  const modelId = opts.modelId.trim();
  if (!modelId) {
    throw new Error("modelId required");
  }

  const config = loadEndpointsFile(opts.endpointsPath);
  const catalogs = opts.catalogs ?? [];

  let endpointId: string;
  let createdEndpoint = false;
  let boundProvider: string | undefined;

  if (opts.provider) {
    if (!opts.providersConfig) {
      throw new Error("providersConfig required when binding by provider");
    }
    const bound = bindByProvider({
      config,
      role,
      modelId,
      provider: opts.provider,
      providersConfig: opts.providersConfig,
    });
    endpointId = bound.endpointId;
    createdEndpoint = bound.createdEndpoint;
    boundProvider = opts.provider;
  } else if (
    opts.endpointId &&
    opts.providersConfig?.providers[opts.endpointId]?.defaultBaseUrl
  ) {
    const bound = bindByProvider({
      config,
      role,
      modelId,
      provider: opts.endpointId,
      providersConfig: opts.providersConfig,
    });
    endpointId = bound.endpointId;
    createdEndpoint = bound.createdEndpoint;
    boundProvider = opts.endpointId;
  } else {
    const { template, existing } = findTemplate(config, catalogs, modelId, {
      endpointId: opts.endpointId,
    });

    if (existing) {
      endpointId = existing.id;
      boundProvider = existing.provider;
      if (role === "designVision" || role === "designImage") {
        existing.capabilities = capabilitiesForRole(existing, role);
      }
    } else {
      endpointId = allocateEndpointId(config, template, modelId);
      config.endpoints.push(
        cloneEndpointForModel(template, endpointId, modelId, role),
      );
      createdEndpoint = true;
      boundProvider = template.provider;
    }
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
    provider: boundProvider,
    createdEndpoint,
  };
}
