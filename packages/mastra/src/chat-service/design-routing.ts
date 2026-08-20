/** Chat-owned design loop this conversation last used. */
export type DesignResumeLatch = {
  loopId: string;
  title?: string;
  status?: string;
  lastUserLine?: string;
  currentVersion?: number;
};

export const DESIGN_LOOP_ID_DEPENDENT_TOOLS = new Set([
  "design_loop_get",
  "design_loop_continue",
  "design_loop_acceptance",
  "design_loop_accept",
  "design_loop_retry",
  "design_loop_pin",
  "design_loop_unpin",
  "design_loop_discard",
  "design_loop_import_design",
  "review_design_loop",
]);

export type DesignTurnAction = "continue" | "accept" | "status" | "unrelated";

export type DesignTurnDecision =
  | { action: "continue"; reason: string }
  | { action: "accept"; reason: string }
  | { action: "status"; reason: string }
  | { action: "unrelated"; reason: string }
  | { action: "ambiguous"; reason: string };

export function isDesignLoopOpen(status: string | undefined): boolean {
  return !status || status === "open";
}

/**
 * Structural design-turn routing when the classification LLM is unavailable.
 * Mirrors decidePlanTurn: routing intent from operator text is the
 * classifier's job — here we only detect cases where classification is moot
 * (no open loop, empty message). Anything else stays ambiguous so the
 * caller falls back to a neutral read-only action.
 */
export function decideDesignTurn(input: {
  operatorMessage: string;
  latch?: DesignResumeLatch | null;
}): DesignTurnDecision {
  const latch = input.latch;
  const message = input.operatorMessage.trim();
  if (!latch?.loopId || !isDesignLoopOpen(latch.status)) {
    return { action: "unrelated", reason: "no open design latch" };
  }
  if (!message) {
    return { action: "ambiguous", reason: "empty operator message" };
  }
  return { action: "ambiguous", reason: "need classifier" };
}

export function formatDesignLoopLatchPrompt(latch: DesignResumeLatch): string {
  const lines = [
    "## Active design loop (this chat)",
    `- loopId: ${latch.loopId}`,
    latch.currentVersion
      ? `- current version: v${latch.currentVersion}`
      : null,
    latch.title ? `- brief: ${latch.title.slice(0, 200)}` : null,
    `- status: ${latch.status ?? "open"}`,
    "",
    "When the operator gives visual feedback, dissatisfaction, or asks for design changes (colours, layout, spacing, copy, components):",
    "- call **design_loop_continue** (gated) — NOT design_loop_get.",
    "- omit loopId to use this latched loop; message is backfilled from the operator's words.",
    "- design_loop_get is read-only status only — it never revises the mock.",
  ];
  return lines.filter(Boolean).join("\n");
}

export function formatDesignTurnRoutingPrefix(opts: {
  latch: DesignResumeLatch;
  decision: Exclude<DesignTurnDecision, { action: "ambiguous" }>;
}): string {
  const { latch, decision } = opts;
  const tool =
    decision.action === "continue"
      ? "design_loop_continue"
      : decision.action === "accept"
        ? "design_loop_accept"
        : decision.action === "status"
          ? "design_loop_get"
          : null;
  if (!tool) return "";
  return [
    `[Design loop routing: loopId=${latch.loopId} v${latch.currentVersion ?? "?"} — operator intent=${decision.action} (${decision.reason}).`,
    tool === "design_loop_get"
      ? "Read-only status check is OK."
      : `You MUST park ${tool} with the operator's feedback — do NOT call design_loop_get instead.]`,
  ].join(" ");
}

/** Parse design loop status from a dispatch envelope or JSON body. */
export function parseDesignLoopStatusFromDispatch(
  raw: string,
): string | undefined {
  const header = raw.match(/^status:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as {
      status?: unknown;
      loop?: { status?: unknown };
    };
    if (typeof parsed.status === "string") return parsed.status;
    if (typeof parsed.loop?.status === "string") return parsed.loop.status;
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** Parse currentVersion from a dispatch envelope or JSON body. */
export function parseDesignLoopVersionFromDispatch(
  raw: string,
): number | undefined {
  const fromJson = (text: string): number | undefined => {
    try {
      const parsed = JSON.parse(text) as {
        version?: unknown;
        currentVersion?: unknown;
        loop?: { currentVersion?: unknown };
      };
      for (const v of [
        parsed.version,
        parsed.currentVersion,
        parsed.loop?.currentVersion,
      ]) {
        if (typeof v === "number") return v;
      }
    } catch {
      /* not JSON */
    }
    return undefined;
  };
  const whole = fromJson(raw);
  if (whole !== undefined) return whole;
  // Envelope: JSON body may sit after a `---` separator or on its own line.
  const body = raw.split(/^---$/m)[1];
  if (body) {
    const fromBody = fromJson(body.trim());
    if (fromBody !== undefined) return fromBody;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const fromLine = fromJson(trimmed);
    if (fromLine !== undefined) return fromLine;
  }
  return undefined;
}
