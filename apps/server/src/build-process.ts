/**
 * Build-process configurator — shared service layer.
 *
 * One implementation behind both the MCP tools and the REST endpoints so
 * Hermes (REST) and agents (MCP) can never diverge. Composes the
 * deterministic artifacts helpers with the LLM configurator.
 */

import {
  applyBuildProcessChanges,
  collectBuildProcessEvidence,
  readBuildProcessEvidence,
  readProjectConfig,
  renderCiWorkflowYaml,
  renderPublishWorkflowYaml,
  runToolchainCommand,
  toolchainBuildCmd,
  toolchainInstallCmd,
  resolveProjectToolchain,
  writeBuildProcessEvidence,
  writeProjectConfig,
  writeProjectRegistryEnv,
  type AppliedChange,
  type BuildProcessEvidence,
  type NpmRegistryMeta,
  type ProjectRegistryEnvWrite,
} from "@slopcontrol/artifacts";
import { configureBuildProcessViaLlm } from "@slopcontrol/llm";
import {
  BuildToolchainSpecSchema,
  type BuildProcessConfigChange,
  type BuildProcessConfigResult,
  type BuildToolchainSpec,
  type LlmEndpoint,
} from "@slopcontrol/types";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type BuildProcessState = {
  toolchain: BuildToolchainSpec | null;
  evidence: BuildProcessEvidence | null;
  /** Canonical registry env values for .env.docker / CI secrets (when known). */
  registryEnv?: Record<string, string>;
};

/** GET state: resolved toolchain + recorded evidence. No LLM call. */
export function getProjectBuildProcessState(opts: {
  projectRoot: string;
  registryEnv?: Record<string, string>;
}): BuildProcessState {
  const config = readProjectConfig(opts.projectRoot);
  return {
    toolchain: config.toolchain ?? null,
    evidence: readBuildProcessEvidence(opts.projectRoot),
    ...(opts.registryEnv ? { registryEnv: opts.registryEnv } : {}),
  };
}

export type BuildProcessAuditReport = {
  result: BuildProcessConfigResult;
  applied: false;
  auditOnly: boolean;
};

/** LLM audit: resolve toolchain + gaps, propose changes — apply nothing. */
export async function auditProjectBuildProcess(opts: {
  projectRoot: string;
  endpoint: LlmEndpoint;
  modelId?: string;
}): Promise<BuildProcessAuditReport> {
  const config = readProjectConfig(opts.projectRoot);
  const evidenceText = collectBuildProcessEvidence({
    projectRoot: opts.projectRoot,
    configuredToolchain: config.toolchain ?? null,
  });
  const result = await configureBuildProcessViaLlm({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    evidence: evidenceText,
  });
  writeBuildProcessEvidence(opts.projectRoot, {
    toolchain: result.toolchain,
    gaps: result.gaps,
    notes: result.notes,
    confidence: result.confidence,
    origin: "llm",
    lastAuditAt: new Date().toISOString(),
    applied: [],
  });
  return { result, applied: false, auditOnly: true };
}

export type BuildProcessConfigureReport = {
  result: BuildProcessConfigResult;
  applied: boolean;
  auditOnly: boolean;
  changes: AppliedChange[];
  commandRuns: Array<{ command: string[]; code: number; durationMs: number }>;
};

/**
 * LLM configure: resolve → guardrailed apply → persist toolchain.
 * Low confidence = audit-only (nothing applied, evidence still recorded).
 */
export async function configureProjectBuildProcess(opts: {
  projectRoot: string;
  endpoint: LlmEndpoint;
  modelId?: string;
  /** Execute allowlisted run_command entries (default true). */
  runCommands?: boolean;
  commandTimeoutMs?: number;
}): Promise<BuildProcessConfigureReport> {
  const audit = await auditProjectBuildProcess(opts);
  const { result } = audit;
  const now = new Date().toISOString();

  if (result.confidence === "low") {
    return {
      result,
      applied: false,
      auditOnly: true,
      changes: [],
      commandRuns: [],
    };
  }

  const { results, pendingCommands } = applyBuildProcessChanges({
    projectRoot: opts.projectRoot,
    changes: result.changes,
    toolchain: result.toolchain,
  });

  // Deterministic CI fallback: only when the project has NO workflow at
  // all. The LLM owns amendments to existing workflows — overwriting a
  // richer pipeline with the minimal template destroys project-specific
  // triggers/steps (observed on Jamlight's ci.yml).
  const touchedWorkflows = results.some(
    (r) =>
      r.applied &&
      "path" in r.change &&
      typeof r.change.path === "string" &&
      r.change.path.startsWith(".github/workflows/"),
  );
  const workflowsDir = join(opts.projectRoot, ".github", "workflows");
  const hasAnyWorkflow =
    existsSync(workflowsDir) &&
    readdirSync(workflowsDir).some((f) => /\.ya?ml$/.test(f));
  if (!touchedWorkflows && !hasAnyWorkflow) {
    const fallbackChanges: BuildProcessConfigChange[] = [];
    const ciYaml = renderCiWorkflowYaml(result.toolchain);
    if (ciYaml) {
      fallbackChanges.push({
        op: "write_file",
        path: ".github/workflows/ci.yml",
        content: ciYaml,
        rationale: "deterministic CI fallback (LLM left workflows untouched)",
      });
    }
    if (fallbackChanges.length) {
      const applied = applyBuildProcessChanges({
        projectRoot: opts.projectRoot,
        changes: fallbackChanges,
        toolchain: result.toolchain,
      });
      results.push(...applied.results);
    }
  }

  // Component libraries always need the publish workflow — check for it
  // independently of whether the LLM touched ci.yml.
  if (readProjectConfig(opts.projectRoot).componentLibrary) {
    const wrotePublish = results.some(
      (r) =>
        r.applied &&
        "path" in r.change &&
        typeof r.change.path === "string" &&
        /publish/i.test(r.change.path),
    );
    if (!wrotePublish && !existsSync(join(opts.projectRoot, ".github", "workflows", "publish.yml"))) {
      const publishYaml = renderPublishWorkflowYaml(result.toolchain);
      if (publishYaml) {
        const applied = applyBuildProcessChanges({
          projectRoot: opts.projectRoot,
          changes: [
            {
              op: "write_file",
              path: ".github/workflows/publish.yml",
              content: publishYaml,
              rationale:
                "deterministic publish fallback (componentLibrary, no publish workflow)",
            },
          ],
          toolchain: result.toolchain,
        });
        results.push(...applied.results);
      }
    }
  }

  const commandRuns: Array<{ command: string[]; code: number; durationMs: number }> = [];
  if (opts.runCommands !== false) {
    for (const command of pendingCommands) {
      const run = await runToolchainCommand({
        cmd: command,
        cwd: opts.projectRoot,
        timeoutMs: opts.commandTimeoutMs ?? 10 * 60_000,
        redactSecrets: [process.env.SLOPCONTROL_NPM_REGISTRY_TOKEN ?? ""],
      });
      commandRuns.push({ command, code: run.code, durationMs: run.durationMs });
    }
  }

  const config = readProjectConfig(opts.projectRoot);
  config.toolchain = result.toolchain;
  writeProjectConfig(opts.projectRoot, config);

  writeBuildProcessEvidence(opts.projectRoot, {
    toolchain: result.toolchain,
    gaps: result.gaps,
    notes: result.notes,
    confidence: result.confidence,
    origin: "llm",
    lastAuditAt: now,
    lastConfigureAt: now,
    applied: results.map((r) => ({
      op: r.change.op,
      path: "path" in r.change ? r.change.path : undefined,
      rationale: r.change.rationale,
      applied: r.applied,
      detail: r.detail,
    })),
  });

  return {
    result,
    applied: true,
    auditOnly: false,
    changes: results,
    commandRuns,
  };
}

/** Hermes manual override: schema-validated, recorded with origin manual. */
export function updateProjectToolchain(opts: {
  projectRoot: string;
  toolchain: unknown;
  componentLibrary?: boolean;
}): { toolchain: BuildToolchainSpec; componentLibrary: boolean } {
  const toolchain = BuildToolchainSpecSchema.parse(opts.toolchain);
  const config = readProjectConfig(opts.projectRoot);
  config.toolchain = toolchain;
  if (typeof opts.componentLibrary === "boolean") {
    config.componentLibrary = opts.componentLibrary;
  }
  writeProjectConfig(opts.projectRoot, config);

  const prior = readBuildProcessEvidence(opts.projectRoot);
  writeBuildProcessEvidence(opts.projectRoot, {
    toolchain,
    gaps: prior?.gaps ?? [],
    notes: prior?.notes ?? "",
    confidence: prior?.confidence,
    origin: "manual",
    lastAuditAt: prior?.lastAuditAt,
    lastConfigureAt: new Date().toISOString(),
    applied: prior?.applied ?? [],
    onboarding: prior?.onboarding,
    lastOnboardAt: prior?.lastOnboardAt,
  });
  return { toolchain, componentLibrary: config.componentLibrary };
}

/** Library-shape heuristic: scoped non-private package with a build script. */
export function suggestComponentLibrary(projectRoot: string): boolean {
  try {
    const pkgPath = join(projectRoot, "package.json");
    if (!existsSync(pkgPath)) return false;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      name?: string;
      private?: boolean;
      scripts?: Record<string, string>;
    };
    return Boolean(
      pkg.name?.startsWith("@") && pkg.private !== true && pkg.scripts?.build,
    );
  } catch {
    return false;
  }
}

export type BuildProcessOnboardingReport = {
  status: "applied" | "audit-only" | "failed";
  toolchainKind?: string;
  suggestedComponentLibrary: boolean;
  envFiles: string[];
  tokenWritten: boolean;
  error?: string;
};

/**
 * Import-time onboarding: bring a newly registered project's build process
 * to the SlopControl capability contract. Runs the LLM configurator through
 * the guardrailed apply layer (no run_commands at import — verify separately),
 * persists the toolchain, and injects the canonical registry env into the
 * project's env files. NEVER throws — registration must not fail because the
 * LLM or registry is unavailable; failures land in the evidence record as
 * onboarding: "failed" for Hermes to surface.
 */
export async function onboardProjectBuildProcess(opts: {
  projectRoot: string;
  endpoint: LlmEndpoint;
  modelId?: string;
  /** Registry meta when the local registry exists; env injection skipped without it. */
  registryMeta?: Pick<NpmRegistryMeta, "url" | "port" | "authToken"> | null;
  /** Seed the auto-publish flag before configure (affects publish.yml fallback). */
  componentLibrary?: boolean;
}): Promise<BuildProcessOnboardingReport> {
  const prior = readBuildProcessEvidence(opts.projectRoot);
  const markStatus = (
    status: "running" | "applied" | "audit-only" | "failed",
    patch?: Partial<BuildProcessEvidence>,
  ) => {
    const current = readBuildProcessEvidence(opts.projectRoot);
    writeBuildProcessEvidence(opts.projectRoot, {
      toolchain: current?.toolchain ?? prior?.toolchain,
      gaps: current?.gaps ?? prior?.gaps ?? [],
      notes: current?.notes ?? prior?.notes ?? "",
      confidence: current?.confidence ?? prior?.confidence,
      origin: current?.origin ?? prior?.origin ?? "llm",
      lastAuditAt: current?.lastAuditAt ?? prior?.lastAuditAt,
      lastConfigureAt: current?.lastConfigureAt ?? prior?.lastConfigureAt,
      applied: current?.applied ?? prior?.applied ?? [],
      onboarding: status,
      lastOnboardAt: new Date().toISOString(),
      ...patch,
    });
  };

  const suggested = suggestComponentLibrary(opts.projectRoot);
  markStatus("running");
  try {
    if (typeof opts.componentLibrary === "boolean") {
      const config = readProjectConfig(opts.projectRoot);
      config.componentLibrary = opts.componentLibrary;
      writeProjectConfig(opts.projectRoot, config);
    }

    const report = await configureProjectBuildProcess({
      projectRoot: opts.projectRoot,
      endpoint: opts.endpoint,
      modelId: opts.modelId,
      runCommands: false,
    });

    let env: ProjectRegistryEnvWrite = { files: [], tokenWritten: false };
    if (opts.registryMeta) {
      env = writeProjectRegistryEnv({
        projectRoot: opts.projectRoot,
        meta: opts.registryMeta,
      });
    }

    const status = report.auditOnly ? "audit-only" : "applied";
    markStatus(status);
    return {
      status,
      toolchainKind: report.result.toolchain.kind,
      suggestedComponentLibrary: suggested,
      envFiles: env.files,
      tokenWritten: env.tokenWritten,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markStatus("failed", { notes: `onboarding failed: ${message}` });
    return {
      status: "failed",
      suggestedComponentLibrary: suggested,
      envFiles: [],
      tokenWritten: false,
      error: message,
    };
  }
}

export type BuildProcessVerifyStep = {
  step: "install" | "build";
  command: string[];
  code: number;
  durationMs: number;
  detail: string;
};

export type BuildProcessVerifyReport = {
  ok: boolean;
  toolchainKind: string;
  steps: BuildProcessVerifyStep[];
};

/**
 * Post-onboarding smoke check: frozen lockfile install + build, run with the
 * canonical registry env so committed config resolves exactly as it will for
 * operators and CI. Opt-in (Hermes button) — installs are too slow to run
 * implicitly at import time.
 */
export async function verifyProjectBuildProcess(opts: {
  projectRoot: string;
  registryMeta?: Pick<NpmRegistryMeta, "url" | "port" | "authToken"> | null;
  commandTimeoutMs?: number;
}): Promise<BuildProcessVerifyReport> {
  const config = readProjectConfig(opts.projectRoot);
  const { spec } = resolveProjectToolchain({
    projectRoot: opts.projectRoot,
    configured: config.toolchain,
  });
  if (!spec) {
    throw new Error(
      "no build toolchain resolved — run build-process configure first",
    );
  }
  const install = toolchainInstallCmd(spec, { frozen: true });
  const build = toolchainBuildCmd(spec);
  if (!install || !build) {
    throw new Error(
      `toolchain ${spec.kind} lacks install/build commands — verify unsupported`,
    );
  }

  const env = opts.registryMeta
    ? {
        SLOPCONTROL_NPM_REGISTRY_URL: opts.registryMeta.url,
        SLOPCONTROL_NPM_REGISTRY_AUTH_HOST: new URL(opts.registryMeta.url).host,
        SLOPCONTROL_NPM_REGISTRY_DOCKER_URL: `http://host.docker.internal:${opts.registryMeta.port}/`,
        SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST: `host.docker.internal:${opts.registryMeta.port}`,
        SLOPCONTROL_NPM_REGISTRY_TOKEN: opts.registryMeta.authToken,
      }
    : undefined;
  const timeoutMs = opts.commandTimeoutMs ?? 10 * 60_000;
  const steps: BuildProcessVerifyStep[] = [];

  const runStep = async (
    step: BuildProcessVerifyStep["step"],
    command: string[],
  ): Promise<BuildProcessVerifyStep> => {
    const run = await runToolchainCommand({
      cmd: command,
      cwd: opts.projectRoot,
      env,
      timeoutMs,
      redactSecrets: [opts.registryMeta?.authToken ?? ""],
    });
    const record: BuildProcessVerifyStep = {
      step,
      command,
      code: run.code,
      durationMs: run.durationMs,
      detail: (run.code === 0 ? run.stdout : run.stderr || run.stdout).slice(
        -400,
      ),
    };
    steps.push(record);
    return record;
  };

  const installStep = await runStep("install", install);
  if (installStep.code === 0) {
    await runStep("build", build);
  }
  return {
    ok: steps.every((s) => s.code === 0),
    toolchainKind: spec.kind,
    steps,
  };
}
