import type { AwaitedLiveTurn } from "@slopcontrol/types";

/** Gated tools that start long-running live turns — confirm returns immediately. */
export const LIVE_TURN_ASYNC_TOOLS = new Set([
  "plan_loop_start",
  "plan_loop_continue",
  "design_loop_start",
  "design_loop_continue",
]);

export type LiveTurnKind = AwaitedLiveTurn["kind"];

export type LiveTurnUpdate = {
  turnId: string;
  kind: LiveTurnKind;
  sessionId: string;
  projectId: string;
  status: "running" | "done" | "interrupted" | "failed";
  summary?: string;
};

export type LiveTurnProgressEvent = {
  type: string;
  summary?: string;
  tool?: string;
};

export function liveTurnKindForTool(tool: string): LiveTurnKind | null {
  if (tool === "plan_loop_start" || tool === "plan_loop_continue") {
    return "plan_loop";
  }
  if (tool === "design_loop_start" || tool === "design_loop_continue") {
    return "design_loop";
  }
  if (tool === "ask") return "ask";
  if (tool === "agent") return "agent";
  return null;
}

export function sessionIdFromLiveTurnArgs(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (tool === "plan_loop_continue" || tool === "design_loop_continue") {
    const loopId = typeof args.loopId === "string" ? args.loopId.trim() : "";
    return loopId || undefined;
  }
  if (tool === "ask") {
    const askId = typeof args.askId === "string" ? args.askId.trim() : "";
    return askId || undefined;
  }
  if (tool === "agent") {
    const agentId = typeof args.agentId === "string" ? args.agentId.trim() : "";
    return agentId || undefined;
  }
  return undefined;
}

export function backfillLoopStartBrief(
  args: Record<string, unknown>,
  operatorMessage: string,
): Record<string, unknown> {
  const brief =
    (typeof args.brief === "string" && args.brief.trim()) ||
    (typeof args.message === "string" && args.message.trim()) ||
    operatorMessage.trim();
  if (!brief) return args;
  return { ...args, brief };
}

export function backfillLoopContinueMessage(
  args: Record<string, unknown>,
  operatorMessage: string,
): Record<string, unknown> {
  const message =
    (typeof args.message === "string" && args.message.trim()) ||
    operatorMessage.trim();
  if (!message) return args;
  return { ...args, message };
}

export function liveTurnStartedMessage(tool: string): string {
  if (tool.startsWith("plan_loop")) {
    return (
      "Plan loop turn started. Progress arrives via live_progress events; " +
      "you'll get live_settled when PLAN.md is ready — do not poll plan_loop_get."
    );
  }
  if (tool.startsWith("design_loop")) {
    return (
      "Design loop turn started. You'll be notified when the mock is ready — " +
      "do not poll design_loop_get."
    );
  }
  return "Live turn started — you'll be notified when it completes.";
}
