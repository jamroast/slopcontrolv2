import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const HostVerifyEnvRewriteSchema = z.object({
  key: z.string().min(1),
  original: z.string(),
  rewritten: z.string(),
  reason: z.string().optional(),
});

export const HostVerifyEnvResultSchema = z.object({
  rewrites: z.array(HostVerifyEnvRewriteSchema),
});

export type HostVerifyEnvRewrite = z.infer<typeof HostVerifyEnvRewriteSchema>;
export type HostVerifyEnvResult = z.infer<typeof HostVerifyEnvResultSchema>;

export const HOST_VERIFY_ENV_SYSTEM_PROMPT = `You decide which environment values point at docker-compose-internal services for HOST-side verification, and what the host-side value should be.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- rewrites: array of { key, original, rewritten, reason? }

Meaning:
- Given compose service names + their published host ports below, mark any env value whose hostname points at a compose-internal service, and rewrite it to localhost:<publishedHostPort>.
- ORIGINAL must be copied verbatim from the input env — validation compares it against the actual env value.
- If services is empty, return an empty rewrites array.
- Only rewrite values that are genuinely service-internal (bare hostname / localhost-ish alias of a declared service). Never rewrite values already pointing at localhost / 127.0.0.1 / host.docker.internal / an IP.
- If nothing is service-internal, return empty rewrites array.`;

export interface ClassifyHostVerifyEnvOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  env: Record<string, string>;
  /** Compose service names (evidence, deterministic). */
  services: string[];
  /** Per-service published host ports (service name → host port). */
  publishedPorts: Record<string, number>;
  /** Canonical DB port fallback for DB-ish services. */
  canonicalDbPort: number;
  timeoutMs?: number;
}

export async function classifyHostVerifyEnvViaLlm(
  opts: ClassifyHostVerifyEnvOptions,
): Promise<HostVerifyEnvResult> {
  const serviceLines = opts.services.length
    ? opts.services
        .map(
          (s) =>
            `- ${s}${opts.publishedPorts[s] ? ` (host port ${opts.publishedPorts[s]})` : ""}`,
        )
        .join("\n")
    : "(no compose services)";
  const user = [
    `Compose services (published host ports):`,
    serviceLines,
    `Canonical DB port fallback: ${opts.canonicalDbPort}`,
    "",
    "Env map:",
    Object.entries(opts.env)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n"),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: HOST_VERIFY_ENV_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return HostVerifyEnvResultSchema.parse(parsed);
}
