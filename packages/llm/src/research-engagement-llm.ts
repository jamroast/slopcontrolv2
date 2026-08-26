import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import { chatJson } from "./json-chat.js";

/**
 * LLM judge for engagement RESEARCH overclaim. The deterministic
 * `researchEngagementQuality` in @slopcontrol/artifacts is the mechanical half
 * (does RESEARCH claim "~90% / already works" without naming residual risks);
 * this judge arbitrates the semantic half — is the overclaim real, or does the
 * research document residual engagement risks in a form the keyword list
 * missed?
 */

export const ResearchEngagementVerdictSchema = z.object({
  /** true = the overclaim is REAL (no residual risks documented) and must retry. */
  genuineGap: z.boolean(),
  reason: z.string(),
  /** Quote of the research text that already documents residual risks (when genuineGap=false). */
  existingProof: z.string().optional(),
  /** Concrete residual-risk line to add (when genuineGap=true). */
  suggestedCheck: z.string().optional(),
});

export type ResearchEngagementVerdict = z.infer<
  typeof ResearchEngagementVerdictSchema
>;

export const RESEARCH_ENGAGEMENT_SYSTEM_PROMPT = `You are SlopControl's engagement-research overclaim judge. A deterministic validator compared a RESEARCH.md against the phase's Change Intent (which has a fill/submit interaction contract) and flagged a possible overclaim: the research claims prior form work is "~90% / already works / already implements" WITHOUT documenting residual engagement risks. Decide whether the overclaim is GENUINE. Respond with ONLY a single JSON object.

First, extract the relevant evidence from the RESEARCH.md body — the overclaim statements ("~90%", "already works") and any residual-risk statements (blocking gaps, unverified hypotheses, open engagement questions) — then judge whether a residual risk is actually documented. Do not rely on the keyword list; the deterministic validator only knows a fixed vocabulary and can miss valid residual-risk documentation.

Judge the SEMANTICS of the research text, not the keyword list.

What counts as NOT overclaiming (genuineGap=false):
- The research documents residual engagement risks in a DIFFERENT vocabulary than the validator's keywords. Any concrete open risk counts: a live AI SDK static tool-part name resolution gap (type: "tool-<name>" without toolName, parseToolResult, extractActiveForm), a blocking gap, a "does not survive reload" note, an unverified hypothesis, a release-gate, an open engagement question.
- The research explicitly frames "prior phases complete" as a hypothesis, not proof.
- The research names a specific remaining gap even if it uses different words than "residual" / "blocking" / "hypothesis".

What DOES count as overclaiming (genuineGap=true — apply strictly):
- "~90% already works" / "already exists" / "already implements N%" with NO residual risk, no open gap, no unverified hypothesis.
- "Prior phases are complete ⇒ proven" with no caveat.
- Prose asserting the outcome works without any named remaining risk.

Verdict rules:
- genuineGap=true when the research overclaims without any residual risk. Include suggestedCheck: one concrete residual-risk line the research could add.
- genuineGap=false when the research already documents a residual risk — include existingProof quoting the exact research text. When in doubt, prefer genuineGap=true (fail closed): a false rejection re-flags research that was correctly flagged; a false approval ships an overclaiming research doc.
- reason: one sentence naming the overclaim, the residual risk found or missing, and why.`;

export interface JudgeResearchEngagementOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** formatChangeIntentPromptBlock(intent) — the authoritative intent. */
  intentBlock: string;
  /** The deterministic issue string that was flagged. */
  issue: string;
  /** The RESEARCH.md body (will be clipped). */
  researchExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

/** Head+tail consolidation (safety net) — never drops the tail (Risks section). */
function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

/** Coerce a possibly-messy LLM payload into the verdict schema. */
export function parseResearchEngagementVerdictPayload(
  parsed: unknown,
): ResearchEngagementVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  return ResearchEngagementVerdictSchema.parse({
    // Fail closed: an unreadable verdict keeps the deterministic issue.
    genuineGap: typeof asObj.genuineGap === "boolean" ? asObj.genuineGap : true,
    reason:
      typeof asObj.reason === "string" && asObj.reason.trim()
        ? asObj.reason.trim()
        : "LLM judge returned no reason — treating the deterministic overclaim as genuine.",
    existingProof:
      typeof asObj.existingProof === "string" && asObj.existingProof.trim()
        ? asObj.existingProof.trim()
        : undefined,
    suggestedCheck:
      typeof asObj.suggestedCheck === "string" && asObj.suggestedCheck.trim()
        ? asObj.suggestedCheck.trim()
        : undefined,
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
      "Deterministic issue flagged:",
      opts.issue,
      "",
      "RESEARCH.md body:",
      clip(opts.researchExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseResearchEngagementVerdictPayload(parsed);
}
