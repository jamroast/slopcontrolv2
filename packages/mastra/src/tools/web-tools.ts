/**
 * Internet helpers for Mastra research/planning agents.
 * Ollama Cloud + Exa for search; fetch_url for direct HTTPS doc pages.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const FETCH_URL_MAX_BYTES = 100_000;
export const FETCH_URL_TIMEOUT_MS = 15_000;

export function getExaApiKey(): string | undefined {
  const key =
    process.env.SLOPCONTROL_EXA_API_KEY?.trim() ||
    process.env.EXA_API_KEY?.trim();
  return key || undefined;
}

/** True for loopback, link-local, RFC1918, CGNAT, metadata IPs. */
export function isBlockedIp(hostnameOrIp: string): boolean {
  const h = hostnameOrIp.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h === "0.0.0.0" ||
    h === "::" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local")
  ) {
    return true;
  }

  // IPv4
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }

  // IPv6 loopback / ULA / link-local
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) {
    return true;
  }
  return false;
}

export type FetchUrlValidation =
  | { ok: true; url: URL }
  | { ok: false; error: string };

export function validateFetchUrl(raw: string): FetchUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: `Invalid URL: ${raw}` };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      error: "Only https:// URLs are allowed (http and other schemes blocked)",
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: "URLs with embedded credentials are blocked" };
  }
  if (isBlockedIp(url.hostname)) {
    return {
      ok: false,
      error: `Blocked host (SSRF): ${url.hostname}`,
    };
  }
  return { ok: true, url };
}

function stripHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export type FetchUrlResult = {
  ok: boolean;
  url: string;
  status?: number;
  contentType?: string;
  text?: string;
  truncated?: boolean;
  error?: string;
};

export async function fetchUrlContent(
  rawUrl: string,
  opts?: { fetchImpl?: typeof fetch },
): Promise<FetchUrlResult> {
  const validated = validateFetchUrl(rawUrl);
  if (!validated.ok) {
    return { ok: false, url: rawUrl, error: validated.error };
  }
  const { url } = validated;
  const fetchImpl = opts?.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
      headers: {
        Accept: "text/html,text/plain,application/json,text/markdown,*/*",
        "User-Agent": "SlopControl/0.1 (research fetch_url)",
      },
    });

    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      return {
        ok: false,
        url: url.toString(),
        status: res.status,
        contentType,
        error: `HTTP ${res.status}`,
      };
    }

    // Re-validate final URL after redirects (undici sets res.url; mocks may omit it)
    const finalUrl = res.url && res.url.length > 0 ? res.url : url.toString();
    let finalParsed: URL;
    try {
      finalParsed = new URL(finalUrl);
    } catch {
      return {
        ok: false,
        url: finalUrl,
        status: res.status,
        error: "Invalid final URL after fetch",
      };
    }
    if (isBlockedIp(finalParsed.hostname)) {
      return {
        ok: false,
        url: finalUrl,
        status: res.status,
        error: `Blocked redirect host (SSRF): ${finalParsed.hostname}`,
      };
    }
    if (finalParsed.protocol !== "https:") {
      return {
        ok: false,
        url: finalUrl,
        error: "Redirect landed on non-https URL",
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.includes(0)) {
      return {
        ok: false,
        url: finalUrl,
        status: res.status,
        contentType,
        error: "Binary response blocked",
      };
    }

    let text = buf.toString("utf-8");
    let truncated = false;
    if (buf.length > FETCH_URL_MAX_BYTES) {
      text = text.slice(0, FETCH_URL_MAX_BYTES);
      truncated = true;
    }

    if (/html/i.test(contentType) || /^\s*</.test(text)) {
      text = stripHtmlToText(text).slice(0, FETCH_URL_MAX_BYTES);
    }

    return {
      ok: true,
      url: finalUrl,
      status: res.status,
      contentType,
      text,
      truncated,
    };
  } catch (error) {
    return {
      ok: false,
      url: url.toString(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type WebSearchHit = {
  title: string;
  url: string;
  snippet: string;
};

export type WebSearchResult = {
  ok: boolean;
  query: string;
  results?: WebSearchHit[];
  error?: string;
  provider?: WebSearchProviderId;
};

export type WebSearchProviderId = "exa" | "ollama" | "disabled";

export function getOllamaApiKey(): string | undefined {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key || undefined;
}

/**
 * Search via Ollama Cloud web search API. Requires OLLAMA_API_KEY.
 */
export async function webSearchOllama(
  query: string,
  opts?: { numResults?: number; fetchImpl?: typeof fetch },
): Promise<WebSearchResult> {
  const key = getOllamaApiKey();
  if (!key) {
    return {
      ok: false,
      query,
      provider: "ollama",
      error:
        "web_search (ollama) requires OLLAMA_API_KEY. Set it in ~/.slopcontrol/.env or the monorepo root .env and restart.",
    };
  }

  const q = query.trim();
  if (!q) {
    return { ok: false, query, provider: "ollama", error: "Empty search query" };
  }

  const maxResults = Math.min(Math.max(opts?.numResults ?? 5, 1), 10);
  const fetchImpl = opts?.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl("https://ollama.com/api/web_search", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: q,
        max_results: maxResults,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        query: q,
        provider: "ollama",
        error: `Ollama web_search HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
      }>;
    };

    const results: WebSearchHit[] = (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: (r.content ?? "").slice(0, 500),
      }));

    return { ok: true, query: q, results, provider: "ollama" };
  } catch (error) {
    return {
      ok: false,
      query: q,
      provider: "ollama",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Search via Exa API. Requires EXA_API_KEY or SLOPCONTROL_EXA_API_KEY.
 */
export async function webSearchExa(
  query: string,
  opts?: { numResults?: number; fetchImpl?: typeof fetch },
): Promise<WebSearchResult> {
  const key = getExaApiKey();
  if (!key) {
    return {
      ok: false,
      query,
      provider: "exa",
      error:
        "web_search (exa) requires EXA_API_KEY (or SLOPCONTROL_EXA_API_KEY). Set it in the SlopControl server environment and restart. See README “Internet research”.",
    };
  }

  const q = query.trim();
  if (!q) {
    return { ok: false, query, error: "Empty search query" };
  }

  const numResults = Math.min(Math.max(opts?.numResults ?? 5, 1), 10);
  const fetchImpl = opts?.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl("https://api.exa.ai/search", {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
      },
      body: JSON.stringify({
        query: q,
        type: "auto",
        numResults,
        contents: {
          text: { maxCharacters: 500 },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        query: q,
        error: `Exa HTTP ${res.status}: ${body.slice(0, 300)}`,
      };
    }

    const data = (await res.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        highlights?: string[];
      }>;
    };

    const results: WebSearchHit[] = (data.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        snippet: (r.text ?? r.highlights?.join(" ") ?? "").slice(0, 500),
      }));

    return { ok: true, query: q, results, provider: "exa" };
  } catch (error) {
    return {
      ok: false,
      query: q,
      provider: "exa",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export type WebSearchConfig = {
  provider?: "auto" | WebSearchProviderId;
  fallback?: WebSearchProviderId[];
};

const DEFAULT_WEB_SEARCH_FALLBACK: WebSearchProviderId[] = ["ollama", "exa"];

function defaultWebSearchConfigPath(): string {
  const dataDir =
    process.env.SLOPCONTROL_DATA_DIR?.trim() ||
    join(homedir(), ".slopcontrol");
  return join(dataDir, "web-search.json");
}

export function loadWebSearchConfig(configPath?: string): WebSearchConfig {
  const path = configPath ?? defaultWebSearchConfigPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as WebSearchConfig;
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export function resolveWebSearchProviderOrder(
  config?: WebSearchConfig,
): WebSearchProviderId[] {
  const cfg = config ?? loadWebSearchConfig();
  if (cfg.provider === "disabled") return [];
  if (cfg.provider === "exa" || cfg.provider === "ollama") {
    return [cfg.provider];
  }
  const fallback =
    cfg.fallback?.filter(
      (p): p is WebSearchProviderId => p === "exa" || p === "ollama",
    ) ?? DEFAULT_WEB_SEARCH_FALLBACK;
  return fallback.length > 0 ? fallback : DEFAULT_WEB_SEARCH_FALLBACK;
}

function providerConfigured(provider: WebSearchProviderId): boolean {
  if (provider === "exa") return Boolean(getExaApiKey());
  if (provider === "ollama") return Boolean(getOllamaApiKey());
  return false;
}

export type WebSearchStatus = {
  configured: WebSearchProviderId[];
  order: WebSearchProviderId[];
  exaKey: boolean;
  ollamaKey: boolean;
  configPath: string;
};

export function getWebSearchStatus(configPath?: string): WebSearchStatus {
  const path = configPath ?? defaultWebSearchConfigPath();
  const config = loadWebSearchConfig(path);
  const order = resolveWebSearchProviderOrder(config);
  const configured = order.filter((p) => providerConfigured(p));
  return {
    configured,
    order,
    exaKey: Boolean(getExaApiKey()),
    ollamaKey: Boolean(getOllamaApiKey()),
    configPath: path,
  };
}

/**
 * Search the public web using the configured provider order (default: ollama → exa).
 */
export async function webSearch(
  query: string,
  opts?: {
    numResults?: number;
    fetchImpl?: typeof fetch;
    config?: WebSearchConfig;
  },
): Promise<WebSearchResult> {
  const q = query.trim();
  if (!q) {
    return { ok: false, query, error: "Empty search query" };
  }

  const order = resolveWebSearchProviderOrder(opts?.config);
  if (order.length === 0) {
    return {
      ok: false,
      query: q,
      provider: "disabled",
      error: "web_search is disabled in ~/.slopcontrol/web-search.json",
    };
  }

  const errors: string[] = [];
  for (const provider of order) {
    const result =
      provider === "ollama"
        ? await webSearchOllama(q, opts)
        : await webSearchExa(q, opts);
    if (result.ok) return result;
    if (result.error) errors.push(`${provider}: ${result.error}`);
  }

  return {
    ok: false,
    query: q,
    error: errors.join(" | ") || "No web search provider available",
  };
}
