import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import { chatJson } from "./json-chat.js";

/**
 * LLM judge for Change Intent ↔ PHASE.md alignment. The deterministic
 * `phaseDocAlignsWithChangeIntent` in @slopcontrol/artifacts is the mechanical
 * half (does the PHASE doc contain the mount/proof keywords the intent
 * demands); this judge arbitrates the semantic half — is a flagged gap real,
 * or does the PHASE doc prove the intent in a form the keyword lists missed?
 *
 * This is the fix for the composer-centric keyword vocabulary: a bubble-mount
 * form that correctly uses FormBubble / sendFormAnswer / composerMode is
 * semantically aligned even though the deterministic regex only knows
 * composer-form / data-testid=composer-form.
 */

export const IntentAlignmentVerdictSchema = z.object({
  /** true = the deterministic issue is a REAL gap and must block. */
  genuineGap: z.boolean(),
  reason: z.string(),
  /** Quote of the PHASE text that already proves alignment (when genuineGap=false). */
  existingProof: z.string().optional(),
  /** Concrete Success Criteria / Automated Check line to add (when genuineGap=true). */
  suggestedCheck: z.string().optional(),
});

export type IntentAlignmentVerdict = z.infer<
  typeof IntentAlignmentVerdictSchema
>;

export const INTENT_ALIGNMENT_SYSTEM_PROMPT = `You are SlopControl's Change Intent alignment judge. A deterministic validator compared a PHASE.md draft against the phase's Change Intent (uiMount + interaction contract) and flagged a possible misalignment. Decide whether the gap is GENUINE. Respond with ONLY a single JSON object.

First, extract the relevant evidence from the PHASE doc excerpt — the concrete proof lines (grep/playwright/vitest commands), mount decisions (composer vs bubble vs page), and tool-part name-resolution proofs — then judge the flagged gap against that evidence. Do not rely on the keyword list; the deterministic validator only knows a fixed vocabulary and can miss valid proofs.

The Change Intent is authoritative. The PHASE.md must prove it satisfies the intent's uiMount and interaction contract. Judge the SEMANTICS of the PHASE text, not the keyword list.

What counts as aligned (genuineGap=false):
- The PHASE proves the interaction at the locked mount in a DIFFERENT vocabulary than the validator's keywords. For a bubble mount, FormBubble / sendFormAnswer / composerMode / typed forms / confirm round-trip are valid fill+submit proofs even though the validator only knows composer-form / data-testid=composer-form.
- A fill/submit proof in any form: a Playwright/vitest render test, a Node one-shot, a grep for the mounted control + a submit action, an equivalent build/test command. Judge semantics, not keywords.
- A live AI SDK static tool-part name resolution proof in any form (type: "tool-<name>", parseToolResult, extractActiveForm, deriving the tool name from the type field) — not only tool-invocation + toolName fixtures.
- A click/navigate proof in any form (onClick, href, router.push, navigate, a click test).

What does NOT count as aligned (genuineGap=true — apply strictly):
- Chip/taxonomy-only work: summary chips, transcript classification, getFormPartState, superseded-chip fixes — these do NOT prove an actionable fillable mount.
- A mount conflict: PHASE Blueprint Deltas / Scope that lock forms into the OPPOSITE mount from the intent (composer vs bubble). The excerpt includes Scope and Blueprint Deltas — use them for mount-conflict issues.
- Prose/TODO/comments asserting the outcome without a runnable check.
- A proof placed only in File Changes / Known limitations, not in Success Criteria / Automated Checks.

Verdict rules:
- genuineGap=true when the PHASE does not (in any form) prove the intent's mount + interaction. Include suggestedCheck: one concrete Success Criteria / Automated Check line the phase could add.
- genuineGap=false when the PHASE already proves alignment — include existingProof quoting the exact PHASE text. When in doubt, prefer genuineGap=true (fail closed): a false rejection re-flags a phase that was correctly blocked; a false approval ships a misaligned phase.
- reason: one sentence naming the intent requirement, the proof found or missing, and why.`;

export interface JudgeIntentAlignmentOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** formatChangeIntentPromptBlock(intent) — the authoritative intent. */
  intentBlock: string;
  /** The deterministic issue string that was flagged. */
  issue: string;
  /** Success Criteria + Automated Checks excerpt (will be clipped). */
  phaseDocExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 16_000;

/** Head+tail consolidation (safety net) — never drops the tail of the excerpt. */
function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

/** Coerce a possibly-messy LLM payload into the verdict schema. */
export function parseIntentAlignmentVerdictPayload(
  parsed: unknown,
): IntentAlignmentVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  return IntentAlignmentVerdictSchema.parse({
    // Fail closed: an unreadable verdict keeps the deterministic issue.
    genuineGap: typeof asObj.genuineGap === "boolean" ? asObj.genuineGap : true,
    reason:
      typeof asObj.reason === "string" && asObj.reason.trim()
        ? asObj.reason.trim()
        : "LLM judge returned no reason — treating the deterministic gap as genuine.",
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
      "Deterministic issue flagged:",
      opts.issue,
      "",
      "PHASE doc excerpt (Scope / Success Criteria / Automated Checks / Blueprint Deltas):",
      clip(opts.phaseDocExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseIntentAlignmentVerdictPayload(parsed);
}
