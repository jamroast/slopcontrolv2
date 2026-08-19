import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const PlanTurnIntentActionSchema = z.enum([
  "continue",
  "accept",
  "promote",
  "status",
  "new_loop",
  "unrelated",
]);

export type PlanTurnIntentAction = z.infer<typeof PlanTurnIntentActionSchema>;

export const PlanTurnIntentSchema = z.object({
  action: PlanTurnIntentActionSchema,
  notes: z.string().optional(),
});

export type PlanTurnIntent = z.infer<typeof PlanTurnIntentSchema>;

export const PLAN_TURN_INTENT_SYSTEM_PROMPT = `You classify an operator chat message when a plan loop is already open (structured PLAN.md exists).

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- action: "continue" | "accept" | "promote" | "status" | "new_loop" | "unrelated"
- notes: optional one-sentence summary

Meaning:
- continue: revise/update the plan from operator feedback (default for dissatisfaction, new requirements, "try again", "flesh out", "investigate", "that's wrong", "update the plan", "run the loop again")
- accept: operator is satisfied and wants to freeze the plan (accept checklist / sign off)
- promote: operator wants to bind plan to a phase and start research
- status: operator only asks what state the plan is in (read-only check)
- new_loop: operator explicitly wants a different/new plan session unrelated to revising this one
- unrelated: question is not about the open plan loop (general Q&A, different project task)

Rules:
- Judge intent, not keywords.
- "try again" / "run another planning loop" / "nothing changed" on an open loop → continue (not status).
- Dissatisfaction with PLAN quality → continue.
- When unsure between continue and status, choose continue.
- When unsure between continue and unrelated, choose continue if the message could affect plan content.
`;

export interface ClassifyPlanTurnIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  latchTitle?: string;
  latchLastUser?: string;
  currentVersion?: number;
  planExcerpt?: string;
  timeoutMs?: number;
}

export async function classifyPlanTurnIntentViaLlm(
  opts: ClassifyPlanTurnIntentViaLlmOptions,
): Promise<PlanTurnIntent> {
  const user = [
    "Open plan loop:",
    `title: ${opts.latchTitle?.trim() || "(none)"}`,
    `last operator line: ${opts.latchLastUser?.trim() || "(none)"}`,
    `current version: v${opts.currentVersion ?? "?"}`,
    opts.planExcerpt?.trim()
      ? `PLAN excerpt:\n${opts.planExcerpt.trim().slice(0, 1_500)}`
      : "",
    "",
    "Operator's next chat message:",
    opts.message.slice(0, 4_000),
  ]
    .filter(Boolean)
    .join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: PLAN_TURN_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return PlanTurnIntentSchema.parse(parsed);
}
