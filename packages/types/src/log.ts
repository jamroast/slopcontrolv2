export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel(): LogLevel {
  const raw = (process.env.SLOPCONTROL_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[configuredLevel()];
}

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta) return "";
  const entries = Object.entries(meta).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "";
  try {
    return ` ${JSON.stringify(Object.fromEntries(entries))}`;
  } catch {
    return "";
  }
}

/**
 * Structured service log. Always writes to stderr so MCP stdio (stdout) stays clean.
 * Level via SLOPCONTROL_LOG_LEVEL=debug|info|warn|error (default: info).
 */
export function slog(
  level: LogLevel,
  scope: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] [${scope}] ${message}${formatMeta(meta)}`;
  process.stderr.write(`${line}\n`);
}

export const log = {
  debug: (scope: string, message: string, meta?: Record<string, unknown>) =>
    slog("debug", scope, message, meta),
  info: (scope: string, message: string, meta?: Record<string, unknown>) =>
    slog("info", scope, message, meta),
  warn: (scope: string, message: string, meta?: Record<string, unknown>) =>
    slog("warn", scope, message, meta),
  error: (scope: string, message: string, meta?: Record<string, unknown>) =>
    slog("error", scope, message, meta),
};
