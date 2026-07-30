import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { LlmEndpoint } from "@slopcontrol/types";
import { assertVisionCapable } from "./capabilities.js";
import { resolveEndpointSecrets } from "./secrets.js";

export interface ChatWithImagesOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  prompt: string;
  imagePaths: string[];
  timeoutMs?: number;
}

export interface ChatWithImagesResult {
  text: string;
  modelId: string;
}

function mimeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "image/jpeg";
}

/** Raster formats providers typically accept as vision image_url inputs. */
export function isRasterVisionPath(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

/**
 * Drop SVG (and other non-raster) paths — many OpenAI-compat hosts return
 * 400 invalid image input for image/svg+xml.
 */
export function filterRasterVisionPaths(paths: string[]): string[] {
  return paths.filter(isRasterVisionPath);
}

/**
 * OpenAI-compatible chat with image attachments.
 * Hard-fails unless `endpoint.capabilities.vision` is true.
 */
export async function chatWithImages(
  opts: ChatWithImagesOptions,
): Promise<ChatWithImagesResult> {
  const endpoint = resolveEndpointSecrets(opts.endpoint);
  assertVisionCapable(endpoint);

  const modelId = opts.modelId ?? endpoint.modelId;
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/chat/completions`;

  const content: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [{ type: "text", text: opts.prompt }];

  const rasterPaths = filterRasterVisionPaths(opts.imagePaths);
  if (rasterPaths.length === 0) {
    throw new Error(
      "No raster vision images (png/jpeg/webp/gif); SVG-only inputs are skipped",
    );
  }

  for (const imagePath of rasterPaths) {
    const bytes = readFileSync(imagePath);
    const b64 = bytes.toString("base64");
    const mime = mimeForPath(imagePath);
    content.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${b64}` },
    });
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(endpoint.headers ?? {}),
  };
  const apiKey = endpoint.apiKey?.trim();
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content }],
        temperature: endpoint.defaultParams?.temperature ?? 0.2,
        max_tokens: endpoint.defaultParams?.maxTokens ?? 2048,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Vision chat failed (${res.status}) for ${basename(imagePathSafe(opts.imagePaths))}: ${body.slice(0, 400)}`,
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim() ?? "";
    return { text, modelId };
  } finally {
    clearTimeout(timer);
  }
}

function imagePathSafe(paths: string[]): string {
  return paths[0] ?? "(no images)";
}
