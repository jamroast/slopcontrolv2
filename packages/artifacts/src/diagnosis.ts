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
