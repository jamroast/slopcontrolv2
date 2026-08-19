/** Chat-owned plan loop this conversation last used. */
export type PlanResumeLatch = {
  loopId: string;
  title?: string;
  status?: string;
  lastUserLine?: string;
  currentVersion?: number;
};

export const PLAN_LOOP_ID_DEPENDENT_TOOLS = new Set([
  "plan_loop_get",
  "plan_loop_continue",
  "plan_loop_acceptance",
  "plan_loop_accept",
  "plan_loop_promote",
  "plan_loop_retry",
  "plan_loop_discard",
]);

export type PlanTurnAction =
  | "continue"
  | "accept"
  | "promote"
  | "status"
  | "new_loop"
  | "unrelated";

export type PlanTurnDecision =
  | { action: "continue"; reason: string }
  | { action: "accept"; reason: string }
  | { action: "promote"; reason: string }
  | { action: "status"; reason: string }
  | { action: "new_loop"; reason: string }
  | { action: "unrelated"; reason: string }
  | { action: "ambiguous"; reason: string };

const CONTINUE_CUES =
  /\b(try again|run (?:another|the) (?:plan|planning)|update the plan|revise|rewrite|flesh out|investigate|research|nothing (?:happened|changed)|didn't change|doesn't look|not right|wrong|missing|too (?:generic|thin|vague)|again please|loop again|continue planning|improve the plan|real paths|walk the (?:repo|codebase))\b/i;

const ACCEPT_CUES =
  /\b(accept the plan|plan looks good|sign off|freeze the plan|good enough|ready to promote|looks good)\b/i;

const PROMOTE_CUES =
  /\b(promote the plan|start research|bind to phase|create the phase)\b/i;

const STATUS_CUES =
  /^(?:what(?:'s| is) the (?:plan )?status|where are we|show (?:me )?the plan\??)$/i;

const NEW_LOOP_CUES =
  /\b(new plan loop|different plan|start over with a new|unrelated plan)\b/i;

export function isPlanLoopOpen(status: string | undefined): boolean {
  return !status || status === "open";
}

export function hasPlanAcceptanceTicks(args: Record<string, unknown>): boolean {
  if (
    Array.isArray(args.acceptedFeatureIds) &&
    args.acceptedFeatureIds.length > 0
  ) {
    return true;
  }
  if (Array.isArray(args.features)) {
    return args.features.some(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        Boolean((f as { accepted?: boolean }).accepted),
    );
  }
  return false;
}

/**
 * Deterministic plan-turn routing when the classification LLM is unavailable.
 * Defaults to continue for substantive operator messages on an open loop.
 */
export function decidePlanTurn(input: {
  operatorMessage: string;
  latch?: PlanResumeLatch | null;
}): PlanTurnDecision {
  const latch = input.latch;
  const message = input.operatorMessage.trim();
  if (!latch?.loopId || !isPlanLoopOpen(latch.status)) {
    return { action: "unrelated", reason: "no open plan latch" };
  }
  if (!message) {
    return { action: "ambiguous", reason: "empty operator message" };
  }

  if (PROMOTE_CUES.test(message)) {
    return { action: "promote", reason: "promote cue" };
  }
  if (ACCEPT_CUES.test(message)) {
    return { action: "accept", reason: "accept cue" };
  }
  if (NEW_LOOP_CUES.test(message)) {
    return { action: "new_loop", reason: "new loop cue" };
  }
  if (STATUS_CUES.test(message) && message.length <= 80) {
    return { action: "status", reason: "status-only cue" };
  }
  if (CONTINUE_CUES.test(message)) {
    return { action: "continue", reason: "continue cue" };
  }

  // Substantive message on open loop → continue (revise), not passive get.
  if (message.length >= 12 && !STATUS_CUES.test(message)) {
    return { action: "continue", reason: "substantive message on open loop" };
  }

  return { action: "ambiguous", reason: "need classifier" };
}

export function formatPlanLoopLatchPrompt(latch: PlanResumeLatch): string {
  const lines = [
    "## Active plan loop (this chat)",
    `- loopId: ${latch.loopId}`,
    latch.currentVersion
      ? `- current version: v${latch.currentVersion}`
      : null,
    latch.title ? `- brief: ${latch.title.slice(0, 200)}` : null,
    `- status: ${latch.status ?? "open"}`,
    "",
    "When the operator gives feedback, dissatisfaction, new requirements, or asks to run the planning loop again:",
    "- call **plan_loop_continue** (gated) — NOT plan_loop_get.",
    "- omit loopId to use this latched loop; message is backfilled from the operator's words.",
    "- plan_loop_get is read-only status only — it never revises PLAN.md.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatPlanTurnRoutingPrefix(opts: {
  latch: PlanResumeLatch;
  decision: Exclude<PlanTurnDecision, { action: "ambiguous" }>;
}): string {
  const { latch, decision } = opts;
  const tool =
    decision.action === "continue"
      ? "plan_loop_continue"
      : decision.action === "accept"
        ? "plan_loop_accept"
        : decision.action === "promote"
          ? "plan_loop_promote"
          : decision.action === "new_loop"
            ? "plan_loop_start"
            : decision.action === "status"
              ? "plan_loop_get"
              : null;
  if (!tool) return "";
  return [
    `[Plan loop routing: loopId=${latch.loopId} v${latch.currentVersion ?? "?"} — operator intent=${decision.action} (${decision.reason}).`,
    tool === "plan_loop_get"
      ? "Read-only status check is OK."
      : `You MUST park ${tool} with the operator's feedback — do NOT call plan_loop_get instead.]`,
  ].join(" ");
}

export type ChatLikeMessage = { role: string; content: string };

/**
 * Compose plan_loop_continue message from operator turn + recent chat + loop chat.
 */
export function composePlanContinueMessage(input: {
  operatorMessage: string;
  chatMessages?: ChatLikeMessage[];
  loopUserMessages?: string[];
  priorOperatorLine?: string;
  maxChars?: number;
}): string {
  const maxChars = input.maxChars ?? 8_000;
  const operator = input.operatorMessage.trim();
  const parts: string[] = [];

  const loopMsgs = (input.loopUserMessages ?? [])
    .map((m) => m.trim())
    .filter(Boolean);
  const uniqueLoop = [...new Set(loopMsgs)].filter((m) => m !== operator);

  if (operator) {
    parts.push(`Latest operator feedback:\n${operator}`);
  }
  if (
    input.priorOperatorLine?.trim() &&
    input.priorOperatorLine.trim() !== operator &&
    operator.length <= 200
  ) {
    parts.push(
      `Prior operator line this refers to:\n${input.priorOperatorLine.trim()}`,
    );
  }
  if (uniqueLoop.length > 0) {
    parts.push(
      `Earlier plan-loop conversation (incorporate all requirements):\n${uniqueLoop.join("\n\n---\n\n")}`,
    );
  }

  const chatUsers = (input.chatMessages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const recentChat = chatUsers
    .filter((m) => m !== operator && !uniqueLoop.includes(m))
    .slice(-4);
  if (recentChat.length > 0) {
    parts.push(
      `Recent chat context (requirements the plan must reflect):\n${recentChat.join("\n\n---\n\n")}`,
    );
  }

  const composed = parts.join("\n\n").trim();
  if (!composed) return operator;
  return composed.slice(0, maxChars);
}

export function parseLoopIdFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^loopId:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as {
      loopId?: unknown;
      loop?: { id?: unknown };
    };
    if (typeof parsed.loopId === "string" && parsed.loopId.trim()) {
      return parsed.loopId.trim();
    }
    if (typeof parsed.loop?.id === "string" && parsed.loop.id.trim()) {
      return parsed.loop.id.trim();
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function parsePlanLoopStatusFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^status:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as { loop?: { status?: unknown } };
    if (typeof parsed.loop?.status === "string") return parsed.loop.status;
  } catch {
    /* not JSON */
  }
  return undefined;
}
