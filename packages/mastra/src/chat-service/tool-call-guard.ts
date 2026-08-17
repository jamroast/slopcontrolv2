import { CHAT_FREE_TOOLS } from "./chat-tools.js";

/** Read-only inspection tools worth deduplicating within a single chat turn. */
const READ_ONLY_GUARD_TOOLS = new Set(
  [...CHAT_FREE_TOOLS].filter(
    (name) =>
      name !== "ask" &&
      name !== "agent" &&
      name !== "wait_for_run" &&
      name !== "ask_sub_research" &&
      name !== "reconcile_blueprint" &&
      name !== "preview_change_intent",
  ),
);

function stableArgsKey(args: Record<string, unknown>): string {
  const keys = Object.keys(args).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) normalized[key] = args[key];
  return JSON.stringify(normalized);
}

export type ToolCallGuard = {
  /** Returns an error message when the tool should not run. */
  check: (tool: string, args: Record<string, unknown>) => string | null;
  disabledTools: () => ReadonlySet<string>;
};

export type ToolCallGuardOptions = {
  /** When a plan/design live turn is active, block plan_loop_get polling. */
  hasActiveLiveTurn?: (loopId?: string) => boolean;
};

/** Detect repeated identical read-only tool calls in one agent turn. */
export function createToolCallGuard(
  opts: ToolCallGuardOptions = {},
): ToolCallGuard {
  const counts = new Map<string, number>();
  const disabled = new Set<string>();

  return {
    check(tool, args) {
      if (
        (tool === "plan_loop_get" || tool === "design_loop_get") &&
        opts.hasActiveLiveTurn?.(
          typeof args.loopId === "string" ? args.loopId : undefined,
        )
      ) {
        return `${tool} is disabled while a live turn is active on this chat — wait for live_settled instead of polling.`;
      }
      if (disabled.has(tool)) {
        return `Tool ${tool} is disabled for this turn after a repeated identical call. Answer from findings already in this turn.`;
      }
      if (!READ_ONLY_GUARD_TOOLS.has(tool)) return null;
      const key = `${tool}:${stableArgsKey(args)}`;
      const seen = (counts.get(key) ?? 0) + 1;
      counts.set(key, seen);
      if (seen >= 2) {
        disabled.add(tool);
      }
      return null;
    },
    disabledTools: () => disabled,
  };
}
