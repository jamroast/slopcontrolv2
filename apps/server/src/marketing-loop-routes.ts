/**
 * REST for marketing loops. OpenClaw's dashboard calls these routes.
 * No HTML. MCP wrappers live in mcp-tools.ts.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { log, type RunStage } from "@slopcontrol/types";
import {
  acceptMarketingLoop,
  appendRunLog,
  createDesignLoopMeta,
  createMarketingLoopMeta,
  designBriefFromPack,
  listMarketingLoops,
  listMarketingVersions,
  productPhaseDescription,
  readMarketingAcceptance,
  readMarketingDoc,
  readMarketingLoopMeta,
  readMarketingPack,
  readMarketingRelease,
  readMarketingVerdict,
  readLoopChatMessages,
  reopenMarketingLoop,
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
    const progress = summarizeMarketingLoopProgress(meta);
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
      release: readMarketingRelease(project.rootPath, meta.id),
      messages: readLoopChatMessages(project.rootPath, "marketing", meta.id),
      versions: listMarketingVersions(project.rootPath, meta.id),
      nextStep: progress.nextStep,
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
    const previousVerdict = readMarketingVerdict(project.rootPath, meta.id, base);
    await runGenerate(req, res, deps, project, meta, {
      version: meta.currentVersion + 1,
      brief: meta.brief,
      message,
      previousDoc,
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
    const designBrief = designBriefFromPack(pack);
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

    const productTracks = pack.tracks.filter((t) => t.kind === "product");
    const trackToPhase = new Map<string, string>();
    const created: Array<{ trackId: string; phaseId: string; dependsOn: string[] }> = [];
    for (const track of productTracks) {
      const phase = store.createPhase({
        projectId: project.id,
        description: productPhaseDescription(pack, track),
        rootPath: project.rootPath,
      });
      trackToPhase.set(track.id, phase.id);
      created.push({
        trackId: track.id,
        phaseId: phase.id,
        dependsOn: track.dependsOn,
      });
    }
    for (const row of created) {
      const dependsOn = row.dependsOn
        .map((id) => trackToPhase.get(id))
        .filter((id): id is string => Boolean(id));
      if (!dependsOn.length) continue;
      const phase = store.getPhase(row.phaseId);
      if (phase) store.updatePhase({ ...phase, dependsOn });
    }

    const landing = pack.tracks.find((t) => t.kind === "landing") ?? null;
    const phaseIds = created.map((row) => row.phaseId);
    const manifest: MarketingReleaseManifest = {
      loopId: meta.id,
      version,
      designLoopId: design.id,
      designBrief,
      phaseIds,
      pendingLanding: landing
        ? {
            brief: landing.brief,
            dependsOnTrackIds: landing.dependsOn,
            dependsOnPhaseIds: landing.dependsOn
              .map((id) => trackToPhase.get(id))
              .filter((id): id is string => Boolean(id)),
          }
        : null,
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
    const runIds: string[] = [];
    if (startResearch) {
      for (const row of created) {
        const phase = store.getPhase(row.phaseId);
        if (!phase || (phase.dependsOn?.length ?? 0) > 0) continue;
        const run = store.createRun({ phaseId: phase.id, projectId: project.id });
        runIds.push(run.id);
        startProductResearch(deps, project, phase, run);
      }
    }

    res.status(202).json({
      loop: promoted,
      loopId: promoted.id,
      designLoopId: design.id,
      phaseIds,
      pendingLanding: manifest.pendingLanding,
      runIds,
      release: manifest,
      nextStep:
        "design_loop_continue on designLoopId to replace the landing placeholder. Unblocked product-gap phases are researching when startResearch is not false. The landing implementation phase stays pending until that design is accepted.",
    });
  });
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
    previousVerdict?: ReturnType<typeof readMarketingVerdict>;
    parentVersion: number | null;
  },
): Promise<void> {
  try {
    const { orchestrator } = getSlopcontrolRuntime(defaultDataDir(), project.rootPath);
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
        previousVerdict: turn.previousVerdict,
        version: turn.version,
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
