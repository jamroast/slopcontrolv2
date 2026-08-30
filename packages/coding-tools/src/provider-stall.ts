/**
 * Detect OpenCode / Ollama provider stalls and rate limits from event payloads
 * (not bash curl probes — those live in probe-abuse.ts).
 *
 * Important: instructional prose (learnings, orchestrator prompts, APPENDIX)
 * often mentions "rate limit" / "429" / "usage limit". Only real provider
 * error shapes may abort a coding turn.
 */

const RATE_LIMIT_RE =
  /\b429\b|rate[\s_-]?limit|usage[\s_-]?limit|session usage limit|upgrade for higher limits|too many requests|quota[\s_-]?exceeded/gi;

/** Must appear near a rate-limit match to count as a real provider failure */
const ERROR_SHAPE_RE =
  /"error"\s*:|"type"\s*:\s*"[^"]*error[^"]*"|\"statusCode\"\s*:\s*429|\"status\"\s*:\s*429|Too Many Requests|provider[_\s.-]?error/i;

/** Instructional / negation windows — do not treat as live provider throttle */
const INSTRUCTIONAL_RE =
  /do not\b[\s\S]{0,100}rate[\s_-]?limit|burn the session[\s\S]{0,60}rate|wait for (?:quota|rate)|stall\/throttle|provider_rate_limit|LEARNINGS|Automated Checks/i;

const ABORT_MESSAGE =
  "OpenCode coding LLM hit provider rate/usage limits (Ollama Cloud or similar). " +
  "Abort; wait for quota or switch model — do not keep recreating sessions.";

export function detectProviderRateLimit(eventText: string): string | null {
  if (!eventText.trim()) return null;

  const re = new RegExp(RATE_LIMIT_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(eventText)) !== null) {
    const start = Math.max(0, m.index - 220);
    const end = Math.min(eventText.length, m.index + m[0].length + 220);
    const window = eventText.slice(start, end);

    if (INSTRUCTIONAL_RE.test(window) && !/"error"\s*:|statusCode|Too Many Requests/i.test(window)) {
      continue;
    }
    if (ERROR_SHAPE_RE.test(window)) {
      return ABORT_MESSAGE;
    }
  }
  return null;
}

/** Abort reasons that count as consecutive coding-LLM stalls (not probe abuse). */
export const STALL_ABORT_REASONS = new Set([
  "turn_timeout",
  "turn_idle",
  "provider_rate_limit",
]);

/** Soft wall-clock yield — session stays sticky; not a stall strike. */
export const TURN_BUDGET_YIELD = "turn_budget_yield";

const SESSION_EXPIRY_RE =
  /session\s+(?:not\s+found|has\s+expired|expired)|404[\s:]+session\s+not\s+found/i;

/**
 * True when a coding turn's output is a session-expiry signal (e.g. pi /
 * OpenCode `404: Session not found` / "session has expired") rather than real work.
 */
export function isSessionExpirySignal(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  return SESSION_EXPIRY_RE.test(text);
}

/** True when the model returned no usable assistant text for the turn. */
export function isEmptyCodingTurnOutput(
  text: string | null | undefined,
): boolean {
  return !text?.trim();
}

/**
 * Coding-session fault on a develop turn — expired agent session or empty output
 * with no planned-path edits. Not the project's test/verify harness; caller
 * passes whether any ## File Changes path was touched.
 */
export function isCodingSessionTurnFault(
  output: string | null | undefined,
  opts: { touchedPlannedPath: boolean },
): boolean {
  if (isSessionExpirySignal(output)) return true;
  return isEmptyCodingTurnOutput(output) && !opts.touchedPlannedPath;
}

export function isStallAbortReason(reason: string | null | undefined): boolean {
  if (!reason) return false;
  if (reason === TURN_BUDGET_YIELD) return false;
  if (STALL_ABORT_REASONS.has(reason)) return true;
  return /provider rate\/usage limits|turn exceeded|no OpenCode events|turn_idle|provider_rate_limit/i.test(
    reason,
  );
}

export function shouldBlockOnStallStrikes(
  consecutiveStalls: number,
  maxStrikes = 3,
): boolean {
  return consecutiveStalls >= maxStrikes;
}

/**
 * Wall-clock budget with real worktree changes is soft yield / budget exhaustion,
 * not an idle/rate-limit stall. Do not count these toward stall strikes.
 */
export function isProductiveTurnTimeout(
  reason: string | null | undefined,
  changedFiles: string[] | null | undefined,
): boolean {
  if (!reason || !changedFiles?.length) return false;
  if (reason === TURN_BUDGET_YIELD || reason === "turn_timeout") return true;
  return /turn exceeded|turn_timeout|turn_budget_yield/i.test(reason);
}

/**
 * Whether develop should recreate the OpenCode session after an abort.
 * Sticky by default for budget yield, idle, and rate-limit; recreate on
 * empty wall-clock timeout, probe abuse, or transport death.
 */
export function shouldRecreateCodingSession(
  reason: string | null | undefined,
  changedFiles: string[] | null | undefined,
): boolean {
  if (!reason) return true;
  if (reason === TURN_BUDGET_YIELD) return false;
  if (isProductiveTurnTimeout(reason, changedFiles)) return false;
  if (reason === "turn_idle" || reason === "provider_rate_limit") return false;
  // Empty wall-clock (stuck) — allow recreate
  if (reason === "turn_timeout" && !(changedFiles?.length)) return true;
  // Probe abuse / unknown — recreate
  return true;
}
