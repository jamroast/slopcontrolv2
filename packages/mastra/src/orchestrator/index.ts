import { randomUUID } from "node:crypto";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { Agent } from "@mastra/core/agent";
import {
  appendAppendix,
  appendRunLog,
  applyProposedRoadmap,
  archiveBlueprint,
  blueprintContractPromptBlock,
  bootstrapFromResearch,
  buildProjectInventory,
  synthesizeBlueprintFromInventory,
  buildFailureDiagnosis,
  buildFailureDiagnosisAsync,
  type BuildFailureDiagnosisInput,
  type ClassifyVerifyFailureFn,
  type FailureDiagnosis,
  buildDevelopmentHandoff,
  writeDevelopmentHandoff,
  formatDiagnosisCard,
  countErrors,
  type HandoffMergeInfo,
  type HandoffDiagnosisSnippet,
  ensureSlopcontrolDir,
  ensureDesignDir,
  evaluatePlanProgress,
  extractCheckCells,
  createDefaultCheckRegistry,
  checkCellLabel,
  extractMarkdownDocument,
  extractSection,
  fingerprintErrors,
  formatPlanProgressAppendix,
  automatedCheckReportedFailure,
  harvestTokensCssFromAgentOutput,
  harvestUiSpecFromAgentOutput,
  isDatabasePhase,
  isDesignComplete,
  isProjectEmpty,
  loadLearningsPromptBlock,
  evaluateApiRoutingCompleteGate,
  listDesignAssetPaths,
  markDesignComplete,
  mergePhaseIntoBlueprint,
  envModelFailureAppendix,
  parseDesignAssetBriefs,
  phaseDocWatchPaths,
  phaseNeedsDesign,
  promoteLearning,
  isMissingNodeBinFailure,
  readAppendix,
  readBlueprint,
  readPhaseDoc,
  readProjectConfig,
  readResearch,
  readRoadmap,
  readRunMemory,
  readTokensCss,
  readUiSpec,
  researchDocWatchPaths,
  resetProjectToPhaseZero,
  resolvePhaseDocFromAgentTurn,
  resolveResearchFromAgentTurn,
  scaffoldPhaseDoc,
  scaffoldResearch,
  scaffoldLlmTestHarness,
  snapshotFileStats,
  phaseDocAlignsWithResearch,
  clearMisalignedPhaseDoc,
  formatChangeIntentPromptBlock,
  buildAdjacentPhaseContextPack,
  buildSiblingBrandRefPack,
  descriptionMentionsBrandTheming,
  changeIntentIsBrandTheming,
  changeIntentIsThemeWiringOnly,
  phaseDocAlignsWithChangeIntent,
  researchEngagementQuality,
  formatAntiAuditThemeDeliveryNote,
  phaseDocRejectsMissingThemeAudit,
  clipBlueprintForPrompt,
  isUxPlacementKnowledge,
  upsertRoadmapEntry,
  validateBlueprintDocument,
  validatePhaseDocForDev,
  validateRuntimeClaimProofs,
  validateRuntimeClaimProofsAsync,
  type ClaimProofJudgeFn,
  verifyDatabaseArtifacts,
  verifyOllamaCloudChatAccess,
  verifyOllamaCloudModelIds,
  resolveLlmTestEnvWithProbe,
  mergeEnvOverlay,
  resolveProjectEnv,
  writeResolvedEnvToWorktree,
  writeDiagnosis,
  buildPlanningFailureDiagnosis,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  clearPhaseDiagnosis,
  clearRunDiagnosis,
  writeBlueprint,
  writeCheckReport,
  writeVerifyStepsReport,
  readVerifyStepsReport,
  tearDownComposeInDir,
  tearDownAllProjectWorktreeCompose,
  freePublishedHostPorts,
  applyWorktreeComposeIsolation,
  snapshotCanonicalRuntimeEnv,
  restoreCanonicalRuntimeEnv,
  loadCanonicalRuntimeEnv,
  stopComposeContainersUnderWorktrees,
  scrubIsolationKeysFromProcessEnv,
  scrubIsolationKeysFromEnvRecord,
  writePhaseDoc,
  writePhaseStatus,
  writeResearch,
  writeRoadmap,
  writeRunMemory,
  writeTokensCss,
  writeUiSpec,
  runVerifyPreflight,
  promotePhaseDocFromWorktree,
  extractHtmlDocument,
  scaffoldDesignLoopMock,
  readPhaseDesignAcceptance,
  formatAcceptancePromptBlock,
  formatDesignLoopReviseBlock,
  formatPhaseBoundMockPromptBlock,
  formatDesignPackPromptBlock,
  formatClaimProofChecksGuidance,
  formatDesignLoopSelectionsPromptBlock,
  maybeAutoPinFromOperatorMessage,
  maybeAutoPinDominantLogoFromMock,
  refreshDesignLoopConcepts,
  readPhaseDesignPack,
  resolveDesignLoopGenerateFallback,
  detectMockDrift,
  hardMockDriftIssues,
  softMockDriftIssues,
  composeDesignLoopVersionNotes,
  patchMockForAssetContinue,
  getDesignLoopSelections,
  readDesignLoopMeta,
  buildLiveSiteInventory,
  writeLiveSiteInventory,
  formatLiveSiteInventoryPromptBlock,
  patchMockNavFromInventory,
  CONTINUE_INTENT_DEFAULT,
  fallbackContinueIntentFromText,
  continueIntentAllowsLogoSwap,
  formatContinueIntentPromptBlock,
  readSharedDesignImport,
  formatSharedDesignPromptBlock,
  detectShareSourceFromText,
  resolveDesignShareSource,
  readShareableDesign,
  importDesignShareIntoLoop,
  pickProjectPriorDesign,
  importProjectPriorDesignIntoLoop,
  pickProjectBrandAssets,
  importProjectBrandAssetsIntoLoop,
  readProjectBrandAssetsImport,
  formatBrandAssetsPromptBlock,
  readProjectPriorDesignImport,
  formatProjectPriorDesignPromptBlock,
  extractSiblingProjectPaths,
  unpinDesignLoopSelection,
  pinDesignLoopLogoAsset,
  dominantMockLogoAsset,
  readDesignLoopElements,
  formatDesignElementsPromptBlock,
  resolveDesignElement,
  importDesignElementIntoLoop,
  unpinDesignElementsFromLoop,
  applyPinnedDesignElementsToMock,
  stripExtraThemeTogglesOutsideMenubar,
  extractElementBodyHtml,
  getDesignLoopScope,
  applyContinueIntentToScope,
  defaultProductScope,
  formatConceptualModelPromptBlock,
  extractThemeContractFromHtml,
  packHasThemeModes,
  withUpdatedScope,
  writeDesignLoopMeta,
  readDesignLoopMockHtml,
  readPlanLoopMeta,
  writePlanLoopMeta,
  defaultPlanScope,
  formatPlanLoopReviseBlock,
  formatPlanAcceptancePromptBlock,
  readPlanLoopAcceptance,
  clearPlanLoopAcceptanceLocks,
  extractPlanDocument,
  validatePlanDocument,
  mergePlanDocumentSections,
  planDocumentWorthMerging,
  resolvePlanLoopGenerateFallback,
  scaffoldPlanDocument,
  failurePlanDocument,
  PLAN_CONTINUE_INTENT_DEFAULT,
  fallbackPlanContinueIntentFromText,
  normalizePlanContinueIntentStructured,
  formatPlanContinueIntentPromptBlock,
  buildSiblingInvestigationPack,
  briefWantsSiblingInvestigation,
  formatPhaseBoundPlanPromptBlock,
  readPhasePlanPack,
  buildCrossProjectCatalog,
  detectDependencyIntentFromText,
  listElementsToAutoImport,
  formatCrossProjectCatalogPromptBlock,
  formatDependencyIntentPromptBlock,
  formatAskDependencyTaskBriefNudge,
  type ContinueIntent,
  type PlanContinueIntent,
  type DependencyIntent,
} from "@slopcontrol/artifacts";
import {
  ensureGitInitialized,
  ensurePhaseWorktree,
  getCodingToolForProject,
  getDesignTool,
  isLogoAssetBrief,
  isStallAbortReason,
  listWorktreeChangedFiles,
  mergePhaseWorktree,
  removePhaseWorktree,
  shouldBlockOnStallStrikes,
  shouldRecreateCodingSession,
  isProductiveTurnTimeout,
  syncLocalFilesFromWorktree,
  syncLocalFilesToWorktree,
  syncPhaseArtifactsToWorktree,
  syncIgnoredArtifactsFromWorktree,
  deriveIconPackFromAsset,
  makeTransparentDesignAsset,
  circularMaskDesignAsset,
} from "@slopcontrol/coding-tools";
import {
  chatWithImages,
  classifyContinueIntentViaLlm,
  classifyPlanContinueIntentViaLlm,
  classifyDependencyIntentViaLlm,
  classifyElementHonorViaLlm,
  classifyVerifyFailureViaLlm,
  judgeClaimProofViaLlm,
  judgeNarrationOnlyViaLlm,
  buildElementHonorSnippets,
  tryMenubarEmbedSimilarity,
  filterRasterVisionPaths,
  type LlmRegistry,
} from "@slopcontrol/llm";
import {
  ensureChangeIntentAsync,
  previewChangeIntentAsync,
} from "./change-intent-async.js";
import {
  ASK_SYNTHESIS_PROMPT_PREFIX,
  askProgressFromStreamChunk,
  decideNarrationSynthesis,
  LiveTurnInterruptedError,
  type AskProgressCallback,
  type LiveProgressCallback,
  type NarrationJudgeFn,
} from "./ask-stream.js";
import {
  buildSupervisorEnrichPrompt,
  extractNextActionsSummary,
  isPromptTooLongError,
  priorNextActionsFromMemory,
  resolveAgentMemoryOption,
} from "../supervisor-enrich.js";
import { basename, dirname, join } from "node:path";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  depsInstallCommand,
  needsDepsInstall,
} from "./deps-install.js";
import { buildDevelopCodingRetryPrompt } from "./coding-retry-prompt.js";
export {
  buildDevelopCodingRetryPrompt,
  resolveDevelopCodingRetryKind,
} from "./coding-retry-prompt.js";
export type {
  DevelopCodingRetryInput,
  DevelopCodingRetryKind,
} from "./coding-retry-prompt.js";
import {
  ASK_SUB_RESEARCH_MAX_TOPICS,
  COMPLETION_TOKENS,
  formatDurationMs,
  log as slog,
  safeJsonForLog,
  type BlueprintStatus,
  type Phase,
  type Project,
  type ProjectOpenMode,
  type Run,
  type RunStage,
} from "@slopcontrol/types";

const execAsync = promisify(exec);

const MAX_NO_PROGRESS = 8;
const MAX_ITERATIONS = 50;
/** Default OpenCode coding turn wall-clock (overridable via config / env). */
const DEFAULT_CODING_TURN_MS = 600_000;

function resolveCodingTurnTimeoutMs(config: {
  codingTurnTimeoutMs?: number;
}): number {
  if (
    typeof config.codingTurnTimeoutMs === "number" &&
    Number.isFinite(config.codingTurnTimeoutMs) &&
    config.codingTurnTimeoutMs > 0
  ) {
    return Math.floor(config.codingTurnTimeoutMs);
  }
  const fromEnv = Number(process.env.SLOPCONTROL_CODING_TURN_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return Math.floor(fromEnv);
  }
  return DEFAULT_CODING_TURN_MS;
}

export interface OrchestratorAgents {
  researchAgent: Agent;
  phasePlannerAgent: Agent;
  reviewAgent: Agent;
  designAgent: Agent;
  designLoopAgent: Agent;
  planLoopAgent: Agent;
  planLoopRepairAgent: Agent;
  devSupervisorAgent: Agent;
  blueprintAgent: Agent;
  askAgent: Agent;
  askSubResearchAgent: Agent;
  agentChatAgent: Agent;
}

export interface OrchestratorContext {
  dataDir: string;
  registry: LlmRegistry;
  agents: OrchestratorAgents;
  /**
   * Auto-publish hook fired after a phase completes on a project whose
   * config sets `componentLibrary: true`. Defaults to an HTTP POST to the
   * server's design-library/publish endpoint (same boundary as the MCP
   * layer); inject a fake in tests.
   */
  publishComponentLibrary?: (opts: {
    projectId: string;
    projectRoot: string;
  }) => Promise<ComponentLibraryPublishOutcome>;
}

export type ComponentLibraryPublishOutcome = {
  ok: boolean;
  summary: string;
};

/** Map the server's publish report to a run-log outcome (pure, testable). */
export function summarizeLibraryPublishResponse(
  httpStatus: number,
  body: {
    name?: string;
    version?: string;
    propagation?: Array<{ ok: boolean }>;
    error?: string;
  },
): ComponentLibraryPublishOutcome {
  if (httpStatus < 200 || httpStatus >= 300) {
    return { ok: false, summary: body.error ?? `HTTP ${httpStatus}` };
  }
  const consumers = body.propagation ?? [];
  const failed = consumers.filter((c) => !c.ok).length;
  const consumerPart = consumers.length
    ? `; ${consumers.length - failed}/${consumers.length} consumers updated`
    : "; no registered consumers";
  return {
    ok: true,
    summary: `${body.name}@${body.version} published${consumerPart}`,
  };
}

/**
 * Default auto-publish: server REST endpoint (orchestrator → server over
 * HTTP keeps packages/mastra decoupled from apps/server).
 */
export async function defaultPublishComponentLibrary(opts: {
  projectId: string;
  projectRoot: string;
}): Promise<ComponentLibraryPublishOutcome> {
  const base = `http://127.0.0.1:${process.env.SLOPCONTROL_PORT ?? 3020}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10 * 60_000);
  try {
    const res = await fetch(
      `${base}/projects/${encodeURIComponent(opts.projectId)}/design-library/publish`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      name?: string;
      version?: string;
      propagation?: Array<{ ok: boolean }>;
      error?: string;
    };
    return summarizeLibraryPublishResponse(res.status, body);
  } finally {
    clearTimeout(timer);
  }
}

export interface AskTurnInput {
  project: Project;
  askId: string;
  message: string;
  /** Prior messages excluding the new user message (already appended by caller optionally) */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  dataDir?: string;
  /** Live tool/text progress (SSE / MCP). */
  onProgress?: AskProgressCallback;
  abortSignal?: AbortSignal;
}

export interface AskSubResearchInput {
  project: Project;
  askId: string;
  topics: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

export interface DesignLoopGenerateInput {
  project: Project;
  loopId: string;
  brief: string;
  /** Operator feedback for continue turns (omit on start). */
  message?: string;
  /** Prior mock HTML to revise (continue). */
  previousHtml?: string;
  version: number;
  /** Store lookups for chat auto design-share (registered project names). */
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  findProjectByRootPath?: (
    rootPath: string,
  ) => { id: string; name: string; rootPath: string } | undefined;
  /** SlopControl data dir for global shared-elements registry (B). */
  dataDir?: string;
  onProgress?: LiveProgressCallback;
  abortSignal?: AbortSignal;
}

export interface PlanLoopGenerateInput {
  project: Project;
  loopId: string;
  brief: string;
  message?: string;
  previousPlan?: string;
  version: number;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  dataDir?: string;
  onProgress?: LiveProgressCallback;
  abortSignal?: AbortSignal;
}

export interface AgentTurnInput {
  project: Project;
  agentId: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  dataDir?: string;
  onProgress?: LiveProgressCallback;
  abortSignal?: AbortSignal;
}

export interface StartResearchInput {
  project: Project;
  phase: Phase;
  run: Run;
  description: string;
  /** Advance run stage (e.g. researching → drafting) without guessing wall-clock in the HTTP layer. */
  onStage?: (stage: RunStage) => void;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
}

export interface ReviewInput {
  project: Project;
  phase: Phase;
  run: Run;
  decision: "approve" | "request_changes";
  feedback?: string;
}

export interface OpenProjectResult {
  blueprintStatus: BlueprintStatus;
  mode: ProjectOpenMode;
  archivePath?: string | null;
  blueprintPreview: string;
  roadmapPreview: string;
  message?: string;
  suggestedNextChange?: string;
  durationMs?: number;
  duration?: string;
}

function emptyOpenResult(
  status: BlueprintStatus,
  mode: ProjectOpenMode,
  message?: string,
): OpenProjectResult {
  return {
    blueprintStatus: status,
    mode,
    archivePath: null,
    blueprintPreview: "",
    roadmapPreview: "",
    message,
  };
}

function log(project: Project, run: Run | null, line: string): void {
  const trimmed = line.trim();
  // Mirror short status lines to stderr; skip dumping full agent markdown.
  if (
    trimmed.startsWith("---") ||
    trimmed.startsWith("===") ||
    trimmed.startsWith("[timing]") ||
    trimmed.startsWith("ERROR:") ||
    trimmed.startsWith("SUCCESS CHECKS") ||
    trimmed.startsWith("Changed files:") ||
    trimmed === COMPLETION_TOKENS.DEV_COMPLETE ||
    trimmed === COMPLETION_TOKENS.DEV_BLOCKED
  ) {
    slog.info("orchestrator", trimmed.slice(0, 500), {
      projectId: project.id,
      runId: run?.id,
    });
  } else if (trimmed.startsWith("[opencode:")) {
    slog.debug("orchestrator", trimmed.slice(0, 240), {
      projectId: project.id,
      runId: run?.id,
    });
  }
  if (!run) return;
  appendRunLog(project.rootPath, run.id, line);
}

/** Write full check output to runs/<id>/checks/ and note the path in the run log. */
function persistCheckOutput(
  project: Project,
  run: Run,
  name: string,
  output: string,
  ok?: boolean,
  checks?: SuccessCheckResult,
): string {
  const path = writeCheckReport(project.rootPath, run.id, name, output);
  log(project, run, `--- Check report written: ${path} ---`);
  if (checks?.steps?.length) {
    const report = writeVerifyStepsReport(project.rootPath, run.id, checks);
    log(
      project,
      run,
      `--- Verify steps written (${report.steps.length} steps, ok=${report.ok})${
        report.firstFailure ? ` firstFailure=${report.firstFailure.id}` : ""
      } ---`,
    );
  }
  slog.info("orchestrator", `check report ${name}`, {
    projectId: project.id,
    runId: run.id,
    path,
    bytes: output.length,
    okHint:
      ok === undefined
        ? /SUCCESS CHECKS FAILED|FAILED:|chat smoke errored|printed FAIL|Merged OK .* but root tests/i.test(
            output,
          )
          ? "failed"
          : "ok"
        : ok
          ? "ok"
          : "failed",
  });
  return path;
}

const REVERSE_ENGINEER_MAX_STEPS = 50;

/** Cap large docs in agent prompts so observational memory is not blown before the agent can write. */
function clipPromptSection(label: string, text: string, maxChars: number): string {
  const body = (text ?? "").trim();
  if (!body) return `(${label}: none)`;
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n\n…[truncated ${label}: ${body.length} chars total; read_file \`.slopcontrol/${label}\` if you need more]`;
}

/** Media tools from structured ContinueIntent (no chat regex). */
function designLoopNeedsMediaTools(intent: ContinueIntent): boolean {
  return (
    intent.inventLogo ||
    intent.wantsAssetEdit ||
    (intent.assetOps?.length ?? 0) > 0 ||
    intent.targets.includes("logo") ||
    intent.scope === "assets_only" ||
    intent.scope === "logo_invent"
  );
}

/** Persist truncated provider/API detail — bare "Bad Request" is not actionable. */
function formatLlmErrorForLog(error: unknown, maxChars = 2_000): string {
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
        "response",
      ]) {
        push(key, any[key]);
      }
      if (any.cause != null) walk(any.cause, depth + 1);
      return;
    }
    if (typeof err === "object") {
      push("detail", err);
    }
  };

  walk(error, 0);
  const out = chunks.filter(Boolean).join(" | ");
  return (out || "unknown error").slice(0, maxChars + 400);
}

function isProviderBadRequest(error: unknown): boolean {
  if (error == null) return false;
  const msg = error instanceof Error ? error.message : String(error);
  if (/bad\s*request/i.test(msg)) return true;
  const any = error as { statusCode?: number; status?: number; cause?: unknown };
  if (any.statusCode === 400 || any.status === 400) return true;
  if (any.cause != null) return isProviderBadRequest(any.cause);
  return false;
}

function researchLooksSolid(research: string): boolean {
  const body = (research ?? "").trim();
  return (
    body.length >= 400 &&
    (/RESEARCH_COMPLETE/i.test(body) || /^#\s+/m.test(body))
  );
}

async function runAgent(
  agent: Agent,
  prompt: string,
  resourceId: string,
  threadId: string,
  opts?: {
    maxSteps?: number;
    timeoutMs?: number;
    /** Pass false to skip Mastra thread replay (supervisor enrich). */
    memory?: false | { resource: string; thread: string };
  },
): Promise<string> {
  const name =
    (agent as { name?: string }).name ??
    (agent as { id?: string }).id ??
    "agent";
  const maxSteps = opts?.maxSteps ?? 30;
  const timeoutMs = opts?.timeoutMs;
  const memoryOpt = resolveAgentMemoryOption(
    resourceId,
    threadId,
    opts?.memory,
  );
  const started = Date.now();
  slog.info("agent", `start ${name}`, {
    resourceId,
    threadId,
    promptChars: prompt.length,
    maxSteps,
    timeoutMs,
    memory: memoryOpt ? "thread" : "none",
  });
  try {
    const generate = () =>
      agent.generate(prompt, {
        maxSteps,
        ...(memoryOpt ? { memory: memoryOpt } : {}),
      });
    const result =
      timeoutMs && timeoutMs > 0
        ? await Promise.race([
            generate(),
            new Promise<never>((_, reject) => {
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `Agent ${name} timed out after ${timeoutMs}ms`,
                    ),
                  ),
                timeoutMs,
              );
            }),
          ])
        : await generate();
    const text = result.text ?? "";
    slog.info("agent", `done ${name}`, {
      resourceId,
      threadId,
      durationMs: Date.now() - started,
      duration: formatDurationMs(Date.now() - started),
      outputChars: text.length,
    });
    return text;
  } catch (error) {
    const detail = formatLlmErrorForLog(error);
    slog.error("agent", `failed ${name}`, {
      resourceId,
      threadId,
      durationMs: Date.now() - started,
      error: detail,
    });
    if (
      /memory|storage|libsql|observational/i.test(detail) &&
      !/requires a threadId|none was found in RequestContext/i.test(detail)
    ) {
      slog.error(
        "agent",
        "Mastra Memory/storage failure — check ~/.slopcontrol/mastra.db is writable and the supervisor LLM endpoint resolves for observationalMemory",
        {
          hint: "GET /health → mastraStorage; configure endpoints.json supervisor role",
        },
      );
    }
    if (/requires a threadId|ObservationalMemory.*threadId/i.test(detail)) {
      slog.error(
        "agent",
        "ObservationalMemory requires threadId — supervisor enrich must use memory:false without OM Memory on the agent",
        {
          hint: "createDevSupervisorAgent must not attach shared Memory with observationalMemory",
        },
      );
    }
    if (error instanceof Error) {
      if (detail !== error.message) {
        throw new Error(detail, { cause: error });
      }
      throw error;
    }
    throw new Error(detail, { cause: error });
  }
}

/**
 * Stream an agent live turn with progress + AbortSignal.
 * Optional narration→synthesis for ask-style turns.
 */
async function runAgentLiveTurn(
  agent: Agent,
  prompt: string,
  resourceId: string,
  threadId: string,
  opts?: {
    maxSteps?: number;
    timeoutMs?: number;
    onProgress?: LiveProgressCallback;
    abortSignal?: AbortSignal;
    /** When true, narration-only + tools → synthesis pass */
    synthesizeIfNarration?: boolean;
    /** LLM judge confirming narration before a synthesis pass is burned. */
    narrationJudgeFn?: NarrationJudgeFn | null;
    statusLabel?: string;
  },
): Promise<{ reply: string; toolCallCount: number; synthesized: boolean }> {
  const name =
    (agent as { name?: string }).name ??
    (agent as { id?: string }).id ??
    "agent";
  const maxSteps = opts?.maxSteps ?? 12;
  const timeoutMs = opts?.timeoutMs ?? 240_000;
  const onProgress = opts?.onProgress;
  const signal = opts?.abortSignal;
  const memoryOpt = resolveAgentMemoryOption(resourceId, threadId);
  const started = Date.now();
  let toolCallCount = 0;
  let textAccum = "";

  const throwIfAborted = () => {
    if (signal?.aborted) {
      throw new LiveTurnInterruptedError(
        "Live turn interrupted",
        textAccum.trim(),
      );
    }
  };

  const emit = (event: Parameters<NonNullable<LiveProgressCallback>>[0]) => {
    try {
      onProgress?.(event);
    } catch {
      /* ignore listener errors */
    }
  };

  slog.info("agent", `start ${name} (stream)`, {
    resourceId,
    threadId,
    promptChars: prompt.length,
    maxSteps,
    timeoutMs,
  });
  emit({
    type: "status",
    summary: opts?.statusLabel ?? "turn started",
  });

  const runStream = async (): Promise<string> => {
    throwIfAborted();
    const streamResult = await agent.stream(prompt, {
      maxSteps,
      ...(memoryOpt ? { memory: memoryOpt } : {}),
      ...(signal ? { abortSignal: signal } : {}),
    });
    const fullStream = (
      streamResult as { fullStream?: AsyncIterable<unknown> }
    ).fullStream;
    if (fullStream && typeof fullStream[Symbol.asyncIterator] === "function") {
      for await (const chunk of fullStream) {
        throwIfAborted();
        const events = askProgressFromStreamChunk(chunk);
        for (const ev of events) {
          if (ev.type === "tool_call") toolCallCount += 1;
          if (ev.type === "text") textAccum += ev.text;
          emit(ev);
        }
      }
    }
    throwIfAborted();
    const finalTextRaw = (streamResult as { text?: Promise<string> | string })
      .text;
    const finalText =
      typeof finalTextRaw === "string"
        ? finalTextRaw
        : finalTextRaw &&
            typeof (finalTextRaw as Promise<string>).then === "function"
          ? await finalTextRaw
          : textAccum;
    return (finalText || textAccum || "").trim();
  };

  try {
    throwIfAborted();
    const reply = await Promise.race([
      runStream(),
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          reject(
            new LiveTurnInterruptedError(
              "Live turn interrupted",
              textAccum.trim(),
            ),
          );
        };
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        setTimeout(
          () =>
            reject(
              new Error(`Agent ${name} timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);

    let out = reply;
    let synthesized = false;
    const narrationDecision = await decideNarrationSynthesis({
      reply: out,
      toolCallCount,
      synthesizeIfNarration: opts?.synthesizeIfNarration,
      judgeFn: opts?.narrationJudgeFn,
    });
    if (narrationDecision.judgeOverrode) {
      slog.info("agent", `${name} narration heuristic overridden by llm judge`, {
        toolCallCount,
        reason: narrationDecision.judgeReason ?? "",
      });
    }
    if (!narrationDecision.heuristicFlagged && narrationDecision.synthesize) {
      slog.info("agent", `${name} narration heuristic miss rescued by llm judge`, {
        toolCallCount,
        reason: narrationDecision.judgeReason ?? "",
      });
    }
    if (narrationDecision.synthesize) {
      throwIfAborted();
      emit({
        type: "status",
        summary: "synthesizing answer from tool findings",
      });
      slog.info("agent", `${name} narration-only; synthesis pass`, {
        toolCallCount,
        outputChars: out.length,
      });
      const synthPrompt = `${ASK_SYNTHESIS_PROMPT_PREFIX}

---
${prompt}

---
Draft / incomplete reply to replace:
${out.slice(0, 2_000) || "(empty)"}`;
      const remainingMs = Math.max(
        30_000,
        timeoutMs - (Date.now() - started),
      );
      const synthMemory = {
        resource: resourceId,
        thread: `${threadId}-synth`,
      };
      const synthGenerate = () =>
        agent.generate(synthPrompt, {
          maxSteps: 1,
          activeTools: [],
          memory: synthMemory,
          ...(signal ? { abortSignal: signal } : {}),
        });
      const synthResult =
        remainingMs > 0
          ? await Promise.race([
              synthGenerate(),
              new Promise<never>((_, reject) => {
                const onAbort = () => {
                  reject(
                    new LiveTurnInterruptedError(
                      "Live turn interrupted",
                      out,
                    ),
                  );
                };
                if (signal) {
                  if (signal.aborted) onAbort();
                  else signal.addEventListener("abort", onAbort, { once: true });
                }
                setTimeout(
                  () =>
                    reject(
                      new Error(
                        `Agent ${name} synthesis timed out after ${remainingMs}ms`,
                      ),
                    ),
                  remainingMs,
                );
              }),
            ])
          : await synthGenerate();
      const synthText = (synthResult as { text?: Promise<string> | string })
        .text;
      out = String(
        typeof synthText === "string"
          ? synthText
          : synthText && typeof synthText.then === "function"
            ? await synthText
            : "",
      ).trim();
      synthesized = true;
      if (out) {
        emit({ type: "text", text: out });
      }
    }

    slog.info("agent", `done ${name} (stream)`, {
      resourceId,
      threadId,
      durationMs: Date.now() - started,
      duration: formatDurationMs(Date.now() - started),
      outputChars: out.length,
      toolCallCount,
      synthesized,
    });
    return {
      reply: out || "(empty reply)",
      toolCallCount,
      synthesized,
    };
  } catch (error) {
    if (error instanceof LiveTurnInterruptedError) {
      slog.info("agent", `interrupted ${name}`, {
        resourceId,
        threadId,
        durationMs: Date.now() - started,
        partialChars: error.partialReply.length,
      });
      throw error;
    }
    const detail = formatLlmErrorForLog(error);
    slog.error("agent", `failed ${name} (stream)`, {
      resourceId,
      threadId,
      durationMs: Date.now() - started,
      error: detail,
    });
    if (error instanceof Error) {
      if (detail !== error.message) {
        throw new Error(detail, { cause: error });
      }
      throw error;
    }
    throw new Error(detail, { cause: error });
  }
}

/** @deprecated Prefer runAgentLiveTurn */
async function runAskAgentStream(
  agent: Agent,
  prompt: string,
  resourceId: string,
  threadId: string,
  opts?: {
    maxSteps?: number;
    timeoutMs?: number;
    onProgress?: AskProgressCallback;
    abortSignal?: AbortSignal;
    narrationJudgeFn?: NarrationJudgeFn | null;
  },
): Promise<{ reply: string; toolCallCount: number; synthesized: boolean }> {
  return runAgentLiveTurn(agent, prompt, resourceId, threadId, {
    ...opts,
    synthesizeIfNarration: true,
    statusLabel: "ask started",
  });
}

function writeBlueprintAndRoadmap(projectRoot: string, rawOutput: string): string {
  // Prefer an already-structured document (e.g. inventory synthesis) as-is.
  const trimmed = rawOutput.replace(/\r\n/g, "\n").trim();
  const doc =
    /^#\s+Blueprint\b/im.test(trimmed) && /^##\s+/m.test(trimmed)
      ? trimmed.replace(/^(BLUEPRINT_COMPLETE)\s*$/gm, "").trim()
      : extractMarkdownDocument(rawOutput);
  writeBlueprint(projectRoot, doc);
  // Always extract ## Proposed Roadmap (works even when a ROADMAP stub already exists)
  if (!applyProposedRoadmap(projectRoot, doc)) {
    applyProposedRoadmap(projectRoot, rawOutput);
  }
  if (!readRoadmap(projectRoot).trim()) {
    writeRoadmap(
      projectRoot,
      "# Roadmap\n\n| Phase | Title | Status | Depends on |\n|-------|-------|--------|------------|\n",
    );
  }
  return readBlueprint(projectRoot);
}

function hasToken(output: string, token: string): boolean {
  return output.includes(token);
}

export type CommandRunner = (
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<{ output: string; exitCode: number }>;

/** Default wall-clock budget for verify/check commands (ms). */
export function resolveCheckTimeoutMs(): number {
  const n = Number(process.env.SLOPCONTROL_CHECK_MS ?? 60_000);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

/**
 * Run a shell command with a wall-clock budget. On timeout, kills the process
 * group (Unix) and returns exit 124 with a CHECK_TIMEOUT marker.
 */
export async function runCommandWithTimeout(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  timeoutMs: number = resolveCheckTimeoutMs(),
): Promise<{ output: string; exitCode: number }> {
  if (!timeoutMs || timeoutMs <= 0) {
    return runCommand(command, cwd, env);
  }

  return new Promise((resolve) => {
    let settled = false;
    const chunks: Buffer[] = [];
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const append = (d: Buffer) => {
      chunks.push(d);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    const finish = (exitCode: number, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        output: Buffer.concat(chunks).toString("utf8") + extra,
        exitCode,
      });
    };

    const timer = setTimeout(() => {
      const pid = child.pid;
      if (pid != null) {
        try {
          if (process.platform !== "win32") {
            process.kill(-pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }
      }
      finish(124, `\nCHECK_TIMEOUT after ${timeoutMs}ms\n`);
    }, timeoutMs);

    child.on("error", (err) => {
      finish(1, `\n${err.message}\n`);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
  });
}

/** Wrap a runner with a wall-clock budget (process-group kill for default path). */
export function withCommandTimeout(
  runner: CommandRunner,
  timeoutMs: number = resolveCheckTimeoutMs(),
): CommandRunner {
  return async (command, cwd, env) => {
    if (!timeoutMs || timeoutMs <= 0) {
      return runner(command, cwd, env);
    }
    if (runner === runCommand) {
      return runCommandWithTimeout(command, cwd, env, timeoutMs);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        runner(command, cwd, env).finally(() => {
          if (timer) clearTimeout(timer);
        }),
        new Promise<{ output: string; exitCode: number }>((resolve) => {
          timer = setTimeout(() => {
            resolve({
              output: `CHECK_TIMEOUT after ${timeoutMs}ms\n`,
              exitCode: 124,
            });
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export async function runCommand(
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ output: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      env: env ?? process.env,
    });
    return { output: stdout + stderr, exitCode: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      output: (err.stdout ?? "") + (err.stderr ?? ""),
      exitCode: err.code ?? 1,
    };
  }
}

/** Wrap a runner so every invocation gets the LLM test env overlay. */
export function withEnvOverlay(
  runner: CommandRunner,
  overlay: Record<string, string>,
): CommandRunner {
  return (command, cwd, env) =>
    runner(command, cwd, mergeEnvOverlay(env ?? process.env, overlay));
}

async function runBuild(
  project: Project,
  cwd: string,
  runner: CommandRunner = runCommand,
): Promise<{ output: string; exitCode: number }> {
  const config = readProjectConfig(project.rootPath);
  return runner(config.buildCommand, cwd);
}

export type SuccessCheckMode = "full" | "verify" | "build";

export {
  depsInstallCommand,
  detectPackageManager,
  needsDepsInstall,
} from "./deps-install.js";
export type { PackageManager } from "./deps-install.js";
export {
  ASK_SYNTHESIS_PROMPT_PREFIX,
  askProgressFromStreamChunk,
  askProgressLine,
  clipAskProgress,
  decideNarrationSynthesis,
  formatAskWorkingStub,
  hasSubstantiveReplyMarkers,
  isAskNarrationOnlyReply,
  isLiveTurnInterruptedError,
  LiveTurnInterruptedError,
  summarizeToolArgs,
  summarizeToolResult,
  toolCallFingerprint,
} from "./ask-stream.js";
export type {
  AskProgressCallback,
  AskProgressEvent,
  LiveProgressCallback,
  LiveProgressEvent,
  NarrationJudgeFn,
  NarrationJudgeVerdict,
  NarrationSynthesisDecision,
} from "./ask-stream.js";
export {
  ensureChangeIntentAsync,
  previewChangeIntentAsync,
} from "./change-intent-async.js";
export type { EnsureChangeIntentAsyncOptions } from "./change-intent-async.js";

export type SuccessCheckStep = {
  name: string;
  command?: string;
  exitCode: number;
  output: string;
};

export type SuccessCheckResult = {
  ok: boolean;
  /** Full concatenated log (for check dumps). */
  output: string;
  steps: SuccessCheckStep[];
  firstFailure?: SuccessCheckStep;
  /** Short card for agents: failing step + exit + last lines of that step only. */
  summary: string;
};

function lastNLines(text: string, n: number): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  return lines.slice(-n).join("\n");
}

function buildCheckSummary(
  ok: boolean,
  steps: SuccessCheckStep[],
  firstFailure?: SuccessCheckStep,
): string {
  if (ok) {
    return `Verify OK (${steps.length} steps).`;
  }
  if (!firstFailure) {
    return "Verify failed (no step detail).";
  }
  return [
    `FAILING STEP: ${firstFailure.name}`,
    firstFailure.command
      ? `command: ${firstFailure.command.slice(0, 200)}`
      : null,
    `exitCode: ${firstFailure.exitCode}`,
    "",
    lastNLines(firstFailure.output, 40),
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function failResult(
  parts: string[],
  steps: SuccessCheckStep[],
  failure: SuccessCheckStep,
): SuccessCheckResult {
  const stepsWithFailure = [...steps, failure];
  const output = [...parts, `${failure.name}${failure.command ? ` (${failure.command})` : ""}:\n${failure.output}`].join(
    "\n\n",
  );
  return {
    ok: false,
    output,
    steps: stepsWithFailure,
    firstFailure: failure,
    summary: buildCheckSummary(false, stepsWithFailure, failure),
  };
}

function isExit127CommandNotFoundFailure(
  checks: SuccessCheckResult,
): boolean {
  const fail = checks.firstFailure;
  if (!fail) return false;
  // Only auto deps-install for missing package bins — not host utilities (timeout).
  return isMissingNodeBinFailure({
    name: fail.name,
    command: fail.command,
    exitCode: fail.exitCode,
    output: fail.output,
  });
}

/**
 * Gates for marking development complete.
 * - full: build + phase-doc validation + tests + automated checks + verify + DB
 * - build: build + phase-doc validation only (worktree gate when tests run on root)
 * - verify: tests + automated checks + verify + DB (project root after merge)
 */
export async function runSuccessChecks(
  project: Project,
  phaseDoc: string,
  cwd: string,
  opts?: {
    mode?: SuccessCheckMode;
    runner?: CommandRunner;
    /** Skip PHASE.md Automated Checks presence validation (default false) */
    skipPhaseDocValidation?: boolean;
    /**
     * Always run package-manager install before testCommand (e.g. post-merge
     * root verify — gitignored node_modules never arrives via merge).
     */
    forceDepsInstall?: boolean;
    /** When set, claim-vs-proof can read phase design ACCEPTANCE / mock. */
    phaseId?: string;
    /** When set, claim-vs-proof gate issues are refined by the LLM judge. */
    registry?: LlmRegistry;
  },
): Promise<SuccessCheckResult> {
  const mode = opts?.mode ?? "full";
  const config = readProjectConfig(project.rootPath);
  const parts: string[] = [];
  const steps: SuccessCheckStep[] = [];
  const runBuildStep = mode === "full" || mode === "build";
  const runTestStep = mode === "full" || mode === "verify";

  // Resolve full project env + LLM test profile (technology-agnostic passthrough).
  let llmOverlay: Record<string, string> = {};
  let baseRunner = opts?.runner ?? runCommand;
  let runner = baseRunner;
  if (runTestStep) {
    const projectEnv = resolveProjectEnv({
      projectRoot: project.rootPath,
      config,
      processEnv:
        mode === "verify"
          ? scrubIsolationKeysFromProcessEnv(process.env)
          : process.env,
    });
    const llm = await resolveLlmTestEnvWithProbe({
      projectRoot: project.rootPath,
      config,
    });
    // LLM profile overlay wins for its keys; project env provides everything else
    llmOverlay = { ...projectEnv.env, ...llm.env };
    if (mode === "verify") {
      llmOverlay = scrubIsolationKeysFromEnvRecord(llmOverlay);
    }
    // Wall-clock budget for deps/test/Automated Checks (not build — that keeps baseRunner).
    const budgetMs = resolveCheckTimeoutMs();
    const budgetedBase: CommandRunner =
      baseRunner === runCommand
        ? (command, cwd, env) =>
            runCommandWithTimeout(command, cwd, env, budgetMs)
        : withCommandTimeout(baseRunner, budgetMs);
    runner = withEnvOverlay(budgetedBase, llmOverlay);
    parts.push(
      [
        `Project env: ${Object.keys(projectEnv.env).length} key(s) from [${projectEnv.fromFiles.join(", ") || "none"}]`,
        ...projectEnv.notes.map((n) => `Env note: ${n}`),
        `LLM test profile: ${llm.profile} (source=${llm.source})`,
        llm.probeOk
          ? `LLM probe: ${llm.probeDetail}`
          : `LLM probe failed → fixture fallback: ${llm.probeDetail}`,
        ...llm.notes.map((n) => `LLM note: ${n}`),
      ].join("\n"),
    );
    steps.push({
      name: "project-env",
      exitCode: 0,
      output: parts[parts.length - 1] ?? "",
    });
  }

  // Install when node_modules is missing/stale or forceDepsInstall — before
  // build (worktree build gate) and before tests (verify). At most once per pass.
  let depsInstalledThisPass = false;
  const tryDepsInstall = async (): Promise<SuccessCheckResult | null> => {
    if (depsInstalledThisPass) return null;
    if (
      !needsDepsInstall(cwd, { force: opts?.forceDepsInstall === true })
    ) {
      return null;
    }
    const installCmd = depsInstallCommand(cwd);
    const install = await runner(installCmd, cwd);
    const installStep: SuccessCheckStep = {
      name: "deps-install",
      command: installCmd,
      exitCode: install.exitCode,
      output: install.output,
    };
    parts.push(`deps-install (${installCmd}):\n${install.output.slice(-2000)}`);
    if (install.exitCode !== 0) {
      return failResult(parts.slice(0, -1), steps, {
        ...installStep,
        output: `Dependency install failed.\n${install.output}`,
      });
    }
    steps.push(installStep);
    depsInstalledThisPass = true;
    return null;
  };

  if (runBuildStep) {
    const installFail = await tryDepsInstall();
    if (installFail) return installFail;
    const build = await runBuild(project, cwd, baseRunner);
    const step: SuccessCheckStep = {
      name: "build",
      command: config.buildCommand,
      exitCode: build.exitCode,
      output: build.output,
    };
    if (build.exitCode !== 0) {
      return failResult(parts, steps, {
        ...step,
        output: `Build failed.\n${build.output}`,
      });
    }
    steps.push(step);
    parts.push(`Build OK.\n${build.output.slice(-500)}`);
  }

  if (!opts?.skipPhaseDocValidation) {
    const phaseGate = validatePhaseDocForDev(phaseDoc, {
      projectRoot: project.rootPath,
      phaseId: opts?.phaseId,
    });
    const refined = opts?.registry
      ? await refineClaimProofGateIssues(
          opts.registry,
          phaseDoc,
          phaseGate.issues,
          { projectRoot: project.rootPath, phaseId: opts?.phaseId },
        )
      : { issues: phaseGate.issues, warnings: [] as string[] };
    if (refined.issues.length > 0) {
      const msg = `PHASE.md validation failed:\n${refined.issues.map((i) => `- ${i}`).join("\n")}`;
      parts.push(msg);
      return failResult(parts, steps, {
        name: "phase-doc-validation",
        exitCode: 1,
        output: msg,
      });
    }
  }

  if (mode === "build") {
    parts.push(
      "Worktree build gate OK (tests deferred to project root after merge).",
    );
    return {
      ok: true,
      output: parts.join("\n\n"),
      steps,
      summary: buildCheckSummary(true, steps),
    };
  }

  if (runTestStep) {
    const preflight = await runVerifyPreflight(
      cwd,
      config.verifyPreflightCommand,
      runner,
    );
    parts.push(preflight.output);
    const pfStep: SuccessCheckStep = {
      name: "verify-preflight",
      command: config.verifyPreflightCommand,
      exitCode: preflight.ok ? 0 : 1,
      output: preflight.output,
    };
    steps.push(pfStep);
    if (!preflight.ok) {
      return failResult(parts.slice(0, -1), steps.slice(0, -1), pfStep);
    }
  }

  // Verify-only (no build): still install before test/checks.
  if (runTestStep) {
    const installFail = await tryDepsInstall();
    if (installFail) return installFail;
  }

  if (
    runTestStep &&
    config.runTestsOnComplete !== false &&
    config.testCommand?.trim()
  ) {
    const tests = await runner(config.testCommand, cwd);
    const step: SuccessCheckStep = {
      name: "testCommand",
      command: config.testCommand,
      exitCode: tests.exitCode,
      output: tests.output,
    };
    parts.push(`testCommand (${config.testCommand}):\n${tests.output}`);
    if (tests.exitCode !== 0) {
      return failResult(
        parts.slice(0, -1),
        steps,
        step,
      );
    }
    steps.push(step);
  }

  if (runTestStep) {
    const cells = extractCheckCells(phaseDoc);
    const checkRegistry = createDefaultCheckRegistry(runner);
    const checkEnv = Object.keys(llmOverlay).length > 0
      ? mergeEnvOverlay(process.env, llmOverlay)
      : process.env;
    for (const cell of cells) {
      const label = checkCellLabel(cell);
      const result = await checkRegistry.run(cell, {
        cwd,
        env: checkEnv,
      });
      const step: SuccessCheckStep = {
        name: "automatedCheck",
        command: label,
        exitCode: result.exitCode,
        output: result.output,
      };
      parts.push(`automatedCheck (${label}):\n${result.output}`);
      if (result.exitCode !== 0) {
        return failResult(parts.slice(0, -1), steps, step);
      }
      if (automatedCheckReportedFailure(result.output)) {
        const soft: SuccessCheckStep = {
          name: "automatedCheck-soft-fail",
          command: label,
          exitCode: 1,
          output: [
            result.output,
            `Automated check printed FAIL (exit was ${result.exitCode}). Prefer \`|| exit 1\` instead of \`|| echo FAIL\`.`,
          ].join("\n"),
        };
        return failResult(parts.slice(0, -1), steps, soft);
      }
      steps.push(step);
    }
    if (cells.length > 0) {
      parts.push(`Automated Checks OK (${cells.length}).`);
    }

    if (config.verifyCommand?.trim()) {
      const verify = await runner(config.verifyCommand, cwd);
      const step: SuccessCheckStep = {
        name: "verifyCommand",
        command: config.verifyCommand,
        exitCode: verify.exitCode,
        output: verify.output,
      };
      parts.push(`verifyCommand:\n${verify.output}`);
      if (verify.exitCode !== 0) {
        return failResult(parts.slice(0, -1), steps, step);
      }
      steps.push(step);
    }

    const smokeMode = config.llmSmokeMode ?? "off";
    if (smokeMode === "off") {
      const msg =
        "LLM chat smoke skipped (llmSmokeMode=off). Tests use llmTestProfile overlay — not free-tier Ollama Cloud.";
      parts.push(msg);
      steps.push({ name: "ollama-chat-smoke", exitCode: 0, output: msg });
    } else if (smokeMode === "live") {
      const ollamaModels = verifyOllamaCloudModelIds(project.rootPath);
      parts.push(ollamaModels.output);
      if (!ollamaModels.ok) {
        return failResult(parts.slice(0, -1), steps, {
          name: "ollama-model-ids",
          exitCode: 1,
          output: ollamaModels.output,
        });
      }
      steps.push({
        name: "ollama-model-ids",
        exitCode: 0,
        output: ollamaModels.output,
      });

      const smoke = await verifyOllamaCloudChatAccess(project.rootPath, {
        label: "Ollama Cloud live smoke",
      });
      parts.push(smoke.output);
      if (!smoke.ok) {
        return failResult(parts.slice(0, -1), steps, {
          name: "ollama-chat-smoke",
          exitCode: 1,
          output: smoke.output,
        });
      }
      steps.push({
        name: "ollama-chat-smoke",
        exitCode: 0,
        output: smoke.output,
      });
    } else {
      // local smoke against resolved test env
      const smoke = await verifyOllamaCloudChatAccess(project.rootPath, {
        env: llmOverlay,
        label: "Ollama local test smoke",
      });
      parts.push(smoke.output);
      if (!smoke.ok) {
        return failResult(parts.slice(0, -1), steps, {
          name: "ollama-chat-smoke",
          exitCode: 1,
          output: smoke.output,
        });
      }
      steps.push({
        name: "ollama-chat-smoke",
        exitCode: 0,
        output: smoke.output,
      });
    }
  }

  if (isDatabasePhase(phaseDoc)) {
    const db = verifyDatabaseArtifacts(cwd);
    parts.push(db.output);
    if (!db.ok) {
      const dbMain = verifyDatabaseArtifacts(project.rootPath);
      parts.push(`main tree: ${dbMain.output}`);
      if (!dbMain.ok) {
        return failResult(parts.slice(0, -2), steps, {
          name: "database-artifacts",
          exitCode: 1,
          output: `${db.output}\nmain tree: ${dbMain.output}`,
        });
      }
    }
    steps.push({
      name: "database-artifacts",
      exitCode: 0,
      output: db.output,
    });
  }

  return {
    ok: true,
    output: parts.join("\n\n"),
    steps,
    summary: buildCheckSummary(true, steps),
  };
}

/** Bind the LLM verify-failure classifier to the classification role; null when unbound. */
function tryBindVerifyFailureClassifier(
  registry: LlmRegistry,
): ClassifyVerifyFailureFn | null {
  try {
    const { endpoint, modelId } =
      registry.resolveEndpointForRole("classification");
    return (input) =>
      classifyVerifyFailureViaLlm({
        endpoint,
        modelId,
        output: input.output,
        stepName: input.stepName,
        command: input.command,
        exitCode: input.exitCode,
        signals: input.signals,
        timeoutMs: 90_000,
      });
  } catch {
    return null;
  }
}

/**
 * LLM-first failure diagnosis: deterministic fast-path → LLM classifier →
 * regex-tree fallback. Falls back to the fully sync path when no
 * classification endpoint is bound.
 */
async function diagnoseVerifyFailureLlmFirst(
  registry: LlmRegistry,
  input: BuildFailureDiagnosisInput,
): Promise<FailureDiagnosis> {
  const classifyFn = tryBindVerifyFailureClassifier(registry);
  if (!classifyFn) return buildFailureDiagnosis(input);
  const diagnosis = await buildFailureDiagnosisAsync(input, { classifyFn });
  const tags = diagnosis.tags ?? [];
  if (tags.includes("llm-fallback")) {
    slog.warn("verify", "failure classification LLM failed; regex fallback", {
      class: diagnosis.class,
      fingerprint: diagnosis.fingerprint,
    });
  } else if (tags.includes("llm")) {
    slog.info("verify", "failure classified via llm", {
      class: diagnosis.class,
      confidence: diagnosis.confidence,
      fingerprint: diagnosis.fingerprint,
    });
  }
  return diagnosis;
}

/** Bind the LLM claim-proof judge to the classification role; null when unbound. */
function tryBindClaimProofJudge(registry: LlmRegistry): ClaimProofJudgeFn | null {
  try {
    const { endpoint, modelId } =
      registry.resolveEndpointForRole("classification");
    return (input) =>
      judgeClaimProofViaLlm({
        endpoint,
        modelId,
        claim: input.claim,
        issue: input.issue,
        phaseDocExcerpt: input.phaseDocExcerpt,
        timeoutMs: 90_000,
      });
  } catch {
    return null;
  }
}

/** Bind the LLM narration judge to the classification role; null when unbound. */
function tryBindNarrationJudge(registry: LlmRegistry): NarrationJudgeFn | null {
  try {
    const { endpoint, modelId } =
      registry.resolveEndpointForRole("classification");
    return (input) =>
      judgeNarrationOnlyViaLlm({
        endpoint,
        modelId,
        reply: input.reply,
        toolCallCount: input.toolCallCount,
        timeoutMs: 90_000,
      });
  } catch {
    return null;
  }
}

/**
 * Refine the claim-vs-proof subset of phase-doc gate issues with the LLM
 * judge: deterministic validators flag, the judge arbitrates. Issues not
 * produced by validateRuntimeClaimProofs pass through untouched; a missing
 * endpoint keeps the deterministic set (fail closed).
 */
async function refineClaimProofGateIssues(
  registry: LlmRegistry,
  phaseDoc: string,
  issues: string[],
  opts?: { projectRoot?: string; phaseId?: string },
): Promise<{ issues: string[]; warnings: string[] }> {
  const deterministic = validateRuntimeClaimProofs(phaseDoc, opts);
  if (deterministic.length === 0) return { issues, warnings: [] };
  const judgeFn = tryBindClaimProofJudge(registry);
  if (!judgeFn) return { issues, warnings: [] };
  const refined = await validateRuntimeClaimProofsAsync(phaseDoc, {
    ...opts,
    judgeFn,
  });
  const claimSet = new Set(deterministic);
  const passthrough = issues.filter((i) => !claimSet.has(i));
  if (refined.warnings.length > 0) {
    slog.info("verify", "claim-vs-proof gap rejected by llm judge", {
      phaseId: opts?.phaseId,
      warnings: refined.warnings,
    });
  }
  return { issues: [...passthrough, ...refined.issues], warnings: refined.warnings };
}

export class ChangeOrchestrator {
  constructor(private readonly ctx: OrchestratorContext) {}

  /**
   * Shared CROSS-PROJECT DEPS + DEPENDENCY INTENT prompt blocks for ask/agent/plan/research.
   */
  private async buildCrossProjectDependencyPrompt(opts: {
    projectRoot: string;
    message?: string;
    listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
    dataDir?: string;
    includeAskBriefNudge?: boolean;
  }): Promise<string> {
    const dataDir = opts.dataDir ?? this.ctx.dataDir;
    const catalog = buildCrossProjectCatalog({
      targetRoot: opts.projectRoot,
      dataDir,
      listProjects: opts.listProjects,
    });
    const catalogBlock = formatCrossProjectCatalogPromptBlock(catalog);
    const text = opts.message?.trim() ?? "";
    let intent: DependencyIntent | null = null;
    if (text) {
      try {
        const { endpoint, modelId } = this.ctx.registry.resolveEndpointForRole(
          "classification",
        );
        intent = await classifyDependencyIntentViaLlm({
          endpoint,
          modelId,
          message: text,
          timeoutMs: 90_000,
        });
      } catch (err) {
        slog.warn("deps", "dependency intent LLM failed; regex fallback", {
          error: err instanceof Error ? err.message : String(err),
        });
        intent = detectDependencyIntentFromText(text);
      }
    }
    const intentBlock = formatDependencyIntentPromptBlock(intent);
    const briefNudge = opts.includeAskBriefNudge
      ? formatAskDependencyTaskBriefNudge(intent)
      : "";
    return [catalogBlock, intentBlock, briefNudge].filter(Boolean).join("\n\n");
  }

  /**
   * Inventory → structured reverse-engineer → validate → optional repair → write BP + ROADMAP.
   */
  private async reverseEngineerBlueprint(input: {
    project: Project;
    reason: "open" | "reinit" | "validate_stale";
    operatorNotes?: string;
    forceRefresh?: boolean;
  }): Promise<{ doc: string; repaired: boolean; validationIssues: string[] }> {
    const { project, reason, operatorNotes, forceRefresh } = input;
    const inventory = buildProjectInventory(project.rootPath);
    slog.info("blueprint", "inventory ready", {
      projectId: project.id,
      reason,
      mustRead: inventory.mustReadPresent.length,
      apiRoutes: inventory.apiRoutes.length,
      dockerFiles: inventory.dockerFiles.length,
      treePaths: inventory.treePaths.length,
    });

    const basePrompt = `Reverse-engineer the EXISTING project at ${project.rootPath} into a complete living BLUEPRINT.md.

Reason: ${reason}${forceRefresh ? " (force refresh)" : ""}.
Ignore outdated mental models — ground every claim in files you read.

${operatorNotes?.trim()
  ? `## Operator notes / product intent (fold into Product summary; do not invent files)
${operatorNotes.trim()}
`
  : ""}
${blueprintContractPromptBlock()}

## Deterministic inventory (use this; still verify with tools)
${inventory.markdown}

## Required workflow
1. read_file each must-read path that exists (especially Docker/compose/SQL, package.json, schema, mastra, chat-tools, store).
2. Use grep_files / list_files for API routes, auth, tests, unused scaffolding.
3. Write the FULL structured BLUEPRINT (all required ## sections). Diagrams only inside Architecture.
4. End with BLUEPRINT_COMPLETE.

Output ONLY markdown starting with # Blueprint.`;

    const threadId = `${reason}-${project.id}-${Date.now()}`;
    let output = await runAgent(
      this.ctx.agents.blueprintAgent,
      basePrompt,
      project.id,
      threadId,
      { maxSteps: REVERSE_ENGINEER_MAX_STEPS },
    );

    let doc = extractMarkdownDocument(output);
    let validation = validateBlueprintDocument(doc);
    let repaired = false;

    if (!validation.ok) {
      slog.warn("blueprint", "validation failed; repair pass", {
        projectId: project.id,
        issues: validation.issues,
      });
      const repairPrompt = `Your previous BLUEPRINT failed the completeness check.

Issues:
${validation.issues.map((i) => `- ${i}`).join("\n")}
Missing headings: ${validation.missingHeadings.join(", ") || "(none)"}
Empty/thin sections: ${validation.emptySections.join(", ") || "(none)"}

Previous draft (fix it — do not leave thin sections):
${doc.slice(0, 12_000)}

Re-read must-read files from this inventory if needed:
Must-read present: ${inventory.mustReadPresent.join(", ")}
Docker files: ${inventory.dockerFiles.join(", ") || "(none)"}
SQL files: ${inventory.sqlFiles.join(", ") || "(none)"}
API routes: ${inventory.apiRoutes.join(", ") || "(none)"}

${blueprintContractPromptBlock()}

Output the FULL corrected BLUEPRINT starting with # Blueprint. End with BLUEPRINT_COMPLETE.`;

      output = await runAgent(
        this.ctx.agents.blueprintAgent,
        repairPrompt,
        project.id,
        `${threadId}-repair`,
        { maxSteps: REVERSE_ENGINEER_MAX_STEPS },
      );
      doc = extractMarkdownDocument(output);
      validation = validateBlueprintDocument(doc);
      repaired = true;
      if (!validation.ok) {
        slog.warn(
          "blueprint",
          "repair still incomplete; synthesizing structured blueprint from inventory",
          {
            projectId: project.id,
            issues: validation.issues,
          },
        );
        const synthesized = synthesizeBlueprintFromInventory({
          inventory,
          operatorNotes,
          llmDraft: doc,
        });
        writeBlueprintAndRoadmap(project.rootPath, synthesized);
        const after = validateBlueprintDocument(readBlueprint(project.rootPath));
        return {
          doc: readBlueprint(project.rootPath),
          repaired: true,
          validationIssues: after.ok ? [] : after.issues,
        };
      }
      slog.info("blueprint", "repair pass succeeded", { projectId: project.id });
    } else {
      slog.info("blueprint", "validation passed", { projectId: project.id });
    }

    writeBlueprintAndRoadmap(project.rootPath, output);
    return {
      doc: readBlueprint(project.rootPath),
      repaired,
      validationIssues: validation.ok ? [] : validation.issues,
    };
  }

  /**
   * First-access / open_project: greenfield (empty), reverse-engineer, or validate.
   */
  async openProject(input: {
    project: Project;
    forceRefresh?: boolean;
    intent?: string;
  }): Promise<OpenProjectResult> {
    const wallStart = Date.now();
    const { project, forceRefresh } = input;
    const intent = input.intent?.trim() ?? "";
    ensureSlopcontrolDir(project.rootPath);
    const harness = scaffoldLlmTestHarness(project.rootPath);
    if (harness.written.length > 0) {
      slog.info("open_project", "scaffolded LLM test harness", {
        projectId: project.id,
        written: harness.written,
      });
    }

    const empty = isProjectEmpty(project.rootPath);
    const existing = readBlueprint(project.rootPath);

    slog.info("open_project", "start", {
      projectId: project.id,
      rootPath: project.rootPath,
      empty,
      forceRefresh: Boolean(forceRefresh),
      hasBlueprint: Boolean(existing.trim()),
      hasIntent: Boolean(intent),
    });

    const withDuration = (
      result: OpenProjectResult,
    ): OpenProjectResult => {
      const durationMs = Date.now() - wallStart;
      slog.info("open_project", "done", {
        projectId: project.id,
        blueprintStatus: result.blueprintStatus,
        mode: result.mode,
        durationMs,
        duration: formatDurationMs(durationMs),
      });
      return {
        ...result,
        durationMs,
        duration: formatDurationMs(durationMs),
      };
    };

    // --- Greenfield: empty tree ---
    if (empty) {
      if (!intent && !forceRefresh) {
        return withDuration(
          emptyOpenResult(
            "needs_intent",
            "greenfield",
            "Project tree is empty. Provide intent (what to build) to create a greenfield BLUEPRINT.md.",
          ),
        );
      }
      if (!intent && forceRefresh && !existing.trim()) {
        return withDuration(
          emptyOpenResult(
            "needs_intent",
            "greenfield",
            "Force refresh on an empty project still requires intent.",
          ),
        );
      }

      ensureGitInitialized(project.rootPath);

      let archivePath: string | null = null;
      if (existing.trim()) {
        archivePath = archiveBlueprint(project.rootPath);
      }

      const prompt = `GREENFIELD open for an EMPTY project at ${project.rootPath}.

Product intent:
${intent || existing.slice(0, 500)}

There is no codebase to reverse-engineer. Design a living BLUEPRINT.md from the intent.

${blueprintContractPromptBlock()}

For greenfield, Phase 01 in ## Proposed Roadmap must be 01-scaffold (bootstrap repo, tooling, hello path).
Output ONLY markdown starting with # Blueprint. End with BLUEPRINT_COMPLETE.`;

      const output = await runAgent(
        this.ctx.agents.blueprintAgent,
        prompt,
        project.id,
        `greenfield-${project.id}-${Date.now()}`,
        { maxSteps: REVERSE_ENGINEER_MAX_STEPS },
      );

      writeBlueprintAndRoadmap(project.rootPath, output);
      if (!readRoadmap(project.rootPath).includes("01-scaffold")) {
        writeRoadmap(
          project.rootPath,
          `# Roadmap\n\n| Phase | Title | Status | Depends on |\n|-------|-------|--------|------------|\n| 01-scaffold | Scaffold project per BLUEPRINT | planned | |\n`,
        );
      }

      return withDuration({
        blueprintStatus: existing.trim() ? "updated" : "created",
        mode: "greenfield",
        archivePath,
        blueprintPreview: readBlueprint(project.rootPath).slice(0, 2000),
        roadmapPreview: readRoadmap(project.rootPath).slice(0, 1000),
        suggestedNextChange: "Scaffold the project per BLUEPRINT (01-scaffold)",
        message: "Greenfield blueprint created from intent.",
      });
    }

    // --- Existing codebase ---
    if (!existing.trim() || forceRefresh) {
      let archivePath: string | null = null;
      if (existing.trim()) {
        archivePath = archiveBlueprint(project.rootPath);
      }

      const { validationIssues } = await this.reverseEngineerBlueprint({
        project,
        reason: "open",
        operatorNotes: intent || undefined,
        forceRefresh,
      });

      return withDuration({
        blueprintStatus: existing.trim() ? "updated" : "created",
        mode: "existing",
        archivePath,
        blueprintPreview: readBlueprint(project.rootPath).slice(0, 2000),
        roadmapPreview: readRoadmap(project.rootPath).slice(0, 1000),
        message: validationIssues.length
          ? `Blueprint written with remaining gaps: ${validationIssues.join("; ")}`
          : undefined,
      });
    }

    // Validate existing blueprint against codebase + contract
    const existingValidation = validateBlueprintDocument(existing);
    const inventory = buildProjectInventory(project.rootPath);
    const prompt = `Validate this BLUEPRINT.md against the real codebase at ${project.rootPath}.

Existing BLUEPRINT.md:
${existing}

Contract check on existing doc: ${existingValidation.ok ? "PASS" : `FAIL — ${existingValidation.issues.join("; ")}`}

Deterministic inventory (partial):
- Must-read: ${inventory.mustReadPresent.join(", ")}
- Docker: ${inventory.dockerFiles.join(", ") || "(none)"}
- API routes: ${inventory.apiRoutes.slice(0, 30).join(", ") || "(none)"}

If the blueprint accurately covers architecture, stack, schema, infra/Docker, modules, skills/workflows, auth reality, and roadmap — AND passes the required sections — reply with FRESH on its own line then BLUEPRINT_COMPLETE (you may repeat the blueprint).
If it is outdated, incomplete, diagram-only, or missing required sections, reply with STALE on its own line, then the full corrected BLUEPRINT.md satisfying the contract, then BLUEPRINT_COMPLETE.

${blueprintContractPromptBlock()}`;

    const output = await runAgent(
      this.ctx.agents.blueprintAgent,
      prompt,
      project.id,
      `validate-${project.id}-${Date.now()}`,
      { maxSteps: REVERSE_ENGINEER_MAX_STEPS },
    );

    const isStale =
      !existingValidation.ok ||
      /^\s*STALE\s*$/m.test(output) ||
      (/\bSTALE\b/.test(output) && !/^\s*FRESH\s*$/m.test(output));

    if (isStale) {
      const archivePath = archiveBlueprint(project.rootPath);
      // If agent returned a full blueprint, prefer it; else run full reverse-engineer
      const candidate = extractMarkdownDocument(output);
      const candidateOk = validateBlueprintDocument(candidate).ok;
      if (candidateOk || candidate.length > existing.length) {
        writeBlueprintAndRoadmap(project.rootPath, output);
      } else {
        await this.reverseEngineerBlueprint({
          project,
          reason: "validate_stale",
          operatorNotes: intent || undefined,
        });
      }
      return withDuration({
        blueprintStatus: "updated",
        mode: "existing",
        archivePath,
        blueprintPreview: readBlueprint(project.rootPath).slice(0, 2000),
        roadmapPreview: readRoadmap(project.rootPath).slice(0, 1000),
      });
    }

    applyProposedRoadmap(project.rootPath, existing);
    return withDuration({
      blueprintStatus: "fresh",
      mode: "existing",
      archivePath: null,
      blueprintPreview: existing.slice(0, 2000),
      roadmapPreview: readRoadmap(project.rootPath).slice(0, 1000),
    });
  }

  /**
   * Force reverse-engineer BLUEPRINT.md from source and reset planning to phase zero
   * (archive prior blueprint/phases/runs; next change will be 01-…).
   */
  async reinitProject(input: {
    project: Project;
    notes?: string;
  }): Promise<
    OpenProjectResult & {
      reset: ReturnType<typeof resetProjectToPhaseZero>;
    }
  > {
    const wallStart = Date.now();
    const { project, notes } = input;

    if (isProjectEmpty(project.rootPath)) {
      throw new Error(
        "Cannot reinit an empty project from source. Use open_project with intent (greenfield) instead.",
      );
    }

    slog.info("reinit_project", "start", {
      projectId: project.id,
      rootPath: project.rootPath,
      hasNotes: Boolean(notes?.trim()),
    });

    ensureSlopcontrolDir(project.rootPath);
    const reset = resetProjectToPhaseZero(project.rootPath);
    slog.info("reinit_project", "archived prior planning", {
      projectId: project.id,
      archiveRoot: reset.archiveRoot,
      archivedBlueprint: reset.archivedBlueprint,
      archivedPhaseDirs: reset.archivedPhaseDirs,
      archivedRunDirs: reset.archivedRunDirs,
    });

    const { repaired, validationIssues } = await this.reverseEngineerBlueprint({
      project,
      reason: "reinit",
      operatorNotes: notes,
      forceRefresh: true,
    });

    const durationMs = Date.now() - wallStart;
    slog.info("reinit_project", "done", {
      projectId: project.id,
      durationMs,
      duration: formatDurationMs(durationMs),
      archiveRoot: reset.archiveRoot,
      repaired,
      validationIssues,
    });
    return {
      blueprintStatus: "updated",
      mode: "existing",
      archivePath: reset.archiveRoot,
      blueprintPreview: readBlueprint(project.rootPath).slice(0, 2000),
      roadmapPreview: readRoadmap(project.rootPath).slice(0, 1000),
      message: [
        `Project reinitialized. Archived prior planning to ${reset.archiveRoot}. Development reset to phase zero.`,
        repaired ? "Repair pass was applied after contract validation." : null,
        validationIssues.length
          ? `Remaining gaps: ${validationIssues.join("; ")}`
          : null,
      ]
        .filter(Boolean)
        .join(" "),
      suggestedNextChange:
        "Start the first phase from the new ROADMAP (will be 01-…)",
      durationMs,
      duration: formatDurationMs(durationMs),
      reset,
    };
  }

  /**
   * One turn of a project-scoped ask conversation (exploratory chat).
   * Does not create a phase — use promote_ask / start_research for that.
   * Streams tool progress via onProgress when provided.
   */
  async askTurn(input: AskTurnInput): Promise<{ reply: string }> {
    const { project, askId, message, history } = input;
    ensureSlopcontrolDir(project.rootPath);
    const blueprint = readBlueprint(project.rootPath);
    const roadmap = readRoadmap(project.rootPath);
    const historyBlock =
      history.length === 0
        ? "(no prior turns)"
        : history
            .slice(-12)
            .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2_000)}`)
            .join("\n\n");

    const depPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message,
      listProjects: input.listProjects,
      dataDir: input.dataDir,
      includeAskBriefNudge: true,
    });

    const prompt = `Project ask conversation (askId=${askId}).
Answer the operator using the codebase and planning docs. When shaping a change, include ## Task brief.

BLUEPRINT (excerpt):
${clipPromptSection("BLUEPRINT.md", blueprint, 6_000)}

ROADMAP (excerpt):
${clipPromptSection("ROADMAP.md", roadmap, 3_000)}
${depPack ? `\n${depPack}\n` : ""}
Recent conversation:
${historyBlock}

Operator message:
${message.trim()}`;

    const { reply } = await runAskAgentStream(
      this.ctx.agents.askAgent,
      prompt,
      project.id,
      `ask-${askId}`,
      {
        maxSteps: 12,
        timeoutMs: 240_000,
        onProgress: input.onProgress,
        abortSignal: input.abortSignal,
        narrationJudgeFn: tryBindNarrationJudge(this.ctx.registry),
      },
    );
    return { reply: reply.trim() || "(empty reply)" };
  }

  /**
   * Generate or revise a self-contained design-loop mock HTML (no product writes).
   */
  async designLoopGenerate(input: DesignLoopGenerateInput): Promise<{
    html: string;
    notes: string;
    usedScaffold: boolean;
    /** Operator-facing chat reply (not the HTML dump). */
    reply: string;
  }> {
    const { project, loopId, brief, message, previousHtml, version } = input;
    ensureSlopcontrolDir(project.rootPath);
    const isContinue = version > 1 || Boolean(previousHtml?.trim());
    const desc = [brief, message ?? ""].filter(Boolean).join("\n");
    const continueText = message?.trim() || desc;
    const finishDesign = (opts: {
      html: string;
      notes: string;
      usedScaffold: boolean;
      reply?: string;
    }) => ({
      html: opts.html,
      notes: opts.notes,
      usedScaffold: opts.usedScaffold,
      reply:
        (opts.reply ?? opts.notes).trim() ||
        `Design loop v${version} updated.`,
    });

    // Primary classification: LLM → structured ContinueIntent (start + continue).
    // Regex fallback only when registry/LLM unavailable.
    const classifyText = isContinue ? continueText : brief || desc;
    let continueIntent: ContinueIntent = CONTINUE_INTENT_DEFAULT;
    {
      const fallbackOnce = fallbackContinueIntentFromText(classifyText);
      const startFallback: ContinueIntent =
        !fallbackOnce.adoptTheme &&
        !fallbackOnce.reuseProjectDesign &&
        fallbackOnce.scope === "sections" &&
        fallbackOnce.targets.length === 0
          ? {
              ...CONTINUE_INTENT_DEFAULT,
              scope: "full_revise",
              preserveChrome: false,
            }
          : { ...fallbackOnce, preserveChrome: false };
      try {
        const { endpoint, modelId } = this.ctx.registry.resolveEndpointForRole(
          "classification",
        );
        const classifyOnce = () =>
          classifyContinueIntentViaLlm({
            endpoint,
            modelId,
            message: classifyText,
            brief: isContinue ? brief : undefined,
            isStart: !isContinue,
            timeoutMs: 90_000,
          });
        try {
          continueIntent = await classifyOnce();
        } catch (firstErr) {
          const msg =
            firstErr instanceof Error ? firstErr.message : String(firstErr);
          if (/abort|timed out/i.test(msg)) {
            slog.warn("design-loop", "continue intent LLM aborted; retrying once", {
              loopId,
              isStart: !isContinue,
              error: msg,
            });
            continueIntent = await classifyOnce();
          } else {
            throw firstErr;
          }
        }
      } catch (err) {
        slog.warn("design-loop", "continue intent LLM failed; regex fallback", {
          loopId,
          isStart: !isContinue,
          error: err instanceof Error ? err.message : String(err),
        });
        continueIntent = isContinue ? fallbackOnce : startFallback;
      }
    }

    // Conceptual model scope from structured intent (no chat regex classify).
    {
      const metaNow = readDesignLoopMeta(project.rootPath, loopId);
      if (metaNow) {
        const priorScope = getDesignLoopScope(metaNow);
        const nextScope = isContinue
          ? applyContinueIntentToScope(
              priorScope,
              continueIntent,
              message?.trim() || desc,
            )
          : continueIntent.designScope?.kind ||
              continueIntent.designScope?.focus
            ? applyContinueIntentToScope(
                defaultProductScope("start"),
                continueIntent,
                brief || desc,
              )
            : defaultProductScope("start");
        if (
          nextScope.kind !== priorScope.kind ||
          nextScope.focus !== priorScope.focus ||
          !metaNow.scope
        ) {
          writeDesignLoopMeta(
            project.rootPath,
            withUpdatedScope(metaNow, nextScope),
          );
          slog.info("design-loop", "conceptual model scope updated", {
            loopId,
            kind: nextScope.kind,
            focus: nextScope.focus,
            preserve: nextScope.preserve,
          });
        }
      }
    }

    // Invent/replace: clear prior logo pin so generate_image + force-pin cannot
    // restore the superseded mark. Skip when asset recipe edits the existing pin.
    if (
      isContinue &&
      continueIntent.inventLogo &&
      !(continueIntent.assetOps?.length > 0)
    ) {
      try {
        unpinDesignLoopSelection({
          projectRoot: project.rootPath,
          loopId,
          slot: "logo",
        });
        slog.info("design-loop", "unpinned logo for invent continue", {
          loopId,
        });
      } catch {
        /* best-effort */
      }
    } else if (message?.trim()) {
      const pinnedByChat = maybeAutoPinFromOperatorMessage({
        projectRoot: project.rootPath,
        loopId,
        message,
      });
      if (pinnedByChat) {
        const logo = getDesignLoopSelections(pinnedByChat).find(
          (s) => s.slot === "logo",
        );
        slog.info("design-loop", "chat pinned selection", {
          loopId,
          slot: logo?.slot ?? "logo",
          asset: logo?.asset,
          conceptId: logo?.conceptId,
        });
      }
    }
    if (
      isContinue &&
      previousHtml?.trim() &&
      !continueIntent.inventLogo
    ) {
      maybeAutoPinDominantLogoFromMock({
        projectRoot: project.rootPath,
        loopId,
        previousHtml,
      });
    }
    try {
      refreshDesignLoopConcepts({
        projectRoot: project.rootPath,
        loopId,
        version: Math.max(1, version - (isContinue ? 1 : 0)),
      });
    } catch {
      /* catalog best-effort */
    }

    let pinnedLogo =
      getDesignLoopSelections(
        readDesignLoopMeta(project.rootPath, loopId),
      ).find((s) => s.slot === "logo")?.asset ?? null;

    // Live site inventory (nav/tokens/routes/assets) — authoritative for mocks.
    let siteInventory = buildLiveSiteInventory(project.rootPath);
    try {
      siteInventory = writeLiveSiteInventory(
        project.rootPath,
        loopId,
        siteInventory,
      );
    } catch {
      /* best-effort persist */
    }
    // siteInventoryBlock rebuilt after share import (authority depends on SHARED).
    let siteInventoryBlock = formatLiveSiteInventoryPromptBlock(siteInventory);

    // Brand assets ALWAYS carry: pinned assets from the latest accepted/
    // implemented loop seed every fresh loop (strict — pins only, accepted
    // loops only). Independent of the reuseProjectDesign intent gate.
    let brandAssetsImport = readProjectBrandAssetsImport(
      project.rootPath,
      loopId,
    );
    if (!brandAssetsImport) {
      try {
        const brand = pickProjectBrandAssets(project.rootPath, {
          excludeLoopId: loopId,
        });
        if (brand) {
          brandAssetsImport = importProjectBrandAssetsIntoLoop({
            projectRoot: project.rootPath,
            loopId,
            brand,
          });
          slog.info("design-loop", "carried pinned brand assets", {
            loopId,
            sourceLoopId: brand.sourceLoopId,
            assets: brand.assets,
          });
        }
      } catch (err) {
        slog.warn("design-loop", "brand asset carry failed", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const brandAssetsBlock = formatBrandAssetsPromptBlock(brandAssetsImport);

    // Deterministic icon-pack derive + patch before any agent rewrite.
    let workingPreviousHtml = previousHtml;
    // Seed same-project prior design when operator asks to reuse current theming.
    // Sibling SHARED_FROM stays separate; PRIOR_DESIGN.json is the intentional self path.
    let priorDesignImport = readProjectPriorDesignImport(project.rootPath, loopId);
    const wantsPriorDesign = continueIntent.reuseProjectDesign;
    if (wantsPriorDesign && !priorDesignImport) {
      try {
        const prior = pickProjectPriorDesign(project.rootPath, {
          excludeLoopId: loopId,
        });
        if (prior) {
          priorDesignImport = importProjectPriorDesignIntoLoop({
            projectRoot: project.rootPath,
            loopId,
            prior,
          });
          slog.info("design-loop", "seeded prior project design", {
            loopId,
            kind: prior.kind,
            sourceLoopId: prior.loopId,
            sourcePhaseId: prior.phaseId,
            hasMock: Boolean(prior.mockHtml?.trim()),
            tokenChars: prior.tokensCss.length,
          });
        } else {
          slog.warn("design-loop", "reuseProjectDesign but no prior design found", {
            loopId,
          });
        }
      } catch (err) {
        slog.warn("design-loop", "prior project design seed failed", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (
      !workingPreviousHtml?.trim() &&
      priorDesignImport?.mockHtml?.trim()
    ) {
      workingPreviousHtml = priorDesignImport.mockHtml;
    }
    let assetPatchNotes = "";
    // LLM-first: run only assetOps from classified intent (LLM success or
    // full regex fallback after classify failure). Never re-infer from chat.
    const assetOps =
      !continueIntent.inventLogo && continueIntent.assetOps?.length
        ? continueIntent.assetOps
        : [];
    if (isContinue && assetOps.length && workingPreviousHtml?.trim()) {
      let primaryLogo = pinnedLogo ?? undefined;
      for (const op of assetOps) {
        try {
          if (op === "make_transparent") {
            const source =
              primaryLogo ||
              dominantMockLogoAsset(workingPreviousHtml) ||
              undefined;
            if (!source) {
              slog.warn("design-loop", "make_transparent skipped; no logo asset", {
                loopId,
              });
              continue;
            }
            const result = await makeTransparentDesignAsset({
              projectRoot: project.rootPath,
              loopId,
              sourceFilename: source,
            });
            const outName = basename(result.relativePath);
            primaryLogo = outName;
            pinDesignLoopLogoAsset({
              projectRoot: project.rootPath,
              loopId,
              asset: outName,
              label: outName.replace(/\.[^.]+$/, ""),
            });
            workingPreviousHtml = patchMockForAssetContinue({
              previousHtml: workingPreviousHtml,
              loopId,
              primaryLogoAsset: outName,
            });
            const fallbackNote = result.usedCircularFallback
              ? " (circular fallback)"
              : "";
            assetPatchNotes = [
              assetPatchNotes,
              `Alpha ${outName} from ${result.sourceFilename}${fallbackNote}.`,
            ]
              .filter(Boolean)
              .join(" ");
            slog.info("design-loop", "asset recipe make_transparent", {
              loopId,
              source: result.sourceFilename,
              out: outName,
              usedCircularFallback: result.usedCircularFallback ?? false,
              keyRgb: result.keyRgb,
              threshold: result.threshold,
            });
          } else if (op === "circular_mask") {
            const source =
              primaryLogo ||
              dominantMockLogoAsset(workingPreviousHtml) ||
              undefined;
            if (!source) {
              slog.warn("design-loop", "circular_mask skipped; no logo asset", {
                loopId,
              });
              continue;
            }
            const result = await circularMaskDesignAsset({
              projectRoot: project.rootPath,
              loopId,
              sourceFilename: source,
            });
            const outName = basename(result.relativePath);
            primaryLogo = outName;
            pinDesignLoopLogoAsset({
              projectRoot: project.rootPath,
              loopId,
              asset: outName,
              label: outName.replace(/\.[^.]+$/, ""),
            });
            workingPreviousHtml = patchMockForAssetContinue({
              previousHtml: workingPreviousHtml,
              loopId,
              primaryLogoAsset: outName,
            });
            assetPatchNotes = [
              assetPatchNotes,
              `Circular cut-out ${outName} from ${result.sourceFilename}.`,
            ]
              .filter(Boolean)
              .join(" ");
            slog.info("design-loop", "asset recipe circular_mask", {
              loopId,
              source: result.sourceFilename,
              out: outName,
            });
          } else if (op === "derive_icon_pack") {
            const pack = await deriveIconPackFromAsset({
              projectRoot: project.rootPath,
              loopId,
              preferredFilename: primaryLogo ?? undefined,
              prefix: `icon-v${version}`,
            });
            primaryLogo = pack.sourceFilename || primaryLogo;
            workingPreviousHtml = patchMockForAssetContinue({
              previousHtml: workingPreviousHtml,
              loopId,
              primaryLogoAsset: pack.sourceFilename || primaryLogo,
              iconPackFiles: pack.files,
            });
            const redirectNote = pack.redirectedFrom
              ? ` (source redirected from ${pack.redirectedFrom} → ${pack.sourceFilename})`
              : "";
            assetPatchNotes = [
              assetPatchNotes,
              `Icon pack ${pack.files.length} sizes from ${pack.sourceFilename}${redirectNote}.`,
            ]
              .filter(Boolean)
              .join(" ");
            slog.info("design-loop", "asset recipe derive_icon_pack", {
              loopId,
              source: pack.sourceFilename,
              sizes: pack.files.length,
            });
          }
        } catch (err) {
          slog.warn("design-loop", `asset recipe ${op} failed; continuing`, {
            loopId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Refresh pin after recipe for later prompt / force-pin.
      pinnedLogo =
        getDesignLoopSelections(
          readDesignLoopMeta(project.rootPath, loopId),
        ).find((s) => s.slot === "logo")?.asset ?? pinnedLogo;
    }

    // Deterministic nav align from live inventory (no agent rewrite).
    if (
      isContinue &&
      continueIntent.navAlign &&
      workingPreviousHtml?.trim() &&
      siteInventory.nav.length > 0
    ) {
      workingPreviousHtml = patchMockNavFromInventory(
        workingPreviousHtml,
        siteInventory.nav,
      );
      const navNote = `Nav aligned to live site: ${siteInventory.nav
        .map((n) => n.label)
        .join(", ")}.`;
      assetPatchNotes = [assetPatchNotes, navNote].filter(Boolean).join(" ");
      const navHtml = pinnedLogo
        ? patchMockForAssetContinue({
            previousHtml: workingPreviousHtml,
            loopId,
            primaryLogoAsset: pinnedLogo,
          })
        : workingPreviousHtml;
      return finishDesign({
        html: navHtml,
        notes: `${assetPatchNotes} Prior layout/shell preserved.`,
        usedScaffold: false,
      });
    }

    // Skip agent rewrite when asset-only OR preserve-only (no nav-align left to do).
    if (
      isContinue &&
      workingPreviousHtml?.trim() &&
      (continueIntent.scope === "assets_only" ||
        (continueIntent.preserveChrome &&
          continueIntent.wantsAssetEdit &&
          (continueIntent.assetOps?.length > 0 ||
            /\bicon\s*pack|favicon|browser\s*pack|alpha|transparent\b/i.test(
              message ?? desc,
            )) &&
          !continueIntent.navAlign))
    ) {
      const assetHtml = pinnedLogo
        ? patchMockForAssetContinue({
            previousHtml: workingPreviousHtml,
            loopId,
            primaryLogoAsset: pinnedLogo,
          })
        : workingPreviousHtml;
      return finishDesign({
        html: assetHtml,
        notes: `Asset-only continue: ${assetPatchNotes || "prior mock preserved"}. Prior layout/nav/shell preserved.`,
        usedScaffold: false,
      });
    }

    const wantThemeExcerpts =
      !isContinue || descriptionMentionsBrandTheming(desc);
    // Project brand tokens/logos/landing are covered by LIVE SITE inventory.
    const siblingPack = buildSiblingBrandRefPack({
      projectRoot: project.rootPath,
      description: desc,
      includeTokenExcerpts: wantThemeExcerpts,
    });
    const blueprint =
      isContinue ? "" : readBlueprint(project.rootPath);
    const reviseBlock = workingPreviousHtml?.trim()
      ? formatDesignLoopReviseBlock({
          projectRoot: project.rootPath,
          projectId: project.id,
          loopId,
          previousHtml: workingPreviousHtml,
          maxHtmlChars: 16_000,
        })
      : "(no previous mock — create v1)";
    const selectionsBlock = formatDesignLoopSelectionsPromptBlock({
      projectRoot: project.rootPath,
      loopId,
      version: previousHtml ? Math.max(1, version - 1) : version,
      inventLogo: continueIntent.inventLogo,
    });
    const needsMedia = designLoopNeedsMediaTools(continueIntent);
    const needsEdit =
      continueIntent.wantsAssetEdit && !continueIntent.inventLogo;
    const modeBlock =
      isContinue ||
      continueIntent.reuseProjectDesign ||
      continueIntent.adoptTheme ||
      continueIntent.adoptChrome ||
      continueIntent.inventLogo
        ? formatContinueIntentPromptBlock(continueIntent)
        : "";

    // Sibling share: gated by structured adoptTheme / adoptChrome / shareFrom / absolute path.
    // Resolver may match registered names; intent is never inferred from palette alone.
    const shareText = (isContinue ? message : brief || desc)?.trim() ?? "";
    let siblingShareImported = false;
    if (shareText && !continueIntent.reuseProjectDesign) {
      const mentionsPath = extractSiblingProjectPaths(shareText).length > 0;
      const wantsSharedDesign =
        continueIntent.adoptTheme ||
        continueIntent.adoptChrome ||
        Boolean(continueIntent.shareFrom?.trim()) ||
        mentionsPath;
      if (wantsSharedDesign) {
        const hint = continueIntent.shareFrom?.trim() ?? "";
        let detected =
          hint.length > 0
            ? resolveDesignShareSource({
                targetRoot: project.rootPath,
                fromName: hint.startsWith("/") ? undefined : hint,
                fromRootPath: hint.startsWith("/") ? hint : undefined,
                listProjects: input.listProjects,
                findProjectByRootPath: input.findProjectByRootPath,
              })
            : null;
        if (!detected) {
          detected = detectShareSourceFromText({
            targetRoot: project.rootPath,
            text: hint || shareText,
            listProjects: input.listProjects,
            findProjectByRootPath: input.findProjectByRootPath,
          });
        }
        if (detected) {
          try {
            const share = readShareableDesign(detected);
            if (share) {
              importDesignShareIntoLoop({
                targetRoot: project.rootPath,
                loopId,
                share,
              });
              siblingShareImported = true;
              slog.info("design-loop", "auto-imported shared design from chat", {
                loopId,
                from: detected.name ?? detected.rootPath,
              });
            } else {
              slog.warn("design-loop", "chat named a source with nothing shareable", {
                loopId,
                from: detected.name ?? detected.rootPath,
              });
            }
          } catch (err) {
            slog.warn("design-loop", "auto design-share import failed", {
              loopId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (
          continueIntent.adoptTheme ||
          continueIntent.adoptChrome ||
          mentionsPath
        ) {
          slog.warn("design-loop", "adopt-theme intent but no resolvable source in message", {
            loopId,
            shareFrom: hint || undefined,
          });
        }
      }
    }

    // Cross-project SHARED DESIGN outranks LIVE SITE; PRIOR DESIGN same for same-project reuse.
    const sharedImport = readSharedDesignImport(project.rootPath, loopId);
    const sharedDesignBlock = formatSharedDesignPromptBlock(sharedImport);
    // When sibling was just imported, prefer SHARED; otherwise expose PRIOR DESIGN.
    const priorDesignBlock =
      siblingShareImported || sharedDesignBlock
        ? ""
        : formatProjectPriorDesignPromptBlock(priorDesignImport);
    const sharedDesignActive =
      Boolean(sharedDesignBlock) ||
      Boolean(priorDesignBlock) ||
      continueIntent.adoptTheme ||
      continueIntent.adoptChrome ||
      continueIntent.reuseProjectDesign;
    siteInventoryBlock = formatLiveSiteInventoryPromptBlock(siteInventory, 6_500, {
      sharedDesignActive,
    });
    if (sharedDesignBlock) {
      slog.info("design-loop", "shared design import active", {
        loopId,
        from: sharedImport?.source.name ?? sharedImport?.source.rootPath,
      });
    } else if (priorDesignBlock) {
      slog.info("design-loop", "prior project design active", {
        loopId,
        kind: priorDesignImport?.kind,
        sourceLoopId: priorDesignImport?.sourceLoopId,
      });
    }

    // Shared design elements: DependencyIntent (multi + import-all), not agent MCP.
    // adoptChrome also ensures theme-toggle from shareFrom when resolvable.
    {
      const elText = (isContinue ? message : brief || desc)?.trim() ?? "";
      if (elText || continueIntent.adoptChrome) {
        try {
          let depIntent: DependencyIntent | null = null;
          if (elText) {
            try {
              const { endpoint, modelId } =
                this.ctx.registry.resolveEndpointForRole("classification");
              depIntent = await classifyDependencyIntentViaLlm({
                endpoint,
                modelId,
                message: elText,
                timeoutMs: 90_000,
              });
            } catch {
              depIntent = detectDependencyIntentFromText(elText);
            }
          }
          const catalog = buildCrossProjectCatalog({
            targetRoot: project.rootPath,
            dataDir: input.dataDir ?? this.ctx.dataDir,
            listProjects: input.listProjects,
          });
          const toImport = depIntent
            ? listElementsToAutoImport({
                intent: depIntent,
                catalog,
                message: elText,
              })
            : [];
          if (
            continueIntent.adoptChrome &&
            !toImport.some((e) => e.id === "theme-toggle")
          ) {
            toImport.push({
              id: "theme-toggle",
              fromProject:
                continueIntent.shareFrom?.trim() ||
                depIntent?.importAllElementsFrom ||
                undefined,
            });
          }
          if (
            continueIntent.adoptChrome &&
            !toImport.some((e) => e.id === "menubar") &&
            (depIntent?.importAllElementsFrom ||
              continueIntent.shareFrom?.trim())
          ) {
            toImport.push({
              id: "menubar",
              fromProject:
                continueIntent.shareFrom?.trim() ||
                depIntent?.importAllElementsFrom ||
                undefined,
            });
          }
          for (const item of toImport) {
            const from = item.fromProject?.trim();
            const elBundle = resolveDesignElement({
              elementId: item.id,
              targetRoot: project.rootPath,
              dataDir: input.dataDir ?? this.ctx.dataDir,
              listProjects: input.listProjects,
              origin: from
                ? from.toLowerCase() === "registry"
                  ? "registry"
                  : `project:${from}`
                : undefined,
            });
            if (elBundle) {
              importDesignElementIntoLoop({
                targetRoot: project.rootPath,
                loopId,
                bundle: elBundle,
                origin: elBundle.meta.sourceRootPath ? "project" : "registry",
                sourceName: elBundle.meta.sourceRootPath
                  ? basename(elBundle.meta.sourceRootPath)
                  : from || "registry",
              });
              slog.info("design-loop", "auto-imported shared element from chat", {
                loopId,
                elementId: elBundle.meta.id,
                version: elBundle.meta.version,
                reason: depIntent?.importAllElementsFrom
                  ? "import_all"
                  : depIntent
                    ? "dependency_intent"
                    : "adopt_chrome",
              });
            } else {
              slog.warn(
                "design-loop",
                "shared element not found in sibling/registry (extract/publish first)",
                {
                  loopId,
                  elementId: item.id,
                  from: from || undefined,
                },
              );
            }
          }
          // Landing import-all: drop stale dashboard pins so apply/judge aren't poisoned.
          {
            const priorHtmlForDash =
              workingPreviousHtml ?? previousHtml ?? "";
            const priorHasDashboardEarly =
              /\b(?:dashboard-layout|dashboard-shell|dashboard-sidebar)\b/i.test(
                priorHtmlForDash,
              );
            if (
              depIntent?.importAllElementsFrom &&
              !priorHasDashboardEarly &&
              !/\bdashboard\b/i.test(elText)
            ) {
              const kept = unpinDesignElementsFromLoop({
                projectRoot: project.rootPath,
                loopId,
                elementIds: ["dashboard-shell", "dashboard-sidebar"],
              });
              slog.info(
                "design-loop",
                "pruned stale dashboard element pins for landing import-all",
                {
                  loopId,
                  remaining: kept.map((e) => e.id),
                },
              );
            }
          }
        } catch (err) {
          slog.warn("design-loop", "element auto-import failed", {
            loopId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const loopElements = readDesignLoopElements(project.rootPath, loopId);
    // Prompt: prefer landing chrome snippets; omit dashboard bodies unless present in prior mock.
    const priorHasDashboard = /\b(?:dashboard-layout|dashboard-shell|dashboard-sidebar)\b/i.test(
      workingPreviousHtml ?? previousHtml ?? "",
    );
    const elementsForPrompt = priorHasDashboard
      ? loopElements
      : loopElements.filter((e) => !/^dashboard-/i.test(e.id));
    const elementsBlock = formatDesignElementsPromptBlock(elementsForPrompt, {
      projectRoot: project.rootPath,
      loopId,
    });

    const inventCount = continueIntent.inventLogo
      ? Math.max(1, Math.min(12, continueIntent.inventLogoCount ?? 1))
      : 1;
    const htmlReturnRule =
      continueIntent.scope === "assets_only" || continueIntent.scope === "nav_align"
        ? "Prefer MOCK_ASSETS_ONLY (no full HTML). If you return HTML, keep prior mock; only asset src / icon-pack / LIVE SITE nav updates."
        : continueIntent.inventLogo && inventCount > 1
          ? `Return a complete HTML document based on the prior mock — call generate_image (inventNew=true) exactly ${inventCount} times with distinct styles/filenames; embed a logo-card / Concept grid of all ${inventCount} variants; do NOT pin_logo. Nav must match LIVE SITE.`
          : continueIntent.inventLogo
            ? "Return a complete HTML document based on the prior mock — invent a NEW logo via generate_image (inventNew=true) + pin_logo; do not re-embed the superseded pin. Nav must match LIVE SITE."
          : continueIntent.scope === "full_revise"
            ? "Return a short rationale (1–3 sentences) then a complete self-contained HTML document in a ```html fence. Nav must match LIVE SITE inventory."
            : "Return a complete HTML document based on the prior mock — preserve hero, tokens, shell, and pinned logos; change only requested sections/targets. Nav must match LIVE SITE.";

    const loopMetaForScope = readDesignLoopMeta(project.rootPath, loopId);
    const conceptualScope = getDesignLoopScope(loopMetaForScope);
    const priorMockForTheme =
      workingPreviousHtml?.trim() ||
      previousHtml?.trim() ||
      (version > 1
        ? readDesignLoopMockHtml(project.rootPath, loopId, version - 1)
        : null) ||
      "";
    const themeFromPrior = priorMockForTheme
      ? extractThemeContractFromHtml(priorMockForTheme, {
          request: brief,
          notes: message ?? "",
        })
      : extractThemeContractFromHtml("", {
          request: `${brief}\n${message ?? ""}`,
        });
    // Soft theme contract from ask text when mock not yet dual-mode
    const themeForPrompt =
      themeFromPrior ??
      (/\bdark\b/i.test(desc) && /\blight\b/i.test(desc)
        ? extractThemeContractFromHtml(
            `<html data-theme="dark"><style>:root{--background:#0A0A0A;--foreground:#F5F0E8}[data-theme="light"]{--background:#FDF8F3;--foreground:#1A1510}</style><button class="theme-toggle">Dark / Light</button></html>`,
            { request: desc },
          )
        : null);
    const conceptualModelBlock = formatConceptualModelPromptBlock({
      scope: conceptualScope,
      theme: themeForPrompt,
      forMock: true,
    });

    const authorityCritical = sharedDesignBlock
      ? "CRITICAL: SHARED DESIGN (or adopt-theme sibling excerpts) is authoritative for palette, tokens, dual theme, and logos. LIVE SITE is authoritative for nav labels/hrefs, routes, and extracted screen copy only — do not invent menu items or purple/cream palettes. For screens with extracted headings/columns/fields/buttons, use that copy verbatim."
      : priorDesignBlock
        ? "CRITICAL: PRIOR DESIGN (this project's existing theming / DESIGN_PACK) is authoritative for palette, tokens, dual theme, and logos. Revise from the prior mock when provided. LIVE SITE is authoritative for nav labels/hrefs, routes, and extracted screen copy only — do not invent a new purple/cream palette."
        : sharedDesignActive
          ? "CRITICAL: Shared/prior design authority applies for palette and tokens. LIVE SITE wins for nav/routes/screen copy only."
          : "CRITICAL: LIVE SITE inventory below is authoritative for nav labels/hrefs, routes, tokens, logos, and extracted screen copy / entity fields. Do not invent menu items. For screens with extracted headings/columns/fields/buttons, use that copy verbatim — do not lorem-ipsum. Invent content only for routes with no extraction. Sibling cues are secondary.";

    const prompt = `Design loop ${loopId} — produce version v${version} mock HTML.

${authorityCritical}
Current loopId (required for media tools): ${loopId}
${modeBlock ? `${modeBlock}\n` : ""}${conceptualModelBlock}

${needsEdit
  ? "Operator asked for an IMAGE EDIT (alpha/icon pack/resize). Call make_transparent / derive_icon_pack / resize_image — do NOT generate_image. Prefer pinned / true RGBA sources."
  : continueIntent.inventLogo && inventCount > 1
    ? `Operator asked for ${inventCount} NEW logo variants. Call generate_image with inventNew=true exactly ${inventCount} times (distinct styles/filenames), embed a logo-card / Concept grid of all of them, and do NOT pin_logo — operator will choose later.`
    : continueIntent.inventLogo
    ? "Operator asked for a NEW logo. Call generate_image with inventNew=true, embed the new relativePath, then pin_logo that filename. Do not reuse the superseded pin."
    : continueIntent.reuseProjectDesign
      ? "Operator asked to reuse this project's existing theming. Prefer PRIOR DESIGN tokens/logos and revise from the prior mock — do not invent a new brand system."
      : "When inventing a new mark, call generate_image with inventNew=true if a logo was previously pinned. For stock photos use search_images / import_image. For look critique use review_look."}
Otherwise prefer writing the mock with few or zero tool calls.

${selectionsBlock}

${brandAssetsBlock ? `${brandAssetsBlock}\n` : ""}${sharedDesignBlock ? `${sharedDesignBlock}\n` : ""}${priorDesignBlock ? `${priorDesignBlock}\n` : ""}${elementsBlock ? `${elementsBlock}\n` : ""}${siteInventoryBlock ? `${siteInventoryBlock}\n` : ""}
Brief:
${clipPromptSection("brief", brief, 3_000)}

${message?.trim() ? `Operator feedback:\n${clipPromptSection("feedback", message, 3_000)}\n` : ""}
${reviseBlock}

${siblingPack ? `${siblingPack}\n` : ""}${
      isContinue
        ? ""
        : `BLUEPRINT (excerpt):\n${clipPromptSection("BLUEPRINT.md", blueprint, 3_000)}\n`
    }
${htmlReturnRule}
Inline CSS with :root tokens drawn from this project / sibling excerpts when present (or keep tokens from the previous mock). When the conceptual model includes theme modes, also include a [data-theme="light"] block remapping --background/--surface/--foreground. Prefer local .slopcontrol asset paths over remote hotlinks. End with MOCK_HTML_COMPLETE or MOCK_ASSETS_ONLY on its own line.`;

    let usedScaffold = false;
    let raw = "";
    try {
      const live = await runAgentLiveTurn(
        this.ctx.agents.designLoopAgent,
        prompt,
        project.id,
        `design-loop-${loopId}-v${version}`,
        {
          maxSteps: continueIntent.inventLogo
            ? Math.min(28, 8 + inventCount * 2)
            : continueIntent.scope === "assets_only"
              ? 8
              : needsMedia
                ? 12
                : 4,
          timeoutMs: 300_000,
          onProgress: input.onProgress,
          abortSignal: input.abortSignal,
          synthesizeIfNarration: false,
          statusLabel: "design generate started",
        },
      );
      raw = live.reply;
    } catch (err) {
      if (err instanceof LiveTurnInterruptedError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      slog.warn("design-loop", `generate failed; preserving prior mock if any`, {
        loopId,
        error: detail,
      });
      return finishDesign({
        ...resolveDesignLoopGenerateFallback({
          brief,
          previousHtml: workingPreviousHtml ?? previousHtml,
          errorDetail: detail,
          scaffold: scaffoldDesignLoopMock,
        }),
      });
    }

    const baseHtml = workingPreviousHtml?.trim() || previousHtml?.trim() || "";
    const assetsOnly =
      /MOCK_ASSETS_ONLY/i.test(raw) && Boolean(baseHtml);
    const extracted = assetsOnly ? null : extractHtmlDocument(raw);

    if (!extracted && baseHtml && (assetsOnly || continueIntent.scope === "assets_only")) {
      const html = patchMockForAssetContinue({
        previousHtml: baseHtml,
        loopId,
        primaryLogoAsset: pinnedLogo,
      });
      return finishDesign({
        html,
        notes:
          [
            assetPatchNotes,
            raw
              .replace(/```[\s\S]*?```/g, "")
              .replace(/MOCK_ASSETS_ONLY/gi, "")
              .replace(/MOCK_HTML_COMPLETE/gi, "")
              .trim(),
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 1_500) ||
          `Asset-only continue: prior mock preserved (v${version})`,
        usedScaffold: false,
      });
    }

    if (!extracted) {
      const fallback = resolveDesignLoopGenerateFallback({
        brief,
        previousHtml: workingPreviousHtml ?? previousHtml,
        errorDetail: "no HTML in agent output",
        scaffold: scaffoldDesignLoopMock,
      });
      usedScaffold = fallback.usedScaffold;
      return finishDesign({
        ...fallback,
        notes:
          fallback.notes ||
          (usedScaffold ? "Scaffold mock (no HTML in agent output)" : `v${version}`),
      });
    }

    let html = extracted;
    let softDriftNotes = "";

    // Apply pinned SHARED ELEMENTS before drift so menubar/toggle cleanup
    // is scored, not the agent's messy intermediate HTML.
    let elementHonorNotes = "";
    {
      const pinnedEls = readDesignLoopElements(project.rootPath, loopId);
      if (pinnedEls.length && html?.trim()) {
        const logoSrc = pinnedLogo
          ? `.slopcontrol/design-loops/${loopId}/assets/${pinnedLogo}`
          : null;
        const before = html;
        html = applyPinnedDesignElementsToMock({
          html,
          elements: pinnedEls,
          projectRoot: project.rootPath,
          pinnedLogoSrc: logoSrc,
          brandName: project.name,
        });
        if (html !== before) {
          slog.info("design-loop", "applied pinned design elements to mock", {
            loopId,
            elementIds: pinnedEls.map((e) => e.id),
          });
        }

        // LLM honor judge (semantic). Never discard the applied mock on regex.
        try {
          const { endpoint, modelId } =
            this.ctx.registry.resolveEndpointForRole("classification");
          let menubarSimilarity: number | null = null;
          let embedSignal: "ok" | "skipped" = "skipped";
          const menubarRef = pinnedEls.find((e) => e.id === "menubar");
          if (menubarRef?.mockPath) {
            try {
              const pinnedMenubarAbs = join(
                project.rootPath,
                menubarRef.mockPath,
              );
              if (existsSync(pinnedMenubarAbs)) {
                const pinnedBody = extractElementBodyHtml(
                  readFileSync(pinnedMenubarAbs, "utf-8"),
                );
                const mockHeader =
                  html.match(
                    /<header\b[^>]*>[\s\S]{0,4000}?<\/header>/i,
                  )?.[0] ?? "";
                const sim = await tryMenubarEmbedSimilarity({
                  endpoint,
                  modelId,
                  pinnedMenubarHtml: pinnedBody,
                  mockHeaderHtml: mockHeader,
                });
                if (typeof sim === "number" && Number.isFinite(sim)) {
                  menubarSimilarity = sim;
                  embedSignal = "ok";
                }
              }
            } catch {
              embedSignal = "skipped";
            }
          }
          const honor = await classifyElementHonorViaLlm({
            endpoint,
            modelId,
            pinnedElementIds: pinnedEls.map((e) => e.id),
            mockSnippets: buildElementHonorSnippets(html),
            operatorHints: [
              `adoptChrome=${continueIntent.adoptChrome}`,
              `scope=${continueIntent.scope}`,
              message?.slice(0, 400) ?? "",
            ]
              .filter(Boolean)
              .join("\n"),
            menubarSimilarity:
              menubarSimilarity == null ? undefined : menubarSimilarity,
            timeoutMs: 90_000,
          });
          slog.info("design-loop", "element honor judge", {
            loopId,
            honors: honor.honorsPinnedElements,
            competing: honor.competingThemeControl,
            confidence: honor.confidence,
            menubarSimilarity,
            embedSignal,
          });
          if (
            honor.competingThemeControl &&
            honor.confidence === "high"
          ) {
            const cleaned = stripExtraThemeTogglesOutsideMenubar(html);
            if (cleaned !== html) {
              html = cleaned;
              slog.info(
                "design-loop",
                "stripped extra theme toggles outside menubar after honor judge",
                { loopId },
              );
            }
          }
          elementHonorNotes = [
            `Element honor: honors=${honor.honorsPinnedElements} competing=${honor.competingThemeControl} missingMenubar=${honor.missingMenubar} missingToggle=${honor.missingThemeToggle} confidence=${honor.confidence}.`,
            honor.notes.trim(),
          ]
            .filter(Boolean)
            .join(" ")
            .slice(0, 800);
        } catch (err) {
          slog.warn("design-loop", "element honor judge skipped", {
            loopId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (isContinue && baseHtml && continueIntent.scope !== "full_revise") {
      const drift = detectMockDrift({
        previousHtml: baseHtml,
        nextHtml: html,
        intent: continueIntent,
        pinnedLogoAsset: pinnedLogo,
        pinnedElements: readDesignLoopElements(project.rootPath, loopId),
      });
      const hard = hardMockDriftIssues(drift);
      const soft = softMockDriftIssues(drift);
      const intentSummary = `intent={scope:${continueIntent.scope}, adoptTheme:${continueIntent.adoptTheme}, inventLogo:${continueIntent.inventLogo}, preserveChrome:${continueIntent.preserveChrome}, targets:[${continueIntent.targets.join(",")}]}`;
      if (hard.length) {
        slog.warn("design-loop", "rejecting drifted mock; keeping prior + asset patch", {
          loopId,
          version,
          issues: hard.map((d) => d.code),
          softIssues: soft.map((d) => d.code),
          intent: {
            scope: continueIntent.scope,
            adoptTheme: continueIntent.adoptTheme,
            inventLogo: continueIntent.inventLogo,
            preserveChrome: continueIntent.preserveChrome,
            targets: continueIntent.targets,
          },
        });
        html = patchMockForAssetContinue({
          previousHtml: baseHtml,
          loopId,
          primaryLogoAsset: pinnedLogo,
        });
        {
          const pinnedEls = readDesignLoopElements(project.rootPath, loopId);
          if (pinnedEls.length) {
            const logoSrc = pinnedLogo
              ? `.slopcontrol/design-loops/${loopId}/assets/${pinnedLogo}`
              : null;
            html = applyPinnedDesignElementsToMock({
              html,
              elements: pinnedEls,
              projectRoot: project.rootPath,
              pinnedLogoSrc: logoSrc,
              brandName: project.name,
            });
          }
        }
        const notes = [
          assetPatchNotes,
          elementHonorNotes,
          `Rejected layout/logo drift (${hard.map((d) => d.code).join(", ")}); kept prior mock.`,
          intentSummary,
          ...hard.map((d) => d.detail),
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1_500);
        return finishDesign({ html, notes, usedScaffold: false });
      }
      if (soft.length) {
        slog.warn("design-loop", "soft drift warning; keeping agent mock", {
          loopId,
          version,
          issues: soft.map((d) => d.code),
          intent: {
            scope: continueIntent.scope,
            targets: continueIntent.targets,
            preserveChrome: continueIntent.preserveChrome,
          },
        });
        softDriftNotes = [
          assetPatchNotes,
          `Soft drift warning (${soft.map((d) => d.code).join(", ")}); kept agent mock.`,
          intentSummary,
          ...soft.map((d) => d.detail),
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1_500);
      }
    }

    // Force pinned primary logo into the final mock — except invent/logo-swap
    // continues, where the agent (or share import) may introduce a new mark.
    const allowLogoSwap = continueIntentAllowsLogoSwap(continueIntent);
    if (pinnedLogo && html?.trim() && !continueIntent.inventLogo && !allowLogoSwap) {
      const before = html;
      html = patchMockForAssetContinue({
        previousHtml: html,
        loopId,
        primaryLogoAsset: pinnedLogo,
      });
      if (html !== before) {
        slog.info("design-loop", "applying pinned logo", {
          loopId,
          asset: pinnedLogo,
        });
      }
    } else if (
      continueIntent.inventLogo &&
      inventCount <= 1 &&
      html?.trim()
    ) {
      const newLogo = dominantMockLogoAsset(html);
      if (newLogo && newLogo !== pinnedLogo) {
        try {
          pinDesignLoopLogoAsset({
            projectRoot: project.rootPath,
            loopId,
            asset: newLogo,
            label: `Invented mark (${newLogo})`,
          });
          slog.info("design-loop", "re-pinned invented logo", {
            loopId,
            asset: newLogo,
          });
        } catch (err) {
          slog.warn("design-loop", "failed to re-pin invented logo", {
            loopId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const notes = composeDesignLoopVersionNotes({
      elementHonorNotes,
      softDriftNotes,
      agentRaw: raw,
      version,
    });
    const chatProse = raw
      .replace(/```[\s\S]*?```/g, "")
      .replace(/MOCK_ASSETS_ONLY/gi, "")
      .replace(/MOCK_HTML_COMPLETE/gi, "")
      .trim()
      .slice(0, 2_000);
    return finishDesign({
      html,
      notes,
      usedScaffold: false,
      reply: chatProse || notes,
    });
  }

  /**
   * Generate or revise a plan-loop PLAN.md (no product / phase writes).
   */
  async planLoopGenerate(input: PlanLoopGenerateInput): Promise<{
    plan: string;
    notes: string;
    usedScaffold: boolean;
    reply: string;
  }> {
    const { project, loopId, brief, message, previousPlan, version } = input;
    ensureSlopcontrolDir(project.rootPath);
    const isContinue = version > 1 || Boolean(previousPlan?.trim());
    const desc = [brief, message ?? ""].filter(Boolean).join("\n");
    const finishPlan = (opts: {
      plan: string;
      notes: string;
      usedScaffold: boolean;
      reply?: string;
    }) => ({
      plan: opts.plan,
      notes: opts.notes,
      usedScaffold: opts.usedScaffold,
      reply:
        (opts.reply ?? opts.notes).trim() || `Plan loop v${version} updated.`,
    });

    let continueIntent: PlanContinueIntent = PLAN_CONTINUE_INTENT_DEFAULT;
    if (isContinue) {
      const fallback = normalizePlanContinueIntentStructured(
        fallbackPlanContinueIntentFromText(message?.trim() || desc),
      );
      try {
        const { endpoint, modelId } = this.ctx.registry.resolveEndpointForRole(
          "classification",
        );
        continueIntent = await classifyPlanContinueIntentViaLlm({
          endpoint,
          modelId,
          message: message?.trim() || desc,
          brief,
          timeoutMs: 90_000,
        });
      } catch (err) {
        slog.warn("plan-loop", "continue intent LLM failed; regex fallback", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
        continueIntent = fallback;
      }
    } else {
      continueIntent = {
        ...PLAN_CONTINUE_INTENT_DEFAULT,
        scope: "full_revise",
      };
    }

    const reopenLocks =
      isContinue &&
      (continueIntent.scope === "expand_scope" ||
        continueIntent.scope === "full_revise");
    if (reopenLocks) {
      clearPlanLoopAcceptanceLocks({
        projectRoot: project.rootPath,
        loopId,
        version,
      });
    }

    const metaNow = readPlanLoopMeta(project.rootPath, loopId);
    if (metaNow) {
      let scope = metaNow.scope ?? defaultPlanScope(brief, "start");
      if (isContinue) {
        if (
          continueIntent.scope === "expand_scope" ||
          continueIntent.scope === "full_revise"
        ) {
          scope = defaultPlanScope(message?.trim() || brief, "continue");
          if (continueIntent.focus) {
            scope = { ...scope, focus: continueIntent.focus, source: "continue" };
          }
        } else if (continueIntent.focus) {
          scope = {
            ...scope,
            focus: continueIntent.focus,
            preserve: continueIntent.preserve ?? scope.preserve,
            source: "continue",
          };
        } else if (continueIntent.preserve?.length) {
          scope = {
            ...scope,
            preserve: continueIntent.preserve,
            source: "continue",
          };
        }
      }
      if (
        !metaNow.scope ||
        scope.focus !== metaNow.scope.focus ||
        scope.kind !== metaNow.scope.kind ||
        reopenLocks
      ) {
        writePlanLoopMeta(project.rootPath, {
          ...metaNow,
          scope,
          updatedAt: new Date().toISOString(),
        });
      }
    }

    const scope =
      readPlanLoopMeta(project.rootPath, loopId)?.scope ??
      defaultPlanScope(brief, "start");
    const acceptance = readPlanLoopAcceptance(project.rootPath, loopId);
    const acceptanceBlock = formatPlanAcceptancePromptBlock(acceptance);
    const modeBlock = isContinue
      ? formatPlanContinueIntentPromptBlock(continueIntent)
      : "";
    const reviseBlock = previousPlan?.trim()
      ? formatPlanLoopReviseBlock({ previousPlan })
      : "(no previous plan — create v1)";
    const conceptual = [
      "CONCEPTUAL MODEL (authoritative for this turn):",
      `- kind: ${scope.kind}`,
      `- focus: ${scope.focus}`,
      `- preserve: ${scope.preserve.length ? scope.preserve.join(", ") : "(none)"}`,
    ].join("\n");

    const depPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message: [brief, message ?? ""].filter(Boolean).join("\n"),
      listProjects: input.listProjects,
      dataDir: input.dataDir,
    });

    const siblingPack = buildSiblingInvestigationPack({
      targetRoot: project.rootPath,
      brief: desc,
      listProjects: input.listProjects,
    });
    const investigate =
      Boolean(siblingPack.trim()) || briefWantsSiblingInvestigation(desc);

    const acceptanceLockNote = reopenLocks
      ? "(Acceptance locks CLEARED for expand/full_revise — Goal/In scope may change; retick before accept.)"
      : "(Ticked sections are locked unless the operator reopens them.)";
    const expandH2Note =
      continueIntent.scope === "expand_scope" ||
      continueIntent.scope === "full_revise"
        ? "CRITICAL: Emit ALL nine required H2 section titles even if some bodies are brief stubs. Rewrite Goal/In scope when expanding."
        : "";

    const prompt = `Plan loop ${loopId} — produce version v${version} PLAN.md.

${conceptual}
${modeBlock ? `\n${modeBlock}\n` : ""}
${acceptanceBlock ? `${acceptanceBlock}\n${acceptanceLockNote}\n` : ""}
${depPack ? `\n${depPack}\n` : ""}
${siblingPack ? `\n${siblingPack}\n` : ""}
Brief:
${clipPromptSection("brief", brief, 3_000)}

${message?.trim() ? `Operator feedback:\n${clipPromptSection("feedback", message, 3_000)}\n` : ""}
${reviseBlock}

Required H2 sections: Goal, Constraints, In scope, Out of scope, Approach, Likely areas, Success criteria, Risks & open questions, Handoff notes.
CRITICAL: Goal must be 1–3 sentences — never paste the operator brief.
${expandH2Note}
${investigate ? "CRITICAL: Investigate sibling absolute paths (read_file) before writing; cite them under Likely areas." : ""}
When CROSS-PROJECT DEPS / DEPENDENCY INTENT apply, record package/element refs under Likely areas and Handoff notes (e.g. deps: @acme/theme-toggle@1.0.0 from SiblingBrand). Never recommend npm link.
Return a short rationale then the full plan in a markdown fence. End with PLAN_COMPLETE.`;

    const maxSteps = investigate ? 16 : 10;
    let raw = "";
    try {
      const live = await runAgentLiveTurn(
        this.ctx.agents.planLoopAgent,
        prompt,
        project.id,
        `plan-loop-${loopId}-v${version}`,
        {
          maxSteps,
          timeoutMs: 240_000,
          onProgress: input.onProgress,
          abortSignal: input.abortSignal,
          synthesizeIfNarration: false,
          statusLabel: "plan generate started",
        },
      );
      raw = live.reply;
    } catch (err) {
      if (err instanceof LiveTurnInterruptedError) throw err;
      const detail = err instanceof Error ? err.message : String(err);
      slog.warn("plan-loop", "generate failed; preserving prior plan if any", {
        loopId,
        error: detail,
      });
      return finishPlan({
        ...resolvePlanLoopGenerateFallback({
          brief,
          previousPlan,
          errorDetail: detail,
          scope,
        }),
      });
    }

    if (continueIntent.scope === "clarify_only" && previousPlan?.trim()) {
      const notes = raw
        .replace(/```[\s\S]*?```/g, "")
        .replace(/PLAN_COMPLETE/gi, "")
        .trim()
        .slice(0, 1_500);
      return finishPlan({
        plan: previousPlan.trim(),
        notes: notes || "Clarify-only continue; prior plan preserved.",
        usedScaffold: false,
      });
    }

    let plan = extractPlanDocument(raw);
    if (!plan?.trim()) {
      // One repair turn before fail-closed — text-only agent (no tools).
      const repairPrompt = `Your previous reply had no extractable PLAN.md. Output ONLY a markdown fence containing the full PLAN.md.

Required H2 titles (exact): Goal, Constraints, In scope, Out of scope, Approach, Likely areas, Success criteria, Risks & open questions, Handoff notes.
Goal: 1–3 sentences summarizing the operator intent (do not paste the brief).
${siblingPack ? `Cite sibling paths from SIBLING INVESTIGATION under Likely areas.\n\n${siblingPack.slice(0, 3_000)}\n` : ""}
Operator intent summary: ${clipPromptSection("brief", brief, 800)}
${message?.trim() ? `Feedback: ${message.trim().slice(0, 800)}\n` : ""}
End with PLAN_COMPLETE.`;
      try {
        raw = await runAgent(
          this.ctx.agents.planLoopRepairAgent,
          repairPrompt,
          project.id,
          `plan-loop-${loopId}-v${version}-repair`,
          { maxSteps: 2, timeoutMs: 180_000 },
        );
        plan = extractPlanDocument(raw);
      } catch (err) {
        slog.warn("plan-loop", "repair generate failed", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!plan?.trim() && previousPlan?.trim()) {
      return finishPlan({
        plan: previousPlan.trim(),
        notes:
          "Agent returned empty plan; prior kept. Call plan_loop_retry.",
        usedScaffold: true,
      });
    }
    if (!plan?.trim()) {
      return finishPlan({
        plan: failurePlanDocument({
          brief,
          errorDetail: "empty agent plan after repair",
        }),
        notes:
          "Failure plan — empty agent output after repair. Call plan_loop_retry.",
        usedScaffold: true,
      });
    }

    let validation = validatePlanDocument(plan);
    let mergeNote = "";
    if (!validation.ok && planDocumentWorthMerging(plan)) {
      const merged = mergePlanDocumentSections({
        incoming: plan,
        prior: previousPlan,
        title: brief,
      });
      const mergedValidation = validatePlanDocument(merged.plan);
      if (mergedValidation.ok) {
        plan = merged.plan;
        validation = mergedValidation;
        const bits = [
          merged.filledFromPrior.length
            ? `from prior: ${merged.filledFromPrior.join(", ")}`
            : null,
          merged.filledStub.length
            ? `stubs: ${merged.filledStub.join(", ")}`
            : null,
        ].filter(Boolean);
        mergeNote = `Merged missing sections (${bits.join("; ") || "ok"}).`;
      }
    }
    if (!validation.ok && previousPlan?.trim()) {
      const priorOk = validatePlanDocument(previousPlan);
      if (priorOk.ok) {
        return finishPlan({
          plan: previousPlan.trim(),
          notes: `Rejected incomplete plan (missing: ${validation.missing.join(", ") || "—"}; empty: ${validation.empty.join(", ") || "—"}); kept prior.`,
          usedScaffold: true,
        });
      }
    }
    if (!validation.ok && !previousPlan?.trim()) {
      return finishPlan({
        plan: scaffoldPlanDocument({
          brief,
          scope,
          errorDetail: `incomplete: missing ${validation.missing.join(",")}`,
        }),
        notes: `Scaffold — incomplete plan sections`,
        usedScaffold: true,
      });
    }

    const chatProse = raw
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^#\s+Plan[\s\S]*/im, "")
      .replace(/PLAN_COMPLETE/gi, "")
      .trim()
      .slice(0, 2_000);
    const notes = [mergeNote, chatProse].filter(Boolean).join(" ");

    return finishPlan({
      plan,
      notes: notes || `v${version}`,
      usedScaffold: false,
      reply: chatProse || notes || `Plan loop v${version} updated.`,
    });
  }

  /**
   * Run up to ASK_SUB_RESEARCH_MAX_TOPICS ephemeral investigations in parallel.
   * Findings are returned for the caller to append to the ask transcript.
   * Does not create phases or write RESEARCH.md.
   */
  async askSubResearch(input: AskSubResearchInput): Promise<{
    findings: Array<{ topic: string; content: string }>;
  }> {
    const { project, askId, topics, history } = input;
    const cleaned = topics.map((t) => t.trim()).filter(Boolean);
    if (cleaned.length === 0) {
      throw new Error("topics must be a non-empty string array (max 4)");
    }
    if (cleaned.length > ASK_SUB_RESEARCH_MAX_TOPICS) {
      throw new Error(
        `At most ${ASK_SUB_RESEARCH_MAX_TOPICS} sub-research topics allowed per request`,
      );
    }

    ensureSlopcontrolDir(project.rootPath);
    const blueprint = readBlueprint(project.rootPath);
    const roadmap = readRoadmap(project.rootPath);
    const historyBlock =
      history.length === 0
        ? "(no prior turns)"
        : history
            .slice(-12)
            .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 1_500)}`)
            .join("\n\n");

    const findings = await Promise.all(
      cleaned.map(async (topic, index) => {
        const prompt = `Ask sub-research (askId=${askId}, topic ${index + 1}/${cleaned.length}).
Investigate ONLY this topic and return markdown findings (no file writes, no phases).

Topic:
${topic}

BLUEPRINT (excerpt):
${clipPromptSection("BLUEPRINT.md", blueprint, 4_000)}

ROADMAP (excerpt):
${clipPromptSection("ROADMAP.md", roadmap, 2_000)}

Ask conversation context:
${historyBlock}`;

        const content = await runAgent(
          this.ctx.agents.askSubResearchAgent,
          prompt,
          project.id,
          `ask-sub-${askId}-${index}`,
          { maxSteps: 16, timeoutMs: 120_000 },
        );
        const body = content.trim() || `(empty findings for: ${topic})`;
        return {
          topic,
          content: `## Sub-research: ${topic}\n\n${body}`,
        };
      }),
    );

    return { findings };
  }

  /**
   * One turn of agent chat (inspect/verify with run_command). Not development.
   */
  async agentTurn(input: AgentTurnInput): Promise<{ reply: string }> {
    const { project, agentId, message, history } = input;
    ensureSlopcontrolDir(project.rootPath);
    const blueprint = readBlueprint(project.rootPath);
    const roadmap = readRoadmap(project.rootPath);
    const historyBlock =
      history.length === 0
        ? "(no prior turns)"
        : history
            .slice(-12)
            .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2_000)}`)
            .join("\n\n");

    const depPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message,
      listProjects: input.listProjects,
      dataDir: input.dataDir,
    });

    const prompt = `Project agent chat (agentId=${agentId}).
Inspect/verify using repo tools and run_command in the project root. Do not start development or phases.

BLUEPRINT (excerpt):
${clipPromptSection("BLUEPRINT.md", blueprint, 6_000)}

ROADMAP (excerpt):
${clipPromptSection("ROADMAP.md", roadmap, 3_000)}
${depPack ? `\n${depPack}\n` : ""}
Recent conversation:
${historyBlock}

Operator message:
${message.trim()}`;

    const reply = await runAgentLiveTurn(
      this.ctx.agents.agentChatAgent,
      prompt,
      project.id,
      `agent-${agentId}`,
      {
        maxSteps: 24,
        timeoutMs: 240_000,
        onProgress: input.onProgress,
        abortSignal: input.abortSignal,
        synthesizeIfNarration: true,
        narrationJudgeFn: tryBindNarrationJudge(this.ctx.registry),
        statusLabel: "agent started",
      },
    );
    return { reply: reply.reply.trim() || "(empty reply)" };
  }

  async startResearch(input: StartResearchInput): Promise<RunStage> {
    const { project, phase, run, description, onStage } = input;
    ensureSlopcontrolDir(project.rootPath);
    onStage?.("researching");
    slog.info("research", "start", {
      projectId: project.id,
      phaseId: phase.id,
      runId: run.id,
      description: description.slice(0, 120),
    });

    if (!readBlueprint(project.rootPath).trim()) {
      if (isProjectEmpty(project.rootPath)) {
        log(
          project,
          run,
          "--- Empty project has no BLUEPRINT.md; bootstrapping via open_project with change description as intent ---",
        );
        const opened = await this.openProject({
          project,
          intent: description,
        });
        if (opened.blueprintStatus === "needs_intent") {
          log(
            project,
            run,
            `ERROR: ${opened.message ?? "needs_intent — provide a non-empty description/intent"}`,
          );
          writeDiagnosis(
            project.rootPath,
            run.id,
            buildPlanningFailureDiagnosis({
              stage: "research",
              title: "Research failed: needs intent",
              detail:
                opened.message ??
                "needs_intent — provide a non-empty description/intent",
              phaseId: phase.id,
              runId: run.id,
              kind: "needs-intent",
            }),
            phase.id,
          );
          return "failed";
        }
        log(
          project,
          run,
          `--- Greenfield BLUEPRINT ready (${opened.blueprintStatus}${opened.duration ? `, ${opened.duration}` : ""}) ---`,
        );
      } else {
        log(project, run, "--- No BLUEPRINT.md; running open_project bootstrap first ---");
        const opened = await this.openProject({ project });
        if (opened.blueprintStatus === "needs_intent") {
          log(project, run, `ERROR: ${opened.message ?? "needs_intent"}`);
          writeDiagnosis(
            project.rootPath,
            run.id,
            buildPlanningFailureDiagnosis({
              stage: "research",
              title: "Research failed: needs intent",
              detail: opened.message ?? "needs_intent",
              phaseId: phase.id,
              runId: run.id,
              kind: "needs-intent",
            }),
            phase.id,
          );
          return "failed";
        }
      }
    }

    log(project, run, `--- Starting research for phase ${phase.id} ---`);

    const intent = await ensureChangeIntentAsync(
      project.rootPath,
      phase.id,
      description,
      { registry: this.ctx.registry },
    );
    const intentBlock = formatChangeIntentPromptBlock(intent);
    const adjacentPack = buildAdjacentPhaseContextPack(project.rootPath, 5);
    const siblingBrandPack = buildSiblingBrandRefPack({
      projectRoot: project.rootPath,
      description,
    });
    const blueprint = readBlueprint(project.rootPath);
    const roadmap = readRoadmap(project.rootPath);
    const learningsBlock = loadLearningsPromptBlock(project.rootPath, {
      phaseDescription: description,
    });
    const researchPath = `.slopcontrol/phases/${phase.id}/RESEARCH.md`;
    const researchDate = new Date().toISOString().slice(0, 10);
    const engagementHonesty = intent.interaction
      ? `
Form / engagement honesty (Change Intent has an interaction contract — mandatory):
- Put \`Date: ${researchDate}\` near the top of RESEARCH.md (authoritative; do not invent another date).
- Do NOT claim fill/submit "already works" (~90% done) solely because prior form phases are \`complete\`.
- Treat prior complete form/engagement phases as hypotheses; verify in code whether the actionable mount still fill+submits.
- Call out open engagement risks when code evidence supports them (e.g. AI SDK tool parts using \`type: "tool-<name>"\` without \`toolName\`, superseded classification, composer vs bubble mount).
- Residual gaps must still prove fill+submit at the locked mount; chip/taxonomy-only is insufficient.
`
      : `
Research date (authoritative): ${researchDate} — put \`Date: ${researchDate}\` near the top of RESEARCH.md.
`;
    const brandResearchNote =
      changeIntentIsBrandTheming(intent)
      ? `
Brand / theming research (mandatory when Change Intent is brand/theming):
- Prefer sibling **consumed** logo paths (Header / shell \`img\` / \`next/image\` → usually \`public/images/logo.svg\`).
- Do NOT treat \`public/brand/*-reuse.svg\` or other tiny tile+circle stubs as the sibling's real mark.
- Probe named sibling projects when the operator named them (absolute path or registered name) — do not assume a default brand family.
- Explicitly decide: palette-only vs palette+shell/theme machinery vs full layout parity — do not silently freeze shells if the operator asked to apply theming.
`
      : "";
    const planContractBlock = formatPhaseBoundPlanPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxPlanChars: 10_000,
    });
    const phasePlanPack = readPhasePlanPack(project.rootPath, phase.id);
    const planResearchNote = phasePlanPack
      ? `
PLAN CONTRACT (authoritative operator plan from plan_loop_promote):
${planContractBlock}
- RESEARCH must resolve every openQuestion with code evidence.
- RESEARCH must not invent a competing Goal; do not expand Out of scope / mustNot.
- RESEARCH must address every successCriteria (concrete verification notes).
- Cite \`.slopcontrol/phases/${phase.id}/plan/PLAN.md\` in findings.
`
      : planContractBlock
        ? `\n${planContractBlock}\n`
        : "";
    const designAcceptance = readPhaseDesignAcceptance(
      project.rootPath,
      phase.id,
    );
    const phasePackForResearch = readPhaseDesignPack(project.rootPath, phase.id);
    const acceptanceBlock = formatAcceptancePromptBlock(designAcceptance, {
      inScopeIds: phasePackForResearch?.inScope,
      alreadyAppliedIds: phasePackForResearch?.alreadyApplied,
    });
    const designPackBlock = formatDesignPackPromptBlock(phasePackForResearch);
    const boundMockBlock = formatPhaseBoundMockPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxHtmlChars: 10_000,
    });
    const themeResearchNote =
      packHasThemeModes(phasePackForResearch) ||
      designAcceptance?.features?.some(
        (f) => f.id === "theme_modes" && f.accepted,
      )
        ? `
CRITICAL theme contract (theme_modes):
- Plan File Changes so product CSS remaps semantic tokens under html[data-theme="light"].
- ThemeToggle (or equivalent) must set documentElement data-theme — not only a .light class that never receives tokens.
- Body/chrome must use var(--background)/var(--foreground) (or equivalent semantic vars), not hard-coded --color-dark-* that ignore the toggle.
- Cite DESIGN_PACK.theme.requirements and lightTokensCss when present.
`
        : "";
    const claimProofResearchNote = (() => {
      const designShellOrTheme = Boolean(
        designAcceptance?.features?.some(
          (f) =>
            f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
        ) ||
          phasePackForResearch?.inScope?.includes("theme_modes") ||
          phasePackForResearch?.inScope?.includes("applied_shell"),
      );
      const askSignalsShellTheme =
        changeIntentIsBrandTheming(intent) ||
        changeIntentIsThemeWiringOnly(intent);
      if (!designShellOrTheme && !askSignalsShellTheme) return "";
      return `\n${formatClaimProofChecksGuidance({
        shellNotes: phasePackForResearch?.shell,
        designShellOrTheme,
      })}\n`;
    })();
    const antiAuditThemeNote = formatAntiAuditThemeDeliveryNote({
      description: phase.description,
      projectRoot: project.rootPath,
      phaseId: phase.id,
      requestsMissingThemeControl: intent.requestsMissingThemeControl,
      designShellOrThemeAccepted: designAcceptance?.features?.some(
        (f) =>
          f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
      ),
    });
    const elementsResearchNote = phasePackForResearch?.elements?.length
      ? `
CRITICAL shared elements (DESIGN_PACK.elements):
${phasePackForResearch.elements
  .map((e) => {
    const npm = e.npmPackage
      ? ` — prefer \`pnpm add ${e.npmPackage}@${e.npmVersion ?? "*"}\` from SlopControl private registry (never npm link)`
      : e.hasCode
        ? ` from \`${e.codePath ?? "design/elements/.../src"}\` (prefer TS/JS)`
        : ` per \`${e.specPath ?? "SPEC.md"}\` + mock`;
    return `- Mount ${e.id}@${e.version}${npm} at ${(e.mountHints ?? ["host"]).join("/")}`;
  })
  .join("\n")}
- Do not invent a competing day/night (or other) control when an element id is listed.
`
      : "";
    const crossDepResearchPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message: description,
      listProjects: input.listProjects,
    });
    const acceptanceResearchNote = designAcceptance?.features?.some((f) => f.accepted)
      ? `
Design-loop acceptance (authoritative scope for this phase):
${acceptanceBlock}
- RESEARCH must figure out HOW to implement every IN SCOPE feature (concrete files, mounts, token paths).
- Do NOT expand into OUT OF SCOPE features; treat them as mustNot.
- If applied_shell is in scope, plan portal/dashboard UI fidelity to the accepted mock frames — not palette-only.
- Obey DESIGN_PACK.json logos/tokens/contentPillars/scope/theme/elements; do not invent a competing mark or control.
- If conceptual model scope.kind is component/flow, File Changes must stay within focusPaths/focus — do not expand to full site shell.
${themeResearchNote}${claimProofResearchNote}${elementsResearchNote}${crossDepResearchPack ? `\n${crossDepResearchPack}\n` : ""}${designPackBlock ? `\n${designPackBlock}\n` : ""}${boundMockBlock ? `\n${boundMockBlock}\n` : ""}
`
      : [designPackBlock, boundMockBlock, crossDepResearchPack].filter(Boolean).join("\n\n")
        ? `\n${themeResearchNote}${claimProofResearchNote}${elementsResearchNote}${[crossDepResearchPack, designPackBlock, boundMockBlock].filter(Boolean).join("\n\n")}\n`
        : crossDepResearchPack
          ? `\n${crossDepResearchPack}\n`
          : "";
    const prompt = `Change request:
${clipPromptSection("change-request", description, 4_000)}

${intentBlock}
${planResearchNote}${acceptanceResearchNote}${adjacentPack ? `${adjacentPack}\n` : ""}${siblingBrandPack ? `${siblingBrandPack}\n` : ""}Phase id: ${phase.id}
${engagementHonesty}${brandResearchNote}${antiAuditThemeNote}
Existing blueprint (excerpt — full file at .slopcontrol/BLUEPRINT.md; prefer Live decisions):
${clipBlueprintForPrompt(blueprint || "", 6_000)}

Roadmap (excerpt — full file at .slopcontrol/ROADMAP.md):
${clipPromptSection("ROADMAP.md", roadmap || "", 2_000)}
${learningsBlock ? `\n${learningsBlock}` : ""}
Research the project at ${project.rootPath}.
Use tools sparingly, then write RESEARCH.md via write_file to ${researchPath} AND return the same markdown in your final response (start with #).
End with RESEARCH_COMPLETE.
If the blueprint is still thin, include ## Proposed Blueprint and ## Proposed Roadmap.
Do NOT only chat about investigating — the response body / written file must be the RESEARCH.md document.
Obey Change Intent uiMount over older contradictory Blueprint Deltas.
Obey prior learnings (especially infra blockers): do not propose coding-agent work to bring up missing local services.`;

    const researchWatch = researchDocWatchPaths(project.rootPath, phase.id);
    let beforeStats = snapshotFileStats(researchWatch);
    let output = await runAgent(
      this.ctx.agents.researchAgent,
      prompt,
      project.id,
      `${phase.id}-research`,
      { maxSteps: 20 },
    );

    log(project, run, output);
    let resolved = resolveResearchFromAgentTurn({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      agentOutput: output,
      beforeStats,
    });

    if (resolved.thin) {
      slog.warn("research", "thin research output; retrying once", {
        projectId: project.id,
        phaseId: phase.id,
        source: resolved.source,
        chars: resolved.doc.length,
        preview: resolved.doc.slice(0, 200),
      });
      const retryPrompt = `Your previous research was empty or chat-only (${resolved.doc.length} chars).
Do NOT continue investigating with tools. Immediately write the FULL RESEARCH.md.

write_file path: ${researchPath}
Also return the same markdown in your final response starting with #.
Cover: problem summary, relevant files/modules, root-cause hypotheses, risks.
Use Date: ${researchDate} near the top (authoritative).
${intent.interaction ? "If this is a form/engagement change: do not claim fill/submit already works just because prior phases are complete; note open mount/engagement risks from code." : ""}
End with RESEARCH_COMPLETE.

Change request:
${clipPromptSection("change-request", description, 4_000)}
Phase id: ${phase.id}
${intentBlock}`;
      beforeStats = snapshotFileStats(researchWatch);
      output = await runAgent(
        this.ctx.agents.researchAgent,
        retryPrompt,
        project.id,
        `${phase.id}-research-retry`,
        { maxSteps: 12 },
      );
      log(project, run, output);
      resolved = resolveResearchFromAgentTurn({
        projectRoot: project.rootPath,
        phaseId: phase.id,
        agentOutput: output,
        beforeStats,
      });
    }

    const engagementQuality = researchEngagementQuality(resolved.doc, intent);
    if (!resolved.thin && !engagementQuality.ok) {
      slog.warn("research", "engagement overclaim; retrying once", {
        projectId: project.id,
        phaseId: phase.id,
        issues: engagementQuality.issues,
      });
      log(
        project,
        run,
        `--- Research overclaim for engagement Intent; retrying once ---\n${engagementQuality.issues.map((i) => `- ${i}`).join("\n")}`,
      );
      const honestyRetry = `Your previous RESEARCH.md overclaimed that fill/submit / dynamic forms already work without residual engagement risks.
Rewrite the FULL RESEARCH.md. Rules:
- Use Date: ${researchDate} near the top (authoritative).
- Do NOT claim ~90% / "already exists" / "already works" unless you also document residual risks with code evidence (e.g. live AI SDK type: tool-<name> without toolName, parseToolResult, blocking gaps).
- Prefer open engagement risks over "prior phases are complete ⇒ proven".
write_file path: ${researchPath}
Also return the same markdown starting with #.
End with RESEARCH_COMPLETE.

${intentBlock}

Change request:
${clipPromptSection("change-request", description, 4_000)}
Phase id: ${phase.id}`;
      beforeStats = snapshotFileStats(researchWatch);
      output = await runAgent(
        this.ctx.agents.researchAgent,
        honestyRetry,
        project.id,
        `${phase.id}-research-honesty-retry`,
        { maxSteps: 12 },
      );
      log(project, run, output);
      resolved = resolveResearchFromAgentTurn({
        projectRoot: project.rootPath,
        phaseId: phase.id,
        agentOutput: output,
        beforeStats,
      });
      const again = researchEngagementQuality(resolved.doc, intent);
      if (!again.ok) {
        log(
          project,
          run,
          `--- Research still overclaims after honesty retry; proceeding with caveats ---\n${again.issues.map((i) => `- ${i}`).join("\n")}`,
        );
      }
    }

    if (resolved.thin) {
      const scaffolded = scaffoldResearch({
        phaseId: phase.id,
        description,
      });
      log(
        project,
        run,
        "--- Research still thin; writing scaffold RESEARCH.md so planning can continue ---",
      );
      writeResearch(project.rootPath, phase.id, scaffolded);
    } else {
      if (resolved.source === "tool_write" && resolved.path) {
        log(
          project,
          run,
          `--- Harvested RESEARCH.md from tool write: ${resolved.path} ---`,
        );
      }
      writeResearch(project.rootPath, phase.id, resolved.doc);
    }

    writePhaseStatus(project.rootPath, phase.id, "draft");

    const researchDoc = readResearch(project.rootPath, phase.id);
    if (!readBlueprint(project.rootPath).trim()) {
      bootstrapFromResearch(project.rootPath, researchDoc, {
        archiveExisting: false,
      });
    }

    if (!researchDoc.trim()) {
      slog.warn("research", "empty research after resolve", {
        projectId: project.id,
        phaseId: phase.id,
        runId: run.id,
      });
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "research",
          title: "Research failed: empty RESEARCH.md",
          detail: "Research resolve produced an empty document.",
          phaseId: phase.id,
          runId: run.id,
          kind: "empty-research",
        }),
        phase.id,
      );
      return "failed";
    }

    onStage?.("drafting");
    return this.draftPhase({
      project,
      phase,
      run,
      onStage,
      listProjects: input.listProjects,
    });
  }

  async draftPhase(input: {
    project: Project;
    phase: Phase;
    run: Run;
    onStage?: (stage: RunStage) => void;
    listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  }): Promise<RunStage> {
    const { project, phase, run, onStage } = input;
    onStage?.("drafting");
    log(project, run, "--- Drafting PHASE.md ---");

    const research = readResearch(project.rootPath, phase.id);
    const blueprint = readBlueprint(project.rootPath);
    const config = readProjectConfig(project.rootPath);
    const canonicalPath = `.slopcontrol/phases/${phase.id}/PHASE.md`;
    const cleared = clearMisalignedPhaseDoc({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      research,
      description: phase.description,
    });
    if (cleared.cleared) {
      log(
        project,
        run,
        `--- Cleared prior PHASE.md that did not match RESEARCH (${cleared.issues.join("; ")}) ---`,
      );
    }
    const learningsBlock = loadLearningsPromptBlock(project.rootPath, {
      phaseDescription: phase.description,
      phaseDoc: research,
    });
    const intent = await ensureChangeIntentAsync(
      project.rootPath,
      phase.id,
      phase.description,
      { registry: this.ctx.registry },
    );
    const intentBlock = formatChangeIntentPromptBlock(intent);
    const adjacentPack = buildAdjacentPhaseContextPack(project.rootPath, 5);
    const brandDesignAsk = changeIntentIsBrandTheming(intent);
    const themeWiringOnly = changeIntentIsThemeWiringOnly(intent);
    const designRoutingNote =
      intent.changeKind === "chrome-hide" || intent.changeKind === "backend"
        ? brandDesignAsk
          ? `
Design routing (brand/theming ask — override backend mislabel):
- Near the top of PHASE.md include \`Requires design pass: yes\`.
- Include ## Brand and ## Assets (logo / wordmark / favicon briefs).
- Decide shell scope explicitly (palette-only vs shell/theme machinery vs full layout parity).
- Automated Checks must reject \`Status:** draft\` / tile+circle fallback SVGs under public/brand/.
`
          : `
Design routing (Change Intent changeKind=${intent.changeKind}):
- Near the top of PHASE.md include \`Requires design pass: no\`.
- Do NOT add ## Brand or ## Assets unless the operator explicitly asked for a visual/brand change.
- Put behaviour/state tables under Scope / Success Criteria — not as design-asset briefs.
`
        : brandDesignAsk
          ? `
Design routing (brand/theming):
- Near the top of PHASE.md include \`Requires design pass: yes\`.
- Include ## Brand and ## Assets with concrete logo/wordmark/favicon briefs (not empty tables).
- Decide shell scope explicitly; do not freeze marketing/portal shells without stating palette-only.
- Automated Checks: no design-fallback SVGs in public/brand/; wordmarks must not glue words (e.g. JamLight); shells must reference the new lockup.
`
          : themeWiringOnly
            ? `
Design routing (theme toggle / data-theme wiring — not a brand identity pass):
- Near the top of PHASE.md include \`Requires design pass: no\`.
- If ## Brand / ## Assets appear, mark them Not applicable — do not invent logo briefs.
- Prove toggle → data-theme → token remaps with Automated Checks (unit tests / vite build), not a design-loop mock.
`
            : "";

    const draftAcceptance = readPhaseDesignAcceptance(
      project.rootPath,
      phase.id,
    );
    const draftPhasePack = readPhaseDesignPack(project.rootPath, phase.id);
    const draftAcceptanceBlock = formatAcceptancePromptBlock(draftAcceptance, {
      inScopeIds: draftPhasePack?.inScope,
      alreadyAppliedIds: draftPhasePack?.alreadyApplied,
    });
    const draftPackBlock = formatDesignPackPromptBlock(draftPhasePack);
    const draftPlanBlock = formatPhaseBoundPlanPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxPlanChars: 8_000,
    });
    const draftPlanNote = readPhasePlanPack(project.rootPath, phase.id)
      ? `
CRITICAL plan contract: Scope, File Changes, and Success Criteria MUST cover PLAN_PACK successCriteria and In scope; do NOT expand mustNot / Out of scope. Cite \`.slopcontrol/phases/${phase.id}/plan/PLAN.md\`.
${draftPlanBlock ? `\n${draftPlanBlock}\n` : ""}
`
      : draftPlanBlock
        ? `\n${draftPlanBlock}\n`
        : "";
    const draftThemeNote = (() => {
      const designShellOrTheme = Boolean(
        draftAcceptance?.features?.some(
          (f) =>
            f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
        ) ||
          draftPhasePack?.inScope?.includes("theme_modes") ||
          draftPhasePack?.inScope?.includes("applied_shell"),
      );
      const themeModes = packHasThemeModes(draftPhasePack);
      if (!themeModes && !designShellOrTheme) return "";
      const parts: string[] = [];
      if (themeModes) {
        parts.push(`CRITICAL theme_modes: Plan File Changes for html[data-theme] light remaps of semantic tokens; ThemeToggle must set data-theme; body/chrome on var(--background)/var(--foreground) — not hard-coded --color-dark-* alone.`);
      }
      parts.push(
        formatClaimProofChecksGuidance({
          shellNotes: draftPhasePack?.shell,
          designShellOrTheme: themeModes || designShellOrTheme,
        }),
      );
      return `\n${parts.join("\n")}\n`;
    })();
    const draftAntiAuditThemeNote = formatAntiAuditThemeDeliveryNote({
      description: phase.description,
      projectRoot: project.rootPath,
      phaseId: phase.id,
      requestsMissingThemeControl: intent.requestsMissingThemeControl,
      designShellOrThemeAccepted: draftAcceptance?.features?.some(
        (f) =>
          f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
      ),
    });
    const draftBoundMock = formatPhaseBoundMockPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxHtmlChars: 8_000,
    });
    const draftElementsNote = draftPhasePack?.elements?.length
      ? `
CRITICAL shared elements (DESIGN_PACK.elements):
${draftPhasePack.elements
  .map((e) => {
    const npm = e.npmPackage
      ? ` — \`pnpm add ${e.npmPackage}@${e.npmVersion ?? "*"}\` after npm_registry_ensure_rc (never npm link)`
      : e.hasCode
        ? ` from \`${e.codePath ?? "design/elements"}\``
        : "";
    return `- Mount ${e.id}@${e.version}${npm}`;
  })
  .join("\n")}
`
      : "";
    const draftCrossDepPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message: phase.description,
      listProjects: input.listProjects,
    });
    const draftAcceptanceNote = draftAcceptance?.features?.some((f) => f.accepted)
      ? `
${draftAcceptanceBlock}
CRITICAL: Scope, File Changes, Success Criteria, and Automated Checks MUST cover every IN SCOPE feature above.
Do NOT plan OUT OF SCOPE features. Unticked items are mustNot for this phase.
File Changes must reference DESIGN_PACK logos/tokens/scope/theme and \`.slopcontrol/phases/${phase.id}/design/mock.html\` — do not invent a competing mark.
${draftPlanNote}${draftThemeNote}${draftElementsNote}${draftCrossDepPack ? `\n${draftCrossDepPack}\n` : ""}${draftPackBlock ? `\n${draftPackBlock}\n` : ""}${draftBoundMock ? `\n${draftBoundMock}\n` : ""}
`
      : [draftPlanNote, draftPackBlock, draftBoundMock, draftCrossDepPack].filter(Boolean).join("\n\n")
        ? `\n${draftPlanNote}${draftThemeNote}${draftElementsNote}${[draftCrossDepPack, draftPackBlock, draftBoundMock].filter(Boolean).join("\n\n")}\n`
        : draftCrossDepPack
          ? `\n${draftCrossDepPack}\n`
          : "";

    const buildDraftPrompt = (slim: boolean) => {
      const pack = slim ? "" : adjacentPack ? `${adjacentPack}\n` : "";
      const blueprintClip = slim ? 2_500 : 6_000;
      const researchClip = slim ? 4_000 : 8_000;
      return `Draft PHASE.md for phase ${phase.id} only (single phase).
Description:
${clipPromptSection("change-request", phase.description, 4_000)}

${intentBlock}
${draftAcceptanceNote}${designRoutingNote}${draftAntiAuditThemeNote}${pack}CRITICAL: Scope and File Changes must implement THIS phase's RESEARCH.md below.
Do NOT reuse or retitle a prior phase plan (e.g. host.docker.internal / extra_hosts)
unless RESEARCH explicitly asks for that work. If RESEARCH is about model naming /
:cloud passthrough / model-resolver, the PHASE must plan that — not networking.
If Change Intent uiMount is set, Scope/File Changes/Blueprint Deltas MUST honour that mount
(composer vs bubble vs modal vs page). Do not supersede a mount BD against Change Intent.

Return the full PHASE.md content starting with # in your response.
If you use write_file, write ONLY to ${canonicalPath} (never project-root PHASE.md).
Include ## Blueprint Deltas for durable design changes.
MUST include ## Automated Checks with at least one runnable command in a \`\`\`bash fence
(e.g. npm test -- path/to/regression.test.ts). Manual-only success criteria are not enough.
When finished, include PHASE_COMPLETE on its own line.
Do NOT narrate that you wrote the file — output the document itself.
${learningsBlock ? `\n${learningsBlock}\n` : ""}
Blueprint (excerpt — full at .slopcontrol/BLUEPRINT.md; prefer Live decisions):
${clipPromptSection("BLUEPRINT.md", clipBlueprintForPrompt(blueprint, blueprintClip), blueprintClip)}

Research:
${clipPromptSection("RESEARCH.md", research, researchClip)}`;
    };

    const watch = phaseDocWatchPaths(project.rootPath, phase.id);
    let beforeStats = snapshotFileStats(watch);

    const finishWithScaffold = (reason: string): RunStage | void => {
      if (intent.interaction && intent.interaction.mount !== "n/a") {
        log(
          project,
          run,
          `${reason}\n--- Engagement Change Intent: refusing Intent-breaking scaffold; fail closed (retry draft) ---`,
        );
        writePhaseStatus(project.rootPath, phase.id, "draft");
        writeDiagnosis(
          project.rootPath,
          run.id,
          buildPlanningFailureDiagnosis({
            stage: "draft",
            title: "Draft rejected: engagement Change Intent (no scaffold)",
            detail: `${reason}\nRefusing Intent-breaking scaffold for interaction mount=${intent.interaction.mount}.`,
            phaseId: phase.id,
            runId: run.id,
            kind: "change-intent-scaffold-refused",
            operatorActions: [
              "Retry draft so Success Criteria / Automated Checks prove fill+submit at the locked mount and live AI SDK static tool-part name resolution (type: tool-<name> / parseToolResult / extractActiveForm).",
              "Do not rely on summary-chip-only or tool-invocation+toolName fixtures.",
            ],
          }),
          phase.id,
        );
        return "failed";
      }
      const scaffolded = scaffoldPhaseDoc({
        phaseId: phase.id,
        description: phase.description,
        research,
        testCommand: config.testCommand,
        intent,
        projectRoot: project.rootPath,
      });
      log(project, run, reason);
      writePhaseDoc(project.rootPath, phase.id, scaffolded);
    };

    const recoverableDraftFail = (
      detail: string,
      opts?: { title?: string; kind?: string },
    ): RunStage => {
      log(
        project,
        run,
        `ERROR drafting PHASE.md (research intact). Handoff: retry draft.\n${detail}`,
      );
      writePhaseStatus(project.rootPath, phase.id, "draft");
      const kind =
        opts?.kind ??
        (/change intent|tool-<|parseToolResult|extractActiveForm|uiMount/i.test(
          detail,
        )
          ? "change-intent"
          : "draft-failed");
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "draft",
          title: opts?.title ?? "Draft rejected",
          detail,
          phaseId: phase.id,
          runId: run.id,
          kind,
        }),
        phase.id,
      );
      return "failed";
    };

    const intentIssuesForDoc = (doc: string): string[] => {
      if (!doc?.trim()) return [];
      const align = phaseDocAlignsWithChangeIntent(doc, intent);
      return align.ok ? [] : align.issues;
    };

    let output: string | null = null;
    let phaseDocWritten = false;
    try {
      output = await runAgent(
        this.ctx.agents.phasePlannerAgent,
        buildDraftPrompt(false),
        project.id,
        `${phase.id}-planning`,
        { maxSteps: 20 },
      );
    } catch (error) {
      const detail = formatLlmErrorForLog(error);
      log(project, run, `ERROR: draft generate failed — ${detail}`);
      if (isProviderBadRequest(error)) {
        log(
          project,
          run,
          "--- Retrying draft once with slimmed prompt (no adjacent pack, smaller clips) ---",
        );
        try {
          beforeStats = snapshotFileStats(watch);
          output = await runAgent(
            this.ctx.agents.phasePlannerAgent,
            buildDraftPrompt(true),
            project.id,
            `${phase.id}-planning-slim`,
            { maxSteps: 16 },
          );
        } catch (retryError) {
          const retryDetail = formatLlmErrorForLog(retryError);
          log(project, run, `ERROR: slim draft retry failed — ${retryDetail}`);
          if (researchLooksSolid(research)) {
            const scaffolded = finishWithScaffold(
              `Draft LLM threw after solid RESEARCH.md (${retryDetail}). Using scaffold so review can proceed. Handoff: retry draft if scaffold is insufficient.`,
            );
            if (scaffolded === "failed") return scaffolded;
            phaseDocWritten = true;
          } else {
            return recoverableDraftFail(retryDetail);
          }
        }
      } else if (researchLooksSolid(research)) {
        const scaffolded = finishWithScaffold(
          `Draft LLM threw after solid RESEARCH.md (${detail}). Using scaffold so review can proceed. Handoff: retry draft if scaffold is insufficient.`,
        );
        if (scaffolded === "failed") return scaffolded;
        phaseDocWritten = true;
      } else {
        return recoverableDraftFail(detail);
      }
    }

    if (output != null && !phaseDocWritten) {
      log(project, run, output);

      let resolved = resolvePhaseDocFromAgentTurn({
        projectRoot: project.rootPath,
        phaseId: phase.id,
        agentOutput: output,
        beforeStats,
        description: phase.description,
        research,
      });

      let intentIssues =
        resolved.source !== "none" && resolved.gate.ok
          ? intentIssuesForDoc(resolved.doc)
          : [];

      const needsRepair =
        !resolved.gate.ok ||
        resolved.source === "none" ||
        (resolved.alignIssues?.length ?? 0) > 0 ||
        intentIssues.length > 0;

      if (needsRepair) {
        const alignBlock =
          resolved.alignIssues && resolved.alignIssues.length > 0
            ? `Research alignment issues:\n${resolved.alignIssues.map((i) => `- ${i}`).join("\n")}\n`
            : "";
        const intentBlockRepair =
          intentIssues.length > 0
            ? `Change Intent alignment issues (MUST fix in ## Success Criteria and ## Automated Checks — not only File Changes / Known limitations):\n${intentIssues.map((i) => `- ${i}`).join("\n")}\n`
            : "";
        slog.warn("planning", "PHASE.md failed structure/alignment/intent gate; retrying once", {
          projectId: project.id,
          phaseId: phase.id,
          issues: resolved.gate.issues,
          alignIssues: resolved.alignIssues,
          intentIssues,
          source: resolved.source,
          path: resolved.path,
        });
        const repairPrompt = `Your previous PHASE.md was invalid (chat preamble, missing sections, wrong-phase content, or Change Intent misalignment).
Issues:
${resolved.gate.issues.map((i) => `- ${i}`).join("\n")}
${alignBlock}${intentBlockRepair}
${formatChangeIntentPromptBlock(intent)}
Rewrite the FULL PHASE.md starting with # Title — output ONLY the markdown document (no "here is what changed").
If you use write_file, path must be exactly: ${canonicalPath}
Required sections: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence, no curl with API keys), ## Blueprint Deltas.
Base Scope/File Changes ONLY on the RESEARCH below — do not copy a prior phase's host-routing plan.
Obey Change Intent uiMount / interaction contract — do not substitute chips for a fillable mount.
When Change Intent has an engagement interaction: ## Success Criteria and ## Automated Checks MUST prove fill+submit at the locked mount AND live AI SDK static tool-part name resolution (type: "tool-<name>" / parseToolResult / extractActiveForm) — not only tool-invocation + toolName fixtures. Put those proofs in Success Criteria / Automated Checks, not only in File Changes or Known limitations.
End with PHASE_COMPLETE.

Description:
${clipPromptSection("change-request", phase.description, 4_000)}
Research:
${clipPromptSection("RESEARCH.md", research, 8_000)}`;
        let repairThrew = false;
        try {
          beforeStats = snapshotFileStats(watch);
          const repaired = await runAgent(
            this.ctx.agents.phasePlannerAgent,
            repairPrompt,
            project.id,
            `${phase.id}-planning-repair`,
            { maxSteps: 16 },
          );
          log(project, run, repaired);
          resolved = resolvePhaseDocFromAgentTurn({
            projectRoot: project.rootPath,
            phaseId: phase.id,
            agentOutput: repaired,
            beforeStats,
            description: phase.description,
            research,
          });
          intentIssues =
            resolved.source !== "none" && resolved.gate.ok
              ? intentIssuesForDoc(resolved.doc)
              : [];
        } catch (repairError) {
          repairThrew = true;
          const repairDetail = formatLlmErrorForLog(repairError);
          log(project, run, `ERROR: draft repair failed — ${repairDetail}`);
          if (researchLooksSolid(research)) {
            const scaffolded = finishWithScaffold(
              `Draft repair threw after solid RESEARCH.md (${repairDetail}). Using scaffold so review can proceed.`,
            );
            if (scaffolded === "failed") return scaffolded;
            phaseDocWritten = true;
          } else {
            return recoverableDraftFail(repairDetail);
          }
        }

        if (!repairThrew) {
          const stillBad =
            !resolved.gate.ok ||
            resolved.source === "none" ||
            (resolved.alignIssues?.length ?? 0) > 0 ||
            intentIssues.length > 0;

          if (stillBad) {
            if (intentIssues.length > 0 && researchLooksSolid(research)) {
              // Prefer fail-closed with diagnosis over Intent-breaking scaffold.
              return recoverableDraftFail(
                [
                  ...resolved.gate.issues,
                  ...(resolved.alignIssues ?? []),
                  ...intentIssues,
                ].join("; "),
                {
                  title: "Draft rejected: Change Intent",
                  kind: "change-intent",
                },
              );
            }
            const scaffolded = finishWithScaffold(
              `PHASE.md still invalid after repair (${[
                ...resolved.gate.issues,
                ...(resolved.alignIssues ?? []),
                ...intentIssues,
              ].join("; ")}). Using scaffold so review can proceed.`,
            );
            if (scaffolded === "failed") return scaffolded;
          } else {
            if (resolved.source === "tool_write" && resolved.path) {
              log(
                project,
                run,
                `--- Harvested PHASE.md from ${resolved.path} (source=${resolved.source}) ---`,
              );
            }
            writePhaseDoc(project.rootPath, phase.id, resolved.doc);
          }
          phaseDocWritten = true;
        }
      } else {
        if (resolved.source === "tool_write" && resolved.path) {
          log(
            project,
            run,
            `--- Harvested PHASE.md from ${resolved.path} (source=${resolved.source}) ---`,
          );
        }
        writePhaseDoc(project.rootPath, phase.id, resolved.doc);
        phaseDocWritten = true;
      }
    }

    const phaseDoc = readPhaseDoc(project.rootPath, phase.id);
    const gate = validatePhaseDocForDev(phaseDoc, {
      projectRoot: project.rootPath,
      phaseId: phase.id,
    });
    const claimRefined = await refineClaimProofGateIssues(
      this.ctx.registry,
      phaseDoc,
      gate.issues,
      { projectRoot: project.rootPath, phaseId: phase.id },
    );
    for (const warning of claimRefined.warnings) {
      log(project, run, `claim-vs-proof: ${warning}`);
    }
    const gateIssues = claimRefined.issues;
    const align = phaseDocAlignsWithResearch(
      phaseDoc,
      research,
      phase.description,
    );
    const antiAudit = phaseDocRejectsMissingThemeAudit({
      description: phase.description,
      phaseDoc,
      projectRoot: project.rootPath,
      phaseId: phase.id,
      requestsMissingThemeControl: intent.requestsMissingThemeControl,
      designShellOrThemeAccepted: draftAcceptance?.features?.some(
        (f) =>
          f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
      ),
    });
    if (gateIssues.length > 0) {
      log(
        project,
        run,
        `PHASE.md still invalid after scaffold:\n${gateIssues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(gateIssues.join("; "), {
          title: "Draft rejected: PHASE structure",
          kind: "phase-structure",
        });
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "draft",
          title: "Draft blocked: PHASE structure",
          detail: gateIssues.join("; "),
          phaseId: phase.id,
          runId: run.id,
          kind: "phase-structure-blocked",
        }),
        phase.id,
      );
      return "failed";
    }
    if (!align.ok) {
      log(
        project,
        run,
        `PHASE.md still misaligned with RESEARCH after scaffold:\n${align.issues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(align.issues.join("; "), {
          title: "Draft rejected: RESEARCH alignment",
          kind: "research-align",
        });
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "draft",
          title: "Draft blocked: RESEARCH alignment",
          detail: align.issues.join("; "),
          phaseId: phase.id,
          runId: run.id,
          kind: "research-align-blocked",
        }),
        phase.id,
      );
      return "failed";
    }
    if (!antiAudit.ok) {
      log(
        project,
        run,
        `PHASE.md review-only audit rejected for missing theme control:\n${antiAudit.issues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(antiAudit.issues.join("; "), {
          title: "Draft rejected: theme audit",
          kind: "theme-audit",
        });
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "draft",
          title: "Draft blocked: theme audit",
          detail: antiAudit.issues.join("; "),
          phaseId: phase.id,
          runId: run.id,
          kind: "theme-audit-blocked",
        }),
        phase.id,
      );
      return "failed";
    }
    const intentAlign = phaseDocAlignsWithChangeIntent(phaseDoc, intent);
    if (!intentAlign.ok) {
      log(
        project,
        run,
        `PHASE.md misaligned with Change Intent uiMount=${intent.uiMount}:\n${intentAlign.issues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(intentAlign.issues.join("; "), {
          title: "Draft rejected: Change Intent",
          kind: "change-intent",
        });
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
      writeDiagnosis(
        project.rootPath,
        run.id,
        buildPlanningFailureDiagnosis({
          stage: "draft",
          title: "Draft blocked: Change Intent",
          detail: intentAlign.issues.join("; "),
          phaseId: phase.id,
          runId: run.id,
          kind: "change-intent-blocked",
        }),
        phase.id,
      );
      return "failed";
    }

    writePhaseStatus(project.rootPath, phase.id, "in_review");
    upsertRoadmapEntry(
      project.rootPath,
      phase.id,
      phase.title ?? phase.description.slice(0, 80),
      "in_review",
      phase.dependsOn ?? [],
    );

    return "in_review";
  }

  async submitReview(input: ReviewInput): Promise<RunStage> {
    const { project, phase, run, decision, feedback } = input;

    if (decision === "approve") {
      const phaseDoc = readPhaseDoc(project.rootPath, phase.id);
      const gate = validatePhaseDocForDev(phaseDoc, {
        projectRoot: project.rootPath,
        phaseId: phase.id,
      });
      const claimRefined = await refineClaimProofGateIssues(
        this.ctx.registry,
        phaseDoc,
        gate.issues,
        { projectRoot: project.rootPath, phaseId: phase.id },
      );
      for (const warning of claimRefined.warnings) {
        log(project, run, `claim-vs-proof: ${warning}`);
      }
      if (claimRefined.issues.length > 0) {
        log(
          project,
          run,
          `--- Cannot approve: PHASE.md failed validation ---\n${claimRefined.issues.map((i) => `- ${i}`).join("\n")}`,
        );
        writePhaseStatus(project.rootPath, phase.id, "in_review");
        return "in_review";
      }
      const intent = await ensureChangeIntentAsync(
        project.rootPath,
        phase.id,
        phase.description,
        { registry: this.ctx.registry },
      );
      const intentAlign = phaseDocAlignsWithChangeIntent(phaseDoc, intent);
      if (!intentAlign.ok) {
        log(
          project,
          run,
          `--- Cannot approve: PHASE.md misaligned with Change Intent ---\n${intentAlign.issues.map((i) => `- ${i}`).join("\n")}`,
        );
        writePhaseStatus(project.rootPath, phase.id, "in_review");
        return "in_review";
      }
      const antiAudit = phaseDocRejectsMissingThemeAudit({
        description: phase.description,
        phaseDoc,
        projectRoot: project.rootPath,
        phaseId: phase.id,
        requestsMissingThemeControl: intent.requestsMissingThemeControl,
      });
      if (!antiAudit.ok) {
        log(
          project,
          run,
          `--- Cannot approve: review-only PHASE rejected for missing theme control ---\n${antiAudit.issues.map((i) => `- ${i}`).join("\n")}`,
        );
        writePhaseStatus(project.rootPath, phase.id, "in_review");
        return "in_review";
      }
      writePhaseStatus(project.rootPath, phase.id, "accepted");
      mergePhaseIntoBlueprint(
        project.rootPath,
        phase.id,
        phaseDoc,
        phase.description,
      );
      upsertRoadmapEntry(
        project.rootPath,
        phase.id,
        phase.title ?? phase.description.slice(0, 80),
        "accepted",
        phase.dependsOn ?? [],
      );
      log(project, run, "--- Phase approved; ready for development ---");
      return "accepted";
    }

    log(project, run, `--- Review feedback ---\n${feedback ?? ""}`);
    const canonicalPath = `.slopcontrol/phases/${phase.id}/PHASE.md`;
    const research = readResearch(project.rootPath, phase.id);
    const intent = await ensureChangeIntentAsync(
      project.rootPath,
      phase.id,
      phase.description,
      { registry: this.ctx.registry },
    );
    const intentBlock = formatChangeIntentPromptBlock(intent);
    const brandAsk = changeIntentIsBrandTheming(intent);
    const themeWiringOnly = changeIntentIsThemeWiringOnly(intent);
    const designRoutingNote =
      intent.changeKind === "chrome-hide" || intent.changeKind === "backend"
        ? brandAsk
          ? `
Design routing (brand/theming ask — override backend mislabel):
- Keep or add \`Requires design pass: yes\` near the top of PHASE.md.
- Include ## Brand and ## Assets; do not drop them on revise.
`
          : `
Design routing (Change Intent changeKind=${intent.changeKind}):
- Keep or add \`Requires design pass: no\` near the top of PHASE.md.
- Do NOT add ## Brand or ## Assets unless the operator feedback explicitly asks for a visual/brand change.
- Behaviour/state tables belong under Scope / Success Criteria — not as design-asset briefs.
`
        : brandAsk
          ? `
Design routing (brand/theming):
- Keep \`Requires design pass: yes\` and ## Brand / ## Assets.
- Automated Checks must reject design-fallback SVGs under public/brand/.
`
          : themeWiringOnly
            ? `
Design routing (theme toggle / data-theme wiring — not a brand identity pass):
- Keep or add \`Requires design pass: no\` near the top of PHASE.md.
- If ## Brand / ## Assets appear, mark them Not applicable.
`
            : "";
    const prompt = `Revise PHASE.md based on this feedback:\n${feedback ?? ""}

${intentBlock}
${designRoutingNote}Return the full revised PHASE.md content starting with # (document only, no chat).
If you use write_file, write ONLY to ${canonicalPath}.
Include "## Blueprint Deltas" for durable design changes.
Keep ## Automated Checks with a \`\`\`bash fence.
Keep Scope/File Changes aligned with RESEARCH for this phase — do not substitute a prior phase's plan.
Obey Change Intent uiMount / interaction — do not replace fillable mounts with chips only.
When finished, include PHASE_COMPLETE on its own line.

Current phase doc:
${readPhaseDoc(project.rootPath, phase.id)}

Research:
${clipPromptSection("RESEARCH.md", research, 6_000)}`;

    const watch = phaseDocWatchPaths(project.rootPath, phase.id);
    const beforeStats = snapshotFileStats(watch);
    const output = await runAgent(
      this.ctx.agents.reviewAgent,
      prompt,
      project.id,
      `${phase.id}-review`,
      { maxSteps: 16 },
    );

    log(project, run, output);
    const resolved = resolvePhaseDocFromAgentTurn({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      agentOutput: output,
      beforeStats,
      description: phase.description,
      research,
    });
    if (resolved.gate.ok && resolved.source !== "none") {
      log(
        project,
        run,
        `--- Harvested revised PHASE.md (source=${resolved.source}${resolved.path ? `, path=${resolved.path}` : ""}) ---`,
      );
      writePhaseDoc(project.rootPath, phase.id, resolved.doc);
    } else {
      const issues = [
        ...resolved.gate.issues,
        ...(resolved.alignIssues ?? []),
      ];
      log(
        project,
        run,
        `--- PHASE harvest failed after review (source=${resolved.source}); keeping prior PHASE.md ---\n${issues.map((i) => `- ${i}`).join("\n") || "- no structure-valid candidate"}`,
      );
      // Never write raw agent output / truncated extract over a prior doc.
    }
    writePhaseStatus(project.rootPath, phase.id, "in_review");
    return "in_review";
  }

  async startDesign(input: {
    project: Project;
    phase: Phase;
    run: Run;
    signal?: AbortSignal;
    /** When true, re-run design even if DESIGN_COMPLETE + UI-SPEC already exist. */
    force?: boolean;
  }): Promise<{ stage: RunStage; worktreePath?: string; worktreeBranch?: string }> {
    const { project, phase, run, signal, force } = input;
    const config = readProjectConfig(project.rootPath);

    if (
      !force &&
      isDesignComplete(project.rootPath, phase.id) &&
      readUiSpec(project.rootPath, phase.id).trim()
    ) {
      log(
        project,
        run,
        "--- Design already complete (UI-SPEC + DESIGN_COMPLETE); skipping (pass force to redo) ---",
      );
      writePhaseStatus(project.rootPath, phase.id, "design_complete");
      const existing = ensurePhaseWorktree({
        projectRoot: project.rootPath,
        projectId: project.id,
        phaseId: phase.id,
        dataDir: this.ctx.dataDir,
        syncPaths: config.worktreeSyncPaths,
      });
      return {
        stage: "design_complete",
        worktreePath: existing.path,
        worktreeBranch: existing.branch,
      };
    }

    writePhaseStatus(project.rootPath, phase.id, "designing");
    log(project, run, "--- Starting design stage ---");
    appendAppendix(project.rootPath, phase.id, "## Design pass started\n");

    const worktree = ensurePhaseWorktree({
      projectRoot: project.rootPath,
      projectId: project.id,
      phaseId: phase.id,
      dataDir: this.ctx.dataDir,
      syncPaths: config.worktreeSyncPaths,
    });
    log(
      project,
      run,
      `--- Worktree ready for design: ${worktree.path} (branch ${worktree.branch}) ---`,
    );

    if (signal?.aborted) {
      writePhaseStatus(project.rootPath, phase.id, "interrupted");
      return {
        stage: "interrupted",
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      };
    }

    const phaseDoc = readPhaseDoc(project.rootPath, phase.id);
    const existingUiSpec = readUiSpec(project.rootPath, phase.id);
    const assetDirRel = config.designAssetDir || "public/brand";
    const canonicalUiSpecPath = `.slopcontrol/phases/${phase.id}/UI-SPEC.md`;
    const canonicalTokensPath = `.slopcontrol/phases/${phase.id}/design/tokens.css`;
    const existingMockPath = join(
      project.rootPath,
      ".slopcontrol",
      "phases",
      phase.id,
      "design",
      "mock.html",
    );
    const existingMock = existsSync(existingMockPath)
      ? readFileSync(existingMockPath, "utf-8")
      : "";
    const mockContractBlock = existingMock.trim()
      ? `\nAccepted design-loop mock (honor this visual contract — do not invent a competing shell):\n\`\`\`html\n${existingMock.trim().slice(0, 12_000)}\n\`\`\`\n`
      : "";

    const prompt = `Produce UI-SPEC.md and tokens.css for this phase.
${mockContractBlock}
Write UI-SPEC to ${canonicalUiSpecPath} (start with # UI-SPEC).
Write tokens.css to ${canonicalTokensPath}.
Include ## Assets table (Name | Filename | Prompt), max 3 assets.
End with UI_SPEC_COMPLETE.

Phase description: ${phase.description}

${clipPromptSection("PHASE.md", phaseDoc, 8_000)}

${existingUiSpec.trim() ? clipPromptSection("UI-SPEC.md (existing)", existingUiSpec, 4_000) : "(no existing UI-SPEC)"}

Worktree asset dir (for later coding): ${assetDirRel}
`;

    const output = await runAgent(
      this.ctx.agents.designAgent,
      prompt,
      project.id,
      `${phase.id}-design`,
      { maxSteps: 20 },
    );
    log(project, run, output);

    if (signal?.aborted) {
      writePhaseStatus(project.rootPath, phase.id, "interrupted");
      return {
        stage: "interrupted",
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      };
    }

    const harvestedUi = harvestUiSpecFromAgentOutput(output);
    if (harvestedUi.trim()) {
      writeUiSpec(project.rootPath, phase.id, harvestedUi);
      log(project, run, "--- Harvested UI-SPEC.md from design agent ---");
    } else if (existsSync(join(project.rootPath, canonicalUiSpecPath))) {
      // Agent wrote via tool; re-read
      const fromDisk = readUiSpec(project.rootPath, phase.id);
      if (fromDisk.trim()) {
        log(project, run, "--- Using tool-written UI-SPEC.md ---");
      }
    } else if (!existingUiSpec.trim()) {
      // Minimal scaffold so design can still produce assets from PHASE Brand/Assets
      const scaffold = `# UI-SPEC

## Palette
- Derived from PHASE Brand/Assets

## Typography
- System UI stack pending refine

## Layout
- See PHASE.md

## Logo brief
${extractSection(phaseDoc, /Brand/i)?.trim().slice(0, 400) || phase.description}

## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| logo | logo.png | ${phase.description.slice(0, 120)} brand mark |
`;
      writeUiSpec(project.rootPath, phase.id, scaffold);
      log(project, run, "--- Scaffolded minimal UI-SPEC.md ---");
    }

    const tokens = harvestTokensCssFromAgentOutput(output);
    if (tokens.trim()) {
      writeTokensCss(project.rootPath, phase.id, tokens);
      const wtTokensDir = join(worktree.path, assetDirRel);
      mkdirSync(wtTokensDir, { recursive: true });
      writeFileSync(join(wtTokensDir, "tokens.css"), tokens, "utf-8");
      log(project, run, `--- Wrote tokens.css (phase design/ + ${assetDirRel}/) ---`);
    }

    ensureDesignDir(project.rootPath, phase.id);
    const uiSpec = readUiSpec(project.rootPath, phase.id);
    const briefs = parseDesignAssetBriefs(
      `${uiSpec}\n${phaseDoc}`,
      3,
    );
    const designTool = getDesignTool(config.designToolId);
    const imageBinding = this.ctx.registry.tryResolveDesignImage(
      config.roleBindings,
    );
    const palette =
      extractSection(uiSpec, /Palette/i)
        ?.match(/#[0-9a-fA-F]{3,8}/g)
        ?.slice(0, 5) ?? undefined;
    const brandName =
      extractSection(phaseDoc, /Brand/i)?.split("\n")[0]?.replace(/^[#*\-\s]+/, "").trim() ||
      project.name;

    const generatedPaths: string[] = [];
    const logoBlockers: string[] = [];
    for (const brief of briefs) {
      if (signal?.aborted) break;
      const phaseOut = join(
        ensureDesignDir(project.rootPath, phase.id),
        brief.filename,
      );
      const wtOut = join(worktree.path, assetDirRel, brief.filename);
      mkdirSync(dirname(wtOut), { recursive: true });

      const logoFailClosed = isLogoAssetBrief(brief);
      const result = await designTool.generateImage({
        prompt: brief.prompt,
        outPath: phaseOut,
        endpoint: imageBinding?.endpoint,
        modelId: imageBinding?.modelId,
        brandName,
        palette,
        logoFailClosed,
      });

      if (result.reason === "logo_requires_designImage") {
        logoBlockers.push(brief.name);
        log(
          project,
          run,
          `--- Asset ${brief.name}: BLOCKED (logo requires designImage — bind openai-images endpoint, e.g. pull x/flux2-klein; do not accept svg_fallback) ---`,
        );
        continue;
      }

      generatedPaths.push(result.path);
      const wtTarget =
        result.format === "svg"
          ? wtOut.replace(/\.(png|webp|jpe?g)$/i, ".svg")
          : wtOut;
      try {
        mkdirSync(dirname(wtTarget), { recursive: true });
        copyFileSync(result.path, wtTarget);
      } catch (error) {
        log(
          project,
          run,
          `--- Failed to copy asset to worktree: ${error instanceof Error ? error.message : String(error)} ---`,
        );
      }
      log(
        project,
        run,
        `--- Asset ${brief.name}: ${result.path}${result.skipped ? ` (${result.reason ?? "fallback"})` : ""} ---`,
      );
    }

    if (logoBlockers.length > 0) {
      const msg = `Design cannot complete: logo/mark asset(s) [${logoBlockers.join(", ")}] require a bound designImage role (openai-images). Pull e.g. x/flux2-klein, add ollama-image endpoint, bind roles.designImage. svg_fallback is not accepted for logos.`;
      log(project, run, `ERROR: ${msg}`);
      appendAppendix(
        project.rootPath,
        phase.id,
        `## Design blocked — designImage required\n\n${msg}\n`,
      );
      writePhaseStatus(project.rootPath, phase.id, "accepted");
      return {
        stage: "failed",
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      };
    }

    const vision = this.ctx.registry.tryResolveDesignVision(config.roleBindings);
    if (vision && generatedPaths.length > 0 && !signal?.aborted) {
      const rasterPaths = filterRasterVisionPaths(generatedPaths.slice(0, 3));
      if (rasterPaths.length === 0) {
        log(
          project,
          run,
          "--- Design vision review skipped (SVG-only assets; providers reject image/svg+xml) ---",
        );
      } else {
        try {
          const critique = await chatWithImages({
            endpoint: vision.endpoint,
            modelId: vision.modelId,
            imagePaths: rasterPaths,
            prompt: `Critique these design assets against the brief. Be concise (bullet points).\n\nBrief:\n${clipPromptSection("UI-SPEC", uiSpec, 2_000)}`,
          });
          appendAppendix(
            project.rootPath,
            phase.id,
            `## Design vision review\n\n${critique.text}\n`,
          );
          log(project, run, "--- Design vision review appended to APPENDIX ---");
        } catch (error) {
          log(
            project,
            run,
            `--- Design vision review skipped: ${error instanceof Error ? error.message : String(error)} ---`,
          );
        }
      }
    } else if (!vision) {
      log(
        project,
        run,
        "--- Design vision review skipped (designVision unbound or not vision-capable) ---",
      );
    }

    markDesignComplete(project.rootPath, phase.id);
    writePhaseStatus(project.rootPath, phase.id, "design_complete");
    appendAppendix(project.rootPath, phase.id, "## Design pass complete\n");
    log(project, run, "--- Design stage complete; ready for development ---");

    return {
      stage: "design_complete",
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
    };
  }

  async startDevelopment(input: {
    project: Project;
    phase: Phase;
    run: Run;
    signal?: AbortSignal;
    /** When true, run design first if the phase needs it and design is incomplete. */
    autoDesign?: boolean;
    listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  }): Promise<{ stage: RunStage; worktreePath?: string; worktreeBranch?: string }> {
    const { project, phase, run, signal, autoDesign } = input;
    const config = readProjectConfig(project.rootPath);

    if (
      autoDesign &&
      phaseNeedsDesign(project.rootPath, phase.id, config) &&
      !isDesignComplete(project.rootPath, phase.id)
    ) {
      log(project, run, "--- autoDesign: running design stage first ---");
      const designResult = await this.startDesign({
        project,
        phase,
        run,
        signal,
      });
      if (designResult.stage !== "design_complete") {
        return designResult;
      }
    }

    writePhaseStatus(project.rootPath, phase.id, "developing");
    log(project, run, "--- Starting development ---");
    appendAppendix(
      project.rootPath,
      phase.id,
      "## Develop pass started\n",
    );

    const worktree = ensurePhaseWorktree({
      projectRoot: project.rootPath,
      projectId: project.id,
      phaseId: phase.id,
      dataDir: this.ctx.dataDir,
      syncPaths: config.worktreeSyncPaths,
    });
    log(
      project,
      run,
      `--- Worktree ready: ${worktree.path} (branch ${worktree.branch}) ---`,
    );
    if (worktree.syncedFiles?.length) {
      log(
        project,
        run,
        `--- Synced local files into worktree: ${worktree.syncedFiles.join(", ")} ---`,
      );
    }
    {
      const projectEnv = resolveProjectEnv({
        projectRoot: project.rootPath,
        config,
      });
      const llm = await resolveLlmTestEnvWithProbe({
        projectRoot: project.rootPath,
        config,
      });
      const written = writeResolvedEnvToWorktree({
        worktreePath: worktree.path,
        env: { ...projectEnv.env, ...llm.env },
      });
      const snap = snapshotCanonicalRuntimeEnv(project.rootPath);
      log(
        project,
        run,
        `--- Canonical runtime snapshot: DB_PORT=${snap.dbPort} ports=[${snap.publishedPorts.join(",")}] ---`,
      );
      const isolation = applyWorktreeComposeIsolation({
        worktreePath: worktree.path,
        phaseId: phase.id,
      });
      log(
        project,
        run,
        `--- Wrote ${written} (${Object.keys(projectEnv.env).length}+ LLM keys) for worktree/CI parity ---`,
      );
      log(
        project,
        run,
        `--- Worktree compose isolation: COMPOSE_PROJECT_NAME=${isolation.projectName} DB_PORT=${isolation.dbPort} ---`,
      );
    }
    const codingTool = getCodingToolForProject({
      toolId: config.codingToolId,
      projectId: project.id,
      projectRoot: project.rootPath,
    });
    const { endpoint, modelId } = this.ctx.registry.resolveEndpointForRole(
      "coding",
      config.roleBindings,
    );
    slog.info("development", "coding session", {
      projectId: project.id,
      phaseId: phase.id,
      runId: run.id,
      codingToolId: config.codingToolId,
      endpointId: endpoint.id,
      modelId,
      worktree: worktree.path,
    });

    const createCodingSession = async () =>
      codingTool.createSession({
        projectDir: worktree.path,
        endpoint,
        modelId,
        onEvent: (event) => {
          log(
            project,
            run,
            `[opencode:${event.type}] ${safeJsonForLog(event.payload, 500)}`,
          );
        },
      });

    let session = await createCodingSession();

    const blueprint = readBlueprint(project.rootPath);
    let phaseDoc = readPhaseDoc(project.rootPath, phase.id);
    const intent = await ensureChangeIntentAsync(
      project.rootPath,
      phase.id,
      phase.description,
      { registry: this.ctx.registry },
    );
    const intentBlock = formatChangeIntentPromptBlock(intent);
    // Prefer Live decisions; keep blueprint excerpt small to reduce tool-wander.
    const blueprintExcerpt = blueprint.trim()
      ? clipBlueprintForPrompt(blueprint, 4_000)
      : "";
    const learningsBlock = loadLearningsPromptBlock(project.rootPath, {
      phaseDescription: phase.description,
      phaseDoc,
    });
    const uiSpecDoc = readUiSpec(project.rootPath, phase.id);
    const tokensCss = readTokensCss(project.rootPath, phase.id);
    const designAssetPaths = listDesignAssetPaths(project.rootPath, phase.id);
    const designMockPath = join(
      project.rootPath,
      ".slopcontrol",
      "phases",
      phase.id,
      "design",
      "mock.html",
    );
    const designMockHtml = existsSync(designMockPath)
      ? readFileSync(designMockPath, "utf-8")
      : "";
    const developAcceptance = readPhaseDesignAcceptance(
      project.rootPath,
      phase.id,
    );
    const developPhasePack = readPhaseDesignPack(project.rootPath, phase.id);
    const developAcceptanceBlock = formatAcceptancePromptBlock(
      developAcceptance,
      {
        inScopeIds: developPhasePack?.inScope,
        alreadyAppliedIds: developPhasePack?.alreadyApplied,
      },
    );
    const developPackBlock = formatDesignPackPromptBlock(developPhasePack);
    const developThemeNote = packHasThemeModes(developPhasePack)
      ? `CRITICAL: Implement DESIGN_PACK.theme — html[data-theme] toggle, light token remaps for --background/--surface/--foreground, body/chrome on semantic vars (not hard-coded --color-dark-* alone).`
      : null;
    const developElementsNote = developPhasePack?.elements?.length
      ? `CRITICAL elements: ${developPhasePack.elements
          .map((e) =>
            e.npmPackage
              ? `${e.id} via pnpm add ${e.npmPackage}@${e.npmVersion ?? "*"} (never npm link)`
              : e.id,
          )
          .join("; ")}`
      : null;
    const developCrossDepPack = await this.buildCrossProjectDependencyPrompt({
      projectRoot: project.rootPath,
      message: phase.description,
      listProjects: input.listProjects,
    });
    const designContext = [
      developAcceptance?.features?.length ? developAcceptanceBlock : null,
      developThemeNote,
      developElementsNote,
      developCrossDepPack || null,
      developPackBlock || null,
      uiSpecDoc.trim()
        ? clipPromptSection("UI-SPEC.md", uiSpecDoc, 6_000)
        : null,
      tokensCss.trim()
        ? `tokens.css (from design pass)\n\n\`\`\`css\n${tokensCss.trim().slice(0, 3_000)}\n\`\`\``
        : null,
      designMockHtml.trim()
        ? `Accepted design-loop mock (visual source of truth for **accepted features only** — do not invent a competing shell):\n\`\`\`html\n${designMockHtml.trim().slice(0, 12_000)}\n\`\`\``
        : null,
      designAssetPaths.length
        ? `Design assets (use these paths; do not reinvent logos from scratch):\n${designAssetPaths.map((p) => `- ${p}`).join("\n")}\nPrefer project \`public/brand/\` copies when present.`
        : null,
    ]
      .filter(Boolean)
      .join("\n\n");
    const contextSystem = [
      `You are editing a git worktree at ${worktree.path} on branch ${worktree.branch}.`,
      `Project artifacts live in the main tree at ${project.rootPath}/.slopcontrol — follow them.`,
      intentBlock,
      phaseDoc.trim() ? `PHASE.md\n\n${phaseDoc}` : null,
      designContext.trim() ? designContext : null,
      blueprintExcerpt
        ? `BLUEPRINT.md (excerpt — prefer Live decisions)\n\n${blueprintExcerpt}`
        : null,
      learningsBlock.trim() ? learningsBlock : null,
      "Infra failures (ECONNREFUSED / unreachable runtime services) are NOT app bugs — do not invent bring-up scripts; stop and report.",
      "Obey Change Intent uiMount: do not move interactive forms away from the locked mount; do not replace fillable UI with chips only.",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    let iteration = 0;
    let noProgressCount = 0;
    let stallStrikeCount = 0;
    let infraStrikeCount = 0;
    let diagnosisStreak = 0;
    let lastDiagnosisFingerprint = "";
    let lastErrorHash = "";
    let lastErrorCount = Number.POSITIVE_INFINITY;
    let lastAbortWasProductiveTimeout = false;
    let lastFailWasPostMergeRootVerify = false;
    const MAX_DIAGNOSIS_STREAK = 3;
    const MAX_STALL_STRIKES = 3;
    const memory = readRunMemory(project.rootPath, run.id);
    let needsFreshSession = false;
    let terminalStage: RunStage | null = null;
    let lastDiagnosisCard = "";
    let lastChecksOk: boolean | undefined;
    let lastChecksSummary = "";
    let lastMergeInfo: HandoffMergeInfo = {
      autoMerged: false,
      worktreePresent: true,
      branch: worktree.branch,
    };
    const priorDiagnosis = readLatestDiagnosisForPhase(
      project.rootPath,
      phase.id,
    );
    // Re-classify from stored evidence so older blocked diagnoses pick up
    // long-lived / host-utility tags after classifier updates.
    const priorRefreshed = priorDiagnosis
      ? buildFailureDiagnosis({
          output: priorDiagnosis.evidence || priorDiagnosis.title,
          firstFailure: priorDiagnosis.failingStep
            ? {
                name: priorDiagnosis.failingStep.name,
                command: priorDiagnosis.failingStep.command,
                exitCode: priorDiagnosis.failingStep.exitCode,
                output: priorDiagnosis.evidence,
              }
            : undefined,
          sourcePhaseId: phase.id,
          sourceRunId: run.id,
        })
      : null;
    let lastHandoffDiagnosis: HandoffDiagnosisSnippet | undefined =
      priorRefreshed
        ? {
            fingerprint: priorRefreshed.fingerprint,
            title: priorRefreshed.title,
            class: priorRefreshed.class,
            operatorActions: priorRefreshed.operatorActions,
            nextActions: priorRefreshed.nextActions,
            tags: priorRefreshed.tags,
          }
        : undefined;

    const persistHandoff = (
      outcome: "complete" | "blocked" | "interrupted",
    ): void => {
      try {
        if (outcome === "complete") {
          lastHandoffDiagnosis = undefined;
        }
        const handoff = buildDevelopmentHandoff({
          outcome,
          phaseId: phase.id,
          runId: run.id,
          phaseDoc: readPhaseDoc(project.rootPath, phase.id) || phaseDoc,
          appendix: readAppendix(project.rootPath, phase.id),
          checksOk: lastChecksOk,
          checksSummary: lastChecksSummary,
          merge: lastMergeInfo,
          diagnosis:
            outcome === "complete" ? undefined : lastHandoffDiagnosis,
          worktreeBranch: worktree.branch,
        });
        writeDevelopmentHandoff(project.rootPath, {
          phaseId: phase.id,
          runId: run.id,
          handoff,
        });
        // Promote UX/placement knowledge into durable learnings for next research
        for (const k of handoff.knowledge ?? []) {
          if (!isUxPlacementKnowledge(k)) continue;
          promoteLearning(project.rootPath, {
            kind: "process",
            tags: ["ux-placement", "ui-mount"],
            title: k.slice(0, 120),
            lesson: k,
            severity: "warning",
            sourcePhaseId: phase.id,
            sourceRunId: run.id,
          });
        }
        log(
          project,
          run,
          `--- Development handoff written (outcome=${outcome}, operatorRequirements=${handoff.operatorRequirements.length}) ---`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(project, run, `--- Development handoff write failed: ${message} ---`);
      }
    };

    const finishDevelop = (
      stage: "complete" | "blocked" | "interrupted",
      paths?: { worktreePath?: string; worktreeBranch?: string },
    ): {
      stage: RunStage;
      worktreePath?: string;
      worktreeBranch?: string;
    } => {
      persistHandoff(stage);
      terminalStage = stage;
      return {
        stage,
        worktreePath: paths?.worktreePath,
        worktreeBranch: paths?.worktreeBranch ?? worktree.branch,
      };
    };

    const markInterrupted = (): {
      stage: RunStage;
      worktreePath?: string;
      worktreeBranch?: string;
    } => {
      log(project, run, "--- Development interrupted (stop/abort) ---");
      writePhaseStatus(project.rootPath, phase.id, "interrupted");
      return finishDevelop("interrupted", {
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      });
    };

    try {
      while (iteration < MAX_ITERATIONS) {
        if (signal?.aborted) {
          return markInterrupted();
        }

        iteration += 1;
        const iterationStarted = Date.now();
        log(project, run, `\n=== ITERATION ${iteration} ===`);

        // Re-sync gitignored env into worktree each iteration (keys live on root).
        const resynced = syncLocalFilesToWorktree({
          projectRoot: project.rootPath,
          worktreePath: worktree.path,
          relativePaths: config.worktreeSyncPaths,
        });
        const projectEnv = resolveProjectEnv({
          projectRoot: project.rootPath,
          config,
        });
        const llm = await resolveLlmTestEnvWithProbe({
          projectRoot: project.rootPath,
          config,
        });
        const resolvedEnv = { ...projectEnv.env, ...llm.env };
        const written = writeResolvedEnvToWorktree({
          worktreePath: worktree.path,
          env: resolvedEnv,
        });
        const phaseResynced = syncPhaseArtifactsToWorktree({
          projectRoot: project.rootPath,
          worktreePath: worktree.path,
          phaseId: phase.id,
          // After the first iter, keep agent edits to PHASE.md (e.g. fixed checks)
          preserveWorktreeEdits: iteration > 1,
        });
        if (resynced.length > 0 || written || phaseResynced.length > 0) {
          log(
            project,
            run,
            `--- Re-synced into worktree: ${[...resynced, written, ...phaseResynced].filter(Boolean).join(", ")} (${Object.keys(resolvedEnv).length} keys) ---`,
          );
        }
        const isolation = applyWorktreeComposeIsolation({
          worktreePath: worktree.path,
          phaseId: phase.id,
        });
        if (!loadCanonicalRuntimeEnv(project.rootPath)) {
          const snap = snapshotCanonicalRuntimeEnv(project.rootPath);
          log(
            project,
            run,
            `--- Canonical runtime snapshot (late): DB_PORT=${snap.dbPort} ---`,
          );
        }
        log(
          project,
          run,
          `--- Worktree compose isolation: COMPOSE_PROJECT_NAME=${isolation.projectName} DB_PORT=${isolation.dbPort} ---`,
        );

        if (needsFreshSession) {
          log(project, run, "--- Recreating OpenCode session after abort/fetch failure ---");
          await codingTool.abort(session).catch(() => undefined);
          session = await createCodingSession();
          needsFreshSession = false;
        }

        const appendix = readAppendix(project.rootPath, phase.id);

        let prompt: string;
        let systemOverride: string | undefined;

        if (iteration === 1) {
          prompt = `Implement this phase following \`.slopcontrol/phases/${phase.id}/PHASE.md\` exactly (canonical phase doc — do NOT trust a stale repo-root \`PHASE.md\` from a prior phase).
Work only in this worktree checkout.
If UI-SPEC.md / tokens.css / design assets are in context, implement against them (do not invent a competing brand).
Implement the tests / commands listed under ## Automated Checks before claiming done.
Never spawn multi-word commands as a single binary (wrong: spawn("docker compose", args); correct: spawn("docker", ["compose", ...args])).
Do NOT probe live **cloud** APIs with curl/http using secrets from .env* files. Never print or echo API keys. Local Docker/Ollama auth diagnosis (127.0.0.1 / localhost / ollama: / host.docker.internal) is allowed without printing the key.
For Docker **401 Unauthorized** against embedded Ollama: inspect \`docker-compose.yml\` \`environment:\` vs \`env_file\` — \`VAR: \${VAR:-}\` with an empty host shell overrides \`env_file\` and empties the container key; prefer compose edits over PHASE-only churn.
Env layers: \`.env.slopcontrol\` is the SlopControl **test/develop overlay** (local Ollama / fixture). \`.env.docker\` / \`.env.local\` are **runtime/Docker**. Do NOT “fix tests” by rewriting \`.env.docker\` to free-tier cloud models or setting OLLAMA_TIER=free. If PHASE Automated Checks only grep \`.env.docker\`, edit that file as specified — do not curl cloud APIs. Naive \`grep ':cloud' .env.docker\` also matches comments — prefer assignment-only patterns (e.g. \`grep -E '^[^#]*:cloud'\`) or remove \`:cloud\` from comments. Gitignored \`.env*\` edits in the worktree are pushed back to the project root before root verify (except paid→free OLLAMA_TIER regressions, which are blocked); also tighten PHASE.md checks so comments cannot fail the gate.
For LLM/env failures: rely on SlopControl resolved project env (\`.env.slopcontrol\`) and llmTestProfile — do NOT invent worktree-only product fixes. If the operator configured paid tier (OLLAMA_TIER=paid, bare glm-5.2), keep that — 404/403 is operator key/catalog, not a cue to force :cloud.
If verify fails because a runtime dependency is down (connection refused, stopped containers, etc.), do NOT invent app-repo scripts to paper over it — leave that to the operator / verifyPreflightCommand / MCP get_operator_suggestions.
After implementing, ensure the project builds and Automated Checks / tests pass${
            isDatabasePhase(phaseDoc)
              ? " AND database DDL/tables are present (e.g. docker/init-db.sql with CREATE TABLE)"
              : ""
          }. Before printing DEV_COMPLETE, append to \`.slopcontrol/phases/${phase.id}/APPENDIX.md\` an \`## Operator handoff\` section with \`### Operator requirements\`, \`### Knowledge\`, and \`### Follow-ups\` (use bullet \`None\` when empty). Print DEV_COMPLETE only when success criteria and Automated Checks are met.`;
          systemOverride = contextSystem || undefined;
        } else if (lastAbortWasProductiveTimeout) {
          lastAbortWasProductiveTimeout = false;
          prompt = `Resume unfinished PHASE work — the previous coding turn hit the wall-clock budget but already changed files in the worktree.
Do NOT re-litigate prior infra stall / turn_timeout APPENDIX cards. Continue from \`.slopcontrol/phases/${phase.id}/PHASE.md\` File Changes and ## Automated Checks.
Honor UI-SPEC / tokens / design assets when present. Finish remaining work, run checks, append \`## Operator handoff\` to APPENDIX (Operator requirements / Knowledge / Follow-ups), then print DEV_COMPLETE when success criteria pass.`;
          systemOverride = [
            contextSystem || null,
            appendix.trim()
              ? `APPENDIX.md (latest only — prefer "budget exceeded — continue" over old stall diagnoses)\n\n${appendix.slice(-4_000)}`
              : null,
          ]
            .filter(Boolean)
            .join("\n\n---\n\n");
        } else if (lastFailWasPostMergeRootVerify) {
          lastFailWasPostMergeRootVerify = false;
          prompt = `POST-MERGE ROOT VERIFY failed — worktree build passed and the phase branch merged, but tests on the **project root** failed.
Do NOT re-assert DEV_COMPLETE until project-root \`npm test\` / Automated Checks pass.
Git merge only moves tracked files; gitignored outputs (e.g. \`drizzle/\`) are synced from the worktree by SlopControl before root verify — edit those artifacts in the worktree so the next sync lands the correct files on root.
Address the latest APPENDIX Failure diagnosis (post-merge root verify). Fix the failing assertion on root, append/update \`## Operator handoff\` in APPENDIX, then print DEV_COMPLETE only when root verify would pass.`;
          systemOverride = [
            contextSystem || null,
            designContext.trim() ? designContext.slice(0, 4_000) : null,
            learningsBlock.trim() ? learningsBlock : null,
            appendix.trim() ? `APPENDIX.md\n\n${appendix}` : null,
          ]
            .filter(Boolean)
            .join("\n\n---\n\n");
        } else {
          // Prefer latest diagnosis over APPENDIX scrape (stale host-utility cards misroute).
          prompt = buildDevelopCodingRetryPrompt({
            phaseId: phase.id,
            title: lastHandoffDiagnosis?.title,
            nextActions: lastHandoffDiagnosis?.nextActions,
            class: lastHandoffDiagnosis?.class,
            tags: lastHandoffDiagnosis?.tags,
            appendixFallback: appendix,
          });
          if (appendix.trim()) {
            systemOverride = [
              contextSystem ? `PHASE.md context:\n${phaseDoc.slice(0, 3000)}` : null,
              designContext.trim()
                ? designContext.slice(0, 4_000)
                : null,
              learningsBlock.trim() ? learningsBlock : null,
              `APPENDIX.md\n\n${appendix}`,
            ]
              .filter(Boolean)
              .join("\n\n---\n\n");
          }
        }

        let codingResult;
        const codingTurnMs = resolveCodingTurnTimeoutMs(config);
        try {
          codingResult = await (codingTool.runPromptWithSystem
            ? codingTool.runPromptWithSystem(session, prompt, systemOverride, {
                timeoutMs: codingTurnMs,
              })
            : codingTool.runPrompt(session, prompt, {
                timeoutMs: codingTurnMs,
              }));
        } catch (error) {
          if (signal?.aborted) return markInterrupted();
          const message = error instanceof Error ? error.message : String(error);
          log(project, run, `Coding turn error: ${message}`);
          needsFreshSession = true;
          appendAppendix(
            project.rootPath,
            phase.id,
            `## Iteration ${iteration} — coding transport failure\n\n${message}\n\nDo not probe live APIs. Edit files from PHASE.md and run local Automated Checks.`,
          );
          noProgressCount += 1;
          if (noProgressCount >= MAX_NO_PROGRESS) {
            log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
            writePhaseStatus(project.rootPath, phase.id, "blocked");
            return finishDevelop("blocked", {
              worktreePath: worktree.path,
              worktreeBranch: worktree.branch,
            });
          }
          continue;
        }

        if (signal?.aborted) return markInterrupted();

        log(project, run, codingResult.output);

        const probe = codingResult.abortReason || null;
        if (codingResult.aborted || probe) {
          const reason = probe || codingResult.abortReason || "coding turn aborted";
          log(project, run, `--- Coding turn aborted: ${reason} ---`);
          const gitChanged = listWorktreeChangedFiles(worktree.path);
          needsFreshSession = shouldRecreateCodingSession(reason, gitChanged);
          if (!needsFreshSession) {
            log(
              project,
              run,
              `--- Keeping sticky OpenCode session ${session.id} (no recreate) ---`,
            );
          }
          const productiveTimeout = isProductiveTurnTimeout(reason, gitChanged);
          const stall =
            !productiveTimeout &&
            isStallAbortReason(codingResult.abortReason || reason);

          if (productiveTimeout) {
            stallStrikeCount = 0;
            noProgressCount = 0;
            lastAbortWasProductiveTimeout = true;
            appendAppendix(
              project.rootPath,
              phase.id,
              `## Iteration ${iteration} — coding turn budget exceeded — continue\n\n${reason}\n\n` +
                `Soft wall-clock budget hit but the worktree has changes (${gitChanged.length} paths). ` +
                `OpenCode session stays sticky (no recreate). Continue from PHASE.md. Do not print secrets.`,
            );
          } else if (stall) {
            lastAbortWasProductiveTimeout = false;
            stallStrikeCount += 1;
            appendAppendix(
              project.rootPath,
              phase.id,
              `## Iteration ${iteration} — coding LLM stall/throttle abort\n\n${reason}\n\n` +
                `OpenCode coding LLM stalled or was rate-limited (not a product curl). ` +
                `Stall strikes: ${stallStrikeCount}/${MAX_STALL_STRIKES}. ` +
                `Read \`.slopcontrol/phases/${phase.id}/PHASE.md\`. Do not print secrets.`,
            );
            noProgressCount += 1;
          } else {
            lastAbortWasProductiveTimeout = false;
            stallStrikeCount = 0;
            if (gitChanged.length === 0) {
              appendAppendix(
                project.rootPath,
                phase.id,
                `## Iteration ${iteration} — probe/timeout abort (no file changes)\n\n${reason}\n\nTurn produced no git changes. Shrink scope. Read \`.slopcontrol/phases/${phase.id}/PHASE.md\` (not a stale repo-root PHASE.md). For Docker 401s, inspect \`docker-compose.yml\` \`environment:\` vs \`env_file\` (\`\${VAR:-}\` empty override) and edit compose — do not curl cloud APIs or print secrets.`,
              );
              noProgressCount += 1;
            } else {
              appendAppendix(
                project.rootPath,
                phase.id,
                `## Iteration ${iteration} — probe/timeout abort\n\n${reason}\n\nStop curling **cloud** Ollama APIs. Prefer compose/\`env_file\` fixes for embedded-Ollama 401s. Read \`.slopcontrol/phases/${phase.id}/PHASE.md\` for phase intent. \`.env.slopcontrol\` = test overlay; \`.env.docker\` = runtime — do not switch runtime to free-tier to pass tests.`,
              );
              noProgressCount += 1;
            }
          }
          if (shouldBlockOnStallStrikes(stallStrikeCount, MAX_STALL_STRIKES)) {
            const stallRootCause = `${MAX_STALL_STRIKES} consecutive turn_idle / empty turn_timeout / provider_rate_limit aborts.`;
            const stallActions = [
              "Wait for Ollama Cloud quota or switch OpenCode coding model.",
              "Confirm OpenCode is healthy (`curl http://127.0.0.1:4096/global/health`).",
              "Retry development after provider recovers — do not keep recreating sessions under throttle.",
            ];
            appendAppendix(
              project.rootPath,
              phase.id,
              `## Failure diagnosis\n\n- **class:** infra (high)\n- **audience:** operator\n- **title:** OpenCode coding LLM stalled / rate-limited repeatedly\n\n### Root cause\n\n${stallRootCause}\n\n### Operator actions\n\n${stallActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}\n`,
            );
            writeDiagnosis(
              project.rootPath,
              run.id,
              {
                audience: "operator",
                operatorActions: stallActions,
                class: "infra",
                confidence: "high",
                title: "OpenCode coding LLM stalled / rate-limited repeatedly",
                rootCause: stallRootCause,
                evidence: reason,
                nextActions: stallActions.join(" "),
                fingerprint: `stall-strikes-${MAX_STALL_STRIKES}`,
                codingAgentShouldFix: false,
                phaseId: phase.id,
                runId: run.id,
                updatedAt: new Date().toISOString(),
              },
              phase.id,
            );
            lastHandoffDiagnosis = {
              fingerprint: `stall-strikes-${MAX_STALL_STRIKES}`,
              title: "OpenCode coding LLM stalled / rate-limited repeatedly",
              class: "infra",
              operatorActions: stallActions,
            };
            log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
            writePhaseStatus(project.rootPath, phase.id, "blocked");
            return finishDevelop("blocked", {
              worktreePath: worktree.path,
              worktreeBranch: worktree.branch,
            });
          }
          if (noProgressCount >= MAX_NO_PROGRESS) {
            log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
            writePhaseStatus(project.rootPath, phase.id, "blocked");
            return finishDevelop("blocked", {
              worktreePath: worktree.path,
              worktreeBranch: worktree.branch,
            });
          }
          continue;
        }

        stallStrikeCount = 0;

        const sessionChanged = await codingTool.getChangedFiles(session);
        const gitChanged = listWorktreeChangedFiles(worktree.path);
        const changed = [
          ...new Set([...sessionChanged, ...gitChanged].filter(Boolean)),
        ];
        if (changed.length > 0) {
          log(project, run, `Changed files: ${changed.join(", ")}`);
        }

        const planProgress = evaluatePlanProgress(phaseDoc, changed);
        if (planProgress.plannedPaths.length > 0) {
          writeCheckReport(
            project.rootPath,
            run.id,
            `iter${iteration}-plan-progress`,
            planProgress.summary,
          );
          log(project, run, `--- Plan progress ---\n${planProgress.summary}`);
          if (planProgress.offTrack) {
            appendAppendix(
              project.rootPath,
              phase.id,
              formatPlanProgressAppendix(planProgress),
            );
          }
        }

        const promoted = promotePhaseDocFromWorktree({
          projectRoot: project.rootPath,
          worktreePath: worktree.path,
          phaseId: phase.id,
        });
        if (promoted.promoted) {
          log(
            project,
            run,
            "--- Promoted worktree PHASE.md fixes to project canonical ---",
          );
        }
        phaseDoc = readPhaseDoc(project.rootPath, phase.id);

        // When auto-merging: build-only in the worktree, then merge and run
        // tests on the project root (where .env.docker / .env.local live).
        const autoMerge = config.autoMergeOnComplete !== false;
        let pushedEnv: string[] = [];
        let checks = await runSuccessChecks(project, phaseDoc, worktree.path, {
          mode: autoMerge ? "build" : "full",
          phaseId: phase.id,
          registry: this.ctx.registry,
        });
        if (!checks.ok && isExit127CommandNotFoundFailure(checks)) {
          log(
            project,
            run,
            "--- Auto deps-install after exit 127 (force reinstall + recheck) ---",
          );
          checks = await runSuccessChecks(project, phaseDoc, worktree.path, {
            mode: autoMerge ? "build" : "full",
            forceDepsInstall: true,
            phaseId: phase.id,
            registry: this.ctx.registry,
          });
          if (checks.ok) {
            log(
              project,
              run,
              "--- Auto deps-install recovered worktree gate ---",
            );
          }
        }
        log(
          project,
          run,
          `[timing] iteration ${iteration} elapsed ${formatDurationMs(Date.now() - iterationStarted)}`,
        );

        if (checks.ok && autoMerge) {
          log(
            project,
            run,
            `--- Worktree build OK; merging ${worktree.branch} into project root before tests ---`,
          );
          try {
            const mergeResult = mergePhaseWorktree({
              projectRoot: project.rootPath,
              projectId: project.id,
              phaseId: phase.id,
              dataDir: this.ctx.dataDir,
              targetBranch: config.mergeTargetBranch,
              stashDirty: true,
              conflictStrategy: "prefer_phase",
              // Keep worktree until DEV_COMPLETE so a failed root verify can iterate
              removeWorktree: false,
            });
            log(project, run, mergeResult.message);
            const stashNotRestored =
              mergeResult.ok &&
              mergeResult.stashedRoot &&
              !mergeResult.stashRestored;
            if (mergeResult.ok && !stashNotRestored) {
              lastMergeInfo = {
                autoMerged: true,
                worktreePresent: true,
                branch: mergeResult.targetBranch,
                commit: mergeResult.mergeCommit ?? undefined,
                stashRestored: mergeResult.stashedRoot
                  ? mergeResult.stashRestored
                  : undefined,
                stashRef: mergeResult.stashRef,
              };
              log(
                project,
                run,
                `--- Project folder now on ${mergeResult.targetBranch} @ ${(mergeResult.mergeCommit ?? "").slice(0, 8)} ---`,
              );
            }
            if (!mergeResult.ok || stashNotRestored) {
              const overwriteBlocked =
                mergeResult.failureKind === "overwrite" ||
                /Merge blocked by dirty\/untracked|would be overwritten by merge/i.test(
                  mergeResult.message,
                );
              const mergeFail: SuccessCheckStep = {
                name: "auto-merge",
                exitCode: 1,
                output: [
                  stashNotRestored
                    ? `Auto-merge left unrestored pre-merge stash:\n${mergeResult.message}`
                    : `Auto-merge failed:\n${mergeResult.message}`,
                  mergeResult.conflicts?.length
                    ? `Conflicts: ${mergeResult.conflicts.join(", ")}`
                    : null,
                  mergeResult.clearedSlopcontrolPaths?.length
                    ? `Cleared .slopcontrol paths: ${mergeResult.clearedSlopcontrolPaths.join(", ")}`
                    : null,
                  mergeResult.stashRef
                    ? `Stash ref: ${mergeResult.stashRef}`
                    : null,
                  stashNotRestored
                    ? "Restore or drop the pre-merge stash (git stash pop / git stash drop), then continue."
                    : overwriteBlocked
                      ? "SlopControl clears .slopcontrol overwrite blockers before merge; retry the develop iteration (no product-code change required)."
                      : "Fix merge conflicts (resolve_conflicts) or worktree issues, then continue.",
                ]
                  .filter(Boolean)
                  .join("\n"),
              };
              if (stashNotRestored) {
                lastMergeInfo = {
                  autoMerged: true,
                  worktreePresent: true,
                  branch: mergeResult.targetBranch,
                  commit: mergeResult.mergeCommit ?? undefined,
                  stashRestored: false,
                  stashRef: mergeResult.stashRef,
                };
              }
              appendAppendix(
                project.rootPath,
                phase.id,
                [
                  `## Iteration ${iteration} — auto-merge`,
                  "",
                  mergeFail.output.slice(0, 2_500),
                  "",
                ].join("\n"),
              );
              checks = {
                ok: false,
                output: [checks.output, mergeFail.output].join("\n\n"),
                steps: [...(checks.steps ?? []), mergeFail],
                firstFailure: mergeFail,
                summary: buildCheckSummary(false, [...(checks.steps ?? []), mergeFail], mergeFail),
              };
            } else {
              const healed = restoreCanonicalRuntimeEnv(project.rootPath);
              if (healed.restored.length > 0 || healed.created) {
                log(
                  project,
                  run,
                  `--- Restored canonical runtime env (DB_PORT=${healed.dbPort}): ${healed.restored.join(", ") || "(snapshot refreshed)"} ---`,
                );
              }
              pushedEnv = syncLocalFilesFromWorktree({
                projectRoot: project.rootPath,
                worktreePath: worktree.path,
                relativePaths: config.worktreeSyncPaths,
              });
              if (pushedEnv.length > 0) {
                log(
                  project,
                  run,
                  `--- Pushed worktree env to project root: ${pushedEnv.join(", ")} ---`,
                );
              }
              // Sync may re-touch env files — force canonical ports again before verify
              const healedAfterSync = restoreCanonicalRuntimeEnv(
                project.rootPath,
              );
              if (healedAfterSync.restored.length > 0) {
                log(
                  project,
                  run,
                  `--- Re-applied canonical runtime env after sync: ${healedAfterSync.restored.join(", ")} ---`,
                );
              }
              const ignoredSync = syncIgnoredArtifactsFromWorktree({
                projectRoot: project.rootPath,
                worktreePath: worktree.path,
              });
              if (
                ignoredSync.copied.length > 0 ||
                ignoredSync.deleted.length > 0
              ) {
                const bits = [
                  ignoredSync.copied.length
                    ? `copied ${ignoredSync.copied.join(", ")}`
                    : null,
                  ignoredSync.deleted.length
                    ? `deleted stale ${ignoredSync.deleted.join(", ")}`
                    : null,
                ].filter(Boolean);
                log(
                  project,
                  run,
                  `--- Synced gitignored worktree artifacts to root: ${bits.join("; ")} ---`,
                );
              }
              log(
                project,
                run,
                `--- Freeing worktree compose ports before root verify ---`,
              );
              const allWtDown = tearDownAllProjectWorktreeCompose({
                dataDir: this.ctx.dataDir,
                projectId: project.id,
              });
              if (allWtDown.attempted) {
                log(
                  project,
                  run,
                  `--- All project worktree compose down (${allWtDown.ok ? "ok" : "warn"}) ---\n${allWtDown.output.slice(0, 1200)}`,
                );
              } else {
                const single = tearDownComposeInDir(worktree.path);
                if (single.attempted) {
                  log(
                    project,
                    run,
                    `--- Worktree compose down (${single.ok ? "ok" : "warn"}) ---\n${single.output.slice(0, 800)}`,
                  );
                }
              }
              const stoppedOrphans = stopComposeContainersUnderWorktrees({
                dataDir: this.ctx.dataDir,
                projectId: project.id,
              });
              if (stoppedOrphans.attempted) {
                log(
                  project,
                  run,
                  `--- Stopped worktree-path compose containers (${stoppedOrphans.ok ? "ok" : "warn"}) ---\n${stoppedOrphans.output.slice(0, 800)}`,
                );
              }
              const freed = freePublishedHostPorts(project.rootPath, {
                dataDir: this.ctx.dataDir,
                projectId: project.id,
              });
              if (freed.attempted) {
                log(
                  project,
                  run,
                  `--- Freed published DB host ports (${freed.ok ? "ok" : "warn"}) ---\n${freed.output.slice(0, 800)}`,
                );
              }
              log(
                project,
                run,
                `--- Running tests on project root (${project.rootPath}) ---`,
              );
              const rootChecks = await runSuccessChecks(
                project,
                phaseDoc,
                project.rootPath,
                {
                  mode: "verify",
                  forceDepsInstall: true,
                  phaseId: phase.id,
                  registry: this.ctx.registry,
                },
              );
              let rootVerify = rootChecks;
              if (!rootVerify.ok && isExit127CommandNotFoundFailure(rootVerify)) {
                log(
                  project,
                  run,
                  "--- Auto deps-install after exit 127 (project root) ---",
                );
                rootVerify = await runSuccessChecks(
                  project,
                  phaseDoc,
                  project.rootPath,
                  {
                    mode: "verify",
                    forceDepsInstall: true,
                    phaseId: phase.id,
                    registry: this.ctx.registry,
                  },
                );
              }
              persistCheckOutput(
                project,
                run,
                `iter${iteration}-root-verify`,
                rootVerify.output,
                rootVerify.ok,
                rootVerify,
              );
              log(
                project,
                run,
                `--- Post-merge root verify summary ---\n${rootVerify.summary}`,
              );
              if (!rootVerify.ok) {
                lastFailWasPostMergeRootVerify = true;
                const rootFail = rootVerify.firstFailure;
                const postMergeStep: SuccessCheckStep = {
                  name: rootFail?.name
                    ? `post-merge-root-verify:${rootFail.name}`
                    : "post-merge-root-verify",
                  command: rootFail?.command,
                  exitCode: rootFail?.exitCode ?? 1,
                  output: [
                    "POST-MERGE ROOT VERIFY FAILED — worktree build passed; phase branch merged.",
                    "Git merge does not copy gitignored files; SlopControl syncs ignored worktree artifacts before this step.",
                    "Do not claim DEV_COMPLETE from worktree-only green — fix so project-root tests pass.",
                    "",
                    rootFail?.output ?? rootVerify.output,
                  ].join("\n"),
                };
                appendAppendix(
                  project.rootPath,
                  phase.id,
                  [
                    `## Iteration ${iteration} — post-merge root verify`,
                    "",
                    postMergeStep.output.slice(0, 2_500),
                    "",
                  ].join("\n"),
                );
                checks = {
                  ok: false,
                  output: [
                    checks.output,
                    `Merged OK (${mergeResult.mergeCommit?.slice(0, 8) ?? "ok"}) but root tests/verify failed:`,
                    postMergeStep.output,
                    "Full output is under .slopcontrol/runs/<runId>/checks/.",
                  ].join("\n\n"),
                  steps: [...(checks.steps ?? []), ...(rootVerify.steps ?? []), postMergeStep],
                  firstFailure: postMergeStep,
                  summary: buildCheckSummary(
                    false,
                    [...(checks.steps ?? []), ...(rootVerify.steps ?? []), postMergeStep],
                    postMergeStep,
                  ),
                };
              } else {
                lastFailWasPostMergeRootVerify = false;
                checks = {
                  ok: true,
                  output: [
                    checks.output,
                    mergeResult.message,
                    rootVerify.output,
                  ].join("\n\n"),
                  steps: [...(checks.steps ?? []), ...(rootVerify.steps ?? [])],
                  summary: rootVerify.summary,
                };
              }
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            const mergeThrow: SuccessCheckStep = {
              name: "auto-merge",
              exitCode: 1,
              output: `Auto-merge threw: ${message}`,
            };
            checks = {
              ok: false,
              output: `${checks.output}\n\n${mergeThrow.output}`,
              steps: [...(checks.steps ?? []), mergeThrow],
              firstFailure: mergeThrow,
              summary: buildCheckSummary(false, [...(checks.steps ?? []), mergeThrow], mergeThrow),
            };
          }
        }

        if (checks.ok) {
          const appendixForGate = readAppendix(project.rootPath, phase.id);
          const researchForGate = readResearch(project.rootPath, phase.id);
          const apiGate = evaluateApiRoutingCompleteGate({
            appendix: appendixForGate,
            phaseDoc,
            researchDoc: researchForGate,
            changedFiles: changed,
            envTouchedPaths: pushedEnv,
          });
          if (!apiGate.allowComplete) {
            const gateStep: SuccessCheckStep = {
              name: "api-routing-complete-gate",
              exitCode: 1,
              output: apiGate.reason ?? "API-routing complete gate failed",
            };
            appendAppendix(
              project.rootPath,
              phase.id,
              [
                `## Iteration ${iteration} — API-routing complete gate`,
                "",
                gateStep.output,
                "",
              ].join("\n"),
            );
            checks = {
              ok: false,
              output: [checks.output, gateStep.output].join("\n\n"),
              steps: [...(checks.steps ?? []), gateStep],
              firstFailure: gateStep,
              summary: buildCheckSummary(
                false,
                [...(checks.steps ?? []), gateStep],
                gateStep,
              ),
            };
            log(project, run, `--- ${gateStep.output} ---`);
          }
        }

        if (checks.ok) {
          persistCheckOutput(
            project,
            run,
            `iter${iteration}-success`,
            checks.output,
            true,
            checks,
          );
          log(project, run, checks.output);
          if (autoMerge && config.removeWorktreeOnComplete !== false) {
            try {
              const removed = removePhaseWorktree({
                projectRoot: project.rootPath,
                projectId: project.id,
                phaseId: phase.id,
                dataDir: this.ctx.dataDir,
                // Phase tip is on main after successful auto-merge; drop the
                // slop/* branch so it does not look like an unmerged leftover.
                deleteBranch: true,
              });
              log(project, run, `--- ${removed.message} ---`);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              log(
                project,
                run,
                `--- Worktree cleanup skipped: ${message} ---`,
              );
            }
          }
          lastChecksOk = true;
          lastChecksSummary = checks.summary || checks.output.slice(-2000);
          if (autoMerge && config.removeWorktreeOnComplete !== false) {
            lastMergeInfo = {
              ...lastMergeInfo,
              autoMerged: lastMergeInfo.autoMerged,
              worktreePresent: false,
            };
          }
          log(project, run, COMPLETION_TOKENS.DEV_COMPLETE);
          writePhaseStatus(project.rootPath, phase.id, "complete");
          clearRunDiagnosis(project.rootPath, run.id, phase.id);
          upsertRoadmapEntry(
            project.rootPath,
            phase.id,
            phase.title ?? phase.description.slice(0, 80),
            "complete",
            phase.dependsOn ?? [],
          );
          if (config.componentLibrary) {
            const publish =
              this.ctx.publishComponentLibrary ??
              defaultPublishComponentLibrary;
            try {
              const outcome = await publish({
                projectId: project.id,
                projectRoot: project.rootPath,
              });
              log(
                project,
                run,
                outcome.ok
                  ? `--- Component library auto-publish: ${outcome.summary} ---`
                  : `--- Component library auto-publish failed (phase still complete): ${outcome.summary} ---`,
              );
            } catch (error) {
              log(
                project,
                run,
                `--- Component library auto-publish failed (phase still complete): ${
                  error instanceof Error ? error.message : String(error)
                } ---`,
              );
            }
          }
          return finishDevelop("complete", {
            worktreePath:
              autoMerge && config.removeWorktreeOnComplete !== false
                ? undefined
                : worktree.path,
            worktreeBranch: worktree.branch,
          });
        }

        lastChecksOk = false;
        lastChecksSummary = checks.summary || checks.output.slice(-2000);

        persistCheckOutput(
          project,
          run,
          `iter${iteration}-failed`,
          checks.output,
          false,
          checks,
        );
        log(
          project,
          run,
          `SUCCESS CHECKS FAILED — diagnosis summary:\n${checks.summary}`,
        );

        const verifySteps = readVerifyStepsReport(project.rootPath, run.id);
        const diagnosis = await diagnoseVerifyFailureLlmFirst(this.ctx.registry, {
          output: checks.summary || checks.output,
          firstFailure: checks.firstFailure,
          failingStepId: verifySteps?.firstFailure?.id,
          sourcePhaseId: phase.id,
          sourceRunId: run.id,
        });
        writeDiagnosis(
          project.rootPath,
          run.id,
          {
            audience: diagnosis.audience,
            operatorActions: diagnosis.operatorActions,
            class: diagnosis.class,
            confidence: diagnosis.confidence,
            title: diagnosis.title,
            rootCause: diagnosis.rootCause,
            evidence: diagnosis.evidence,
            nextActions: diagnosis.nextActions,
            fingerprint: diagnosis.fingerprint,
            codingAgentShouldFix: diagnosis.codingAgentShouldFix,
            tags: diagnosis.tags,
            failingStep: diagnosis.failingStep,
            phaseId: phase.id,
            runId: run.id,
            updatedAt: new Date().toISOString(),
          },
          phase.id,
        );
        lastHandoffDiagnosis = {
          fingerprint: diagnosis.fingerprint,
          title: diagnosis.title,
          class: diagnosis.class,
          operatorActions: diagnosis.operatorActions,
          nextActions: diagnosis.nextActions,
          tags: diagnosis.tags,
        };
        lastDiagnosisCard = formatDiagnosisCard(diagnosis);
        log(
          project,
          run,
          `--- Failure diagnosis: ${diagnosis.class} (${diagnosis.confidence}) audience=${diagnosis.audience} — ${diagnosis.title} [fp=${diagnosis.fingerprint}] ---`,
        );
        if (diagnosis.operatorActions.length > 0) {
          log(
            project,
            run,
            `--- Operator actions ---\n${diagnosis.operatorActions.map((a, i) => `${i + 1}. ${a}`).join("\n")}`,
          );
        }

        if (diagnosis.learning) {
          const recorded = promoteLearning(project.rootPath, diagnosis.learning);
          log(
            project,
            run,
            `--- Learning recorded: ${recorded.id} (hits=${recorded.hitCount}) ---`,
          );
        }

        appendAppendix(
          project.rootPath,
          phase.id,
          `## Iteration ${iteration}\n\n${lastDiagnosisCard}`,
        );

        if (
          /Ollama Cloud model IDs missing|model entitlement 403|chat smoke FAILED/i.test(
            checks.summary + checks.output,
          )
        ) {
          appendAppendix(
            project.rootPath,
            phase.id,
            envModelFailureAppendix(checks.firstFailure?.output ?? checks.output),
          );
        }

        // Overwrite-style auto-merge failures are recoverable by SlopControl
        // clearance on the next merge attempt — do not burn operator infra strikes.
        const overwriteMergeFailure =
          checks.firstFailure?.name === "auto-merge" &&
          /Merge blocked by dirty\/untracked|would be overwritten by merge|slopcontrol-overwrite/i.test(
            `${diagnosis.title}\n${diagnosis.evidence}\n${checks.firstFailure.output}`,
          );

        if (
          !overwriteMergeFailure &&
          (diagnosis.class === "infra" || diagnosis.audience === "operator")
        ) {
          infraStrikeCount += 1;
          if (infraStrikeCount >= 2) {
            log(
              project,
              run,
              "--- Operator/infra strikes exhausted; blocking (use MCP get_operator_suggestions) ---",
            );
            appendAppendix(
              project.rootPath,
              phase.id,
              `${lastDiagnosisCard}\n\nDEV_BLOCKED — infra strikes exhausted.`,
            );
            log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
            writePhaseStatus(project.rootPath, phase.id, "blocked");
            return finishDevelop("blocked", {
              worktreePath: worktree.path,
              worktreeBranch: worktree.branch,
            });
          }
        }

        if (diagnosis.fingerprint === lastDiagnosisFingerprint) {
          diagnosisStreak += 1;
        } else {
          diagnosisStreak = 1;
          lastDiagnosisFingerprint = diagnosis.fingerprint;
        }

        if (diagnosisStreak >= MAX_DIAGNOSIS_STREAK) {
          log(
            project,
            run,
            `--- Same diagnosis ${diagnosisStreak}× (fp=${diagnosis.fingerprint}); blocking mindless loop ---`,
          );
          appendAppendix(
            project.rootPath,
            phase.id,
            [
              lastDiagnosisCard,
              "",
              `DEV_BLOCKED — same failure diagnosis repeated ${diagnosisStreak} times without progress.`,
              "Operator/coding must change approach (fix PHASE check, product code, or restore infra) before retry_development.",
            ].join("\n"),
          );
          log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
          writePhaseStatus(project.rootPath, phase.id, "blocked");
          return finishDevelop("blocked", {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
          });
        }

        if (planProgress.offTrack) {
          noProgressCount += 1;
        }

        const currentErrorHash = fingerprintErrors(checks.summary || checks.output);
        const currentErrorCount = countErrors(checks.summary || checks.output);

        if (
          currentErrorHash === lastErrorHash ||
          currentErrorCount >= lastErrorCount
        ) {
          noProgressCount += 1;
        } else {
          noProgressCount = 0;
          stallStrikeCount = 0;
        }

        if (noProgressCount >= MAX_NO_PROGRESS) {
          appendAppendix(
            project.rootPath,
            phase.id,
            `${lastDiagnosisCard}\n\nDEV_BLOCKED — no-progress streak exhausted.`,
          );
          log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
          writePhaseStatus(project.rootPath, phase.id, "blocked");
          return finishDevelop("blocked", {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
          });
        }

        memory.push({
          iteration,
          status: "build_failed",
          errorCount: currentErrorCount,
          errorHash: currentErrorHash,
          noProgressStreak: noProgressCount,
          timestamp: new Date().toISOString(),
          details: checks.summary.slice(-500),
        });
        writeRunMemory(project.rootPath, run.id, memory);

        // High-confidence deterministic diagnosis: skip supervisor enrichment.
        // Low confidence: short supervisor prompt with diagnosis card only (not full logs).
        if (diagnosis.confidence === "high") {
          log(
            project,
            run,
            "--- High-confidence diagnosis; skipping supervisor enrichment ---",
          );
          lastErrorHash = currentErrorHash;
          lastErrorCount = currentErrorCount;
          continue;
        }

        const learningsForSupervisor = loadLearningsPromptBlock(
          project.rootPath,
          {
            phaseDescription: phase.description,
            phaseDoc,
            failureText: checks.summary,
            limit: 8,
          },
        );

        const enrichBuilt = buildSupervisorEnrichPrompt({
          iteration,
          diagnosisStreak,
          maxDiagnosisStreak: MAX_DIAGNOSIS_STREAK,
          noProgressCount,
          maxNoProgress: MAX_NO_PROGRESS,
          infraStrikeCount,
          planCoverageSummary: planProgress.summary,
          diagnosisCard: lastDiagnosisCard,
          phaseExcerpt: phaseDoc,
          worktreePath: worktree.path,
          runId: run.id,
          phaseId: phase.id,
          checkSignal: lastChecksSummary || checks.summary || "",
          learningsBlock: learningsForSupervisor || undefined,
          priorNextActions: priorNextActionsFromMemory(memory),
        });
        const supervisorPrompt = enrichBuilt.prompt;
        if (enrichBuilt.clipped) {
          log(
            project,
            run,
            `--- Supervisor prompt clipped to budget (${enrichBuilt.charCount} chars) ---`,
          );
        }

        const supervisorTimeoutMs = Number(
          process.env.SLOPCONTROL_SUPERVISOR_MS ?? 90_000,
        );
        let supervisorOutput = "";
        try {
          // No Mastra thread replay — curated prompt carries continuity.
          supervisorOutput = await runAgent(
            this.ctx.agents.devSupervisorAgent,
            supervisorPrompt,
            project.id,
            run.id,
            {
              timeoutMs: supervisorTimeoutMs,
              maxSteps: 1,
              memory: false,
            },
          );
        } catch (error) {
          if (signal?.aborted) return markInterrupted();
          const message =
            error instanceof Error ? error.message : String(error);
          // Keep deterministic diagnosis — do not invent a conflicting retry narrative.
          const tooLong = isPromptTooLongError(error);
          log(
            project,
            run,
            tooLong
              ? `Supervisor prompt too long (keeping diagnosis): ${message}`
              : `Supervisor timed out/failed (keeping diagnosis): ${message}`,
          );
          lastErrorHash = currentErrorHash;
          lastErrorCount = currentErrorCount;
          continue;
        }

        log(project, run, supervisorOutput);

        if (hasToken(supervisorOutput, COMPLETION_TOKENS.DEV_BLOCKED)) {
          appendAppendix(
            project.rootPath,
            phase.id,
            `${lastDiagnosisCard}\n\n${supervisorOutput}`,
          );
          writePhaseStatus(project.rootPath, phase.id, "blocked");
          return finishDevelop("blocked", {
            worktreePath: worktree.path,
            worktreeBranch: worktree.branch,
          });
        }

        if (supervisorOutput.trim()) {
          appendAppendix(
            project.rootPath,
            phase.id,
            `## Iteration ${iteration} — supervisor enrichment\n\n${supervisorOutput}`,
          );
          const nextSummary = extractNextActionsSummary(supervisorOutput);
          const lastMem = memory[memory.length - 1];
          if (lastMem && nextSummary) {
            lastMem.nextActionsSummary = nextSummary;
            writeRunMemory(project.rootPath, run.id, memory);
          }
        }
        lastErrorHash = currentErrorHash;
        lastErrorCount = currentErrorCount;
      }
    } finally {
      await codingTool.abort(session).catch(() => undefined);
    }

    if (signal?.aborted) {
      return markInterrupted();
    }

    if (!terminalStage) {
      log(project, run, COMPLETION_TOKENS.DEV_BLOCKED);
      writePhaseStatus(project.rootPath, phase.id, "blocked");
    }
    return finishDevelop(
      terminalStage === "complete"
        ? "complete"
        : terminalStage === "interrupted"
          ? "interrupted"
          : "blocked",
      {
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      },
    );
  }

  /**
   * Re-run the full success-check suite in the phase worktree (no coding, no merge).
   * Persists verify-steps.json + diagnosis on failure; clears diagnosis on success.
   */
  async retryVerify(input: {
    project: Project;
    phase: Phase;
    run: Run;
    signal?: AbortSignal;
  }): Promise<{
    stage: RunStage;
    ok: boolean;
    firstFailure?: {
      id?: string;
      name: string;
      command?: string;
      exitCode: number;
    };
    stepsSummary: string;
    worktreePath?: string;
    worktreeBranch?: string;
  }> {
    const { project, phase, run, signal } = input;
    const config = readProjectConfig(project.rootPath);

    log(project, run, "--- retry_verify: re-running success checks (no coding) ---");
    writePhaseStatus(project.rootPath, phase.id, "developing");

    const worktree = ensurePhaseWorktree({
      projectRoot: project.rootPath,
      projectId: project.id,
      phaseId: phase.id,
      dataDir: this.ctx.dataDir,
      syncPaths: config.worktreeSyncPaths,
    });
    log(
      project,
      run,
      `--- Worktree ready: ${worktree.path} (branch ${worktree.branch}) ---`,
    );

    {
      const projectEnv = resolveProjectEnv({
        projectRoot: project.rootPath,
        config,
      });
      const llm = await resolveLlmTestEnvWithProbe({
        projectRoot: project.rootPath,
        config,
      });
      writeResolvedEnvToWorktree({
        worktreePath: worktree.path,
        env: { ...projectEnv.env, ...llm.env },
      });
      applyWorktreeComposeIsolation({
        worktreePath: worktree.path,
        phaseId: phase.id,
      });
    }

    if (signal?.aborted) {
      writePhaseStatus(project.rootPath, phase.id, "interrupted");
      return {
        stage: "interrupted",
        ok: false,
        stepsSummary: "retry_verify aborted",
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      };
    }

    const phaseDoc = readPhaseDoc(project.rootPath, phase.id);
    let checks = await runSuccessChecks(project, phaseDoc, worktree.path, {
      mode: "full",
      phaseId: phase.id,
      registry: this.ctx.registry,
    });
    if (!checks.ok && isExit127CommandNotFoundFailure(checks)) {
      log(project, run, "--- Auto deps-install after exit 127 (retry_verify) ---");
      checks = await runSuccessChecks(project, phaseDoc, worktree.path, {
        mode: "full",
        forceDepsInstall: true,
        phaseId: phase.id,
        registry: this.ctx.registry,
      });
    }

    persistCheckOutput(
      project,
      run,
      "retry-verify",
      checks.output,
      checks.ok,
      checks,
    );
    log(project, run, `--- retry_verify summary ---\n${checks.summary}`);

    const verifySteps = readVerifyStepsReport(project.rootPath, run.id);

    if (checks.ok) {
      clearRunDiagnosis(project.rootPath, run.id, phase.id);
      log(
        project,
        run,
        "--- VERIFY_OK (retry_verify) — call retry_development to merge/complete ---",
      );
      writePhaseStatus(project.rootPath, phase.id, "interrupted");
      return {
        stage: "interrupted",
        ok: true,
        stepsSummary: checks.summary || "Verify OK",
        worktreePath: worktree.path,
        worktreeBranch: worktree.branch,
      };
    }

    const diagnosis = await diagnoseVerifyFailureLlmFirst(this.ctx.registry, {
      output: checks.summary || checks.output,
      firstFailure: checks.firstFailure,
      failingStepId: verifySteps?.firstFailure?.id,
      sourcePhaseId: phase.id,
      sourceRunId: run.id,
    });
    writeDiagnosis(
      project.rootPath,
      run.id,
      {
        audience: diagnosis.audience,
        operatorActions: diagnosis.operatorActions,
        class: diagnosis.class,
        confidence: diagnosis.confidence,
        title: diagnosis.title,
        rootCause: diagnosis.rootCause,
        evidence: diagnosis.evidence,
        nextActions: diagnosis.nextActions,
        fingerprint: diagnosis.fingerprint,
        codingAgentShouldFix: diagnosis.codingAgentShouldFix,
        tags: diagnosis.tags,
        failingStep: diagnosis.failingStep,
        phaseId: phase.id,
        runId: run.id,
        updatedAt: new Date().toISOString(),
      },
      phase.id,
    );
    log(
      project,
      run,
      `--- Failure diagnosis: ${diagnosis.class} (${diagnosis.confidence}) — ${diagnosis.title} ---`,
    );
    writePhaseStatus(project.rootPath, phase.id, "blocked");
    return {
      stage: "blocked",
      ok: false,
      firstFailure: verifySteps?.firstFailure
        ? {
            id: verifySteps.firstFailure.id,
            name: verifySteps.firstFailure.name,
            command: verifySteps.firstFailure.command,
            exitCode: verifySteps.firstFailure.exitCode,
          }
        : checks.firstFailure
          ? {
              name: checks.firstFailure.name,
              command: checks.firstFailure.command,
              exitCode: checks.firstFailure.exitCode,
            }
          : undefined,
      stepsSummary: checks.summary || "Verify failed",
      worktreePath: worktree.path,
      worktreeBranch: worktree.branch,
    };
  }
}

export function createIds() {
  return {
    phaseId: randomUUID(),
    runId: randomUUID(),
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
