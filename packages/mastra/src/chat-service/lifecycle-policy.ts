import {
  isBusyRunStage,
  isTerminalRunStage,
  parseRunStage,
  type RunStage,
} from "@slopcontrol/types";

/** Canonical command to issue when the operator has signalled proceed. */
export type ProceedCommand = {
  tool: string;
  args: Record<string, unknown>;
};

/**
 * One row per gate that auto-advances after proceed. Busy/terminal/idle
 * have no command — decideAdvance returns working or stop from kind.
 */
export const ON_PROCEED = {
  in_review: {
    tool: "submit_review",
    args: { decision: "approve" },
  },
  accepted: {
    tool: "start_development",
    args: { autoDesign: true },
  },
  design_complete: {
    tool: "start_development",
    args: { autoDesign: true },
  },
} as const satisfies Partial<Record<RunStage, ProceedCommand>>;

export const ADVANCE_EVENT_TYPES = [
  "proceed",
  "command_ok",
  "design_required",
  "review_required",
  "already_running",
  "unknown_error",
] as const;

export type AdvanceEventType = (typeof ADVANCE_EVENT_TYPES)[number];

export type AdvanceEvent =
  | { type: "proceed" }
  | { type: "command_ok" }
  | { type: "design_required" }
  | { type: "review_required" }
  | { type: "already_running" }
  | { type: "unknown_error"; detail: string };

export type AdvanceDecision =
  | { kind: "dispatch"; tool: string; args: Record<string, unknown> }
  | { kind: "working" }
  | { kind: "stop"; reason: string };

function blockedReason(stage: RunStage): string {
  if (stage === "complete") return "Run already completed.";
  if (isTerminalRunStage(stage)) {
    return `Run is ${stage}. Use get_run / get_operator_suggestions, then retry_development or retry_verify — do not invent a next step.`;
  }
  return `Stage ${stage} does not auto-advance.`;
}

/**
 * Mealy decision: (observed stage, event) → next command or stop.
 * `proceed` and `command_ok` are level-triggered (same table). Error events
 * are explicit — never infer transitions by scraping free-text as a second machine.
 */
export function decideAdvance(
  stage: string | undefined,
  event: AdvanceEvent,
): AdvanceDecision {
  if (event.type === "already_running") {
    return { kind: "working" };
  }
  if (event.type === "unknown_error") {
    return { kind: "stop", reason: event.detail.slice(0, 800) };
  }
  if (event.type === "design_required") {
    return { kind: "dispatch", tool: "start_design", args: {} };
  }
  if (event.type === "review_required") {
    return {
      kind: "dispatch",
      tool: "submit_review",
      args: { decision: "approve" },
    };
  }

  const parsed = parseRunStage(stage) ?? "idle";
  if (isBusyRunStage(parsed)) {
    return { kind: "working" };
  }
  const command = ON_PROCEED[parsed as keyof typeof ON_PROCEED];
  if (command) {
    return {
      kind: "dispatch",
      tool: command.tool,
      args: { ...command.args },
    };
  }
  return { kind: "stop", reason: blockedReason(parsed) };
}

function jsonErrorCode(text: string): string | undefined {
  const trimmed = text.replace(/^ERROR:\s*/i, "").trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as {
      error?: unknown;
    };
    return typeof parsed.error === "string" ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

/** Structured HTTP/MCP `{ error }` first; regex only as fallback. */
export function parseAdvanceEvent(text: string): AdvanceEvent {
  const code = jsonErrorCode(text) ?? "";
  const body = text.replace(/^ERROR:\s*/i, "");
  const haystack = `${code}\n${body}`;

  if (code === "design_required" || /design_required/i.test(haystack)) {
    return { type: "design_required" };
  }
  if (
    code === "development_in_progress" ||
    /development_in_progress/i.test(haystack)
  ) {
    return { type: "already_running" };
  }
  if (/must be accepted or design_complete/i.test(haystack)) {
    return { type: "review_required" };
  }
  return { type: "unknown_error", detail: text.slice(0, 800) };
}

export function eventForType(
  type: AdvanceEventType,
  detail = "unknown",
): AdvanceEvent {
  if (type === "unknown_error") return { type, detail };
  return { type };
}
