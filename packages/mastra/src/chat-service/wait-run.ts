import type { RunSettledContext } from "./run-settled-notification.js";
import { buildRunSettledGuidance } from "./run-settled-notification.js";
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
/** Slow poll when run-stage pub/sub is active (watchdog only). */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 30_000;
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

/** Infer the wait kind from a live run stage (for wait_for_run, which carries no tool context). */
export function runWaitKindForStage(stage: string | undefined): RunWaitKind {
  if (stage === "researching" || stage === "drafting") return "research";
  return "develop";
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
  watchdogIntervalMs?: number;
  signal?: AbortSignal;
  onProgress?: (snap: RunSnapshot, elapsedMs: number) => void;
  /** Wake early on server stage transitions (touchRunStage pub/sub). */
  subscribeRun?: (runId: string, listener: () => void) => () => void;
}): Promise<WaitForRunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollMs = opts.intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
  const watchdogMs = opts.subscribeRun
    ? (opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS)
    : pollMs;
  const started = Date.now();
  let lastStage: RunStage | undefined;
  let last: RunSnapshot | undefined;

  return new Promise((resolve, reject) => {
    let finished = false;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let unsub: (() => void) | undefined;

    const finish = (result: WaitForRunResult) => {
      if (finished) return;
      finished = true;
      if (watchdog) clearInterval(watchdog);
      unsub?.();
      resolve(result);
    };

    const onAbort = () => {
      if (finished) return;
      finished = true;
      if (watchdog) clearInterval(watchdog);
      unsub?.();
      reject(opts.signal?.reason ?? new Error("aborted"));
    };

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const evaluate = async (): Promise<void> => {
      if (finished || opts.signal?.aborted) return;
      const snap = await opts.getRun();
      const elapsedMs = Date.now() - started;
      if (!snap) {
        finish({
          runId: opts.runId,
          stage: "missing",
          settled: false,
          timedOut: false,
          elapsedMs,
        });
        return;
      }
      last = snap;
      if (snap.stage !== lastStage) {
        lastStage = snap.stage;
        opts.onProgress?.(snap, elapsedMs);
      }
      if (!isBusyRunStage(snap.stage)) {
        finish({
          runId: snap.id,
          stage: snap.stage,
          settled: true,
          timedOut: false,
          elapsedMs,
          phaseId: snap.phaseId,
          projectId: snap.projectId,
        });
        return;
      }
      if (elapsedMs >= timeoutMs) {
        finish({
          runId: snap.id,
          stage: snap.stage,
          settled: false,
          timedOut: true,
          elapsedMs,
          phaseId: snap.phaseId,
          projectId: snap.projectId,
        });
      }
    };

    unsub = opts.subscribeRun?.(opts.runId, () => {
      void evaluate();
    });

    void evaluate();
    watchdog = setInterval(() => {
      void evaluate();
    }, Math.max(10, watchdogMs));
  });
}

export function formatWaitForRunResult(
  result: WaitForRunResult,
  ctx?: RunSettledContext,
): string {
  if (result.stage === "missing") {
    return `Run ${result.runId} was not found while waiting.`;
  }
  if (result.settled) {
    const guidance = buildRunSettledGuidance(
      {
        id: result.runId,
        stage: result.stage,
        phaseId: result.phaseId,
        projectId: result.projectId,
      },
      ctx,
    );
    return [
      `Run ${result.runId} finished ${result.stage} after ${Math.round(result.elapsedMs / 1000)}s.`,
      "Brief the operator on this outcome now.",
      guidance,
    ].join(" ");
  }
  return [
    `Run ${result.runId} is still ${result.stage} after ${Math.round(result.elapsedMs / 1000)}s.`,
    "Tell the operator it is in progress (that stage). Do not invent a completion summary.",
    "A follow-up will arrive in this chat when the stage settles.",
  ].join(" ");
}
