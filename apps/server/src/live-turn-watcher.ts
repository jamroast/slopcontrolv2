/**
 * Watcher for interactive live turns: stall / repeat-tool / thrash → auto-stop.
 * Runs in-process with the Express server (no separate Mastra daemon).
 */

import { log } from "@slopcontrol/types";
import { toolCallFingerprint } from "@slopcontrol/mastra";
import {
  liveTurns,
  type LiveTurnEvent,
  type LiveTurnRecord,
} from "./live-turns.js";

export type LiveWatcherConfig = {
  enabled: boolean;
  /** No events while running → interrupt */
  stallMs: number;
  /** Same tool fingerprint this many times → interrupt */
  repeatToolLimit: number;
  /** Tool calls with almost no text → interrupt */
  thrashToolLimit: number;
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
  const textLen = turn.events
    .filter((e): e is LiveTurnEvent & { type: "text" } => e.type === "text")
    .reduce((n, e) => n + e.text.length, 0);

  if (toolCalls.length >= cfg.thrashToolLimit && textLen < 80) {
    return "watcher_thrash";
  }

  const counts = new Map<string, number>();
  for (const e of toolCalls) {
    if (e.type !== "tool_call") continue;
    const fp = toolCallFingerprint(e.tool, e.summary);
    counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  for (const n of counts.values()) {
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
