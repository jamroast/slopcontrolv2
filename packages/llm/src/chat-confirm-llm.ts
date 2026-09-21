import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const ChatConfirmDecisionSchema = z.enum(["approve", "deny", "unrelated"]);

export const ChatConfirmClassificationSchema = z.object({
  decision: ChatConfirmDecisionSchema,
  token: z.string().min(1).optional(),
  tokens: z.array(z.string().min(1)).optional(),
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
- token: string — when the operator's decision addresses exactly ONE of several parked actions, set token to that action's token.
- tokens: string[] — when the operator's decision addresses ALL parked actions at once (blanket approval/denial), list every parked token here.
- When there is exactly one parked action, omit token/tokens (it is implied).

Meaning:
- approve: the operator wants the parked action(s) to proceed now (they are authorizing those tool calls).
- deny: the operator wants the parked action(s) cancelled / not run.
- unrelated: the message is a new question, a clarification, a different task, or anything that is not a decision about the parked action.

Rules:
- Judge intent, not keywords. Short authorizations, explicit go-aheads, and restatements of "do that investigation/action" are approve when they clearly refer to the parked tool.
- Blanket go-aheads ("go ahead", "yes", "do it", "approve all", "confirm all", "both", "all of them") in reply to a batch of parked actions approve ALL of them — return every parked token in tokens.
- A new problem statement, a different phase, or "wait, first tell me X" is unrelated even if polite.
- If several parked actions exist and the operator only addresses one, set token to that action's token.
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

/**
 * Bind/drop tokens after JSON parse. Returns a validated `tokens` list for
 * approve/deny. Unknown tokens are dropped; when none survive (or none were
 * given with several parked) fail closed to unrelated.
 */
export function normalizeChatConfirmClassification(
  classified: ChatConfirmClassification,
  parked: ParkedChatAction[],
): ChatConfirmClassification {
  if (parked.length === 0) return { decision: "unrelated" };
  if (classified.decision === "unrelated") return { decision: "unrelated" };
  const allowed = new Set(parked.map((p) => p.token));
  const requested = [
    ...(classified.tokens ?? []),
    ...(classified.token ? [classified.token] : []),
  ];
  const valid = [...new Set(requested.filter((t) => allowed.has(t)))];
  if (parked.length === 1) {
    // An explicit but unknown token fails closed; otherwise the single
    // parked action is implied.
    if (requested.length > 0 && valid.length === 0) {
      return { decision: "unrelated" };
    }
    return { decision: classified.decision, tokens: [parked[0]!.token] };
  }
  if (valid.length === 0) return { decision: "unrelated" };
  return { decision: classified.decision, tokens: valid };
}
