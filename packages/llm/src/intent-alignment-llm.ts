import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

/**
 * LLM judge for Change Intent ↔ PHASE.md alignment. This is the SOLE
 * authority for semantic alignment — there is no regex pre-filter. The judge
 * reads the full PHASE doc excerpt + the authoritative Change Intent and
 * returns a holistic verdict: is the doc aligned, and if not, what are the
 * specific gaps and concrete fixes.
 *
 * Structural checks (section presence, format) live separately in
 * validatePhaseDocForDev and stay deterministic; this judge owns only the
 * semantic question of whether the doc proves the intent's uiMount +
 * interaction contract.
 */

export const PlanningFaultLegSchema = z.enum([
  "none",
  "research",
  "draft",
  "both",
]);

export type PlanningFaultLeg = z.infer<typeof PlanningFaultLegSchema>;

export const IntentAlignmentVerdictSchema = z.object({
  /** true = the PHASE doc satisfies the intent's uiMount + interaction contract. */
  aligned: z.boolean(),
  /** Specific misalignments (empty when aligned). */
  gaps: z.array(z.string()),
  /** Concrete Success Criteria / Automated Check lines to add, parallel to gaps. */
  suggestedLines: z.array(z.string()),
  /**
   * Which planning leg should re-run to fix misalignment (when aligned=false).
   * research = RESEARCH.md lacks facts/checks; draft = PHASE failed to translate
   * adequate research; both = both legs need work.
   */
  faultLeg: PlanningFaultLegSchema.optional(),
});

export type IntentAlignmentVerdict = z.infer<
  typeof IntentAlignmentVerdictSchema
>;

export const INTENT_ALIGNMENT_SYSTEM_PROMPT = `You are SlopControl's Change Intent alignment judge. You decide whether a PHASE.md draft satisfies the phase's Change Intent (uiMount + interaction contract). Respond with ONLY a single JSON object.

First, extract the relevant evidence from the PHASE doc excerpt — the concrete proof lines (grep/playwright/vitest commands), mount decisions (composer vs bubble vs page), and tool-part name-resolution proofs — then judge the whole doc against the intent.

The Change Intent is authoritative. The PHASE.md must prove it satisfies the intent's uiMount and interaction contract. Judge the SEMANTICS of the PHASE text, not any fixed keyword list.

When Change Intent has NO interaction block:
- Judge uiMount only (page route, href, concrete file paths, grep proofs).
- Do NOT require Playwright fill/submit, form engagement, or tool-part proofs.
- Auth wiring (POST token, localStorage writer) is NOT a chat-form engagement contract.
- When changeKind is specification: judge Scope/Success Criteria coverage only; doc/grep/structural checks are sufficient — do NOT require fill+submit or runtime engagement proofs for work deferred to later phases.

When Change Intent HAS an interaction block, check ALL of:
1. Mount conflict: PHASE Blueprint Deltas / Scope must not lock forms into the OPPOSITE mount from the intent (composer vs bubble vs page).
2. Actionable mount: the PHASE must prove an actionable fillable mount, not chip/taxonomy-only work (summary chips, transcript classification, getFormPartState, superseded-chip fixes).
3. Fill/submit proof: when primaryAction is "submit form", Success Criteria / Automated Checks must prove fill+submit at the locked mount.
4. Live tool-part proof: for chat mounts (composer/bubble), prove live AI SDK static tool-part name resolution — not only tool-invocation fixtures.
5. Click/navigate proof: when primaryAction is click/navigate, prove click / onClick / href / router.push instead of fill+submit.

Verdict rules:
- aligned=true only when the PHASE proves the intent's mount + interaction (in any vocabulary). When in doubt, prefer aligned=false (fail closed).
- gaps: one string per misalignment.
- suggestedLines: one concrete Success Criteria / Automated Check line per gap.
- faultLeg (required when aligned=false):
  - "research" when RESEARCH.md lacks the facts/paths/check proposals needed (compare RESEARCH excerpt when provided).
  - "draft" when RESEARCH already specifies the fix but PHASE omitted it.
  - "both" when both are insufficient.
  - "none" when aligned=true.`;

export interface JudgeIntentAlignmentOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** formatChangeIntentPromptBlock(intent) — the authoritative intent. */
  intentBlock: string;
  /** Scope / Success Criteria / Automated Checks / Blueprint Deltas excerpt. */
  phaseDocExcerpt: string;
  /** Optional — helps attribute faultLeg to research vs draft. */
  researchExcerpt?: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

/** Head+tail consolidation (safety net) — never drops the tail of the excerpt. */
function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

/** Coerce a possibly-messy LLM payload into the verdict schema (fail closed). */
export function parseIntentAlignmentVerdictPayload(
  parsed: unknown,
): IntentAlignmentVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const gaps = Array.isArray(asObj.gaps)
    ? asObj.gaps.filter((g): g is string => typeof g === "string" && g.trim() !== "")
    : [];
  const suggestedLines = Array.isArray(asObj.suggestedLines)
    ? asObj.suggestedLines.filter(
        (s): s is string => typeof s === "string" && s.trim() !== "",
      )
    : [];
  const alignedIsBool = typeof asObj.aligned === "boolean";
  const aligned = alignedIsBool ? asObj.aligned : false;
  const rawLeg = asObj.faultLeg;
  const faultLegParsed = PlanningFaultLegSchema.safeParse(rawLeg);
  const faultLeg = faultLegParsed.success ? faultLegParsed.data : undefined;
  return IntentAlignmentVerdictSchema.parse({
    aligned,
    gaps:
      gaps.length > 0
        ? gaps
        : alignedIsBool
          ? []
          : [
              "Change Intent alignment could not be verified (unreadable judge verdict)",
            ],
    suggestedLines,
    faultLeg: aligned
      ? "none"
      : faultLeg ?? (gaps.length > 0 ? "draft" : undefined),
  });
}

export async function judgeIntentAlignmentViaLlm(
  opts: JudgeIntentAlignmentOptions,
): Promise<IntentAlignmentVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    system: INTENT_ALIGNMENT_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      ...(opts.researchExcerpt?.trim()
        ? [
            "RESEARCH.md excerpt (for faultLeg attribution):",
            clip(opts.researchExcerpt, EXCERPT_TAIL_CHARS),
            "",
          ]
        : []),
      "PHASE doc excerpt (Scope / Success Criteria / Automated Checks / Blueprint Deltas):",
      clip(opts.phaseDocExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseIntentAlignmentVerdictPayload(parsed);
}
