import { log } from "@slopcontrol/types";
import type { ChatService } from "@slopcontrol/mastra";

export interface ChatConversationWatcherConfig {
  enabled: boolean;
  pollMs: number;
  /** Conversations idle longer than this are closed. */
  maxIdleMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveChatConversationWatcherConfig(): ChatConversationWatcherConfig {
  return {
    enabled: process.env.SLOPCONTROL_CHAT_WATCHER_ENABLED !== "0",
    pollMs: envInt("SLOPCONTROL_CHAT_WATCHER_INTERVAL_MS", 10 * 60 * 1_000),
    maxIdleMs: envInt(
      "SLOPCONTROL_CHAT_IDLE_CLOSE_MS",
      24 * 60 * 60 * 1_000,
    ),
  };
}

/**
 * Pure decider: which active conversations are idle past maxIdleMs.
 * Separated from the timer for tests (injectable clock).
 */
export function planIdleConversationClose(
  conversations: { id: string; lastActiveAt: string }[],
  maxIdleMs: number,
  now: Date = new Date(),
): string[] {
  return conversations
    .filter((c) => now.getTime() - Date.parse(c.lastActiveAt) >= maxIdleMs)
    .map((c) => c.id);
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;

export function startChatConversationWatcher(
  chatService: Pick<ChatService, "listConversations" | "closeIdleConversations">,
  cfg: ChatConversationWatcherConfig = resolveChatConversationWatcherConfig(),
): void {
  if (!cfg.enabled) {
    log.info("chat", "conversation watcher disabled (SLOPCONTROL_CHAT_WATCHER_ENABLED=0)");
    return;
  }
  if (watcherTimer) return;
  log.info("chat", "conversation watcher started", {
    pollMs: cfg.pollMs,
    maxIdleMs: cfg.maxIdleMs,
  });
  watcherTimer = setInterval(() => {
    try {
      const closed = chatService.closeIdleConversations(cfg.maxIdleMs);
      if (closed.length > 0) {
        log.info("chat", "idle conversations closed", { count: closed.length });
      }
    } catch (err) {
      log.warn("chat", "idle-close sweep failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }, cfg.pollMs);
  if (typeof watcherTimer === "object" && "unref" in watcherTimer) {
    watcherTimer.unref();
  }
}

export function stopChatConversationWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
