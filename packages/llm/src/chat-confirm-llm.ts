import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const ChatConfirmDecisionSchema = z.enum(["approve", "deny", "unrelated"]);

export const ChatConfirmClassificationSchema = z.object({
  decision: ChatConfirmDecisionSchema,
  token: z.string().min(1).optional(),
});

export type ChatConfirmClassification = z.infer<
  typeof ChatConfirmClassificationSchema
>;

export type ParkedChatAction = {
  token: string;
  tool: string;
  argsPreview?: string;
};

export const CHAT_CONFIRM_SYSTEM_PROMPT = `You classify whether an operator's chat message is confirming, denying, or unrelated to a parked SlopControl gated action.

Output ONLY a single JSON object. No prose, no markdown fences.

Schema:
- decision: "approve" | "deny" | "unrelated"
- token: string — required when more than one parked action is listed and decision is approve or deny. When there is exactly one parked action, omit token (it is implied).

Meaning:
- approve: the operator wants the parked action to proceed now (they are authorizing that specific tool call).
- deny: the operator wants the parked action cancelled / not run.
- unrelated: the message is a new question, a clarification, a different task, or anything that is not a decision about the parked action.

Rules:
- Judge intent, not keywords. Short authorizations, explicit go-aheads, and restatements of "do that investigation/action" are approve when they clearly refer to the parked tool.
- A new problem statement, a different phase, or "wait, first tell me X" is unrelated even if polite.
- If two parked actions exist and the operator only addresses one, set token to that action's token.
- If you cannot tell which action they mean, decision=unrelated.
- Never invent a token that is not in the parked-action list.
`;

export interface ClassifyChatConfirmViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  parked: ParkedChatAction[];
  timeoutMs?: number;
}

/**
 * Classification-role JSON → approve | deny | unrelated for a parked chat action.
 * Throws on LLM/parse failure so the caller can fail-closed to unrelated.
 */
export async function classifyChatConfirmViaLlm(
  opts: ClassifyChatConfirmViaLlmOptions,
): Promise<ChatConfirmClassification> {
  if (opts.parked.length === 0) {
    return { decision: "unrelated" };
  }

  const parkedBlock = opts.parked
    .map(
      (p, i) =>
        `${i + 1}. token=${p.token} tool=${p.tool} args=${p.argsPreview ?? "{}"}`,
    )
    .join("\n");

  const user = [
    "Parked gated action(s) waiting on the operator:",
    parkedBlock,
    "",
    "Operator's next chat message:",
    opts.message.slice(0, 4_000),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: CHAT_CONFIRM_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};
  const classified = ChatConfirmClassificationSchema.parse(raw);
  return normalizeChatConfirmClassification(classified, opts.parked);
}

/** Bind/drop token after JSON parse. Unknown or missing token → unrelated. */
export function normalizeChatConfirmClassification(
  classified: ChatConfirmClassification,
  parked: ParkedChatAction[],
): ChatConfirmClassification {
  if (parked.length === 0) return { decision: "unrelated" };
  const allowed = new Set(parked.map((p) => p.token));
  if (classified.token && !allowed.has(classified.token)) {
    return { decision: "unrelated" };
  }
  if (parked.length === 1) {
    return { decision: classified.decision, token: parked[0]!.token };
  }
  if (
    (classified.decision === "approve" || classified.decision === "deny") &&
    !classified.token
  ) {
    return { decision: "unrelated" };
  }
  return classified;
}
