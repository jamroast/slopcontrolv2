import { z } from "zod";

export { log, slog, type LogLevel } from "./log.js";
export { redactSecrets, safeJsonForLog } from "./redact.js";

export const LlmApiTypeSchema = z.enum([
  "openai-chat",
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "openai-images",
]);

export type LlmApiType = z.infer<typeof LlmApiTypeSchema>;

export const LlmCapabilitiesSchema = z
  .object({
    chat: z.boolean().default(true),
    /** Model accepts images in chat (e.g. kimi-k2.7-code). Never true for glm-5.2. */
    vision: z.boolean().default(false),
    /** Model can generate images (Ollama Flux / Z-Image, etc.). */
    imageGen: z.boolean().default(false),
  })
  .default({ chat: true, vision: false, imageGen: false });

export type LlmCapabilities = z.infer<typeof LlmCapabilitiesSchema>;

export const LlmEndpointSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  apiType: LlmApiTypeSchema,
  modelId: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  defaultParams: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
      topP: z.number().optional(),
    })
    .optional(),
  timeoutMs: z.number().positive().optional(),
  reasoningVariant: z.enum(["low", "medium", "high"]).optional(),
  capabilities: LlmCapabilitiesSchema.optional(),
});

export type LlmEndpoint = z.infer<typeof LlmEndpointSchema>;

export const AgentRoleSchema = z.enum([
  "research",
  "planning",
  "supervisor",
  "coding",
  "design",
  "designVision",
  "designImage",
  /** Structured JSON classification (continue-intent, change-intent) */
  "classification",
]);

export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const RoleBindingSchema = z.object({
  endpointId: z.string().min(1),
  modelId: z.string().optional(),
});

export type RoleBinding = z.infer<typeof RoleBindingSchema>;

export const RoleModelBindingsSchema = z.object({
  research: RoleBindingSchema,
  planning: RoleBindingSchema,
  supervisor: RoleBindingSchema,
  coding: RoleBindingSchema,
  /** UI-SPEC / tokens text — defaults to planning when omitted */
  design: RoleBindingSchema.optional(),
  /** Multimodal design review — must bind a vision-capable model */
  designVision: RoleBindingSchema.optional(),
  /** Raster image generation — must bind an imageGen-capable model */
  designImage: RoleBindingSchema.optional(),
  /**
   * Structured JSON classification (continue-intent / change-intent).
   * Defaults to planning when omitted.
   */
  classification: RoleBindingSchema.optional(),
});

export type RoleModelBindings = z.infer<typeof RoleModelBindingsSchema>;

export const EndpointsConfigSchema = z.object({
  endpoints: z.array(LlmEndpointSchema),
  roles: RoleModelBindingsSchema,
});

export type EndpointsConfig = z.infer<typeof EndpointsConfigSchema>;

export const PhaseStatusSchema = z.enum([
  "draft",
  "in_review",
  "accepted",
  "designing",
  /** Design pass finished; ready for development (path B). */
  "design_complete",
  "developing",
  "complete",
  "blocked",
  "interrupted",
]);

export type PhaseStatus = z.infer<typeof PhaseStatusSchema>;

export const RunStageSchema = z.enum([
  "idle",
  "researching",
  "drafting",
  "in_review",
  "accepted",
  "designing",
  /** Design pass finished; ready for development (path B). */
  "design_complete",
  "developing",
  "complete",
  "blocked",
  "failed",
  "interrupted",
]);

export type RunStage = z.infer<typeof RunStageSchema>;

export const LearningKindSchema = z.enum([
  "infra",
  "product",
  "process",
  "model",
  "env",
]);

export type LearningKind = z.infer<typeof LearningKindSchema>;

export const LearningSeveritySchema = z.enum(["blocker", "warning", "note"]);

export type LearningSeverity = z.infer<typeof LearningSeveritySchema>;

export const LearningRecordSchema = z.object({
  id: z.string().min(1),
  kind: LearningKindSchema,
  tags: z.array(z.string().min(1)).default([]),
  title: z.string().min(1),
  lesson: z.string().min(1),
  evidence: z.string().optional(),
  sourcePhaseId: z.string().optional(),
  sourceRunId: z.string().optional(),
  severity: LearningSeveritySchema.default("warning"),
  createdAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  hitCount: z.number().int().positive().default(1),
});

export type LearningRecord = z.infer<typeof LearningRecordSchema>;

export const LearningIndexSchema = z.object({
  version: z.literal(1).default(1),
  learnings: z.array(LearningRecordSchema).default([]),
});

export type LearningIndex = z.infer<typeof LearningIndexSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rootPath: z.string().min(1),
  blueprintVersion: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Project = z.infer<typeof ProjectSchema>;

export const AskMessageRoleSchema = z.enum(["user", "assistant"]);

export type AskMessageRole = z.infer<typeof AskMessageRoleSchema>;

export const AskMessageMetaSchema = z
  .object({
    kind: z.enum(["sub_research"]).optional(),
    topic: z.string().optional(),
  })
  .optional();

export type AskMessageMeta = z.infer<typeof AskMessageMetaSchema>;

export const AskMessageSchema = z.object({
  role: AskMessageRoleSchema,
  content: z.string().min(1),
  at: z.string().datetime(),
  meta: AskMessageMetaSchema,
});

export type AskMessage = z.infer<typeof AskMessageSchema>;

/** Shared chat message for design-loop / plan-loop (Ask parity). */
export const LoopChatMessageMetaSchema = z
  .object({
    kind: z.enum(["working", "final", "system"]).optional(),
    version: z.number().int().positive().optional(),
    assets: z.array(z.string()).optional(),
    ops: z.array(z.string()).optional(),
  })
  .optional();

export type LoopChatMessageMeta = z.infer<typeof LoopChatMessageMetaSchema>;

export const LoopChatMessageSchema = z.object({
  role: AskMessageRoleSchema,
  content: z.string().min(1),
  at: z.string().datetime(),
  meta: LoopChatMessageMetaSchema,
});

export type LoopChatMessage = z.infer<typeof LoopChatMessageSchema>;

export const AskStatusSchema = z.enum(["open", "promoted", "archived"]);

export type AskStatus = z.infer<typeof AskStatusSchema>;

export const AskSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().optional(),
  status: AskStatusSchema,
  messages: z.array(AskMessageSchema).default([]),
  promotedPhaseId: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AskSession = z.infer<typeof AskSessionSchema>;

/** Max parallel ephemeral sub-research topics per ask request. */
export const ASK_SUB_RESEARCH_MAX_TOPICS = 4;

export const AgentMessageSchema = AskMessageSchema;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export const AgentStatusSchema = z.enum(["open", "archived"]);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  title: z.string().optional(),
  status: AgentStatusSchema,
  messages: z.array(AgentMessageSchema).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const PhaseSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  description: z.string().min(1),
  status: PhaseStatusSchema,
  /** 1-based ordinal used in directory names like 01-slug */
  ordinal: z.number().int().positive().optional(),
  slug: z.string().optional(),
  title: z.string().optional(),
  /**
   * Optional phase ids that must be `complete` before this phase can start development.
   * Research/draft may still run; development is blocked until deps are met.
   */
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Checked-out worktree path when development has started */
  worktreePath: z.string().optional(),
  worktreeBranch: z.string().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type Phase = z.infer<typeof PhaseSchema>;

/** Phases that are not yet complete among `dependsOn`. */
export function unmetPhaseDependencies(
  phase: Pick<Phase, "dependsOn" | "id">,
  allPhases: Phase[],
): Array<{ id: string; status: PhaseStatus | "missing" }> {
  const deps = phase.dependsOn ?? [];
  if (deps.length === 0) return [];

  const byId = new Map(allPhases.map((p) => [p.id, p]));
  const unmet: Array<{ id: string; status: PhaseStatus | "missing" }> = [];
  for (const depId of deps) {
    if (depId === phase.id) continue; // ignore self-dep
    const dep = byId.get(depId);
    if (!dep) {
      unmet.push({ id: depId, status: "missing" });
      continue;
    }
    if (dep.status !== "complete") {
      unmet.push({ id: depId, status: dep.status });
    }
  }
  return unmet;
}

export function phaseDependenciesSatisfied(
  phase: Pick<Phase, "dependsOn" | "id">,
  allPhases: Phase[],
): boolean {
  return unmetPhaseDependencies(phase, allPhases).length === 0;
}

export const StageTimingSchema = z.object({
  stage: RunStageSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

export type StageTiming = z.infer<typeof StageTimingSchema>;

export const RunSchema = z.object({
  id: z.string().min(1),
  phaseId: z.string().min(1),
  projectId: z.string().min(1),
  stage: RunStageSchema,
  iterationCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  /** When pipeline work first left idle */
  startedAt: z.string().datetime().optional(),
  /** When a terminal stage was reached */
  finishedAt: z.string().datetime().optional(),
  /** Wall time from startedAt → finishedAt */
  totalDurationMs: z.number().int().nonnegative().optional(),
  /** Per-stage timing segments (closed when the stage changes) */
  stageTimings: z.array(StageTimingSchema).default([]),
});

export type Run = z.infer<typeof RunSchema>;

const TERMINAL_STAGES = new Set<RunStage>([
  "complete",
  "blocked",
  "failed",
]);

/**
 * Close the open stage timing (if any) and start a new segment for `nextStage`.
 * Mutates and returns the same run object for convenience.
 * No-ops timing when `nextStage` equals the current stage.
 */
export function recordStageTransition(
  run: Run,
  nextStage: RunStage,
  at: Date = new Date(),
): Run {
  const now = at.toISOString();
  const timings = [...(run.stageTimings ?? [])];
  const previousStage = run.stage;

  if (run.stage === nextStage && timings.length > 0) {
    run.updatedAt = now;
    return run;
  }

  const last = timings[timings.length - 1];
  if (last && !last.endedAt) {
    last.endedAt = now;
    last.durationMs = Math.max(0, at.getTime() - Date.parse(last.startedAt));
  }

  timings.push({ stage: nextStage, startedAt: now });

  run.stage = nextStage;
  run.stageTimings = timings;
  run.updatedAt = now;

  if (!run.startedAt && nextStage !== "idle") {
    run.startedAt = now;
  }

  if (TERMINAL_STAGES.has(nextStage)) {
    const terminal = timings[timings.length - 1];
    if (terminal && !terminal.endedAt) {
      terminal.endedAt = now;
      terminal.durationMs = Math.max(
        0,
        at.getTime() - Date.parse(terminal.startedAt),
      );
    }
    run.finishedAt = now;
    if (run.startedAt) {
      run.totalDurationMs = Math.max(0, at.getTime() - Date.parse(run.startedAt));
    }
  } else if (TERMINAL_STAGES.has(previousStage)) {
    // Retry after failed/blocked — run is active again
    run.finishedAt = undefined;
    run.totalDurationMs = undefined;
  }

  return run;
}

export function formatDurationMs(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm}m`;
}

export const BuildToolchainSpecSchema = z.object({
  /**
   * Open-ended ecosystem id: "node-pnpm" | "node-npm" ship as defaults;
   * anything else ("rust-cargo", "python-uv", ...) is LLM-resolved per project.
   */
  kind: z.string().min(1),
  buildCmd: z.array(z.string().min(1)).optional(),
  installCmd: z.array(z.string().min(1)).optional(),
  frozenInstallCmd: z.array(z.string().min(1)).optional(),
  /** {bump} placeholder → patch|minor|major. */
  bumpVersionCmd: z.array(z.string().min(1)).optional(),
  /** {registryUrl} placeholder → target registry URL. */
  publishCmd: z.array(z.string().min(1)).optional(),
  /** {dep} placeholder → name@^version. */
  consumeUpdateCmd: z.array(z.string().min(1)).optional(),
  lockfiles: z.array(z.string().min(1)).default([]),
  registryEnvKeys: z.array(z.string().min(1)).default([]),
});

export type BuildToolchainSpec = z.infer<typeof BuildToolchainSpecSchema>;

/**
 * One build-process change proposed by the LLM configurator (or Hermes).
 * Structured + allowlisted so the deterministic apply layer can validate
 * before touching disk. `edit_json.set` uses dot-path keys ("scripts.build").
 */
export const BuildProcessConfigChangeSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("write_file"),
    path: z.string().min(1),
    content: z.string(),
    rationale: z.string().default(""),
  }),
  z.object({
    op: z.literal("edit_json"),
    path: z.string().min(1),
    set: z.record(z.string(), z.unknown()),
    rationale: z.string().default(""),
  }),
  z.object({
    op: z.literal("replace_section"),
    path: z.string().min(1),
    markerStart: z.string().min(1),
    markerEnd: z.string().min(1),
    content: z.string(),
    rationale: z.string().default(""),
  }),
  z.object({
    op: z.literal("run_command"),
    command: z.array(z.string().min(1)).min(1),
    rationale: z.string().default(""),
  }),
]);

export type BuildProcessConfigChange = z.infer<
  typeof BuildProcessConfigChangeSchema
>;

/** LLM configurator output: resolved toolchain + proposed changes. */
export const BuildProcessConfigResultSchema = z.object({
  toolchain: BuildToolchainSpecSchema,
  gaps: z.array(z.string()).default([]),
  changes: z.array(BuildProcessConfigChangeSchema).default([]),
  notes: z.string().default(""),
  confidence: z.enum(["low", "medium", "high"]),
});

export type BuildProcessConfigResult = z.infer<
  typeof BuildProcessConfigResultSchema
>;

export const ProjectConfigSchema = z.object({
  buildCommand: z.string().default("npm run build"),
  testCommand: z.string().default("npm test"),
  /** Optional post-build verification (e.g. docker compose + SQL probe) */
  verifyCommand: z.string().optional(),
  /**
   * Optional command run before root testCommand during verify
   * (e.g. ensure Postgres is healthy). Exit non-zero = infra failure.
   */
  verifyPreflightCommand: z.string().optional(),
  /**
   * When true (default), run testCommand during development success checks.
   * With autoMergeOnComplete, tests run on the project root after merge
   * (where gitignored env files like .env.docker live).
   */
  runTestsOnComplete: z.boolean().default(true),
  /**
   * When true (default), merge the phase worktree into the project root and
   * run tests / Automated Checks on the root tree before marking complete.
   * Worktree gate is build-only so missing gitignored env files do not
   * false-fail tests.
   */
  autoMergeOnComplete: z.boolean().default(true),
  /**
   * Branch in the project folder to merge into (and leave checked out) when
   * auto-merging. Defaults to the current branch when unset.
   */
  mergeTargetBranch: z.string().min(1).optional(),
  /**
   * When true (default), remove the phase worktree after a successful
   * auto-merge on development complete.
   */
  removeWorktreeOnComplete: z.boolean().default(true),
  /**
   * Relative paths copied from project root → phase worktree on create/reuse
   * (gitignored secrets/env). Defaults cover common dotenv files.
   */
  worktreeSyncPaths: z
    .array(z.string().min(1))
    .default([
      ".env",
      ".env.local",
      ".env.docker",
      ".env.test",
      ".env.development.local",
      ".env.test.local",
      ".env.production.local",
    ]),
  /**
   * LLM test harness profile for verify / Automated Checks.
   * - local: point tests at local Ollama (or pipeline URL via process.env)
   * - fixture: deterministic fake client (no HTTP)
   * - live: use project cloud env (opt-in only)
   */
  llmTestProfile: z.enum(["local", "fixture", "live"]).default("local"),
  /** Project-relative dotenv used for the test harness (default `.env.test`). */
  llmTestEnvFile: z.string().min(1).default(".env.test"),
  /**
   * Live LLM smoke during verify.
   * - off (default): skip cloud/local chat smoke
   * - local: smoke against resolved test env (local Ollama / pipeline)
   * - live: smoke against root `.env.docker` cloud credentials
   */
  llmSmokeMode: z.enum(["off", "local", "live"]).default("off"),
  /**
   * Rewrite app cloud model IDs → local/test names during verify env overlay
   * (e.g. `{ "glm-5.2:cloud": "llama3.2" }`). Merged into envMap for model keys.
   */
  llmModelMap: z.record(z.string(), z.string()).optional(),
  /**
   * Generic value remaps applied to resolved project env (any technology).
   * Applied after file/process merge. llmModelMap is merged on top for AI_* models.
   */
  envMap: z.record(z.string(), z.string()).optional(),
  /**
   * Extra process.env keys to include even if absent from project .env* files
   * (e.g. CI-only secrets). Prefer setting vars that also appear in .env files.
   */
  envPassthroughKeys: z.array(z.string().min(1)).optional(),
  /**
   * Prefixes for process.env keys to include when not in project files
   * (e.g. `["DATABASE_", "CLERK_"]`). Default empty — no wholesale OS dump.
   */
  envPassthroughPrefixes: z.array(z.string().min(1)).optional(),
  codingToolId: z.string().default("opencode"),
  /**
   * Max wall-clock ms for a single OpenCode coding turn.
   * Overrides SLOPCONTROL_CODING_TURN_MS when set. Default elsewhere is 600000.
   */
  codingTurnTimeoutMs: z.number().int().positive().optional(),
  roleBindings: RoleModelBindingsSchema.partial().optional(),
  /** DesignTool id (default ollama-images). */
  designToolId: z.string().default("ollama-images"),
  /** Relative dir in the worktree for generated brand assets. */
  designAssetDir: z.string().min(1).default("public/brand"),
  /**
   * When true (default), phases that need design run the design stage before coding.
   * Set false to skip even when UI-SPEC/Assets exist.
   */
  enableDesignPass: z.boolean().default(true),
  /**
   * Resolved build toolchain (commands as data) for this project.
   * Written by the build-process configurator (LLM) or manual override;
   * consumed by publish / propagate / docker / CI surfaces.
   */
  toolchain: BuildToolchainSpecSchema.optional(),
  /**
   * True when this project is a shared component/design library whose
   * changes should auto-publish to the registry after phases complete.
   */
  componentLibrary: z.boolean().default(false),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const BlueprintStatusSchema = z.enum([
  "created",
  "fresh",
  "updated",
  "missing",
  "needs_intent",
]);

export type BlueprintStatus = z.infer<typeof BlueprintStatusSchema>;

export const ProjectOpenModeSchema = z.enum(["greenfield", "existing"]);

export type ProjectOpenMode = z.infer<typeof ProjectOpenModeSchema>;

export const RunActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open_project"),
    rootPath: z.string().min(1),
    name: z.string().optional(),
    /** Required when the project tree is empty (greenfield). */
    intent: z.string().optional(),
    forceRefresh: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("start_research"),
    projectId: z.string(),
    description: z.string(),
    /** Optional phase ids this new phase depends on */
    dependsOn: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    action: z.literal("submit_review"),
    runId: z.string(),
    decision: z.enum(["approve", "request_changes"]),
    feedback: z.string().optional(),
  }),
  z.object({
    action: z.literal("start_development"),
    runId: z.string(),
    /**
     * When true, run the design stage first if the phase needs it
     * (UI/brand path B). Default false — callers should use start_design
     * or set this when chaining.
     */
    autoDesign: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("start_design"),
    runId: z.string(),
    /** When true, re-run design even if DESIGN_COMPLETE + UI-SPEC already exist. */
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("stop_run"),
    runId: z.string(),
  }),
  z.object({
    action: z.literal("retry_development"),
    runId: z.string(),
  }),
  z.object({
    action: z.literal("retry_verify"),
    runId: z.string(),
  }),
  z.object({
    action: z.literal("delete_run"),
    runId: z.string(),
  }),
  z.object({
    action: z.literal("set_phase_dependencies"),
    phaseId: z.string(),
    dependsOn: z.array(z.string().min(1)),
  }),
  z.object({
    action: z.literal("reinit_project"),
    /** Prefer projectId when known; otherwise rootPath */
    projectId: z.string().optional(),
    rootPath: z.string().optional(),
    /** Optional notes to fold into the reverse-engineered blueprint */
    notes: z.string().optional(),
  }),
  z.object({
    action: z.literal("rerun_research"),
    runId: z.string(),
  }),
  z.object({
    action: z.literal("list_worktrees"),
    projectId: z.string(),
  }),
  z.object({
    action: z.literal("merge_phase"),
    projectId: z.string(),
    phaseId: z.string(),
    /** Branch in the project root to merge into (default: current branch) */
    targetBranch: z.string().optional(),
    commitMessage: z.string().optional(),
    /** Remove the phase worktree after a successful merge (default true) */
    removeWorktree: z.boolean().optional(),
    /**
     * Stash dirty project-root files before merge (default true).
     * Set false to refuse when the project directory is dirty.
     */
    stashDirty: z.boolean().optional(),
    /**
     * On merge conflicts with the phase branch: prefer_phase (default) or abort.
     */
    conflictStrategy: z.enum(["prefer_phase", "abort"]).optional(),
  }),
  z.object({
    action: z.literal("list_conflicts"),
    projectId: z.string(),
  }),
  z.object({
    action: z.literal("resolve_conflicts"),
    projectId: z.string(),
    /**
     * ours | theirs | phase | auto (default).
     * auto prefers phase work during merges and post-merge stash conflicts.
     */
    strategy: z.enum(["ours", "theirs", "phase", "auto"]).optional(),
    /** Used when strategy is phase or auto */
    phaseId: z.string().optional(),
    /** Optional subset of paths to resolve */
    paths: z.array(z.string()).optional(),
    /** Complete an in-progress merge commit when conflicts clear (default true) */
    continueMerge: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("get_git_status"),
    projectId: z.string(),
  }),
  z.object({
    action: z.literal("checkout_branch"),
    projectId: z.string(),
    branch: z.string().min(1),
    /** Create the branch if missing (default false) */
    create: z.boolean().optional(),
    /** Stash dirty files before checkout (default true) */
    stashDirty: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("remove_worktree"),
    projectId: z.string(),
    phaseId: z.string(),
    /** Also delete the local slop/<phaseId> branch (default false) */
    deleteBranch: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("preview_change_intent"),
    projectId: z.string(),
    /** Operator description to score (engagement / mount heuristics). */
    description: z.string().min(1),
    /** Optional phase id for refinementOf lookup exclude + PHASE alignment. */
    phaseId: z.string().optional(),
    /** When true, also align against that phase's PHASE.md if present. */
    checkPhaseDoc: z.boolean().optional(),
    /** Skip planning LLM; use heuristic extract only (offline tests). */
    heuristicOnly: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("reconcile_blueprint"),
    projectId: z.string(),
    /** Prefer INTENT from this phase when resolving mount conflicts. */
    phaseId: z.string().optional(),
    /** When true (default), do not write BLUEPRINT.md — return the report + live slice only. */
    dryRun: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("audit_ui_gates"),
    projectId: z.string(),
    /** Description that should trigger engagement Intent (optional if phaseId has INTENT). */
    description: z.string().optional(),
    phaseId: z.string().optional(),
    /** Skip planning LLM; use heuristic extract only (offline tests). */
    heuristicOnly: z.boolean().optional(),
  }),
]);

export type RunAction = z.infer<typeof RunActionSchema>;

export const IterationMemoryEntrySchema = z.object({
  iteration: z.number().int().positive(),
  status: z.string(),
  errorCount: z.number().int().nonnegative(),
  errorHash: z.string(),
  noProgressStreak: z.number().int().nonnegative(),
  timestamp: z.string().datetime(),
  details: z.string(),
  /** Distilled supervisor ## Next actions (no tool/OM blobs). */
  nextActionsSummary: z.string().optional(),
});

export type IterationMemoryEntry = z.infer<typeof IterationMemoryEntrySchema>;

export const COMPLETION_TOKENS = {
  PHASE_COMPLETE: "PHASE_COMPLETE",
  DEV_COMPLETE: "DEV_COMPLETE",
  DEV_BLOCKED: "DEV_BLOCKED",
} as const;

export type CompletionToken =
  (typeof COMPLETION_TOKENS)[keyof typeof COMPLETION_TOKENS];
