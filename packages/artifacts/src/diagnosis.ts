/**
 * Persisted diagnosis shape. Lives in its own module (not the index barrel)
 * so modules that both the barrel re-exports and that need the type can
 * import it without a circular reference.
 */
export type PersistedDiagnosis = {
  audience: "operator" | "coding";
  operatorActions: string[];
  class: string;
  confidence: string;
  title: string;
  rootCause: string;
  evidence: string;
  nextActions: string;
  fingerprint: string;
  codingAgentShouldFix: boolean;
  /** Classifier: fixable by harness/environment (deps, services, ports). */
  harnessRecoverable?: boolean;
  /** Classifier tags for coding-retry routing (long-lived, host-utility, …). */
  tags?: string[];
  /**
   * Structured planning gaps (judge findings / gate issues). Authoritative for
   * retry_draft + self-heal feedback: a gap may contain "; ", which a flat
   * "; "-joined detail cannot round-trip losslessly.
   */
  issues?: string[];
  /**
   * Cumulative unresolved planning gaps, accumulated across verdicts rather
   * than overwritten each round. A gap only leaves when a later verdict lists
   * it in resolvedGaps — never silently forgotten.
   */
  openIssues?: string[];
  /** Cumulative research-attributed gaps (stale on research regen). */
  researchIssues?: string[];
  /** Cumulative draft-attributed gaps (survive research regen). */
  draftIssues?: string[];
  /** Research re-runs that did not unblock the phase (budget for A3). */
  researchReruns?: number;
  failingStep?: {
    name: string;
    command?: string;
    exitCode: number;
    /** Stable id matching verify_steps[].id when present. */
    stepId?: string;
  };
  phaseId?: string;
  runId?: string;
  updatedAt: string;
};

/** Cumulative planning-gap ledger (research vs draft attribution split). */
export type PlanningIssueLedger = {
  openIssues: string[];
  researchIssues: string[];
  draftIssues: string[];
};

/** Whitespace/case-insensitive identity for a gap string. */
export function normalizeGap(gap: string): string {
  return gap.trim().toLowerCase().replace(/\s+/g, " ");
}

function mergeGapSet(
  prev: string[],
  added: string[],
  resolved: Set<string>,
): string[] {
  // Preserve first-seen wording; drop anything the judge verified as resolved.
  const out = new Map<string, string>();
  for (const g of prev) {
    const n = normalizeGap(g);
    if (n) out.set(n, g);
  }
  for (const g of added) {
    const n = normalizeGap(g);
    if (n && !out.has(n)) out.set(n, g);
  }
  for (const key of out.keys()) {
    if (resolved.has(key)) out.delete(key);
  }
  return [...out.values()];
}

/**
 * Accumulate a verdict into the phase's open-issue ledger: union the new gaps
 * with the prior set, then subtract the judge-verified resolvedGaps. Nothing
 * leaves except a resolvedGaps match — a gap can no longer be forgotten and
 * rediscovered a later round.
 */
export function mergePlanningIssueLedger(
  prev: PlanningIssueLedger | null,
  verdict: {
    gaps: string[];
    resolvedGaps: string[];
    researchFaults: string[];
    draftFaults: string[];
  },
): PlanningIssueLedger {
  const resolved = new Set((verdict.resolvedGaps ?? []).map(normalizeGap));
  // Un-attributed gaps: the judge rejected but filled neither attribution list.
  // faultLegFromPhaseQualityVerdict defaults that case to draft; mirror it by
  // folding the raw gaps into draftIssues. When an attribution IS present we
  // trust it — the judge may word `gaps` differently than the split, so matching
  // gaps→attribution by text would double-count a reworded gap.
  const hasAttribution =
    (verdict.researchFaults?.length ?? 0) > 0 ||
    (verdict.draftFaults?.length ?? 0) > 0;
  const unAttributed = hasAttribution ? [] : (verdict.gaps ?? []);
  const researchIssues = mergeGapSet(
    prev?.researchIssues ?? [],
    verdict.researchFaults ?? [],
    resolved,
  );
  const draftIssues = mergeGapSet(
    prev?.draftIssues ?? [],
    [...(verdict.draftFaults ?? []), ...unAttributed],
    resolved,
  );
  // openIssues is the union of the two attribution buckets — deriving it from
  // the split (not the raw `gaps`, which the judge may word differently than
  // its researchFaults/draftFaults) keeps the research-regen subtraction in
  // seedPriorQualityGaps aligned with the seeded gaps.
  const union = new Map<string, string>();
  for (const g of [...researchIssues, ...draftIssues]) {
    union.set(normalizeGap(g), g);
  }
  // Preserve prior openIssues entries that are still unresolved but were never
  // attributed (e.g. a legacy verdict written before the split existed).
  for (const g of prev?.openIssues ?? []) {
    const n = normalizeGap(g);
    if (!resolved.has(n) && !union.has(n)) union.set(n, g);
  }
  return { openIssues: [...union.values()], researchIssues, draftIssues };
}
