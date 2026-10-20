/**
 * REST for marketing loops. OpenClaw's dashboard calls these routes.
 * No HTML. MCP wrappers live in mcp-tools.ts.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { log, type RunStage } from "@slopcontrol/types";
import {
  abandonDesignLoop,
  abandonMarketingLoop,
  acceptMarketingLoop,
  appendRunLog,
  collectMarketingDesignBasis,
  createDesignLoopMeta,
  createMarketingLoopMeta,
  designBriefFromPack,
  formatMarketingDesignBasisBlock,
  seedMarketingDesignLoop,
  listMarketingLoops,
  listMarketingVersions,
  marketingScheduleView,
  productPhaseDescription,
  readDesignLoopMeta,
  readMarketingAcceptance,
  readMarketingDoc,
  readMarketingLoopMeta,
  readRichestMarketingFindings,
  readMarketingPack,
  readMarketingRelease,
  readMarketingVerdict,
  readLoopChatMessages,
  reopenMarketingLoop,
  scheduleMarketingRelease,
  seedMarketingAcceptance,
  summarizeMarketingLoopProgress,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
  writeMarketingLoopMeta,
  writeMarketingLoopVersion,
  writeMarketingRelease,
  type MarketingLoopAcceptanceFeature,
  type MarketingReleaseManifest,
} from "@slopcontrol/artifacts";
import {
  ensureChangeIntentAsync,
  getSlopcontrolRuntime,
  isLiveTurnInterruptedError,
} from "@slopcontrol/mastra";
import type { SlopStore } from "./store.js";
import { defaultDataDir } from "./store.js";
import {
  attachIfRunningLiveTurn,
  bindLiveTurn,
  wantsLiveStream,
  workingStubFromBound,
} from "./live-turn-http.js";
import { createLoopChatTurn } from "./loop-chat-http.js";
import { liveTurns } from "./live-turns.js";

type RunRecord = ReturnType<SlopStore["createRun"]>;

export type MarketingRouteDeps = {
  store: SlopStore;
  activeRuns: Set<string>;
  abortControllers: Map<string, AbortController>;
  touchRunStage: (runId: string, stage: RunStage) => void;
  updatePhaseStatus: (phaseId: string, status: string) => void;
};

function sliceDoc(
  doc: string | null,
  offsetRaw: unknown,
  limitRaw: unknown,
): { doc: string | null; total: number; offset: number } {
  const full = doc ?? "";
  const offset = Math.max(0, Math.floor(Number(offsetRaw ?? 0) || 0));
  const limitRawNum = Math.floor(Number(limitRaw ?? 0) || 0);
  const limit = limitRawNum > 0 ? Math.min(limitRawNum, 64_000) : 0;
  if (!full) return { doc: null, total: 0, offset: 0 };
  if (offset > 0 || limit > 0) {
    const sliced = limit > 0 ? full.slice(offset, offset + limit) : full.slice(offset);
    return { doc: sliced, total: full.length, offset };
  }
  return { doc: full, total: full.length, offset: 0 };
}

const TERMINAL_RUN_STAGES = new Set(["complete", "failed", "interrupted"]);

function existingDesignBasisBlock(
  store: SlopStore,
  projectRoot: string,
): string {
  return formatMarketingDesignBasisBlock(
    collectMarketingDesignBasis({
      projectRoot,
      dataDir: defaultDataDir(),
      listProjects: () =>
        store.listProjects().map((project) => ({
          id: project.id,
          name: project.name,
          rootPath: project.rootPath,
        })),
    }),
  );
}

function phaseIdsForTracks(
  trackIds: string[],
  trackToPhase: Map<string, string>,
): string[] {
  return trackIds
    .map((id) => trackToPhase.get(id))
    .filter((id): id is string => Boolean(id));
}

function interruptPhaseRuns(
  deps: MarketingRouteDeps,
  projectId: string,
  phaseId: string,
): void {
  for (const run of deps.store.listRuns(projectId)) {
    if (run.phaseId !== phaseId) continue;
    if (TERMINAL_RUN_STAGES.has(run.stage)) continue;
    deps.abortControllers.get(run.id)?.abort();
    deps.activeRuns.delete(run.id);
    deps.abortControllers.delete(run.id);
    deps.touchRunStage(run.id, "interrupted");
  }
}

function startReadyMarketingPhases(
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  phaseIds: string[],
): string[] {
  const runIds: string[] = [];
  for (const phaseId of phaseIds) {
    const phase = deps.store.getPhase(phaseId);
    if (!phase || (phase.dependsOn?.length ?? 0) > 0) {
      const unmet = (phase?.dependsOn ?? []).some((id) => {
        const dep = deps.store.getPhase(id);
        return !dep || dep.status !== "complete";
      });
      if (!phase || unmet) continue;
    }
    const open = deps.store.listRuns(project.id).find(
      (run) =>
        run.phaseId === phase.id &&
        (run.stage === "researching" || run.stage === "drafting" || run.stage === "idle"),
    );
    if (open && deps.activeRuns.has(open.id)) continue;
    if (
      !open &&
      phase.status !== "draft" &&
      phase.status !== "blocked" &&
      phase.status !== "interrupted"
    ) {
      continue;
    }
    const run =
      open ??
      deps.store.createRun({ phaseId: phase.id, projectId: project.id });
    runIds.push(run.id);
    startProductResearch(deps, project, phase, run);
  }
  return runIds;
}

export function registerMarketingLoopRoutes(
  app: Express,
  deps: MarketingRouteDeps,
): void {
  const { store } = deps;

  app.get("/projects/:id/marketing-loops", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const loops = listMarketingLoops(project.rootPath).map((meta) => ({
      ...meta,
      ...summarizeMarketingLoopProgress(meta),
    }));
    res.json({ loops });
  });

  app.get("/projects/:id/marketing-loops/:loopId", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    const version =
      typeof req.query.version === "string" && req.query.version.trim()
        ? Number(req.query.version)
        : meta.currentVersion;
    const full = Number.isFinite(version) && version > 0
      ? readMarketingDoc(project.rootPath, meta.id, version)
      : null;
    const sliced = sliceDoc(full, req.query.offset, req.query.limit);
    const release = readMarketingRelease(project.rootPath, meta.id);
    const progress = summarizeMarketingLoopProgress(meta);
    const scheduleView =
      meta.status === "promoted"
        ? scheduleViewForProject(deps, project, release)
        : null;
    res.json({
      loop: meta,
      loopId: meta.id,
      version: Number.isFinite(version) ? version : null,
      doc: sliced.doc,
      docTotalChars: sliced.total,
      docOffset: sliced.doc ? sliced.offset : 0,
      verdict:
        Number.isFinite(version) && version > 0
          ? readMarketingVerdict(project.rootPath, meta.id, version)
          : null,
      acceptance: readMarketingAcceptance(project.rootPath, meta.id),
      pack: readMarketingPack(project.rootPath, meta.id),
      release,
      messages: readLoopChatMessages(project.rootPath, "marketing", meta.id),
      versions: listMarketingVersions(project.rootPath, meta.id),
      liveTurn: (() => {
        const running = liveTurns.getActive("marketing_loop", meta.id);
        return running ? liveTurns.snapshot(running.turnId) : null;
      })(),
      nextStep: scheduleView?.nextStep ?? progress.nextStep,
      designReady: scheduleView?.designReady ?? false,
      readyPhaseIds: scheduleView?.readyPhaseIds ?? [],
      blockers: progress.blockers,
    });
  });

  app.post("/projects/:id/marketing-loops", async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const brief = String(req.body?.brief ?? req.body?.message ?? "").trim();
    if (!brief) {
      res.status(400).json({
        error: "brief is required",
        hint: "Pass the operator's launch request as brief.",
      });
      return;
    }
    const meta = createMarketingLoopMeta({ projectId: project.id, brief });
    writeMarketingLoopMeta(project.rootPath, meta);
    await runGenerate(req, res, deps, project, meta, {
      version: 1,
      brief,
      parentVersion: null,
    });
  });

  app.post("/projects/:id/marketing-loops/:loopId/continue", async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    let meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    if (meta.status === "abandoned") {
      res.status(409).json({
        error: "Marketing loop was discarded. Start a new marketing loop.",
        loopId: meta.id,
      });
      return;
    }
    if (meta.status !== "open") {
      meta = reopenMarketingLoop(project.rootPath, meta.id);
    }
    const message = String(req.body?.message ?? "").trim();
    if (!message) {
      res.status(400).json({ error: "message is required" });
      return;
    }
    const baseRaw = req.body?.baseVersion;
    const base =
      typeof baseRaw === "number"
        ? baseRaw
        : typeof baseRaw === "string" && baseRaw.trim()
          ? Number(baseRaw)
          : meta.currentVersion;
    if (!Number.isFinite(base) || base < 1) {
      res.status(400).json({ error: "No marketing version to continue from" });
      return;
    }
    const previousDoc = readMarketingDoc(project.rootPath, meta.id, base) ?? undefined;
    const previousFindings =
      readRichestMarketingFindings(project.rootPath, meta.id, base) ?? undefined;
    const previousVerdict = readMarketingVerdict(project.rootPath, meta.id, base);
    await runGenerate(req, res, deps, project, meta, {
      version: meta.currentVersion + 1,
      brief: meta.brief,
      message,
      previousDoc,
      previousFindings,
      previousVerdict,
      parentVersion: base,
    });
  });

  app.post("/projects/:id/marketing-loops/:loopId/stop", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    const stopped = liveTurns.stop("marketing_loop", meta.id, "operator_stop");
    if (!stopped) {
      res.status(409).json({
        error: "No active marketing-loop turn to stop",
        loopId: meta.id,
      });
      return;
    }
    res.json({ ok: true, code: "interrupted", loopId: meta.id, turnId: stopped.turnId });
  });

  app.put("/projects/:id/marketing-loops/:loopId/acceptance", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    const existing =
      readMarketingAcceptance(project.rootPath, meta.id) ??
      seedMarketingAcceptance({
        projectRoot: project.rootPath,
        loopId: meta.id,
        version: meta.currentVersion,
      });
    const ids = new Set(
      Array.isArray(req.body?.acceptedFeatureIds)
        ? req.body.acceptedFeatureIds.map(String)
        : [],
    );
    const features: MarketingLoopAcceptanceFeature[] = existing.features.map((f) =>
      ids.size ? { ...f, accepted: ids.has(f.id) || f.accepted } : f,
    );
    const next = {
      ...existing,
      features,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(project.rootPath, ".slopcontrol", "marketing-loops", meta.id, "ACCEPTANCE.json"),
      `${JSON.stringify(next, null, 2)}\n`,
      "utf-8",
    );
    res.json({ acceptance: next, loopId: meta.id });
  });

  app.post("/projects/:id/marketing-loops/:loopId/accept", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const meta = acceptMarketingLoop(
        project.rootPath,
        req.params.loopId,
        typeof req.body?.version === "number" ? req.body.version : undefined,
        {
          acceptedFeatureIds: Array.isArray(req.body?.acceptedFeatureIds)
            ? req.body.acceptedFeatureIds.map(String)
            : undefined,
          acceptAllFeatures: req.body?.acceptAllFeatures === true,
        },
      );
      res.json({
        loop: meta,
        loopId: meta.id,
        pack: readMarketingPack(project.rootPath, meta.id),
        nextStep: "marketing_loop_promote",
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const status = /not found/i.test(errMsg) ? 404 : 409;
      res.status(status).json({ error: errMsg });
    }
  });

  app.post("/projects/:id/marketing-loops/:loopId/promote", async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    if (meta.status !== "accepted" && meta.status !== "promoted") {
      res.status(409).json({
        error: "Accept the marketing loop before marketing_loop_promote",
        hint: "marketing_loop_accept",
        loopId: meta.id,
      });
      return;
    }
    if (meta.status === "promoted") {
      res.json({
        loop: meta,
        loopId: meta.id,
        designLoopId: meta.designLoopId ?? null,
        phaseIds: meta.phaseIds ?? [],
        release: readMarketingRelease(project.rootPath, meta.id),
        nextStep: summarizeMarketingLoopProgress(meta).nextStep,
      });
      return;
    }
    const version = meta.acceptedVersion ?? meta.currentVersion;
    const pack = readMarketingPack(project.rootPath, meta.id);
    if (!pack) {
      res.status(409).json({ error: "MARKETING_PACK.json missing", loopId: meta.id });
      return;
    }
    const plan = scheduleMarketingRelease(pack);
    const designBasis = existingDesignBasisBlock(store, project.rootPath);
    const designBrief = designBriefFromPack(
      pack,
      plan.surfaceTracks.map((track) => track.trackId),
      designBasis,
    );
    const design = createDesignLoopMeta({
      projectId: project.id,
      brief: designBrief,
    });
    writeDesignLoopMeta(project.rootPath, { ...design, currentVersion: 1 });
    writeDesignLoopVersion({
      projectRoot: project.rootPath,
      loopId: design.id,
      version: 1,
      html: `<!DOCTYPE html><html><body><main><p>Landing placeholder opened by marketing loop ${meta.id}. Continue this design loop to replace it.</p></main></body></html>`,
      notes: "Scaffold opened by marketing_loop_promote. Continue before accept.",
      request: designBrief,
      usedScaffold: true,
      parentVersion: null,
    });
    const seeded = seedMarketingDesignLoop({
      projectRoot: project.rootPath,
      loopId: design.id,
      projectId: project.id,
      dataDir: defaultDataDir(),
      listProjects: () =>
        store.listProjects().map((item) => ({
          id: item.id,
          name: item.name,
          rootPath: item.rootPath,
        })),
    });
    log.info("marketing-loop", "seeded design loop from existing artifacts", {
      loopId: meta.id,
      designLoopId: design.id,
      elements: seeded.importedElementIds,
      logos: seeded.basis.logos.map((logo) => logo.name),
    });

    const trackToPhase = new Map<string, string>();
    for (const row of plan.phases) {
      const phase = store.createPhase({
        projectId: project.id,
        description: productPhaseDescription(
          pack,
          pack.tracks.find((track) => track.id === row.trackId)!,
        ),
        rootPath: project.rootPath,
        dependsOn: phaseIdsForTracks(row.dependsOnTrackIds, trackToPhase),
      });
      trackToPhase.set(row.trackId, phase.id);
    }
    for (const row of plan.phases) {
      const phase = store.getPhase(trackToPhase.get(row.trackId)!);
      if (!phase) continue;
      store.updatePhase({
        ...phase,
        dependsOn: phaseIdsForTracks(row.dependsOnTrackIds, trackToPhase),
      });
    }
    const phaseIds = plan.phases.map((row) => trackToPhase.get(row.trackId)!);
    const landing = plan.landingTracks[0] ?? null;
    const manifest: MarketingReleaseManifest = {
      loopId: meta.id,
      version,
      designLoopId: design.id,
      designBrief,
      phaseIds,
      pendingLanding: landing
        ? {
            brief: landing.brief,
            dependsOnTrackIds: landing.dependsOnTrackIds,
            dependsOnPhaseIds: phaseIdsForTracks(landing.dependsOnTrackIds, trackToPhase),
          }
        : null,
      schedule: {
        phases: plan.phases.map((row) => ({
          trackId: row.trackId,
          phaseId: trackToPhase.get(row.trackId)!,
          role: row.role,
          dependsOnTrackIds: row.dependsOnTrackIds,
        })),
        surfaceTracks: plan.surfaceTracks.map((track) => ({
          trackId: track.trackId,
          dependsOnTrackIds: track.dependsOnTrackIds,
        })),
        landingTracks: plan.landingTracks,
      },
      promotedAt: new Date().toISOString(),
    };
    writeMarketingRelease(project.rootPath, meta.id, manifest);
    const promoted = {
      ...meta,
      status: "promoted" as const,
      designLoopId: design.id,
      phaseIds,
      updatedAt: new Date().toISOString(),
    };
    writeMarketingLoopMeta(project.rootPath, promoted);

    const startResearch = req.body?.startResearch !== false;
    const runIds = startResearch
      ? startReadyMarketingPhases(deps, project, phaseIds)
      : [];
    const view = scheduleViewForProject(deps, project, manifest);

    res.status(202).json({
      loop: promoted,
      loopId: promoted.id,
      designLoopId: design.id,
      phaseIds,
      pendingLanding: manifest.pendingLanding,
      runIds,
      release: manifest,
      ...view,
    });
  });

  app.post("/projects/:id/marketing-loops/:loopId/align", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    try {
      const result = alignPromotedMarketingLoop(deps, project, req.params.loopId);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = /not found/i.test(message) ? 404 : 409;
      res.status(status).json({ error: message });
    }
  });

  app.post("/projects/:id/marketing-loops/:loopId/abandon", (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readMarketingLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Marketing loop not found" });
      return;
    }
    const abandoned = abandonMarketingLoop(project.rootPath, meta.id);
    let designLoopId: string | null = null;
    if (meta.designLoopId) {
      try {
        const design = abandonDesignLoop({
          projectRoot: project.rootPath,
          loopId: meta.designLoopId,
          reason: "Marketing loop discarded",
        });
        designLoopId = design.id;
      } catch (err) {
        log.warn("marketing-loop", "design loop abandon skipped", {
          loopId: meta.id,
          designLoopId: meta.designLoopId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const supersededPhaseIds: string[] = [];
    for (const phaseId of meta.phaseIds ?? []) {
      const phase = store.getPhase(phaseId);
      if (!phase || phase.status === "complete" || phase.status === "superseded") {
        continue;
      }
      interruptPhaseRuns(deps, project.id, phaseId);
      deps.updatePhaseStatus(phaseId, "superseded");
      supersededPhaseIds.push(phaseId);
    }
    res.json({
      loop: abandoned,
      loopId: abandoned.id,
      designLoopId,
      supersededPhaseIds,
    });
  });
}

function releaseScheduleView(
  projectRoot: string,
  manifest: MarketingReleaseManifest | null,
): {
  designReady: boolean;
  readyPhaseIds: string[];
  nextStep: string;
} {
  if (!manifest?.schedule) {
    return {
      designReady: false,
      readyPhaseIds: [],
      nextStep: summarizeMarketingLoopProgress({
        id: manifest?.loopId ?? "",
        projectId: "",
        brief: "",
        status: "promoted",
        currentVersion: manifest?.version ?? 1,
        createdAt: "",
        updatedAt: "",
      }).nextStep,
    };
  }
  const phaseStatusById = new Map<string, string>();
  for (const row of manifest.schedule.phases) {
    phaseStatusById.set(row.phaseId, "draft");
  }
  const design = manifest.designLoopId
    ? readDesignLoopMeta(projectRoot, manifest.designLoopId)
    : null;
  return marketingScheduleView({
    schedule: manifest.schedule,
    phaseStatusById,
    designAccepted: design?.status === "accepted",
    designLoopId: manifest.designLoopId,
  });
}

function scheduleViewForProject(
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  manifest: MarketingReleaseManifest | null,
) {
  if (!manifest?.schedule) return releaseScheduleView(project.rootPath, manifest);
  const phaseStatusById = new Map(
    manifest.schedule.phases.map((row) => {
      const phase = deps.store.getPhase(row.phaseId);
      return [row.phaseId, phase?.status ?? "missing"] as const;
    }),
  );
  const design = manifest.designLoopId
    ? readDesignLoopMeta(project.rootPath, manifest.designLoopId)
    : null;
  return marketingScheduleView({
    schedule: manifest.schedule,
    phaseStatusById,
    designAccepted: design?.status === "accepted",
    designLoopId: manifest.designLoopId,
  });
}

function alignPromotedMarketingLoop(
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  loopId: string,
) {
  const meta = readMarketingLoopMeta(project.rootPath, loopId);
  if (!meta || meta.projectId !== project.id) {
    throw new Error("Marketing loop not found");
  }
  if (meta.status !== "promoted") {
    throw new Error("Accept and promote the marketing loop before align");
  }
  const pack = readMarketingPack(project.rootPath, meta.id);
  const release = readMarketingRelease(project.rootPath, meta.id);
  if (!pack || !release) throw new Error("MARKETING_PACK.json or RELEASE.json missing");
  const plan = scheduleMarketingRelease(pack);
  const trackToPhase = new Map<string, string>();
  if (release.schedule) {
    for (const row of release.schedule.phases) trackToPhase.set(row.trackId, row.phaseId);
  } else {
    const productTracks = pack.tracks.filter((track) => track.kind === "product");
    productTracks.forEach((track, index) => {
      const phaseId = release.phaseIds[index];
      if (phaseId) trackToPhase.set(track.id, phaseId);
    });
  }
  const planned = new Set(plan.phases.map((row) => row.trackId));
  for (const [trackId, phaseId] of [...trackToPhase]) {
    if (planned.has(trackId)) continue;
    interruptPhaseRuns(deps, project.id, phaseId);
    const phase = deps.store.getPhase(phaseId);
    if (phase && phase.status !== "superseded") {
      deps.updatePhaseStatus(phaseId, "superseded");
    }
    trackToPhase.delete(trackId);
  }
  for (const row of plan.phases) {
    const existingId = trackToPhase.get(row.trackId);
    const existing = existingId ? deps.store.getPhase(existingId) : undefined;
    const dependsOn = phaseIdsForTracks(row.dependsOnTrackIds, trackToPhase);
    const unmet = dependsOn.some((id) => deps.store.getPhase(id)?.status !== "complete");
    const premature =
      existing &&
      unmet &&
      existing.status !== "draft" &&
      existing.status !== "blocked" &&
      existing.status !== "interrupted" &&
      existing.status !== "superseded";
    if (!existing || existing.status === "superseded" || premature) {
      if (existing && existing.status !== "superseded") {
        interruptPhaseRuns(deps, project.id, existing.id);
        deps.updatePhaseStatus(existing.id, "superseded");
      }
      const created = deps.store.createPhase({
        projectId: project.id,
        description: productPhaseDescription(
          pack,
          pack.tracks.find((track) => track.id === row.trackId) ?? {
            id: row.trackId,
            kind: "product",
            brief: row.brief,
            claimIds: [],
            dependsOn: row.dependsOnTrackIds,
          },
        ),
        rootPath: project.rootPath,
        dependsOn,
      });
      trackToPhase.set(row.trackId, created.id);
      continue;
    }
    deps.store.updatePhase({ ...existing, dependsOn });
    trackToPhase.set(row.trackId, existing.id);
  }
  const phaseIds = plan.phases.map((row) => trackToPhase.get(row.trackId)!);
  const designBasis = existingDesignBasisBlock(deps.store, project.rootPath);
  const designBrief = designBriefFromPack(
    pack,
    plan.surfaceTracks.map((track) => track.trackId),
    designBasis,
  );
  if (release.designLoopId) {
    const design = readDesignLoopMeta(project.rootPath, release.designLoopId);
    if (design && design.status !== "abandoned") {
      writeDesignLoopMeta(project.rootPath, {
        ...design,
        brief: designBrief,
        updatedAt: new Date().toISOString(),
      });
      seedMarketingDesignLoop({
        projectRoot: project.rootPath,
        loopId: design.id,
        projectId: project.id,
        dataDir: defaultDataDir(),
        listProjects: () =>
          deps.store.listProjects().map((item) => ({
            id: item.id,
            name: item.name,
            rootPath: item.rootPath,
          })),
      });
    }
  }
  const landing = plan.landingTracks[0] ?? null;
  const manifest: MarketingReleaseManifest = {
    ...release,
    designBrief,
    phaseIds,
    pendingLanding: landing
      ? {
          brief: landing.brief,
          dependsOnTrackIds: landing.dependsOnTrackIds,
          dependsOnPhaseIds: phaseIdsForTracks(landing.dependsOnTrackIds, trackToPhase),
        }
      : null,
    schedule: {
      phases: plan.phases.map((row) => ({
        trackId: row.trackId,
        phaseId: trackToPhase.get(row.trackId)!,
        role: row.role,
        dependsOnTrackIds: row.dependsOnTrackIds,
      })),
      surfaceTracks: plan.surfaceTracks.map((track) => ({
        trackId: track.trackId,
        dependsOnTrackIds: track.dependsOnTrackIds,
      })),
      landingTracks: plan.landingTracks.map((track) => ({
        ...track,
        phaseId: release.schedule?.landingTracks.find((row) => row.trackId === track.trackId)
          ?.phaseId,
      })),
    },
  };
  writeMarketingRelease(project.rootPath, meta.id, manifest);
  const promoted = {
    ...meta,
    phaseIds,
    updatedAt: new Date().toISOString(),
  };
  writeMarketingLoopMeta(project.rootPath, promoted);
  const runIds = startReadyMarketingPhases(deps, project, phaseIds);
  return {
    loop: promoted,
    loopId: meta.id,
    designLoopId: manifest.designLoopId ?? null,
    phaseIds,
    pendingLanding: manifest.pendingLanding,
    runIds,
    release: manifest,
    supersededPhaseIds: release.phaseIds.filter((id) => !phaseIds.includes(id)),
    ...scheduleViewForProject(deps, project, manifest),
  };
}

export function advanceMarketingReleaseOnPhaseComplete(
  deps: MarketingRouteDeps,
  phase: NonNullable<ReturnType<SlopStore["getPhase"]>>,
): void {
  const project = deps.store.getProject(phase.projectId);
  if (!project) return;
  for (const meta of listMarketingLoops(project.rootPath)) {
    if (meta.status !== "promoted" || meta.projectId !== project.id) continue;
    const release = readMarketingRelease(project.rootPath, meta.id);
    if (!release?.schedule?.phases.some((row) => row.phaseId === phase.id)) continue;
    const view = scheduleViewForProject(deps, project, release);
    startReadyMarketingPhases(deps, project, view.readyPhaseIds);
  }
}

export function materializeMarketingLandingPhases(
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  designLoopId: string,
): string[] {
  const created: string[] = [];
  for (const meta of listMarketingLoops(project.rootPath)) {
    if (meta.projectId !== project.id || meta.designLoopId !== designLoopId) continue;
    const release = readMarketingRelease(project.rootPath, meta.id);
    const pack = readMarketingPack(project.rootPath, meta.id);
    if (!release?.schedule || !pack) continue;
    const design = readDesignLoopMeta(project.rootPath, designLoopId);
    if (design?.status !== "accepted") continue;
    const trackToPhase = new Map(
      release.schedule.phases.map((row) => [row.trackId, row.phaseId]),
    );
    const landingTracks = release.schedule.landingTracks.map((track) => {
      if (track.phaseId && deps.store.getPhase(track.phaseId)) return track;
      const phase = deps.store.createPhase({
        projectId: project.id,
        description: productPhaseDescription(
          pack,
          pack.tracks.find((row) => row.id === track.trackId) ?? {
            id: track.trackId,
            kind: "landing",
            brief: track.brief,
            claimIds: [],
            dependsOn: track.dependsOnTrackIds,
          },
        ),
        rootPath: project.rootPath,
        dependsOn: phaseIdsForTracks(track.dependsOnTrackIds, trackToPhase),
      });
      created.push(phase.id);
      return { ...track, phaseId: phase.id };
    });
    const phaseIds = [
      ...release.schedule.phases.map((row) => row.phaseId),
      ...landingTracks.map((track) => track.phaseId).filter((id): id is string => Boolean(id)),
    ];
    const manifest: MarketingReleaseManifest = {
      ...release,
      phaseIds,
      schedule: { ...release.schedule, landingTracks },
    };
    writeMarketingRelease(project.rootPath, meta.id, manifest);
    writeMarketingLoopMeta(project.rootPath, {
      ...meta,
      phaseIds,
      updatedAt: new Date().toISOString(),
    });
    startReadyMarketingPhases(deps, project, created);
  }
  return created;
}

function startProductResearch(
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  phase: NonNullable<ReturnType<SlopStore["getPhase"]>>,
  run: RunRecord,
): void {
  deps.touchRunStage(run.id, "researching");
  deps.updatePhaseStatus(phase.id, "draft");
  deps.activeRuns.add(run.id);
  const ac = new AbortController();
  deps.abortControllers.set(run.id, ac);
  void (async () => {
    try {
      const { orchestrator, registry } = getSlopcontrolRuntime(
        defaultDataDir(),
        project.rootPath,
      );
      await ensureChangeIntentAsync(project.rootPath, phase.id, phase.description, {
        registry,
      });
      const stage = await orchestrator.startResearch({
        project,
        phase: deps.store.getPhase(phase.id) ?? phase,
        run: deps.store.getRun(run.id) ?? run,
        description: phase.description,
        listProjects: () => deps.store.listProjects(),
        onStage: (s) => deps.touchRunStage(run.id, s),
      });
      deps.touchRunStage(run.id, stage);
      deps.updatePhaseStatus(phase.id, stage === "in_review" ? "in_review" : "draft");
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("marketing-loop", "promote research failed", {
        projectId: project.id,
        phaseId: phase.id,
        runId: run.id,
        error: errMsg,
      });
      appendRunLog(project.rootPath, run.id, `marketing_loop_promote research failed: ${errMsg}`);
      deps.touchRunStage(run.id, "failed");
      deps.updatePhaseStatus(phase.id, "draft");
    } finally {
      deps.activeRuns.delete(run.id);
      deps.abortControllers.delete(run.id);
    }
  })();
}

async function runGenerate(
  req: Request,
  res: Response,
  deps: MarketingRouteDeps,
  project: NonNullable<ReturnType<SlopStore["getProject"]>>,
  meta: NonNullable<ReturnType<typeof readMarketingLoopMeta>>,
  turn: {
    version: number;
    brief: string;
    message?: string;
    previousDoc?: string;
    previousFindings?: string;
    previousVerdict?: ReturnType<typeof readMarketingVerdict>;
    parentVersion: number | null;
  },
): Promise<void> {
  try {
    const { orchestrator } = getSlopcontrolRuntime(defaultDataDir(), project.rootPath);
    if (attachIfRunningLiveTurn(req, res, "marketing_loop", meta.id)) return;
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "marketing_loop",
      projectId: project.id,
      sessionId: meta.id,
      res,
      stream,
    });
    const chat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "marketing",
      loopId: meta.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    chat.appendUser(turn.message?.trim() || turn.brief);
    let generated;
    try {
      generated = await orchestrator.marketingLoopGenerate({
        project,
        loopId: meta.id,
        brief: turn.brief,
        message: turn.message,
        previousDoc: turn.previousDoc,
        previousFindings: turn.previousFindings,
        previousVerdict: turn.previousVerdict,
        version: turn.version,
        dataDir: defaultDataDir(),
        listProjects: () =>
          deps.store.listProjects().map((item) => ({
            id: item.id,
            name: item.name,
            rootPath: item.rootPath,
          })),
        abortSignal: bound.signal,
        onProgress: chat.onProgress,
      });
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason = liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const recovery = `Marketing generate interrupted (${reason}). Call marketing_loop_continue.`;
        chat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, { loopId: meta.id, reply: recovery });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", { partialReply: recovery });
        res.status(499).json({ error: "interrupted", loopId: meta.id, reply: recovery });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");
    writeMarketingLoopVersion({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version: turn.version,
      doc: generated.doc,
      notes: generated.notes,
      findings: generated.findings,
      request: turn.message?.trim() || turn.brief,
      verdict: generated.verdict,
      usedScaffold: generated.usedScaffold,
      error: generated.usedScaffold ? generated.notes : undefined,
      parentVersion: turn.parentVersion,
    });
    const acceptance =
      readMarketingAcceptance(project.rootPath, meta.id) ??
      seedMarketingAcceptance({
        projectRoot: project.rootPath,
        loopId: meta.id,
        version: turn.version,
      });
    const next = {
      ...meta,
      currentVersion: turn.version,
      status: "open" as const,
      updatedAt: new Date().toISOString(),
    };
    writeMarketingLoopMeta(project.rootPath, next);
    const reply = generated.reply || generated.notes;
    const messages = chat.finalizeAssistant(reply, { version: turn.version });
    const payload = {
      loop: next,
      loopId: next.id,
      version: turn.version,
      doc: generated.doc,
      docTotalChars: generated.doc.length,
      docOffset: 0,
      notes: generated.notes,
      reply,
      messages,
      usedScaffold: generated.usedScaffold,
      verdict: generated.verdict,
      acceptance,
      nextStep: summarizeMarketingLoopProgress(next).nextStep,
    };
    if (stream) {
      bound.completeDone(payload);
      return;
    }
    res.status(turn.version === 1 ? 201 : 200).json(payload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("marketing-loop", "generate failed", {
      projectId: project.id,
      loopId: meta.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loopId: meta.id });
  }
}
