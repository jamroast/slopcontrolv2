import { randomUUID } from "node:crypto";
import { exec } from "node:child_process";
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
  isBrandThemingAsk,
  phaseDocAlignsWithChangeIntent,
  researchEngagementQuality,
  clipBlueprintForPrompt,
  isUxPlacementKnowledge,
  upsertRoadmapEntry,
  validateBlueprintDocument,
  validatePhaseDocForDev,
  verifyDatabaseArtifacts,
  verifyOllamaCloudChatAccess,
  verifyOllamaCloudModelIds,
  resolveLlmTestEnvWithProbe,
  mergeEnvOverlay,
  resolveProjectEnv,
  writeResolvedEnvToWorktree,
  writeDiagnosis,
  readDiagnosis,
  readLatestDiagnosisForPhase,
  clearPhaseDiagnosis,
  clearRunDiagnosis,
  writeBlueprint,
  writeCheckReport,
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
  formatDesignLoopSelectionsPromptBlock,
  maybeAutoPinFromOperatorMessage,
  maybeAutoPinDominantLogoFromMock,
  designLoopAskNeedsImageEdit,
  refreshDesignLoopConcepts,
  readPhaseDesignPack,
  resolveDesignLoopGenerateFallback,
  detectMockDrift,
  patchMockForAssetContinue,
  getDesignLoopSelections,
  readDesignLoopMeta,
  buildLiveSiteInventory,
  writeLiveSiteInventory,
  formatLiveSiteInventoryPromptBlock,
  patchMockNavFromInventory,
  CONTINUE_INTENT_DEFAULT,
  fallbackContinueIntentFromText,
  normalizeContinueIntent,
  continueIntentAllowsLogoSwap,
  formatContinueIntentPromptBlock,
  readSharedDesignImport,
  formatSharedDesignPromptBlock,
  detectShareSourceFromText,
  readShareableDesign,
  importDesignShareIntoLoop,
  extractSiblingProjectPaths,
  unpinDesignLoopSelection,
  pinDesignLoopLogoAsset,
  dominantMockLogoAsset,
  getDesignLoopScope,
  applyContinueIntentToScope,
  classifyDesignScopeFromText,
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
  extractPlanDocument,
  validatePlanDocument,
  resolvePlanLoopGenerateFallback,
  scaffoldPlanDocument,
  PLAN_CONTINUE_INTENT_DEFAULT,
  fallbackPlanContinueIntentFromText,
  formatPlanContinueIntentPromptBlock,
  formatPhaseBoundPlanPromptBlock,
  readPhasePlanPack,
  type ContinueIntent,
  type PlanContinueIntent,
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
} from "@slopcontrol/coding-tools";
import {
  chatWithImages,
  classifyContinueIntentViaLlm,
  classifyPlanContinueIntentViaLlm,
  filterRasterVisionPaths,
  type LlmRegistry,
} from "@slopcontrol/llm";
import {
  ensureChangeIntentAsync,
  previewChangeIntentAsync,
} from "./change-intent-async.js";
import { dirname, join } from "node:path";
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
}

export interface StartResearchInput {
  project: Project;
  phase: Phase;
  run: Run;
  description: string;
  /** Advance run stage (e.g. researching → drafting) without guessing wall-clock in the HTTP layer. */
  onStage?: (stage: RunStage) => void;
}

export interface AskTurnInput {
  project: Project;
  askId: string;
  message: string;
  /** Prior messages excluding the new user message (already appended by caller optionally) */
  history: Array<{ role: "user" | "assistant"; content: string }>;
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
}

export interface PlanLoopGenerateInput {
  project: Project;
  loopId: string;
  brief: string;
  message?: string;
  previousPlan?: string;
  version: number;
}

export interface AgentTurnInput {
  project: Project;
  agentId: string;
  message: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
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
): string {
  const path = writeCheckReport(project.rootPath, run.id, name, output);
  log(project, run, `--- Check report written: ${path} ---`);
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

/** True when brief/feedback likely needs image search/gen/edit/review tools. */
function designLoopNeedsMediaTools(brief: string, message?: string): boolean {
  const text = `${brief}\n${message ?? ""}`;
  if (designLoopAskNeedsImageEdit(text)) return true;
  return /\b(image|images|search|generate|logo|photo|photos|stock|openverse|import|review|vision|icon|mark|alpha|transparent|favicon|pin)\b/i.test(
    text,
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
  opts?: { maxSteps?: number; timeoutMs?: number },
): Promise<string> {
  const name =
    (agent as { name?: string }).name ??
    (agent as { id?: string }).id ??
    "agent";
  const maxSteps = opts?.maxSteps ?? 30;
  const timeoutMs = opts?.timeoutMs;
  const started = Date.now();
  slog.info("agent", `start ${name}`, {
    resourceId,
    threadId,
    promptChars: prompt.length,
    maxSteps,
    timeoutMs,
  });
  try {
    const generate = () =>
      agent.generate(prompt, {
        maxSteps,
        memory: {
          resource: resourceId,
          thread: threadId,
        },
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
    if (/memory|storage|libsql|observational/i.test(detail)) {
      slog.error(
        "agent",
        "Mastra Memory/storage failure — check ~/.slopcontrol/mastra.db is writable and the supervisor LLM endpoint resolves for observationalMemory",
        {
          hint: "GET /health → mastraStorage; configure endpoints.json supervisor role",
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
    runner = withEnvOverlay(baseRunner, llmOverlay);
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

  if (runBuildStep) {
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
    const phaseGate = validatePhaseDocForDev(phaseDoc);
    if (!phaseGate.ok) {
      const msg = `PHASE.md validation failed:\n${phaseGate.issues.map((i) => `- ${i}`).join("\n")}`;
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

  // Install before test/checks when node_modules is missing, stale (manifest
  // newer than nm), or forceDepsInstall (post-merge root verify).
  if (
    runTestStep &&
    needsDepsInstall(cwd, { force: opts?.forceDepsInstall === true })
  ) {
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

export class ChangeOrchestrator {
  constructor(private readonly ctx: OrchestratorContext) {}

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

    const prompt = `Project ask conversation (askId=${askId}).
Answer the operator using the codebase and planning docs. When shaping a change, include ## Task brief.

BLUEPRINT (excerpt):
${clipPromptSection("BLUEPRINT.md", blueprint, 6_000)}

ROADMAP (excerpt):
${clipPromptSection("ROADMAP.md", roadmap, 3_000)}

Recent conversation:
${historyBlock}

Operator message:
${message.trim()}`;

    const reply = await runAgent(
      this.ctx.agents.askAgent,
      prompt,
      project.id,
      `ask-${askId}`,
      { maxSteps: 20, timeoutMs: 180_000 },
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
  }> {
    const { project, loopId, brief, message, previousHtml, version } = input;
    ensureSlopcontrolDir(project.rootPath);
    const isContinue = version > 1 || Boolean(previousHtml?.trim());
    const desc = [brief, message ?? ""].filter(Boolean).join("\n");
    const continueText = message?.trim() || desc;

    // Primary classification: LLM → structured ContinueIntent. Regex fallback
    // only when registry/LLM unavailable (offline, timeout, parse failure).
    let continueIntent: ContinueIntent = CONTINUE_INTENT_DEFAULT;
    if (isContinue) {
      const fallback = fallbackContinueIntentFromText(continueText);
      try {
        const { endpoint, modelId } = this.ctx.registry.resolveEndpointForRole(
          "classification",
        );
        continueIntent = await classifyContinueIntentViaLlm({
          endpoint,
          modelId,
          message: continueText,
          brief,
          timeoutMs: 15_000,
        });
      } catch (err) {
        slog.warn("design-loop", "continue intent LLM failed; regex fallback", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
        continueIntent = fallback;
      }
      continueIntent = normalizeContinueIntent(continueIntent, continueText);
    } else {
      continueIntent = {
        ...CONTINUE_INTENT_DEFAULT,
        scope: "full_revise",
        preserveChrome: false,
      };
    }

    // Conceptual model scope: classify on start; patch on continue from intent/chat.
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
          : classifyDesignScopeFromText(brief || desc, { source: "start" });
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
    // restore the superseded mark. Skip auto-pin from mock on invent turns.
    if (isContinue && continueIntent.inventLogo) {
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
      } else if (
        /\b(pin|go with|use|select|choose)\b/i.test(message) &&
        /\b(logo|mark|\.png|\.svg|\.webp)\b/i.test(message)
      ) {
        slog.warn("design-loop", "chat asked to pin logo but no match found", {
          loopId,
          messagePreview: message.slice(0, 200),
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

    const pinnedLogo =
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

    // Deterministic icon-pack derive + patch before any agent rewrite.
    let workingPreviousHtml = previousHtml;
    let assetPatchNotes = "";
    const wantsIconPack =
      continueIntent.wantsAssetEdit &&
      /\bicon\s*pack|favicon|browser\s*pack\b/i.test(message ?? desc);
    if (
      isContinue &&
      continueIntent.wantsAssetEdit &&
      wantsIconPack &&
      workingPreviousHtml?.trim()
    ) {
      try {
        const pack = await deriveIconPackFromAsset({
          projectRoot: project.rootPath,
          loopId,
          preferredFilename: pinnedLogo ?? undefined,
          prefix: `icon-v${version}`,
        });
        workingPreviousHtml = patchMockForAssetContinue({
          previousHtml: workingPreviousHtml,
          loopId,
          primaryLogoAsset: pack.sourceFilename || pinnedLogo,
          iconPackFiles: pack.files,
        });
        const redirectNote = pack.redirectedFrom
          ? ` (source redirected from ${pack.redirectedFrom} → ${pack.sourceFilename})`
          : "";
        assetPatchNotes = `Icon pack ${pack.files.length} sizes from ${pack.sourceFilename}${redirectNote}.`;
      } catch (err) {
        slog.warn("design-loop", "deterministic icon pack failed; falling through", {
          loopId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
      return {
        html: navHtml,
        notes: `${assetPatchNotes} Prior layout/shell preserved.`,
        usedScaffold: false,
      };
    }

    // Skip agent rewrite when asset-only OR preserve-only (no nav-align left to do).
    if (
      isContinue &&
      workingPreviousHtml?.trim() &&
      (continueIntent.scope === "assets_only" ||
        (continueIntent.preserveChrome &&
          continueIntent.wantsAssetEdit &&
          wantsIconPack &&
          !continueIntent.navAlign))
    ) {
      const assetHtml = pinnedLogo
        ? patchMockForAssetContinue({
            previousHtml: workingPreviousHtml,
            loopId,
            primaryLogoAsset: pinnedLogo,
          })
        : workingPreviousHtml;
      return {
        html: assetHtml,
        notes: `Asset-only continue: ${assetPatchNotes || "prior mock preserved"}. Prior layout/nav/shell preserved.`,
        usedScaffold: false,
      };
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
    const needsMedia =
      designLoopNeedsMediaTools(brief, message) || continueIntent.inventLogo;
    const needsEdit =
      designLoopAskNeedsImageEdit(desc) && !continueIntent.inventLogo;
    const modeBlock = isContinue
      ? formatContinueIntentPromptBlock(continueIntent)
      : "";

    // Chat-driven design share: "pull the theme from jamroast" auto-imports.
    // Gate: adopt-theme intent, brand/palette/typography targets, or an explicit path.
    // Do NOT treat inventLogo alone as a share request (avoids self-alias traps).
    if (isContinue && message?.trim()) {
      const mentionsPath = extractSiblingProjectPaths(message).length > 0;
      const wantsSharedDesign =
        continueIntent.adoptTheme ||
        mentionsPath ||
        continueIntent.targets.some((t) =>
          ["palette", "tokens", "typography", "brand"].includes(t),
        );
      if (wantsSharedDesign) {
        const detected = detectShareSourceFromText({
          targetRoot: project.rootPath,
          text: message,
          listProjects: input.listProjects,
          findProjectByRootPath: input.findProjectByRootPath,
        });
        if (detected) {
          try {
            const share = readShareableDesign(detected);
            if (share) {
              importDesignShareIntoLoop({
                targetRoot: project.rootPath,
                loopId,
                share,
              });
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
        } else if (continueIntent.adoptTheme || mentionsPath) {
          slog.warn("design-loop", "adopt-theme intent but no resolvable source in message", {
            loopId,
          });
        }
      }
    }

    // Cross-project design share: SHARED DESIGN outranks LIVE SITE for palette/logos.
    const sharedImport = readSharedDesignImport(project.rootPath, loopId);
    const sharedDesignBlock = formatSharedDesignPromptBlock(sharedImport);
    const sharedDesignActive = Boolean(sharedDesignBlock) || continueIntent.adoptTheme;
    siteInventoryBlock = formatLiveSiteInventoryPromptBlock(siteInventory, 6_500, {
      sharedDesignActive,
    });
    if (sharedDesignBlock) {
      slog.info("design-loop", "shared design import active", {
        loopId,
        from: sharedImport?.source.name ?? sharedImport?.source.rootPath,
      });
    }

    const htmlReturnRule =
      continueIntent.scope === "assets_only" || continueIntent.scope === "nav_align"
        ? "Prefer MOCK_ASSETS_ONLY (no full HTML). If you return HTML, keep prior mock; only asset src / icon-pack / LIVE SITE nav updates."
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

    const authorityCritical = sharedDesignActive
      ? "CRITICAL: SHARED DESIGN (or adopt-theme sibling excerpts) is authoritative for palette, tokens, dual theme, and logos. LIVE SITE is authoritative for nav labels/hrefs, routes, and extracted screen copy only — do not invent menu items or purple/cream palettes. For screens with extracted headings/columns/fields/buttons, use that copy verbatim."
      : "CRITICAL: LIVE SITE inventory below is authoritative for nav labels/hrefs, routes, tokens, logos, and extracted screen copy / entity fields. Do not invent menu items. For screens with extracted headings/columns/fields/buttons, use that copy verbatim — do not lorem-ipsum. Invent content only for routes with no extraction. Sibling cues are secondary.";

    const prompt = `Design loop ${loopId} — produce version v${version} mock HTML.

${authorityCritical}
Current loopId (required for media tools): ${loopId}
${modeBlock ? `${modeBlock}\n` : ""}${conceptualModelBlock}

${needsEdit
  ? "Operator asked for an IMAGE EDIT (alpha/icon pack/resize). Call make_transparent / derive_icon_pack / resize_image — do NOT generate_image. Prefer pinned / true RGBA sources."
  : continueIntent.inventLogo
    ? "Operator asked for a NEW logo. Call generate_image with inventNew=true, embed the new relativePath, then pin_logo that filename. Do not reuse the superseded pin."
    : "When inventing a new mark, call generate_image with inventNew=true if a logo was previously pinned. For stock photos use search_images / import_image. For look critique use review_look."}
Otherwise prefer writing the mock with few or zero tool calls.

${selectionsBlock}

${sharedDesignBlock ? `${sharedDesignBlock}\n` : ""}${siteInventoryBlock ? `${siteInventoryBlock}\n` : ""}
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
      raw = await runAgent(
        this.ctx.agents.designLoopAgent,
        prompt,
        project.id,
        // Fresh thread per version — previousHtml carries the visual contract;
        // sticky threads were ~65–90k tokens of prior mocks/tool junk.
        `design-loop-${loopId}-v${version}`,
        // Media tools need headroom; layout-only continues stay lean.
        {
          maxSteps:
            continueIntent.scope === "assets_only" ? 8 : needsMedia ? 12 : 4,
          timeoutMs: 300_000,
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      slog.warn("design-loop", `generate failed; preserving prior mock if any`, {
        loopId,
        error: detail,
      });
      return resolveDesignLoopGenerateFallback({
        brief,
        previousHtml: workingPreviousHtml ?? previousHtml,
        errorDetail: detail,
        scaffold: scaffoldDesignLoopMock,
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
      return {
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
      };
    }

    if (!extracted) {
      const fallback = resolveDesignLoopGenerateFallback({
        brief,
        previousHtml: workingPreviousHtml ?? previousHtml,
        errorDetail: "no HTML in agent output",
        scaffold: scaffoldDesignLoopMock,
      });
      usedScaffold = fallback.usedScaffold;
      return {
        ...fallback,
        notes:
          fallback.notes ||
          (usedScaffold ? "Scaffold mock (no HTML in agent output)" : `v${version}`),
      };
    }

    let html = extracted;
    if (isContinue && baseHtml && continueIntent.scope !== "full_revise") {
      const drift = detectMockDrift({
        previousHtml: baseHtml,
        nextHtml: html,
        intent: continueIntent,
        pinnedLogoAsset: pinnedLogo,
      });
      if (drift.length) {
        const intentSummary = `intent={scope:${continueIntent.scope}, adoptTheme:${continueIntent.adoptTheme}, inventLogo:${continueIntent.inventLogo}, preserveChrome:${continueIntent.preserveChrome}, targets:[${continueIntent.targets.join(",")}]}`;
        slog.warn("design-loop", "rejecting drifted mock; keeping prior + asset patch", {
          loopId,
          version,
          issues: drift.map((d) => d.code),
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
        const notes = [
          assetPatchNotes,
          `Rejected layout/logo drift (${drift.map((d) => d.code).join(", ")}); kept prior mock.`,
          intentSummary,
          ...drift.map((d) => d.detail),
        ]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1_500);
        return { html, notes, usedScaffold: false };
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
    } else if (continueIntent.inventLogo && html?.trim()) {
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

    const notes = raw
      .replace(/```[\s\S]*?```/g, "")
      .replace(/<!DOCTYPE[\s\S]*/i, "")
      .replace(/MOCK_HTML_COMPLETE/gi, "")
      .replace(/MOCK_ASSETS_ONLY/gi, "")
      .trim()
      .slice(0, 1_500);
    return {
      html,
      notes: notes || `v${version}`,
      usedScaffold: false,
    };
  }

  /**
   * Generate or revise a plan-loop PLAN.md (no product / phase writes).
   */
  async planLoopGenerate(input: PlanLoopGenerateInput): Promise<{
    plan: string;
    notes: string;
    usedScaffold: boolean;
  }> {
    const { project, loopId, brief, message, previousPlan, version } = input;
    ensureSlopcontrolDir(project.rootPath);
    const isContinue = version > 1 || Boolean(previousPlan?.trim());
    const desc = [brief, message ?? ""].filter(Boolean).join("\n");

    let continueIntent: PlanContinueIntent = PLAN_CONTINUE_INTENT_DEFAULT;
    if (isContinue) {
      const fallback = fallbackPlanContinueIntentFromText(
        message?.trim() || desc,
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
          timeoutMs: 15_000,
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

    const metaNow = readPlanLoopMeta(project.rootPath, loopId);
    if (metaNow) {
      let scope = metaNow.scope ?? defaultPlanScope(brief, "start");
      if (isContinue) {
        if (continueIntent.focus) {
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
        } else if (continueIntent.scope === "full_revise") {
          scope = defaultPlanScope(message?.trim() || brief, "continue");
        }
      }
      if (
        !metaNow.scope ||
        scope.focus !== metaNow.scope.focus ||
        scope.kind !== metaNow.scope.kind
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

    const prompt = `Plan loop ${loopId} — produce version v${version} PLAN.md.

${conceptual}
${modeBlock ? `\n${modeBlock}\n` : ""}
${acceptanceBlock ? `${acceptanceBlock}\n(Ticked sections are locked unless the operator reopens them.)\n` : ""}

Brief:
${clipPromptSection("brief", brief, 3_000)}

${message?.trim() ? `Operator feedback:\n${clipPromptSection("feedback", message, 3_000)}\n` : ""}
${reviseBlock}

Required H2 sections: Goal, Constraints, In scope, Out of scope, Approach, Likely areas, Success criteria, Risks & open questions, Handoff notes.
Return a short rationale then the full plan in a markdown fence. End with PLAN_COMPLETE.`;

    let raw = "";
    try {
      raw = await runAgent(
        this.ctx.agents.planLoopAgent,
        prompt,
        project.id,
        `plan-loop-${loopId}-v${version}`,
        { maxSteps: 10, timeoutMs: 240_000 },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      slog.warn("plan-loop", "generate failed; preserving prior plan if any", {
        loopId,
        error: detail,
      });
      return resolvePlanLoopGenerateFallback({
        brief,
        previousPlan,
        errorDetail: detail,
        scope,
      });
    }

    if (continueIntent.scope === "clarify_only" && previousPlan?.trim()) {
      const notes = raw
        .replace(/```[\s\S]*?```/g, "")
        .replace(/PLAN_COMPLETE/gi, "")
        .trim()
        .slice(0, 1_500);
      return {
        plan: previousPlan.trim(),
        notes: notes || "Clarify-only continue; prior plan preserved.",
        usedScaffold: false,
      };
    }

    let plan = extractPlanDocument(raw);
    if (!plan?.trim() && previousPlan?.trim()) {
      return {
        plan: previousPlan.trim(),
        notes: "No PLAN.md extracted; kept prior plan.",
        usedScaffold: true,
      };
    }
    if (!plan?.trim()) {
      return {
        plan: scaffoldPlanDocument({
          brief,
          scope,
          errorDetail: "empty agent plan",
        }),
        notes: "Scaffold — empty agent output",
        usedScaffold: true,
      };
    }

    const validation = validatePlanDocument(plan);
    if (!validation.ok && previousPlan?.trim()) {
      const priorOk = validatePlanDocument(previousPlan);
      if (priorOk.ok) {
        return {
          plan: previousPlan.trim(),
          notes: `Rejected incomplete plan (missing: ${validation.missing.join(", ") || "—"}; empty: ${validation.empty.join(", ") || "—"}); kept prior.`,
          usedScaffold: true,
        };
      }
    }
    if (!validation.ok && !previousPlan?.trim()) {
      return {
        plan: scaffoldPlanDocument({
          brief,
          scope,
          errorDetail: `incomplete: missing ${validation.missing.join(",")}`,
        }),
        notes: `Scaffold — incomplete plan sections`,
        usedScaffold: true,
      };
    }

    const notes = raw
      .replace(/```[\s\S]*?```/g, "")
      .replace(/^#\s+Plan[\s\S]*/im, "")
      .replace(/PLAN_COMPLETE/gi, "")
      .trim()
      .slice(0, 1_500);

    return {
      plan,
      notes: notes || `v${version}`,
      usedScaffold: false,
    };
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

    const prompt = `Project agent chat (agentId=${agentId}).
Inspect/verify using repo tools and run_command in the project root. Do not start development or phases.

BLUEPRINT (excerpt):
${clipPromptSection("BLUEPRINT.md", blueprint, 6_000)}

ROADMAP (excerpt):
${clipPromptSection("ROADMAP.md", roadmap, 3_000)}

Recent conversation:
${historyBlock}

Operator message:
${message.trim()}`;

    const reply = await runAgent(
      this.ctx.agents.agentChatAgent,
      prompt,
      project.id,
      `agent-${agentId}`,
      { maxSteps: 24, timeoutMs: 240_000 },
    );
    return { reply: reply.trim() || "(empty reply)" };
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
    const brandResearchNote = isBrandThemingAsk(
      `${intent.title}\n${intent.goal}\n${description}`,
    )
      ? `
Brand / theming research (mandatory when Change Intent is brand/theming):
- Prefer sibling **consumed** logo paths (Header / shell \`img\` / \`next/image\` → usually \`public/images/logo.svg\`).
- Do NOT treat \`public/brand/*-reuse.svg\` or other tiny tile+circle stubs as the sibling's real mark.
- Probe family siblings when relevant (e.g. burntjam alongside JamPress).
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
    const acceptanceBlock = formatAcceptancePromptBlock(designAcceptance);
    const designPackBlock = formatDesignPackPromptBlock(
      readPhaseDesignPack(project.rootPath, phase.id),
    );
    const boundMockBlock = formatPhaseBoundMockPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxHtmlChars: 10_000,
    });
    const phasePackForResearch = readPhaseDesignPack(project.rootPath, phase.id);
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
    const acceptanceResearchNote = designAcceptance?.features?.some((f) => f.accepted)
      ? `
Design-loop acceptance (authoritative scope for this phase):
${acceptanceBlock}
- RESEARCH must figure out HOW to implement every IN SCOPE feature (concrete files, mounts, token paths).
- Do NOT expand into OUT OF SCOPE features; treat them as mustNot.
- If applied_shell is in scope, plan portal/dashboard UI fidelity to the accepted mock frames — not palette-only.
- Obey DESIGN_PACK.json logos/tokens/contentPillars/scope/theme; do not invent a competing mark.
- If conceptual model scope.kind is component/flow, File Changes must stay within focusPaths/focus — do not expand to full site shell.
${themeResearchNote}${designPackBlock ? `\n${designPackBlock}\n` : ""}${boundMockBlock ? `\n${boundMockBlock}\n` : ""}
`
      : [designPackBlock, boundMockBlock].filter(Boolean).join("\n\n")
        ? `\n${themeResearchNote}${[designPackBlock, boundMockBlock].filter(Boolean).join("\n\n")}\n`
        : "";
    const prompt = `Change request:
${clipPromptSection("change-request", description, 4_000)}

${intentBlock}
${planResearchNote}${acceptanceResearchNote}${adjacentPack ? `${adjacentPack}\n` : ""}${siblingBrandPack ? `${siblingBrandPack}\n` : ""}Phase id: ${phase.id}
${engagementHonesty}${brandResearchNote}
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
      return "failed";
    }

    onStage?.("drafting");
    return this.draftPhase({ project, phase, run, onStage });
  }

  async draftPhase(input: {
    project: Project;
    phase: Phase;
    run: Run;
    onStage?: (stage: RunStage) => void;
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
    const designRoutingNote =
      intent.changeKind === "chrome-hide" || intent.changeKind === "backend"
        ? isBrandThemingAsk(`${intent.title}\n${intent.goal}\n${phase.description}`)
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
        : isBrandThemingAsk(`${intent.title}\n${intent.goal}\n${phase.description}`)
          ? `
Design routing (brand/theming):
- Near the top of PHASE.md include \`Requires design pass: yes\`.
- Include ## Brand and ## Assets with concrete logo/wordmark/favicon briefs (not empty tables).
- Decide shell scope explicitly; do not freeze marketing/portal shells without stating palette-only.
- Automated Checks: no design-fallback SVGs in public/brand/; wordmarks must not glue words (e.g. JamLight); shells must reference the new lockup.
`
          : "";

    const draftAcceptance = readPhaseDesignAcceptance(
      project.rootPath,
      phase.id,
    );
    const draftAcceptanceBlock = formatAcceptancePromptBlock(draftAcceptance);
    const draftPhasePack = readPhaseDesignPack(project.rootPath, phase.id);
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
    const draftThemeNote = packHasThemeModes(draftPhasePack)
      ? `
CRITICAL theme_modes: Plan File Changes for html[data-theme] light remaps of semantic tokens; ThemeToggle must set data-theme; body/chrome on var(--background)/var(--foreground) — not hard-coded --color-dark-* alone.
`
      : "";
    const draftBoundMock = formatPhaseBoundMockPromptBlock({
      projectRoot: project.rootPath,
      phaseId: phase.id,
      maxHtmlChars: 8_000,
    });
    const draftAcceptanceNote = draftAcceptance?.features?.some((f) => f.accepted)
      ? `
${draftAcceptanceBlock}
CRITICAL: Scope, File Changes, Success Criteria, and Automated Checks MUST cover every IN SCOPE feature above.
Do NOT plan OUT OF SCOPE features. Unticked items are mustNot for this phase.
File Changes must reference DESIGN_PACK logos/tokens/scope/theme and \`.slopcontrol/phases/${phase.id}/design/mock.html\` — do not invent a competing mark.
${draftPlanNote}${draftThemeNote}${draftPackBlock ? `\n${draftPackBlock}\n` : ""}${draftBoundMock ? `\n${draftBoundMock}\n` : ""}
`
      : [draftPlanNote, draftPackBlock, draftBoundMock].filter(Boolean).join("\n\n")
        ? `\n${draftPlanNote}${draftThemeNote}${[draftPackBlock, draftBoundMock].filter(Boolean).join("\n\n")}\n`
        : "";

    const buildDraftPrompt = (slim: boolean) => {
      const pack = slim ? "" : adjacentPack ? `${adjacentPack}\n` : "";
      const blueprintClip = slim ? 2_500 : 6_000;
      const researchClip = slim ? 4_000 : 8_000;
      return `Draft PHASE.md for phase ${phase.id} only (single phase).
Description:
${clipPromptSection("change-request", phase.description, 4_000)}

${intentBlock}
${draftAcceptanceNote}${designRoutingNote}${pack}CRITICAL: Scope and File Changes must implement THIS phase's RESEARCH.md below.
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
        return "failed";
      }
      const scaffolded = scaffoldPhaseDoc({
        phaseId: phase.id,
        description: phase.description,
        research,
        testCommand: config.testCommand,
        intent,
      });
      log(project, run, reason);
      writePhaseDoc(project.rootPath, phase.id, scaffolded);
    };

    const recoverableDraftFail = (detail: string): RunStage => {
      log(
        project,
        run,
        `ERROR drafting PHASE.md (research intact). Handoff: retry draft.\n${detail}`,
      );
      writePhaseStatus(project.rootPath, phase.id, "draft");
      return "failed";
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

      const needsRepair =
        !resolved.gate.ok ||
        resolved.source === "none" ||
        (resolved.alignIssues?.length ?? 0) > 0;

      if (needsRepair) {
        const alignBlock =
          resolved.alignIssues && resolved.alignIssues.length > 0
            ? `Research alignment issues:\n${resolved.alignIssues.map((i) => `- ${i}`).join("\n")}\n`
            : "";
        slog.warn("planning", "PHASE.md failed structure/alignment gate; retrying once", {
          projectId: project.id,
          phaseId: phase.id,
          issues: resolved.gate.issues,
          alignIssues: resolved.alignIssues,
          source: resolved.source,
          path: resolved.path,
        });
        const repairPrompt = `Your previous PHASE.md was invalid (chat preamble, missing sections, or wrong-phase content).
Issues:
${resolved.gate.issues.map((i) => `- ${i}`).join("\n")}
${alignBlock}
${formatChangeIntentPromptBlock(intent)}
Rewrite the FULL PHASE.md starting with # Title — output ONLY the markdown document (no "here is what changed").
If you use write_file, path must be exactly: ${canonicalPath}
Required sections: ## Scope, ## File Changes, ## Success Criteria, ## Automated Checks (bash fence, no curl with API keys), ## Blueprint Deltas.
Base Scope/File Changes ONLY on the RESEARCH below — do not copy a prior phase's host-routing plan.
Obey Change Intent uiMount / interaction contract — do not substitute chips for a fillable mount.
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
            (resolved.alignIssues?.length ?? 0) > 0;

          if (stillBad) {
            const scaffolded = finishWithScaffold(
              `PHASE.md still invalid after repair (${[
                ...resolved.gate.issues,
                ...(resolved.alignIssues ?? []),
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
    const gate = validatePhaseDocForDev(phaseDoc);
    const align = phaseDocAlignsWithResearch(
      phaseDoc,
      research,
      phase.description,
    );
    if (!gate.ok) {
      log(
        project,
        run,
        `PHASE.md still invalid after scaffold:\n${gate.issues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(gate.issues.join("; "));
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
      return "failed";
    }
    if (!align.ok) {
      log(
        project,
        run,
        `PHASE.md still misaligned with RESEARCH after scaffold:\n${align.issues.join("\n")}`,
      );
      if (researchLooksSolid(research)) {
        return recoverableDraftFail(align.issues.join("; "));
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
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
        return recoverableDraftFail(intentAlign.issues.join("; "));
      }
      writePhaseStatus(project.rootPath, phase.id, "blocked");
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
      const gate = validatePhaseDocForDev(phaseDoc);
      if (!gate.ok) {
        log(
          project,
          run,
          `--- Cannot approve: PHASE.md failed validation ---\n${gate.issues.map((i) => `- ${i}`).join("\n")}`,
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
    const brandAsk = isBrandThemingAsk(
      `${intent.title}\n${intent.goal}\n${phase.description}`,
    );
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
    const developAcceptanceBlock =
      formatAcceptancePromptBlock(developAcceptance);
    const developPhasePack = readPhaseDesignPack(project.rootPath, phase.id);
    const developPackBlock = formatDesignPackPromptBlock(developPhasePack);
    const developThemeNote = packHasThemeModes(developPhasePack)
      ? `CRITICAL: Implement DESIGN_PACK.theme — html[data-theme] toggle, light token remaps for --background/--surface/--foreground, body/chrome on semantic vars (not hard-coded --color-dark-* alone).`
      : null;
    const designContext = [
      developAcceptance?.features?.length ? developAcceptanceBlock : null,
      developThemeNote,
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
    let lastHandoffDiagnosis: HandoffDiagnosisSnippet | undefined;

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
          const processShell =
            /Broken Automated Check|incomplete shell compound|shell syntax|line continuation|api-routing-complete-gate|Chat stream hang|class:\*\* process|class=process|post-merge root verify/i.test(
              appendix,
            );
          prompt = processShell
            ? `Fix the APPENDIX Failure diagnosis. This is a **process** failure (PHASE.md Automated Checks and/or incomplete Ollama OpenAI-compat routing).
If the diagnosis mentions Automated Checks shell/syntax: FIRST edit \`.slopcontrol/phases/${phase.id}/PHASE.md\` — rewrite the failing check into one complete statement.
If the diagnosis mentions Stream started hang or api-routing-complete-gate: implement the promised routing files (model-resolver / OLLAMA_BASE_URL / chat route) — do NOT complete on catalogue-only diffs; do NOT force free-tier.
If the diagnosis mentions post-merge root verify: fix files so project-root tests pass (gitignored artifacts must match the worktree); do not claim DEV_COMPLETE from worktree-only green.
Then ensure build/tests pass. Before DEV_COMPLETE, append \`## Operator handoff\` to APPENDIX. Print DEV_COMPLETE when success criteria and Automated Checks pass.`
            : `Fix the implementation using the latest APPENDIX Failure diagnosis.
Address the **root cause of the failing step first** — do not expand scope or invent bring-up scripts.
Ensure ## Automated Checks and tests pass. Fix spawn ENOENT-style bugs by splitting command vs args.
Do NOT burn the session on live API probing or rate-limit waits — edit files and run local Automated Checks.
Do NOT chase infra bring-up (missing local services) inside the app repo — follow APPENDIX failure class.
Before DEV_COMPLETE, append \`## Operator handoff\` (Operator requirements / Knowledge / Follow-ups) to APPENDIX. Print DEV_COMPLETE when build, tests, and phase success criteria pass.`;
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
        });
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
                { mode: "verify", forceDepsInstall: true },
              );
              persistCheckOutput(
                project,
                run,
                `iter${iteration}-root-verify`,
                rootChecks.output,
                rootChecks.ok,
              );
              log(
                project,
                run,
                `--- Post-merge root verify summary ---\n${rootChecks.summary}`,
              );
              if (!rootChecks.ok) {
                lastFailWasPostMergeRootVerify = true;
                const rootFail = rootChecks.firstFailure;
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
                    rootFail?.output ?? rootChecks.output,
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
                  steps: [...(checks.steps ?? []), ...(rootChecks.steps ?? []), postMergeStep],
                  firstFailure: postMergeStep,
                  summary: buildCheckSummary(
                    false,
                    [...(checks.steps ?? []), ...(rootChecks.steps ?? []), postMergeStep],
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
                    rootChecks.output,
                  ].join("\n\n"),
                  steps: [...(checks.steps ?? []), ...(rootChecks.steps ?? [])],
                  summary: rootChecks.summary,
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
        );
        log(
          project,
          run,
          `SUCCESS CHECKS FAILED — diagnosis summary:\n${checks.summary}`,
        );

        const diagnosis = buildFailureDiagnosis({
          output: checks.summary || checks.output,
          firstFailure: checks.firstFailure,
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

        const supervisorPrompt = `Enrich this Failure diagnosis (do not re-litigate full logs).
Iteration ${iteration}. Diagnosis streak: ${diagnosisStreak}/${MAX_DIAGNOSIS_STREAK}.
No-progress: ${noProgressCount}/${MAX_NO_PROGRESS}. Infra strikes: ${infraStrikeCount}/2.
Plan coverage: ${planProgress.summary}

${lastDiagnosisCard}

PHASE excerpt:
${phaseDoc.slice(0, 4000)}

Worktree: ${worktree.path}
${learningsForSupervisor ? `\n${learningsForSupervisor}` : ""}

Respond with:
## Next actions
(concise instructions for the coding tool addressing the failing step — or operator actions if infra)

If unrecoverable, include DEV_BLOCKED on its own line.
Do not invent bring-up scripts for infra. Fix broken Automated Checks in PHASE.md when class=process/shell — edit \`.slopcontrol/phases/<phaseId>/PHASE.md\` before product files.`;

        const supervisorTimeoutMs = Number(
          process.env.SLOPCONTROL_SUPERVISOR_MS ?? 90_000,
        );
        let supervisorOutput = "";
        try {
          supervisorOutput = await runAgent(
            this.ctx.agents.devSupervisorAgent,
            supervisorPrompt,
            project.id,
            run.id,
            { timeoutMs: supervisorTimeoutMs, maxSteps: 12 },
          );
        } catch (error) {
          if (signal?.aborted) return markInterrupted();
          const message =
            error instanceof Error ? error.message : String(error);
          // Keep deterministic diagnosis — do not invent a conflicting retry narrative.
          log(
            project,
            run,
            `Supervisor timed out/failed (keeping diagnosis): ${message}`,
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
