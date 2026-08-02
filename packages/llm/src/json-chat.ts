import type { LlmEndpoint } from "@slopcontrol/types";
import { resolveEndpointSecrets } from "./secrets.js";

export interface ChatJsonOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  system: string;
  user: string;
  timeoutMs?: number;
  temperature?: number;
  /**
   * Extra attempts after the first when content is empty or not valid JSON
   * (default 2 → 3 tries total).
   */
  emptyContentRetries?: number;
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
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
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

function isRetryableChatJsonError(message: string): boolean {
  return /empty content|parse failed/i.test(message);
}

/**
 * OpenAI-compatible JSON chat. Prefer `response_format: json_object` for
 * openai-chat; otherwise strip fences and parse.
 * Retries on empty content or invalid JSON (prose refusals / chatter).
 */
export async function chatJson(opts: ChatJsonOptions): Promise<ChatJsonResult> {
  const endpoint = resolveEndpointSecrets(opts.endpoint);
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
  const timeoutMs = opts.timeoutMs ?? endpoint.timeoutMs ?? 15_000;
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
      max_tokens: endpoint.defaultParams?.maxTokens ?? 1024,
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
      const e = err instanceof Error ? err : new Error(String(err));
      lastError = e;
      if (attempt < maxAttempts && isRetryableChatJsonError(e.message)) {
        continue;
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("JSON chat returned empty content");
}
