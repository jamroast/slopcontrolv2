import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const DesignTurnIntentActionSchema = z.enum([
  "continue",
  "accept",
  "status",
  "unrelated",
]);

export type DesignTurnIntentAction = z.infer<typeof DesignTurnIntentActionSchema>;

export const DesignTurnIntentSchema = z.object({
  action: DesignTurnIntentActionSchema,
  notes: z.string().optional(),
});

export type DesignTurnIntent = z.infer<typeof DesignTurnIntentSchema>;

export const DESIGN_TURN_INTENT_SYSTEM_PROMPT = `You classify an operator chat message when a design loop is already open (a mock HTML look-and-feel exploration exists).

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- action: "continue" | "accept" | "status" | "unrelated"
- notes: optional one-sentence summary

Meaning:
- continue: revise the mock from operator feedback (default for visual feedback: colours, layout, spacing, typography, copy, components, branding; also dissatisfaction, "try again", "make it darker", "nothing changed")
- accept: operator is satisfied and wants to freeze the design ("looks good", "ship it", "use this one")
- status: operator only asks what state the design loop is in (read-only check)
- unrelated: message is not about the open design loop (general Q&A, different project task, planning/development work)

Rules:
- Judge intent, not keywords.
- Any visual/aesthetic feedback on an open loop → continue (not status).
- When unsure between continue and status, choose continue.
- When unsure between continue and unrelated, choose continue if the message could affect the mock.
`;

export interface ClassifyDesignTurnIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  latchTitle?: string;
  latchLastUser?: string;
  currentVersion?: number;
  timeoutMs?: number;
}

export async function classifyDesignTurnIntentViaLlm(
  opts: ClassifyDesignTurnIntentViaLlmOptions,
): Promise<DesignTurnIntent> {
  const user = [
    "Open design loop:",
    `title: ${opts.latchTitle?.trim() || "(none)"}`,
    `last operator line: ${opts.latchLastUser?.trim() || "(none)"}`,
    `current version: v${opts.currentVersion ?? "?"}`,
    "",
    "Operator's next chat message:",
    opts.message.slice(0, 4_000),
  ]
    .filter(Boolean)
    .join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: DESIGN_TURN_INTENT_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  return DesignTurnIntentSchema.parse(parsed);
}
