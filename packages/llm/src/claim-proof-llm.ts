import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
} from "./json-chat.js";

/**
 * LLM judge for claim-vs-proof gaps. The deterministic validators in
 * @slopcontrol/artifacts claim-vs-proof.ts are the mechanical half (does a
 * grep/@source/mount proof exist); this judge arbitrates the semantic half —
 * is a flagged gap real, or does the phase doc prove the claim in a form the
 * keyword lists missed?
 */

export const ClaimProofVerdictSchema = z.object({
  /** true = the deterministic issue is a REAL gap and must block. */
  genuineGap: z.boolean(),
  reason: z.string(),
  /** Quote of the check text that already proves the claim (when genuineGap=false). */
  existingProof: z.string().optional(),
  /** Concrete check command/line to add (when genuineGap=true). */
  suggestedCheck: z.string().optional(),
});

export type ClaimProofVerdict = z.infer<typeof ClaimProofVerdictSchema>;

export const CLAIM_PROOF_SYSTEM_PROMPT = `You are SlopControl's claim-vs-proof judge. A deterministic validator compared a PHASE doc's claims (Scope / Success Criteria / design acceptance) against its Automated Checks and flagged a possible gap: a runtime outcome is claimed, but no finite proof was detected. Decide whether the gap is GENUINE. Respond with ONLY a single JSON object.

What counts as proof:
- A FINITE Automated Check (one-shot command, build, test, grep, node script) that demonstrates the claimed runtime outcome.
- A proof in a DIFFERENT FORM than the validator's keyword list still counts: a vitest/jest render test, a Node one-shot, a Playwright/screenshot check, an equivalent build command — judge the semantics, not the keywords.
- grep that config/source text exists is proof ONLY for textual claims, not for runtime outcomes.

What does NOT count as proof (hard-won rules — apply strictly):
- Export-only: greps for \`export function ThemeToggle\` (or similar) prove the symbol exists, NOT that it is mounted/used. Insufficient for mount claims.
- Import-order-only: proving \`@import "tailwindcss"\` is the first line proves import order, NOT that utilities are emitted into built CSS. Insufficient for style-visibility claims.
- Mounted ≠ visible: a mount grep does not prove styles resolve (utilities emitted / non-utility color+size fallback).
- Long-lived dev servers (\`pnpm dev\`, \`vite\`, \`next dev\`) are never finite proofs, even when the claim would hold.
- Comments, TODOs, or prose in the check block asserting the outcome is not a check.

Verdict rules:
- genuineGap=true when no check (in any form) finitely demonstrates the claimed outcome. Include suggestedCheck: one concrete check line the phase could add.
- genuineGap=false when an existing check already demonstrates the outcome — include existingProof quoting the exact check text. When in doubt, prefer genuineGap=true (fail closed): a false rejection re-flags a phase that was correctly blocked; a false approval ships an unproven claim.
- reason: one sentence naming the claim, the proof found or missing, and why.`;

export interface JudgeClaimProofViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** The claim being checked (e.g. "theme-shell-mount"). */
  claim: string;
  /** The deterministic issue string that was flagged. */
  issue: string;
  /** Success Criteria + Automated Checks excerpt (will be clipped). */
  phaseDocExcerpt: string;
  timeoutMs?: number;
}

const EXCERPT_TAIL_CHARS = 4_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Coerce a possibly-messy LLM payload into the verdict schema. */
export function parseClaimProofVerdictPayload(parsed: unknown): ClaimProofVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  return ClaimProofVerdictSchema.parse({
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

export async function judgeClaimProofViaLlm(
  opts: JudgeClaimProofViaLlmOptions,
): Promise<ClaimProofVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    system: CLAIM_PROOF_SYSTEM_PROMPT,
    user: [
      `Claim: ${opts.claim}`,
      "",
      "Deterministic issue flagged:",
      opts.issue,
      "",
      "PHASE doc excerpt (Success Criteria / Automated Checks):",
      clip(opts.phaseDocExcerpt ?? "", EXCERPT_TAIL_CHARS),
    ].join("\n"),
  });
  return parseClaimProofVerdictPayload(parsed);
}
