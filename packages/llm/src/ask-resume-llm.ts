import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const AskResumeLlmDecisionSchema = z.enum(["continue", "new"]);

export const AskResumeClassificationSchema = z.object({
  decision: AskResumeLlmDecisionSchema,
});

export type AskResumeClassification = z.infer<
  typeof AskResumeClassificationSchema
>;

export const ASK_RESUME_SYSTEM_PROMPT = `You classify whether an operator's next chat message continues the same investigation thread or starts a new one.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- decision: "continue" | "new"

Meaning:
- continue: the operator is following up on the current ask (clarifying, going deeper, asking why/how about the same bug or files).
- new: the operator changed topic — a different feature, route, page, incident, or investigation.

Rules:
- Judge intent, not keywords.
- A thank-you plus a new question about a different page/feature is new.
- "what about X" is continue only when X is part of the current ask title/last user line.
- If you cannot tell, decision=new. Starting a fresh ask is safer than mixing transcripts.
`;

export interface ClassifyAskResumeViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  latchTitle?: string;
  latchLastUser?: string;
  timeoutMs?: number;
}

/**
 * Classification-role JSON → continue | new for a chat ask latch.
 * Throws on LLM/parse failure so the caller can fail-closed to new.
 */
export async function classifyAskResumeViaLlm(
  opts: ClassifyAskResumeViaLlmOptions,
): Promise<AskResumeClassification> {
  const user = [
    "Current ask session:",
    `title: ${opts.latchTitle?.trim() || "(none)"}`,
    `last user line: ${opts.latchLastUser?.trim() || "(none)"}`,
    "",
    "Operator's next chat message:",
    opts.message.slice(0, 4_000),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: ASK_RESUME_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};
  return AskResumeClassificationSchema.parse(raw);
}
