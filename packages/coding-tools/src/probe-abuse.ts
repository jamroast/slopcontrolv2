/**
 * Detect coding-session derail patterns (secret curls, long sleep+curl loops).
 * Kept in coding-tools so OpenCode can abort mid-turn without depending on artifacts.
 *
 * Important: require curl as an *invocation toward* a target on the same line —
 * not mere co-occurrence of the word "curl" and an URL in PHASE.md / APPENDIX prose.
 * Bearer curls to local Docker/Ollama hosts are allowed for auth diagnosis.
 */

/** curl followed by args, then Ollama Cloud chat/models on the same line */
const CURL_TO_OLLAMA_CLOUD =
  /\bcurl\b\s+[^\n]{0,200}https?:\/\/api\.ollama\.cloud\/v1\/(?:chat|models)/i;

/** sleep N && curl loops */
const SLEEP_AND_CURL = /sleep\s+\d+\s*&&\s*curl\b/i;

/** rate-limit after a curl invocation on the same line */
const CURL_RATE_LIMIT =
  /\bcurl\b\s+[^\n]{0,300}(?:session usage limit|upgrade for higher limits)/i;

/** Local / embedded targets — Bearer curls here are auth diagnosis, not secret probes */
const LOCAL_HTTP_TARGET =
  /https?:\/\/(?:127\.0\.0\.1|localhost|host\.docker\.internal)(?::\d+)?(?:\/|\s|$|"|')|https?:\/\/ollama(?::\d+)?(?:\/|\s|$|"|')/i;

/** Non-local http(s) URL (excludes the local hosts above) */
const NON_LOCAL_HTTP =
  /https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|\s|$|"|')|localhost(?::\d+)?(?:\/|\s|$|"|')|host\.docker\.internal(?::\d+)?(?:\/|\s|$|"|')|ollama(?::\d+)?(?:\/|\s|$|"|'))[^\s"'\\]+/i;

/**
 * Flag curl + Authorization Bearer only when the same command targets a non-local host.
 * Local Docker/Ollama diagnosis curls are allowed.
 */
function detectBearerCloudProbe(text: string): string | null {
  const segments =
    text.match(/\bcurl\b[^\n]{0,400}Authorization:\s*Bearer[^\n]{0,400}/gi) ??
    [];
  for (const segment of segments) {
    if (LOCAL_HTTP_TARGET.test(segment)) continue;
    if (NON_LOCAL_HTTP.test(segment) || /api\.ollama\.cloud|ollama\.com/i.test(segment)) {
      return "Coding session used curl with Authorization Bearer (secret probe). Abort and edit files instead.";
    }
  }
  return null;
}

export function detectCodingProbeAbuse(text: string): string | null {
  if (!text) return null;

  const bearer = detectBearerCloudProbe(text);
  if (bearer) return bearer;
  if (SLEEP_AND_CURL.test(text)) {
    return "Coding session ran sleep+curl probe loops. Abort and edit files instead.";
  }
  if (CURL_RATE_LIMIT.test(text)) {
    return "Coding session hit Ollama rate limits while probing. Abort; do not wait/retry live APIs.";
  }
  if (CURL_TO_OLLAMA_CLOUD.test(text)) {
    return "Coding session probed Ollama Cloud HTTP APIs. Abort and rely on local Automated Checks.";
  }
  return null;
}

/**
 * Extract bash tool command strings from OpenCode event payloads.
 * Used so probe detection ignores PHASE.md / system-prompt echoes.
 */
export function extractBashCommandsFromEvents(text: string): string {
  if (!text.trim()) return "";
  const commands: string[] = [];

  // Direct command fields in JSON event blobs
  const commandField =
    /"command"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  let m: RegExpExecArray | null;
  while ((m = commandField.exec(text)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    try {
      commands.push(JSON.parse(`"${raw}"`) as string);
    } catch {
      commands.push(raw.replace(/\\n/g, "\n").replace(/\\"/g, '"'));
    }
  }

  // tool":"bash" nearby input.command shapes
  const toolBash =
    /"tool"\s*:\s*"bash"[\s\S]{0,400}?"(?:command|raw)"\s*:\s*"((?:\\.|[^"\\])*)"/gi;
  while ((m = toolBash.exec(text)) !== null) {
    const raw = m[1];
    if (raw === undefined) continue;
    try {
      commands.push(JSON.parse(`"${raw}"`) as string);
    } catch {
      commands.push(raw);
    }
  }

  return commands.join("\n");
}

function looksLikeOpenCodeEventBlob(text: string): boolean {
  return /"type"\s*:/.test(text) || /"part"\s*:/.test(text);
}

/**
 * Probe scan for OpenCode mid-turn: scan bash commands only when the payload
 * looks like OpenCode event JSON. Fall back to full text only for raw command
 * strings (unit tests / simple invocations).
 */
export function detectCodingProbeAbuseFromEvents(eventText: string): string | null {
  const commands = extractBashCommandsFromEvents(eventText);
  if (commands.trim()) {
    return detectCodingProbeAbuse(commands);
  }
  if (looksLikeOpenCodeEventBlob(eventText)) {
    return null;
  }
  return detectCodingProbeAbuse(eventText);
}
