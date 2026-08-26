import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import { chatJson } from "./json-chat.js";

/**
 * LLM judge for engagement RESEARCH overclaim. This is the SOLE authority for
 * the overclaim question — there is no regex pre-filter. The judge reads the
 * full RESEARCH.md + the authoritative Change Intent and returns a holistic
 * verdict: does the research overclaim prior form work without documenting
 * residual engagement risks?
 */

export const ResearchEngagementVerdictSchema = z.object({
  /** true = the research overclaims without residual risks and must retry. */
  overclaims: z.boolean(),
  /** Description of the overclaim (empty when overclaims=false). */
  gaps: z.array(z.string()),
  /** Concrete residual-risk lines to add, parallel to gaps. */
  suggestedLines: z.array(z.string()),
});

export type ResearchEngagementVerdict = z.infer<
  typeof ResearchEngagementVerdictSchema
>;

export const RESEARCH_ENGAGEMENT_SYSTEM_PROMPT = `You are SlopControl's engagement-research overclaim judge. You decide whether a RESEARCH.md overclaims prior form work as "~90% / already works / already implements" WITHOUT documenting residual engagement risks, for a phase whose Change Intent has a fill/submit interaction contract. Respond with ONLY a single JSON object.

First, extract the relevant evidence from the RESEARCH.md body — the overclaim statements ("~90%", "already works") and any residual-risk statements (blocking gaps, unverified hypotheses, open engagement questions) — then judge whether a residual risk is actually documented. Judge the SEMANTICS of the research text, not any fixed keyword list.

What counts as NOT overclaiming (overclaims=false):
- The research documents residual engagement risks in any vocabulary. Any concrete open risk counts: a live AI SDK static tool-part name resolution gap (type: "tool-<name>" without toolName, parseToolResult, extractActiveForm), a blocking gap, a "does not survive reload" note, an unverified hypothesis, a release-gate, an open engagement question.
- The research explicitly frames "prior phases complete" as a hypothesis, not proof.
- The research names a specific remaining gap even if it uses different words than "residual" / "blocking" / "hypothesis".

What DOES count as overclaiming (overclaims=true — apply strictly):
- "~90% already works" / "already exists" / "already implements N%" with NO residual risk, no open gap, no unverified hypothesis.
- "Prior phases are complete ⇒ proven" with no caveat.
- Prose asserting the outcome works without any named remaining risk.

Verdict rules:
- overclaims=true when the research overclaims without any residual risk. Include suggestedLines: one concrete residual-risk line the research could add.
- overclaims=false when the research already documents a residual risk. When in doubt, prefer overclaims=true (fail closed): a false rejection re-flags research that was correctly flagged; a false approval ships an overclaiming research doc.
- gaps: one string per overclaim, naming what is claimed and what residual risk is missing.`;

export interface JudgeResearchEngagementOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** formatChangeIntentPromptBlock(intent) — the authoritative intent. */
  intentBlock: string;
  /** The RESEARCH.md body (will be clipped). */
  researchExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

/** Head+tail consolidation (safety net) — never drops the tail (Risks section). */
function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

/** Coerce a possibly-messy LLM payload into the verdict schema (fail closed). */
export function parseResearchEngagementVerdictPayload(
  parsed: unknown,
): ResearchEngagementVerdict {
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
  const overclaimsIsBool = typeof asObj.overclaims === "boolean";
  const overclaims = overclaimsIsBool ? asObj.overclaims : true;
  return ResearchEngagementVerdictSchema.parse({
    overclaims,
    gaps:
      gaps.length > 0
        ? gaps
        : overclaimsIsBool
          ? []
          : [
              "Engagement research overclaim could not be verified (unreadable judge verdict)",
            ],
    suggestedLines,
  });
}

export async function judgeResearchEngagementViaLlm(
  opts: JudgeResearchEngagementOptions,
): Promise<ResearchEngagementVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs,
    system: RESEARCH_ENGAGEMENT_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      "RESEARCH.md body:",
      clip(opts.researchExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseResearchEngagementVerdictPayload(parsed);
}
