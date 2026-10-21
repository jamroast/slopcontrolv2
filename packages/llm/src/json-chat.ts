import { type ZodError, type ZodType } from "zod";
import {
  generateObject,
  generateText,
  NoObjectGeneratedError,
  type FlexibleSchema,
  type LanguageModel,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LlmEndpoint, ProvidersConfig } from "@slopcontrol/types";
import { resolveEndpointSecrets } from "./secrets.js";

/** Default wall-clock for JSON chat when caller and endpoint omit timeoutMs. */
export const CHAT_JSON_DEFAULT_TIMEOUT_MS = 300_000;

/** Default completion budget when caller and endpoint omit maxTokens. */
export const CHAT_JSON_DEFAULT_MAX_TOKENS = 4096;

/** Planning quality / intent judges — big excerpts + reasoning headroom. */
export const CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS = 300_000;
/**
 * 8k was too small for reasoning-model judges: deepseek-v4-pro burns ~15k
 * tokens on chain-of-thought for an 80k-char PHASE judge prompt before the
 * answer. 32k (the truncation cap) lets a reasoning judge finish in one call.
 */
export const CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS = 32_768;

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
  /**
   * AI SDK transport retries for 408/409/429/5xx and network errors
   * (default 2). Applies to the AI SDK transport; the fetch fallback uses
   * `emptyContentRetries` as before.
   */
  maxRetries?: number;
  /**
   * Retries of a TIMED-OUT attempt in the fetch transport (default
   * CHAT_JSON_TIMEOUT_RETRIES). A timeout is a latency signal, not flaky JSON.
   * `chatJson` passes 0 when it falls back after an SDK timeout, so one slow
   * provider costs one timed-out window rather than three.
   */
  timeoutRetries?: number;
}

export interface ChatJsonResult {
  text: string;
  parsed: unknown;
  modelId: string;
}

const JSON_ONLY_NUDGE =
  "\n\nIMPORTANT: Respond with ONLY a single valid JSON object. No prose, no markdown, no explanation.";

/** Completion budget shared by every truncation bump ladder. */
const TRUNCATION_BUDGET_CAP = 32_768;

/**
 * Bump a completion budget after finish_reason=length (doubling, min +2k).
 * Returns the next budget, or null when already at the cap.
 */
function nextTruncationBudget(current: number): number | null {
  const bumped = Math.min(
    TRUNCATION_BUDGET_CAP,
    Math.max(current* 2, current + 2_048),
  );
  return bumped <= current ? null : bumped;
}

/**
 * The first balanced, parseable JSON *object* in text (reasoning fallbacks can
 * contain array literals mid-thought — a "received array" shape failure should
 * never stop the scan before a real verdict object is checked).
 */
function extractJsonObject(text: string): unknown | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const candidate = extractBalanced(text, i, "{");
    if (candidate == null) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        return value;
      }
    } catch {
      // Not valid JSON — keep scanning.
    }
  }
  return null;
}

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

/**
 * Max retries of a timed-out attempt. A timeout is a latency signal (prompt
 * too big / provider too slow), not flaky JSON — the identical payload at the
 * same timeout almost always re-aborts, so more than one retry just triples
 * wall time for the same verdict.
 */
export const CHAT_JSON_TIMEOUT_RETRIES = 1;

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
 * Direct OpenAI-compatible JSON chat (compatibility transport).
 *
 * Kept as the bounded fallback behind `chatJson` for endpoints that reject
 * structured output, plus the `SLOPCONTROL_JUDGE_TRANSPORT=fetch` escape hatch.
 * Prefers `response_format: json_object` for openai-chat; otherwise strips
 * fences and parses. Retries empty content, invalid JSON, shape and timeouts.
 */
export async function chatJsonFetch(
  opts: ChatJsonOptions,
): Promise<ChatJsonResult> {
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
  // Mutable completion budget: finish_reason=length retries bump it instead of
  // burning the same budget on a nudged retry (a truncation needs more tokens,
  // not a different shape — reasoning-model judges exceed 8k before answering).
  let maxTokensBudget =
    opts.maxTokens ??
    endpoint.defaultParams?.maxTokens ??
    CHAT_JSON_DEFAULT_MAX_TOKENS;
  // Field-level reason from the previous shape failure, so a retry is told
  // which key was missing or which type was wrong — not only "send JSON".
  let shapeNudge = "";
  // Timeouts retry at most `timeoutRetries` times (default
  // CHAT_JSON_TIMEOUT_RETRIES): a 300s abort is a latency signal, not flaky JSON.
  const timeoutRetryBudget = Math.max(0, opts.timeoutRetries ?? CHAT_JSON_TIMEOUT_RETRIES);
  let timeoutRetriesUsed = 0;

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
      max_tokens: maxTokensBudget,
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
        choices?: Array<{
          message?: ChatMessage;
          finish_reason?: string;
          finishReason?: string;
        }>;
      };
      const finishReason =
        json.choices?.[0]?.finish_reason ?? json.choices?.[0]?.finishReason;
      const message = json.choices?.[0]?.message;
      const text = extractChatMessageText(message);
      // When content is empty the extractor fell back to reasoning text — a
      // mid-thought scratch pad whose bracketed snippets are not the answer.
      const contentText = (() => {
        const c = message?.content;
        if (typeof c === "string") return c.trim();
        if (Array.isArray(c)) {
          return c.map((p) => (typeof p?.text === "string" ? p.text : "")).filter(Boolean).join("\n").trim();
        }
        return "";
      })();
      const textFromReasoning = !contentText && Boolean(text);
      // Truncated completion (reasoning models burn the whole budget on CoT):
      // bump the budget rather than parse truncated chain-of-thought or retry
      // the identical budget with a nudge.
      const bumpOnTruncation = (): boolean => {
        if (finishReason !== "length") return false;
        const bumped = nextTruncationBudget(maxTokensBudget);
        if (bumped == null || attempt >= maxAttempts) return false;
        maxTokensBudget = bumped;
        return true;
      };
      if (!text) {
        if (bumpOnTruncation()) continue;
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
        if (bumpOnTruncation()) continue;
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
        // Truncated reasoning fallback: the extraction scan can land on an
        // array literal from mid-thought text. Rescan for a verdict object.
        // Content-based arrays keep the nudge contract (the model's whole
        // answer really was an array — tell it to send an object instead).
        if (!checked.success && Array.isArray(parsed) && textFromReasoning) {
          const obj = extractJsonObject(text);
          if (obj !== null) {
            const rescued = opts.schema.safeParse(obj);
            if (rescued.success) checked = rescued;
          }
        }
        if (!checked.success) {
          if (bumpOnTruncation()) continue;
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
        if (
          attempt < maxAttempts &&
          timeoutRetriesUsed < timeoutRetryBudget
        ) {
          timeoutRetriesUsed += 1;
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

// ─── AI SDK transport (the layer Mastra runs on) ────────────────────────────

class JsonTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonTruncatedError";
  }
}

/** generateObject parse repair: pull the JSON value out of fences/prose. */
async function repairJsonText({
  text,
}: {
  text: string;
}): Promise<string | null> {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const extracted = stripJsonFence(trimmed);
  return extracted && extracted !== trimmed ? extracted : null;
}

const openaiProviders = new Map<string, ReturnType<typeof createOpenAI>>();
const anthropicProviders = new Map<string, ReturnType<typeof createAnthropic>>();

/** Build (and cache) an AI SDK model for an endpoint; null when unsupported. */
export function aiSdkModelFor(
  endpoint: LlmEndpoint,
  modelId: string,
): LanguageModel | null {
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) return null;
  const headers = endpoint.headers ?? {};
  const apiKey = endpoint.apiKey?.trim() || "not-needed";
  const key = `${endpoint.apiType}|${baseUrl}|${apiKey}|${JSON.stringify(headers)}`;
  if (endpoint.apiType === "anthropic-messages") {
    let provider = anthropicProviders.get(key);
    if (!provider) {
      provider = createAnthropic({ baseURL: baseUrl, apiKey, headers });
      anthropicProviders.set(key, provider);
    }
    return provider(modelId) as LanguageModel;
  }
  if (
    endpoint.apiType === "openai-chat" ||
    endpoint.apiType === "openai-completions"
  ) {
    let provider = openaiProviders.get(key);
    if (!provider) {
      provider = createOpenAI({ baseURL: baseUrl, apiKey, headers });
      openaiProviders.set(key, provider);
    }
    return provider.chat(
      modelId as Parameters<typeof provider.chat>[0],
    ) as LanguageModel;
  }
  return null;
}

/** Transport-level failure after the SDK's own retries (429/5xx/network). */
function isTransportFailure(err: unknown): boolean {
  const status = (err as { statusCode?: number } | null)?.statusCode;
  if (status != null && (status === 429 || status >= 500)) return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return isServerSideChatJsonError(msg);
}

/**
 * JSON chat with the AI SDK transport (generateObject when a schema is given,
 * generateText otherwise), Mastra-native retries/abort/finishReason, and a
 * bounded fallback to the direct fetch transport for endpoints that reject
 * structured output.
 */
export async function chatJson(opts: ChatJsonOptions): Promise<ChatJsonResult> {
  if (process.env.SLOPCONTROL_JUDGE_TRANSPORT === "fetch") {
    return chatJsonFetch(opts);
  }
  const endpoint = resolveEndpointSecrets(opts.endpoint, opts.providers);
  const modelId = opts.modelId ?? endpoint.modelId;
  const model = aiSdkModelFor(endpoint, modelId);
  if (!model) return chatJsonFetch(opts);

  const timeoutMs =
    opts.timeoutMs ?? endpoint.timeoutMs ?? CHAT_JSON_DEFAULT_TIMEOUT_MS;
  const baseBudget =
    opts.maxTokens ??
    endpoint.defaultParams?.maxTokens ??
    CHAT_JSON_DEFAULT_MAX_TOKENS;
  const maxRetries = opts.maxRetries ?? 2;

  const call = async (
    useSchema: boolean,
    budget: number,
  ): Promise<ChatJsonResult> => {
    const abortSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    try {
      if (useSchema && opts.schema) {
        const result = await generateObject({
          model,
          schema: opts.schema as unknown as FlexibleSchema<unknown>,
          system: opts.system,
          prompt: opts.user,
          temperature: opts.temperature ?? 0,
          maxOutputTokens: budget,
          maxRetries,
          abortSignal,
          experimental_repairText: repairJsonText,
        });
        if (result.finishReason === "length") {
          throw new JsonTruncatedError(
            `JSON chat truncated (finishReason=length, maxOutputTokens=${budget})`,
          );
        }
        return {
          text: JSON.stringify(result.object),
          parsed: result.object,
          modelId,
        };
      }
      const result = await generateText({
        model,
        system: opts.system,
        prompt: `${opts.user}${JSON_ONLY_NUDGE}`,
        temperature: opts.temperature ?? 0,
        maxOutputTokens: budget,
        maxRetries,
        abortSignal,
      });
      if (result.finishReason === "length") {
        throw new JsonTruncatedError(
          `JSON chat truncated (finishReason=length, maxOutputTokens=${budget})`,
        );
      }
      const text = (result.text ?? "").trim();
      if (!text) throw new Error("JSON chat returned empty content");
      const parsed: unknown = JSON.parse(stripJsonFence(text));
      if (opts.schema) {
        const checked = opts.schema.safeParse(parsed);
        if (!checked.success) {
          throw new Error(
            `JSON shape invalid: ${formatZodIssues(checked.error)}${opts.schemaHint ? ` — ${opts.schemaHint}` : ""}`,
          );
        }
        return { text, parsed: checked.data, modelId };
      }
      return { text, parsed, modelId };
    } catch (err) {
      if (abortSignal.aborted || isChatJsonTimeoutError(err)) {
        throw timeoutError(timeoutMs, 1, 1);
      }
      if (
        err instanceof NoObjectGeneratedError &&
        (err as { finishReason?: string }).finishReason === "length"
      ) {
        throw new JsonTruncatedError(
          `JSON chat truncated (finishReason=length, maxOutputTokens=${budget})`,
        );
      }
      throw err;
    }
  };

  const withTruncationRetry = async (
    useSchema: boolean,
  ): Promise<ChatJsonResult> => {
    try {
      return await call(useSchema, baseBudget);
    } catch (err) {
      if (!(err instanceof JsonTruncatedError)) throw err;
      const bumped = nextTruncationBudget(baseBudget);
      if (bumped == null) throw err;
      return call(useSchema, bumped);
    }
  };

  let firstError: unknown;
  if (opts.schema) {
    try {
      return await withTruncationRetry(true);
    } catch (err) {
      firstError = err;
      // A transport failure already burned the SDK retries: go straight to the
      // compatibility transport instead of paying for a second text attempt.
      // A timeout gets exactly one fetch attempt (timeoutRetries: 0) — repeating
      // the same slow window would triple wall time without changing the cause.
      if (isChatJsonTimeoutError(err)) {
        return chatJsonFetch({ ...opts, timeoutRetries: 0 });
      }
      if (isTransportFailure(err)) {
        return chatJsonFetch(opts);
      }
    }
  }
  try {
    return await withTruncationRetry(false);
  } catch (err) {
    firstError = firstError ?? err;
    if (isChatJsonTimeoutError(err)) {
      return chatJsonFetch({ ...opts, timeoutRetries: 0 });
    }
  }
  try {
    return await chatJsonFetch(opts);
  } catch (fetchErr) {
    throw fetchErr ?? firstError;
  }
}
