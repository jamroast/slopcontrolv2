import {
  BUSY_RUN_STAGES,
  isBusyRunStage,
  type Run,
  type RunStage,
} from "@slopcontrol/types";
import type { RunWaitKind } from "./types.js";

export { BUSY_RUN_STAGES, isBusyRunStage };

/** Lifecycle tools that return 202 while a run continues in the background. */
export const LIFECYCLE_WAIT_TOOLS = new Set<string>([
  "start_change",
  "promote_ask",
  "start_development",
  "submit_review",
  "retry_development",
  "start_design",
  "advance_run",
  "retry_verify",
  "implement_design",
  "plan_loop_promote",
  "relaunch_design_research",
]);

export const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
export const DEFAULT_WAIT_INTERVAL_MS = 2_000;
export const DEFAULT_FOLLOW_UP_WAIT_MS = 30 * 60 * 1_000;
export const HTTP_WAIT_MAX_MS = 180_000;

// Re-export for convenience (canonical definition is in types.ts)
export type { RunWaitKind };

/**
 * Differentiated wait strategies by run kind.
 * - ask: short inline (30s), brief follow-up (5min)
 * - research: longer inline (120s), standard follow-up (30min)
 * - develop: longer inline (120s), extended follow-up (60min)
 */
export const WAIT_CONFIG: Record<
  RunWaitKind,
  {
    inlineMs: number;
    followUpMs: number;
    progressIntervalMs: number;
  }
> = {
  ask: {
    inlineMs: 30_000,
    followUpMs: 5 * 60 * 1_000,
    progressIntervalMs: 30_000,
  },
  research: {
    inlineMs: 120_000,
    followUpMs: 30 * 60 * 1_000,
    progressIntervalMs: 60_000,
  },
  develop: {
    inlineMs: 120_000,
    followUpMs: 60 * 60 * 1_000,
    progressIntervalMs: 60_000,
  },
};

/** Map lifecycle tools to the kind of run they start. */
export const LIFECYCLE_TOOL_KIND: Record<string, RunWaitKind> = {
  ask: "ask",
  fork_ask: "ask",
  promote_ask: "research",
  start_change: "research",
  start_development: "develop",
  retry_development: "develop",
  start_design: "develop",
  implement_design: "develop",
  plan_loop_promote: "research",
  relaunch_design_research: "research",
};

export function runWaitKindForTool(tool: string): RunWaitKind | undefined {
  return LIFECYCLE_TOOL_KIND[tool];
}

export interface WaitConfigOverrides {
  inlineMs?: number;
  followUpMs?: number;
  progressIntervalMs?: number;
}

/** Per-kind wait defaults with instance overrides applied on top. */
export function resolveWaitConfig(
  kind: RunWaitKind,
  overrides?: WaitConfigOverrides,
): { inlineMs: number; followUpMs: number; progressIntervalMs: number } {
  const base = WAIT_CONFIG[kind];
  return {
    inlineMs: overrides?.inlineMs ?? base.inlineMs,
    followUpMs: overrides?.followUpMs ?? base.followUpMs,
    progressIntervalMs:
      overrides?.progressIntervalMs ?? base.progressIntervalMs,
  };
}

export type RunSnapshot = Pick<Run, "id" | "stage" | "phaseId" | "projectId">;

export type WaitForRunResult = {
  runId: string;
  stage: RunStage | "missing";
  settled: boolean;
  timedOut: boolean;
  elapsedMs: number;
  phaseId?: string;
  projectId?: string;
};

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Pull runId + stage out of a start_change / start_development (etc.) payload.
 */
export function extractBusyRunFromLifecycleResult(
  text: string,
): { runId: string; stage?: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
    const nested =
      parsed.run && typeof parsed.run === "object"
        ? (parsed.run as Record<string, unknown>)
        : parsed;
    const runId =
      (typeof nested.id === "string" && nested.id) ||
      (typeof parsed.runId === "string" && parsed.runId) ||
      "";
    if (!runId) return null;
    const stage =
      (typeof nested.stage === "string" && nested.stage) ||
      (typeof parsed.stage === "string" && parsed.stage) ||
      undefined;
    return { runId, stage };
  } catch {
    return null;
  }
}

export async function waitForRun(opts: {
  runId: string;
  getRun: () => RunSnapshot | undefined | Promise<RunSnapshot | undefined>;
  timeoutMs?: number;
  intervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (snap: RunSnapshot, elapsedMs: number) => void;
}): Promise<WaitForRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const started = Date.now();
  let last: RunSnapshot | undefined;

  while (true) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new Error("aborted");
    }
    const snap = await opts.getRun();
    const elapsedMs = Date.now() - started;
    if (!snap) {
      return {
        runId: opts.runId,
        stage: "missing",
        settled: false,
        timedOut: false,
        elapsedMs,
      };
    }
    last = snap;
    opts.onProgress?.(snap, elapsedMs);
    if (!isBusyRunStage(snap.stage)) {
      return {
        runId: snap.id,
        stage: snap.stage,
        settled: true,
        timedOut: false,
        elapsedMs,
        phaseId: snap.phaseId,
        projectId: snap.projectId,
      };
    }
    if (elapsedMs >= timeoutMs) {
      return {
        runId: snap.id,
        stage: snap.stage,
        settled: false,
        timedOut: true,
        elapsedMs,
        phaseId: snap.phaseId,
        projectId: snap.projectId,
      };
    }
    const remaining = timeoutMs - elapsedMs;
    await sleep(Math.min(intervalMs, Math.max(10, remaining)), opts.signal);
  }
}

export function formatWaitForRunResult(result: WaitForRunResult): string {
  if (result.stage === "missing") {
    return `Run ${result.runId} was not found while waiting.`;
  }
  if (result.settled) {
    return [
      `Run ${result.runId} finished ${result.stage} after ${Math.round(result.elapsedMs / 1000)}s.`,
      "Brief the operator on this outcome now.",
      result.stage === "in_review"
        ? "Research is ready for operator review — park advance_run (or start_development). Confirming either accepts the review if needed and keeps going until coding or design is running. Stay in this chat. Use submit_review request_changes only to send the plan back."
        : result.stage === "complete"
          ? "The run completed."
          : result.stage === "blocked" || result.stage === "failed"
            ? "The run did not succeed. Use get_run / get_development_report / get_operator_suggestions for why, then propose next steps."
            : "Do not claim the work is still in progress.",
    ].join(" ");
  }
  return [
    `Run ${result.runId} is still ${result.stage} after ${Math.round(result.elapsedMs / 1000)}s.`,
    "Tell the operator it is in progress (that stage). Do not invent a completion summary.",
    "A follow-up will arrive in this chat when the stage settles.",
  ].join(" ");
}
