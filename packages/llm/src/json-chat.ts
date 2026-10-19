import { type ZodError, type ZodType } from "zod";
import type { LlmEndpoint, ProvidersConfig } from "@slopcontrol/types";
import { resolveEndpointSecrets } from "./secrets.js";

/** Default wall-clock for JSON chat when caller and endpoint omit timeoutMs. */
export const CHAT_JSON_DEFAULT_TIMEOUT_MS = 300_000;

/** Default completion budget when caller and endpoint omit maxTokens. */
export const CHAT_JSON_DEFAULT_MAX_TOKENS = 4096;

/** Planning quality / intent judges — large excerpts + reasoning headroom. */
export const CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS = 300_000;
export const CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS = 8192;

/**
 * Shared RESEARCH.md / PHASE.md excerpt budget for planning judges and the
 * drafter prompts those judges score. Judges cannot read_file past a clip, so
 * a smaller inner consolidate (the old 16k head+tail) drops the middle the
 * drafter was told to implement. 96k covers a realistic research doc inside
 * one cloud-judge context. Callers that must truncate further should keep
 * head and tail inside this budget, never a shorter head-only slice.
 */
export const PLANNING_JUDGE_EXCERPT_CHARS = 96_000;

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
  /** Test hook: override the sleep used for server-error retry backoff. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Validate the parsed value inside the retry loop. A shape mismatch (e.g. an
   * object schema receiving an array) retries with a nudge instead of throwing
   * out of chatJson — callers no longer parse outside the retry boundary.
   */
  schema?: ZodType;
  /** Prompt fragment describing the expected shape (used in shape-error nudges). */
  schemaHint?: string;
}

export interface ChatJsonResult {
  text: string;
  parsed: unknown;
  modelId: string;
}

const JSON_ONLY_NUDGE =
  "\n\nIMPORTANT: Respond with ONLY a single valid JSON object. No prose, no markdown, no explanation.";

/** Human-readable zod issue summary (never a raw issues array). */
export function formatZodIssues(error: ZodError): string {
  const issues = error.issues ?? [];
  if (issues.length === 0) return "invalid shape";
  return issues
    .map((issue) => {
      const where =
        issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

/** Strip optional markdown fences around a JSON object/array. */
export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fenced?.[1]) return extractJsonValue(fenced[1].trim());
  // Opening fence without closing fence (common on truncated cloud judge output).
  const openFence = trimmed.match(/^```(?:json)?\s*([\s\S]*)$/i);
  if (openFence?.[1]) return extractJsonValue(openFence[1].trim());
  return extractJsonValue(trimmed);
}

function extractJsonValue(text: string): string {
  // Model-agnostic extraction: try each `{`/`[` as a candidate JSON value and
  // return the first one that parses. Tolerates leading prose, trailing prose,
  // markdown fences, and prose braces that are not JSON — so any model that
  // emits a JSON object/array anywhere in its reply is handled.
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const candidate = extractBalanced(text, i, ch);
    if (candidate == null) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON — try the next candidate.
    }
  }
  // No parseable JSON value found — return the raw text (best effort).
  return text;
}

/**
 * Return the balanced `{…}`/`[…]` span starting at `start`, skipping string
 * contents (including escaped quotes) so braces inside strings do not confuse
 * the match. Returns null when unbalanced.
 */
function extractBalanced(
  text: string,
  start: number,
  open: string,
): string | null {
  const close = open === "{" ? "}" : "]";
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
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
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

/**
 * True for transient server-side failures — HTTP 5xx, 429 rate-limit, and
 * network/connectivity errors — where retrying after a backoff delay is
 * worthwhile (e.g. hosted providers returning 500 under load). 4xx client
 * errors are deterministic and stay non-retryable.
 */
export function isServerSideChatJsonError(message: string): boolean {
  return (
    /JSON chat failed \((?:5\d\d|429)\)/i.test(message) ||
    /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|network error|connect timeout|UND_ERR_CONNECT_TIMEOUT/i.test(
      message,
    )
  );
}

export function isRetryableChatJsonError(message: string, err?: unknown): boolean {
  return (
    /empty content|parse failed/i.test(message) ||
    isChatJsonTimeoutError(err, message) ||
    isServerSideChatJsonError(message)
  );
}

/** Base delay for server-side retries; doubles per attempt (capped) plus jitter. */
export const CHAT_JSON_SERVER_RETRY_BASE_MS = 2_000;
export const CHAT_JSON_SERVER_RETRY_MAX_MS = 15_000;

/** Exponential backoff with up to 1s jitter: ~2s, ~4s, ~8s, then capped ~15s. */
export function serverRetryDelayMs(attempt: number): number {
  const exp = Math.min(
    CHAT_JSON_SERVER_RETRY_MAX_MS,
    CHAT_JSON_SERVER_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
  );
  return exp + Math.floor(Math.random() * 1_000);
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
  const sleep =
    opts.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastError: Error | null = null;
  // Only relax response_format after the provider returned empty content with
  // it forced — never as a last-resort against prose output.
  let dropJsonFormat = false;
  // Field-level reason from the previous shape failure, so a retry is told
  // which key was missing or which type was wrong — not only "send JSON".
  let shapeNudge = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const userContent =
      attempt === 1 ? opts.user : `${opts.user}${JSON_ONLY_NUDGE}${shapeNudge}`;
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
    // Keep json_object while retrying parse/prose failures. Drop it only after
    // an empty completion (some models return empty when response_format is
    // forced) — dropping it on the final attempt makes prose more likely.
    if (useJsonObject && !dropJsonFormat) {
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
        dropJsonFormat = true;
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
      if (opts.schema) {
        let checked = opts.schema.safeParse(parsed);
        // Single-element array wrapping is a common model tic — unwrap when the
        // wrapped element satisfies the schema (never for genuine array schemas,
        // because the wrapped check must pass).
        if (
          !checked.success &&
          Array.isArray(parsed) &&
          parsed.length === 1 &&
          parsed[0] !== null &&
          typeof parsed[0] === "object" &&
          !Array.isArray(parsed[0])
        ) {
          const unwrapped = opts.schema.safeParse(parsed[0]);
          if (unwrapped.success) checked = unwrapped;
        }
        if (!checked.success) {
          const issues = formatZodIssues(checked.error);
          shapeNudge = `\n\nYour previous JSON failed schema validation: ${issues}.${opts.schemaHint ? ` ${opts.schemaHint}.` : ""}`;
          lastError = new Error(
            `JSON shape invalid: ${issues}${opts.schemaHint ? ` — ${opts.schemaHint}` : ""} (attempt ${attempt}/${maxAttempts})`,
          );
          if (attempt < maxAttempts) continue;
          throw lastError;
        }
        return { text, parsed: checked.data, modelId };
      }
      return { text, parsed, modelId };
    } catch (err) {
      if (isChatJsonTimeoutError(err)) {
        lastError = timeoutError(timeoutMs, attempt, maxAttempts);
        if (attempt < maxAttempts) {
          // Timeouts usually mean an overloaded server — back off, don't hammer.
          await sleep(serverRetryDelayMs(attempt));
          continue;
        }
        throw lastError;
      }
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (attempt < maxAttempts && isRetryableChatJsonError(e.message, e)) {
        if (isServerSideChatJsonError(e.message)) {
          await sleep(serverRetryDelayMs(attempt));
        }
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("JSON chat returned empty content");
}
