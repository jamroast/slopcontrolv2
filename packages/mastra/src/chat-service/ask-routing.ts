import type { AskStatus } from "@slopcontrol/types";

/** Chat-owned ask session this conversation last used. */
export type AskResumeLatch = {
  askId: string;
  /** Owning project — required for global chat latch fill / rehydrate. */
  projectId?: string;
  title?: string;
  lastUserLine?: string;
  status?: AskStatus | string;
};

/** True when the latched ask may be reused for a tool call on projectId. */
export function askLatchAppliesToProject(
  latch: AskResumeLatch | null | undefined,
  projectId?: string | null,
): boolean {
  const target = projectId?.trim();
  if (!latch?.askId) return false;
  if (!target) return true;
  if (!latch.projectId) return true;
  return latch.projectId === target;
}

export type AskToolArgs = {
  askId?: string;
  newAsk?: boolean;
  title?: string;
  message?: string;
};

export type AskResumeDecision =
  | { kind: "continue"; askId: string; reason: string }
  | { kind: "new"; title: string; reason: string }
  | { kind: "ambiguous"; reason: string };

const CONTINUE_CUES =
  /^(why\b|how come\b|and\b|also\b|what about\b|go deeper\b|continue\b|same\b|dig\b|more on\b|more detail\b|that\b|this\b|ok (but |and )?why)/i;

const NEW_CUES =
  /\b(now look at|now review|now check|instead\b|another (thing|question|ask|topic)|unrelated|switching to|switch to|while (you.?re|you are) at it|different (topic|question|page|route))\b/i;

const STOPWORDS = new Set(
  (
    "the a an and or but if then than this that those these you your we our " +
      "is are was were be been being to of in on for from with without about " +
      "into over after before please could would should can just also now look " +
      "see check review investigate understand thanks thank great fixing fixed " +
      "that what how why does did do"
  ).split(/\s+/),
);

export const ASK_ID_DEPENDENT_TOOLS = new Set([
  "get_ask",
  "ask_sub_research",
  "promote_ask",
  "fork_ask",
]);

export function isAskOpen(status: string | undefined): boolean {
  return !status || status === "open";
}

export function askTitleFromOperatorMessage(message: string, maxLen = 80): string {
  const first = message.split(/\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!first) return "New investigation";
  return first.length <= maxLen ? first : `${first.slice(0, maxLen).trim()}`;
}

/** Routes (`/product`) and source-ish paths the operator named. */
export function extractAnchors(text: string): Set<string> {
  const out = new Set<string>();
  const src = text.toLowerCase();
  for (const m of src.matchAll(/\/[a-z][\w-]*/g)) {
    out.add(m[0]);
  }
  for (const m of src.matchAll(/[\w./-]+\.(?:tsx?|jsx?|css|md)\b/g)) {
    out.add(m[0]);
  }
  return out;
}

export function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9/+_-]+/)) {
    if (raw.length < 4) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  return inter / new Set([...a, ...b]).size;
}

function latchCorpus(latch: AskResumeLatch): string {
  return `${latch.title ?? ""} ${latch.lastUserLine ?? ""}`;
}

/**
 * Deterministic continue-vs-new for chat-originated asks.
 * Does not call an LLM — `ambiguous` means the caller may classify, then
 * fail-closed to new.
 */
export function decideAskResume(input: {
  operatorMessage: string;
  args: AskToolArgs;
  latch?: AskResumeLatch | null;
  projectId?: string | null;
}): AskResumeDecision {
  const askId =
    typeof input.args.askId === "string" ? input.args.askId.trim() : "";
  if (askId) {
    return { kind: "continue", askId, reason: "explicit askId" };
  }
  if (input.args.newAsk === true) {
    return {
      kind: "new",
      title:
        (typeof input.args.title === "string" && input.args.title.trim()) ||
        askTitleFromOperatorMessage(input.operatorMessage),
      reason: "explicit newAsk",
    };
  }

  const latch = input.latch;
  if (!latch?.askId || !isAskOpen(latch.status)) {
    return {
      kind: "new",
      title: askTitleFromOperatorMessage(input.operatorMessage),
      reason: latch?.askId ? `latch not open (${latch.status})` : "no latch",
    };
  }

  if (!askLatchAppliesToProject(latch, input.projectId)) {
    return {
      kind: "new",
      title: askTitleFromOperatorMessage(input.operatorMessage),
      reason: "cross-project",
    };
  }

  const message = input.operatorMessage.trim();
  const latchText = latchCorpus(latch);
  const msgAnchors = extractAnchors(message);
  const latchAnchors = extractAnchors(latchText);
  const extraAnchors = [...msgAnchors].filter((a) => !latchAnchors.has(a));

  if (extraAnchors.length > 0) {
    return {
      kind: "new",
      title: askTitleFromOperatorMessage(message),
      reason: `new path/route ${extraAnchors[0]}`,
    };
  }

  if (NEW_CUES.test(message)) {
    return {
      kind: "new",
      title: askTitleFromOperatorMessage(message),
      reason: "topic-shift cue",
    };
  }

  const msgTokens = significantTokens(message);
  const latchTokens = significantTokens(latchText);
  const overlap = jaccard(msgTokens, latchTokens);
  let inter = 0;
  for (const t of msgTokens) {
    if (latchTokens.has(t)) inter += 1;
  }
  const shortFollowUp = message.length <= 160 && CONTINUE_CUES.test(message);

  if (shortFollowUp && overlap >= 0.05) {
    return {
      kind: "continue",
      askId: latch.askId,
      reason: "short follow-up",
    };
  }
  if (shortFollowUp && extraAnchors.length === 0 && message.length <= 80) {
    return {
      kind: "continue",
      askId: latch.askId,
      reason: "short deixis",
    };
  }
  if (inter >= 3 && !NEW_CUES.test(message)) {
    return {
      kind: "continue",
      askId: latch.askId,
      reason: "same-topic overlap",
    };
  }
  if (overlap >= 0.35 && !NEW_CUES.test(message)) {
    return {
      kind: "continue",
      askId: latch.askId,
      reason: "same-topic overlap",
    };
  }
  if (overlap < 0.12 && message.length > 80) {
    return {
      kind: "new",
      title: askTitleFromOperatorMessage(message),
      reason: "low overlap with latch",
    };
  }

  return { kind: "ambiguous", reason: "need classifier" };
}

export function applyAskResumeDecision(
  decision: Exclude<AskResumeDecision, { kind: "ambiguous" }>,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (decision.kind === "continue") {
    const { newAsk: _ignored, ...rest } = args;
    return { ...rest, askId: decision.askId };
  }
  const { askId: _ignored, ...rest } = args;
  return { ...rest, newAsk: true, title: decision.title };
}

const SHORT_OPERATOR_FOR_PRIOR = 160;

/**
 * Chat often rewrites the operator's question into a file checklist.
 * Ask must see the operator's words first; chat notes are secondary.
 */
export function composeAskDispatchMessage(input: {
  operatorMessage: string;
  chatMessage?: string;
  priorOperatorQuestion?: string;
}): string {
  const operator = input.operatorMessage.trim();
  const chat = (input.chatMessage ?? "").trim();
  const prior = (input.priorOperatorQuestion ?? "").trim();
  const chatDiffers = Boolean(chat && chat !== operator);
  const includePrior = Boolean(
    prior &&
      prior !== operator &&
      operator.length > 0 &&
      operator.length <= SHORT_OPERATOR_FOR_PRIOR,
  );

  if (!chatDiffers && !includePrior) {
    return operator || chat;
  }

  const parts: string[] = [];
  if (operator) {
    parts.push(`Operator request:\n${operator}`);
  }
  if (includePrior) {
    parts.push(`Prior operator question this refers to:\n${prior}`);
  }
  if (chatDiffers) {
    parts.push(
      `Chat investigation notes (do not replace the operator request; if they conflict, follow the operator):\n${chat}`,
    );
  }
  return parts.join("\n\n") || chat || operator;
}

export function parseAskIdFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^askId:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as {
      askId?: unknown;
      ask?: { id?: unknown };
    };
    if (typeof parsed.askId === "string" && parsed.askId.trim()) {
      return parsed.askId.trim();
    }
    if (typeof parsed.ask?.id === "string" && parsed.ask.id.trim()) {
      return parsed.ask.id.trim();
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function parseAskStatusFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^status:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as { ask?: { status?: unknown } };
    if (typeof parsed.ask?.status === "string") return parsed.ask.status;
  } catch {
    /* not JSON */
  }
  return undefined;
}
