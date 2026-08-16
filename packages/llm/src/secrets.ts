import type { LlmEndpoint, ProvidersConfig } from "@slopcontrol/types";
import {
  resolveEndpointWithProviders,
  providerEnvVarName,
} from "./providers.js";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function substituteEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(ENV_PATTERN, (_, name: string) => process.env[name] ?? "");
}

export function resolveEndpointSecrets(
  endpoint: LlmEndpoint,
  providers?: ProvidersConfig,
): LlmEndpoint {
  // Step 1: merge provider config (providers.json) when endpoint.provider is set
  let resolved = endpoint;
  if (providers && endpoint.provider) {
    resolved = resolveEndpointWithProviders(endpoint, providers);
  }

  // Step 2: env-var substitution for ${VAR} patterns in apiKey/headers
  resolved = {
    ...resolved,
    apiKey: substituteEnv(resolved.apiKey),
    headers: resolved.headers
      ? Object.fromEntries(
          Object.entries(resolved.headers).map(([key, val]) => [
            key,
            substituteEnv(val) ?? val,
          ]),
        )
      : undefined,
  };

  // Step 3: if the endpoint has a provider but no key yet, try the
  // provider env-var convention (e.g. provider: "openrouter" → OPENROUTER_API_KEY)
  if (resolved.provider && !resolved.apiKey) {
    const envVar = providerEnvVarName(resolved.provider);
    const fromEnv = process.env[envVar]?.trim();
    if (fromEnv) {
      resolved = { ...resolved, apiKey: fromEnv };
    }
  }

  return resolved;
}
