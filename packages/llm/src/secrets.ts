import type { LlmEndpoint } from "@slopcontrol/types";

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

export function substituteEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(ENV_PATTERN, (_, name: string) => process.env[name] ?? "");
}

export function resolveEndpointSecrets(endpoint: LlmEndpoint): LlmEndpoint {
  return {
    ...endpoint,
    apiKey: substituteEnv(endpoint.apiKey),
    headers: endpoint.headers
      ? Object.fromEntries(
          Object.entries(endpoint.headers).map(([key, val]) => [
            key,
            substituteEnv(val) ?? val,
          ]),
        )
      : undefined,
  };
}
