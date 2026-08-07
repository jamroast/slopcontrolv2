import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";
import { resolveEndpointSecrets } from "./secrets.js";

export const ElementHonorResultSchema = z.object({
  honorsPinnedElements: z.boolean(),
  /** True only if a second independent theme control exists (not BEM children). */
  competingThemeControl: z.boolean(),
  missingMenubar: z.boolean(),
  missingThemeToggle: z.boolean(),
  notes: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export type ElementHonorResult = z.infer<typeof ElementHonorResultSchema>;

export const ELEMENT_HONOR_SYSTEM_PROMPT = `You judge whether a design mock HTML honors pinned SHARED ELEMENTS.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY a JSON object with these fields:
- honorsPinnedElements: boolean — overall, does the mock reuse the pinned controls correctly?
- competingThemeControl: boolean — true ONLY if a second independent theme-toggle control exists outside / in addition to the pinned one. BEM children (theme-toggle__sun, theme-toggle__moon, SVG icons inside one button) are NOT competing.
- missingMenubar: boolean — pinned menubar id but mock has no menubar-like header
- missingThemeToggle: boolean — pinned theme-toggle but mock has no theme toggle control
- notes: string — 1–2 sentences for operator NOTES.md
- confidence: "low" | "medium" | "high"

Rules:
- A pinned menubar may contain the theme-toggle; that is correct.
- One button.theme-toggle with svg.theme-toggle__sun and svg.theme-toggle__moon = ONE control, not three.
- Substring "theme-toggle" in class names of children does not mean competing controls.
- Prefer honorsPinnedElements=true when apply already merged shared chrome and only BEM/icon markup differs.
- competingThemeControl=true only when you see a distinct second control that also toggles theme (e.g. another button with day/night or a second .theme-toggle outside the menubar).
`;

export interface ClassifyElementHonorViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  pinnedElementIds: string[];
  /** Short HTML snippets (header / toggle regions), not full documents. */
  mockSnippets: string;
  operatorHints?: string;
  /** Optional 0–1 cosine similarity of pinned menubar vs mock header. */
  menubarSimilarity?: number;
  timeoutMs?: number;
}

/**
 * Classification-role JSON → ElementHonorResult.
 * On parse failure callers should catch and skip hard reject (rely on apply).
 */
export async function classifyElementHonorViaLlm(
  opts: ClassifyElementHonorViaLlmOptions,
): Promise<ElementHonorResult> {
  const userParts = [
    `Pinned element ids: ${opts.pinnedElementIds.join(", ") || "(none)"}`,
    "",
    "Mock snippets:",
    opts.mockSnippets.slice(0, 6_000),
  ];
  if (opts.operatorHints?.trim()) {
    userParts.push("", "Operator / continue hints:", opts.operatorHints.trim().slice(0, 1_000));
  }
  if (
    typeof opts.menubarSimilarity === "number" &&
    Number.isFinite(opts.menubarSimilarity)
  ) {
    userParts.push(
      "",
      `Optional embed signal menubarSimilarity (0–1, higher=more similar): ${opts.menubarSimilarity.toFixed(3)}`,
      "Use as a weak signal only; do not treat alone as competing or missing.",
    );
  }

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: ELEMENT_HONOR_SYSTEM_PROMPT,
    user: userParts.join("\n"),
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};

  return ElementHonorResultSchema.parse({
    honorsPinnedElements: Boolean(raw.honorsPinnedElements),
    competingThemeControl: Boolean(raw.competingThemeControl),
    missingMenubar: Boolean(raw.missingMenubar),
    missingThemeToggle: Boolean(raw.missingThemeToggle),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    confidence:
      raw.confidence === "low" ||
      raw.confidence === "medium" ||
      raw.confidence === "high"
        ? raw.confidence
        : "low",
  });
}

/** Build short snippets for the honor judge from full mock HTML. */
export function buildElementHonorSnippets(html: string): string {
  const parts: string[] = [];
  const headerMatch = html.match(
    /<header\b[^>]*>[\s\S]{0,4000}?<\/header>/i,
  );
  if (headerMatch?.[0]) {
    parts.push("### header", headerMatch[0].slice(0, 3_500));
  }
  const toggleMatch = html.match(
    /<(?:button|div|label)\b[^>]*class=["'][^"']*\btheme-toggle\b[^"']*["'][^>]*>[\s\S]{0,1500}?<\/(?:button|div|label)>/i,
  );
  if (toggleMatch?.[0]) {
    parts.push("### theme-toggle", toggleMatch[0].slice(0, 1_500));
  }
  if (!parts.length) {
    parts.push(html.slice(0, 2_500));
  }
  return parts.join("\n\n");
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Optional OpenAI-compatible embeddings similarity. Returns undefined when the
 * endpoint has no embeddings API or the request fails — never throws to callers
 * that ignore the result.
 */
export async function tryMenubarEmbedSimilarity(opts: {
  endpoint: LlmEndpoint;
  modelId?: string;
  pinnedMenubarHtml: string;
  mockHeaderHtml: string;
  timeoutMs?: number;
}): Promise<number | undefined> {
  const a = opts.pinnedMenubarHtml.trim();
  const b = opts.mockHeaderHtml.trim();
  if (!a || !b) return undefined;

  const endpoint = resolveEndpointSecrets(opts.endpoint);
  const modelId = opts.modelId ?? endpoint.modelId;
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/embeddings`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? 30_000,
  );
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(endpoint.apiKey
          ? { authorization: `Bearer ${endpoint.apiKey}` }
          : {}),
        ...(endpoint.headers ?? {}),
      },
      body: JSON.stringify({
        model: modelId,
        input: [a.slice(0, 4_000), b.slice(0, 4_000)],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return undefined;
    const json = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const rows = [...(json.data ?? [])].sort(
      (x, y) => (x.index ?? 0) - (y.index ?? 0),
    );
    const e0 = rows[0]?.embedding;
    const e1 = rows[1]?.embedding;
    if (!e0?.length || !e1?.length) return undefined;
    return cosineSimilarity(e0, e1);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
