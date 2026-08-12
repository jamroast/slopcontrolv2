/**
 * BuildToolchain seam — per-project build-system commands as data.
 *
 * SlopControl orchestrates (publish → propagate → docker → CI) but the
 * project's own build system executes. The descriptor lives in
 * `.slopcontrol/config.json` (`ProjectConfig.toolchain`) so new ecosystems
 * are resolved per project (by the LLM build-process configurator) without
 * touching SlopControl core. Node adapters below are defaults/hints only.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  BuildToolchainSpecSchema,
  type BuildToolchainSpec,
} from "@slopcontrol/types";

export const REGISTRY_ENV_KEYS = [
  "SLOPCONTROL_NPM_REGISTRY_URL",
  "SLOPCONTROL_NPM_REGISTRY_DOCKER_URL",
  "SLOPCONTROL_NPM_REGISTRY_AUTH_HOST",
  "SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST",
  "SLOPCONTROL_NPM_REGISTRY_TOKEN",
] as const;

const NODE_PNPM_SPEC: BuildToolchainSpec = BuildToolchainSpecSchema.parse({
  kind: "node-pnpm",
  buildCmd: ["pnpm", "run", "build"],
  installCmd: ["pnpm", "install"],
  frozenInstallCmd: ["pnpm", "install", "--frozen-lockfile"],
  bumpVersionCmd: ["pnpm", "version", "{bump}", "--no-git-tag-version"],
  publishCmd: [
    "pnpm",
    "publish",
    "--registry",
    "{registryUrl}",
    "--no-git-checks",
  ],
  consumeUpdateCmd: ["pnpm", "add", "{dep}"],
  lockfiles: ["pnpm-lock.yaml"],
  registryEnvKeys: [...REGISTRY_ENV_KEYS],
});

const NODE_NPM_SPEC: BuildToolchainSpec = BuildToolchainSpecSchema.parse({
  kind: "node-npm",
  buildCmd: ["npm", "run", "build"],
  installCmd: ["npm", "install"],
  frozenInstallCmd: ["npm", "ci"],
  bumpVersionCmd: ["npm", "version", "{bump}", "--no-git-tag-version"],
  publishCmd: ["npm", "publish", "--registry", "{registryUrl}"],
  consumeUpdateCmd: ["npm", "install", "{dep}"],
  lockfiles: ["package-lock.json"],
  registryEnvKeys: [...REGISTRY_ENV_KEYS],
});

const DEFAULT_SPECS: Record<string, BuildToolchainSpec> = {
  "node-pnpm": NODE_PNPM_SPEC,
  "node-npm": NODE_NPM_SPEC,
};

/** Default command spec for a known ecosystem kind, else null. */
export function defaultToolchainSpec(kind: string): BuildToolchainSpec | null {
  const spec = DEFAULT_SPECS[kind];
  return spec ? BuildToolchainSpecSchema.parse(spec) : null;
}

export type ToolchainDetectHint = {
  /** Primary ecosystem guess (node lockfiles win over manifests). */
  kind: string;
  /** Files that drove the guess (evidence for the LLM configurator). */
  matched: string[];
  /** True when `kind` has a built-in default spec. */
  hasDefaultSpec: boolean;
};

/**
 * Cheap deterministic hint from on-disk files. pnpm preferred when both
 * lockfiles exist (SlopControl standardizes consumers on pnpm). This feeds
 * the LLM configurator — it is not the final word.
 */
export function detectBuildToolchain(projectRoot: string): ToolchainDetectHint {
  const has = (rel: string): boolean => existsSync(join(projectRoot, rel));
  const matched: string[] = [];
  for (const rel of [
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
  ]) {
    if (has(rel)) matched.push(rel);
  }
  let kind = "unknown";
  if (has("pnpm-lock.yaml")) kind = "node-pnpm";
  else if (has("package-lock.json")) kind = "node-npm";
  else if (has("yarn.lock") || has("bun.lockb") || has("package.json"))
    kind = "node-pnpm";
  else if (has("Cargo.toml")) kind = "rust-cargo";
  else if (has("pyproject.toml") || has("requirements.txt")) kind = "python";
  else if (has("go.mod")) kind = "go";
  return { kind, matched, hasDefaultSpec: kind in DEFAULT_SPECS };
}

/** Fill `{placeholder}` tokens in a command template. */
export function substituteCommandArgs(
  template: string[],
  vars: Record<string, string>,
): string[] {
  return template.map((arg) =>
    arg.replace(/\{([a-zA-Z]+)\}/g, (m, key: string) => vars[key] ?? m),
  );
}

/** True when a command template contains no unresolved placeholders. */
export function commandTemplateComplete(template: string[]): boolean {
  return !template.some((a) => /\{[a-zA-Z]+\}/.test(a));
}

export function toolchainBuildCmd(spec: BuildToolchainSpec): string[] | null {
  return spec.buildCmd ?? null;
}

export function toolchainInstallCmd(
  spec: BuildToolchainSpec,
  opts: { frozen: boolean },
): string[] | null {
  if (opts.frozen) return spec.frozenInstallCmd ?? spec.installCmd ?? null;
  return spec.installCmd ?? null;
}

export function toolchainBumpVersionCmd(
  spec: BuildToolchainSpec,
  bump: "patch" | "minor" | "major",
): string[] | null {
  if (!spec.bumpVersionCmd) return null;
  return substituteCommandArgs(spec.bumpVersionCmd, { bump });
}

export function toolchainPublishCmd(
  spec: BuildToolchainSpec,
  registryUrl: string,
): string[] | null {
  if (!spec.publishCmd) return null;
  return substituteCommandArgs(spec.publishCmd, { registryUrl });
}

export function toolchainConsumeUpdateCmd(
  spec: BuildToolchainSpec,
  dep: string,
): string[] | null {
  if (!spec.consumeUpdateCmd) return null;
  return substituteCommandArgs(spec.consumeUpdateCmd, { dep });
}

/**
 * Persisted specs drifted before the defaults gained `--no-git-tag-version`:
 * without it `npm/pnpm version` demands a clean git tree, which is never true
 * right after a phase merge, so auto-publish bump steps fail. Normalize at
 * resolve time so drifted configs keep working.
 */
function normalizeToolchainSpec(spec: BuildToolchainSpec): BuildToolchainSpec {
  if (
    (spec.kind === "node-pnpm" || spec.kind === "node-npm") &&
    spec.bumpVersionCmd &&
    !spec.bumpVersionCmd.includes("--no-git-tag-version")
  ) {
    return {
      ...spec,
      bumpVersionCmd: [...spec.bumpVersionCmd, "--no-git-tag-version"],
    };
  }
  return spec;
}

/**
 * Resolve the effective spec for a project: persisted config wins, else the
 * detected-kind default (when one exists), else null (needs the LLM
 * configurator).
 */
export function resolveProjectToolchain(opts: {
  projectRoot: string;
  configured?: BuildToolchainSpec | null;
}): { spec: BuildToolchainSpec | null; source: "config" | "default" | "none" } {
  if (opts.configured) {
    return {
      spec: normalizeToolchainSpec(BuildToolchainSpecSchema.parse(opts.configured)),
      source: "config",
    };
  }
  const hint = detectBuildToolchain(opts.projectRoot);
  const def = defaultToolchainSpec(hint.kind);
  if (def) return { spec: def, source: "default" };
  return { spec: null, source: "none" };
}

export type RunCommandResult = {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
};

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join("***");
  }
  return out;
}

/**
 * Run one toolchain command (no shell — argv array). Output is collected,
 * secret-redacted, and optionally streamed. Timeout SIGKILLs the child.
 */
export async function runToolchainCommand(opts: {
  cmd: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Secrets to strip from captured output (e.g. registry token). */
  redactSecrets?: string[];
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}): Promise<RunCommandResult> {
  const [bin, ...args] = opts.cmd;
  if (!bin) throw new Error("runToolchainCommand: empty command");
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const secrets = opts.redactSecrets ?? [];
  const started = Date.now();

  return await new Promise<RunCommandResult>((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      const chunk = redact(d.toString("utf-8"), secrets);
      stdout += chunk;
      opts.onOutput?.("stdout", chunk);
    });
    child.stderr.on("data", (d: Buffer) => {
      const chunk = redact(d.toString("utf-8"), secrets);
      stderr += chunk;
      opts.onOutput?.("stderr", chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      });
    });
  });
}
