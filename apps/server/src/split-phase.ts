import { writePhaseStatus, upsertRoadmapEntry } from "@slopcontrol/artifacts";
import {
  isBusyRunStage,
  isGateRunStage,
  type Phase,
} from "@slopcontrol/types";
import type { SlopStore } from "./store.js";

export type SplitPhasePart = { title?: string; description: string };

export type StartResearchResolution =
  | { ok: true; phase: Phase; reused: boolean; description: string }
  | { ok: false; status: number; error: string };

/**
 * Resolve the phase that start_research should run on.
 *
 * With a phaseId this reuses an existing draft phase (e.g. a fresh sub-phase
 * from split_phase) instead of creating a duplicate new phase. Without a
 * phaseId it creates a new phase. Non-draft phases are rejected so callers
 * don't accidentally overwrite work already in flight.
 */
export function resolveStartResearchPhase(opts: {
  store: SlopStore;
  project: { id: string; rootPath: string };
  phaseId?: string;
  description: string;
  dependsOn?: string[];
}): StartResearchResolution {
  const { store, project, phaseId, description, dependsOn } = opts;
  if (phaseId) {
    const existing = store.getPhase(phaseId);
    if (!existing || existing.projectId !== project.id) {
      return { ok: false, status: 404, error: "Phase not found" };
    }
    if (existing.status === "superseded") {
      return {
        ok: false,
        status: 409,
        error: "Phase is superseded — it was split into narrower phases",
      };
    }
    if (existing.status !== "draft") {
      return {
        ok: false,
        status: 409,
        error: `Phase is ${existing.status}; start a new phase instead of reusing it`,
      };
    }
    return {
      ok: true,
      phase: existing,
      reused: true,
      description: existing.description,
    };
  }
  const phase = store.createPhase({
    projectId: project.id,
    description,
    rootPath: project.rootPath,
    dependsOn,
  });
  return { ok: true, phase, reused: false, description };
}

export type SplitPhaseResult = {
  supersededPhaseId: string;
  phases: Array<{ id: string; ordinal: number; title: string }>;
};

/**
 * Split one over-broad phase into N narrower phases.
 *
 * Marks the original phase `superseded`, interrupts any active run on it,
 * creates N fresh `draft` phases chained by `dependsOn` (the first inherits
 * the original's dependencies; each subsequent depends on the previous), and
 * re-points the original's dependents to the last sub-phase.
 */
export function splitPhase(opts: {
  store: SlopStore;
  project: { id: string; rootPath: string };
  phaseId: string;
  parts: SplitPhasePart[];
  /** Abort/cleanup hook for an interrupted run (server-side side effect). */
  interruptRun?: (runId: string) => void;
}): SplitPhaseResult {
  const { store, project, phaseId, parts } = opts;
  const original = store.getPhase(phaseId);
  if (!original || original.projectId !== project.id) {
    throw new Error("Phase not found");
  }
  if (!Array.isArray(parts) || parts.length < 2) {
    throw new Error("split_phase requires at least 2 parts");
  }
  if (original.worktreePath) {
    throw new Error(
      "Cannot split a phase with an active worktree — merge or remove it first",
    );
  }
  const unsplittable = new Set([
    "developing",
    "designing",
    "design_complete",
    "complete",
    "superseded",
  ]);
  if (unsplittable.has(original.status)) {
    throw new Error(`Cannot split a phase in status "${original.status}"`);
  }

  // 1. Supersede the original.
  original.status = "superseded";
  original.updatedAt = new Date().toISOString();
  store.updatePhase(original);
  writePhaseStatus(project.rootPath, original.id, "superseded");

  // 2. Interrupt any active run on the original, and supersede gate runs
  // (in_review / accepted / design_complete) so they don't linger as
  // "awaiting review" on a phase that is now superseded.
  for (const run of store.listRuns(project.id)) {
    if (run.phaseId !== original.id) continue;
    if (isBusyRunStage(run.stage)) {
      opts.interruptRun?.(run.id);
    }
    if (isBusyRunStage(run.stage) || isGateRunStage(run.stage)) {
      run.stage = "interrupted";
      run.updatedAt = new Date().toISOString();
      store.updateRun(run);
    }
  }

  // 3. Create sub-phases (sequential dependsOn chain).
  const created: SplitPhaseResult["phases"] = [];
  let prevId: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const description = (part.description ?? "").trim();
    if (!description) {
      throw new Error(`Part ${i + 1} has an empty description`);
    }
    const dependsOn =
      i === 0 ? (original.dependsOn ?? []) : prevId ? [prevId] : [];
    const phase = store.createPhase({
      projectId: project.id,
      description,
      rootPath: project.rootPath,
      dependsOn,
    });
    if (part.title?.trim()) {
      phase.title = part.title.trim();
      store.updatePhase(phase);
    }
    created.push({
      id: phase.id,
      ordinal: phase.ordinal ?? 0,
      title: phase.title ?? phase.description.slice(0, 80),
    });
    prevId = phase.id;
  }

  // 4. Re-point dependents of the original to the last sub-phase.
  const lastId = created[created.length - 1]!.id;
  for (const p of store.listPhases(project.id)) {
    if (p.id === original.id) continue;
    if (!p.dependsOn.includes(original.id)) continue;
    p.dependsOn = p.dependsOn.map((d) => (d === original.id ? lastId : d));
    p.updatedAt = new Date().toISOString();
    store.updatePhase(p);
  }

  // 5. Roadmap: supersede the original, add sub-phase rows.
  upsertRoadmapEntry(
    project.rootPath,
    original.id,
    original.title ?? original.description.slice(0, 80),
    "superseded",
    original.dependsOn ?? [],
  );
  for (const c of created) {
    const phase = store.getPhase(c.id);
    if (!phase) continue;
    upsertRoadmapEntry(
      project.rootPath,
      phase.id,
      phase.title ?? phase.description.slice(0, 80),
      "draft",
      phase.dependsOn ?? [],
    );
  }

  return { supersededPhaseId: original.id, phases: created };
}
