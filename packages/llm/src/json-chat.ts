import type { LlmEndpoint, ProvidersConfig } from "@slopcontrol/types";
import { resolveEndpointSecrets } from "./secrets.js";

/** Default wall-clock for JSON chat when caller and endpoint omit timeoutMs. */
export const CHAT_JSON_DEFAULT_TIMEOUT_MS = 300_000;

/** Default completion budget when caller and endpoint omit maxTokens. */
export const CHAT_JSON_DEFAULT_MAX_TOKENS = 4096;

/** Planning quality / intent judges — large excerpts + reasoning headroom. */
export const CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS = 300_000;
export const CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS = 8192;

export interface ChatJsonOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  system: string;
  user: string;
  timeoutMs?: number;
  temperature?: number;
  providers?: ProvidersConfig;
  /**
   * Extra attempts after the first when content is empty, not valid JSON,
   * or the request timed out (default 2 → 3 tries total).
   */
  emptyContentRetries?: number;
  /**
   * Completion budget override. Reasoning models (e.g. glm cloud) spend tokens
   * on chain-of-thought before the JSON answer; callers with large structured
   * outputs should raise this well above the 1024 default.
   */
  maxTokens?: number;
}

export interface ChatJsonResult {
  text: string;
  parsed: unknown;
  modelId: string;
}

const JSON_ONLY_NUDGE =
  "\n\nIMPORTANT: Respond with ONLY a single valid JSON object. No prose, no markdown, no explanation.";

/** Strip optional markdown fences around a JSON object/array. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced?.[1]) return extractJsonObject(fenced[1].trim());
  // Opening fence without closing fence (common on truncated cloud judge output).
  const openFence = trimmed.match(/^```(?:json)?\s*([\s\S]*)$/i);
  if (openFence?.[1]) return extractJsonObject(openFence[1].trim());
  return extractJsonObject(trimmed);
}

function extractJsonObject(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text;
  // Walk from the first `{` tracking brace depth, skipping string contents so
  // `{`/`}` inside string values (and trailing prose that happens to contain a
  // `}`) do not confuse the match. Returns the balanced object, not the last `}`.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  // Unbalanced — return the rest of the text (best effort).
  return text.slice(start);
}

type ChatMessage = {
  content?: string | Array<{ type?: string; text?: string }>;
  reasoning_content?: string;
  reasoning?: string;
};

/** Prefer message.content; fall back to reasoning fields some cloud models use. */
export function extractChatMessageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const joined = content
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
    if (joined) return joined;
  }
  for (const alt of [message.reasoning_content, message.reasoning]) {
    if (typeof alt === "string" && alt.trim()) {
      // Reasoning often wraps the JSON; stripJsonFence will locate the object.
      return alt.trim();
    }
  }
  return "";
}

/** True when fetch was aborted by our timeout (or equivalent AbortError). */
export function isChatJsonTimeoutError(
  err: unknown,
  message?: string,
): boolean {
  const msg =
    message ??
    (err instanceof Error ? err.message : err != null ? String(err) : "");
  const name = err instanceof Error ? err.name : "";
  return (
    name === "AbortError" ||
    /operation was aborted/i.test(msg) ||
    /JSON chat timed out after/i.test(msg)
  );
}

export function isRetryableChatJsonError(message: string, err?: unknown): boolean {
  return (
    /empty content|parse failed/i.test(message) ||
    isChatJsonTimeoutError(err, message)
  );
}

function timeoutError(timeoutMs: number, attempt: number, maxAttempts: number): Error {
  return new Error(
    `JSON chat timed out after ${timeoutMs}ms (attempt ${attempt}/${maxAttempts})`,
  );
}

/**
 * OpenAI-compatible JSON chat. Prefer `response_format: json_object` for
 * openai-chat; otherwise strip fences and parse.
 * Retries on empty content, invalid JSON, or client timeout abort.
 */
export async function chatJson(opts: ChatJsonOptions): Promise<ChatJsonResult> {
  const endpoint = resolveEndpointSecrets(opts.endpoint, opts.providers);
  const modelId = opts.modelId ?? endpoint.modelId;
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(endpoint.headers ?? {}),
  };
  const apiKey = endpoint.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const useJsonObject = endpoint.apiType === "openai-chat";
  const timeoutMs =
    opts.timeoutMs ?? endpoint.timeoutMs ?? CHAT_JSON_DEFAULT_TIMEOUT_MS;
  const maxAttempts = 1 + Math.max(0, opts.emptyContentRetries ?? 2);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userContent =
      attempt === 1 ? opts.user : `${opts.user}${JSON_ONLY_NUDGE}`;
    const body: Record<string, unknown> = {
      model: modelId,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: userContent },
      ],
      temperature: opts.temperature ?? 0,
      max_tokens:
        opts.maxTokens ??
        endpoint.defaultParams?.maxTokens ??
        CHAT_JSON_DEFAULT_MAX_TOKENS,
    };
    // Keep json_object while retrying parse/prose failures. Drop it only on the
    // final attempt (some models return empty when response_format is forced).
    if (useJsonObject && attempt < maxAttempts) {
      body.response_format = { type: "json_object" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        throw new Error(
          `JSON chat failed (${res.status}): ${errBody.slice(0, 400)}`,
        );
      }

      const json = (await res.json()) as {
        choices?: Array<{ message?: ChatMessage }>;
      };
      const text = extractChatMessageText(json.choices?.[0]?.message);
      if (!text) {
        lastError = new Error(
          `JSON chat returned empty content (attempt ${attempt}/${maxAttempts})`,
        );
        if (attempt < maxAttempts) continue;
        throw lastError;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripJsonFence(text));
      } catch (err) {
        lastError = new Error(
          `JSON chat parse failed: ${err instanceof Error ? err.message : String(err)} (attempt ${attempt}/${maxAttempts}; preview=${JSON.stringify(text.slice(0, 80))})`,
        );
        if (attempt < maxAttempts) continue;
        throw lastError;
      }
      return { text, parsed, modelId };
    } catch (err) {
      if (isChatJsonTimeoutError(err)) {
        lastError = timeoutError(timeoutMs, attempt, maxAttempts);
        if (attempt < maxAttempts) continue;
        throw lastError;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (attempt < maxAttempts && isRetryableChatJsonError(e.message, e)) {
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("JSON chat returned empty content");
}
