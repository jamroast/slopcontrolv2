/**
 * Long-lived HTTP timeouts for OpenCode SDK blocking session.prompt().
 * Node's default undici headersTimeout is 300s and kills long coding turns.
 *
 * Do NOT wrap SDK fetch with a custom undici.fetch(Request) — the OpenCode
 * client passes Request objects and that path throws
 * "Failed to parse URL from [object Request]". Use setGlobalDispatcher instead
 * so globalThis.fetch keeps Request compatibility with raised timeouts.
 */
import { Agent, setGlobalDispatcher } from "undici";

const HOUR_MS = 3_600_000;

let installed = false;
let installedMs = 0;

function resolveTimeoutMs(): number {
  const timeoutMs = Number(
    process.env.SLOPCONTROL_OPENCODE_FETCH_MS ??
      process.env.SLOPCONTROL_CODING_TURN_MS ??
      HOUR_MS,
  );
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : HOUR_MS;
}

/**
 * Install a process-wide undici Agent with long headers/body timeouts.
 * Idempotent for the same timeout; safe to call before createOpencodeClient.
 */
export function ensureOpenCodeFetchTimeouts(): void {
  const ms = resolveTimeoutMs();
  if (installed && installedMs === ms) return;
  setGlobalDispatcher(
    new Agent({
      connectTimeout: Math.max(ms, 60_000),
      headersTimeout: ms,
      bodyTimeout: ms,
    }),
  );
  installed = true;
  installedMs = ms;
}

/** Test helper — reset install guard (does not restore prior dispatcher). */
export function resetOpenCodeFetchTimeoutsForTests(): void {
  installed = false;
  installedMs = 0;
}

export function getOpenCodeFetchTimeoutMsForTests(): number {
  return installedMs;
}
