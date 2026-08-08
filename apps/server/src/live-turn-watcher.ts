/**
 * Watcher for interactive live turns: stall / repeat-tool / thrash → auto-stop.
 * Runs in-process with the Express server (no separate Mastra daemon).
 */

import { log } from "@slopcontrol/types";
import { toolCallFingerprint } from "@slopcontrol/mastra";
import {
  liveTurns,
  type LiveTurnKind,
  type LiveTurnRecord,
} from "./live-turns.js";

export type LiveWatcherConfig = {
  enabled: boolean;
  /** No events while running → interrupt */
  stallMs: number;
  /** Same tool fingerprint this many times → interrupt */
  repeatToolLimit: number;
  /** Tool calls with almost no text AND almost no diversity → interrupt */
  thrashToolLimit: number;
  /** Read-heavy kinds get their own budget (their step limits exceed the default). */
  thrashToolLimitByKind: Partial<Record<LiveTurnKind, number>>;
  /** Absolute max turn age */
  maxAgeMs: number;
  pollMs: number;
};

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function resolveLiveWatcherConfig(): LiveWatcherConfig {
  const enabled =
    process.env.SLOPCONTROL_LIVE_WATCH !== "0" &&
    process.env.SLOPCONTROL_LIVE_WATCH !== "false";
  return {
    enabled,
    stallMs: envInt("SLOPCONTROL_LIVE_STALL_MS", 90_000),
    repeatToolLimit: envInt("SLOPCONTROL_LIVE_REPEAT_TOOL", 5),
    thrashToolLimit: envInt("SLOPCONTROL_LIVE_THRASH_TOOLS", 16),
    thrashToolLimitByKind: {
      // plan_loop turns are read-heavy by design (maxSteps 16 + repair pass);
      // the global default would kill a full exploration before the plan streams.
      plan_loop: envInt("SLOPCONTROL_LIVE_THRASH_TOOLS_PLAN_LOOP", 40),
    },
    maxAgeMs: envInt("SLOPCONTROL_LIVE_MAX_AGE_MS", 12 * 60_000),
    pollMs: envInt("SLOPCONTROL_LIVE_WATCH_POLL_MS", 5_000),
  };
}

export type WatcherTripReason =
  | "watcher_stall"
  | "watcher_repeat_tool"
  | "watcher_thrash"
  | "watcher_max_age";

export function evaluateLiveTurnWatch(
  turn: LiveTurnRecord,
  cfg: LiveWatcherConfig,
  nowMs = Date.now(),
): WatcherTripReason | null {
  if (turn.status !== "running") return null;
  const started = Date.parse(turn.startedAt);
  const last = Date.parse(turn.lastEventAt);
  if (Number.isFinite(started) && nowMs - started >= cfg.maxAgeMs) {
    return "watcher_max_age";
  }
  if (Number.isFinite(last) && nowMs - last >= cfg.stallMs) {
    return "watcher_stall";
  }

  const toolCalls = turn.events.filter((e) => e.type === "tool_call");
  // Cumulative text on the record — event eviction must not lower it.
  const textLen = turn.textLen;

  const fingerprints = new Map<string, number>();
  for (const e of toolCalls) {
    if (e.type !== "tool_call") continue;
    const fp = toolCallFingerprint(e.tool, e.summary);
    fingerprints.set(fp, (fingerprints.get(fp) ?? 0) + 1);
  }

  // Thrash = high volume AND almost no narration AND almost no diversity.
  // Many distinct reads/searches are legitimate exploration (plan/research
  // turns narrate only at the end); repeating a handful of calls is not.
  const limit = cfg.thrashToolLimitByKind[turn.kind] ?? cfg.thrashToolLimit;
  const distinct = fingerprints.size;
  if (
    toolCalls.length >= limit &&
    textLen < 80 &&
    distinct <= Math.max(2, Math.floor(toolCalls.length / 4))
  ) {
    return "watcher_thrash";
  }

  for (const n of fingerprints.values()) {
    if (n >= cfg.repeatToolLimit) return "watcher_repeat_tool";
  }
  return null;
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;

export function startLiveTurnWatcher(
  cfg: LiveWatcherConfig = resolveLiveWatcherConfig(),
): void {
  if (!cfg.enabled) {
    log.info("live-watch", "disabled (SLOPCONTROL_LIVE_WATCH=0)");
    return;
  }
  if (watcherTimer) return;
  log.info("live-watch", "started", {
    stallMs: cfg.stallMs,
    repeatToolLimit: cfg.repeatToolLimit,
    thrashToolLimit: cfg.thrashToolLimit,
    maxAgeMs: cfg.maxAgeMs,
  });
  watcherTimer = setInterval(() => {
    const now = Date.now();
    for (const turn of liveTurns.listActive()) {
      const reason = evaluateLiveTurnWatch(turn, cfg, now);
      if (!reason) continue;
      log.warn("live-watch", "auto-interrupt", {
        turnId: turn.turnId,
        kind: turn.kind,
        sessionId: turn.sessionId,
        reason,
      });
      liveTurns.stop(turn.kind, turn.sessionId, reason);
    }
  }, cfg.pollMs);
  // Don't keep process alive solely for watcher in tests
  if (typeof watcherTimer === "object" && "unref" in watcherTimer) {
    watcherTimer.unref();
  }
}

export function stopLiveTurnWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
