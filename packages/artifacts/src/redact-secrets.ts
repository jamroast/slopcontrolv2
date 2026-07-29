/**
 * Redact secrets from diagnosis / APPENDIX evidence so API keys never leak to UI.
 */

const SECRET_KEY_LINE =
  /^([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PRIVATE_KEY)[A-Za-z0-9_]*)\s*=\s*(.+)$/gim;

const BEARER_RE = /(Authorization:\s*Bearer\s+)(\S+)/gi;

const INLINE_KEY_ASSIGN =
  /\b([A-Za-z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)[A-Za-z0-9_]*)\s*[:=]\s*([^\s"'`,;]+)/gi;

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text.replace(SECRET_KEY_LINE, (_m, key: string, value: string) => {
    const v = value.trim().replace(/^["']|["']$/g, "");
    return `${key}=[REDACTED len=${v.length}]`;
  });
  out = out.replace(BEARER_RE, (_m, prefix: string, token: string) => {
    return `${prefix}[REDACTED len=${token.length}]`;
  });
  out = out.replace(INLINE_KEY_ASSIGN, (m, key: string, value: string) => {
    // Skip already-redacted
    if (/\[REDACTED/i.test(value)) return m;
    return `${key}=[REDACTED len=${value.length}]`;
  });
  return out;
}
