/**
 * In-memory per-project develop lock.
 * Only live background jobs hold the lock — failed/orphaned stages do not.
 */

export type DevelopClaimConflict = {
  ok: false;
  blockingRunId: string;
};

export type DevelopClaimOk = { ok: true };

export type DevelopClaimResult = DevelopClaimOk | DevelopClaimConflict;

export class DevelopLock {
  /** projectId -> runId */
  private readonly claims = new Map<string, string>();

  constructor(private readonly isRunActive: (runId: string) => boolean) {}

  /** Clear stale claim if the run is no longer active. */
  getLiveClaim(projectId: string): string | undefined {
    const runId = this.claims.get(projectId);
    if (!runId) return undefined;
    if (!this.isRunActive(runId)) {
      this.claims.delete(projectId);
      return undefined;
    }
    return runId;
  }

  tryClaim(projectId: string, runId: string): DevelopClaimResult {
    const existing = this.getLiveClaim(projectId);
    if (existing) {
      // Same run already claimed (e.g. double-submit) — still a conflict
      return { ok: false, blockingRunId: existing };
    }
    this.claims.set(projectId, runId);
    return { ok: true };
  }

  release(projectId: string, runId: string): void {
    if (this.claims.get(projectId) === runId) {
      this.claims.delete(projectId);
    }
  }

  /** Drop claim for a project regardless of runId (delete/reinit). */
  clearProject(projectId: string): void {
    this.claims.delete(projectId);
  }

  /** Test/inspection helper. */
  size(): number {
    return this.claims.size;
  }
}
