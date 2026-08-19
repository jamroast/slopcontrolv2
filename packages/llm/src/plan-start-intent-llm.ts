import type { LlmEndpoint } from "@slopcontrol/types";
import { z } from "zod";
import { chatJson } from "./json-chat.js";

export const PlanStartIntentSchema = z.object({
  needsInvestigation: z.boolean(),
  investigateEngine: z.enum(["auto", "mastra", "pi"]),
  siblingInvestigation: z.boolean(),
  scopeKind: z
    .enum(["feature", "bugfix", "refactor", "integration", "spike"])
    .optional(),
  focus: z.string().optional(),
  preserve: z.array(z.string()).optional(),
  notes: z.string().optional(),
});

export type PlanStartIntent = z.infer<typeof PlanStartIntentSchema>;

export const PLAN_START_INTENT_DEFAULT: PlanStartIntent = {
  needsInvestigation: true,
  investigateEngine: "auto",
  siblingInvestigation: false,
  scopeKind: "feature",
};

export const PLAN_START_INTENT_SYSTEM_PROMPT = `You classify a plan-loop START brief (first version of a structured PLAN.md) into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY a JSON object with these fields:
- needsInvestigation: boolean — true when the operator wants codebase/sibling research before planning (investigate, learn from, deep dive, present a plan after research, compare to another app). false for narrow tweaks with no repo walk needed.
- investigateEngine: "auto" | "mastra" | "pi" — pi for thorough/deep/exhaustive; mastra for quick/light; auto when unspecified.
- siblingInvestigation: boolean — true when the brief names another project/app to learn from (JamPress, sibling, other repo).
- scopeKind: optional — feature | bugfix | refactor | integration | spike
- focus: optional string — concrete component/feature focus (never bare words like "management")
- preserve: optional string[] — areas to freeze
- notes: optional string — 1 sentence summary

Rules:
- "investigate / research / learn from / look at X and plan" → needsInvestigation true, siblingInvestigation when X is another product
- Detailed briefs that already list requirements or file paths still need needsInvestigation true — the planner must validate paths and read the repo before writing Likely areas
- "plan a small button tweak / copy change" with no walk → needsInvestigation false
- thorough / deep / exhaustive → investigateEngine pi
- quick / lightweight → investigateEngine mastra
`;

export async function classifyPlanStartIntentViaLlm(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  brief: string;
  timeoutMs?: number;
}): Promise<PlanStartIntent> {
  const user = [
    "Operator plan-loop start brief (classify this start):",
    "",
    opts.brief.slice(0, 4_000),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: PLAN_START_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return PlanStartIntentSchema.parse(parsed);
}
