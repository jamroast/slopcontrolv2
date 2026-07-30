import type { LlmEndpoint } from "@slopcontrol/types";
import { resolveEndpointSecrets } from "./secrets.js";

export interface ChatJsonOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  system: string;
  user: string;
  timeoutMs?: number;
  temperature?: number;
}

export interface ChatJsonResult {
  text: string;
  parsed: unknown;
  modelId: string;
}

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

/**
 * OpenAI-compatible JSON chat. Prefer `response_format: json_object` for
 * openai-chat; otherwise strip fences and parse.
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
  const body: Record<string, unknown> = {
    model: modelId,
    messages: [
      { role: "system", content: opts.system },
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0,
    max_tokens: endpoint.defaultParams?.maxTokens ?? 1024,
  };
  if (useJsonObject) {
    body.response_format = { type: "json_object" };
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? endpoint.timeoutMs ?? 15_000;
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
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    if (!text) {
      throw new Error("JSON chat returned empty content");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripJsonFence(text));
    } catch (err) {
      throw new Error(
        `JSON chat parse failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { text, parsed, modelId };
  } finally {
    clearTimeout(timer);
  }
}
