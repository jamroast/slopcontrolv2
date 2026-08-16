import "./load-env.js";

import { existsSync, readFileSync, readdirSync, rmSync, openSync, readSync, closeSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import cors from "cors";
import express from "express";
import {
  readPhaseDoc,
  readResearch,
  readRunLog,
  appendRunLog,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  readVerifyStepsReport,
  probeMastraDbFile,
  phaseNeedsDesign,
  isDesignComplete,
  readProjectConfig,
  writeProjectConfig,
  resolveProjectToolchain,
  readUiSpec,
  readRunHandoff,
  readLatestHandoffForPhase,
  handoffSummary,
  buildAskTaskDescription,
  writeAskArtifacts,
  isAskAgentTimeoutError,
  ASK_TIMEOUT_RECOVERY_MESSAGE,
  writeAgentArtifacts,
  formatChangeIntentPromptBlock,
  phaseDocAlignsWithChangeIntent,
  readChangeIntent,
  reconcileProjectBlueprint,
  clipBlueprintForPrompt,
  isEngagementSymptom,
  createDesignLoopMeta,
  writeDesignLoopMeta,
  readDesignLoopMeta,
  appendDesignLoopTranscript,
  writeDesignLoopVersion,
  readDesignLoopMockHtml,
  readDesignLoopNotes,
  readDesignLoopTranscript,
  readDesignLoopRequest,
  readDesignLoopVersionMeta,
  setDesignLoopLastError,
  designLoopVersionExists,
  acceptDesignLoop,
  reopenDesignLoopForIterate,
  listDesignLoops,
  bindAcceptedDesignLoopToPhase,
  seedDesignLoopAcceptanceFromHtml,
  readDesignLoopAcceptance,
  writeDesignLoopAcceptance,
  applyAcceptanceFeatureTicks,
  writePhaseStatus,
  rewriteDesignLoopAssetUrls,
  listDesignLoopAssets,
  resolveDesignLoopAssetFile,
  readDesignLoopPack,
  buildDesignLoopConceptCatalog,
  refreshDesignLoopConcepts,
  getDesignLoopSelections,
  pinDesignLoopSelection,
  unpinDesignLoopSelection,
  replaceDesignLoopSelections,
  allocateNextDesignLoopVersion,
  assertActiveDesignLoopBase,
  buildDesignLoopVersionTree,
  invalidateDesignLoopVersion,
  resolveDesignLoopTip,
  getDesignLoopVersionNode,
  buildLiveSiteInventory,
  writeLiveSiteInventory,
  readLiveSiteInventory,
  summarizeLiveSiteInventory,
  resolveDesignShareSource,
  readShareableDesign,
  importDesignShareIntoLoop,
  readSharedDesignImport,
  formatSharedDesignPromptBlock,
  listProjectElements,
  listRegistryElements,
  resolveDesignElement,
  publishDesignElement,
  extractAndPublishDesignElementFromLoop,
  extractDesignElementFromMock,
  listExtractableDesignElementsFromLoop,
  importDesignElementIntoLoop,
  readDesignLoopElements,
  formatDesignElementsPromptBlock,
  projectElementsRoot,
  registryElementsRoot,
  ensureNpmRegistryLayout,
  ensureProjectNpmrc,
  listNpmRegistryPackages,
  npmRegistryEnvValues,
  npmRegistryPackageFreshness,
  writeProjectRegistryEnv,
  readNpmRegistryMeta,
  prepareDesignElementNpmPackage,
  recordDesignElementNpmPublish,
  jamPackageNameForElement,
  buildCrossProjectCatalog,
  resolveDependencyRecommendation,
  detectDependencyIntentFromText,
  DesignScopeSchema,
  conceptualModelFromLoop,
  defaultProductScope,
  checkThemeContractInProject,
  packHasThemeModes,
  createPlanLoopMeta,
  writePlanLoopMeta,
  readPlanLoopMeta,
  listPlanLoops,
  appendPlanLoopTranscript,
  writePlanLoopVersion,
  readPlanLoopPlanMd,
  readPlanLoopNotes,
  readPlanLoopRequest,
  readPlanLoopTranscript,
  readPlanLoopVersionMeta,
  setPlanLoopLastError,
  acceptPlanLoop,
  reopenPlanLoopForIterate,
  seedPlanLoopAcceptance,
  readPlanLoopAcceptance,
  writePlanLoopAcceptance,
  applyPlanAcceptanceTicks,
  bindAcceptedPlanLoopToPhase,
  assertPlanLoopVersionAcceptable,
  PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR,
  allocateNextPlanLoopVersion,
  assertActivePlanLoopBase,
  buildPlanLoopVersionTree,
  invalidatePlanLoopVersion,
  resolvePlanLoopTip,
  readPlanLoopPack,
  summarizePlanConceptualModel,
  phaseDescriptionFromPlanPack,
  defaultPlanScope,
  phaseDescriptionFromDesignAccept,
  resolveDesignImplementInScope,
  readLoopChatMessages,
} from "@slopcontrol/artifacts";
import {
  checkoutProjectBranch,
  getProjectGitStatus,
  listConflicts,
  listPhaseWorktrees,
  mergePhaseWorktree,
  removePhaseWorktree,
  resolveConflicts,
  generateDesignImage,
  searchDesignImages,
  importDesignImageById,
  resolveServableDesignAsset,
  reviewDesignLoopLook,
  listCodingTools,
} from "@slopcontrol/coding-tools";
import {
  classifyDependencyIntentViaLlm,
  loadEndpointsConfig,
  loadProvidersConfig,
  defaultProvidersPath,
  mergeProviderUpdate,
  resolveEndpointSecrets,
} from "@slopcontrol/llm";
import { getSlopcontrolRuntime, ensureChangeIntentAsync, previewChangeIntentAsync, askProgressLine, formatAskWorkingStub, isLiveTurnInterruptedError, ChatService, ConversationClosedError, ConversationNotFoundError, clearSlopcontrolRuntimeCache, waitForRun, formatWaitForRunResult, DEFAULT_WAIT_TIMEOUT_MS, DEFAULT_WAIT_INTERVAL_MS, HTTP_WAIT_MAX_MS, RunStageBroker } from "@slopcontrol/mastra";
import {
  bindLiveTurn,
  wantsLiveStream,
  workingStubFromBound,
} from "./live-turn-http.js";
import { createLoopChatTurn } from "./loop-chat-http.js";
import { liveTurns } from "./live-turns.js";
import { startLiveTurnWatcher } from "./live-turn-watcher.js";
import {
  auditProjectBuildProcess,
  configureProjectBuildProcess,
  getProjectBuildProcessState,
  onboardProjectBuildProcess,
  updateProjectToolchain,
  verifyProjectBuildProcess,
} from "./build-process.js";
import { ObsidianSync } from "@slopcontrol/obsidian";
import { RunActionSchema, ASK_SUB_RESEARCH_MAX_TOPICS, formatDurationMs, log, recordStageTransition, unmetPhaseDependencies, AgentRoleSchema, AskInvestigateToolSchema, type Run, type RunStage } from "@slopcontrol/types";
import { mountMcpHttp } from "./mcp-http.js";
import { createStore, defaultDataDir } from "./store.js";
import { shouldNotifyRunStageChange } from "./run-settled.js";
import { DevelopLock } from "./develop-lock.js";
import { NO_ENV_SYNC_HINT, runProjectEnvSync } from "./env-sync.js";
import { compactProjectRuns, compactRuns, planCompaction } from "./run-compaction.js";
import { startRunCompactionWatcher } from "./run-compaction-watcher.js";
import { startChatConversationWatcher } from "./chat-conversation-watcher.js";
import { dispatchSlopcontrolTool } from "./mcp-tools.js";

const PORT = Number(process.env.SLOPCONTROL_PORT ?? 3020);
const app = express();
const store = createStore();
const activeRuns = new Set<string>();
const abortControllers = new Map<string, AbortController>();
/** One live develop (design→develop / retry) job per project. */
const developLock = new DevelopLock((runId) => activeRuns.has(runId));
const runStageBroker = new RunStageBroker({
  logPath: join(defaultDataDir(), "events.jsonl"),
});

let chatServiceInstance: ChatService | null = null;
function getChatService(): ChatService {
  if (!chatServiceInstance) {
    const dataDir = defaultDataDir();
    chatServiceInstance = new ChatService({
      store,
      getMemory: () => getSlopcontrolRuntime(dataDir, dataDir).memory,
      dispatch: (name, args) => dispatchSlopcontrolTool(name, args),
      context: {
        listProjects: () => store.listProjects(),
        listPhases: (projectId) => store.listPhases(projectId),
        listRuns: (projectId) => store.listRuns(projectId),
        getProject: (id) => store.getProject(id),
        getAsk: (id) => {
          const ask = store.getAsk(id);
          return ask
            ? { id: ask.id, status: ask.status, title: ask.title }
            : undefined;
        },
      },
      endpointsPath: join(dataDir, "endpoints.json"),
      onEndpointsChanged: () => clearSlopcontrolRuntimeCache(),
      subscribeRunUpdates: (runId, listener) =>
        runStageBroker.subscribe(runId, listener),
    });
  }
  return chatServiceInstance;
}

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

  runStageBroker.emit({
    id: run.id,
    stage: run.stage,
    phaseId: run.phaseId,
    projectId: run.projectId,
    previousStage: previous,
  });

  // Choke point for run-settled push notifications: every research/design/
  // develop stage transition flows through here, so gate + terminal stages
  // notify awaiting chat conversations regardless of which loop produced them.
  if (shouldNotifyRunStageChange(previous, stage)) {
    try {
      getChatService().handleRunStageChanged(run);
    } catch (err) {
      log.warn("chat", "handleRunStageChanged failed", {
        runId: run.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

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
 * Resolve a design loop for relaunch_design_research.
 * Prefer loopId; else match meta.phaseId or design/STATUS.md Source line.
 */
function resolveDesignLoopForRelaunchResearch(
  project: { id: string; rootPath: string },
  opts: { loopId?: string; phaseId?: string },
):
  | { ok: true; meta: NonNullable<ReturnType<typeof readDesignLoopMeta>> }
  | { ok: false; status: number; error: string; hint?: string } {
  const loopId = opts.loopId?.trim() || "";
  const phaseId = opts.phaseId?.trim() || "";
  if (!loopId && !phaseId) {
    return {
      ok: false,
      status: 400,
      error: "Provide loopId and/or phaseId",
      hint: "relaunch_design_research",
    };
  }

  if (loopId) {
    const meta = readDesignLoopMeta(project.rootPath, loopId);
    if (!meta || meta.projectId !== project.id) {
      return { ok: false, status: 404, error: "Design loop not found" };
    }
    return { ok: true, meta };
  }

  const byPhase = listDesignLoops(project.rootPath).filter(
    (l) => l.projectId === project.id && l.phaseId === phaseId,
  );
  if (byPhase.length === 1) {
    return { ok: true, meta: byPhase[0]! };
  }
  if (byPhase.length > 1) {
    byPhase.sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || ""),
    );
    return { ok: true, meta: byPhase[0]! };
  }

  const statusPath = join(
    project.rootPath,
    ".slopcontrol",
    "phases",
    phaseId,
    "design",
    "STATUS.md",
  );
  if (existsSync(statusPath)) {
    try {
      const status = readFileSync(statusPath, "utf-8");
      const m = status.match(
        /Source:\s*design-loop\s+([0-9a-f-]{36})\s+v\d+/i,
      );
      if (m?.[1]) {
        const meta = readDesignLoopMeta(project.rootPath, m[1]);
        if (meta && meta.projectId === project.id) {
          return { ok: true, meta };
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ok: false,
    status: 404,
    error: `No design loop found for phaseId=${phaseId}`,
    hint: "Pass loopId from list_design_loops, or ensure the phase has design/STATUS.md from implement_design",
  };
}

/**
 * Always create a new phase, bind the accepted/implemented design contract,
 * and start research. Used by relaunch_design_research (and recoverable
 * stuck design_complete phases).
 */
function startFreshDesignResearchFromLoop(opts: {
  project: NonNullable<ReturnType<typeof store.getProject>>;
  meta: NonNullable<ReturnType<typeof readDesignLoopMeta>>;
  dependsOn?: string[];
}): {
  phase: ReturnType<typeof store.createPhase>;
  bound: ReturnType<typeof bindAcceptedDesignLoopToPhase>;
  run: ReturnType<typeof store.createRun>;
} {
  const { project, meta } = opts;
  if (meta.status !== "accepted" && meta.status !== "implemented") {
    throw new Error(
      `Design loop must be accepted or implemented before relaunch research (status=${meta.status}). Call design_loop_accept first.`,
    );
  }

  const acceptance = readDesignLoopAcceptance(project.rootPath, meta.id);
  const acceptedIds =
    acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [];
  if (acceptedIds.length < 1) {
    throw new Error(
      `Design loop ${meta.id} has no accepted features — call design_loop_accept with at least one feature ticked`,
    );
  }

  const { inScope } = resolveDesignImplementInScope({
    acceptedFeatureIds: acceptedIds,
    lastImplementedFeatureIds: meta.lastImplementedFeatureIds,
  });
  const version = meta.acceptedVersion ?? meta.currentVersion;
  const request = readDesignLoopRequest(project.rootPath, meta.id, version);
  const isExtensionImplement = Boolean(
    meta.lastImplementedVersion != null ||
      (meta.lastImplementedFeatureIds?.length ?? 0) > 0,
  );
  const description = phaseDescriptionFromDesignAccept({
    request,
    briefFallback: meta.brief,
    inScopeIds: inScope,
    features: acceptance?.features,
    isExtensionImplement,
  });

  const phase = store.createPhase({
    projectId: project.id,
    description,
    rootPath: project.rootPath,
    dependsOn: opts.dependsOn,
  });

  const bound = bindAcceptedDesignLoopToPhase({
    projectRoot: project.rootPath,
    loopId: meta.id,
    phaseId: phase.id,
  });

  const run = store.createRun({ phaseId: phase.id, projectId: project.id });
  touchRunStage(run.id, "researching");
  activeRuns.add(run.id);
  const ac = new AbortController();
  abortControllers.set(run.id, ac);
  const { orchestrator } = getRuntime(project.rootPath);
  const researchDescription = phase.description;
  void (async () => {
    try {
      const stage = await orchestrator.startResearch({
        project,
        phase: store.getPhase(phase.id) ?? phase,
        run: store.getRun(run.id) ?? run,
        description: researchDescription,
        listProjects: () => store.listProjects(),
        onStage: (s) => touchRunStage(run.id, s),
      });
      touchRunStage(run.id, stage);
      updatePhaseStatus(
        phase.id,
        stage === "in_review" ? "in_review" : "draft",
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error("design-loop", "relaunch design research failed", {
        projectId: project.id,
        loopId: meta.id,
        runId: run.id,
        error: errMsg,
      });
      appendRunLog(
        project.rootPath,
        run.id,
        `relaunch_design_research failed: ${errMsg}`,
      );
      touchRunStage(run.id, "failed");
      updatePhaseStatus(phase.id, "draft");
    } finally {
      activeRuns.delete(run.id);
      abortControllers.delete(run.id);
    }
  })();

  return { phase, bound, run };
}

function formatBgErrorDetail(error: unknown, maxChars = 2_000): string {
  const chunks: string[] = [];
  const push = (label: string, value: unknown) => {
    if (value == null) return;
    const text =
      typeof value === "string"
        ? value
        : (() => {
            try {
              return JSON.stringify(value);
            } catch {
              return String(value);
            }
          })();
    if (!text.trim()) return;
    chunks.push(label ? `${label}=${text.slice(0, maxChars)}` : text.slice(0, maxChars));
  };
  const walk = (err: unknown, depth: number) => {
    if (err == null || depth > 4) return;
    if (typeof err === "string") {
      push("", err);
      return;
    }
    if (err instanceof Error) {
      push("", err.message);
      const any = err as Error & Record<string, unknown>;
      for (const key of [
        "statusCode",
        "status",
        "code",
        "url",
        "responseBody",
        "data",
        "body",
      ]) {
        push(key, any[key]);
      }
      if (any.cause != null) walk(any.cause, depth + 1);
      return;
    }
    if (typeof err === "object") push("detail", err);
  };
  walk(error, 0);
  return (chunks.filter(Boolean).join(" | ") || "unknown error").slice(0, maxChars + 400);
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
      const message = formatBgErrorDetail(error);
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

const RETRY_VERIFY_STAGES = new Set(["blocked", "failed", "interrupted"]);

/** Re-run develop verify suite only (no coding / merge). Awaits completion. */
async function executeRetryVerify(
  runId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const run = store.getRun(runId);
  if (!run) {
    return { status: 404, body: { error: "Run not found" } };
  }
  const project = store.getProject(run.projectId);
  const phase = store.getPhase(run.phaseId);
  if (!project || !phase) {
    return { status: 404, body: { error: "Project or phase not found" } };
  }
  if (!RETRY_VERIFY_STAGES.has(run.stage)) {
    return {
      status: 409,
      body: {
        error: "retry_verify_not_allowed",
        message:
          "retry_verify is only allowed when the run stage is blocked, failed, or interrupted.",
        stage: run.stage,
      },
    };
  }
  const unmet = unmetPhaseDependencies(phase, store.listPhases(project.id));
  if (unmet.length > 0) {
    return {
      status: 409,
      body: {
        error: "Phase dependencies are not complete",
        unmet,
        dependsOn: phase.dependsOn ?? [],
      },
    };
  }
  const blockingRunId = developLock.getLiveClaim(project.id);
  if (blockingRunId) {
    const blocking = store.getRun(blockingRunId);
    return {
      status: 409,
      body: {
        error: "development_in_progress",
        message:
          "Another develop job is already running for this project. Wait for it to finish or stop_run, then retry.",
        blockingRunId,
        blockingPhaseId: blocking?.phaseId,
        blockingStage: blocking?.stage,
      },
    };
  }
  const claim = developLock.tryClaim(project.id, run.id);
  if (!claim.ok) {
    const blocking = store.getRun(claim.blockingRunId);
    return {
      status: 409,
      body: {
        error: "development_in_progress",
        message:
          "Another develop job is already running for this project. Wait for it to finish or stop_run, then retry.",
        blockingRunId: claim.blockingRunId,
        blockingPhaseId: blocking?.phaseId,
        blockingStage: blocking?.stage,
      },
    };
  }

  touchRunStage(run.id, "developing");
  updatePhaseStatus(phase.id, "developing");
  activeRuns.add(run.id);
  const ac = new AbortController();
  abortControllers.set(run.id, ac);

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const result = await orchestrator.retryVerify({
      project,
      phase: store.getPhase(phase.id) ?? phase,
      run: store.getRun(run.id) ?? run,
      signal: ac.signal,
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
      result.stage === "blocked"
        ? "blocked"
        : result.stage === "interrupted"
          ? "interrupted"
          : "developing",
    );
    const steps = readVerifyStepsReport(project.rootPath, run.id);
    return {
      status: 200,
      body: {
        runId: run.id,
        ok: result.ok,
        stage: result.stage,
        firstFailure: result.firstFailure ?? null,
        stepsSummary: result.stepsSummary,
        steps: steps?.steps ?? null,
        accepted: true,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    touchRunStage(run.id, "failed");
    updatePhaseStatus(phase.id, "failed");
    return {
      status: 500,
      body: { error: "retry_verify_failed", message, runId: run.id },
    };
  } finally {
    activeRuns.delete(run.id);
    abortControllers.delete(run.id);
    developLock.release(project.id, run.id);
  }
}

app.get("/health", async (_req, res) => {
  const dataDir = defaultDataDir();
  const mastraPath = join(dataDir, "mastra.db");
  const mastraStorage = probeMastraDbFile(mastraPath);
  let npmRegistry: {
    enabled: boolean;
    up: boolean;
    url?: string;
    status?: string;
    packageCount?: number;
  } = { enabled: false, up: false };
  try {
    const { refreshNpmRegistryStatus, getNpmRegistryStatus } = await import(
      "./npm-registry.js"
    );
    const meta = isNpmRegistryEnvOff()
      ? null
      : await refreshNpmRegistryStatus(dataDir).catch(() => null);
    const st = getNpmRegistryStatus(dataDir);
    npmRegistry = {
      enabled: st.enabled,
      up: Boolean(meta?.status === "up" || st.up),
      url: meta?.url ?? st.meta?.url,
      status: meta?.status ?? st.meta?.status,
      packageCount: st.packages.length,
    };
  } catch {
    /* optional */
  }
  res.json({
    ok: true,
    projects: store.listProjects().length,
    activeRuns: activeRuns.size,
    dataDir,
    mastraStorage,
    npmRegistry,
    mcp: { path: "/mcp", transport: "streamable-http" },
  });
});

function isNpmRegistryEnvOff(): boolean {
  const v = (process.env.SLOPCONTROL_NPM_REGISTRY ?? "1").trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

/**
 * Read the last N lines of a file efficiently — reads from the end in chunks
 * without loading the entire file into memory.
 */
function readTailLines(filePath: string, maxLines: number): string {
  try {
    const stat = statSync(filePath);
    if (stat.size === 0) return "";
    const CHUNK = 8192;
    const fd = openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(CHUNK);
      let pos = stat.size;
      let lines: string[] = [];
      let leftover = "";

      while (pos > 0 && lines.length < maxLines) {
        const readSize = Math.min(CHUNK, pos);
        pos -= readSize;
        readSync(fd, buf, 0, readSize, pos);
        const chunk = buf.toString("utf-8", 0, readSize) + leftover;
        const parts = chunk.split("\n");
        leftover = parts.shift() ?? "";
        lines = [...parts, ...lines];
      }
      if (leftover && lines.length < maxLines) {
        lines = [leftover, ...lines];
      }
      // Return only the last maxLines
      return lines.slice(-maxLines).join("\n");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// ===== Runs list (for dashboard) =====

function buildRunPayload(run: Run) {
  const project = store.getProject(run.projectId);
  const phase = store.getPhase(run.phaseId);
  if (!project) return null;

  // Tombstone row: merged into an archive run — no fs reads, cheap listing.
  if (run.archived && run.archivedInto) {
    return {
      id: run.id,
      archived: true,
      archived_into: run.archivedInto,
      project_id: run.projectId,
      phase_id: run.phaseId,
      stage: run.stage,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
      researchRunning: false,
      devRunning: false,
    };
  }

  // Synthetic archive run: surface the compaction manifest.
  let archiveManifest: unknown = null;
  if (run.archived && run.mergedRunIds) {
    const archiveRoot = join(project.rootPath, ".slopcontrol", "archive");
    try {
      for (const dir of readdirSync(archiveRoot)) {
        if (!dir.startsWith("runs-compact-")) continue;
        const manifestPath = join(archiveRoot, dir, "ARCHIVE.json");
        if (!existsSync(manifestPath)) continue;
        const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
          archiveRunId?: string;
        };
        if (parsed.archiveRunId === run.id) {
          archiveManifest = parsed;
          break;
        }
      }
    } catch {
      /* archive dir missing or unreadable — payload still works */
    }
  }

  let devOutput = "";
  const logPath = join(project.rootPath, ".slopcontrol", "runs", run.id, "log.txt");
  if (existsSync(logPath)) {
    devOutput = readTailLines(logPath, 500);
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
  const verifySteps = readVerifyStepsReport(project.rootPath, run.id);

  return {
    id: run.id,
    idea: run.archiveTitle ?? phase?.description ?? "",
    project_dir: project.rootPath,
    stage: run.stage,
    archived: run.archived === true ? true : undefined,
    merged_run_ids: run.mergedRunIds,
    archive: archiveManifest,
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
    failure_summary: diagnosis
      ? `${diagnosis.title}${diagnosis.rootCause ? `: ${diagnosis.rootCause.slice(0, 240)}` : ""}`
      : null,
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
    verify_steps: verifySteps?.steps ?? null,
    verify_first_failure: verifySteps?.firstFailure
      ? {
          id: verifySteps.firstFailure.id,
          name: verifySteps.firstFailure.name,
          exitCode: verifySteps.firstFailure.exitCode,
          command: verifySteps.firstFailure.command,
        }
      : null,
    verify_ok: verifySteps ? verifySteps.ok : null,
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
  const skipBuildOnboarding = Boolean(req.body?.skipBuildOnboarding);
  const componentLibrary =
    typeof req.body?.componentLibrary === "boolean"
      ? (req.body.componentLibrary as boolean)
      : undefined;
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
    if (!skipBuildOnboarding) {
      kickoffBuildProcessOnboarding(project.id, { componentLibrary });
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
  res.json({
    projects: store.listProjects().map((project) => {
      const config = readProjectConfig(project.rootPath);
      return {
        ...project,
        buildProcessConfigured:
          resolveProjectToolchain({
            projectRoot: project.rootPath,
            configured: config.toolchain ?? null,
          }).source !== "none",
        codingToolId: config.codingToolId ?? "opencode",
        askInvestigateTool: config.askInvestigateTool ?? "auto",
      };
    }),
  });
});

/**
 * Update display fields for a project (rename). Does not move rootPath/id.
 */
app.patch("/projects/:id", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const name = String((req.body as { name?: unknown } | undefined)?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  project.name = name;
  project.updatedAt = new Date().toISOString();
  store.updateProject(project);
  log.info("project", "renamed", { projectId: project.id, name });
  res.json({ project });
});

/**
 * Build-process state for Hermes: resolved toolchain + recorded evidence.
 * No LLM call — reads .slopcontrol/config.json + BUILD_PROCESS.json.
 */
app.get("/projects/:id/build-process", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const registryMeta = readNpmRegistryMeta(defaultDataDir());
  res.json(
    getProjectBuildProcessState({
      projectRoot: project.rootPath,
      registryEnv: registryMeta
        ? npmRegistryEnvValues(registryMeta)
        : undefined,
    }),
  );
});

/**
 * Fire-and-forget import-time onboarding. Runs entirely in the background so
 * registration responds immediately; outcome lands in BUILD_PROCESS.json
 * (onboarding status) for the state endpoint to surface. Never throws.
 */
function kickoffBuildProcessOnboarding(
  projectId: string,
  opts?: { componentLibrary?: boolean },
): void {
  const project = store.getProject(projectId);
  if (!project) return;
  void (async () => {
    try {
      const { registry } = getRuntime(project.rootPath);
      const { endpoint, modelId } =
        registry.resolveEndpointForRole("classification");
      const registryMeta = readNpmRegistryMeta(defaultDataDir());
      const report = await onboardProjectBuildProcess({
        projectRoot: project.rootPath,
        endpoint,
        modelId,
        registryMeta,
        componentLibrary: opts?.componentLibrary,
      });
      log.info("project", "build-process onboarding finished", {
        projectId: project.id,
        status: report.status,
        toolchain: report.toolchainKind,
        envFiles: report.envFiles,
      });
    } catch (err) {
      log.error("project", "build-process onboarding crashed", {
        projectId: project.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

/** LLM audit: resolve toolchain + gaps against the capability checklist. */
app.post("/projects/:id/build-process/audit", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const { registry } = getRuntime(project.rootPath);
    const { endpoint, modelId } =
      registry.resolveEndpointForRole("classification");
    const report = await auditProjectBuildProcess({
      projectRoot: project.rootPath,
      endpoint,
      modelId,
    });
    log.info("project", "build-process audit", {
      projectId: project.id,
      confidence: report.result.confidence,
      gaps: report.result.gaps.length,
    });
    res.json(report);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** LLM configure: propose → guardrailed apply → persist toolchain. */
app.post("/projects/:id/build-process/configure", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const { registry } = getRuntime(project.rootPath);
    const { endpoint, modelId } =
      registry.resolveEndpointForRole("classification");
    const runCommands =
      (req.body as { runCommands?: boolean } | undefined)?.runCommands !==
      false;
    const report = await configureProjectBuildProcess({
      projectRoot: project.rootPath,
      endpoint,
      modelId,
      runCommands,
    });
    // A configure must leave the project fully wired: inject the canonical
    // registry env (SLOPCONTROL_NPM_REGISTRY_*) into the project's env files,
    // same as import-time onboarding does.
    let envFiles: string[] = [];
    let tokenWritten = false;
    if (report.applied && !report.auditOnly) {
      const env = writeProjectRegistryEnv({
        projectRoot: project.rootPath,
        meta: ensureNpmRegistryLayout(defaultDataDir()),
      });
      envFiles = env.files;
      tokenWritten = env.tokenWritten;
    }
    log.info("project", "build-process configure", {
      projectId: project.id,
      applied: report.applied,
      auditOnly: report.auditOnly,
      changes: report.changes.filter((c) => c.applied).length,
      envFiles: envFiles.length,
    });
    res.json({ ...report, envFiles, tokenWritten });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Run the project-native env sync (envSyncCmd) at the project root. The
 * project owns merge semantics; SlopControl only orchestrates. 409 when no
 * envSyncCmd is resolved (project needs a `manage` script or a persisted
 * toolchain envSyncCmd).
 */
app.post("/projects/:id/env/sync", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const result = await runProjectEnvSync({ projectRoot: project.rootPath });
    if ("reason" in result) {
      res.status(409).json({ error: NO_ENV_SYNC_HINT });
      return;
    }
    log.info("project", "env sync", {
      projectId: project.id,
      code: result.code,
    });
    res.status(result.ok ? 200 : 500).json(result);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Run compaction: flatten old terminal runs into a single archive run.
 * dryRun returns the plan without writing anything.
 */
app.post("/projects/:id/runs/compact", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const config = readProjectConfig(project.rootPath);
    const result = await compactProjectRuns({
      projectId: project.id,
      projectRoot: project.rootPath,
      store,
      activeRunIds: activeRuns,
      dryRun: req.body?.dryRun === true,
      config: config.runCompaction ?? {},
    });
    if (result.status === 409) {
      res.status(409).json({ error: result.error });
      return;
    }
    if (result.body.compacted === true) {
      log.info("runs", "compacted", {
        projectId: project.id,
        archiveRunId: result.body.archiveRunId,
        merged: (result.body.mergedRunIds as string[]).length,
      });
    }
    res.json(result.body);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.put("/projects/:id/build-process/toolchain", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const body = (req.body ?? {}) as {
      toolchain?: unknown;
      componentLibrary?: boolean;
    };
    const toolchain = body.toolchain ?? req.body;
    const out = updateProjectToolchain({
      projectRoot: project.rootPath,
      toolchain,
      componentLibrary:
        typeof body.componentLibrary === "boolean"
          ? body.componentLibrary
          : undefined,
    });
    log.info("project", "build-process toolchain manual override", {
      projectId: project.id,
      kind: out.toolchain.kind,
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Post-onboarding smoke check: frozen install + build with the canonical
 * registry env. Opt-in (Hermes) — installs are too slow for import time.
 */
app.post("/projects/:id/build-process/verify", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    const registryMeta = readNpmRegistryMeta(defaultDataDir());
    const report = await verifyProjectBuildProcess({
      projectRoot: project.rootPath,
      registryMeta,
    });
    log.info("project", "build-process verify", {
      projectId: project.id,
      ok: report.ok,
      steps: report.steps.map((s) => `${s.step}:${s.code}`).join(","),
    });
    res.json(report);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/** Hermes/operator override of the per-project coding agent (opencode|pi). */
app.put("/projects/:id/coding-tool", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const body = (req.body ?? {}) as { toolId?: unknown };
  const toolId = typeof body.toolId === "string" ? body.toolId.trim() : "";
  if (!toolId) {
    res.status(400).json({ error: "toolId is required" });
    return;
  }
  const known = listCodingTools().map((t) => t.id);
  if (!known.includes(toolId)) {
    res.status(400).json({
      error: `Unknown coding tool "${toolId}". Registered: ${known.join(", ")}`,
    });
    return;
  }
  const config = readProjectConfig(project.rootPath);
  config.codingToolId = toolId;
  writeProjectConfig(project.rootPath, config);
  log.info("project", "coding tool switched", {
    projectId: project.id,
    codingToolId: toolId,
  });
  res.json({ projectId: project.id, codingToolId: toolId, knownTools: known });
});

/** Per-project Ask investigation walker (auto|mastra|pi). */
app.put("/projects/:id/ask-investigate-tool", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const parsed = AskInvestigateToolSchema.safeParse(
    typeof req.body?.tool === "string"
      ? req.body.tool.trim()
      : req.body?.askInvestigateTool,
  );
  if (!parsed.success) {
    res.status(400).json({
      error: "tool must be one of: auto, mastra, pi",
    });
    return;
  }
  const config = readProjectConfig(project.rootPath);
  config.askInvestigateTool = parsed.data;
  writeProjectConfig(project.rootPath, config);
  log.info("project", "ask investigate tool switched", {
    projectId: project.id,
    askInvestigateTool: parsed.data,
  });
  res.json({
    projectId: project.id,
    askInvestigateTool: parsed.data,
  });
});

/**
 * Consume side of the registry cycle: update THIS project to a published
 * library version via its own toolchain (pnpm add …) and commit the bump.
 * For projects imported before publish-time propagation existed.
 */
app.post("/projects/:id/design-library/consume", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    packageName?: string;
    version?: string;
    commitBump?: boolean;
  };
  if (!body.packageName) {
    res.status(400).json({ error: "packageName is required" });
    return;
  }
  try {
    const { consumeLibraryFromRegistry } = await import("./npm-registry.js");
    const report = await consumeLibraryFromRegistry({
      dataDir: defaultDataDir(),
      projectRoot: project.rootPath,
      packageName: body.packageName,
      version: body.version,
      commitBump: body.commitBump,
    });
    log.info("project", "design library consume", {
      projectId: project.id,
      name: report.packageName,
      version: report.version,
      ok: report.ok,
    });
    res.json(report);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
  const skipBuildOnboarding = Boolean(req.body?.skipBuildOnboarding);
  const componentLibrary =
    typeof req.body?.componentLibrary === "boolean"
      ? (req.body.componentLibrary as boolean)
      : undefined;
  if (!rootPath) {
    res.status(400).json({ error: "rootPath is required" });
    return;
  }
  const project = store.createProject({ name, rootPath });
  if (!skipBuildOnboarding) {
    kickoffBuildProcessOnboarding(project.id, { componentLibrary });
  }
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
  const forceNew =
    req.body?.newAsk === true ||
    req.body?.forceNew === true ||
    req.body?.newAsk === "true" ||
    req.body?.forceNew === "true";
  const stream = wantsLiveStream(req);
  const investigateParsed = AskInvestigateToolSchema.safeParse(
    req.body?.investigateTool,
  );
  const investigateTool = investigateParsed.success
    ? investigateParsed.data
    : undefined;

  const now = new Date().toISOString();
  const userMsg = { role: "user" as const, content: message, at: now };

  let ask = askId ? store.getAsk(askId) : undefined;
  if (askId && (!ask || ask.projectId !== project.id)) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  // Sticky resume: omit askId → continue latest open ask (unless newAsk)
  if (!ask && !forceNew) {
    ask = store.latestOpenAsk(project.id);
    if (ask) askId = ask.id;
  }
  if (ask && ask.status === "promoted") {
    res.status(409).json({
      error:
        "Ask already promoted; call fork_ask to continue chatting, or pass newAsk=true for a fresh session",
      promotedPhaseId: ask.promotedPhaseId,
      askId: ask.id,
      hint: "fork_ask",
    });
    return;
  }
  if (ask && ask.status === "archived") {
    res.status(409).json({
      error:
        "Ask is archived; call fork_ask to continue from its transcript, or pass newAsk=true",
      askId: ask.id,
      hint: "fork_ask",
    });
    return;
  }

  if (!ask) {
    ask = store.createAsk({
      projectId: project.id,
      title: title || message,
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

  const bound = bindLiveTurn({
    kind: "ask",
    projectId: project.id,
    sessionId: ask.id,
    res,
    stream,
  });
  let workingStubStarted = false;

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const { reply } = await orchestrator.askTurn({
      project,
      askId: ask.id,
      message,
      history,
      listProjects: () => store.listProjects(),
      dataDir: defaultDataDir(),
      abortSignal: bound.signal,
      ...(investigateTool ? { investigateTool } : {}),
      onProgress: (event) => {
        bound.onProgress(event);
        const line = askProgressLine(event);
        if (!line) return;
        const stub = workingStubFromBound(bound);
        if (!workingStubStarted) {
          ask = store.appendAskMessage(ask!.id, {
            role: "assistant",
            content: stub,
            at: new Date().toISOString(),
          }) ?? ask;
          workingStubStarted = true;
        } else {
          ask =
            store.replaceLastAssistantAskMessage(ask!.id, stub) ?? ask;
        }
        writeAskArtifacts(project.rootPath, ask!);
      },
    });
    const assistantAt = new Date().toISOString();
    if (workingStubStarted) {
      ask =
        store.replaceLastAssistantAskMessage(ask.id, reply, assistantAt) ??
        ask;
    } else {
      ask =
        store.appendAskMessage(ask.id, {
          role: "assistant",
          content: reply,
          at: assistantAt,
        }) ?? ask;
    }
    writeAskArtifacts(project.rootPath, ask);
    if (stream) {
      bound.completeDone({ reply, askId: ask.id, ask });
      return;
    }
    liveTurns.complete(bound.turnId, "done");
    res.json({ ask, reply, askId: ask.id, turnId: bound.turnId });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("ask", "ask turn failed", {
      projectId: project.id,
      askId: ask.id,
      error: errMsg,
    });

    if (isLiveTurnInterruptedError(error)) {
      const partial =
        (error as { partialReply?: string }).partialReply?.trim() ||
        workingStubFromBound(bound) ||
        "Interrupted.";
      const recovery = `${partial}\n\n---\nAsk interrupted (${liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop"}). Call ask again or narrow the question.`;
      const assistantAt = new Date().toISOString();
      if (workingStubStarted) {
        ask =
          store.replaceLastAssistantAskMessage(
            ask.id,
            recovery,
            assistantAt,
          ) ?? ask;
      } else {
        ask =
          store.appendAskMessage(ask.id, {
            role: "assistant",
            content: recovery,
            at: assistantAt,
          }) ?? ask;
      }
      writeAskArtifacts(project.rootPath, ask);
      if (stream) {
        bound.completeInterrupted(recovery, { askId: ask.id, ask });
        return;
      }
      liveTurns.complete(bound.turnId, "interrupted", {
        partialReply: recovery,
      });
      res.status(499).json({
        error: errMsg,
        code: "interrupted",
        reply: recovery,
        ask,
        askId: ask.id,
        turnId: bound.turnId,
      });
      return;
    }

    if (isAskAgentTimeoutError(error)) {
      const partial = workingStubFromBound(bound);
      const recovery = partial
        ? `${partial}\n\n---\n${ASK_TIMEOUT_RECOVERY_MESSAGE}`
        : ASK_TIMEOUT_RECOVERY_MESSAGE;
      const assistantAt = new Date().toISOString();
      if (workingStubStarted) {
        ask =
          store.replaceLastAssistantAskMessage(
            ask.id,
            recovery,
            assistantAt,
          ) ?? ask;
      } else {
        ask =
          store.appendAskMessage(ask.id, {
            role: "assistant",
            content: recovery,
            at: assistantAt,
          }) ?? ask;
      }
      writeAskArtifacts(project.rootPath, ask);
      if (stream) {
        bound.completeFailed(errMsg, {
          code: "ask_timeout",
          reply: recovery,
          askId: ask.id,
          ask,
          hint: "retry_ask_or_narrow",
        });
        return;
      }
      liveTurns.complete(bound.turnId, "failed", { reason: errMsg });
      res.status(504).json({
        error: errMsg,
        code: "ask_timeout",
        reply: recovery,
        hint: "retry_ask_or_narrow",
        ask,
        askId: ask.id,
      });
      return;
    }
    writeAskArtifacts(project.rootPath, ask);
    if (stream) {
      bound.completeFailed(errMsg, { askId: ask.id, ask });
      return;
    }
    liveTurns.complete(bound.turnId, "failed", { reason: errMsg });
    res.status(500).json({ error: errMsg, ask, askId: ask.id });
  }
});

app.post("/projects/:id/asks/:askId/stop", (req, res) => {
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
  const stopped = liveTurns.stop("ask", ask.id, "operator_stop");
  if (!stopped) {
    res.status(409).json({
      error: "No active ask turn to stop",
      askId: ask.id,
    });
    return;
  }
  res.json({
    ok: true,
    code: "interrupted",
    askId: ask.id,
    turnId: stopped.turnId,
    reason: stopped.interruptReason,
  });
});

app.post("/projects/:id/asks/:askId/fork", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const source = store.getAsk(req.params.askId);
  if (!source || source.projectId !== project.id) {
    res.status(404).json({ error: "Ask not found" });
    return;
  }
  const title =
    typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  const forked = store.forkAsk(source.id, { title });
  if (!forked) {
    res.status(500).json({ error: "Failed to fork ask" });
    return;
  }
  writeAskArtifacts(project.rootPath, forked);
  res.status(201).json({ ask: forked, askId: forked.id, forkedFrom: source.id });
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
  {
    const { registry } = getRuntime(project.rootPath);
    await ensureChangeIntentAsync(
      project.rootPath,
      phase.id,
      description,
      { registry },
    );
  }

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
    const stage = await orchestrator.startResearch({
      project,
      phase: store.getPhase(phase.id) ?? phase,
      run: store.getRun(run.id) ?? run,
      description,
      listProjects: () => store.listProjects(),
      onStage: (s) => touchRunStage(run.id, s),
    });
    touchRunStage(run.id, stage);
    updatePhaseStatus(
      phase.id,
      stage === "in_review"
        ? "in_review"
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
      error:
        "Ask already promoted; call fork_ask to continue chatting, then ask_sub_research on the forked session",
      promotedPhaseId: ask.promotedPhaseId,
      askId: ask.id,
      hint: "fork_ask",
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
  const stream = wantsLiveStream(req);

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

  const bound = bindLiveTurn({
    kind: "agent",
    projectId: project.id,
    sessionId: agent.id,
    res,
    stream,
  });
  let workingStubStarted = false;

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const { reply } = await orchestrator.agentTurn({
      project,
      agentId: agent.id,
      message,
      history,
      listProjects: () => store.listProjects(),
      dataDir: defaultDataDir(),
      abortSignal: bound.signal,
      onProgress: (event) => {
        bound.onProgress(event);
        const line = askProgressLine(event);
        if (!line) return;
        const stub = workingStubFromBound(bound);
        if (!workingStubStarted) {
          agent = store.appendAgentMessage(agent!.id, {
            role: "assistant",
            content: stub,
            at: new Date().toISOString(),
          }) ?? agent;
          workingStubStarted = true;
        } else {
          const a = store.getAgent(agent!.id);
          if (a && a.messages[a.messages.length - 1]?.role === "assistant") {
            a.messages = [
              ...a.messages.slice(0, -1),
              {
                role: "assistant",
                content: stub,
                at: new Date().toISOString(),
              },
            ];
            store.updateAgent(a);
            agent = a;
          }
        }
        writeAgentArtifacts(project.rootPath, agent!);
      },
    });
    const assistantAt = new Date().toISOString();
    if (workingStubStarted) {
      const a = store.getAgent(agent.id);
      if (a && a.messages[a.messages.length - 1]?.role === "assistant") {
        a.messages = [
          ...a.messages.slice(0, -1),
          { role: "assistant", content: reply, at: assistantAt },
        ];
        store.updateAgent(a);
        agent = a;
      }
    } else {
      agent =
        store.appendAgentMessage(agent.id, {
          role: "assistant",
          content: reply,
          at: assistantAt,
        }) ?? agent;
    }
    writeAgentArtifacts(project.rootPath, agent);
    if (stream) {
      bound.completeDone({ reply, agentId: agent.id, agent });
      return;
    }
    liveTurns.complete(bound.turnId, "done");
    res.json({ agent, reply, turnId: bound.turnId });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("agent", "agent turn failed", {
      projectId: project.id,
      agentId: agent.id,
      error: errMsg,
    });
    if (isLiveTurnInterruptedError(error)) {
      const partial =
        (error as { partialReply?: string }).partialReply?.trim() ||
        workingStubFromBound(bound) ||
        "Interrupted.";
      const reason =
        liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
      const recovery = `${partial}\n\n---\nAgent turn interrupted (${reason}). Call agent again or use stop_session next time to redirect sooner.`;
      if (workingStubStarted) {
        const a = store.getAgent(agent.id);
        if (a && a.messages[a.messages.length - 1]?.role === "assistant") {
          a.messages = [
            ...a.messages.slice(0, -1),
            {
              role: "assistant",
              content: recovery,
              at: new Date().toISOString(),
            },
          ];
          store.updateAgent(a);
          agent = a;
        }
      } else {
        agent =
          store.appendAgentMessage(agent.id, {
            role: "assistant",
            content: recovery,
            at: new Date().toISOString(),
          }) ?? agent;
      }
      writeAgentArtifacts(project.rootPath, agent);
      if (stream) {
        bound.completeInterrupted(recovery, { agentId: agent.id, agent });
        return;
      }
      liveTurns.complete(bound.turnId, "interrupted", {
        partialReply: recovery,
      });
      res.status(499).json({
        error: errMsg,
        code: "interrupted",
        reply: recovery,
        agent,
      });
      return;
    }
    if (stream) {
      bound.completeFailed(errMsg, { agent });
      return;
    }
    liveTurns.complete(bound.turnId, "failed", { reason: errMsg });
    res.status(500).json({ error: errMsg, agent });
  }
});

app.post("/projects/:id/agents/:agentId/stop", (req, res) => {
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
  const stopped = liveTurns.stop("agent", agent.id, "operator_stop");
  if (!stopped) {
    res.status(409).json({
      error: "No active agent turn to stop",
      agentId: agent.id,
    });
    return;
  }
  res.json({
    ok: true,
    code: "interrupted",
    agentId: agent.id,
    turnId: stopped.turnId,
  });
});

// ── Plan loops (chat → PLAN.md → accept → promote → research) ─────────────

app.get("/projects/:id/plan-loops", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  res.json({ projectId: project.id, loops: listPlanLoops(project.rootPath) });
});

app.get("/projects/:id/plan-loops/:loopId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  const version =
    typeof req.query.version === "string" && req.query.version.trim()
      ? Number(req.query.version)
      : meta.status === "open"
        ? meta.currentVersion
        : meta.acceptedVersion ?? meta.currentVersion;
  const includePlan = req.query.includePlan !== "false";
  const plan =
    includePlan && Number.isFinite(version) && version > 0
      ? readPlanLoopPlanMd(project.rootPath, meta.id, version)
      : null;
  const notes =
    Number.isFinite(version) && version > 0
      ? readPlanLoopNotes(project.rootPath, meta.id, version)
      : null;
  const versionMeta =
    Number.isFinite(version) && version > 0
      ? readPlanLoopVersionMeta(project.rootPath, meta.id, version)
      : null;
  let acceptance = readPlanLoopAcceptance(project.rootPath, meta.id);
  if (!acceptance && plan?.trim() && Number.isFinite(version) && version > 0) {
    acceptance = seedPlanLoopAcceptance({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version: version as number,
    });
  }
  const designPack = readPlanLoopPack(project.rootPath, meta.id);
  const acceptanceInScope =
    acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [];
  res.json({
    loop: meta,
    loopId: meta.id,
    version: Number.isFinite(version) ? version : null,
    plan,
    notes,
    transcript: readPlanLoopTranscript(project.rootPath, meta.id),
    messages: readLoopChatMessages(project.rootPath, "plan", meta.id),
    versionMeta,
    usedScaffold: versionMeta?.usedScaffold ?? false,
    acceptance,
    planPack: designPack,
    conceptualModel: summarizePlanConceptualModel({
      meta,
      inScope: acceptanceInScope,
    }),
    versions: buildPlanLoopVersionTree(project.rootPath, meta.id),
  });
});

app.post("/projects/:id/plan-loops", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const brief = String(req.body?.brief ?? req.body?.message ?? "").trim();
  if (!brief) {
    res.status(400).json({ error: "brief is required" });
    return;
  }
  const phaseId =
    typeof req.body?.phaseId === "string" ? req.body.phaseId.trim() : undefined;
  const askId =
    typeof req.body?.askId === "string" ? req.body.askId.trim() : undefined;
  const scope =
    req.body?.scope && typeof req.body.scope === "object"
      ? {
          kind: String(req.body.scope.kind || "feature") as
            | "feature"
            | "bugfix"
            | "refactor"
            | "integration"
            | "spike",
          focus: String(req.body.scope.focus || "change"),
          preserve: Array.isArray(req.body.scope.preserve)
            ? req.body.scope.preserve.map(String)
            : [],
          source: "manual" as const,
        }
      : defaultPlanScope(brief, "start");

  const meta = createPlanLoopMeta({
    projectId: project.id,
    brief,
    phaseId: phaseId || undefined,
    askId: askId || undefined,
    scope,
  });
  writePlanLoopMeta(project.rootPath, meta);

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const version = 1;
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "plan_loop",
      projectId: project.id,
      sessionId: meta.id,
      res,
      stream,
    });
    const planChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "plan",
      loopId: meta.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    planChat.appendUser(brief);
    let plan: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ plan, notes, usedScaffold, reply } = await orchestrator.planLoopGenerate({
        project,
        loopId: meta.id,
        brief,
        version,
        listProjects: () => store.listProjects(),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: planChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Plan generate interrupted.";
        const recovery = `${partial}\n\n---\nPlan generate interrupted (${reason}). Call plan_loop_continue or plan_loop_retry with a narrower brief.`;
        planChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: meta.id,
            notes: recovery,
            reply: recovery,
            messages: planChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: meta.id,
          notes: recovery,
          reply: recovery,
          messages: planChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");
    writePlanLoopVersion({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      plan,
      notes,
      request: brief,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion: null,
    });
    const acceptance = seedPlanLoopAcceptance({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
    });
    const fresh = readPlanLoopMeta(project.rootPath, meta.id) ?? meta;
    let next = {
      ...fresh,
      currentVersion: version,
      updatedAt: new Date().toISOString(),
    };
    writePlanLoopMeta(project.rootPath, next);
    next =
      setPlanLoopLastError(
        project.rootPath,
        meta.id,
        usedScaffold
          ? { version, reason: notes, at: new Date().toISOString() }
          : null,
      ) ?? next;
    const operatorReply = reply || notes || `Plan loop v${version} updated.`;
    const messages = planChat.finalizeAssistant(operatorReply, { version });
    const planStartPayload = {
      loop: next,
      loopId: next.id,
      version,
      plan,
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      acceptance,
      conceptualModel: summarizePlanConceptualModel({
        meta: next,
        inScope: [],
      }),
      hint: usedScaffold ? "plan_loop_retry" : undefined,
      transcript: readPlanLoopTranscript(project.rootPath, meta.id),
      versions: buildPlanLoopVersionTree(project.rootPath, meta.id),
      next: "Iterate with plan_loop_continue, tick acceptance, plan_loop_accept, then plan_loop_promote.",
    };
    if (stream) {
      bound.completeDone(planStartPayload);
      return;
    }
    res.status(201).json(planStartPayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("plan-loop", "start failed", {
      projectId: project.id,
      loopId: meta.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/plan-loops/:loopId/continue", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  let working = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!working || working.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  let reopenedFrom: string | undefined;
  if (working.status !== "open") {
    reopenedFrom = working.status;
    working = reopenPlanLoopForIterate(project.rootPath, working.id);
  }
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }
  const tip = resolvePlanLoopTip(project.rootPath, working.id);
  const baseRaw = req.body?.baseVersion;
  const baseVersion =
    typeof baseRaw === "number"
      ? baseRaw
      : typeof baseRaw === "string" && baseRaw.trim()
        ? Number(baseRaw)
        : tip;
  if (!Number.isFinite(baseVersion) || baseVersion < 1) {
    res.status(400).json({ error: "baseVersion required (or set tip)" });
    return;
  }
  try {
    assertActivePlanLoopBase({
      projectRoot: project.rootPath,
      loopId: working.id,
      version: baseVersion,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const previousPlan = readPlanLoopPlanMd(
    project.rootPath,
    working.id,
    baseVersion,
  );
  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const version = allocateNextPlanLoopVersion(
      project.rootPath,
      working.id,
    );
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "plan_loop",
      projectId: project.id,
      sessionId: working.id,
      res,
      stream,
    });
    const planChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "plan",
      loopId: working.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    planChat.appendUser(message);
    let plan: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ plan, notes, usedScaffold, reply } = await orchestrator.planLoopGenerate({
        project,
        loopId: working.id,
        brief: working.brief,
        message,
        previousPlan: previousPlan ?? undefined,
        version,
        listProjects: () => store.listProjects(),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: planChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Plan continue interrupted.";
        const recovery = `${partial}\n\n---\nPlan continue interrupted (${reason}). Call plan_loop_continue again or plan_loop_retry.`;
        planChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: working.id,
            notes: recovery,
            reply: recovery,
            messages: planChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: working.id,
          notes: recovery,
          reply: recovery,
          messages: planChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");
    writePlanLoopVersion({
      projectRoot: project.rootPath,
      loopId: working.id,
      version,
      plan,
      notes,
      request: message,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion: baseVersion,
    });
    const acceptance = seedPlanLoopAcceptance({
      projectRoot: project.rootPath,
      loopId: working.id,
      version,
    });
    const fresh =
      readPlanLoopMeta(project.rootPath, working.id) ?? working;
    let next = {
      ...fresh,
      currentVersion: version,
      updatedAt: new Date().toISOString(),
    };
    writePlanLoopMeta(project.rootPath, next);
    next =
      setPlanLoopLastError(
        project.rootPath,
        working.id,
        usedScaffold
          ? { version, reason: notes, at: new Date().toISOString() }
          : null,
      ) ?? next;
    const operatorReply = reply || notes || `Plan loop v${version} updated.`;
    const messages = planChat.finalizeAssistant(operatorReply, { version });
    const planContinuePayload = {
      loop: next,
      loopId: next.id,
      version,
      baseVersion,
      plan,
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      acceptance,
      conceptualModel: summarizePlanConceptualModel({ meta: next }),
      reopenedFrom,
      hint: usedScaffold ? "plan_loop_retry" : undefined,
      next: "Tick features, plan_loop_accept, then plan_loop_promote.",
      transcript: readPlanLoopTranscript(project.rootPath, working.id),
      versions: buildPlanLoopVersionTree(project.rootPath, working.id),
    };
    if (stream) {
      bound.completeDone(planContinuePayload);
      return;
    }
    res.json(planContinuePayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("plan-loop", "continue failed", {
      projectId: project.id,
      loopId: working.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loop: working, loopId: working.id });
  }
});


app.post("/projects/:id/plan-loops/:loopId/stop", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  const stopped = liveTurns.stop("plan_loop", meta.id, "operator_stop");
  if (!stopped) {
    res.status(409).json({
      error: "No active plan-loop turn to stop",
      loopId: meta.id,
    });
    return;
  }
  res.json({
    ok: true,
    code: "interrupted",
    loopId: meta.id,
    turnId: stopped.turnId,
  });
});

app.put("/projects/:id/plan-loops/:loopId/acceptance", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  const prior =
    readPlanLoopAcceptance(project.rootPath, meta.id) ??
    seedPlanLoopAcceptance({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version: meta.currentVersion || 1,
    });
  const features = applyPlanAcceptanceTicks({
    features: prior.features,
    nextFeatures: Array.isArray(req.body?.features)
      ? req.body.features
      : undefined,
    acceptedFeatureIds: Array.isArray(req.body?.acceptedFeatureIds)
      ? req.body.acceptedFeatureIds.map(String)
      : undefined,
  });
  const acceptance = {
    version: meta.currentVersion || prior.version,
    features,
    acceptedAt: prior.acceptedAt,
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopAcceptance(project.rootPath, meta.id, acceptance);
  res.json({ loop: meta, loopId: meta.id, acceptance });
});

app.post("/projects/:id/plan-loops/:loopId/accept", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  const versionRaw = req.body?.version;
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string" && versionRaw.trim()
        ? Number(versionRaw)
        : undefined;
  try {
    const accepted = acceptPlanLoop(project.rootPath, meta.id, version, {
      features: Array.isArray(req.body?.features) ? req.body.features : undefined,
      acceptedFeatureIds: Array.isArray(req.body?.acceptedFeatureIds)
        ? req.body.acceptedFeatureIds.map(String)
        : undefined,
    });
    const acceptance = readPlanLoopAcceptance(project.rootPath, accepted.id);
    const plan = readPlanLoopPlanMd(
      project.rootPath,
      accepted.id,
      accepted.acceptedVersion ?? accepted.currentVersion,
    );
    const pack = readPlanLoopPack(project.rootPath, accepted.id);
    appendPlanLoopTranscript(
      project.rootPath,
      accepted.id,
      "user",
      `Accepted v${accepted.acceptedVersion}`,
    );
    res.json({
      loop: accepted,
      loopId: accepted.id,
      version: accepted.acceptedVersion,
      plan,
      acceptance,
      planPack: pack,
      conceptualModel: summarizePlanConceptualModel({
        meta: accepted,
        inScope:
          acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [],
      }),
      next: "Call plan_loop_promote to bind the plan and start research.",
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes(PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR) || /usedScaffold|failure plan/i.test(errMsg)) {
      res.status(409).json({
        error: errMsg,
        loop: meta,
        loopId: meta.id,
        hint: "plan_loop_retry",
      });
      return;
    }
    res.status(400).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/plan-loops/:loopId/promote", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  if (meta.status === "open") {
    res.status(409).json({
      error: "Accept the plan loop before plan_loop_promote",
      loop: meta,
      loopId: meta.id,
      hint: "plan_loop_accept",
    });
    return;
  }
  const promoteVersion = meta.acceptedVersion ?? meta.currentVersion;
  try {
    assertPlanLoopVersionAcceptable(project.rootPath, meta.id, promoteVersion);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(409).json({
      error: errMsg,
      loop: meta,
      loopId: meta.id,
      hint: "plan_loop_retry",
    });
    return;
  }
  const startResearch = req.body?.startResearch !== false;
  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? req.body.dependsOn.map(String).filter(Boolean)
    : undefined;
  const pack = readPlanLoopPack(project.rootPath, meta.id);
  const description = pack
    ? phaseDescriptionFromPlanPack(pack)
    : meta.brief;

  const phase = store.createPhase({
    projectId: project.id,
    description,
    rootPath: project.rootPath,
    dependsOn,
  });

  try {
    const bound = bindAcceptedPlanLoopToPhase({
      projectRoot: project.rootPath,
      loopId: meta.id,
      phaseId: phase.id,
    });

    let run = null as ReturnType<typeof store.createRun> | null;
    if (startResearch) {
      run = store.createRun({ phaseId: phase.id, projectId: project.id });
      touchRunStage(run.id, "researching");
      updatePhaseStatus(phase.id, "draft");
      {
        const { registry } = getRuntime(project.rootPath);
        await ensureChangeIntentAsync(
          project.rootPath,
          phase.id,
          description,
          { registry },
        );
      }
      void import("@slopcontrol/artifacts").then(({ upsertRoadmapEntry }) => {
        upsertRoadmapEntry(
          project.rootPath,
          phase.id,
          phase.title ?? phase.description.slice(0, 80),
          "draft",
          phase.dependsOn ?? [],
        );
      });
      activeRuns.add(run.id);
      const ac = new AbortController();
      abortControllers.set(run.id, ac);
      const { orchestrator } = getRuntime(project.rootPath);
      void (async () => {
        try {
          const stage = await orchestrator.startResearch({
            project,
            phase: store.getPhase(phase.id) ?? phase,
            run: store.getRun(run!.id) ?? run!,
            description,
            listProjects: () => store.listProjects(),
      onStage: (s) => touchRunStage(run!.id, s),
          });
          touchRunStage(run!.id, stage);
          updatePhaseStatus(
            phase.id,
            stage === "in_review" ? "in_review" : "draft",
          );
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          log.error("plan-loop", "promote research failed", {
            projectId: project.id,
            loopId: meta.id,
            runId: run!.id,
            error: errMsg,
          });
          appendRunLog(
            project.rootPath,
            run!.id,
            `plan_loop_promote research failed: ${errMsg}`,
          );
          touchRunStage(run!.id, "failed");
          updatePhaseStatus(phase.id, "draft");
        } finally {
          activeRuns.delete(run!.id);
          abortControllers.delete(run!.id);
        }
      })();
    }

    res.status(202).json({
      loop: bound.meta,
      loopId: bound.meta.id,
      phase: store.getPhase(phase.id),
      phaseId: phase.id,
      version: bound.version,
      planPath: bound.planPath,
      planPack: readPlanLoopPack(project.rootPath, meta.id),
      run,
      runId: run?.id ?? null,
      stage: startResearch ? "researching" : "bound",
      next: startResearch
        ? "Research started from PLAN contract. After review approval, call start_development."
        : "Plan bound to phase. Call start_research or start_development when ready.",
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes(PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR) || /usedScaffold|failure plan/i.test(errMsg)) {
      res.status(409).json({
        error: errMsg,
        loop: meta,
        loopId: meta.id,
        hint: "plan_loop_retry",
      });
      return;
    }
    res.status(400).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/plan-loops/:loopId/retry", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  const version = meta.currentVersion;
  if (!version || version < 1) {
    res.status(400).json({ error: "No version to retry" });
    return;
  }
  const vm = readPlanLoopVersionMeta(project.rootPath, meta.id, version);
  const parent = vm?.parentVersion ?? null;
  const previousPlan =
    parent != null && parent >= 1
      ? readPlanLoopPlanMd(project.rootPath, meta.id, parent)
      : undefined;
  const request =
    readPlanLoopRequest(project.rootPath, meta.id, version) ?? meta.brief;
  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "plan_loop",
      projectId: project.id,
      sessionId: meta.id,
      res,
      stream,
    });
    const planChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "plan",
      loopId: meta.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    planChat.appendUser(`Retry v${version}: ${request}`);
    let plan: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ plan, notes, usedScaffold, reply } = await orchestrator.planLoopGenerate({
        project,
        loopId: meta.id,
        brief: meta.brief,
        message: version > 1 ? request : undefined,
        previousPlan: previousPlan ?? undefined,
        version,
        listProjects: () => store.listProjects(),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: planChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Plan retry interrupted.";
        const recovery = `${partial}\n\n---\nPlan retry interrupted (${reason}). Call plan_loop_retry again.`;
        planChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: meta.id,
            notes: recovery,
            reply: recovery,
            messages: planChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: meta.id,
          notes: recovery,
          reply: recovery,
          messages: planChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");
    writePlanLoopVersion({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      plan,
      notes,
      request,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion: parent,
    });
    seedPlanLoopAcceptance({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
    });
    const next =
      setPlanLoopLastError(
        project.rootPath,
        meta.id,
        usedScaffold
          ? { version, reason: notes, at: new Date().toISOString() }
          : null,
      ) ?? meta;
    const operatorReply = reply || notes || `Plan loop v${version} updated.`;
    const messages = planChat.finalizeAssistant(operatorReply, { version });
    const retryPayload = {
      loop: next,
      loopId: next.id,
      version,
      plan,
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      hint: usedScaffold ? "plan_loop_retry" : undefined,
      transcript: readPlanLoopTranscript(project.rootPath, meta.id),
    };
    if (stream) {
      bound.completeDone(retryPayload);
      return;
    }
    res.json(retryPayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.get("/projects/:id/plan-loops/:loopId/versions", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Plan loop not found" });
    return;
  }
  res.json({
    loopId: meta.id,
    ...buildPlanLoopVersionTree(project.rootPath, meta.id),
  });
});

app.post(
  "/projects/:id/plan-loops/:loopId/versions/:version/discard",
  (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readPlanLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Plan loop not found" });
      return;
    }
    const version = Number(req.params.version);
    if (!Number.isFinite(version) || version < 1) {
      res.status(400).json({ error: "Invalid version" });
      return;
    }
    try {
      const next = invalidatePlanLoopVersion({
        projectRoot: project.rootPath,
        loopId: meta.id,
        version,
        reason:
          typeof req.body?.reason === "string"
            ? req.body.reason
            : "discarded",
      });
      res.json({
        loop: next,
        loopId: next.id,
        versions: buildPlanLoopVersionTree(project.rootPath, meta.id),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.status(400).json({ error: errMsg });
    }
  },
);

app.get("/projects/:id/design-loops", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const loops = listDesignLoops(project.rootPath);
  res.json({ projectId: project.id, loops });
});

app.get("/projects/:id/design-loops/:loopId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  // Open loops (incl. reopened after implement) should show latest work by default.
  // Accepted/implemented loops default to the frozen acceptedVersion.
  const version =
    typeof req.query.version === "string" && req.query.version.trim()
      ? Number(req.query.version)
      : meta.status === "open"
        ? meta.currentVersion
        : meta.acceptedVersion ?? meta.currentVersion;
  const includeHtml = req.query.includeHtml !== "false";
  const html =
    includeHtml && Number.isFinite(version) && version > 0
      ? readDesignLoopMockHtml(project.rootPath, meta.id, version)
      : null;
  const notes =
    Number.isFinite(version) && version > 0
      ? readDesignLoopNotes(project.rootPath, meta.id, version)
      : null;
  const versionMeta =
    Number.isFinite(version) && version > 0
      ? readDesignLoopVersionMeta(project.rootPath, meta.id, version)
      : null;
  const transcript = readDesignLoopTranscript(project.rootPath, meta.id);
  const messages = readLoopChatMessages(project.rootPath, "design", meta.id);
  let acceptance = readDesignLoopAcceptance(project.rootPath, meta.id);
  // Seed checklist for loops created before ACCEPTANCE.json existed
  if (!acceptance && html?.trim() && Number.isFinite(version) && version > 0) {
    acceptance = seedDesignLoopAcceptanceFromHtml({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version: version as number,
      html,
    });
  }
  const assets = listDesignLoopAssets(project.rootPath, project.id, meta.id);
  const designPack = readDesignLoopPack(project.rootPath, meta.id);
  let concepts = buildDesignLoopConceptCatalog({
    projectRoot: project.rootPath,
    loopId: meta.id,
    version: Number.isFinite(version) ? (version as number) : undefined,
    html,
  });
  try {
    concepts = refreshDesignLoopConcepts({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version: Number.isFinite(version) ? (version as number) : undefined,
    });
  } catch {
    /* best-effort */
  }
  const selections = getDesignLoopSelections(meta);
  const versionsSummary = buildDesignLoopVersionTree(project.rootPath, meta.id);
  const htmlForApi =
    html != null
      ? rewriteDesignLoopAssetUrls(html, {
          projectId: project.id,
          loopId: meta.id,
        })
      : null;
  let siteInventory = readLiveSiteInventory(project.rootPath, meta.id);
  if (!siteInventory) {
    try {
      siteInventory = writeLiveSiteInventory(project.rootPath, meta.id);
    } catch {
      siteInventory = buildLiveSiteInventory(project.rootPath);
    }
  }
  const acceptanceInScope =
    acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [];
  res.json({
    loop: meta,
    loopId: meta.id,
    version: Number.isFinite(version) ? version : null,
    html: htmlForApi,
    notes,
    transcript,
    messages,
    versionMeta,
    usedScaffold: versionMeta?.usedScaffold ?? false,
    acceptance,
    assets,
    designPack,
    conceptualModel: conceptualModelFromLoop({
      meta,
      pack: designPack,
      html,
      acceptanceInScope,
    }),
    concepts,
    selections,
    versions: versionsSummary,
    tip: versionsSummary.tip,
    siteInventory: summarizeLiveSiteInventory(siteInventory),
  });
});

app.get("/projects/:id/design-loops/:loopId/site-inventory", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const refresh =
    req.query.refresh === "true" ||
    req.query.refresh === "1" ||
    req.query.refresh === "yes";
  let refreshed = false;
  let inventory = refresh
    ? null
    : readLiveSiteInventory(project.rootPath, meta.id);
  if (!inventory) {
    refreshed = true;
    try {
      inventory = writeLiveSiteInventory(project.rootPath, meta.id);
    } catch {
      inventory = buildLiveSiteInventory(project.rootPath);
    }
  }
  res.json({
    projectId: project.id,
    loopId: meta.id,
    refreshed,
    inventory,
    summary: summarizeLiveSiteInventory(inventory),
  });
});

app.get("/projects/:id/design-loops/:loopId/concepts", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const concepts = buildDesignLoopConceptCatalog({
    projectRoot: project.rootPath,
    loopId: meta.id,
  });
  res.json({
    loopId: meta.id,
    concepts,
    selections: getDesignLoopSelections(meta),
  });
});

app.post("/projects/:id/design-loops/:loopId/selections", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  try {
    const slot = String(req.body?.slot ?? "logo").trim() || "logo";
    const next = pinDesignLoopSelection({
      projectRoot: project.rootPath,
      loopId: meta.id,
      slot,
      conceptId:
        typeof req.body?.conceptId === "string"
          ? req.body.conceptId
          : undefined,
      asset: typeof req.body?.asset === "string" ? req.body.asset : undefined,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      excerpt:
        typeof req.body?.excerpt === "string" ? req.body.excerpt : undefined,
    });
    res.json({
      loop: next,
      selections: getDesignLoopSelections(next),
      concepts: buildDesignLoopConceptCatalog({
        projectRoot: project.rootPath,
        loopId: meta.id,
      }),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.put("/projects/:id/design-loops/:loopId/selections", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  try {
    if (!Array.isArray(req.body?.selections)) {
      res.status(400).json({ error: "selections array required" });
      return;
    }
    const next = replaceDesignLoopSelections({
      projectRoot: project.rootPath,
      loopId: meta.id,
      selections: req.body.selections,
    });
    res.json({
      loop: next,
      selections: getDesignLoopSelections(next),
      concepts: buildDesignLoopConceptCatalog({
        projectRoot: project.rootPath,
        loopId: meta.id,
      }),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete("/projects/:id/design-loops/:loopId/selections", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  try {
    const slot =
      typeof req.query.slot === "string" && req.query.slot.trim()
        ? req.query.slot.trim()
        : undefined;
    const next = unpinDesignLoopSelection({
      projectRoot: project.rootPath,
      loopId: meta.id,
      slot,
    });
    res.json({
      loop: next,
      selections: getDesignLoopSelections(next),
      concepts: buildDesignLoopConceptCatalog({
        projectRoot: project.rootPath,
        loopId: meta.id,
      }),
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.delete(
  "/projects/:id/design-loops/:loopId/selections/:slot",
  (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Design loop not found" });
      return;
    }
    try {
      const next = unpinDesignLoopSelection({
        projectRoot: project.rootPath,
        loopId: meta.id,
        slot: req.params.slot,
      });
      res.json({
        loop: next,
        selections: getDesignLoopSelections(next),
        concepts: buildDesignLoopConceptCatalog({
          projectRoot: project.rootPath,
          loopId: meta.id,
        }),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.put("/projects/:id/design-loops/:loopId/acceptance", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  if (meta.status === "implemented") {
    res.status(409).json({
      error:
        "Design loop is implemented; call design_loop_continue to reopen before editing acceptance",
      loop: meta,
      loopId: meta.id,
    });
    return;
  }
  const prior = readDesignLoopAcceptance(project.rootPath, meta.id);
  const bodyFeatures = Array.isArray(req.body?.features)
    ? req.body.features
    : undefined;
  const acceptedFeatureIds = Array.isArray(req.body?.acceptedFeatureIds)
    ? req.body.acceptedFeatureIds.map(String)
    : undefined;

  let baseFeatures = prior?.features ?? [];
  if (!baseFeatures.length && meta.currentVersion > 0) {
    const html = readDesignLoopMockHtml(
      project.rootPath,
      meta.id,
      meta.currentVersion,
    );
    if (html) {
      baseFeatures = seedDesignLoopAcceptanceFromHtml({
        projectRoot: project.rootPath,
        loopId: meta.id,
        version: meta.currentVersion,
        html,
      }).features;
    }
  }

  const features = applyAcceptanceFeatureTicks({
    features: baseFeatures,
    nextFeatures: bodyFeatures,
    acceptedFeatureIds,
  });
  const acceptance = {
    version: meta.currentVersion || prior?.version || 1,
    features,
    acceptedAt: meta.status === "accepted" ? prior?.acceptedAt : undefined,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopAcceptance(project.rootPath, meta.id, acceptance);
  res.json({
    loop: meta,
    loopId: meta.id,
    acceptance,
  });
});

app.post("/projects/:id/design-loops", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const brief = String(req.body?.brief ?? req.body?.message ?? "").trim();
  if (!brief) {
    res.status(400).json({ error: "brief is required" });
    return;
  }
  const phaseId =
    typeof req.body?.phaseId === "string" ? req.body.phaseId.trim() : undefined;
  const askId =
    typeof req.body?.askId === "string" ? req.body.askId.trim() : undefined;
  let scopeOverride: ReturnType<typeof DesignScopeSchema.parse> | undefined;
  if (req.body?.scope && typeof req.body.scope === "object") {
    try {
      scopeOverride = DesignScopeSchema.parse({
        ...req.body.scope,
        source: req.body.scope.source ?? "manual",
      });
    } catch {
      res.status(400).json({
        error:
          'Invalid scope — expected { kind: product|shell|screen|component|flow, focus: string, preserve?: string[] }',
      });
      return;
    }
  }

  const meta = createDesignLoopMeta({
    projectId: project.id,
    brief,
    phaseId: phaseId || undefined,
    askId: askId || undefined,
    // Scope refined after LLM continue-intent in designLoopGenerate.
    scope: scopeOverride ?? defaultProductScope("start"),
  });
  writeDesignLoopMeta(project.rootPath, meta);

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const version = 1;
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "design_loop",
      projectId: project.id,
      sessionId: meta.id,
      res,
      stream,
    });
    const designChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "design",
      loopId: meta.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    designChat.appendUser(brief);
    let html: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ html, notes, usedScaffold, reply } = await orchestrator.designLoopGenerate({
        project,
        loopId: meta.id,
        brief,
        version,
        listProjects: () => store.listProjects(),
        findProjectByRootPath: (rootPath) =>
          store.findProjectByRootPath(rootPath),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: designChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Design generate interrupted.";
        const recovery = `${partial}\n\n---\nDesign generate interrupted (${reason}). Call design_loop_continue or design_loop_retry.`;
        designChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: meta.id,
            notes: recovery,
            reply: recovery,
            messages: designChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: meta.id,
          notes: recovery,
          reply: recovery,
          messages: designChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (stream) {
      // fall through to write version then SSE done below — mark after artifacts
    } else {
      liveTurns.complete(bound.turnId, "done");
    }
    writeDesignLoopVersion({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      html,
      notes,
      request: brief,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion: null,
    });
    const acceptance = seedDesignLoopAcceptanceFromHtml({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      html,
    });
    // Re-read after generate so pins/selections written during generate are kept.
    const freshStart = readDesignLoopMeta(project.rootPath, meta.id) ?? meta;
    let next = {
      ...freshStart,
      currentVersion: version,
      updatedAt: new Date().toISOString(),
    };
    writeDesignLoopMeta(project.rootPath, next);
    if (usedScaffold) {
      next =
        setDesignLoopLastError(project.rootPath, meta.id, {
          version,
          reason: notes,
          at: new Date().toISOString(),
        }) ?? next;
    } else {
      next = setDesignLoopLastError(project.rootPath, meta.id, null) ?? next;
    }
    const operatorReply = reply || notes || `Design loop v${version} updated.`;
    const messages = designChat.finalizeAssistant(operatorReply, { version });
    const siteInv =
      readLiveSiteInventory(project.rootPath, next.id) ??
      buildLiveSiteInventory(project.rootPath);
    const startPack = readDesignLoopPack(project.rootPath, next.id);
    const startPayload = {
      loop: next,
      loopId: next.id,
      version,
      html: rewriteDesignLoopAssetUrls(html, {
        projectId: project.id,
        loopId: next.id,
      }),
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      acceptance,
      conceptualModel: conceptualModelFromLoop({
        meta: next,
        pack: startPack,
        html,
        acceptanceInScope:
          acceptance.features.filter((f) => f.accepted).map((f) => f.id),
      }),
      hint: usedScaffold ? "design_loop_retry" : undefined,
      transcript: readDesignLoopTranscript(project.rootPath, meta.id),
      versions: buildDesignLoopVersionTree(project.rootPath, meta.id),
      siteInventory: summarizeLiveSiteInventory(siteInv),
    };
    if (stream) {
      bound.completeDone(startPayload);
      return;
    }
    res.status(201).json(startPayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("design-loop", "start failed", {
      projectId: project.id,
      loopId: meta.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/design-loops/:loopId/continue", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  // Accepted/implemented loops may continue to vN+1 (reopens to open).
  // Prior acceptedVersion + phaseId stay as history until accept + implement again.
  let working =
    meta.status === "open"
      ? meta
      : reopenDesignLoopForIterate(project.rootPath, meta.id);
  const reopenedFrom = meta.status !== "open" ? meta.status : undefined;
  const message = String(req.body?.message ?? "").trim();
  if (!message) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const tip = resolveDesignLoopTip(project.rootPath, working.id);
  const baseRaw = req.body?.baseVersion;
  const baseVersion =
    typeof baseRaw === "number"
      ? baseRaw
      : typeof baseRaw === "string" && baseRaw.trim()
        ? Number(baseRaw)
        : tip;
  if (!Number.isFinite(baseVersion) || baseVersion < 1) {
    res.status(400).json({
      error: "baseVersion required (or set tip via an active currentVersion)",
    });
    return;
  }
  try {
    assertActiveDesignLoopBase({
      projectRoot: project.rootPath,
      loopId: working.id,
      version: baseVersion,
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const previousHtml = readDesignLoopMockHtml(
    project.rootPath,
    working.id,
    baseVersion,
  );

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const version = allocateNextDesignLoopVersion(
      project.rootPath,
      working.id,
    );
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "design_loop",
      projectId: project.id,
      sessionId: working.id,
      res,
      stream,
    });
    const designChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "design",
      loopId: working.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    designChat.appendUser(
      baseVersion !== tip
        ? `${message}\n\n(baseVersion: v${baseVersion})`
        : message,
    );
    let html: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ html, notes, usedScaffold, reply } = await orchestrator.designLoopGenerate({
        project,
        loopId: working.id,
        brief: working.brief,
        message,
        previousHtml: previousHtml ?? undefined,
        version,
        listProjects: () => store.listProjects(),
        findProjectByRootPath: (rootPath) =>
          store.findProjectByRootPath(rootPath),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: designChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Design continue interrupted.";
        const recovery = `${partial}\n\n---\nDesign continue interrupted (${reason}). Call design_loop_continue again or design_loop_retry.`;
        designChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: working.id,
            notes: recovery,
            reply: recovery,
            messages: designChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: working.id,
          notes: recovery,
          reply: recovery,
          messages: designChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");
    writeDesignLoopVersion({
      projectRoot: project.rootPath,
      loopId: working.id,
      version,
      html,
      notes,
      request: message,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion: baseVersion,
    });
    const acceptance = seedDesignLoopAcceptanceFromHtml({
      projectRoot: project.rootPath,
      loopId: working.id,
      version,
      html,
    });
    // Re-read after generate so pins/selections written during generate are kept.
    const freshContinue =
      readDesignLoopMeta(project.rootPath, working.id) ?? working;
    let next = {
      ...freshContinue,
      currentVersion: version,
      updatedAt: new Date().toISOString(),
    };
    writeDesignLoopMeta(project.rootPath, next);
    if (usedScaffold) {
      next =
        setDesignLoopLastError(project.rootPath, working.id, {
          version,
          reason: notes,
          at: new Date().toISOString(),
        }) ?? next;
    } else {
      next = setDesignLoopLastError(project.rootPath, working.id, null) ?? next;
    }
    const operatorReply = reply || notes || `Design loop v${version} updated.`;
    const messages = designChat.finalizeAssistant(operatorReply, {
      version,
    });
    const siteInv =
      readLiveSiteInventory(project.rootPath, next.id) ??
      buildLiveSiteInventory(project.rootPath);
    const continuePack = readDesignLoopPack(project.rootPath, next.id);
    const continuePayload = {
      loop: next,
      loopId: next.id,
      version,
      baseVersion,
      html: rewriteDesignLoopAssetUrls(html, {
        projectId: project.id,
        loopId: next.id,
      }),
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      acceptance,
      conceptualModel: conceptualModelFromLoop({
        meta: next,
        pack: continuePack,
        html,
        acceptanceInScope:
          acceptance.features.filter((f) => f.accepted).map((f) => f.id),
      }),
      siteInventory: summarizeLiveSiteInventory(siteInv),
      reopenedFrom,
      hint: usedScaffold ? "design_loop_retry" : undefined,
      next: "Tick features (PUT .../acceptance), design_loop_accept, then implement_design.",
      transcript: readDesignLoopTranscript(project.rootPath, working.id),
      versions: buildDesignLoopVersionTree(project.rootPath, working.id),
    };
    if (stream) {
      bound.completeDone(continuePayload);
      return;
    }
    res.json(continuePayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("design-loop", "continue failed", {
      projectId: project.id,
      loopId: working.id,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loop: working, loopId: working.id });
  }
});


app.post("/projects/:id/design-loops/:loopId/stop", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const stopped = liveTurns.stop("design_loop", meta.id, "operator_stop");
  if (!stopped) {
    res.status(409).json({
      error: "No active design-loop turn to stop",
      loopId: meta.id,
    });
    return;
  }
  res.json({
    ok: true,
    code: "interrupted",
    loopId: meta.id,
    turnId: stopped.turnId,
  });
});

app.get("/projects/:id/design-loops/:loopId/versions", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const built = buildDesignLoopVersionTree(project.rootPath, meta.id);
  res.json({
    loopId: meta.id,
    loop: meta,
    ...built,
  });
});

app.post(
  "/projects/:id/design-loops/:loopId/versions/:version/discard",
  (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Design loop not found" });
      return;
    }
    const version = Number(req.params.version);
    if (!Number.isFinite(version) || version < 1) {
      res.status(400).json({ error: "Invalid version" });
      return;
    }
    try {
      const result = invalidateDesignLoopVersion({
        projectRoot: project.rootPath,
        loopId: meta.id,
        version,
        reason:
          typeof req.body?.reason === "string" ? req.body.reason : undefined,
      });
      res.json({
        loop: result.loop,
        loopId: meta.id,
        discardedVersion: version,
        tip: result.tip,
        version: result.version,
        versions: result.versions,
        tree: result.tree,
        transcript: readDesignLoopTranscript(project.rootPath, meta.id),
      });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

app.post("/projects/:id/design-loops/:loopId/retry", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  if (meta.status !== "open") {
    res.status(409).json({
      error: `Design loop is ${meta.status}; cannot retry a closed loop`,
      loop: meta,
      loopId: meta.id,
    });
    return;
  }
  const versionRaw = req.body?.version;
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string" && versionRaw.trim()
        ? Number(versionRaw)
        : meta.currentVersion;
  if (!Number.isFinite(version) || version < 1) {
    res.status(400).json({ error: "Invalid version" });
    return;
  }
  if (!designLoopVersionExists(project.rootPath, meta.id, version)) {
    res.status(404).json({
      error: `Design loop version v${version} not found`,
      loopId: meta.id,
    });
    return;
  }

  const override =
    typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const storedRequest = readDesignLoopRequest(
    project.rootPath,
    meta.id,
    version,
  );
  const requestText =
    override ||
    storedRequest?.trim() ||
    (version === 1 ? meta.brief : "");
  if (!requestText.trim()) {
    res.status(400).json({
      error:
        "No REQUEST.md for this version and no message override; cannot retry",
      loopId: meta.id,
      version,
      hint: "Pass message to retry with an explicit prompt",
    });
    return;
  }

  const existingNode = getDesignLoopVersionNode(
    project.rootPath,
    meta.id,
    version,
  );
  const parentVersion =
    existingNode?.parentVersion !== undefined
      ? existingNode.parentVersion
      : version <= 1
        ? null
        : version - 1;
  const previousHtml =
    parentVersion != null && parentVersion > 0
      ? readDesignLoopMockHtml(project.rootPath, meta.id, parentVersion)
      : null;

  try {
    const { orchestrator } = getRuntime(project.rootPath);
    const isFirst = version === 1;
    const stream = wantsLiveStream(req);
    const bound = bindLiveTurn({
      kind: "design_loop",
      projectId: project.id,
      sessionId: meta.id,
      res,
      stream,
    });
    const designChat = createLoopChatTurn({
      projectRoot: project.rootPath,
      kind: "design",
      loopId: meta.id,
      bound,
      workingStubFromBound: (b) => workingStubFromBound(b as typeof bound),
    });
    designChat.appendUser(
      `Retry v${version}${override ? ` (override): ${override}` : ""}`,
    );
    let html: string;
    let notes: string;
    let usedScaffold: boolean;
    let reply: string;
    try {
      ({ html, notes, usedScaffold, reply } = await orchestrator.designLoopGenerate({
        project,
        loopId: meta.id,
        brief: isFirst ? requestText : meta.brief,
        message: isFirst ? undefined : requestText,
        previousHtml: previousHtml ?? undefined,
        version,
        listProjects: () => store.listProjects(),
        findProjectByRootPath: (rootPath) =>
          store.findProjectByRootPath(rootPath),
        dataDir: defaultDataDir(),
        abortSignal: bound.signal,
        onProgress: designChat.onProgress,
      }));
    } catch (genErr) {
      if (isLiveTurnInterruptedError(genErr)) {
        const reason =
          liveTurns.get(bound.turnId)?.interruptReason ?? "operator_stop";
        const partial =
          (genErr as { partialReply?: string }).partialReply ||
          "Design retry interrupted.";
        const recovery = `${partial}\n\n---\nDesign retry interrupted (${reason}). Call design_loop_retry again.`;
        designChat.finalizeAssistant(recovery);
        if (stream) {
          bound.completeInterrupted(recovery, {
            loopId: meta.id,
            notes: recovery,
            reply: recovery,
            messages: designChat.messages(),
          });
          return;
        }
        liveTurns.complete(bound.turnId, "interrupted", {
          partialReply: recovery,
        });
        res.status(499).json({
          error: "interrupted",
          code: "interrupted",
          loopId: meta.id,
          notes: recovery,
          reply: recovery,
          messages: designChat.messages(),
        });
        return;
      }
      throw genErr;
    }
    if (!stream) liveTurns.complete(bound.turnId, "done");

    writeDesignLoopVersion({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      html,
      notes,
      request: requestText,
      usedScaffold,
      error: usedScaffold ? notes : undefined,
      parentVersion,
      clearInvalid: true,
    });
    const acceptance = seedDesignLoopAcceptanceFromHtml({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      html,
    });
    // Re-read after generate so pins/selections written during generate are kept.
    const freshRetry = readDesignLoopMeta(project.rootPath, meta.id) ?? meta;
    let next = {
      ...freshRetry,
      currentVersion: Math.max(freshRetry.currentVersion, version),
      updatedAt: new Date().toISOString(),
    };
    writeDesignLoopMeta(project.rootPath, next);
    if (usedScaffold) {
      next =
        setDesignLoopLastError(project.rootPath, meta.id, {
          version,
          reason: notes,
          at: new Date().toISOString(),
        }) ?? next;
    } else {
      next = setDesignLoopLastError(project.rootPath, meta.id, null) ?? next;
    }
    const operatorReply = reply || notes || `Design loop v${version} updated.`;
    const messages = designChat.finalizeAssistant(operatorReply, { version });
    const retryPayload = {
      loop: next,
      loopId: next.id,
      version,
      html: rewriteDesignLoopAssetUrls(html, {
        projectId: project.id,
        loopId: next.id,
      }),
      notes,
      reply: operatorReply,
      messages,
      usedScaffold,
      acceptance,
      hint: usedScaffold ? "design_loop_retry" : undefined,
      transcript: readDesignLoopTranscript(project.rootPath, meta.id),
      versions: buildDesignLoopVersionTree(project.rootPath, meta.id),
    };
    if (stream) {
      bound.completeDone(retryPayload);
      return;
    }
    res.json(retryPayload);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    log.error("design-loop", "retry failed", {
      projectId: project.id,
      loopId: meta.id,
      version,
      error: errMsg,
    });
    res.status(500).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/design-loops/:loopId/accept", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const versionRaw = req.body?.version;
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string" && versionRaw.trim()
        ? Number(versionRaw)
        : undefined;
  const bodyFeatures = Array.isArray(req.body?.features)
    ? req.body.features
    : undefined;
  const acceptedFeatureIds = Array.isArray(req.body?.acceptedFeatureIds)
    ? req.body.acceptedFeatureIds.map(String)
    : undefined;
  try {
    const requestedVersion =
      Number.isFinite(version) ? (version as number) : undefined;
    const olderThanLatest =
      requestedVersion != null &&
      requestedVersion < meta.currentVersion;
    const accepted = acceptDesignLoop(
      project.rootPath,
      meta.id,
      requestedVersion,
      {
        features: bodyFeatures,
        acceptedFeatureIds,
      },
    );
    const acceptance = readDesignLoopAcceptance(project.rootPath, accepted.id);
    const html = readDesignLoopMockHtml(
      project.rootPath,
      accepted.id,
      accepted.acceptedVersion ?? accepted.currentVersion,
    );
    const ticked =
      acceptance?.features.filter((f) => f.accepted).map((f) => f.id).join(", ") ??
      "";
    appendDesignLoopTranscript(
      project.rootPath,
      accepted.id,
      "user",
      `Accepted v${accepted.acceptedVersion}${ticked ? ` — features: ${ticked}` : ""}${
        olderThanLatest
          ? ` (note: v${meta.currentVersion} is newer and was not accepted)`
          : ""
      }`,
    );
    const acceptPack = readDesignLoopPack(project.rootPath, accepted.id);
    res.json({
      loop: accepted,
      ...(olderThanLatest
        ? {
            warning: `Accepted v${accepted.acceptedVersion} but v${meta.currentVersion} is newer — later chat revisions were discarded.`,
          }
        : {}),
      loopId: accepted.id,
      version: accepted.acceptedVersion,
      html,
      acceptance,
      designPack: acceptPack,
      conceptualModel: conceptualModelFromLoop({
        meta: accepted,
        pack: acceptPack,
        html,
        acceptanceInScope:
          acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [],
      }),
      next: "Call implement_design to bind this mock + acceptance checklist + design pack to a phase, then research plans those features.",
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

app.post("/projects/:id/design-loops/:loopId/import-design", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const fromProjectId = typeof req.body?.fromProjectId === "string" ? req.body.fromProjectId.trim() : "";
  const fromRootPath = typeof req.body?.fromRootPath === "string" ? req.body.fromRootPath.trim() : "";
  const fromName = typeof req.body?.fromName === "string" ? req.body.fromName.trim() : "";
  if (!fromProjectId && !fromRootPath && !fromName) {
    res.status(400).json({
      error: "Provide fromProjectId, fromRootPath, or fromName",
      loop: meta,
      loopId: meta.id,
    });
    return;
  }
  const source = resolveDesignShareSource({
    targetRoot: project.rootPath,
    fromProjectId: fromProjectId || undefined,
    fromRootPath: fromRootPath || undefined,
    fromName: fromName || undefined,
    listProjects: () => store.listProjects(),
    findProjectByRootPath: (rootPath) => store.findProjectByRootPath(rootPath),
  });
  if (!source) {
    res.status(404).json({
      error: "Could not resolve a design source project (check fromName/fromProjectId)",
      loop: meta,
      loopId: meta.id,
    });
    return;
  }
  const share = readShareableDesign(source);
  if (!share) {
    res.status(404).json({
      error: `No shareable design found in ${source.name ?? source.rootPath} (no accepted pack, tokens, or logos)`,
      loop: meta,
      loopId: meta.id,
      source,
    });
    return;
  }
  let imported;
  try {
    imported = importDesignShareIntoLoop({
      targetRoot: project.rootPath,
      loopId: meta.id,
      share,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
      loop: meta,
      loopId: meta.id,
      source,
      hint: "Import from a registered sibling project (by name or rootPath), not this project.",
    });
    return;
  }
  res.json({
    ok: true,
    loopId: meta.id,
    source: imported.source,
    importedAt: imported.importedAt,
    copiedAssets: imported.copiedAssets,
    logoAssetPaths: imported.logoAssetPaths,
    tokensExcerpt: imported.tokensCss.slice(0, 600),
    sharedDesignPromptBlock: formatSharedDesignPromptBlock(imported),
    next: "Continue the design loop — the SHARED DESIGN block now outranks LIVE SITE for palette/logos.",
  });
});

/** Unified cross-project elements + npm packages + registered projects. */
app.get("/projects/:id/cross-deps", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const catalog = buildCrossProjectCatalog({
    targetRoot: project.rootPath,
    dataDir: defaultDataDir(),
    listProjects: () => store.listProjects(),
  });
  const filterId =
    typeof req.query.projectId === "string" ? req.query.projectId : undefined;
  const projects = filterId
    ? catalog.projects.filter((p) => p.id === filterId || p.name === filterId)
    : catalog.projects;
  const elements = filterId
    ? catalog.elements.filter(
        (e) =>
          e.projectName === filterId ||
          e.origin.includes(filterId) ||
          projects.some((p) => p.name === e.projectName),
      )
    : catalog.elements;
  res.json({
    projectId: project.id,
    registryUrl: catalog.registryUrl,
    elements,
    npmPackages: catalog.npmPackages,
    projects,
    neverNpmLink: true,
    hint: "Prefer npm_registry_ensure_rc → pnpm add @jam/… or design_element_import. Never npm link.",
  });
});

app.post("/projects/:id/resolve-dependency", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    text?: string;
    elementId?: string;
    packageName?: string;
    fromName?: string;
  };
  const catalog = buildCrossProjectCatalog({
    targetRoot: project.rootPath,
    dataDir: defaultDataDir(),
    listProjects: () => store.listProjects(),
  });
  let intent = body.text
    ? detectDependencyIntentFromText(body.text)
    : undefined;
  if (body.text?.trim()) {
    try {
      const { registry } = getRuntime(project.rootPath);
      const { endpoint, modelId } =
        registry.resolveEndpointForRole("classification");
      intent = await classifyDependencyIntentViaLlm({
        endpoint,
        modelId,
        message: body.text,
        timeoutMs: 90_000,
      });
    } catch {
      /* regex fallback already set */
    }
  }
  const resolved = resolveDependencyRecommendation({
    text: body.text,
    elementId: body.elementId,
    packageName: body.packageName,
    fromName: body.fromName,
    catalog,
    intent,
  });
  res.json({
    projectId: project.id,
    intent: resolved.intent,
    recommended: resolved.recommended,
    neverNpmLink: true,
    nextActions: [
      "npm_registry_ensure_rc",
      "list_extractable_design_elements / design_element_import / list_design_elements",
      "pnpm add @jam/… (after ensure_rc)",
    ],
  });
});

/** List design elements (project library + optional registry). */
app.get("/projects/:id/design-elements", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const includeRegistry = req.query.includeRegistry !== "false";
  res.json({
    projectId: project.id,
    projectElements: listProjectElements(project.rootPath),
    registryElements: includeRegistry
      ? listRegistryElements(defaultDataDir())
      : [],
    projectLibrary: projectElementsRoot(project.rootPath),
    registryLibrary: registryElementsRoot(defaultDataDir()),
  });
});

app.get("/projects/:id/design-elements/:elementId", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const version = req.query.version
    ? Number(req.query.version)
    : undefined;
  const origin =
    typeof req.query.origin === "string" ? req.query.origin : undefined;
  const bundle = resolveDesignElement({
    elementId: req.params.elementId,
    version: Number.isFinite(version) ? version : undefined,
    origin,
    targetRoot: project.rootPath,
    dataDir: defaultDataDir(),
    listProjects: () => store.listProjects(),
  });
  if (!bundle) {
    res.status(404).json({ error: "Design element not found" });
    return;
  }
  res.json({
    meta: bundle.meta,
    spec: bundle.spec,
    mockHtml: bundle.mockHtml,
    tokensCss: bundle.tokensCss,
    srcFiles: Object.keys(bundle.srcFiles),
    hasCode: bundle.meta.hasCode,
    rootPath: bundle.rootPath,
  });
});

app.post("/projects/:id/design-elements/publish", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const elementId =
    typeof req.body?.elementId === "string" ? req.body.elementId.trim() : "";
  const mockHtml =
    typeof req.body?.mockHtml === "string" ? req.body.mockHtml : "";
  const spec = typeof req.body?.spec === "string" ? req.body.spec : "";
  if (!elementId || !mockHtml.trim() || !spec.trim()) {
    res.status(400).json({
      error: "elementId, mockHtml, and spec are required (or use extract)",
    });
    return;
  }
  const srcFiles =
    req.body?.srcFiles && typeof req.body.srcFiles === "object"
      ? (req.body.srcFiles as Record<string, string>)
      : undefined;
  try {
    const meta = publishDesignElement({
      projectRoot: project.rootPath,
      elementId,
      kind: req.body?.kind,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      spec,
      mockHtml,
      tokensCss:
        typeof req.body?.tokensCss === "string" ? req.body.tokensCss : undefined,
      srcFiles,
      states: Array.isArray(req.body?.states) ? req.body.states : undefined,
      a11y: Array.isArray(req.body?.a11y) ? req.body.a11y : undefined,
      mountHints: Array.isArray(req.body?.mountHints)
        ? req.body.mountHints
        : undefined,
      themeRequirements: Array.isArray(req.body?.themeRequirements)
        ? req.body.themeRequirements
        : undefined,
      publishToRegistry: Boolean(req.body?.publishToRegistry),
      dataDir: defaultDataDir(),
      sourceProjectId: project.id,
    });
    res.json({
      ok: true,
      meta,
      next: meta.hasCode
        ? "Consumers can import this element; implement prefers src/ TS/JS."
        : "Consumers import + implement from SPEC + mock.",
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.get(
  "/projects/:id/design-loops/:loopId/elements/extractable",
  (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const loopMeta = readDesignLoopMeta(project.rootPath, req.params.loopId);
    if (!loopMeta || loopMeta.projectId !== project.id) {
      res.status(404).json({ error: "Design loop not found" });
      return;
    }
    try {
      const versionRaw = req.query.version;
      const version =
        typeof versionRaw === "string" && versionRaw.trim()
          ? Number(versionRaw)
          : undefined;
      const candidates = listExtractableDesignElementsFromLoop({
        projectRoot: project.rootPath,
        loopId: loopMeta.id,
        version:
          typeof version === "number" && Number.isFinite(version)
            ? version
            : undefined,
      });
      res.json({
        ok: true,
        loopId: loopMeta.id,
        version: version ?? loopMeta.currentVersion,
        candidates,
        next: candidates.length
          ? "Pick a candidate id, then POST …/elements/extract with { elementId, label? }."
          : "No extractable regions found. Add data-element markers or known chrome classes (menubar, theme-toggle, …).",
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
);

app.post("/projects/:id/design-loops/:loopId/elements/extract", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const loopMeta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!loopMeta || loopMeta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const publish = req.body?.publish !== false;
  try {
    if (publish) {
      const meta = extractAndPublishDesignElementFromLoop({
        projectRoot: project.rootPath,
        loopId: loopMeta.id,
        version:
          typeof req.body?.version === "number"
            ? req.body.version
            : undefined,
        elementId:
          typeof req.body?.elementId === "string"
            ? req.body.elementId
            : undefined,
        kind: req.body?.kind,
        label: typeof req.body?.label === "string" ? req.body.label : undefined,
        publishToRegistry: Boolean(req.body?.publishToRegistry),
        dataDir: defaultDataDir(),
        sourceProjectId: project.id,
      });
      res.json({
        ok: true,
        published: true,
        meta,
        next: "Import into consumer loops with design_element_import or chat 'use theme-toggle from <registered-project>'.",
      });
      return;
    }
    const version =
      typeof req.body?.version === "number"
        ? req.body.version
        : loopMeta.currentVersion;
    const html =
      readDesignLoopMockHtml(project.rootPath, loopMeta.id, version) ?? "";
    const extracted = extractDesignElementFromMock({
      html,
      elementId:
        typeof req.body?.elementId === "string"
          ? req.body.elementId
          : undefined,
      kind: req.body?.kind,
      label: typeof req.body?.label === "string" ? req.body.label : undefined,
      brief: loopMeta.brief,
      projectRoot: project.rootPath,
    });
    res.json({ ok: true, published: false, extracted });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/projects/:id/design-loops/:loopId/elements/import", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const loopMeta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!loopMeta || loopMeta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const elementId =
    typeof req.body?.elementId === "string"
      ? req.body.elementId.trim()
      : "theme-toggle";
  const origin =
    typeof req.body?.origin === "string" ? req.body.origin : undefined;
  const version =
    typeof req.body?.version === "number" ? req.body.version : undefined;
  const bundle = resolveDesignElement({
    elementId,
    version,
    origin,
    targetRoot: project.rootPath,
    dataDir: defaultDataDir(),
    listProjects: () => store.listProjects(),
  });
  if (!bundle) {
    res.status(404).json({
      error: `Could not resolve element ${elementId}`,
      hint: "Publish from a brand project first, or pass origin=registry|project:<registered-name>",
    });
    return;
  }
  const ref = importDesignElementIntoLoop({
    targetRoot: project.rootPath,
    loopId: loopMeta.id,
    bundle,
    origin: origin?.startsWith("registry")
      ? "registry"
      : "project",
    sourceName: bundle.meta.sourceRootPath
      ? basename(bundle.meta.sourceRootPath)
      : undefined,
  });
  res.json({
    ok: true,
    element: ref,
    elements: readDesignLoopElements(project.rootPath, loopMeta.id),
    promptBlock: formatDesignElementsPromptBlock(
      readDesignLoopElements(project.rootPath, loopMeta.id),
      { projectRoot: project.rootPath, loopId: loopMeta.id },
    ),
    next: "Continue the design loop — SHARED ELEMENTS must be embedded once (no inventing a second toggle).",
  });
});

// ===== Private npm registry (Verdaccio) =====

app.get("/npm-registry", async (_req, res) => {
  try {
    const { refreshNpmRegistryStatus, getNpmRegistryStatus } = await import(
      "./npm-registry.js"
    );
    const dataDir = defaultDataDir();
    const meta = isNpmRegistryEnvOff()
      ? ensureNpmRegistryLayout(dataDir)
      : await refreshNpmRegistryStatus(dataDir);
    const st = getNpmRegistryStatus(dataDir);
    // Component-library freshness: dist newer than the registry tarball means
    // a publish is owed (catches "edited src, rebuilt, never republished").
    const libraries = store
      .listProjects()
      .map((p) => {
        try {
          if (!readProjectConfig(p.rootPath).componentLibrary) return null;
          const pkgPath = join(p.rootPath, "package.json");
          if (!existsSync(pkgPath)) return null;
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
            name?: string;
          };
          if (!pkg.name) return null;
          const freshness = npmRegistryPackageFreshness({
            dataDir,
            name: pkg.name,
            distDir: join(p.rootPath, "dist"),
          });
          return { projectId: p.id, projectName: p.name, ...freshness };
        } catch {
          return null;
        }
      })
      .filter((l): l is NonNullable<typeof l> => l !== null);
    res.json({
      enabled: st.enabled && !isNpmRegistryEnvOff(),
      meta,
      up: meta.status === "up",
      packages: st.packages,
      scopes: meta.scopes,
      libraries,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/npm-registry/start", async (_req, res) => {
  try {
    const { startNpmRegistry } = await import("./npm-registry.js");
    const meta = await startNpmRegistry(defaultDataDir());
    res.json({ ok: true, meta, up: meta.status === "up" });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/npm-registry/stop", async (_req, res) => {
  try {
    const { stopNpmRegistry } = await import("./npm-registry.js");
    const meta = await stopNpmRegistry(defaultDataDir());
    res.json({ ok: true, meta });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/npm-registry/ensure-rc", (req, res) => {
  const projectId =
    typeof req.body?.projectId === "string" ? req.body.projectId.trim() : "";
  const project = projectId ? store.getProject(projectId) : null;
  if (!project) {
    res.status(404).json({ error: "Project not found (pass projectId)" });
    return;
  }
  const meta =
    readNpmRegistryMeta(defaultDataDir()) ??
    ensureNpmRegistryLayout(defaultDataDir());
  const result = ensureProjectNpmrc({
    projectRoot: project.rootPath,
    registryUrl: meta.url,
    authToken: meta.authToken,
    scopes: meta.scopes,
  });
  res.json({
    ok: true,
    path: result.path,
    registryUrl: meta.url,
    scopes: meta.scopes,
    hint: "Add .npmrc to .gitignore if it should not be committed. Then: pnpm add @jam/<pkg>",
  });
});

app.get("/npm-registry/packages", (_req, res) => {
  const dataDir = defaultDataDir();
  ensureNpmRegistryLayout(dataDir);
  res.json({
    packages: listNpmRegistryPackages(dataDir),
    meta: readNpmRegistryMeta(dataDir),
  });
});

app.post("/npm-registry/publish", async (req, res) => {
  const packageDir =
    typeof req.body?.packageDir === "string" ? req.body.packageDir.trim() : "";
  if (!packageDir || !existsSync(packageDir)) {
    res.status(400).json({ error: "packageDir must be an existing directory" });
    return;
  }
  try {
    const { publishToNpmRegistry } = await import("./npm-registry.js");
    const result = await publishToNpmRegistry({
      dataDir: defaultDataDir(),
      packageDir,
      tag: typeof req.body?.tag === "string" ? req.body.tag : undefined,
    });
    res.json({
      ok: true,
      stdout: result.stdout.slice(0, 2_000),
      registryUrl: result.meta.url,
      packages: listNpmRegistryPackages(defaultDataDir()),
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/projects/:id/design-elements/:elementId/publish-npm", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const elementId = req.params.elementId;
  const version =
    typeof req.body?.version === "number" ? req.body.version : undefined;
  try {
    const prepared = prepareDesignElementNpmPackage({
      projectRoot: project.rootPath,
      elementId,
      version,
    });
    const { publishToNpmRegistry } = await import("./npm-registry.js");
    const published = await publishToNpmRegistry({
      dataDir: defaultDataDir(),
      packageDir: prepared.packageRoot,
    });
    const meta = recordDesignElementNpmPublish({
      projectRoot: project.rootPath,
      elementId: prepared.meta.id,
      version: prepared.meta.version,
      npmPackage: prepared.packageName,
      npmVersion: prepared.packageVersion,
    });
    res.json({
      ok: true,
      meta,
      packageName: prepared.packageName,
      packageVersion: prepared.packageVersion,
      registryUrl: published.meta.url,
      stdout: published.stdout.slice(0, 1_500),
      next: `On consumers: npm_registry_ensure_rc then pnpm add ${prepared.packageName}@${prepared.packageVersion}`,
    });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
      hint: `Publish the element first (design_element_publish / extract). Package name: ${jamPackageNameForElement(elementId)}`,
    });
  }
});

/**
 * Toolchain-driven library publish: build → bump → publish via the project's
 * own build system, then propagate to registered consumers. The publish →
 * consume pipeline for component-library projects (e.g. jamroast-components).
 */
app.post("/projects/:id/design-library/publish", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const body = (req.body ?? {}) as {
    bump?: "patch" | "minor" | "major";
    propagate?: boolean;
  };
  try {
    const { publishLibraryToRegistry } = await import("./npm-registry.js");
    const report = await publishLibraryToRegistry({
      dataDir: defaultDataDir(),
      packageDir: project.rootPath,
      bump: body.bump,
      propagate: body.propagate,
      projects: store
        .listProjects()
        .map((p) => ({ id: p.id, name: p.name, rootPath: p.rootPath })),
    });
    log.info("project", "design library published", {
      projectId: project.id,
      name: report.name,
      version: report.version,
      consumers: report.propagation?.length ?? 0,
    });
    res.json(report);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

app.post("/projects/:id/design-loops/:loopId/implement", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  if (meta.status === "open") {
    res.status(409).json({
      error: "Accept the design loop before implement_design",
      loop: meta,
      loopId: meta.id,
      hint: "design_loop_accept",
    });
    return;
  }

  const phaseIdOverride =
    typeof req.body?.phaseId === "string" ? req.body.phaseId.trim() : "";
  const startResearch = req.body?.startResearch !== false;
  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? req.body.dependsOn.map(String).filter(Boolean)
    : undefined;

  let phase = phaseIdOverride
    ? store.getPhase(phaseIdOverride)
    : meta.phaseId
      ? store.getPhase(meta.phaseId)
      : undefined;

  if (phaseIdOverride && (!phase || phase.projectId !== project.id)) {
    res.status(404).json({ error: "Phase not found" });
    return;
  }

  // When linked phase is complete (or missing), create a new phase so research
  // can replan from the acceptance checklist. Explicit phaseId forces rebind.
  // Also create a new phase after a prior implement on this loop: rebinding the
  // incomplete prior phase only refreshes design/ artifacts and skips research
  // (JamPress stuck at design_complete with stale RESEARCH/PHASE).
  if (
    !phaseIdOverride &&
    phase &&
    (phase.status === "complete" ||
      meta.lastImplementedVersion != null ||
      (meta.lastImplementedFeatureIds?.length ?? 0) > 0)
  ) {
    phase = undefined;
  }

  const createdPhase = !phase;
  if (!phase) {
    const acceptance = readDesignLoopAcceptance(project.rootPath, meta.id);
    const acceptedIds =
      acceptance?.features.filter((f) => f.accepted).map((f) => f.id) ?? [];
    const { inScope } = resolveDesignImplementInScope({
      acceptedFeatureIds: acceptedIds,
      lastImplementedFeatureIds: meta.lastImplementedFeatureIds,
    });
    const version = meta.acceptedVersion ?? meta.currentVersion;
    const request = readDesignLoopRequest(project.rootPath, meta.id, version);
    const isExtensionImplement = Boolean(
      meta.lastImplementedVersion != null ||
        (meta.lastImplementedFeatureIds?.length ?? 0) > 0,
    );
    const description = phaseDescriptionFromDesignAccept({
      request,
      briefFallback: meta.brief,
      inScopeIds: inScope,
      features: acceptance?.features,
      isExtensionImplement,
    });
    phase = store.createPhase({
      projectId: project.id,
      description,
      rootPath: project.rootPath,
      dependsOn,
    });
  }

  try {
    const bound = bindAcceptedDesignLoopToPhase({
      projectRoot: project.rootPath,
      loopId: meta.id,
      phaseId: phase.id,
    });
    // DESIGN_COMPLETE is in design/STATUS.md from bind. Only stamp phase status
    // when we are not about to run research (which owns draft → review → accepted).
    const willResearch = startResearch && createdPhase;
    if (!willResearch) {
      writePhaseStatus(project.rootPath, phase.id, "design_complete");
      updatePhaseStatus(phase.id, "design_complete");
    }

    let run = null as ReturnType<typeof store.createRun> | null;
    if (willResearch) {
      run = store.createRun({ phaseId: phase.id, projectId: project.id });
      touchRunStage(run.id, "researching");
      activeRuns.add(run.id);
      const ac = new AbortController();
      abortControllers.set(run.id, ac);
      const { orchestrator } = getRuntime(project.rootPath);
      const researchDescription = phase.description;
      void (async () => {
        try {
          const stage = await orchestrator.startResearch({
            project,
            phase: phase!,
            run: run!,
            description: researchDescription,
            listProjects: () => store.listProjects(),
            onStage: (s) => touchRunStage(run!.id, s),
          });
          // Final stage (in_review / failed) is returned, not always pushed via onStage.
          touchRunStage(run!.id, stage);
          updatePhaseStatus(
            phase!.id,
            stage === "in_review" ? "in_review" : "draft",
          );
        } catch (error) {
          const errMsg =
            error instanceof Error ? error.message : String(error);
          log.error("design-loop", "implement research failed", {
            projectId: project.id,
            loopId: meta.id,
            runId: run!.id,
            error: errMsg,
          });
          appendRunLog(
            project.rootPath,
            run!.id,
            `implement_design research failed: ${errMsg}`,
          );
          touchRunStage(run!.id, "failed");
          updatePhaseStatus(phase!.id, "draft");
        } finally {
          activeRuns.delete(run!.id);
          abortControllers.delete(run!.id);
        }
      })();
    }

    const implementPack = readDesignLoopPack(project.rootPath, meta.id);
    let themeContractWarning: string[] | undefined;
    if (packHasThemeModes(implementPack) && implementPack?.theme) {
      const check = checkThemeContractInProject({
        projectRoot: project.rootPath,
        theme: implementPack.theme,
      });
      if (!check.ok) {
        themeContractWarning = check.issues;
        log.warn("design-loop", "theme contract gaps in product CSS (warn)", {
          projectId: project.id,
          loopId: meta.id,
          issues: check.issues,
        });
      }
    }
    res.status(createdPhase ? 201 : 200).json({
      loop: bound.meta,
      loopId: bound.meta.id,
      phase,
      phaseId: phase.id,
      version: bound.version,
      mockPath: bound.mockPath,
      uiSpecPath: bound.uiSpecPath,
      run,
      runId: run?.id ?? null,
      createdPhase,
      acceptance: readDesignLoopAcceptance(project.rootPath, meta.id),
      designPack: implementPack,
      conceptualModel: conceptualModelFromLoop({
        meta: bound.meta,
        pack: implementPack,
        acceptanceInScope: implementPack?.inScope,
      }),
      themeContractWarning,
      next: willResearch
        ? "Research started from acceptance checklist. After review approval, call start_development."
        : "Design contract bound (UI-SPEC + mock + ACCEPTANCE + DESIGN_COMPLETE). Call start_development when the phase is accepted/ready.",
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg, loop: meta, loopId: meta.id });
  }
});

/**
 * Relaunch research from an accepted/implemented design loop (recovery when
 * implement only rebound design/ without spawning research). Always creates a
 * new phase, rebinds the current accepted mock + pack, and starts research.
 * Body: { dependsOn?, loopId? } — loopId in path; optional phaseId on
 * POST /projects/:id/relaunch-design-research to resolve the loop.
 */
app.post(
  "/projects/:id/design-loops/:loopId/relaunch-research",
  async (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const dependsOn = Array.isArray(req.body?.dependsOn)
      ? req.body.dependsOn.map(String).filter(Boolean)
      : undefined;
    const resolved = resolveDesignLoopForRelaunchResearch(project, {
      loopId: req.params.loopId,
    });
    if (!resolved.ok) {
      res.status(resolved.status).json({
        error: resolved.error,
        hint: resolved.hint,
      });
      return;
    }
    try {
      const { phase, bound, run } = startFreshDesignResearchFromLoop({
        project,
        meta: resolved.meta,
        dependsOn,
      });
      const implementPack = readDesignLoopPack(project.rootPath, bound.meta.id);
      let themeContractWarning: string[] | undefined;
      if (packHasThemeModes(implementPack) && implementPack?.theme) {
        const check = checkThemeContractInProject({
          projectRoot: project.rootPath,
          theme: implementPack.theme,
        });
        if (!check.ok) themeContractWarning = check.issues;
      }
      res.status(201).json({
        loop: bound.meta,
        loopId: bound.meta.id,
        phase,
        phaseId: phase.id,
        version: bound.version,
        mockPath: bound.mockPath,
        uiSpecPath: bound.uiSpecPath,
        run,
        runId: run.id,
        createdPhase: true,
        researchStarted: true,
        acceptance: readDesignLoopAcceptance(project.rootPath, bound.meta.id),
        designPack: implementPack,
        conceptualModel: conceptualModelFromLoop({
          meta: bound.meta,
          pack: implementPack,
          acceptanceInScope: implementPack?.inScope,
        }),
        themeContractWarning,
        priorPhaseId: resolved.meta.phaseId,
        next: "Research started from the accepted design contract. After review approval, call start_development.",
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        error: errMsg,
        loop: resolved.meta,
        loopId: resolved.meta.id,
        hint: "design_loop_accept",
      });
    }
  },
);

/** Same as loop relaunch-research, but resolve loop from phaseId and/or loopId. */
app.post("/projects/:id/relaunch-design-research", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const loopId =
    typeof req.body?.loopId === "string" ? req.body.loopId.trim() : "";
  const phaseId =
    typeof req.body?.phaseId === "string" ? req.body.phaseId.trim() : "";
  const dependsOn = Array.isArray(req.body?.dependsOn)
    ? req.body.dependsOn.map(String).filter(Boolean)
    : undefined;
  const resolved = resolveDesignLoopForRelaunchResearch(project, {
    loopId,
    phaseId,
  });
  if (!resolved.ok) {
    res.status(resolved.status).json({
      error: resolved.error,
      hint: resolved.hint,
    });
    return;
  }
  try {
    const { phase, bound, run } = startFreshDesignResearchFromLoop({
      project,
      meta: resolved.meta,
      dependsOn,
    });
    const implementPack = readDesignLoopPack(project.rootPath, bound.meta.id);
    let themeContractWarning: string[] | undefined;
    if (packHasThemeModes(implementPack) && implementPack?.theme) {
      const check = checkThemeContractInProject({
        projectRoot: project.rootPath,
        theme: implementPack.theme,
      });
      if (!check.ok) themeContractWarning = check.issues;
    }
    res.status(201).json({
      loop: bound.meta,
      loopId: bound.meta.id,
      phase,
      phaseId: phase.id,
      version: bound.version,
      mockPath: bound.mockPath,
      uiSpecPath: bound.uiSpecPath,
      run,
      runId: run.id,
      createdPhase: true,
      researchStarted: true,
      acceptance: readDesignLoopAcceptance(project.rootPath, bound.meta.id),
      designPack: implementPack,
      conceptualModel: conceptualModelFromLoop({
        meta: bound.meta,
        pack: implementPack,
        acceptanceInScope: implementPack?.inScope,
      }),
      themeContractWarning,
      priorPhaseId: resolved.meta.phaseId ?? (phaseId || undefined),
      next: "Research started from the accepted design contract. After review approval, call start_development.",
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      error: errMsg,
      loop: resolved.meta,
      loopId: resolved.meta.id,
      hint: "design_loop_accept",
    });
  }
});

app.post("/projects/:id/design-loops/:loopId/review", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  const versionRaw = req.body?.version;
  const version =
    typeof versionRaw === "number"
      ? versionRaw
      : typeof versionRaw === "string" && versionRaw.trim()
        ? Number(versionRaw)
        : meta.currentVersion;
  if (!Number.isFinite(version) || version < 1) {
    res.status(400).json({ error: "No mock version to review" });
    return;
  }
  try {
    const { registry } = getRuntime(project.rootPath);
    const vision = registry.tryResolveDesignVision();
    if (!vision) {
      res.status(400).json({
        error:
          "designVision unbound — bind roles.designVision to a vision-capable model (kimi-k2.7-code or kimi-k3)",
      });
      return;
    }
    const result = await reviewDesignLoopLook({
      projectRoot: project.rootPath,
      loopId: meta.id,
      version,
      brief: meta.brief,
      visionEndpoint: vision.endpoint,
      visionModelId: vision.modelId,
      reusePreview: req.body?.reusePreview !== false,
    });
    appendDesignLoopTranscript(
      project.rootPath,
      meta.id,
      "assistant",
      `## Vision review (v${version})\n\n${result.critique}`,
    );
    res.json({
      loopId: meta.id,
      version,
      critique: result.critique,
      previewPath: result.previewPath,
      reviewPath: result.reviewPath,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg, loopId: meta.id });
  }
});

app.post("/projects/:id/design-images", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const prompt = String(req.body?.prompt ?? "").trim();
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  const loopId =
    typeof req.body?.loopId === "string" ? req.body.loopId.trim() : undefined;
  if (loopId) {
    const meta = readDesignLoopMeta(project.rootPath, loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Design loop not found" });
      return;
    }
  }
  try {
    const { registry } = getRuntime(project.rootPath);
    const binding = registry.tryResolveDesignImage();
    if (!binding) {
      res.status(400).json({
        error:
          "designImage unbound — bind roles.designImage to openai-images (e.g. x/flux2-klein)",
      });
      return;
    }
    const result = await generateDesignImage({
      projectRoot: project.rootPath,
      prompt,
      endpoint: binding.endpoint,
      modelId: binding.modelId,
      loopId,
      filename:
        typeof req.body?.filename === "string"
          ? req.body.filename.trim()
          : undefined,
      width:
        typeof req.body?.width === "number" ? req.body.width : undefined,
      height:
        typeof req.body?.height === "number" ? req.body.height : undefined,
    });
    if (loopId) {
      appendDesignLoopTranscript(
        project.rootPath,
        loopId,
        "assistant",
        `Generated image: ${result.relativePath}`,
      );
    }
    res.status(201).json({
      path: result.path,
      relativePath: result.relativePath,
      bytes: result.bytes,
      format: result.format,
      loopId: loopId ?? null,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg });
  }
});

app.get("/projects/:id/design-images/search", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const q = String(req.query.q ?? req.query.query ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "q is required" });
    return;
  }
  try {
    const hits = await searchDesignImages({
      query: q,
      source:
        typeof req.query.source === "string" ? req.query.source : undefined,
      page:
        typeof req.query.page === "string"
          ? Number(req.query.page)
          : undefined,
      pageSize:
        typeof req.query.pageSize === "string"
          ? Number(req.query.pageSize)
          : undefined,
    });
    res.json({ projectId: project.id, query: q, hits });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg });
  }
});

app.post("/projects/:id/design-images/search", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const q = String(req.body?.query ?? req.body?.q ?? "").trim();
  if (!q) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  try {
    const hits = await searchDesignImages({
      query: q,
      source:
        typeof req.body?.source === "string" ? req.body.source : undefined,
      page: typeof req.body?.page === "number" ? req.body.page : undefined,
      pageSize:
        typeof req.body?.pageSize === "number" ? req.body.pageSize : undefined,
      licenseType:
        typeof req.body?.licenseType === "string"
          ? req.body.licenseType
          : undefined,
    });
    res.json({ projectId: project.id, query: q, hits });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg });
  }
});

app.post("/projects/:id/design-images/import", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const loopId = String(req.body?.loopId ?? "").trim();
  const openverseId = String(req.body?.openverseId ?? "").trim();
  if (!loopId || !openverseId) {
    res.status(400).json({ error: "loopId and openverseId are required" });
    return;
  }
  const meta = readDesignLoopMeta(project.rootPath, loopId);
  if (!meta || meta.projectId !== project.id) {
    res.status(404).json({ error: "Design loop not found" });
    return;
  }
  try {
    const result = await importDesignImageById({
      projectRoot: project.rootPath,
      loopId,
      openverseId,
      filename:
        typeof req.body?.filename === "string"
          ? req.body.filename.trim()
          : undefined,
    });
    appendDesignLoopTranscript(
      project.rootPath,
      loopId,
      "assistant",
      `Imported Openverse ${openverseId} → ${result.relativePath}\nAttribution: ${result.hit.attribution}`,
    );
    res.status(201).json({
      loopId,
      relativePath: result.relativePath,
      absolutePath: result.absolutePath,
      attributionPath: result.attributionPath,
      hit: result.hit,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    res.status(400).json({ error: errMsg });
  }
});

app.get("/projects/:id/design-images/:name", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const path = resolveServableDesignAsset(
    project.rootPath,
    String(req.params.name ?? ""),
  );
  if (!path) {
    res.status(404).json({ error: "Asset not found" });
    return;
  }
  res.sendFile(path);
});

app.get(
  "/projects/:id/design-loops/:loopId/assets/:name",
  (req, res) => {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const meta = readDesignLoopMeta(project.rootPath, req.params.loopId);
    if (!meta || meta.projectId !== project.id) {
      res.status(404).json({ error: "Design loop not found" });
      return;
    }
    const path = resolveDesignLoopAssetFile(
      project.rootPath,
      meta.id,
      String(req.params.name ?? ""),
    );
    if (!path) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.sendFile(path);
  },
);

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
  let run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  // Tombstone: redirect to the archive run it was merged into.
  let mergedFrom: string | undefined;
  if (run.archived && run.archivedInto) {
    mergedFrom = run.id;
    run = store.getRun(run.archivedInto) ?? run;
  }
  const payload = buildRunPayload(run);
  if (!payload) {
    res.status(404).json({ error: "Project not found for run" });
    return;
  }
  res.json({
    ...payload,
    merged_from: mergedFrom,
    active: activeRuns.has(run.id),
  });
});

app.post("/runs/:id/wait", async (req, res) => {
  const runId = routeParam(req, "id");
  if (!store.getRun(runId)) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const requested =
    typeof req.body?.timeoutMs === "number" ? req.body.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(1_000, requested), HTTP_WAIT_MAX_MS);
  try {
    const result = await waitForRun({
      runId,
      getRun: () => store.getRun(runId),
      timeoutMs,
      intervalMs: DEFAULT_WAIT_INTERVAL_MS,
    });
    res.json({
      ...result,
      message: formatWaitForRunResult(result),
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/runs/:id/steps", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  const project = store.getProject(run.projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found for run" });
    return;
  }
  const report = readVerifyStepsReport(project.rootPath, run.id);
  if (!report) {
    res.status(404).json({ error: "No verify steps for this run" });
    return;
  }
  res.json({
    runId: run.id,
    stage: run.stage,
    ok: report.ok,
    steps: report.steps,
    firstFailure: report.firstFailure ?? null,
    summary: report.summary,
    updatedAt: report.updatedAt,
  });
});

app.post("/runs/:id/retry-verify", async (req, res) => {
  const result = await executeRetryVerify(req.params.id);
  res.status(result.status).json(result.body);
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

// ---- provider config (providers.json) ----

function providersPath(): string {
  return defaultProvidersPath(defaultDataDir());
}

function redactProviders(config: ReturnType<typeof loadProvidersConfig>) {
  const redacted: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(config.providers)) {
    redacted[name] = {
      ...entry,
      apiKey: entry.apiKey ? "***" : null,
    };
  }
  return { providers: redacted };
}

app.get("/config/providers", (_req, res) => {
  const config = loadProvidersConfig(providersPath());
  res.json(redactProviders(config));
});

app.put("/config/providers/:name", (req, res) => {
  const { name } = req.params;
  const body = req.body ?? {};
  const config = loadProvidersConfig(providersPath());
  config.providers[name] = mergeProviderUpdate(config.providers[name], body);
  const path = providersPath();
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  clearSlopcontrolRuntimeCache();
  res.json({ ok: true, provider: name });
});

app.delete("/config/providers/:name", (req, res) => {
  const { name } = req.params;
  const config = loadProvidersConfig(providersPath());
  if (!(name in config.providers)) {
    res.status(404).json({ error: `Provider not found: ${name}` });
    return;
  }
  delete config.providers[name];
  const path = providersPath();
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  clearSlopcontrolRuntimeCache();
  res.json({ ok: true, removed: name });
});

// Test connectivity for a provider by listing its models
app.get("/config/providers/:name/test", async (req, res) => {
  const { name } = req.params;
  const config = loadProvidersConfig(providersPath());
  const provider = config.providers[name];
  if (!provider) {
    res.status(404).json({ error: `Provider not found: ${name}` });
    return;
  }
  const synthetic = resolveEndpointSecrets(
    {
      id: name,
      label: name,
      baseUrl: provider.defaultBaseUrl ?? "",
      provider: name,
      apiType: "openai-chat",
      modelId: "test",
    },
    config,
  );
  const baseUrl = synthetic.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    res.status(400).json({ error: `Provider ${name} has no defaultBaseUrl configured` });
    return;
  }
  const apiKey = synthetic.apiKey?.trim() ?? "";
  try {
    const url = `${baseUrl.replace(/\/$/, "")}/models`;
    const res2 = await fetch(url, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...synthetic.headers,
        ...provider.headers,
      },
      signal: AbortSignal.timeout(synthetic.timeoutMs ?? provider.timeoutMs ?? 10_000),
    });
    if (!res2.ok) {
      res.json({ ok: false, error: `HTTP ${res2.status} from ${url}`, provider: name });
      return;
    }
    const data = (await res2.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter(Boolean);
    res.json({ ok: true, provider: name, models, count: models.length });
  } catch (err) {
    res.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      provider: name,
    });
  }
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
      {
        const { registry } = getRuntime(project.rootPath);
        await ensureChangeIntentAsync(
          project.rootPath,
          phase.id,
          action.description,
          { registry },
        );
      }

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
        const stage = await orchestrator.startResearch({
          project,
          phase: store.getPhase(phase.id) ?? phase,
          run: store.getRun(run.id) ?? run,
          description: action.description,
          listProjects: () => store.listProjects(),
      onStage: (s) => touchRunStage(run.id, s),
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, stage === "in_review" ? "in_review" : "draft");
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
            listProjects: () => store.listProjects(),
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
            listProjects: () => store.listProjects(),
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

    if (action.action === "retry_verify") {
      const result = await executeRetryVerify(action.runId);
      res.status(result.status).json(result.body);
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
        const stage = await orchestrator.startResearch({
          project,
          phase,
          run,
          description: phase.description,
          listProjects: () => store.listProjects(),
      onStage: (s) => touchRunStage(run.id, s),
        });
        touchRunStage(run.id, stage);
        updatePhaseStatus(phase.id, stage === "in_review" ? "in_review" : "draft");
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

    if (action.action === "preview_change_intent") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const { registry } = getRuntime(project.rootPath);
      const { intent, source } = await previewChangeIntentAsync(
        action.description,
        {
          projectRoot: project.rootPath,
          phaseId: action.phaseId,
          registry,
          heuristicOnly: action.heuristicOnly === true,
        },
      );
      let phaseAlign: { ok: boolean; issues: string[] } | null = null;
      if (action.checkPhaseDoc && action.phaseId) {
        const phaseDoc = readPhaseDoc(project.rootPath, action.phaseId);
        if (phaseDoc.trim()) {
          phaseAlign = phaseDocAlignsWithChangeIntent(phaseDoc, intent);
        } else {
          phaseAlign = { ok: false, issues: ["PHASE.md missing or empty"] };
        }
      }
      res.json({
        projectId: project.id,
        engagementSymptom: isEngagementSymptom(action.description),
        intent,
        source,
        promptBlock: formatChangeIntentPromptBlock(intent),
        phaseAlign,
      });
      return;
    }

    if (action.action === "reconcile_blueprint") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const dryRun = action.dryRun !== false;
      const result = reconcileProjectBlueprint(
        project.rootPath,
        action.phaseId,
        { dryRun },
      );
      res.json({
        projectId: project.id,
        phaseId: action.phaseId ?? null,
        ...result,
        liveDecisionsPreview: result.liveDecisions.slice(0, 4_000),
      });
      return;
    }

    if (action.action === "audit_ui_gates") {
      const project = store.getProject(action.projectId);
      if (!project) {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      const description =
        action.description?.trim() ||
        (action.phaseId
          ? store.getPhase(action.phaseId)?.description ?? ""
          : "");
      const stored = action.phaseId
        ? readChangeIntent(project.rootPath, action.phaseId)
        : null;
      let preview = stored;
      let source: "llm" | "heuristic" | "stored" = stored ? "stored" : "heuristic";
      if (description) {
        const { registry } = getRuntime(project.rootPath);
        const previewed = await previewChangeIntentAsync(description, {
          projectRoot: project.rootPath,
          phaseId: action.phaseId,
          registry,
          heuristicOnly: action.heuristicOnly === true,
        });
        preview = previewed.intent;
        source = previewed.source;
      }
      if (!preview) {
        res.status(400).json({
          error:
            "Provide description and/or phaseId with existing INTENT.json",
        });
        return;
      }
      let phaseAlign: { ok: boolean; issues: string[] } | null = null;
      if (action.phaseId) {
        const phaseDoc = readPhaseDoc(project.rootPath, action.phaseId);
        phaseAlign = phaseDoc.trim()
          ? phaseDocAlignsWithChangeIntent(phaseDoc, preview)
          : { ok: false, issues: ["PHASE.md missing or empty"] };
      }
      const dry = reconcileProjectBlueprint(project.rootPath, action.phaseId, {
        dryRun: true,
      });
      const checks = {
        engagementDetected: description
          ? isEngagementSymptom(description)
          : false,
        uiMountLocked: preview.uiMount !== "n/a",
        hasInteractionContract: Boolean(preview.interaction),
        changeKind: preview.changeKind ?? null,
        phaseAlignOk: phaseAlign ? phaseAlign.ok : null,
        liveHasComposer: /BD-COMPOSER-FORM/i.test(dry.liveDecisions),
        liveHasInBubbleUnstruck: /^\s*-\s+BD-IN-BUBBLE-FORMS\b/m.test(
          dry.liveDecisions,
        ),
      };
      res.json({
        projectId: project.id,
        phaseId: action.phaseId ?? null,
        storedIntent: stored,
        previewIntent: preview,
        source,
        promptBlock: formatChangeIntentPromptBlock(preview),
        phaseAlign,
        reconcileDryRun: {
          report: dry.report,
          wouldChange: dry.changed,
          liveDecisionsPreview: dry.liveDecisions.slice(0, 4_000),
        },
        blueprintClipPreview: clipBlueprintForPrompt(
          // read via reconcile dry — clip from live only
          dry.liveDecisions
            ? `## Live decisions\n\n${dry.liveDecisions}\n`
            : "",
          2_000,
        ),
        checks,
        ok:
          checks.uiMountLocked &&
          checks.hasInteractionContract &&
          (phaseAlign ? phaseAlign.ok : true) &&
          !checks.liveHasInBubbleUnstruck,
      });
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

// ---- Chat service (per-project + global operator chat) ----

function chatErrorStatus(err: unknown): number {
  if (err instanceof ConversationNotFoundError) return 404;
  if (err instanceof ConversationClosedError) return 409;
  return 500;
}

function routeParam(req: express.Request, name: string): string {
  const value = req.params[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function sseHeaders(res: express.Response): void {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
}

const SSE_HEARTBEAT_MS = 20_000;

/** Keep chat SSE connections alive and push filtered chat-service events. */
function attachChatEventStream(
  req: express.Request,
  res: express.Response,
  filter: (event: { conversationId?: string; projectId?: string | null }) => boolean,
): void {
  sseHeaders(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: ping\n\n`);
    }
  }, SSE_HEARTBEAT_MS);

  const unsubscribe = getChatService().subscribe((event) => {
    if (!filter(event)) return;
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

app.post("/projects/:id/chats", (req, res) => {
  try {
    const project = store.getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    const { title, modelOverride } = req.body ?? {};
    const conversation = getChatService().createConversation({
      projectId: project.id,
      title: typeof title === "string" ? title : undefined,
      modelOverride,
    });
    res.status(201).json({ conversation });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/projects/:id/chats", async (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  const status = req.query.status === "closed" ? "closed" : req.query.status === "active" ? "active" : undefined;
  res.json({
    conversations: await getChatService().listConversationsDetailed({
      projectId: project.id,
      status,
    }),
  });
});

app.get("/projects/:id/chats/events", (req, res) => {
  const project = store.getProject(req.params.id);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  attachChatEventStream(req, res, (event) => event.projectId === project.id);
});

app.post("/chats", (req, res) => {
  try {
    const { title, modelOverride } = req.body ?? {};
    const conversation = getChatService().createConversation({
      projectId: null,
      title: typeof title === "string" ? title : undefined,
      modelOverride,
    });
    res.status(201).json({ conversation });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/chats", async (req, res) => {
  const status = req.query.status === "closed" ? "closed" : req.query.status === "active" ? "active" : undefined;
  const all = req.query.all === "1" || req.query.all === "true";
  res.json({
    conversations: all
      ? await getChatService().listConversationsDetailed({ status })
      : await getChatService().listConversationsDetailed({ projectId: null, status }),
  });
});

app.get("/chats/events", (req, res) => {
  attachChatEventStream(req, res, () => true);
});

// Live run-stage events for the dashboard: replay retained log then follow
// live. Replaces polling /runs/:id/status and /chats/:id/awaited-runs.
app.get("/events/runs", (req, res) => {
  const projectId =
    typeof req.query.projectId === "string" && req.query.projectId.trim()
      ? req.query.projectId.trim()
      : null;
  const afterSeq = Math.max(
    0,
    Number.parseInt(
      typeof req.query.afterSeq === "string" ? req.query.afterSeq : "0",
      10,
    ) || 0,
  );

  sseHeaders(res);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(`: ping\n\n`);
    }
  }, SSE_HEARTBEAT_MS);

  const writeEvent = (event: {
    seq?: number;
    ts?: string;
    id: string;
    stage: string;
    phaseId?: string;
    projectId?: string;
    previousStage?: string;
  }) => {
    if (projectId && event.projectId !== projectId) return;
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  // Replay retained events newer than afterSeq, then follow live
  for (const event of runStageBroker.replaySince(afterSeq)) {
    writeEvent(event);
  }
  const unsubscribe = runStageBroker.subscribe("*", (update) => {
    writeEvent({
      seq: runStageBroker.currentSeq(),
      ts: new Date().toISOString(),
      ...update,
    });
  });

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
});

app.get("/chats/:id/events", (req, res) => {
  try {
    getChatService().getConversation(req.params.id);
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const conversationId = req.params.id;
  attachChatEventStream(req, res, (event) => event.conversationId === conversationId);
});

app.get("/chats/models", async (_req, res) => {
  try {
    res.json({ endpoints: await getChatService().listModels() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/chats/function-mappings", async (_req, res) => {
  try {
    res.json(await getChatService().listFunctionMappings());
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/chats/function-mappings", async (req, res) => {
  try {
    const { modelId, provider, endpointId } = req.body ?? {};
    const parsedFn = AgentRoleSchema.safeParse(req.body?.function);
    if (!parsedFn.success) {
      res.status(400).json({
        error:
          `function must be one of: ${AgentRoleSchema.options.join(", ")}`,
      });
      return;
    }
    if (typeof modelId !== "string" || !modelId.trim()) {
      res.status(400).json({ error: "modelId required" });
      return;
    }
    if (endpointId !== undefined && typeof endpointId !== "string") {
      res.status(400).json({ error: "endpointId must be a string" });
      return;
    }
    if (provider !== undefined && typeof provider !== "string") {
      res.status(400).json({ error: "provider must be a string" });
      return;
    }
    const result = await getChatService().bindFunctionMapping({
      function: parsedFn.data,
      modelId: modelId.trim(),
      ...(typeof provider === "string" && provider.trim()
        ? { provider: provider.trim() }
        : {}),
      ...(endpointId?.trim() ? { endpointId: endpointId.trim() } : {}),
    });
    res.json({
      ok: true,
      function: result.function,
      modelId: result.modelId,
      endpointId: result.endpointId,
      provider: result.provider,
      createdEndpoint: result.createdEndpoint,
      roles: result.config.roles,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith("Unknown endpoint")
      ? 404
      : message.includes("Pass endpointId") || message.includes("modelId required")
        ? 400
        : 500;
    res.status(status).json({ error: message });
  }
});

app.get("/chat-models", async (_req, res) => {
  try {
    res.json({ endpoints: await getChatService().listModels() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/projects/:id/chat-models", async (req, res) => {
  if (!store.getProject(req.params.id)) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  try {
    res.json({ endpoints: await getChatService().listModels() });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/chats/:id", async (req, res) => {
  try {
    const service = getChatService();
    const conversation = service.getConversation(req.params.id);
    const messages = await service.getMessages(req.params.id);
    res.json({ conversation, messages });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** Compatibility alias — some clients hit /chat/:id (singular). */
app.get("/chat/:id", async (req, res) => {
  try {
    const service = getChatService();
    const conversation = service.getConversation(req.params.id);
    const messages = await service.getMessages(req.params.id);
    res.json({ conversation, messages });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/chats/:id", (req, res) => {
  const deleted = getChatService().deleteConversation(req.params.id);
  if (!deleted) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }
  res.json({ deleted: true });
});

app.post("/chats/:id/close", (req, res) => {
  try {
    res.json({ conversation: getChatService().closeConversation(req.params.id) });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/chats/:id/reopen", (req, res) => {
  try {
    res.json({ conversation: getChatService().reopenConversation(routeParam(req, "id")) });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function setChatModelHandler(req: express.Request, res: express.Response): void {
  try {
    const { endpointId, modelId } = req.body ?? {};
    if (typeof endpointId !== "string" || typeof modelId !== "string") {
      res.status(400).json({ error: "endpointId and modelId required" });
      return;
    }
    const conversation = getChatService().setConversationModel(routeParam(req, "id"), {
      endpointId,
      modelId,
    });
    res.json({ conversation });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
}

app.post("/chats/:id/model", setChatModelHandler);
app.put("/chats/:id/model", setChatModelHandler);

function updateEndpointModelHandler(req: express.Request, res: express.Response): void {
  try {
    const { modelId } = req.body ?? {};
    if (typeof modelId !== "string" || !modelId.trim()) {
      res.status(400).json({ error: "modelId required" });
      return;
    }
    const endpointId = routeParam(req, "endpointId");
    const config = getChatService().updateEndpointDefaultModel(
      endpointId,
      modelId.trim(),
    );
    res.json({ ok: true, endpoints: config.endpoints });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res
      .status(message.startsWith("Unknown endpoint") ? 404 : 500)
      .json({ error: message });
  }
}

app.post("/chats/endpoints/:endpointId/model", updateEndpointModelHandler);
app.put("/config/endpoints/:endpointId/model", updateEndpointModelHandler);

app.post("/chats/:id/confirm", async (req, res) => {
  try {
    const { token, approve } = req.body ?? {};
    if (typeof token !== "string" || typeof approve !== "boolean") {
      res.status(400).json({ error: "token and approve (boolean) required" });
      return;
    }
    const result = await getChatService().confirm({
      conversationId: req.params.id,
      token,
      approve,
    });
    if (!result.ok && result.error === "Unknown or expired confirmation token") {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function streamChatTurn(req: express.Request, res: express.Response): Promise<void> {
  const { message } = req.body ?? {};
  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message required" });
    return;
  }
  try {
    getChatService().getConversation(routeParam(req, "id"));
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  sseHeaders(res);
  try {
    for await (const event of getChatService().sendMessage(
      routeParam(req, "id"),
      message,
    )) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    res.write(
      `data: ${JSON.stringify({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      })}\n\n`,
    );
  } finally {
    res.end();
  }
}

app.post("/chats/:id/messages", streamChatTurn);
app.post("/chat/:id/messages", streamChatTurn);
app.post("/chat/:id/send", streamChatTurn);

// Lightweight run status for dashboard polling (no log tail)
app.get("/runs/:id/status", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: "Run not found" });
    return;
  }
  res.json({
    id: run.id,
    stage: run.stage,
    stageKind: run.stage,
    phaseId: run.phaseId,
    projectId: run.projectId,
    elapsedMs: run.startedAt
      ? Date.now() - new Date(run.startedAt).getTime()
      : undefined,
    totalDurationMs: run.totalDurationMs ?? null,
  });
});

// Awaited runs for a conversation (dashboard polls on mount)
app.get("/chats/:id/awaited-runs", (req, res) => {
  try {
    const awaited = getChatService().getAwaitedRun(req.params.id);
    res.json({ runs: awaited ? [awaited] : [] });
  } catch (err) {
    res
      .status(chatErrorStatus(err))
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/chats/awaited-runs", (_req, res) => {
  try {
    const runs = getChatService().listAwaitedRuns();
    res.json({ runs });
  } catch (err) {
    res
      .status(500)
      .json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  // Bound the event log before anything replays from it
  try {
    if (runStageBroker.compact()) {
      log.info("events", "event log compacted", {
        path: join(defaultDataDir(), "events.jsonl"),
      });
    }
  } catch (err) {
    log.warn("events", "event log compaction failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  startLiveTurnWatcher();
  startRunCompactionWatcher({
    store,
    isRunActive: (runId) => activeRuns.has(runId),
    projectBusy: (projectId) =>
      store
        .listRuns(projectId)
        .some((run) => activeRuns.has(run.id)),
  });
  startChatConversationWatcher(getChatService());
  // Recover any in-flight awaited runs that survived a server restart
  try {
    getChatService().recoverAwaitedRuns();
  } catch (err) {
    log.warn("chat", "recoverAwaitedRuns failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // Replay the event log for awaited runs that settled while the server was
  // down — supplements the store-scan recovery above (fallback for rotation).
  try {
    const events = runStageBroker.replaySince(0);
    for (const event of events) {
      getChatService().handleRunStageChanged({
        id: event.id,
        stage: event.stage,
        phaseId: event.phaseId,
        projectId: event.projectId,
      });
    }
    if (events.length > 0) {
      log.info("events", "replayed event log on startup", {
        count: events.length,
      });
    }
  } catch (err) {
    log.warn("events", "startup event replay failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const providers = loadProvidersConfig(defaultProvidersPath(defaultDataDir()));
  const providerKeys = Object.entries(providers.providers)
    .map(([name, p]) => `${name}=${p.apiKey ? "set" : "none"}`)
    .join(", ");
  log.info("server", `listening on http://localhost:${PORT}`, {
    dataDir: defaultDataDir(),
    logLevel: process.env.SLOPCONTROL_LOG_LEVEL ?? "info",
    providers: providerKeys || "(none configured)",
  });
  void import("./npm-registry.js")
    .then(({ autoStartNpmRegistry }) =>
      autoStartNpmRegistry(defaultDataDir()),
    )
    .then(() => {
      log.info("npm-registry", "auto-start attempted", {
        dataDir: defaultDataDir(),
      });
    })
    .catch((err) => {
      log.warn("npm-registry", "auto-start failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
});
