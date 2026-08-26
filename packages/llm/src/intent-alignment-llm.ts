import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import { chatJson } from "./json-chat.js";

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

export const IntentAlignmentVerdictSchema = z.object({
  /** true = the PHASE doc satisfies the intent's uiMount + interaction contract. */
  aligned: z.boolean(),
  /** Specific misalignments (empty when aligned). */
  gaps: z.array(z.string()),
  /** Concrete Success Criteria / Automated Check lines to add, parallel to gaps. */
  suggestedLines: z.array(z.string()),
});

export type IntentAlignmentVerdict = z.infer<
  typeof IntentAlignmentVerdictSchema
>;

export const INTENT_ALIGNMENT_SYSTEM_PROMPT = `You are SlopControl's Change Intent alignment judge. You decide whether a PHASE.md draft satisfies the phase's Change Intent (uiMount + interaction contract). Respond with ONLY a single JSON object.

First, extract the relevant evidence from the PHASE doc excerpt — the concrete proof lines (grep/playwright/vitest commands), mount decisions (composer vs bubble vs page), and tool-part name-resolution proofs — then judge the whole doc against the intent.

The Change Intent is authoritative. The PHASE.md must prove it satisfies the intent's uiMount and interaction contract. Judge the SEMANTICS of the PHASE text, not any fixed keyword list.

Check ALL of the following and report every gap:
1. Mount conflict: PHASE Blueprint Deltas / Scope must not lock forms into the OPPOSITE mount from the intent (composer vs bubble vs page).
2. Actionable mount: the PHASE must prove an actionable fillable mount, not chip/taxonomy-only work (summary chips, transcript classification, getFormPartState, superseded-chip fixes).
3. Fill/submit proof: when the interaction primaryAction is "submit form", Success Criteria / Automated Checks must prove fill+submit at the locked mount. A bubble-mount FormBubble / sendFormAnswer / composerMode proof counts even though it uses different words than composer-form / data-testid=composer-form.
4. Live tool-part proof: for chat mounts (composer/bubble), the PHASE must prove live AI SDK static tool-part name resolution (type: "tool-<name>" / parseToolResult / extractActiveForm) — not only tool-invocation + toolName fixtures.
5. Click/navigate proof: when primaryAction is click/navigate, prove click / onClick / href / router.push instead of fill+submit.

Verdict rules:
- aligned=true only when the PHASE proves the intent's mount + interaction (in any vocabulary). When in doubt, prefer aligned=false (fail closed): a false rejection re-flags a phase that was correctly blocked; a false approval ships a misaligned phase.
- gaps: one string per misalignment, naming the intent requirement and what is missing.
- suggestedLines: one concrete Success Criteria / Automated Check line per gap that the phase could add to fix it.`;

export interface JudgeIntentAlignmentOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** formatChangeIntentPromptBlock(intent) — the authoritative intent. */
  intentBlock: string;
  /** Scope / Success Criteria / Automated Checks / Blueprint Deltas excerpt. */
  phaseDocExcerpt: string;
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
  });
}

export async function judgeIntentAlignmentViaLlm(
  opts: JudgeIntentAlignmentOptions,
): Promise<IntentAlignmentVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs,
    system: INTENT_ALIGNMENT_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      "PHASE doc excerpt (Scope / Success Criteria / Automated Checks / Blueprint Deltas):",
      clip(opts.phaseDocExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseIntentAlignmentVerdictPayload(parsed);
}
