import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  EndpointsConfigSchema,
  type AgentRole,
  type EndpointsConfig,
  type LlmEndpoint,
  type RoleBinding,
  type RoleModelBindings,
} from "@slopcontrol/types";
import { endpointSupportsVision } from "./capabilities.js";
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

function bindingForRole(
  roles: RoleModelBindings,
  role: AgentRole,
  roleOverrides?: Partial<RoleModelBindings>,
): RoleBinding {
  const override = roleOverrides?.[role];
  if (override) return override;

  const direct = roles[role as keyof RoleModelBindings];
  if (direct) return direct;

  // Text design falls back to planning when unbound.
  if (role === "design") {
    return roles.planning;
  }

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
): MastraModelConfig {
  const resolved = resolveEndpointSecrets(endpoint);
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
  };
}

export class LlmRegistry {
  private readonly endpoints: Map<string, LlmEndpoint>;
  private readonly roles: RoleModelBindings;

  constructor(config: EndpointsConfig) {
    this.endpoints = new Map(config.endpoints.map((e) => [e.id, e]));
    this.roles = config.roles;
  }

  static fromFile(configPath?: string): LlmRegistry {
    return new LlmRegistry(loadEndpointsConfig(configPath));
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

  /** True when a role has an explicit binding (after overrides). */
  hasRoleBinding(
    role: AgentRole,
    roleOverrides?: Partial<RoleModelBindings>,
  ): boolean {
    if (roleOverrides?.[role]) return true;
    if (role === "design") {
      return Boolean(this.roles.design) || Boolean(this.roles.planning);
    }
    const binding = this.roles[role as keyof RoleModelBindings];
    return Boolean(binding);
  }

  resolve(role: AgentRole, roleOverrides?: Partial<RoleModelBindings>): MastraModelConfig {
    const binding = bindingForRole(this.roles, role, roleOverrides);
    const endpoint = this.getEndpoint(binding.endpointId);
    return toMastraModelConfig(endpoint, binding.modelId);
  }

  resolveEndpointForRole(
    role: AgentRole,
    roleOverrides?: Partial<RoleModelBindings>,
  ): { endpoint: LlmEndpoint; modelId: string; mastraModel: MastraModelConfig } {
    const binding = bindingForRole(this.roles, role, roleOverrides);
    const endpoint = resolveEndpointSecrets(this.getEndpoint(binding.endpointId));
    const modelId = binding.modelId ?? endpoint.modelId;
    return {
      endpoint,
      modelId,
      mastraModel: toMastraModelConfig(endpoint, modelId),
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
    const endpoint = resolveEndpointSecrets(this.getEndpoint(binding.endpointId));
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
    const endpoint = resolveEndpointSecrets(this.getEndpoint(binding.endpointId));
    return {
      endpoint,
      modelId: binding.modelId ?? endpoint.modelId,
    };
  }
}

export * from "./vision-chat.js";
export * from "./json-chat.js";
export * from "./intent-extract.js";
export * from "@slopcontrol/types";
