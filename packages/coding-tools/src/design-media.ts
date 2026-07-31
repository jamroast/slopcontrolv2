import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { LlmEndpoint } from "@slopcontrol/types";
import { getDesignTool } from "./registry.js";
import type { GenerateImageResult } from "./design-tool.js";

const SLOP = ".slopcontrol";
const OPENVERSE_BASE = "https://api.openverse.org/v1";
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const USER_AGENT = "SlopControl/0.1 (design-loop; +https://github.com/local/slopcontrol)";

export type DesignMediaPaths = {
  absolutePath: string;
  relativePath: string;
};

export function safeAssetBasename(name: string, fallbackExt = "png"): string {
  const raw = (name || "asset").trim();
  const base = basename(raw).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const cleaned = base.slice(0, 80) || `asset-${randomUUID().slice(0, 8)}`;
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(cleaned)) return cleaned;
  return `${cleaned}.${fallbackExt.replace(/^\./, "")}`;
}

export function designLoopAssetsDir(
  projectRoot: string,
  loopId: string,
): string {
  return join(projectRoot, SLOP, "design-loops", loopId, "assets");
}

export function generatedImagesDir(projectRoot: string): string {
  return join(projectRoot, SLOP, "generated-images");
}

/** Resolve a writable asset path under .slopcontrol (rejects ..). */
export function resolveDesignAssetOutPath(opts: {
  projectRoot: string;
  loopId?: string;
  filename?: string;
  ext?: string;
}): DesignMediaPaths {
  const root = resolve(opts.projectRoot);
  const name = safeAssetBasename(
    opts.filename ?? `gen-${randomUUID().slice(0, 8)}`,
    opts.ext ?? "png",
  );
  const dir = opts.loopId?.trim()
    ? designLoopAssetsDir(root, opts.loopId.trim())
    : generatedImagesDir(root);
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  const relDir = resolve(dir);
  if (!absolutePath.startsWith(relDir + sep) && absolutePath !== relDir) {
    throw new Error("Invalid asset path");
  }
  return {
    absolutePath,
    relativePath: relative(root, absolutePath).replace(/\\/g, "/"),
  };
}

/** Path-safe resolve for serving local design assets. */
export function resolveServableDesignAsset(
  projectRoot: string,
  name: string,
): string | null {
  const root = resolve(projectRoot);
  const base = basename(name);
  if (!base || base !== name || base.includes("..")) return null;
  const candidates = [
    join(root, SLOP, "generated-images", base),
    ...listLoopAssetMatches(root, base),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function listLoopAssetMatches(projectRoot: string, base: string): string[] {
  const loopsRoot = join(projectRoot, SLOP, "design-loops");
  if (!existsSync(loopsRoot)) return [];
  const out: string[] = [];
  for (const loopId of readdirSync(loopsRoot)) {
    if (loopId.startsWith(".")) continue;
    const p = join(loopsRoot, loopId, "assets", base);
    if (existsSync(p)) out.push(p);
  }
  return out;
}

export type GenerateDesignImageInput = {
  projectRoot: string;
  prompt: string;
  endpoint?: LlmEndpoint | null;
  modelId?: string;
  loopId?: string;
  filename?: string;
  width?: number;
  height?: number;
};

export type GenerateDesignImageOutput = GenerateImageResult & {
  relativePath: string;
};

/**
 * Operator/MCP/chat-invoked generation — hard-fails without a usable image endpoint
 * (no silent SVG fallback).
 */
export async function generateDesignImage(
  opts: GenerateDesignImageInput,
): Promise<GenerateDesignImageOutput> {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("prompt is required");
  if (!opts.endpoint) {
    throw new Error(
      "designImage unbound — bind roles.designImage to an openai-images endpoint (e.g. ollama x/flux2-klein)",
    );
  }

  const out = resolveDesignAssetOutPath({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    filename: opts.filename,
    ext: "png",
  });

  const tool = getDesignTool();
  const result = await tool.generateImage({
    prompt,
    outPath: out.absolutePath,
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    width: opts.width ?? 512,
    height: opts.height ?? 512,
    logoFailClosed: true,
  });

  if (result.skipped || result.reason) {
    throw new Error(
      result.reason === "logo_requires_designImage"
        ? "designImage unbound or image generation failed — bind roles.designImage (openai-images)"
        : `Image generation failed: ${result.reason ?? "unknown"}`,
    );
  }

  return {
    ...result,
    relativePath: relative(resolve(opts.projectRoot), result.path).replace(
      /\\/g,
      "/",
    ),
  };
}

export type OpenverseImageHit = {
  id: string;
  title: string;
  url: string;
  thumbnail: string;
  foreignLandingUrl: string;
  license: string;
  licenseUrl: string;
  creator: string;
  source: string;
  attribution: string;
};

export type SearchDesignImagesInput = {
  query: string;
  page?: number;
  pageSize?: number;
  source?: string;
  licenseType?: string;
  /** Injected fetch for tests */
  fetchImpl?: typeof fetch;
};

export async function searchDesignImages(
  opts: SearchDesignImagesInput,
): Promise<OpenverseImageHit[]> {
  const q = opts.query.trim();
  if (!q) throw new Error("query is required");
  const pageSize = Math.min(Math.max(opts.pageSize ?? 8, 1), 20);
  const page = Math.max(opts.page ?? 1, 1);
  const params = new URLSearchParams({
    q,
    page: String(page),
    page_size: String(pageSize),
    mature: "false",
  });
  if (opts.source?.trim()) params.set("source", opts.source.trim());
  if (opts.licenseType?.trim()) {
    params.set("license_type", opts.licenseType.trim());
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const token = await maybeOpenverseToken(opts.fetchImpl ?? fetch);
  if (token) headers.Authorization = `Bearer ${token}`;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${OPENVERSE_BASE}/images/?${params}`, {
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Openverse search failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const json = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
  };
  const results = Array.isArray(json.results) ? json.results : [];
  return results.map(normalizeOpenverseHit).filter((h) => Boolean(h.url));
}

function normalizeOpenverseHit(raw: Record<string, unknown>): OpenverseImageHit {
  const id = String(raw.id ?? "");
  const title = String(raw.title ?? "Untitled");
  const url = String(raw.url ?? "");
  const thumbnail = String(raw.thumbnail ?? url);
  const foreignLandingUrl = String(raw.foreign_landing_url ?? "");
  const license = String(raw.license ?? "");
  const licenseUrl = String(raw.license_url ?? "");
  const creator = String(raw.creator ?? "Unknown");
  const source = String(raw.source ?? "");
  const attribution =
    typeof raw.attribution === "string" && raw.attribution.trim()
      ? raw.attribution.trim()
      : `${title} by ${creator} — ${license}${licenseUrl ? ` (${licenseUrl})` : ""}`;
  return {
    id,
    title,
    url,
    thumbnail,
    foreignLandingUrl,
    license,
    licenseUrl,
    creator,
    source,
    attribution,
  };
}

let cachedOpenverseToken: { token: string; expiresAt: number } | null = null;

async function maybeOpenverseToken(
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const id = process.env.OPENVERSE_CLIENT_ID?.trim();
  const secret = process.env.OPENVERSE_CLIENT_SECRET?.trim();
  if (!id || !secret) return null;
  if (cachedOpenverseToken && cachedOpenverseToken.expiresAt > Date.now() + 60_000) {
    return cachedOpenverseToken.token;
  }
  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: "client_credentials",
  });
  const res = await fetchImpl(`${OPENVERSE_BASE}/auth_tokens/token/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) return null;
  cachedOpenverseToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

export type ImportDesignImageInput = {
  projectRoot: string;
  loopId: string;
  hit: OpenverseImageHit;
  filename?: string;
  fetchImpl?: typeof fetch;
};

export type ImportDesignImageOutput = {
  absolutePath: string;
  relativePath: string;
  attributionPath: string;
  hit: OpenverseImageHit;
};

/**
 * Download a search hit into loop assets. Only HTTPS URLs matching the hit's host.
 */
export async function importDesignImage(
  opts: ImportDesignImageInput,
): Promise<ImportDesignImageOutput> {
  const loopId = opts.loopId.trim();
  if (!loopId) throw new Error("loopId is required");
  const hit = opts.hit;
  if (!hit?.id || !hit.url) throw new Error("hit with id and url is required");

  let parsed: URL;
  try {
    parsed = new URL(hit.url);
  } catch {
    throw new Error("Invalid hit url");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("Only https image URLs can be imported");
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(hit.url, {
    headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*" },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Image download failed (${res.status})`);
  }
  const finalUrl = res.url || hit.url;
  let finalParsed: URL;
  try {
    finalParsed = new URL(finalUrl);
  } catch {
    throw new Error("Invalid redirect url");
  }
  if (finalParsed.protocol !== "https:") {
    throw new Error("Redirect left https — refusing download");
  }
  // Allow CDN host change but reject clearly malicious schemes (already https).
  const lenHeader = Number(res.headers.get("content-length") ?? 0);
  if (lenHeader > MAX_IMPORT_BYTES) {
    throw new Error(`Image too large (>${MAX_IMPORT_BYTES} bytes)`);
  }

  const extFromUrl =
    finalParsed.pathname.match(/\.(png|jpe?g|webp|gif)$/i)?.[1] ?? "jpg";
  const out = resolveDesignAssetOutPath({
    projectRoot: opts.projectRoot,
    loopId,
    filename: opts.filename ?? `openverse-${hit.id}`,
    ext: extFromUrl,
  });

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMPORT_BYTES) {
    throw new Error(`Image too large (>${MAX_IMPORT_BYTES} bytes)`);
  }
  mkdirSync(dirname(out.absolutePath), { recursive: true });
  writeFileSync(out.absolutePath, buf);

  const attributionPath = `${out.absolutePath}.attribution.json`;
  writeFileSync(
    attributionPath,
    `${JSON.stringify(
      {
        ...hit,
        importedAt: new Date().toISOString(),
        localPath: out.relativePath,
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );

  return {
    absolutePath: out.absolutePath,
    relativePath: out.relativePath,
    attributionPath,
    hit,
  };
}

/** Fetch Openverse detail by id then import. */
export async function importDesignImageById(opts: {
  projectRoot: string;
  loopId: string;
  openverseId: string;
  filename?: string;
  fetchImpl?: typeof fetch;
}): Promise<ImportDesignImageOutput> {
  const id = opts.openverseId.trim();
  if (!id) throw new Error("openverseId is required");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
  const token = await maybeOpenverseToken(fetchImpl);
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(`${OPENVERSE_BASE}/images/${encodeURIComponent(id)}/`, {
    headers,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Openverse detail failed (${res.status}): ${body.slice(0, 200)}`,
    );
  }
  const raw = (await res.json()) as Record<string, unknown>;
  const hit = normalizeOpenverseHit(raw);
  return importDesignImage({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    hit,
    filename: opts.filename,
    fetchImpl,
  });
}

export function listLoopRasterAssets(
  projectRoot: string,
  loopId: string,
  limit = 2,
): string[] {
  const dir = designLoopAssetsDir(projectRoot, loopId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n))
    .map((n) => join(dir, n))
    .slice(0, limit);
}

export function copyLoopAssetsToPhaseDesign(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): string[] {
  const src = designLoopAssetsDir(opts.projectRoot, opts.loopId);
  if (!existsSync(src)) return [];
  const dest = join(
    opts.projectRoot,
    SLOP,
    "phases",
    opts.phaseId,
    "design",
    "assets",
  );
  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(src)) {
    if (name.startsWith(".")) continue;
    const from = join(src, name);
    const to = join(dest, name);
    writeFileSync(to, readFileSync(from));
    copied.push(to);
  }
  return copied;
}

/** Test helper to clear cached Openverse token. */
export function clearOpenverseTokenCache(): void {
  cachedOpenverseToken = null;
}
