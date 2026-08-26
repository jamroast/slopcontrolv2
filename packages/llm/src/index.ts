import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  EndpointsConfigSchema,
  type AgentRole,
  type EndpointsConfig,
  type LlmEndpoint,
  type ProvidersConfig,
  type RoleBinding,
  type RoleModelBindings,
} from "@slopcontrol/types";
import { endpointSupportsVision } from "./capabilities.js";
import {
  defaultProvidersPath,
  loadProvidersConfig,
} from "./providers.js";
import { resolveEndpointSecrets } from "./secrets.js";

export { substituteEnv, resolveEndpointSecrets } from "./secrets.js";
export {
  assertVisionCapable,
  endpointSupportsImageGen,
  endpointSupportsVision,
} from "./capabilities.js";

/**
 * Mastra agent/OM model config. Prefer this over AI SDK LanguageModel so we
 * avoid Models.dev gateway defaults (e.g. google/gemini) and type mismatches.
 */
export interface MastraModelConfig {
  id: `${string}/${string}`;
  url?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Sampling params forwarded to the agent loop (agent.stream modelSettings). */
  defaultParams?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
  };
}

export function defaultConfigPath(dataDir?: string): string {
  const root = dataDir ?? join(homedir(), ".slopcontrol");
  return join(root, "endpoints.json");
}

export function defaultEndpointsConfig(): EndpointsConfig {
  return EndpointsConfigSchema.parse({
    endpoints: [
      {
        id: "local-ollama",
        label: "Local Ollama",
        baseUrl: "http://localhost:11434/v1",
        apiType: "openai-chat",
        modelId: "llama3.2",
      },
    ],
    roles: {
      research: { endpointId: "local-ollama" },
      planning: { endpointId: "local-ollama" },
      supervisor: { endpointId: "local-ollama" },
      coding: { endpointId: "local-ollama" },
    },
  });
}

export function loadEndpointsConfig(configPath?: string): EndpointsConfig {
  const path = configPath ?? defaultConfigPath(process.env.SLOPCONTROL_DATA_DIR);
  if (!existsSync(path)) {
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true });
    const defaults = defaultEndpointsConfig();
    writeFileSync(path, JSON.stringify(defaults, null, 2), "utf-8");
    return defaults;
  }

  const raw = JSON.parse(readFileSync(path, "utf-8"));
  return EndpointsConfigSchema.parse(raw);
}

function providerPrefix(apiType: LlmEndpoint["apiType"]): string {
  switch (apiType) {
    case "anthropic-messages":
      return "anthropic";
    case "openai-images":
      return "openai";
    default:
      // openai-compatible custom baseURL (Ollama, Ollama Cloud, Vercel, etc.)
      return "openai";
  }
}

export type RoleBindingInfo = {
  role: AgentRole;
  bound: boolean;
  explicit: boolean;
  fallbackFrom: AgentRole | null;
  binding: RoleBinding | null;
};

/**
 * Describe how a function (agent role) is bound in endpoints.json,
 * including fallbacks (classification/design → planning, chat → supervisor,
 * ask/agent → research, judge → ask then research).
 * Does not throw for unbound optional roles (designVision / designImage).
 */
export function roleBindingInfo(
  roles: RoleModelBindings,
  role: AgentRole,
): RoleBindingInfo {
  const direct = roles[role as keyof RoleModelBindings];
  if (direct) {
    return {
      role,
      bound: true,
      explicit: true,
      fallbackFrom: null,
      binding: direct,
    };
  }

  if (role === "design" || role === "classification") {
    return {
      role,
      bound: true,
      explicit: false,
      fallbackFrom: "planning",
      binding: roles.planning,
    };
  }
  if (role === "chat") {
    return {
      role,
      bound: true,
      explicit: false,
      fallbackFrom: "supervisor",
      binding: roles.supervisor,
    };
  }
  if (role === "ask" || role === "agent") {
    return {
      role,
      bound: true,
      explicit: false,
      fallbackFrom: "research",
      binding: roles.research,
    };
  }
  if (role === "judge") {
    return {
      role,
      bound: true,
      explicit: false,
      fallbackFrom: roles.ask ? "ask" : "research",
      binding: roles.ask ?? roles.research,
    };
  }
  if (role === "designVision" || role === "designImage") {
    return {
      role,
      bound: false,
      explicit: false,
      fallbackFrom: null,
      binding: null,
    };
  }

  const required = roles[role as "research" | "planning" | "supervisor" | "coding"];
  return {
    role,
    bound: Boolean(required),
    explicit: Boolean(required),
    fallbackFrom: null,
    binding: required ?? null,
  };
}

function bindingForRole(
  roles: RoleModelBindings,
  role: AgentRole,
  roleOverrides?: Partial<RoleModelBindings>,
): RoleBinding {
  const override = roleOverrides?.[role];
  if (override) return override;

  const info = roleBindingInfo(roles, role);
  if (info.binding) return info.binding;

  if (role === "designVision" || role === "designImage") {
    throw new Error(
      `Role "${role}" is not bound in endpoints.json. ` +
        (role === "designVision"
          ? "Bind a vision-capable chat model (capabilities.vision: true)."
          : "Bind an image-generation model (capabilities.imageGen: true / apiType openai-images)."),
    );
  }

  throw new Error(`Role "${role}" is not bound in endpoints.json`);
}

export function toMastraModelConfig(
  endpoint: LlmEndpoint,
  modelIdOverride?: string,
  providers?: ProvidersConfig,
): MastraModelConfig {
  const resolved = resolveEndpointSecrets(endpoint, providers);
  const modelId = modelIdOverride ?? resolved.modelId;
  const prefix = providerPrefix(resolved.apiType);
  const apiKey = resolved.apiKey?.trim() ?? "";

  if (resolved.apiKey !== undefined && resolved.apiKey.includes("${")) {
    throw new Error(
      `Endpoint "${resolved.id}" apiKey still contains an unsubstituted env placeholder. ` +
        `Ensure the variable is set (e.g. OLLAMA_API_KEY) and that the server loaded the monorepo root .env.`,
    );
  }

  if (!apiKey && /ollama\.com|ollama\.cloud/i.test(resolved.baseUrl)) {
    throw new Error(
      `Endpoint "${resolved.id}" requires an API key for ${resolved.baseUrl}. ` +
        `Set OLLAMA_API_KEY in the monorepo root .env (or ~/.slopcontrol/.env) and restart the server.`,
    );
  }

  return {
    id: `${prefix}/${modelId}`,
    url: resolved.baseUrl,
    apiKey: apiKey || "not-needed",
    headers: resolved.headers,
    defaultParams: resolved.defaultParams,
  };
}

export class LlmRegistry {
  private readonly endpoints: Map<string, LlmEndpoint>;
  private readonly roles: RoleModelBindings;
  private readonly providers: ProvidersConfig;

  constructor(config: EndpointsConfig, providers?: ProvidersConfig) {
    this.endpoints = new Map(config.endpoints.map((e) => [e.id, e]));
    this.roles = config.roles;
    this.providers = providers ?? { providers: {} };
  }

  static fromFile(configPath?: string, providersPath?: string): LlmRegistry {
    const endpointsPath =
      configPath ?? defaultConfigPath(process.env.SLOPCONTROL_DATA_DIR);
    const resolvedProvidersPath =
      providersPath ?? join(dirname(endpointsPath), "providers.json");
    const endpoints = loadEndpointsConfig(endpointsPath);
    const providers = loadProvidersConfig(resolvedProvidersPath);
    return new LlmRegistry(endpoints, providers);
  }

  getEndpoint(id: string): LlmEndpoint {
    const endpoint = this.endpoints.get(id);
    if (!endpoint) {
      throw new Error(`Unknown LLM endpoint: ${id}`);
    }
    return endpoint;
  }

  listEndpoints(): LlmEndpoint[] {
    return [...this.endpoints.values()];
  }

  getRoleBindings(): RoleModelBindings {
    return this.roles;
  }

  getProviders(): ProvidersConfig {
    return this.providers;
  }

  /** True when a role has an explicit binding (after overrides). */
  hasRoleBinding(
    role: AgentRole,
    roleOverrides?: Partial<RoleModelBindings>,
  ): boolean {
    if (roleOverrides?.[role]) return true;
    if (role === "design") {
      return Boolean(this.roles.design) || Boolean(this.roles.planning);
    }
    if (role === "classification") {
      return (
        Boolean(this.roles.classification) || Boolean(this.roles.planning)
      );
    }
    if (role === "chat") {
      return Boolean(this.roles.chat) || Boolean(this.roles.supervisor);
    }
    if (role === "ask" || role === "agent") {
      return Boolean(this.roles[role]) || Boolean(this.roles.research);
    }
    if (role === "judge") {
      return (
        Boolean(this.roles.judge) ||
        Boolean(this.roles.ask) ||
        Boolean(this.roles.research)
      );
    }
    const binding = this.roles[role as keyof RoleModelBindings];
    return Boolean(binding);
  }

  resolve(role: AgentRole, roleOverrides?: Partial<RoleModelBindings>): MastraModelConfig {
    const binding = bindingForRole(this.roles, role, roleOverrides);
    const endpoint = this.getEndpoint(binding.endpointId);
    return toMastraModelConfig(endpoint, binding.modelId, this.providers);
  }

  resolveEndpointForRole(
    role: AgentRole,
    roleOverrides?: Partial<RoleModelBindings>,
  ): { endpoint: LlmEndpoint; modelId: string; mastraModel: MastraModelConfig } {
    const binding = bindingForRole(this.roles, role, roleOverrides);
    const endpoint = resolveEndpointSecrets(
      this.getEndpoint(binding.endpointId),
      this.providers,
    );
    const modelId = binding.modelId ?? endpoint.modelId;
    return {
      endpoint,
      modelId,
      mastraModel: toMastraModelConfig(endpoint, modelId, this.providers),
    };
  }

  /**
   * Resolve designVision only when bound and vision-capable.
   * Returns null when unbound or not vision-capable (caller should skip).
   */
  tryResolveDesignVision(
    roleOverrides?: Partial<RoleModelBindings>,
  ): { endpoint: LlmEndpoint; modelId: string } | null {
    const binding =
      roleOverrides?.designVision ?? this.roles.designVision ?? null;
    if (!binding) return null;
    const endpoint = resolveEndpointSecrets(
      this.getEndpoint(binding.endpointId),
      this.providers,
    );
    if (!endpointSupportsVision(endpoint)) return null;
    return {
      endpoint,
      modelId: binding.modelId ?? endpoint.modelId,
    };
  }

  /**
   * Resolve designImage when bound; returns null when unbound (SVG fallback).
   */
  tryResolveDesignImage(
    roleOverrides?: Partial<RoleModelBindings>,
  ): { endpoint: LlmEndpoint; modelId: string } | null {
    const binding = roleOverrides?.designImage ?? this.roles.designImage ?? null;
    if (!binding) return null;
    const endpoint = resolveEndpointSecrets(
      this.getEndpoint(binding.endpointId),
      this.providers,
    );
    return {
      endpoint,
      modelId: binding.modelId ?? endpoint.modelId,
    };
  }
}

export * from "./providers.js";
export * from "./vision-chat.js";
export * from "./json-chat.js";
export * from "./intent-extract.js";
export * from "./continue-intent-llm.js";
export * from "./chat-confirm-llm.js";
export * from "./ask-resume-llm.js";
export * from "./ask-investigate-engine-llm.js";
export * from "./plan-continue-intent-llm.js";
export * from "./plan-start-intent-llm.js";
export * from "./plan-turn-intent-llm.js";
export * from "./design-turn-intent-llm.js";
export * from "./intent-research-conflict-llm.js";
export * from "./host-verify-env-llm.js";
export * from "./revision-target-llm.js";
export * from "./doc-revision-judge-llm.js";
export * from "./dependency-intent-llm.js";
export * from "./element-honor-llm.js";
export * from "./build-process-config-llm.js";
export * from "./verify-failure-llm.js";
export * from "./claim-proof-llm.js";
export * from "./intent-alignment-llm.js";
export * from "./research-engagement-llm.js";
export * from "./ask-narration-llm.js";
export * from "@slopcontrol/types";
