import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const ImplementationHonorResultSchema = z.object({
  /** How faithfully the implementation carries the accepted mock's styling. */
  fidelity: z.enum(["high", "partial", "low"]),
  /** Mock class names / rules with no equivalent in the implementation. */
  missingStyles: z.array(z.string()).default([]),
  /** Mock custom properties referenced by implemented code but never defined. */
  missingTokens: z.array(z.string()).default([]),
  notes: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export type ImplementationHonorResult = z.infer<
  typeof ImplementationHonorResultSchema
>;

export const IMPLEMENTATION_HONOR_SYSTEM_PROMPT = `You judge whether an implemented UI carries through the styling of an ACCEPTED design mock.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

You are given:
1. The accepted mock's component CSS (styles.css per pinned element) + token ladders — the authoritative styling.
2. The implemented evidence: consumer component source excerpts + product CSS.

Return ONLY a JSON object with these fields:
- fidelity: "high" | "partial" | "low" — overall, how faithfully the implementation carries the mock's component styling.
- missingStyles: string[] — mock class names or rules with NO equivalent in the implementation (e.g. ".env-pane border-left accent"). Only entries you are confident are absent.
- missingTokens: string[] — CSS custom properties the mock defines and the implementation references but never defines, or drops outright.
- notes: string — 1–2 sentences for the operator.
- confidence: "low" | "medium" | "high"

Rules:
- fidelity=high when the mock's named classes/rules are present — ported verbatim, or via CSS modules / styled wrappers carrying the same declarations.
- Renamed classes are fine when the declarations clearly carry over (same properties and values); note the rename in notes, not in missingStyles.
- fidelity=low when mock-styled elements are replaced by generic utility-class soup (bg-muted, text-muted-foreground, border-border, rounded-md) that ignores the mock's component CSS — that is an approximation, not a port.
- Utility classes are acceptable ONLY for elements the mock styles with utilities too; never as a substitute for mock component CSS.
- Tailwind theme bridging (@theme / --color-* mapped onto mock tokens) counts as honoring tokens.
- When evidence is too thin to judge (empty excerpts), use fidelity=partial with confidence=low and say so in notes.
`;

export interface JudgeImplementationHonorOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** Element ids the styles belong to. */
  elementIds: string[];
  /** Accepted mock side: per-element component CSS + token ladders. */
  mockSnippets: string;
  /** Implementation side: component source + product CSS excerpts. */
  implementationSnippets: string;
  timeoutMs?: number;
}

/**
 * Post-implementation fidelity judge: accepted mock styles vs shipped code.
 * Callers should treat errors as "judge unavailable" and skip (fail open) —
 * deterministic Automated Checks remain the hard gate.
 */
export async function judgeImplementationHonorViaLlm(
  opts: JudgeImplementationHonorOptions,
): Promise<ImplementationHonorResult> {
  const user = [
    `Pinned element ids: ${opts.elementIds.join(", ") || "(none)"}`,
    "",
    "Accepted mock component CSS + tokens:",
    opts.mockSnippets.slice(0, 6_000),
    "",
    "Implemented evidence (component source + product CSS excerpts):",
    opts.implementationSnippets.slice(0, 6_000),
  ].join("\n");

  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: IMPLEMENTATION_HONOR_SYSTEM_PROMPT,
    user,
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};

  const stringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
      : [];

  return ImplementationHonorResultSchema.parse({
    fidelity:
      raw.fidelity === "high" ||
      raw.fidelity === "partial" ||
      raw.fidelity === "low"
        ? raw.fidelity
        : "partial",
    missingStyles: stringArray(raw.missingStyles),
    missingTokens: stringArray(raw.missingTokens),
    notes: typeof raw.notes === "string" ? raw.notes : "",
    confidence:
      raw.confidence === "low" ||
      raw.confidence === "medium" ||
      raw.confidence === "high"
        ? raw.confidence
        : "low",
  });
}
