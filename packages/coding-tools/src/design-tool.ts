import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { LlmEndpoint, ProvidersConfig } from "@slopcontrol/types";
import {
  endpointSupportsImageGen,
  resolveEndpointSecrets,
} from "@slopcontrol/llm";

export interface GenerateImageOptions {
  prompt: string;
  outPath: string;
  endpoint?: LlmEndpoint;
  modelId?: string;
  width?: number;
  height?: number;
  providers?: ProvidersConfig;
  /** Brand / palette hint for SVG fallback. */
  brandName?: string;
  palette?: string[];
  /**
   * When true, logo/mark briefs must not silently fall back to tile+circle SVG.
   * Returns skipped with reason `logo_requires_designImage` (no file written).
   */
  logoFailClosed?: boolean;
}

/** True when an asset brief is a logo / wordmark / mark / favicon. */
export function isLogoAssetBrief(brief: {
  name: string;
  filename: string;
  prompt?: string;
}): boolean {
  // Name + filename only: the free-text prompt mentions "logo" constantly
  // (e.g. "mock reference showing the pinned logo") and must not turn
  // non-generative briefs into fail-closed logo blockers.
  const blob = `${brief.name} ${brief.filename}`;
  return /\b(logo|wordmark|mark|favicon|app.?icon|brand\s*mark|lockup)\b/i.test(
    blob,
  );
}

export interface GenerateImageResult {
  path: string;
  bytes: number;
  skipped?: boolean;
  reason?: string;
  format: "png" | "svg" | "webp" | "jpeg";
}

export interface DesignTool {
  id: string;
  generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult>;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Minimal brand SVG when image gen is unbound or fails. */
export function writeSvgFallback(opts: {
  outPath: string;
  prompt: string;
  brandName?: string;
  palette?: string[];
}): GenerateImageResult {
  const colors = opts.palette?.length
    ? opts.palette
    : ["#1a1a1a", "#f5f5f5", "#c45c26"];
  const bg = colors[0] ?? "#1a1a1a";
  const fg = colors[1] ?? "#f5f5f5";
  const accent = colors[2] ?? colors[0] ?? "#c45c26";
  const label = escapeXml(
    (opts.brandName ?? opts.prompt).trim().slice(0, 48) || "Brand",
  );
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img">
  <rect width="512" height="512" fill="${escapeXml(bg)}"/>
  <circle cx="256" cy="200" r="72" fill="${escapeXml(accent)}"/>
  <text x="256" y="360" text-anchor="middle" font-family="Georgia, serif" font-size="36" fill="${escapeXml(fg)}">${label}</text>
</svg>
`;
  const target = opts.outPath.replace(/\.(png|webp|jpe?g)$/i, ".svg");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, svg, "utf-8");
  return {
    path: target,
    bytes: Buffer.byteLength(svg, "utf-8"),
    skipped: true,
    reason: "svg_fallback",
    format: "svg",
  };
}

function decodeImagePayload(data: string): { bytes: Buffer; format: GenerateImageResult["format"] } {
  if (data.startsWith("data:")) {
    const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i.exec(data);
    if (m?.[2]) {
      const fmt = (m[1] ?? "png").toLowerCase();
      return {
        bytes: Buffer.from(m[2], "base64"),
        format: fmt === "jpg" || fmt === "jpeg" ? "jpeg" : (fmt as "png" | "webp"),
      };
    }
  }
  return { bytes: Buffer.from(data, "base64"), format: "png" };
}

export class OllamaImagesDesignTool implements DesignTool {
  id = "ollama-images";

  async generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
    const logoBlocked = (): GenerateImageResult => ({
      path: opts.outPath,
      bytes: 0,
      skipped: true,
      reason: "logo_requires_designImage",
      format: "png",
    });

    const fallback = () => {
      if (opts.logoFailClosed) return logoBlocked();
      return writeSvgFallback({
        outPath: opts.outPath,
        prompt: opts.prompt,
        brandName: opts.brandName,
        palette: opts.palette,
      });
    };

    if (!opts.endpoint) {
      return fallback();
    }

    const endpoint = resolveEndpointSecrets(opts.endpoint, opts.providers);
    if (!endpointSupportsImageGen(endpoint)) {
      return {
        ...fallback(),
        reason: opts.logoFailClosed
          ? "logo_requires_designImage"
          : "endpoint_lacks_imageGen",
      };
    }

    const modelId = opts.modelId ?? endpoint.modelId;
    const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/images/generations`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(endpoint.headers ?? {}),
    };
    const apiKey = endpoint.apiKey?.trim();
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: modelId,
          prompt: opts.prompt,
          n: 1,
          size: `${opts.width ?? 512}x${opts.height ?? 512}`,
          response_format: "b64_json",
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return {
          ...fallback(),
          reason: opts.logoFailClosed
            ? "logo_requires_designImage"
            : `image_gen_http_${res.status}:${body.slice(0, 120)}`,
        };
      }

      const json = (await res.json()) as {
        data?: Array<{ b64_json?: string; url?: string }>;
      };
      const first = json.data?.[0];
      const payload = first?.b64_json ?? first?.url;
      if (!payload) {
        return {
          ...fallback(),
          reason: opts.logoFailClosed
            ? "logo_requires_designImage"
            : "image_gen_empty_response",
        };
      }

      // Remote URL without b64 — fall back to SVG (avoid downloading arbitrary hosts blindly).
      if (payload.startsWith("http")) {
        return {
          ...fallback(),
          reason: opts.logoFailClosed
            ? "logo_requires_designImage"
            : "image_gen_url_only",
        };
      }

      const decoded = decodeImagePayload(payload);
      mkdirSync(dirname(opts.outPath), { recursive: true });
      writeFileSync(opts.outPath, decoded.bytes);
      return {
        path: opts.outPath,
        bytes: decoded.bytes.length,
        format: decoded.format,
      };
    } catch (error) {
      return {
        ...fallback(),
        reason: opts.logoFailClosed
          ? "logo_requires_designImage"
          : `image_gen_error:${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
