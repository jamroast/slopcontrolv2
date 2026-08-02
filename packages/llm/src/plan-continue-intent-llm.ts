import {
  PlanContinueIntentSchema,
  fallbackPlanContinueIntentFromText,
  type PlanContinueIntent,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const PLAN_CONTINUE_INTENT_SYSTEM_PROMPT = `You classify a plan-loop continue request (operator feedback on an existing PLAN.md) into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY a JSON object with these fields:
- scope: one of "sections" | "expand_scope" | "narrow_scope" | "full_revise" | "clarify_only"
- sections: string[] — PLAN.md section titles to change (subset of Goal, Constraints, In scope, Out of scope, Approach, Likely areas, Success criteria, Risks & open questions, Handoff notes)
- focus: optional string — new focus when narrowing/expanding
- preserve: optional string[] — areas to freeze
- notes: string — 1 sentence summary

Rules:
- "rewrite / from scratch / start over" → full_revise
- "only / just / narrow" → narrow_scope (set focus when named)
- "also include / expand / widen" → expand_scope
- pure questions with no change ask → clarify_only
- otherwise sections (list which section titles are mentioned)
`;

export async function classifyPlanContinueIntentViaLlm(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  brief?: string;
  timeoutMs?: number;
}): Promise<PlanContinueIntent> {
  const user = [
    "Operator feedback on the current plan (classify this continue):",
    "",
    opts.message.slice(0, 4_000),
    opts.brief?.trim()
      ? `\nOriginal loop brief (context only):\n${opts.brief.trim().slice(0, 1_500)}`
      : "",
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: PLAN_CONTINUE_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 15_000,
    temperature: 0,
  });

  const intent = PlanContinueIntentSchema.parse(parsed);
  const fallback = fallbackPlanContinueIntentFromText(opts.message);
  return {
    ...fallback,
    ...intent,
    sections: intent.sections.length ? intent.sections : fallback.sections,
  };
}
