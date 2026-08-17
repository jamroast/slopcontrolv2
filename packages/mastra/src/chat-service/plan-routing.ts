/** Chat-owned plan loop this conversation last used. */
export type PlanResumeLatch = {
  loopId: string;
  title?: string;
  status?: string;
};

export const PLAN_LOOP_ID_DEPENDENT_TOOLS = new Set([
  "plan_loop_get",
  "plan_loop_continue",
  "plan_loop_acceptance",
  "plan_loop_accept",
  "plan_loop_promote",
  "plan_loop_retry",
  "plan_loop_discard",
]);

export function isPlanLoopOpen(status: string | undefined): boolean {
  return !status || status === "open";
}

export function hasPlanAcceptanceTicks(args: Record<string, unknown>): boolean {
  if (
    Array.isArray(args.acceptedFeatureIds) &&
    args.acceptedFeatureIds.length > 0
  ) {
    return true;
  }
  if (Array.isArray(args.features)) {
    return args.features.some(
      (f) =>
        typeof f === "object" &&
        f !== null &&
        Boolean((f as { accepted?: boolean }).accepted),
    );
  }
  return false;
}

export function parseLoopIdFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^loopId:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as {
      loopId?: unknown;
      loop?: { id?: unknown };
    };
    if (typeof parsed.loopId === "string" && parsed.loopId.trim()) {
      return parsed.loopId.trim();
    }
    if (typeof parsed.loop?.id === "string" && parsed.loop.id.trim()) {
      return parsed.loop.id.trim();
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function parsePlanLoopStatusFromDispatch(raw: string): string | undefined {
  const header = raw.match(/^status:\s*(\S+)/m);
  if (header?.[1]) return header[1];
  try {
    const parsed = JSON.parse(raw) as { loop?: { status?: unknown } };
    if (typeof parsed.loop?.status === "string") return parsed.loop.status;
  } catch {
    /* not JSON */
  }
  return undefined;
}
