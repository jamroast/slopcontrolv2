import type { LlmEndpoint } from "@slopcontrol/types";
import { z } from "zod";
import { chatJson } from "./json-chat.js";

export const MarketingStartIntentSchema = z.object({
  needsCompetitiveResearch: z.boolean(),
  notes: z.string().optional(),
});

export type MarketingStartIntent = z.infer<typeof MarketingStartIntentSchema>;

export const MARKETING_START_INTENT_DEFAULT: MarketingStartIntent = {
  needsCompetitiveResearch: true,
};

export const MARKETING_START_INTENT_SYSTEM_PROMPT = `You classify a marketing-loop START brief into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY:
- needsCompetitiveResearch: boolean — true when the operator wants the landing judged against competitors, a launch, or "take this to market". false only for a narrow copy tweak that already names the exact sentence to change and does not ask for a competitive read.
- notes: optional string — 1 sentence

Rules:
- "landing loses to competitors", "take this to market", "plan a marketing release" → needsCompetitiveResearch true
- A one-line copy tweak with the replacement sentence already given → needsCompetitiveResearch false
- When unsure, needsCompetitiveResearch true
`;

export async function classifyMarketingStartIntentViaLlm(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  brief: string;
  timeoutMs?: number;
}): Promise<MarketingStartIntent> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: MARKETING_START_INTENT_SYSTEM_PROMPT,
    user: ["Operator marketing-loop start brief:", "", opts.brief.slice(0, 4_000)].join(
      "\n",
    ),
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });
  return MarketingStartIntentSchema.parse(parsed);
}

export const MarketingContinueIntentSchema = z.object({
  scope: z.enum(["sections", "clarify_only", "full_revise", "expand_scope"]),
  notes: z.string().optional(),
});

export type MarketingContinueIntent = z.infer<typeof MarketingContinueIntentSchema>;

export const MARKETING_CONTINUE_INTENT_DEFAULT: MarketingContinueIntent = {
  scope: "sections",
};

/** Classifier failed twice — keep the doc, do not regenerate. */
export const MARKETING_CONTINUE_INTENT_FALLBACK: MarketingContinueIntent = {
  scope: "clarify_only",
};

export const MARKETING_CONTINUE_INTENT_SYSTEM_PROMPT = `You classify a marketing-loop CONTINUE message into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY:
- scope: "sections" | "clarify_only" | "full_revise" | "expand_scope"
- notes: optional string

Rules:
- A question or a comment that does not ask to change the doc → clarify_only
- Edit named sections, tighten a claim, fix one track → sections
- Rewrite the release, start over, the doc is wrong → full_revise
- Add a competitor, a new claim, or a new track the doc does not cover → expand_scope
- When unsure, sections
`;

export async function classifyMarketingContinueIntentViaLlm(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  brief: string;
  timeoutMs?: number;
}): Promise<MarketingContinueIntent> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: MARKETING_CONTINUE_INTENT_SYSTEM_PROMPT,
    user: [
      "Original brief:",
      opts.brief.slice(0, 2_000),
      "",
      "Operator continue message:",
      opts.message.slice(0, 4_000),
    ].join("\n"),
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });
  return MarketingContinueIntentSchema.parse(parsed);
}
