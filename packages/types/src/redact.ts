/**
 * Redact secrets from strings before logging (API keys, bearer tokens, etc.).
 */
export function redactSecrets(input: string): string {
  return input
    .replace(
      /(Authorization:\s*Bearer\s+)[^\s"'\\]+/gi,
      "$1***",
    )
    .replace(
      /(Bearer\s+)[A-Za-z0-9._-]{12,}/gi,
      "$1***",
    )
    .replace(
      /\b(OLLAMA_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|CLERK_SECRET_KEY|CRON_SECRET|API_KEY|apiKey|token|password)\b(\s*[=:]\s*)([^\s"',}\\]+)/gi,
      "$1$2***",
    )
    .replace(
      /\b(oll-|sk-|pk_test_|pk_live_|sk_test_|sk_live_)[A-Za-z0-9._-]{8,}/g,
      "$1***",
    );
}

export function safeJsonForLog(value: unknown, maxLen = 500): string {
  try {
    return redactSecrets(JSON.stringify(value)).slice(0, maxLen);
  } catch {
    return redactSecrets(String(value)).slice(0, maxLen);
  }
}
