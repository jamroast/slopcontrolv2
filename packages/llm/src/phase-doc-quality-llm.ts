import { z } from "zod";
import type { LlmEndpoint } from "@slopcontrol/types";
import { consolidateText } from "@slopcontrol/artifacts";
import {
  chatJson,
  CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
  CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
  PLANNING_JUDGE_EXCERPT_CHARS,
} from "./json-chat.js";

/**
 * PHASE.md quality judge — validates the draft execution contract before
 * intent-alignment gates run.
 */

export const PhaseDocQualityVerdictSchema = z.object({
  /** true = PHASE.md is substantive and implements RESEARCH (not scaffold). */
  ok: z.boolean(),
  gaps: z.array(z.string()),
  suggestedFixes: z.array(z.string()),
  /**
   * Prior gaps this judgement verified as fixed (verbatim). Kept out of the
   * next convergence block so a resolved finding cannot be re-asserted.
   */
  resolvedGaps: z.array(z.string()),
  /**
   * Gaps attributable to thin/missing RESEARCH (research leg should re-run).
   * Subset of gaps — may be empty even when ok=false.
   */
  researchFaults: z.array(z.string()),
  /**
   * Gaps where RESEARCH was adequate but PHASE failed to translate it.
   */
  draftFaults: z.array(z.string()),
});

export type PhaseDocQualityVerdict = z.infer<typeof PhaseDocQualityVerdictSchema>;

export const PHASE_DOC_QUALITY_SYSTEM_PROMPT = `You are SlopControl's PHASE.md quality judge. You decide whether a PHASE.md draft is execution-ready and faithfully implements RESEARCH.md + Change Intent. Respond with ONLY a single JSON object.

Schema:
- ok: boolean
- gaps: string[] — all issues still present (empty when ok)
- suggestedFixes: string[] — concrete fixes parallel to gaps
- resolvedGaps: string[] — prior gaps you verified as fixed, verbatim (empty when there were no prior gaps)
- researchFaults: string[] — gaps only a re-research can fix: evidence missing from RESEARCH.md itself
- draftFaults: string[] — gaps in how PHASE is written, including check mechanics, even when the target came from RESEARCH

Check ALL of:
1. Required sections present and substantive: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence), ## Blueprint Deltas — not placeholder/scaffold text.
2. RESEARCH translation — file paths, routes, checks, and design decisions from RESEARCH appear in PHASE (especially Automated Checks).
3. uiMount — when intent uiMount is set, PHASE Scope/File Changes name the concrete mount (route/page/component), not abstract "wire auth".
4. Automated Checks — finite structural proofs (grep/build/vitest one-shot); no bare dev servers or npm test without path. When a "Automated Check targets" block is supplied, a check targeting an "exists" path is grounded even if RESEARCH.md never names it — do NOT fail it as unverified; a "NEW" path is declared in File Changes (this phase creates it) and may be asserted; a "MISSING" target is a real gap. When a "Verified grep tokens" block is supplied, its tokens are confirmed verbatim on disk by SlopControl — treat them as grounded even when RESEARCH.md never quotes them; do NOT fail them as unverified. Checks must NOT restart infra with docker compose up or trap teardown — SlopControl test-services already brings up Postgres/Redis/etc.; DB-dependent checks assume services are up (migrate/seed/targeted tests). Redundant infra bring-up is a draft fault.
5. Blueprint Deltas — durable decisions recorded when PHASE introduces new routes/surfaces/contracts.

Change Intent precedence:
- The Change Intent block is authoritative. When it contains a researchNote, that note overrides conflicting wording in the phase description (including its Success criteria).
- Never require wording that mustNot forbids; never fail a draft for following researchNote over superseded description phrasing.

Interaction contract rules:
- When Change Intent has NO interaction block, do NOT require Playwright fill/submit or form engagement proofs — grep/route/href proofs suffice for page mounts.
- When interaction primaryAction is submit form, Success Criteria + Automated Checks must prove fill+submit at the locked mount.

Fault routing (researchFaults vs draftFaults) — getting this right matters because researchFaults forces a costly full re-research leg:
- researchFaults is ONLY for evidence missing from RESEARCH.md itself: a repo path the checks rely on that RESEARCH never verified, a doc string a check greps for that neither RESEARCH quoted nor the deterministic verification blocks ("Automated Check targets" / "Verified grep tokens") confirmed on disk, a wrong/contradicted fact, a missing required section — things only fresh investigation in the repo can supply.
- Everything about HOW a check is written — brittle or evadable greps, count-exact sentinels, ordering assumptions, missing invariants, weak assertions — is a draftFault, even when the check's target came from RESEARCH. A re-research cannot fix check mechanics.
- Never attribute a gap to researchFaults unless new repo investigation could resolve it. When unsure, attribute to draftFaults.

Verdict rules:
- ok=true only when PHASE is ready for operator review and development.
- Attribute each gap to researchFaults OR draftFaults (can be both lists non-empty).
- When in doubt, prefer ok=false (fail closed).`;

// Exact §4 paragraph of PHASE_DOC_QUALITY_SYSTEM_PROMPT — the replace target
// for the toolchain-rendered variant below.
const CHECKS_JUDGMENT_CLAUSE = `4. Automated Checks — finite structural proofs (grep/build/vitest one-shot); no bare dev servers or npm test without path. When a "Automated Check targets" block is supplied, a check targeting an "exists" path is grounded even if RESEARCH.md never names it — do NOT fail it as unverified; a "NEW" path is declared in File Changes (this phase creates it) and may be asserted; a "MISSING" target is a real gap. When a "Verified grep tokens" block is supplied, its tokens are confirmed verbatim on disk by SlopControl — treat them as grounded even when RESEARCH.md never quotes them; do NOT fail them as unverified. Checks must NOT restart infra with docker compose up or trap teardown — SlopControl test-services already brings up Postgres/Redis/etc.; DB-dependent checks assume services are up (migrate/seed/targeted tests). Redundant infra bring-up is a draft fault.`;

/**
 * Toolchain-aware variant of the judge system prompt: §4 stops naming one
 * ecosystem's commands and instead judges against the project's rendered
 * check-authoring rules (embedded in the user message). The deterministic
 * targets/infra semantics are unchanged.
 */
export function renderPhaseDocQualitySystemPrompt(opts?: {
  checkRulesBlock?: string;
  hasTestServices?: boolean;
}): string {
  const rules = opts?.checkRulesBlock?.trim();
  if (!rules) return PHASE_DOC_QUALITY_SYSTEM_PROMPT;
  const infra = (opts?.hasTestServices ?? true)
    ? " Checks must NOT restart infra with docker compose up or trap teardown — SlopControl test-services already brings up Postgres/Redis/etc.; DB-dependent checks assume services are up (migrate/seed/targeted tests). Redundant infra bring-up is a draft fault."
    : " Runtime probes must be finite and self-contained (bring up only what they probe, then tear it down).";
  const clause = `4. Automated Checks — finite, targeted proofs obeying the project's check-authoring rules (embedded in the user message under "## Automated Checks rules"; those rules are the drafter's contract — judge against them). When a "Automated Check targets" block is supplied, a check targeting an "exists" path is grounded even if RESEARCH.md never names it — do NOT fail it as unverified; a "NEW" path is declared in File Changes (this phase creates it) and may be asserted; a "MISSING" target is a real gap. When a "Verified grep tokens" block is supplied, its tokens are confirmed verbatim on disk by SlopControl — treat them as grounded even when RESEARCH.md never quotes them; do NOT fail them as unverified.${infra}`;
  return PHASE_DOC_QUALITY_SYSTEM_PROMPT.replace(
    CHECKS_JUDGMENT_CLAUSE,
    clause,
  );
}

export interface JudgePhaseDocQualityOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  intentBlock: string;
  phaseDescription: string;
  researchExcerpt: string;
  phaseDocExcerpt: string;
  /** Deterministic existence list for paths referenced by Automated Checks. */
  checkTargetsBlock?: string;
  /** Deterministic list of grep tokens absent from their target file. */
  grepTokenMismatchesBlock?: string;
  /** Deterministic list of grep tokens confirmed verbatim on disk. */
  verifiedGrepTokensBlock?: string;
  /**
   * Toolchain-rendered check-authoring rules (renderAutomatedChecksRules).
   * When supplied, §4 of the system prompt judges against this contract
   * instead of naming one ecosystem's commands, and the block is embedded
   * in the user message.
   */
  checkRulesBlock?: string;
  /** False when the project has no SlopControl-managed backing services. */
  hasTestServices?: boolean;
  /**
   * Gaps the judge already raised against an earlier draft of this PHASE.
   * Supplied on re-judgement so the judge verifies resolution instead of
   * inventing an unbounded stream of fresh issues (convergence pressure).
   */
  priorGaps?: string[];
  timeoutMs?: number;
}

function clip(text: string, max: number): string {
  return consolidateText(text, max);
}

export function parsePhaseDocQualityVerdictPayload(
  parsed: unknown,
): PhaseDocQualityVerdict {
  const asObj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const pickStrings = (key: string) =>
    Array.isArray(asObj[key])
      ? (asObj[key] as unknown[]).filter(
          (g): g is string => typeof g === "string" && g.trim() !== "",
        )
      : [];
  const gaps = pickStrings("gaps");
  const suggestedFixes = pickStrings("suggestedFixes");
  const resolvedGaps = pickStrings("resolvedGaps");
  const researchFaults = pickStrings("researchFaults");
  const draftFaults = pickStrings("draftFaults");
  const okIsBool = typeof asObj.ok === "boolean";
  const ok = okIsBool ? asObj.ok : false;
  return PhaseDocQualityVerdictSchema.parse({
    ok,
    gaps:
      gaps.length > 0
        ? gaps
        : okIsBool
          ? []
          : ["PHASE quality could not be verified (unreadable judge verdict)"],
    suggestedFixes,
    resolvedGaps,
    researchFaults,
    draftFaults,
  });
}

/**
 * Convergence block for re-judgement: the judge must verify its prior gaps
 * and may only raise NEW issues that are objectively fatal — a judge that
 * can always find one more hypothetical issue prevents the loop from ever
 * passing (phase-197 pattern). `docLabel` names the judged artifact so the
 * same pressure applies to the research and phase-doc judges.
 */
export function formatPriorGapsConvergenceBlock(
  priorGaps: string[],
  docLabel: string = "PHASE.md",
): string {
  const gaps = priorGaps.filter((g) => g.trim().length > 0).slice(0, 12);
  if (gaps.length === 0) return "";
  const fatalExample =
    docLabel === "PHASE.md"
      ? "the phase cannot pass as written — a check targets a MISSING path, a check fails under a reasonable correct implementation, a required section is missing or placeholder, or the draft contradicts RESEARCH.md / the Change Intent"
      : "the research cannot support drafting as written — a required section is missing or placeholder, a claimed repo path/fact is fabricated, or the doc contradicts the Change Intent";
  return [
    "Prior review context (convergence rules apply):",
    `You already rejected an earlier draft of this ${docLabel} with these gaps:`,
    ...gaps.map((g, i) => `${i + 1}. ${g}`),
    "The draft was rewritten to address them. Convergence rules:",
    "- First verify each prior gap against the new draft: if it is still present, report it again in gaps[] (same or sharper wording).",
    "- If a prior gap is fixed, list it VERBATIM in resolvedGaps[]. Never re-report a resolved gap, and never carry it forward.",
    `- Report a NEW gap (one you did not raise before) only when it is objectively fatal: ${fatalExample}.`,
    "- When you report an ungrounded-token gap (a check greps a string no supplied evidence verifies), audit EVERY grep token in the Automated Checks and report all ungrounded tokens at once — never drip-feed them one per round.",
    "- Do NOT report new gaps for hypothetical or hostile implementations (\u201can implementer could write X and evade this check\u201d) when a reasonable implementation passes.",
    "- Robustness hardening and stronger-than-needed invariants are not gaps; omit them.",
  ].join("\n");
}

export async function judgePhaseDocQualityViaLlm(
  opts: JudgePhaseDocQualityOptions,
): Promise<PhaseDocQualityVerdict> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    temperature: 0,
    timeoutMs: opts.timeoutMs ?? CHAT_JSON_PLANNING_JUDGE_TIMEOUT_MS,
    maxTokens: CHAT_JSON_PLANNING_JUDGE_MAX_TOKENS,
    schema: PhaseDocQualityVerdictSchema.partial(),
    schemaHint: "Return ONE JSON object (ok/gaps/…), never an array",
    system: opts.checkRulesBlock
      ? renderPhaseDocQualitySystemPrompt({
          checkRulesBlock: opts.checkRulesBlock,
          hasTestServices: opts.hasTestServices,
        })
      : PHASE_DOC_QUALITY_SYSTEM_PROMPT,
    user: [
      "Change Intent (authoritative):",
      opts.intentBlock,
      "",
      "Phase description:",
      clip(opts.phaseDescription ?? "", 4_000),
      "",
      "RESEARCH.md excerpt:",
      clip(opts.researchExcerpt ?? "", PLANNING_JUDGE_EXCERPT_CHARS),
      "",
      opts.checkRulesBlock ? opts.checkRulesBlock : "",
      "",
      opts.checkTargetsBlock ? opts.checkTargetsBlock : "",
      "",
      opts.grepTokenMismatchesBlock ? opts.grepTokenMismatchesBlock : "",
      "",
      opts.verifiedGrepTokensBlock ? opts.verifiedGrepTokensBlock : "",
      "",
      "",
      formatPriorGapsConvergenceBlock(opts.priorGaps ?? []),
      "",
      "PHASE.md excerpt (Scope / Success Criteria / Automated Checks / Blueprint Deltas):",
      clip(opts.phaseDocExcerpt ?? "", PLANNING_JUDGE_EXCERPT_CHARS),
    ].join("\n"),
  });
  return parsePhaseDocQualityVerdictPayload(parsed);
}
