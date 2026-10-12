import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const CapabilityContradictionSchema = z.object({
  contradictions: z
    .array(
      z.object({
        mustNot: z.string(),
        capability: z.string(),
      }),
    )
    .default([]),
});

export type CapabilityContradiction = z.infer<
  typeof CapabilityContradictionSchema
>;

export const CAPABILITY_CONTRADICTION_SYSTEM_PROMPT = `You decide whether a phase prohibition forbids a route or file the project already serves.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- contradictions: array of { mustNot: string, capability: string }

Meaning:
- A contradiction is a mustNot (or out-of-scope line) that forbids using, linking, serving, or keeping a route or file that appears in the capability inventory.
- mustNot must be copied exactly from the candidate list.
- capability is the route or file path from the inventory that the prohibition forbids.
- Do not flag a prohibition that only limits behavior, copy, or a path that is not in the inventory.
- If none of the candidates contradict an existing capability, contradictions is [].`;

export interface ClassifyCapabilityContradictionsOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  mustNot: string[];
  routes: string[];
  files: string[];
  timeoutMs?: number;
}

export async function classifyCapabilityContradictionsViaLlm(
  opts: ClassifyCapabilityContradictionsOptions,
): Promise<CapabilityContradiction> {
  const user = [
    "Candidate prohibitions:",
    ...opts.mustNot.map((item) => `- ${item}`),
    "",
    "Existing routes:",
    ...(opts.routes.length ? opts.routes.map((route) => `- ${route}`) : ["- (none)"]),
    "",
    "Existing files:",
    ...(opts.files.length ? opts.files.map((file) => `- ${file}`) : ["- (none)"]),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: CAPABILITY_CONTRADICTION_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return CapabilityContradictionSchema.parse(parsed);
}
