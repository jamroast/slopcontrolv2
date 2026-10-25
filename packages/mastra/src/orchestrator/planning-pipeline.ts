/**
 * Planning pipeline self-heal: fault routing and judge retry helpers.
 */

import { createHash } from "node:crypto";
import { isSpecificationAsk, PLANNING_AUTOMATED_CHECKS_RULES, normalizeGap } from "@slopcontrol/artifacts";
import { isChatJsonTimeoutError } from "@slopcontrol/llm";

export type PlanningFaultLeg = "none" | "research" | "draft" | "both";

/**
 * Detect broken agent output (empty or chat-preamble with no extractable
 * markdown document). Returns a human-readable reason, or null when the
 * output contains a usable markdown document (a `# ` heading or a fenced
 * ```markdown / ```md block).
 */
export function brokenOutputReason(text: string | null): string | null {
  if (text == null) return "empty output";
  const trimmed = text.trim();
  if (!trimmed) return "empty output";
  const hasHeading = /^#\s+/m.test(trimmed);
  const hasFence = /```(?:markdown|md)\s*\n[\s\S]*?```/i.test(trimmed);
  if (!hasHeading && !hasFence) {
    return "no markdown document (chat preamble only)";
  }
  return null;
}

/**
 * Per-phase planning-loop budget, resolved once per phase and consulted at
 * every loop boundary. One record instead of scattered constants so an
 * operator can tune the whole envelope (and so the exhausted-budget
 * diagnosis can carry the full policy, not one magic number).
 */
export interface PlanningBudget {
  /** Max repair legs per quality-gate critic loop. */
  legRetries: number;
  /** Max outer self-heal rounds (research → draft → intent gate). */
  selfHealRounds: number;
  /** Max research re-runs for a phase before failing closed. */
  researchReruns: number;
  /**
   * Wall-clock budget for one phase's whole planning loop, checked at loop
   * boundaries (self-heal round tops, critic-loop judgement boundaries).
   */
  wallClockMs: number;
}

export const DEFAULT_PLANNING_BUDGET: PlanningBudget = {
  legRetries: 2,
  selfHealRounds: 3,
  researchReruns: 2,
  // Generous default: a planning round runs several multi-minute agent turns.
  wallClockMs: 60 * 60 * 1000,
};

const budgetEnvInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** Resolve the planning budget with per-knob env overrides (fail to defaults). */
export function resolvePlanningBudget(
  env: NodeJS.ProcessEnv = process.env,
): PlanningBudget {
  return {
    legRetries: budgetEnvInt(
      env.SLOPCONTROL_PLANNING_LEG_RETRIES,
      DEFAULT_PLANNING_BUDGET.legRetries,
    ),
    selfHealRounds: budgetEnvInt(
      env.SLOPCONTROL_PLANNING_SELF_HEAL_ROUNDS,
      DEFAULT_PLANNING_BUDGET.selfHealRounds,
    ),
    researchReruns: budgetEnvInt(
      env.SLOPCONTROL_PLANNING_RESEARCH_RERUNS,
      DEFAULT_PLANNING_BUDGET.researchReruns,
    ),
    wallClockMs: budgetEnvInt(
      env.SLOPCONTROL_PLANNING_WALL_CLOCK_MS,
      DEFAULT_PLANNING_BUDGET.wallClockMs,
    ),
  };
}

/** Back-compat aliases (existing call sites / tests) — prefer PlanningBudget. */
export const MAX_PLANNING_SELF_HEAL_ROUNDS = DEFAULT_PLANNING_BUDGET.selfHealRounds;
export const MAX_PLANNING_LEG_RETRIES = DEFAULT_PLANNING_BUDGET.legRetries;
export const MAX_PLANNING_RESEARCH_RERUNS = DEFAULT_PLANNING_BUDGET.researchReruns;

/** Which budget knob ran out — the unified exhausted-budget diagnosis axis. */
export type PlanningBudgetKnob =
  | "leg-retries"
  | "self-heal-rounds"
  | "research-reruns"
  | "wall-clock";

/** One exhausted-budget detail message per knob (same shape everywhere). */
export function planningBudgetExhaustedDetail(opts: {
  knob: PlanningBudgetKnob;
  budget: PlanningBudget;
  phaseId: string;
}): string {
  const { knob, budget, phaseId } = opts;
  switch (knob) {
    case "research-reruns":
      return `Phase ${phaseId} exceeded ${budget.researchReruns} research re-runs without producing a judge-passing draft. The research leg keeps being rejected — surface the unresolved gaps to the operator rather than looping.`;
    case "wall-clock":
      return `Phase ${phaseId} planning exceeded its wall-clock budget of ${Math.round(budget.wallClockMs / 60_000)}m without producing a judge-passing draft. Surface the unresolved gaps to the operator rather than looping.`;
    case "self-heal-rounds":
      return `Phase ${phaseId} exhausted ${budget.selfHealRounds} planning self-heal rounds without producing a judge-passing draft. Surface the unresolved gaps to the operator rather than looping.`;
    case "leg-retries":
      return `Phase ${phaseId} exhausted ${budget.legRetries} leg-repair retries in a planning quality loop. Surface the unresolved gaps to the operator rather than looping.`;
  }
}

/** Max JSON judge retries on infra/parse failure before fail-closed. */
export const MAX_PLANNING_JUDGE_RETRIES = 3;

/** Wall-clock for research / phase-planner agent turns (cloud models can run 5+ min). */
export const PLANNING_AGENT_TIMEOUT_MS = 600_000;

export function planningAgentRunOpts(maxSteps: number): {
  maxSteps: number;
  timeoutMs: number;
} {
  return { maxSteps, timeoutMs: PLANNING_AGENT_TIMEOUT_MS };
}

const INFRA_ISSUE_RE =
  /could not be verified|unreadable judge|LLM judge failed|judge failed/i;

/** Thrown when a planning judge call errors on every retry without a verdict. */
export class PlanningJudgeInfraError extends Error {
  constructor(readonly rootCause: unknown) {
    const detail =
      rootCause instanceof Error
        ? rootCause.message
        : String(rootCause ?? "unknown");
    super(`Planning judge failed with no verdict: ${detail}`);
    this.name = "PlanningJudgeInfraError";
  }
}

/** Human-readable detail from an unknown judge error (for logs/diagnoses). */
export function planningJudgeErrorDetail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isPlanningJudgeInfraIssue(issue: string): boolean {
  return INFRA_ISSUE_RE.test(issue);
}

export function mergeFaultLegs(
  ...legs: Array<PlanningFaultLeg | undefined>
): PlanningFaultLeg {
  const set = new Set(legs.filter(Boolean));
  if (set.has("both") || (set.has("research") && set.has("draft"))) {
    return "both";
  }
  if (set.has("research")) return "research";
  if (set.has("draft")) return "draft";
  return "none";
}

export function formatJudgeFeedbackBlock(opts: {
  title: string;
  gaps: string[];
  suggestedFixes?: string[];
}): string {
  if (opts.gaps.length === 0) return "";
  const fixes =
    opts.suggestedFixes && opts.suggestedFixes.length > 0
      ? opts.suggestedFixes.map((s, i) => `- ${s}`).join("\n")
      : "";
  return `${opts.title}:
${opts.gaps.map((g) => `- ${g}`).join("\n")}${fixes ? `\nSuggested fixes:\n${fixes}` : ""}`;
}

export function researchQualityRetryPrompt(opts: {
  intentBlock: string;
  description: string;
  researchPath: string;
  researchDate: string;
  judgeFeedback: string;
}): string {
  return `Your previous RESEARCH.md failed the quality judge.
${opts.judgeFeedback}

Rewrite the FULL RESEARCH.md. Rules:
- Use Date: ${opts.researchDate} near the top.
- Include verified file paths, proposed Automated Checks for PHASE, risks, and concrete uiMount decisions.
- write_file path: ${opts.researchPath}
- Also return the same markdown starting with #.
- End with RESEARCH_COMPLETE.

${opts.intentBlock}

Change request:
${opts.description}`;
}

export function phaseQualityRetryPrompt(opts: {
  canonicalPath: string;
  intentBlock: string;
  description: string;
  research: string;
  judgeFeedback: string;
  /** Toolchain-rendered checks contract (defaults to the node-default rules). */
  checkRules?: string;
}): string {
  return `Your previous PHASE.md failed the quality judge.
${opts.judgeFeedback}

Rewrite the FULL PHASE.md starting with \`# Phase …\` — output ONLY the markdown document.
If you use write_file, path must be exactly: ${opts.canonicalPath}
Required sections: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence), ## Blueprint Deltas.
Base Scope/File Changes ONLY on the RESEARCH below.
${opts.intentBlock}
${opts.checkRules ?? PLANNING_AUTOMATED_CHECKS_RULES}
End with PHASE_COMPLETE.

Description:
${opts.description}

Research:
${opts.research}`;
}

const JUDGE_PARSE_OR_EMPTY_RE =
  /parse failed|empty content|timed out|no verdict/i;

/** True when a thrown judge error looks like JSON/empty/timeout infra, not content. */
export function isPlanningJudgeParseFailure(err: unknown): boolean {
  const detail =
    err instanceof PlanningJudgeInfraError
      ? planningJudgeErrorDetail(err.rootCause)
      : err instanceof Error
        ? err.message
        : String(err ?? "");
  return JUDGE_PARSE_OR_EMPTY_RE.test(detail);
}

/** Run a planning JSON judge with infra/parse retries (does not burn leg-repair passes). */
export async function callPlanningJudgeWithInfraRetry<T>(
  call: () => Promise<T>,
  extractGaps: (result: T) => string[],
  maxRetries: number = MAX_PLANNING_JUDGE_RETRIES,
  opts?: { fallbackCall?: () => Promise<T> },
): Promise<{ result: T; judgeInfraFailed: boolean; usedFallback?: boolean }> {
  const runLeg = async (
    legCall: () => Promise<T>,
  ): Promise<{ result: T; judgeInfraFailed: boolean }> => {
    let last: T | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        last = await legCall();
        const gaps = extractGaps(last);
        const infra = gaps.some(isPlanningJudgeInfraIssue);
        if (!infra) return { result: last, judgeInfraFailed: false };
        if (attempt < maxRetries - 1) continue;
        return { result: last, judgeInfraFailed: true };
      } catch (err) {
        lastError = err;
        // A timeout is a latency signal, not a flaky verdict — the same
        // endpoint's ladder already burned its bounded retries, so re-paying
        // full timeout windows here just multiplies wall time. Skip the
        // remaining same-leg attempts; the caller's fallback endpoint (a
        // different provider) is the useful failover.
        if (
          attempt < maxRetries - 1 &&
          !isChatJsonTimeoutError(err)
        ) {
          continue;
        }
        if (last) return { result: last, judgeInfraFailed: true };
        throw new PlanningJudgeInfraError(lastError);
      }
    }
    throw new PlanningJudgeInfraError(
      lastError ?? new Error("retry loop exhausted"),
    );
  };

  try {
    const primary = await runLeg(call);
    if (
      !primary.judgeInfraFailed ||
      !opts?.fallbackCall ||
      !extractGaps(primary.result).some(isPlanningJudgeInfraIssue)
    ) {
      return primary;
    }
    const fallback = await runLeg(opts.fallbackCall);
    return { ...fallback, usedFallback: true };
  } catch (err) {
    if (!opts?.fallbackCall || !isPlanningJudgeParseFailure(err)) {
      throw err;
    }
    const fallback = await runLeg(opts.fallbackCall);
    return { ...fallback, usedFallback: true };
  }
}

export function faultLegFromPhaseQualityVerdict(opts: {
  ok: boolean;
  researchFaults: string[];
  draftFaults: string[];
}): PlanningFaultLeg {
  if (opts.ok) return "none";
  const hasResearch = opts.researchFaults.length > 0;
  const hasDraft =
    opts.draftFaults.length > 0 || (!hasResearch && !opts.ok);
  return mergeFaultLegs(
    hasResearch ? "research" : "none",
    hasDraft ? "draft" : "none",
  );
}

/** Whether the planning self-heal loop should re-run research/draft legs. */
export function shouldContinuePlanningSelfHeal(opts: {
  stage: string;
  faultLeg: PlanningFaultLeg;
  judgeInfraFailed?: boolean;
  round: number;
  maxRounds: number;
}): boolean {
  return (
    opts.stage === "failed" &&
    !opts.judgeInfraFailed &&
    opts.faultLeg !== "none" &&
    opts.round < opts.maxRounds - 1
  );
}

const FILL_SUBMIT_GATE_RE =
  /fill\+submit|fill\/submit|submit form|primary action.*submit|interactive control at locked mount|actionable mount|fillable mount/i;

const SPEC_ONLY_PHASE_RE =
  /specification\s+phase|specification-only|no source(?:\s|-)?code edits|no source edits this phase|implementation is deferred|records decisions|deferred to phases? \d+/i;

/** Stable fingerprint for planning gate issue lists (self-heal oscillation detection). */
export function planningGateIssueFingerprint(issues: string[]): string {
  const normalized = issues
    .map((issue) => issue.replace(/\s+/g, " ").trim().toLowerCase())
    .filter(Boolean)
    .sort()
    .join("|");
  if (!normalized) return "";
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function isEngagementFillSubmitGateIssue(issue: string): boolean {
  return FILL_SUBMIT_GATE_RE.test(issue);
}

export function isSpecOnlyPhaseDocExcerpt(doc: string): boolean {
  return SPEC_ONLY_PHASE_RE.test(doc);
}

/**
 * True when engagement fill/submit gate failures contradict a spec-only phase
 * (description or drafted PHASE scope).
 */
export function isIntentEngagementContradiction(opts: {
  gateIssues: string[];
  phaseDocExcerpt?: string;
  description?: string;
}): boolean {
  const engagementIssues = opts.gateIssues.filter(isEngagementFillSubmitGateIssue);
  if (engagementIssues.length === 0) return false;
  if (opts.description && isSpecificationAsk(opts.description)) return true;
  if (opts.phaseDocExcerpt && isSpecOnlyPhaseDocExcerpt(opts.phaseDocExcerpt)) {
    return true;
  }
  return false;
}

/**
 * After the first failed self-heal round, re-classify Change Intent when the
 * judge keeps demanding engagement proofs against a spec-only phase or repeats
 * the same fill/submit fault (draft cannot converge without intent fix).
 */
export function shouldReclassifyIntentForPlanningSelfHeal(opts: {
  gateIssues: string[];
  phaseDocExcerpt?: string;
  description?: string;
  priorGateFingerprints: string[];
  round: number;
}): boolean {
  if (opts.round < 1 || opts.gateIssues.length === 0) return false;
  const fp = planningGateIssueFingerprint(opts.gateIssues);
  const repeatedEngagementFault =
    fp.length > 0 &&
    opts.priorGateFingerprints.includes(fp) &&
    opts.gateIssues.some(isEngagementFillSubmitGateIssue);
  if (repeatedEngagementFault) return true;
  return isIntentEngagementContradiction(opts);
}

/**
 * Gaps a deferred draft failure stores for the next self-heal round.
 * Structured `issues` win: a gap may itself contain "; ", which splitting
 * `detail` would fragment.
 */
export function nextSelfHealDraftIssues(
  detail: string,
  issues?: string[],
): string[] {
  if (issues?.length) {
    return [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))];
  }
  return detail
    .split("; ")
    .map((issue) => issue.trim())
    .filter(Boolean);
}

/**
 * Prior DRAFT-gate gaps to carry into an operator-triggered `retry_draft`.
 *
 * The planning self-heal loop feeds each round's judge gaps forward, but the
 * operator action used to call `draftPhase` with no feedback and delete the
 * diagnosis first — so every retry_draft regenerated the same check defects
 * (an unsatisfiable grep, a missing test file) that the judge had already
 * rejected. Extract those gaps from the persisted diagnosis instead.
 *
 * Only draft-gate diagnoses qualify: a develop/verify diagnosis is not
 * actionable for a PHASE.md draft.
 */
export function priorDraftJudgeIssuesFromDiagnosis(
  diagnosis: {
    title?: string;
    rootCause?: string;
    evidence?: string;
    tags?: string[];
    issues?: string[];
    draftIssues?: string[];
  } | null,
): string[] {
  if (!diagnosis) return [];
  const tags = diagnosis.tags ?? [];
  const isDraftGate =
    tags.includes("draft") || /^draft rejected/i.test(diagnosis.title ?? "");
  if (!isDraftGate) return [];
  // Structured gaps are authoritative (a gap may itself contain "; ").
  // Prefer the draft-attributed ledger when present, so a research re-run no
  // longer re-feeds research-only gaps to the drafter.
  const structured = (
    diagnosis.draftIssues?.length ? diagnosis.draftIssues : (diagnosis.issues ?? [])
  )
    .map((issue) => issue.trim())
    .filter(Boolean);
  if (structured.length > 0) return [...new Set(structured)];
  // Fallback for older diagnoses: evidence is the longer copy (rootCause caps
  // at 4k and can slice a gap).
  const detail = (diagnosis.evidence || diagnosis.rootCause || "").trim();
  if (!detail) return [];
  return [
    ...new Set(
      detail
        .split("; ")
        .map((issue) => issue.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Gaps the PHASE quality judge raised (only), for the convergence block.
 *
 * Structural/shell-validator diagnoses are NOT quality verdicts: feeding their
 * findings to the judge as "gaps you already raised" anchors it on mechanics it
 * never judged (phase-197: a false-positive brittle-grep finding echoed forever).
 */
export function priorQualityJudgeGapsFromDiagnosis(
  diagnosis: {
    title?: string;
    rootCause?: string;
    evidence?: string;
    tags?: string[];
    issues?: string[];
    openIssues?: string[];
  } | null,
): string[] {
  if (!diagnosis) return [];
  const tags = diagnosis.tags ?? [];
  // Infra diagnoses (“…phase quality judge infra”, kind phase-quality-infra)
  // carry transport messages, not content gaps — they must not seed either.
  const isQuality =
    !tags.includes("phase-quality-infra") &&
    (tags.includes("phase-quality") ||
      (/phase quality judge/i.test(diagnosis.title ?? "") &&
        !/infra/i.test(diagnosis.title ?? "")));
  if (!isQuality) return [];
  // Belt and braces: transport/infra messages are not content gaps even when
  // the diagnosis is tagged `phase-quality` (e.g. the "no LLM judge bound"
  // failure keeps that kind while carrying "…could not be verified…").
  const contentGaps = (issues: string[]) =>
    [...new Set(issues.map((issue) => issue.trim()).filter(Boolean))].filter(
      (issue) => !isPlanningJudgeInfraIssue(issue),
    );
  // Prefer the cumulative ledger; fall back to this verdict's issues for
  // older diagnoses written before the ledger existed.
  const structured = contentGaps(
    diagnosis.openIssues?.length ? diagnosis.openIssues : (diagnosis.issues ?? []),
  );
  if (structured.length > 0) return structured;
  const detail = (diagnosis.evidence || diagnosis.rootCause || "").trim();
  if (!detail) return [];
  return contentGaps(detail.split("; "));
}

/**
 * Seed the quality judge's convergence memory.
 *
 * Returns [] when the only diagnosis is not a quality verdict. When
 * RESEARCH.md was regenerated after the verdict, drops only research-
 * attributed gaps — a re-research leg can invalidate the facts those gaps were
 * about, but draft-mechanics gaps (which no research change can fix) stay in
 * the loop so they are not forgotten and rediscovered a later round.
 */
export function seedPriorQualityGaps(opts: {
  diagnosis: {
    title?: string;
    rootCause?: string;
    evidence?: string;
    tags?: string[];
    issues?: string[];
    openIssues?: string[];
    researchIssues?: string[];
    draftIssues?: string[];
    updatedAt?: string;
    researchHash?: string;
  } | null;
  /** SHA-256 hex of the current RESEARCH.md body (preferred staleness key). */
  researchHash?: string;
  /** Legacy staleness fallback for diagnoses written before content hashing. */
  researchMtimeMs?: number;
}): string[] {
  const { diagnosis } = opts;
  if (!diagnosis) return [];
  const gaps = priorQualityJudgeGapsFromDiagnosis(diagnosis);
  if (gaps.length === 0) return [];
  // With the split ledger we know each gap's attribution. A research-attributed
  // gap can only be closed by a re-research leg, so it must NEVER seed the draft
  // loop — the drafter cannot fix it, the phase-quality judge re-asserts it every
  // leg and faultLeg escalates to "both" forever (re-running research that
  // changed nothing). Drop research gaps unconditionally for split diagnoses,
  // whether or not RESEARCH was regenerated since the verdict. Genuine research
  // faults still surface through the research-reruns budget (the persisted
  // openIssues/researchIssues ledger is untouched here).
  const hasSplit =
    Array.isArray(diagnosis.researchIssues) ||
    Array.isArray(diagnosis.draftIssues);
  if (hasSplit) {
    const research = new Set(
      (diagnosis.researchIssues ?? []).map((g) => normalizeGap(g)),
    );
    return gaps.filter((g) => !research.has(normalizeGap(g)));
  }
  // Legacy diagnosis without the split: we cannot distinguish attribution.
  // Preserve the old fail-safe — drop everything only when RESEARCH was
  // regenerated after the verdict; otherwise keep the gaps.
  let researchRegen = false;
  if (opts.researchHash && diagnosis.researchHash) {
    // Content hash: rewrite-same-content does NOT invalidate (no false drop),
    // mtime does not matter.
    researchRegen = opts.researchHash !== diagnosis.researchHash;
  } else {
    // Legacy mtime fallback (pre-hash diagnoses only).
    const diagnosedAt = Date.parse(diagnosis.updatedAt ?? "");
    researchRegen =
      Number.isFinite(diagnosedAt) &&
      typeof opts.researchMtimeMs === "number" &&
      opts.researchMtimeMs > diagnosedAt;
  }
  return researchRegen ? [] : gaps;
}

/**
 * Prior gaps minus the ones the judge verified as fixed (verbatim match after
 * whitespace/case normalization), so resolved findings cannot be re-asserted.
 */
export function priorGapsAfterResolution(
  priorGaps: string[],
  resolvedGaps: string[],
): string[] {
  const resolved = new Set(resolvedGaps.map(normalizeGap));
  return priorGaps.filter((gap) => !resolved.has(normalizeGap(gap)));
}

/* ------------------------------------------------------------------ */
/* Bounded critic loop — one primitive for judge→repair→re-judge legs. */
/* ------------------------------------------------------------------ */

/** A judge verdict shape the critic loop can accumulate a ledger from. */
export interface CriticLoopVerdict {
  ok: boolean;
  gaps: string[];
  resolvedGaps?: string[];
}

export type CriticLoopOutcome<V extends CriticLoopVerdict> =
  | { kind: "passed"; priorGaps: string[] }
  /** Judge call threw after infra retries — hard infra failure, no verdict. */
  | { kind: "judge-error"; error: unknown; priorGaps: string[] }
  /** Judge degraded to an infra verdict (gaps carry transport messages). */
  | { kind: "infra-failed"; gaps: string[]; priorGaps: string[] }
  /**
   * Loop left via fault routing (shouldEscalate reason) or exhausted leg
   * retries ("max-leg-retries"). `verdict` is the last real judgement;
   * `priorGaps` is the accumulated ledger for the diagnosis.
   */
  | {
      kind: "escalated";
      verdict: V;
      reason: unknown;
      priorGaps: string[];
      legRetries: number;
    }
  /** Repair leg (agent turn) threw. `verdict` is the judgement being fixed. */
  | {
      kind: "repair-error";
      error: unknown;
      verdict: V;
      priorGaps: string[];
      legRetries: number;
    }
  /**
   * Wall-clock deadline hit at a loop boundary (before the next judgement).
   * Carries the accumulated ledger so the caller's budget diagnosis shows
   * WHAT was unresolved, not just that time ran out.
   */
  | { kind: "budget-exhausted"; priorGaps: string[]; legRetries: number };

/**
 * One bounded critic-loop primitive shared by the planning quality gates
 * (research leg, draft leg). Owns the loop mechanics: judge invocation with
 * the convergence ledger, ledger accumulation (union prior+new, subtract
 * verified-resolved), leg-retry bounding, and outcome classification. The
 * caller supplies the leg-specific pieces as callbacks: how to judge, when
 * to escalate (fault routing), and how to run one repair leg.
 *
 * Invariants preserved from the hand-rolled loops:
 * - The ledger accumulates across judgements (never replaces) so a gap an
 *   earlier verdict raised but this one neither re-raised nor resolved is
 *   not forgotten (phase-201 pattern).
 * - resolvedGaps are subtracted verbatim — a resolved finding cannot be
 *   re-asserted (phase-197 anti-confabulation pressure).
 */
export async function runBoundedCriticLoop<V extends CriticLoopVerdict>(opts: {
  /** Seeded convergence memory (persisted diagnosis + self-heal rounds). */
  initialPriorGaps: string[];
  maxLegRetries: number;
  /** One judgement (infra retry + fallback inside). Throws on hard error. */
  judge: (
    priorGaps: string[],
  ) => Promise<{ result: V; judgeInfraFailed: boolean }>;
  /**
   * After a failed verdict: return a non-null escalation reason to leave the
   * loop (fault routing); null lets the loop run a repair leg.
   */
  shouldEscalate?: (verdict: V, legRetriesSoFar: number) => unknown | null;
  /** Run one repair leg (prompt + agent + harvest). Throws = repair failure. */
  repair: (verdict: V, legRetry: number) => Promise<void>;
  /**
   * Deterministic filter applied to a verdict's gaps before ledger
   * accumulation (e.g. drop infra/transport phrasing that must not persist).
   */
  filterAccumulatedGaps?: (gaps: string[]) => string[];
  /** Called when the judge verified prior gaps as fixed. */
  onResolvedGaps?: (resolvedGaps: string[]) => void;
  /**
   * Wall-clock deadline (Date.now() ms). Checked at every loop boundary —
   * when hit, the loop exits with "budget-exhausted" carrying the ledger.
   */
  deadlineMs?: number;
}): Promise<CriticLoopOutcome<V>> {
  let priorGaps = [...opts.initialPriorGaps];
  let legRetries = 0;
  while (true) {
    if (opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) {
      return { kind: "budget-exhausted", priorGaps, legRetries };
    }
    let judged: { result: V; judgeInfraFailed: boolean };
    try {
      judged = await opts.judge(priorGaps);
    } catch (error) {
      return { kind: "judge-error", error, priorGaps };
    }
    if (judged.judgeInfraFailed) {
      return { kind: "infra-failed", gaps: judged.result.gaps, priorGaps };
    }
    const verdict = judged.result;
    if (verdict.ok) return { kind: "passed", priorGaps };

    // Accumulate the running convergence set: union the prior seed with this
    // verdict's (filtered) gaps, dedupe, then subtract verified-resolved.
    const newGaps = opts.filterAccumulatedGaps?.(verdict.gaps) ?? verdict.gaps;
    const seen = new Set<string>();
    const accumulated: string[] = [];
    for (const g of [...priorGaps, ...newGaps]) {
      const key = normalizeGap(g);
      if (!seen.has(key)) {
        seen.add(key);
        accumulated.push(g);
      }
    }
    const resolvedGaps = verdict.resolvedGaps ?? [];
    priorGaps = priorGapsAfterResolution(accumulated, resolvedGaps);
    if (resolvedGaps.length > 0) opts.onResolvedGaps?.(resolvedGaps);

    const reason = opts.shouldEscalate?.(verdict, legRetries) ?? null;
    if (reason !== null && reason !== undefined) {
      return { kind: "escalated", verdict, reason, priorGaps, legRetries };
    }
    if (legRetries >= opts.maxLegRetries) {
      return {
        kind: "escalated",
        verdict,
        reason: "max-leg-retries",
        priorGaps,
        legRetries,
      };
    }

    legRetries++;
    try {
      await opts.repair(verdict, legRetries);
    } catch (error) {
      return { kind: "repair-error", error, verdict, priorGaps, legRetries };
    }
  }
}

/** Title used when carrying a prior draft's judge gaps into the next draft. */
export const PRIOR_DRAFT_FEEDBACK_TITLE =
  "Prior PHASE.md draft was rejected by the quality judge — address every gap below in the rewritten draft";

/**
 * The exact block `draftPhase` injects into the draft prompt when a retry or a
 * self-heal round carries prior judge gaps. Empty string when there are none.
 */
export function formatPriorDraftFeedbackBlock(issues: string[]): string {
  if (issues.length === 0) return "";
  return `${formatJudgeFeedbackBlock({
    title: PRIOR_DRAFT_FEEDBACK_TITLE,
    gaps: issues,
  })}\nHow to address them: fix the cause, not the wording. For an ungrounded-token gap (a check greps a string RESEARCH never quoted), re-scope the check to tokens quoted in RESEARCH's \`## Check targets (verified)\`, or verify the exact string against the target file with read_file before asserting it — never re-assert the flagged token unchanged.\n`;
}
