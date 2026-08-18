import type { AskMessage } from "@slopcontrol/types";
import { extractLastTaskBrief } from "./ask-session.js";

export type ChatLikeMessage = {
  role: string;
  content: string;
};

const HANDOFF_PHRASE =
  /^(please\s+)?(hand\s*(it\s*)?over|submit(\s+it(\s+now)?)?|go\s+ahead|yes|confirm|proceed|do\s+it|sounds?\s+good|ok(?:ay)?|approve)\.?$/i;

/** Short operator lines that authorize a parked action but are not the task brief. */
export function isShortHandoffMessage(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed.length <= 40) return true;
  if (trimmed.length <= 120 && HANDOFF_PHRASE.test(trimmed)) return true;
  return false;
}

/**
 * Build a phase description for chat `start_change`.
 * Prefers an explicit override, then the latest substantive user message
 * (skipping handoff phrases like "please hand it over"), then assistant
 * Task brief sections, then a non-handoff operator message.
 */
export function buildChatTaskDescription(
  messages: ChatLikeMessage[],
  opts?: {
    descriptionOverride?: string;
    operatorMessage?: string;
    maxChars?: number;
  },
): string | null {
  const maxChars = opts?.maxChars ?? 8_000;
  const override = opts?.descriptionOverride?.trim();
  if (override) return override.slice(0, maxChars);

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    const content = m.content.trim();
    if (!content || isShortHandoffMessage(content)) continue;
    return content.slice(0, maxChars);
  }

  const brief = extractLastTaskBrief(messages as AskMessage[]);
  if (brief) return brief.slice(0, maxChars);

  const operator = opts?.operatorMessage?.trim();
  if (operator && !isShortHandoffMessage(operator)) {
    return operator.slice(0, maxChars);
  }

  return null;
}
