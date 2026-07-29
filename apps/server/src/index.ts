import "./load-env.js";

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import cors from "cors";
import express from "express";
import {
  readPhaseDoc,
  readResearch,
  readRunLog,
  appendRunLog,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  probeMastraDbFile,
  phaseNeedsDesign,
  isDesignComplete,
  readProjectConfig,
  readUiSpec,
  readRunHandoff,
  readLatestHandoffForPhase,
  handoffSummary,
  buildAskTaskDescription,
  writeAskArtifacts,
  writeAgentArtifacts,
} from "@slopcontrol/artifacts";
import {
  checkoutProjectBranch,
  getProjectGitStatus,
  listConflicts,
  listPhaseWorktrees,
  mergePhaseWorktree,
  removePhaseWorktree,
  resolveConflicts,
} from "@slopcontrol/coding-tools";
import { loadEndpointsConfig } from "@slopcontrol/llm";
import { getSlopcontrolRuntime } from "@slopcontrol/mastra";
import { ObsidianSync } from "@slopcontrol/obsidian";
import { RunActionSchema, ASK_SUB_RESEARCH_MAX_TOPICS, formatDurationMs, log, recordStageTransition, unmetPhaseDependencies, type Run, type RunStage } from "@slopcontrol/types";
import { mountMcpHttp } from "./mcp-http.js";
import { createStore, defaultDataDir } from "./store.js";
import { DevelopLock } from "./develop-lock.js";

const PORT = Number(process.env.SLOPCONTROL_PORT ?? 3020);
const app = express();
const store = createStore();
const activeRuns = new Set<string>();
const abortControllers = new Map<string, AbortController>();
/** One live develop (design→develop / retry) job per project. */
const developLock = new DevelopLock((runId) => activeRuns.has(runId));

app.use(cors());
app.use(express.json());
mountMcpHttp(app);

app.use((req, res, next) => {
  // Skip noisy polling endpoints at info; still log at debug.
  const quiet =
    req.path === "/health" ||
    req.path.endsWith("/stream") ||
    (req.method === "GET" &&
      (req.path.startsWith("/runs/") ||
        req.path.includes("/phases") ||
        req.path === "/runs" ||
        req.path === "/projects" ||
        req.path === "/config/endpoints"));

  const started = Date.now();
  if (!quiet) {
    log.info("http", `${req.method} ${req.path}`, {
      query: Object.keys(req.query).length ? req.query : undefined,
      action: typeof req.body?.action === "string" ? req.body.action : undefined,
      projectId:
        typeof req.body?.projectId === "string"
          ? req.body.projectId
          : typeof req.params?.id === "string"
            ? req.params.id
            : undefined,
    });
  } else {
    log.debug("http", `${req.method} ${req.path}`);
  }

  res.on("finish", () => {
    const meta = {
      status: res.statusCode,
      durationMs: Date.now() - started,
    };
    if (!quiet || res.statusCode >= 400) {
      const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
      log[level]("http", `${req.method} ${req.path} → ${res.statusCode}`, meta);
    } else {
      log.debug("http", `${req.method} ${req.path} → ${res.statusCode}`, meta);
    }
  });
  next();
});

function getRuntime(projectRoot: string) {
  return getSlopcontrolRuntime(defaultDataDir(), projectRoot);
}

function touchRunStage(runId: string, stage: RunStage, iterationCount?: number): void {
  const run = store.getRun(runId);
  if (!run) return;

  const previous = run.stage;
  recordStageTransition(run, stage);

  if (typeof iterationCount === "number") {
    run.iterationCount = iterationCount;
  }
  store.updateRun(run);

  if (previous !== stage) {
    log.info("run", `stage ${previous} → ${stage}`, {
      runId,
      projectId: run.projectId,
      phaseId: run.phaseId,
      iterationCount: run.iterationCount,
    });
  }

  const project = store.getProject(run.projectId);
  if (!project || previous === stage) return;

  const timings = run.stageTimings ?? [];
  for (let i = timings.length - 1; i >= 0; i--) {
    const t = timings[i];
    if (t && t.stage === previous && t.endedAt != null && t.durationMs != null) {
      appendRunLog(
        project.rootPath,
        runId,
        `[timing] ${previous} → ${stage} (${formatDurationMs(t.durationMs)})`,
      );
      break;
    }
  }

  if (run.finishedAt && run.totalDurationMs != null) {
    appendRunLog(
      project.rootPath,
      runId,
      `[timing] run finished in ${formatDurationMs(run.totalDurationMs)} (stage=${stage})`,
    );
    log.info("run", "finished", {
      runId,
      stage,
      duration: formatDurationMs(run.totalDurationMs),
    });
  }
}

function updatePhaseStatus(phaseId: string, status: string): void {
  const phase = store.getPhase(phaseId);
  if (!phase) return;
  phase.status = status as typeof phase.status;
  phase.updatedAt = new Date().toISOString();
  store.updatePhase(phase);
}

/**
 * Fire-and-forget background job. HTTP returns immediately so SSE can stream.
 * Pass developProjectId when this job holds the per-project develop lock.
 */
function runInBackground(
  runId: string,
  work: (signal: AbortSignal) => Promise<void>,
  opts?: { developProjectId?: string },
): void {
  const controller = new AbortController();
  abortControllers.set(runId, controller);
  activeRuns.add(runId);
  const started = Date.now();
  log.info("bg", "job started", { runId, activeRuns: activeRuns.size });

  void (async () => {
    try {
      if (controller.signal.aborted) {
        log.warn("bg", "job aborted before start", { runId });
        touchRunStage(runId, "interrupted");
        const run = store.getRun(runId);
        if (run) updatePhaseStatus(run.phaseId, "interrupted");
        return;
      }
      await work(controller.signal);
      log.info("bg", "job finished", {
        runId,
        durationMs: Date.now() - started,
        duration: formatDurationMs(Date.now() - started),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = controller.signal.aborted;
      log.error("bg", "job failed", {
        runId,
        durationMs: Date.now() - started,
        error: message,
        aborted,
      });
      const run = store.getRun(runId);
      if (run) {
        const project = store.getProject(run.projectId);
        if (project) {
          const { appendRunLog } = await import("@slopcontrol/artifacts");
          appendRunLog(project.rootPath, runId, `ERROR: ${message}`);
          // If it's a fetch error, add troubleshooting context
          if (message.includes("fetch") || message.includes("ECONNREFUSED") || message.includes("[object Request]")) {
            appendRunLog(project.rootPath, runId,
              `This likely means OpenCode or the LLM endpoint is unreachable (or a broken custom fetch). ` +
              `Check: 1) OpenCode at the URL in the ERROR line (shared :4096 or per-project :4100+), 2) Ollama Cloud authenticated, 3) endpoints.json roles.coding. ` +
              `If the error is "Failed to parse URL from [object Request]", rebuild @slopcontrol/coding-tools (use setGlobalDispatcher, not a custom SDK fetch).`);
          }
        }
        if (aborted) {
          touchRunStage(runId, "interrupted");
          updatePhaseStatus(run.phaseId, "interrupted");
        } else {
          touchRunStage(runId, "failed");
        }
      } else {
        touchRunStage(runId, aborted ? "interrupted" : "failed");
      }
    } finally {
      activeRuns.delete(runId);
      abortControllers.delete(runId);
      if (opts?.developProjectId) {
        developLock.release(opts.developProjectId, runId);
      }
      log.debug("bg", "job cleaned up", { runId, activeRuns: activeRuns.size });
    }
  })();
}

function rejectIfDevelopInProgress(
  res: { status: (code: number) => { json: (body: unknown) => void } },
  projectId: string,
): boolean {
  const blockingRunId = developLock.getLiveClaim(projectId);
  if (!blockingRunId) return false;
  const blocking = store.getRun(blockingRunId);
  res.status(409).json({
    error: "development_in_progress",
    message:
      "Another develop job is already running for this project. Wait for it to finish or stop_run, then retry.",
    blockingRunId,
    blockingPhaseId: blocking?.phaseId,
    blockingStage: blocking?.stage,
  });
  return true;
}

app.get("/health", (_req, res) => {
  const dataDir = defaultDataDir();
  const mastraPath = join(dataDir, "mastra.db");
  const mastraStorage = probeMastraDbFile(mastraPath);
  res.json({
    ok: true,
    projects: store.listProjects().length,
    activeRuns: activeRuns.size,
    dataDir,
    mastraStorage,
    mcp: { path: "/mcp", transport: "streamable-http" },
  });
});

// ===== Runs list (for dashboard) =====

function buildRunPayload(run: Run) {
  const project = store.getProject(run.projectId);
  const phase = store.getPhase(run.phaseId);
  if (!project) return null;

  let devOutput = "";
  const logPath = join(project.rootPath, ".slopcontrol", "runs", run.id, "log.txt");
  if (existsSync(logPath)) {
    devOutput = readFileSync(logPath, "utf-8");
  }

  // Also read phase doc for review stage
  let phaseDoc = "";
  if (phase) {
    phaseDoc = readPhaseDoc(project.rootPath, phase.id);
  }

  const diagnosis =
    readDiagnosis(project.rootPath, run.id) ??
    (phase ? readLatestDiagnosisForPhase(project.rootPath, phase.id) : null);
  const handoff =
    readRunHandoff(project.rootPath, run.id) ??
    (phase ? readLatestHandoffForPhase(project.rootPath, phase.id) : null);

  return {
    id: run.id,
    idea: phase?.description ?? "",
    project_dir: project.rootPath,
    stage: run.stage,
    research_output: phase ? safeReadResearch(project.rootPath, phase.id) : "",
    dev_output: devOutput,
    phase_doc: phaseDoc,
    phase_id: phase?.id ?? null,
    phase_depends_on: phase?.dependsOn ?? [],
    phase_deps_unmet: phase
      ? unmetPhaseDependencies(phase, store.listPhases(run.projectId))
      : [],
    project_id: run.projectId,
    iteration_count: run.iterationCount,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
    started_at: run.startedAt ?? null,
    finished_at: run.finishedAt ?? null,
    total_duration_ms: run.totalDurationMs ?? null,
    total_duration: formatDurationMs(run.totalDurationMs),
    stage_timings: (run.stageTimings ?? []).map((t) => ({
      stage: t.stage,
      started_at: t.startedAt,
      ended_at: t.endedAt ?? null,
      duration_ms: t.durationMs ?? null,
      duration: formatDurationMs(t.durationMs),
    })),
    researchRunning: activeRuns.has(run.id),
    devRunning: activeRuns.has(run.id),
    diagnosis,
    handoff: handoffSummary(handoff),
    operator_suggestions: diagnosis
      ? {
          audience: diagnosis.audience,
          actions: diagnosis.operatorActions,
          class: diagnosis.class,
          title: diagnosis.title,
          codingAgentShouldFix: diagnosis.codingAgentShouldFix,
        }
      : null,
  };
}

function safeReadResearch(projectRoot: string, phaseId: string): string {
  try { return readResearch(projectRoot, phaseId); } catch { return ""; }
}

app.get("/runs", (req, res) => {
  const projectId = String(req.query.projectId ?? "");
  if (!projectId) {
    res.status(400).json({
      error: "projectId query parameter is required (runs are project-scoped)",
    });
    return;
  }
  if (!store.getProject(projectId)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const runs = store.listRuns(projectId);
  const payloads = runs.map(buildRunPayload).filter(Boolean);
  res.json({ runs: payloads });
});

app.get("/projects/:id/runs", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const runs = store.listRuns(project.id);
  const payloads = runs.map(buildRunPayload).filter(Boolean);
  res.json({ runs: payloads });
});

app.post("/projects/open", async (req, res) => {
  const rootPath = String(req.body?.rootPath ?? "");
  const name = String(req.body?.name ?? "").trim() || undefined;
  const intent = String(req.body?.intent ?? "").trim() || undefined;
  const forceRefresh = Boolean(req.body?.forceRefresh);
  if (!rootPath) {
    res.status(400).json({ error: "rootPath is required" });
    return;
  }

  try {
    const project = store.createProject({
      name: name ?? rootPath.split("/").filter(Boolean).pop() ?? "Project",
      rootPath,
    });
    const { orchestrator } = getRuntime(project.rootPath);
    const result = await orchestrator.openProject({
      project,
      forceRefresh,
      intent,
    });
    if (result.blueprintStatus !== "needs_intent") {
      const stored = store.getProject(project.id);
      if (stored) {
        stored.blueprintVersion = (stored.blueprintVersion ?? 0) + 1;
        stored.updatedAt = new Date().toISOString();
        store.updateProject(stored);
      }
    }
    res.json({
      project: store.getProject(project.id),
      ...result,
    });
  } catch (error) {
    log.error("open_project", "failed", {
      rootPath,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/projects", (_req, res) => {
  res.json({ projects: store.listProjects() });
});

/**
 * Delete/unregister a project from SlopControl.
 * Query: purgeArtifacts=true removes only <root>/.slopcontrol (never the whole tree).
 * Query/body rootPath resolves the project when :id is omitted (DELETE /projects?rootPath=…).
 */
app.delete(["/projects", "/projects/:id"], (req, res) => {
  const idParam = String(req.params.id ?? "").trim();
  const rootPath = String(
    req.query.rootPath ?? (req.body as { rootPath?: string } | undefined)?.rootPath ?? "",
  ).trim();
  const purgeRaw =
    req.query.purgeArtifacts ??
    (req.body as { purgeArtifacts?: boolean | string } | undefined)?.purgeArtifacts;
  const purgeArtifacts =
    purgeRaw === true ||
    String(purgeRaw ?? "")
      .toLowerCase() === "true";

  let project = idParam ? store.getProject(idParam) : undefined;
  if (!project && rootPath) {
    project = store.findProjectByRootPath(rootPath);
  }
  if (!project) {
    res.status(404).json({
      error: "Project not found (provide :id or rootPath)",
    });
    return;
  }

  for (const run of store.listRuns(project.id)) {
    abortControllers.get(run.id)?.abort();
    activeRuns.delete(run.id);
    abortControllers.delete(run.id);
  }
  developLock.clearProject(project.id);

  const result = store.deleteProject(project.id);

  const worktreeRoot = join(defaultDataDir(), "worktrees", project.id);
  let worktreesRemoved = false;
  if (existsSync(worktreeRoot)) {
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
      worktreesRemoved = true;
    } catch (error) {
      log.warn("delete_project", "worktree cleanup failed", {
        projectId: project.id,
        worktreeRoot,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  let artifactsPurged = false;
  if (purgeArtifacts) {
    const artifactsDir = join(project.rootPath, ".slopcontrol");
    if (existsSync(artifactsDir)) {
      try {
        rmSync(artifactsDir, { recursive: true, force: true });
        artifactsPurged = true;
      } catch (error) {
        log.warn("delete_project", "artifact purge failed", {
          projectId: project.id,
          artifactsDir,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  log.info("delete_project", "deleted", {
    projectId: project.id,
    name: project.name,
    rootPath: project.rootPath,
    phasesRemoved: result.phasesRemoved,
    runsRemoved: result.runsRemoved,
    worktreesRemoved,
    artifactsPurged,
  });

  res.json({
    deleted: true,
    project: result.project,
    phasesRemoved: result.phasesRemoved,
    runsRemoved: result.runsRemoved,
    worktreesRemoved,
    artifactsPurged,
  });
});

app.post("/projects/reinit", async (req, res) => {
  const projectId = String(req.body?.projectId ?? "").trim();
  const rootPath = String(req.body?.rootPath ?? "").trim();
  const notes = String(req.body?.notes ?? "").trim() || undefined;

  try {
    let project = projectId ? store.getProject(projectId) : undefined;
    if (!project && rootPath) {
      project = store.findProjectByRootPath(rootPath);
      if (!project) {
        project = store.createProject({
          name: rootPath.split("/").filter(Boolean).pop() ?? "Project",
          rootPath,
        });
      }
    }
    if (!project) {
      res.status(400).json({
        error: "projectId or rootPath is required",
      });
      return;
    }

    // Abort any active runs for this project
    for (const run of store.listRuns(project.id)) {
      abortControllers.get(run.id)?.abort();
      activeRuns.delete(run.id);
    }
    developLock.clearProject(project.id);

    const cleared = store.clearProjectWork(project.id);
    const { orchestrator } = getRuntime(project.rootPath);
    const result = await orchestrator.reinitProject({ project, notes });

    const stored = store.getProject(project.id);
    if (stored) {
      stored.blueprintVersion = (stored.blueprintVersion ?? 0) + 1;
      stored.updatedAt = new Date().toISOString();
      store.updateProject(stored);
    }

    res.json({
      project: store.getProject(project.id),
      cleared,
      ...result,
    });
  } catch (error) {
    log.error("reinit_project", "failed", {
      projectId,
      rootPath,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/projects", (req, res) => {
  const name = String(req.body?.name ?? "Untitled Project");
  const rootPath = String(req.body?.rootPath ?? "");
  if (!rootPath) {
    res.status(400).json({ error: "rootPath is required" });
    return;
  }
  const project = store.createProject({ name, rootPath });
  res.status(201).json({ project });
});

app.get("/projects/:id/phases", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ phases: store.listPhases(project.id) });
});

app.get("/projects/:id/asks", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const asks = store.listAsks(project.id).map((ask) => ({
    id: ask.id,
    title: ask.title,
    status: ask.status,
    updatedAt: ask.updatedAt,
    createdAt: ask.createdAt,
    messageCount: ask.messages.length,
    promotedPhaseId: ask.promotedPhaseId,
  }));
  res.json({ projectId: project.id, asks });
});

app.get("/projects/:id/asks/:askId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const ask = store.getAsk(req.params.askId);
  if (!ask || ask.projectId !== project.id) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  res.json({ ask });
});

app.post("/projects/:id/asks", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  let askId =
    typeof req.body?.askId === "string" ? req.body.askId.trim() : "";

  const now = new Date().toISOString();
  const userMsg = { role: "user" as const, content: message, at: now };

  let ask = askId ? store.getAsk(askId) : undefined;
  if (askId && (!ask || ask.projectId !== project.id)) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  if (ask && ask.status === "promoted") {
    res.status(409).json({
      error: "Ask already promoted; start a new ask or use the promoted phase",
      promotedPhaseId: ask.promotedPhaseId,
    });
    return;
  }

  if (!ask) {
    ask = store.createAsk({
      projectId: project.id,
      title: title || message.slice(0, 80),
      firstMessage: userMsg,
    });
    askId = ask.id;
  } else {
    if (title && !ask.title) {
      ask.title = title;
      store.updateAsk(ask);
    }
    ask = store.appendAskMessage(ask.id, userMsg) ?? ask;
  }

  const history = ask.messages
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const { reply } = await orchestrator.askTurn({
      project,
      askId: ask.id,
      message,
      history,
    });
    const assistantMsg = {
      role: "assistant" as const,
      content: reply,
      at: new Date().toISOString(),
    };
    ask = store.appendAskMessage(ask.id, assistantMsg) ?? ask;
    writeAskArtifacts(project.rootPath, ask);
    res.json({ ask, reply });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("ask", "ask turn failed", {
      projectId: project.id,
      askId: ask.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, ask });
  }
});

app.post("/projects/:id/asks/:askId/promote", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const ask = store.getAsk(req.params.askId);
  if (!ask || ask.projectId !== project.id) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  if (ask.status === "promoted" && ask.promotedPhaseId) {
    const existing = store.getPhase(ask.promotedPhaseId);
    res.status(409).json({
      error: "Ask already promoted",
      ask,
      phase: existing,
    });
    return;
  }
  if (ask.messages.length === 0) {
    res.status(400).json({ error: "Ask has no messages to promote" });
    return;
  }

  const descriptionOverride =
    typeof req.body?.description === "string"
      ? req.body.description.trim()
      : undefined;
  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? req.body.dependsOn.map(String).filter(Boolean)
    : undefined;

  const description = buildAskTaskDescription(ask, {
    descriptionOverride,
  });

  const phase = store.createPhase({
    projectId: project.id,
    description,
    rootPath: project.rootPath,
    dependsOn,
  });
  const run = store.createRun({ phaseId: phase.id, projectId: project.id });
  touchRunStage(run.id, "researching");
  updatePhaseStatus(phase.id, "draft");
  store.markAskPromoted(ask.id, phase.id);
  const promoted = store.getAsk(ask.id) ?? ask;
  writeAskArtifacts(project.rootPath, promoted);

  void import("@slopcontrol/artifacts").then(({ upsertRoadmapEntry }) => {
    upsertRoadmapEntry(
      project.rootPath,
      phase.id,
      phase.title ?? phase.description.slice(0, 80),
      "draft",
      phase.dependsOn ?? [],
    );
  });

  runInBackground(run.id, async () => {
    const { orchestrator } = getRuntime(project.rootPath);
    touchRunStage(run.id, "drafting");
    const stage = await orchestrator.startResearch({
      project,
      phase: store.getPhase(phase.id) ?? phase,
      run: store.getRun(run.id) ?? run,
      description,
    });
    touchRunStage(run.id, stage);
    updatePhaseStatus(
      phase.id,
      stage === "in_review"
        ? "in_review"
        : stage === "failed"
          ? "blocked"
          : "draft",
    );
  });

  res.status(202).json({
    ask: store.getAsk(ask.id),
    phase: store.getPhase(phase.id),
    run: store.getRun(run.id),
    stage: "researching",
    accepted: true,
  });
});

app.post("/projects/:id/asks/:askId/sub-research", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const ask = store.getAsk(req.params.askId);
  if (!ask || ask.projectId !== project.id) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  if (ask.status === "promoted") {
    res.status(409).json({
      error: "Ask already promoted; start a new ask for more sub-research",
      promotedPhaseId: ask.promotedPhaseId,
    });
    return;
  }

  const rawTopics = Array.isArray(req.body?.topics) ? req.body.topics : [];
  const topics = rawTopics.map((t: unknown) => String(t ?? "").trim()).filter(Boolean);
  if (topics.length === 0) {
    res.status(400).json({
      error: `topics must be a non-empty string array (max ${ASK_SUB_RESEARCH_MAX_TOPICS})`,
    });
    return;
  }
  if (topics.length > ASK_SUB_RESEARCH_MAX_TOPICS) {
    res.status(400).json({
      error: `At most ${ASK_SUB_RESEARCH_MAX_TOPICS} sub-research topics allowed per request`,
    });
    return;
  }

  const userMsg = {
    role: "user" as const,
    content: `Sub-research topics:\n${topics.map((t: string, i: number) => `${i + 1}. ${t}`).join("\n")}`,
    at: new Date().toISOString(),
    meta: { kind: "sub_research" as const },
  };
  let updated = store.appendAskMessage(ask.id, userMsg) ?? ask;

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const history = updated.messages
      .slice(0, -1)
      .map((m) => ({ role: m.role, content: m.content }));
    const { findings } = await orchestrator.askSubResearch({
      project,
      askId: ask.id,
      topics,
      history,
    });

    for (const finding of findings) {
      updated =
        store.appendAskMessage(ask.id, {
          role: "assistant",
          content: finding.content,
          at: new Date().toISOString(),
          meta: { kind: "sub_research", topic: finding.topic },
        }) ?? updated;
    }

    writeAskArtifacts(project.rootPath, updated);
    res.json({ ask: updated, findings });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("ask", "sub-research failed", {
      projectId: project.id,
      askId: ask.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, ask: store.getAsk(ask.id) });
  }
});

// ===== Agent chat (inspect/verify with run_command; not develop) =====

app.get("/projects/:id/agents", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const agents = store.listAgents(project.id).map((a) => ({
    id: a.id,
    title: a.title,
    status: a.status,
    messageCount: a.messages.length,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  }));
  res.json({ projectId: project.id, agents });
});

app.get("/projects/:id/agents/:agentId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const agent = store.getAgent(req.params.agentId);
  if (!agent || agent.projectId !== project.id) {
    res.status(404).json({ error: "Agent session not found" });
    return;
  }
  res.json({ agent });
});

app.post("/projects/:id/agents", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const message =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  const agentId =
    typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";

  const now = new Date().toISOString();
  const userMsg = { role: "user" as const, content: message, at: now };

  let agent = agentId ? store.getAgent(agentId) : undefined;
  if (agentId && (!agent || agent.projectId !== project.id)) {
    res.status(404).json({ error: "Agent session not found" });
    return;
  }
  if (agent && agent.status === "archived") {
    res.status(409).json({ error: "Agent session is archived; start a new one" });
    return;
  }

  if (!agent) {
    agent = store.createAgent({
      projectId: project.id,
      title: title || message.slice(0, 80),
      firstMessage: userMsg,
    });
  } else {
    if (title && !agent.title) {
      agent.title = title;
      store.updateAgent(agent);
    }
    agent = store.appendAgentMessage(agent.id, userMsg) ?? agent;
  }

  const history = agent.messages
    .slice(0, -1)
    .map((m) => ({ role: m.role, content: m.content }));

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const { reply } = await orchestrator.agentTurn({
      project,
      agentId: agent.id,
      message,
      history,
    });
    const assistantMsg = {
      role: "assistant" as const,
      content: reply,
      at: new Date().toISOString(),
    };
    agent = store.appendAgentMessage(agent.id, assistantMsg) ?? agent;
    writeAgentArtifacts(project.rootPath, agent);
    res.json({ agent, reply });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("agent", "agent turn failed", {
      projectId: project.id,
      agentId: agent.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, agent });
  }
});

app.get("/projects/:id/worktrees", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phaseIds = store.listPhases(project.id).map((p) => p.id);
  const worktrees = listPhaseWorktrees({
    projectId: project.id,
    dataDir: defaultDataDir(),
    phaseIds,
  });
  res.json({
    projectId: project.id,
    rootPath: project.rootPath,
    worktrees,
  });
});

app.post("/projects/:id/phases/:phaseId/merge", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phaseId = String(req.params.phaseId ?? "").trim();
  if (!phaseId) {
    res.status(400).json({ error: "phaseId is required" });
    return;
  }

  const targetBranch =
    typeof req.body?.targetBranch === "string"
      ? req.body.targetBranch.trim() || undefined
      : undefined;
  const commitMessage =
    typeof req.body?.commitMessage === "string"
      ? req.body.commitMessage.trim() || undefined
      : undefined;
  const removeWorktree =
    req.body?.removeWorktree === undefined
      ? true
      : Boolean(req.body.removeWorktree);
  const stashDirty =
    req.body?.stashDirty === undefined ? true : Boolean(req.body.stashDirty);
  const conflictStrategy =
    req.body?.conflictStrategy === "abort" ? "abort" : "prefer_phase";

  try {
    log.info("worktree", "merge_phase start", {
      projectId: project.id,
      phaseId,
      targetBranch,
      removeWorktree,
      stashDirty,
      conflictStrategy,
    });
    const result = mergePhaseWorktree({
      projectRoot: project.rootPath,
      projectId: project.id,
      phaseId,
      dataDir: defaultDataDir(),
      targetBranch,
      commitMessage,
      removeWorktree,
      stashDirty,
      conflictStrategy,
    });
    log.info("worktree", "merge_phase done", {
      projectId: project.id,
      phaseId,
      ok: result.ok,
      mergeCommit: result.mergeCommit,
      removedWorktree: result.removedWorktree,
      targetBranch: result.targetBranch,
    });
    res.status(result.ok ? 200 : 409).json({ project, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("worktree", "merge_phase failed", {
      projectId: project.id,
      phaseId,
      error: message,
    });
    res.status(500).json({ error: message });
  }
});

app.get("/projects/:id/git", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const status = getProjectGitStatus(project.rootPath);
    res.json({ projectId: project.id, ...status });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/projects/:id/git/checkout", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const branch =
    typeof req.body?.branch === "string" ? req.body.branch.trim() : "";
  if (!branch) {
    res.status(400).json({ error: "branch is required" });
    return;
  }
  const create = Boolean(req.body?.create);
  const stashDirty =
    req.body?.stashDirty === undefined ? true : Boolean(req.body.stashDirty);

  try {
    log.info("git", "checkout start", {
      projectId: project.id,
      branch,
      create,
      stashDirty,
    });
    const result = checkoutProjectBranch({
      projectRoot: project.rootPath,
      branch,
      create,
      stashDirty,
    });
    log.info("git", "checkout done", {
      projectId: project.id,
      branch: result.branch,
      previousBranch: result.previousBranch,
    });
    res.json({ projectId: project.id, rootPath: project.rootPath, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("git", "checkout failed", {
      projectId: project.id,
      branch,
      error: message,
    });
    res.status(500).json({ error: message });
  }
});

app.delete("/projects/:id/worktrees/:phaseId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phaseId = String(req.params.phaseId ?? "").trim();
  if (!phaseId) {
    res.status(400).json({ error: "phaseId is required" });
    return;
  }
  const deleteBranch =
    req.query.deleteBranch === "1" ||
    req.query.deleteBranch === "true" ||
    Boolean(req.body?.deleteBranch);

  try {
    log.info("worktree", "remove start", {
      projectId: project.id,
      phaseId,
      deleteBranch,
    });
    const result = removePhaseWorktree({
      projectRoot: project.rootPath,
      projectId: project.id,
      phaseId,
      dataDir: defaultDataDir(),
      deleteBranch,
    });
    log.info("worktree", "remove done", {
      projectId: project.id,
      phaseId,
      removedWorktree: result.removedWorktree,
      deletedBranch: result.deletedBranch,
    });
    res.json({ projectId: project.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("worktree", "remove failed", {
      projectId: project.id,
      phaseId,
      error: message,
    });
    res.status(500).json({ error: message });
  }
});

app.get("/projects/:id/conflicts", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const conflicts = listConflicts(project.rootPath);
    res.json({
      projectId: project.id,
      rootPath: project.rootPath,
      conflicts,
      count: conflicts.length,
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/projects/:id/conflicts/resolve", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const strategyRaw = req.body?.strategy;
  const strategy =
    strategyRaw === "ours" ||
    strategyRaw === "theirs" ||
    strategyRaw === "phase" ||
    strategyRaw === "auto"
      ? strategyRaw
      : "auto";
  const phaseId =
    typeof req.body?.phaseId === "string" ? req.body.phaseId.trim() : undefined;
  const paths = Array.isArray(req.body?.paths)
    ? req.body.paths.filter((p: unknown) => typeof p === "string")
    : undefined;
  const continueMerge =
    req.body?.continueMerge === undefined
      ? true
      : Boolean(req.body.continueMerge);

  try {
    log.info("worktree", "resolve_conflicts start", {
      projectId: project.id,
      strategy,
      phaseId,
      pathCount: paths?.length,
    });
    const result = resolveConflicts({
      projectRoot: project.rootPath,
      strategy,
      phaseId,
      paths,
      continueMerge,
    });
    log.info("worktree", "resolve_conflicts done", {
      projectId: project.id,
      ok: result.ok,
      resolved: result.resolved.length,
      remaining: result.remaining.length,
    });
    res.status(result.ok ? 200 : 409).json({ project, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("worktree", "resolve_conflicts failed", {
      projectId: project.id,
      error: message,
    });
    res.status(500).json({ error: message });
  }
});

app.get("/projects/:projectId/phases/:phaseId/doc", (req, res) => {
  const project = store.getProject(req.params.projectId);
  const phase = store.getPhase(req.params.phaseId);
  if (!project || !phase || phase.projectId !== project.id) {
    res.status(404).json({ error: "Phase not found" });
    return;
  }
  res.json({
    phase,
    phaseDoc: readPhaseDoc(project.rootPath, phase.id),
  });
});

app.post("/projects/:id/phases", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const description = String(req.body?.description ?? "");
  if (!description) {
    res.status(400).json({ error: "description is required" });
    return;
  }

  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? (req.body.dependsOn as unknown[]).map(String).filter(Boolean)
    : String(req.body?.dependsOn ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

  const phase = store.createPhase({
    projectId: project.id,
    description,
    rootPath: project.rootPath,
    dependsOn,
  });
  const run = store.createRun({ phaseId: phase.id, projectId: project.id });
  res.status(201).json({ phase, run });
});

app.patch("/projects/:projectId/phases/:phaseId/dependencies", (req, res) => {
  const project = store.getProject(req.params.projectId);
  const phase = store.getPhase(req.params.phaseId);
  if (!project || !phase || phase.projectId !== project.id) {
    res.status(404).json({ error: "Phase not found" });
    return;
  }

  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? [...new Set((req.body.dependsOn as unknown[]).map(String).filter(Boolean))]
    : [];

  if (dependsOn.includes(phase.id)) {
    res.status(400).json({ error: "A phase cannot depend on itself" });
    return;
  }

  phase.dependsOn = dependsOn;
  phase.updatedAt = new Date().toISOString();
  store.updatePhase(phase);

  void import("@slopcontrol/artifacts").then(({ upsertRoadmapEntry }) => {
    upsertRoadmapEntry(
      project.rootPath,
      phase.id,
      phase.title ?? phase.description.slice(0, 80),
      phase.status,
      dependsOn,
    );
  });

  res.json({
    phase,
    unmet: unmetPhaseDependencies(phase, store.listPhases(project.id)),
  });
});

app.get("/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const payload = buildRunPayload(run);
  if (!payload) {
    res.status(404).json({ error: "Project not found for run" });
    return;
  }
  res.json({
    ...payload,
    active: activeRuns.has(run.id),
  });
});

app.get("/projects/:projectId/phases/:phaseId/status", (req, res) => {
  const project = store.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phase = store.getPhase(req.params.phaseId);
  if (!phase || phase.projectId !== project.id) {
    res.status(404).json({ error: "Phase not found" });
    return;
  }
  const diagnosis = readLatestDiagnosisForPhase(project.rootPath, phase.id);
  const handoff = readLatestHandoffForPhase(project.rootPath, phase.id);
  const runs = store
    .listRuns(project.id)
    .filter((r) => r.phaseId === phase.id)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  const latestRun = runs[0] ?? null;
  const config = readProjectConfig(project.rootPath);
  const needsDesign = phaseNeedsDesign(project.rootPath, phase.id, config);
  const designComplete = isDesignComplete(project.rootPath, phase.id);
  const uiSpec = readUiSpec(project.rootPath, phase.id);
  res.json({
    projectId: project.id,
    phase: {
      id: phase.id,
      status: phase.status,
      description: phase.description,
      dependsOn: phase.dependsOn ?? [],
    },
    design: {
      needed: needsDesign,
      complete: designComplete,
      hasUiSpec: Boolean(uiSpec.trim()),
    },
    diagnosis,
    handoff: handoffSummary(handoff),
    latestRunId: latestRun?.id ?? null,
    latestRunStage: latestRun?.stage ?? null,
    operator_suggestions: diagnosis
      ? {
          audience: diagnosis.audience,
          actions: diagnosis.operatorActions,
          class: diagnosis.class,
          title: diagnosis.title,
          codingAgentShouldFix: diagnosis.codingAgentShouldFix,
          evidence: diagnosis.evidence?.slice(-800),
        }
      : null,
  });
});

app.get("/projects/:projectId/development-report", (req, res) => {
  const project = store.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phaseId =
    typeof req.query.phaseId === "string" ? req.query.phaseId : undefined;
  const runId =
    typeof req.query.runId === "string" ? req.query.runId : undefined;

  let handoff = null as ReturnType<typeof readRunHandoff>;
  if (runId) {
    handoff = readRunHandoff(project.rootPath, runId);
  }
  if (!handoff && phaseId) {
    handoff = readLatestHandoffForPhase(project.rootPath, phaseId);
  }
  if (!handoff) {
    const runs = store
      .listRuns(project.id)
      .filter(
        (r) =>
          r.stage === "complete" ||
          r.stage === "blocked" ||
          r.stage === "interrupted" ||
          r.stage === "failed",
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    for (const run of runs) {
      handoff = readRunHandoff(project.rootPath, run.id);
      if (handoff) break;
      if (run.phaseId) {
        handoff = readLatestHandoffForPhase(project.rootPath, run.phaseId);
        if (handoff) break;
      }
    }
  }

  if (!handoff) {
    res.json({
      projectId: project.id,
      phaseId: phaseId ?? null,
      runId: runId ?? null,
      report: null,
      message:
        "No development handoff yet. After develop completes, blocks, or is interrupted, the report appears here.",
    });
    return;
  }

  res.json({
    projectId: project.id,
    phaseId: handoff.phaseId,
    runId: handoff.runId,
    report: handoff,
  });
});

app.get("/projects/:projectId/operator-suggestions", (req, res) => {
  const project = store.getProject(req.params.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const phaseId =
    typeof req.query.phaseId === "string" ? req.query.phaseId : undefined;
  const runId =
    typeof req.query.runId === "string" ? req.query.runId : undefined;

  let diagnosis = null as ReturnType<typeof readDiagnosis>;
  if (runId) {
    diagnosis = readDiagnosis(project.rootPath, runId);
  }
  if (!diagnosis && phaseId) {
    diagnosis = readLatestDiagnosisForPhase(project.rootPath, phaseId);
  }
  if (!diagnosis) {
    // Latest blocked/failed run for the project
    const runs = store
      .listRuns(project.id)
      .filter((r) => r.stage === "blocked" || r.stage === "failed")
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    for (const run of runs) {
      diagnosis = readDiagnosis(project.rootPath, run.id);
      if (diagnosis) break;
      if (run.phaseId) {
        diagnosis = readLatestDiagnosisForPhase(project.rootPath, run.phaseId);
        if (diagnosis) break;
      }
    }
  }

  if (!diagnosis) {
    res.json({
      projectId: project.id,
      phaseId: phaseId ?? null,
      runId: runId ?? null,
      suggestions: null,
      message:
        "No persisted diagnosis yet. After a failed/blocked develop run, suggestions appear here.",
    });
    return;
  }

  res.json({
    projectId: project.id,
    phaseId: diagnosis.phaseId ?? phaseId ?? null,
    runId: diagnosis.runId ?? runId ?? null,
    suggestions: {
      audience: diagnosis.audience,
      actions: diagnosis.operatorActions,
      class: diagnosis.class,
      confidence: diagnosis.confidence,
      title: diagnosis.title,
      rootCause: diagnosis.rootCause,
      evidence: diagnosis.evidence?.slice(-1200),
      nextActions: diagnosis.nextActions,
      codingAgentShouldFix: diagnosis.codingAgentShouldFix,
      fingerprint: diagnosis.fingerprint,
      updatedAt: diagnosis.updatedAt,
    },
  });
});

app.get("/runs/:id/stream", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }

  const project = store.getProject(run.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const logPath = join(project.rootPath, ".slopcontrol", "runs", run.id, "log.txt");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastSize = 0;

  const sendTail = () => {
    if (!existsSync(logPath)) return;
    const content = readRunLog(project.rootPath, run.id);
    if (content.length <= lastSize) return;
    const chunk = content.slice(lastSize);
    lastSize = content.length;
    for (const line of chunk.split("\n")) {
      if (line.trim()) {
        res.write(`data: ${JSON.stringify({ line })}\n\n`);
      }
    }

    const latest = store.getRun(run.id);
    if (latest) {
      res.write(
        `data: ${JSON.stringify({
          stage: latest.stage,
          active: activeRuns.has(run.id),
          total_duration_ms: latest.totalDurationMs ?? null,
          total_duration: formatDurationMs(latest.totalDurationMs),
          stage_timings: (latest.stageTimings ?? []).map((t) => ({
            stage: t.stage,
            duration_ms: t.durationMs ?? null,
            duration: formatDurationMs(t.durationMs),
            started_at: t.startedAt,
            ended_at: t.endedAt ?? null,
          })),
        })}\n\n`,
      );
    }
  };

  sendTail();
  const interval = setInterval(sendTail, 750);

  req.on("close", () => {
    clearInterval(interval);
  });
});

app.get("/config/endpoints", (_req, res) => {
  const config = loadEndpointsConfig(join(defaultDataDir(), "endpoints.json"));
  res.json(config);
});

app.post("/runs", async (req, res) => {
  const parsed = RunActionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const action = parsed.data;

  try {
    if (action.action === "open_project") {
      const project = store.createProject({
        name:
          action.name ??
          action.rootPath.split("/").filter(Boolean).pop() ??
          "Project",
        rootPath: action.rootPath,
      });
      const { orchestrator } = getRuntime(project.rootPath);
      const result = await orchestrator.openProject({
        project,
        forceRefresh: action.forceRefresh,
        intent: action.intent,
      });
      if (result.blueprintStatus !== "needs_intent") {
        const stored = store.getProject(project.id);
        if (stored) {
          stored.blueprintVersion = (stored.blueprintVersion ?? 0) + 1;
          stored.updatedAt = new Date().toISOString();
          store.updateProject(stored);
        }
      }
      res.json({ project: store.getProject(project.id), ...result });
      return;
    }

    if (action.action === "reinit_project") {
      const project =
        (action.projectId ? store.getProject(action.projectId) : undefined) ??
        (action.rootPath
          ? store.findProjectByRootPath(action.rootPath) ??
            store.createProject({
              name:
                action.rootPath.split("/").filter(Boolean).pop() ?? "Project",
              rootPath: action.rootPath,
            })
          : undefined);

      if (!project) {
        res.status(400).json({ error: "projectId or rootPath is required" });
        return;
      }

      for (const run of store.listRuns(project.id)) {
        abortControllers.get(run.id)?.abort();
        activeRuns.delete(run.id);
      }

      const cleared = store.clearProjectWork(project.id);
      const { orchestrator } = getRuntime(project.rootPath);
      const result = await orchestrator.reinitProject({
        project,
        notes: action.notes,
      });

      const stored = store.getProject(project.id);
      if (stored) {
        stored.blueprintVersion = (stored.blueprintVersion ?? 0) + 1;
        stored.updatedAt = new Date().toISOString();
        store.updateProject(stored);
      }

      res.json({
        project: store.getProject(project.id),
        cleared,
        ...result,
      });
      return;
    }

    if (action.action === "start_research") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const phase = store.createPhase({
        projectId: project.id,
        description: action.description,
        rootPath: project.rootPath,
        dependsOn: action.dependsOn,
      });
      const run = store.createRun({ phaseId: phase.id, projectId: project.id });
      touchRunStage(run.id, "researching");
      updatePhaseStatus(phase.id, "draft");

      void import("@slopcontrol/artifacts").then(({ upsertRoadmapEntry }) => {
        upsertRoadmapEntry(
          project.rootPath,
          phase.id,
          phase.title ?? phase.description.slice(0, 80),
          "draft",
          phase.dependsOn ?? [],
        );
      });

      runInBackground(run.id, async () => {
        const { orchestrator } = getRuntime(project.rootPath);
        touchRunStage(run.id, "drafting");
        const stage = await orchestrator.startResearch({
          project,
          phase: store.getPhase(phase.id) ?? phase,
          run: store.getRun(run.id) ?? run,
          description: action.description,
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, stage === "in_review" ? "in_review" : stage === "failed" ? "blocked" : "draft");
      });

      res.status(202).json({
        run: store.getRun(run.id),
        phase: store.getPhase(phase.id),
        stage: "researching",
        accepted: true,
      });
      return;
    }

    if (action.action === "submit_review") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const project = store.getProject(run.projectId);
      const phase = store.getPhase(run.phaseId);
      if (!project || !phase) {
        res.status(404).json({ error: "Project or phase not found" });
        return;
      }

      // Approve is sync/fast; request_changes can call the LLM so run async.
      if (action.decision === "approve") {
        const { orchestrator } = getRuntime(project.rootPath);
        const stage = await orchestrator.submitReview({
          project,
          phase,
          run,
          decision: "approve",
          feedback: action.feedback,
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, "accepted");
        res.json({ run: store.getRun(run.id), stage });
        return;
      }

      touchRunStage(run.id, "drafting");
      runInBackground(run.id, async () => {
        const { orchestrator } = getRuntime(project.rootPath);
        const stage = await orchestrator.submitReview({
          project,
          phase,
          run,
          decision: "request_changes",
          feedback: action.feedback,
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, "in_review");
      });

      res.status(202).json({
        run: store.getRun(run.id),
        stage: "drafting",
        accepted: true,
      });
      return;
    }

    if (action.action === "start_development") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const project = store.getProject(run.projectId);
      const phase = store.getPhase(run.phaseId);
      if (!project || !phase) {
        res.status(404).json({ error: "Project or phase not found" });
        return;
      }

      if (
        run.stage !== "accepted" &&
        phase.status !== "accepted" &&
        run.stage !== "design_complete" &&
        phase.status !== "design_complete" &&
        run.stage !== "designing" &&
        phase.status !== "designing"
      ) {
        res.status(409).json({
          error:
            "Phase must be accepted or design_complete before development can start",
          stage: run.stage,
          phaseStatus: phase.status,
        });
        return;
      }

      const unmet = unmetPhaseDependencies(phase, store.listPhases(project.id));
      if (unmet.length > 0) {
        res.status(409).json({
          error: "Phase dependencies are not complete",
          unmet,
          dependsOn: phase.dependsOn ?? [],
        });
        return;
      }

      const config = readProjectConfig(project.rootPath);
      const needsDesign = phaseNeedsDesign(project.rootPath, phase.id, config);
      const designDone = isDesignComplete(project.rootPath, phase.id);
      if (needsDesign && !designDone && !action.autoDesign) {
        res.status(409).json({
          error: "design_required",
          message:
            "This phase needs a design pass (UI-SPEC / Brand / Assets). Call start_design first, or pass autoDesign: true.",
          stage: run.stage,
          phaseStatus: phase.status,
        });
        return;
      }

      if (rejectIfDevelopInProgress(res, project.id)) return;

      const claim = developLock.tryClaim(project.id, run.id);
      if (!claim.ok) {
        const blocking = store.getRun(claim.blockingRunId);
        res.status(409).json({
          error: "development_in_progress",
          message:
            "Another develop job is already running for this project. Wait for it to finish or stop_run, then retry.",
          blockingRunId: claim.blockingRunId,
          blockingPhaseId: blocking?.phaseId,
          blockingStage: blocking?.stage,
        });
        return;
      }

      touchRunStage(run.id, action.autoDesign && needsDesign && !designDone ? "designing" : "developing");
      updatePhaseStatus(
        phase.id,
        action.autoDesign && needsDesign && !designDone ? "designing" : "developing",
      );

      runInBackground(
        run.id,
        async (signal) => {
          const { orchestrator } = getRuntime(project.rootPath);
          const result = await orchestrator.startDevelopment({
            project,
            phase: store.getPhase(phase.id) ?? phase,
            run: store.getRun(run.id) ?? run,
            signal,
            autoDesign: action.autoDesign,
          });

          const latestPhase = store.getPhase(phase.id);
          if (latestPhase) {
            latestPhase.worktreePath = result.worktreePath;
            latestPhase.worktreeBranch = result.worktreeBranch;
            latestPhase.updatedAt = new Date().toISOString();
            store.updatePhase(latestPhase);
          }

          if (result.stage === "complete") {
            const obsidian = new ObsidianSync({
              vaultPath: process.env.OBSIDIAN_VAULT_PATH,
            });
            obsidian.writeDecisionNote({
              title: phase.description,
              project: project.name,
              iterations: store.getRun(run.id)?.iterationCount ?? 0,
            });
            updatePhaseStatus(phase.id, "complete");
          } else if (result.stage === "blocked") {
            updatePhaseStatus(phase.id, "blocked");
          } else if (result.stage === "interrupted") {
            updatePhaseStatus(phase.id, "interrupted");
          } else if (result.stage === "design_complete") {
            updatePhaseStatus(phase.id, "design_complete");
          }

          touchRunStage(run.id, result.stage);
        },
        { developProjectId: project.id },
      );

      res.status(202).json({
        run: store.getRun(run.id),
        stage: action.autoDesign && needsDesign && !designDone ? "designing" : "developing",
        accepted: true,
      });
      return;
    }

    if (action.action === "start_design") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const project = store.getProject(run.projectId);
      const phase = store.getPhase(run.phaseId);
      if (!project || !phase) {
        res.status(404).json({ error: "Project or phase not found" });
        return;
      }

      if (
        run.stage !== "accepted" &&
        phase.status !== "accepted" &&
        run.stage !== "designing" &&
        phase.status !== "designing" &&
        run.stage !== "design_complete" &&
        phase.status !== "design_complete"
      ) {
        res.status(409).json({
          error:
            "Phase must be accepted, designing, or design_complete before design can start",
          stage: run.stage,
          phaseStatus: phase.status,
        });
        return;
      }

      if (
        !action.force &&
        isDesignComplete(project.rootPath, phase.id) &&
        readUiSpec(project.rootPath, phase.id).trim()
      ) {
        updatePhaseStatus(phase.id, "design_complete");
        touchRunStage(run.id, "design_complete");
        res.status(200).json({
          run: store.getRun(run.id),
          stage: "design_complete",
          accepted: true,
          skipped: true,
          message:
            "Design already complete (UI-SPEC + DESIGN_COMPLETE); pass force: true to redo",
        });
        return;
      }

      touchRunStage(run.id, "designing");
      updatePhaseStatus(phase.id, "designing");

      runInBackground(run.id, async (signal) => {
        const { orchestrator } = getRuntime(project.rootPath);
        const result = await orchestrator.startDesign({
          project,
          phase: store.getPhase(phase.id) ?? phase,
          run: store.getRun(run.id) ?? run,
          signal,
          force: action.force,
        });

        const latestPhase = store.getPhase(phase.id);
        if (latestPhase) {
          latestPhase.worktreePath = result.worktreePath;
          latestPhase.worktreeBranch = result.worktreeBranch;
          latestPhase.updatedAt = new Date().toISOString();
          store.updatePhase(latestPhase);
        }

        if (result.stage === "design_complete") {
          updatePhaseStatus(phase.id, "design_complete");
        } else if (result.stage === "interrupted") {
          updatePhaseStatus(phase.id, "interrupted");
        } else if (result.stage === "blocked") {
          updatePhaseStatus(phase.id, "blocked");
        }

        touchRunStage(run.id, result.stage);
      });

      res.status(202).json({
        run: store.getRun(run.id),
        stage: "designing",
        accepted: true,
      });
      return;
    }

    if (action.action === "stop_run") {
      const run = store.getRun(action.runId);
      abortControllers.get(action.runId)?.abort();
      activeRuns.delete(action.runId);
      if (run) {
        developLock.release(run.projectId, run.id);
        updatePhaseStatus(run.phaseId, "interrupted");
      }
      touchRunStage(action.runId, "interrupted");
      res.json({ ok: true, stage: "interrupted" });
      return;
    }

    if (action.action === "retry_development") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const project = store.getProject(run.projectId);
      const phase = store.getPhase(run.phaseId);
      if (!project || !phase) {
        res.status(404).json({ error: "Project or phase not found" });
        return;
      }

      const unmet = unmetPhaseDependencies(phase, store.listPhases(project.id));
      if (unmet.length > 0) {
        res.status(409).json({
          error: "Phase dependencies are not complete",
          unmet,
          dependsOn: phase.dependsOn ?? [],
        });
        return;
      }

      if (rejectIfDevelopInProgress(res, project.id)) return;

      const claim = developLock.tryClaim(project.id, run.id);
      if (!claim.ok) {
        const blocking = store.getRun(claim.blockingRunId);
        res.status(409).json({
          error: "development_in_progress",
          message:
            "Another develop job is already running for this project. Wait for it to finish or stop_run, then retry.",
          blockingRunId: claim.blockingRunId,
          blockingPhaseId: blocking?.phaseId,
          blockingStage: blocking?.stage,
        });
        return;
      }

      touchRunStage(run.id, "developing");
      updatePhaseStatus(phase.id, "developing");

      runInBackground(
        run.id,
        async (signal) => {
          const { orchestrator } = getRuntime(project.rootPath);
          const result = await orchestrator.startDevelopment({
            project,
            phase: store.getPhase(phase.id) ?? phase,
            run: store.getRun(run.id) ?? run,
            signal,
          });
          const latestPhase = store.getPhase(phase.id);
          if (latestPhase) {
            latestPhase.worktreePath = result.worktreePath;
            latestPhase.worktreeBranch = result.worktreeBranch;
            latestPhase.updatedAt = new Date().toISOString();
            store.updatePhase(latestPhase);
          }
          touchRunStage(run.id, result.stage);
          updatePhaseStatus(
            phase.id,
            result.stage === "complete"
              ? "complete"
              : result.stage === "blocked"
                ? "blocked"
                : result.stage === "interrupted"
                  ? "interrupted"
                  : "developing",
          );
        },
        { developProjectId: project.id },
      );

      res.status(202).json({
        run: store.getRun(run.id),
        stage: "developing",
        accepted: true,
      });
      return;
    }

    if (action.action === "set_phase_dependencies") {
      const phase = store.getPhase(action.phaseId);
      if (!phase) {
        res.status(404).json({ error: "Phase not found" });
        return;
      }
      const project = store.getProject(phase.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }

      const dependsOn = [...new Set(action.dependsOn.filter(Boolean))];
      if (dependsOn.includes(phase.id)) {
        res.status(400).json({ error: "A phase cannot depend on itself" });
        return;
      }

      phase.dependsOn = dependsOn;
      phase.updatedAt = new Date().toISOString();
      store.updatePhase(phase);

      const { upsertRoadmapEntry } = await import("@slopcontrol/artifacts");
      upsertRoadmapEntry(
        project.rootPath,
        phase.id,
        phase.title ?? phase.description.slice(0, 80),
        phase.status,
        dependsOn,
      );

      res.json({
        phase,
        unmet: unmetPhaseDependencies(phase, store.listPhases(project.id)),
      });
      return;
    }

    if (action.action === "delete_run") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      abortControllers.get(action.runId)?.abort();
      activeRuns.delete(action.runId);
      store.deleteRun(action.runId);
      res.json({ ok: true });
      return;
    }

    if (action.action === "rerun_research") {
      const run = store.getRun(action.runId);
      if (!run) {
        res.status(404).json({ error: "Run not found" });
        return;
      }
      const project = store.getProject(run.projectId);
      const phase = store.getPhase(run.phaseId);
      if (!project || !phase) {
        res.status(404).json({ error: "Project or phase not found" });
        return;
      }

      touchRunStage(run.id, "researching");
      updatePhaseStatus(phase.id, "draft");

      runInBackground(run.id, async () => {
        const { orchestrator } = getRuntime(project.rootPath);
        touchRunStage(run.id, "drafting");
        const stage = await orchestrator.startResearch({
          project,
          phase,
          run,
          description: phase.description,
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, stage === "in_review" ? "in_review" : stage === "failed" ? "blocked" : "draft");
      });

      res.status(202).json({
        run: store.getRun(run.id),
        stage: "researching",
        accepted: true,
      });
      return;
    }

    if (action.action === "list_worktrees") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const phaseIds = store.listPhases(project.id).map((p) => p.id);
      const worktrees = listPhaseWorktrees({
        projectId: project.id,
        dataDir: defaultDataDir(),
        phaseIds,
      });
      res.json({
        projectId: project.id,
        rootPath: project.rootPath,
        worktrees,
      });
      return;
    }

    if (action.action === "merge_phase") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const result = mergePhaseWorktree({
          projectRoot: project.rootPath,
          projectId: project.id,
          phaseId: action.phaseId,
          dataDir: defaultDataDir(),
          targetBranch: action.targetBranch,
          commitMessage: action.commitMessage,
          removeWorktree:
            action.removeWorktree === undefined ? true : action.removeWorktree,
          stashDirty: action.stashDirty,
          conflictStrategy: action.conflictStrategy,
        });
        res.status(result.ok ? 200 : 409).json({ project, ...result });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (action.action === "get_git_status") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const status = getProjectGitStatus(project.rootPath);
        res.json({ projectId: project.id, ...status });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (action.action === "checkout_branch") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const result = checkoutProjectBranch({
          projectRoot: project.rootPath,
          branch: action.branch,
          create: action.create,
          stashDirty: action.stashDirty,
        });
        res.json({
          projectId: project.id,
          rootPath: project.rootPath,
          ...result,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (action.action === "remove_worktree") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const result = removePhaseWorktree({
          projectRoot: project.rootPath,
          projectId: project.id,
          phaseId: action.phaseId,
          dataDir: defaultDataDir(),
          deleteBranch: action.deleteBranch,
        });
        res.json({ projectId: project.id, ...result });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (action.action === "list_conflicts") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const conflicts = listConflicts(project.rootPath);
        res.json({
          projectId: project.id,
          rootPath: project.rootPath,
          conflicts,
          count: conflicts.length,
        });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (action.action === "resolve_conflicts") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      try {
        const result = resolveConflicts({
          projectRoot: project.rootPath,
          strategy: action.strategy,
          phaseId: action.phaseId,
          paths: action.paths,
          continueMerge: action.continueMerge,
        });
        res.status(result.ok ? 200 : 409).json({ project, ...result });
      } catch (error) {
        res.status(500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
  } catch (error) {
    log.error("runs", "action failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  res.status(400).json({ error: "Unhandled action" });
});

app.listen(PORT, () => {
  log.info("server", `listening on http://localhost:${PORT}`, {
    dataDir: defaultDataDir(),
    logLevel: process.env.SLOPCONTROL_LOG_LEVEL ?? "info",
    ollamaApiKey: process.env.OLLAMA_API_KEY ? "set" : "NOT set",
  });
});
