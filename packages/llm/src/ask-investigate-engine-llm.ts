import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const AskInvestigateEngineLlmDecisionSchema = z.enum([
  "pi",
  "mastra",
  "auto",
]);

export const AskInvestigateEngineClassificationSchema = z.object({
  decision: AskInvestigateEngineLlmDecisionSchema,
});

export type AskInvestigateEngineClassification = z.infer<
  typeof AskInvestigateEngineClassificationSchema
>;

export const ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT = `You classify whether the operator expressed an intent to pick an Ask investigation engine for this turn.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- decision: "pi" | "mastra" | "auto"

Meaning:
- pi: they want a thorough / deep / exhaustive codebase walk (the slower Pi walker).
- mastra: they want a fast / cheap / light check (the quicker Mastra tools path).
- auto: they did not express an engine preference. Default routing should apply.

Rules:
- Judge intent, not keywords. Paraphrases count ("be exhaustive", "don't spend long on this", "just a sanity check", naming Pi or Mastra).
- A normal review/investigate question with no speed or depth preference is auto — even if it is long or names a route.
- If they contradict themselves, prefer the latest clause.
- If you cannot tell, decision=auto.
`;

export interface ClassifyAskInvestigateEngineViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  timeoutMs?: number;
}

/**
 * Classification-role JSON → pi | mastra | auto for this Ask turn.
 * Throws on LLM/parse failure so the caller can fail-closed to auto.
 */
export async function classifyAskInvestigateEngineViaLlm(
  opts: ClassifyAskInvestigateEngineViaLlmOptions,
): Promise<AskInvestigateEngineClassification> {
  const user = [
    "Operator Ask message:",
    opts.message.slice(0, 4_000) || "(empty)",
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: ASK_INVESTIGATE_ENGINE_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};
  return AskInvestigateEngineClassificationSchema.parse(raw);
}
