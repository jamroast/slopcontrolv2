/**
 * Verdaccio process lifecycle for SlopControl's private npm registry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  dirMaxMtimeMs,
  ensureNpmRegistryLayout,
  findRegisteredConsumers,
  isNpmRegistryDisabled,
  listNpmRegistryPackages,
  npmRegistryConfigPath,
  propagateLibraryVersion,
  readNpmRegistryMeta,
  readProjectConfig,
  resolveProjectToolchain,
  runToolchainCommand,
  toolchainBuildCmd,
  toolchainBumpVersionCmd,
  toolchainPublishCmd,
  npmRegistryEnvValues,
  writeNpmRegistryMeta,
  type NpmRegistryMeta,
  type PropagationResult,
} from "@slopcontrol/artifacts";
import type { BuildToolchainSpec } from "@slopcontrol/types";

const require = createRequire(import.meta.url);

let child: ChildProcess | null = null;
let starting = false;

function resolveVerdaccioBin(): string | null {
  try {
    const pkgJson = require.resolve("verdaccio/package.json");
    const root = dirname(pkgJson);
    const candidates = [
      join(root, "bin", "verdaccio"),
      join(root, "build", "lib", "cli", "cli.js"),
      join(root, "build", "lib", "cli.js"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  } catch {
    /* not installed */
  }
  return null;
}

export async function pingNpmRegistry(url: string, timeoutMs = 2_000): Promise<boolean> {
  const base = url.endsWith("/") ? url.slice(0, -1) : url;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/-/ping`, { signal: controller.signal });
    if (res.ok) return true;
  } catch {
    /* try root */
  } finally {
    clearTimeout(t);
  }
  try {
    const controller2 = new AbortController();
    const t2 = setTimeout(() => controller2.abort(), timeoutMs);
    try {
      const res = await fetch(base, { signal: controller2.signal });
      return res.ok || res.status === 404;
    } finally {
      clearTimeout(t2);
    }
  } catch {
    return false;
  }
}

export function getNpmRegistryStatus(dataDir: string): {
  enabled: boolean;
  meta: NpmRegistryMeta | null;
  up: boolean;
  packages: ReturnType<typeof listNpmRegistryPackages>;
} {
  if (isNpmRegistryDisabled()) {
    return { enabled: false, meta: null, up: false, packages: [] };
  }
  const meta = readNpmRegistryMeta(dataDir) ?? ensureNpmRegistryLayout(dataDir);
  return {
    enabled: true,
    meta,
    up: meta.status === "up",
    packages: listNpmRegistryPackages(dataDir),
  };
}

export async function refreshNpmRegistryStatus(
  dataDir: string,
): Promise<NpmRegistryMeta> {
  const meta = ensureNpmRegistryLayout(dataDir);
  const up = await pingNpmRegistry(meta.url);
  const next: NpmRegistryMeta = {
    ...meta,
    status: up ? "up" : child || starting ? "starting" : "stopped",
    pid: up ? meta.pid ?? child?.pid : undefined,
    updatedAt: new Date().toISOString(),
    lastError: up ? undefined : meta.lastError,
  };
  if (!up && next.pid && !child) {
    // stale pid
    delete next.pid;
    next.status = "stopped";
  }
  writeNpmRegistryMeta(dataDir, next);
  return next;
}

export async function startNpmRegistry(
  dataDir: string,
): Promise<NpmRegistryMeta> {
  if (isNpmRegistryDisabled()) {
    throw new Error("npm registry disabled (SLOPCONTROL_NPM_REGISTRY=0)");
  }
  let meta = ensureNpmRegistryLayout(dataDir);
  if (await pingNpmRegistry(meta.url)) {
    meta = {
      ...meta,
      status: "up",
      updatedAt: new Date().toISOString(),
      lastError: undefined,
    };
    writeNpmRegistryMeta(dataDir, meta);
    return meta;
  }
  if (starting || child) {
    meta = { ...meta, status: "starting", updatedAt: new Date().toISOString() };
    writeNpmRegistryMeta(dataDir, meta);
    return meta;
  }

  const bin = resolveVerdaccioBin();
  if (!bin) {
    const err =
      "verdaccio package not found — install dependency on @slopcontrol/server";
    meta = {
      ...meta,
      status: "error",
      lastError: err,
      updatedAt: new Date().toISOString(),
    };
    writeNpmRegistryMeta(dataDir, meta);
    throw new Error(err);
  }

  const configPath = npmRegistryConfigPath(dataDir);
  starting = true;
  meta = {
    ...meta,
    status: "starting",
    updatedAt: new Date().toISOString(),
    lastError: undefined,
  };
  writeNpmRegistryMeta(dataDir, meta);

  const isJs = bin.endsWith(".js");
  child = spawn(
    isJs ? process.execPath : bin,
    isJs ? [bin, "--config", configPath] : ["--config", configPath],
    {
      cwd: dirname(configPath),
      env: { ...process.env, VERDACCIO_HANDLE_KILL_SIGNALS: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    },
  );

  const pid = child.pid;
  let stderr = "";
  child.stderr?.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf-8").slice(0, 2_000);
  });
  child.on("exit", (code) => {
    child = null;
    starting = false;
    const cur = readNpmRegistryMeta(dataDir);
    if (cur) {
      writeNpmRegistryMeta(dataDir, {
        ...cur,
        status: "stopped",
        pid: undefined,
        lastError:
          code && code !== 0
            ? `verdaccio exited ${code}: ${stderr.slice(0, 400)}`
            : cur.lastError,
        updatedAt: new Date().toISOString(),
      });
    }
  });

  // Wait until ping succeeds or timeout
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await pingNpmRegistry(meta.url, 800)) {
      starting = false;
      meta = {
        ...meta,
        status: "up",
        pid,
        updatedAt: new Date().toISOString(),
        lastError: undefined,
      };
      writeNpmRegistryMeta(dataDir, meta);
      return meta;
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  starting = false;
  const err = `verdaccio did not become ready: ${stderr.slice(0, 400) || "timeout"}`;
  try {
    child?.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  child = null;
  meta = {
    ...meta,
    status: "error",
    pid: undefined,
    lastError: err,
    updatedAt: new Date().toISOString(),
  };
  writeNpmRegistryMeta(dataDir, meta);
  throw new Error(err);
}

export async function stopNpmRegistry(
  dataDir: string,
): Promise<NpmRegistryMeta> {
  const meta = ensureNpmRegistryLayout(dataDir);
  if (child?.pid) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    child = null;
  } else if (meta.pid) {
    try {
      process.kill(meta.pid, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  starting = false;
  const next: NpmRegistryMeta = {
    ...meta,
    status: "stopped",
    pid: undefined,
    updatedAt: new Date().toISOString(),
  };
  writeNpmRegistryMeta(dataDir, next);
  return next;
}

export async function autoStartNpmRegistry(dataDir: string): Promise<void> {
  if (isNpmRegistryDisabled()) return;
  try {
    await startNpmRegistry(dataDir);
  } catch (err) {
    // best-effort — server still runs
    const meta = readNpmRegistryMeta(dataDir);
    if (meta) {
      writeNpmRegistryMeta(dataDir, {
        ...meta,
        status: "error",
        lastError: err instanceof Error ? err.message : String(err),
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

/** Publish a package directory to the local registry via npm CLI. */
export async function publishToNpmRegistry(opts: {
  dataDir: string;
  packageDir: string;
  tag?: string;
}): Promise<{ ok: true; stdout: string; meta: NpmRegistryMeta }> {
  const meta = await startNpmRegistry(opts.dataDir);
  const registry = meta.url.endsWith("/") ? meta.url.slice(0, -1) : meta.url;
  const args = [
    "publish",
    "--registry",
    registry,
    "--access",
    "public",
    ...(opts.tag ? ["--tag", opts.tag] : []),
  ];
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve) => {
      const proc = spawn("npm", args, {
        cwd: opts.packageDir,
        env: {
          ...process.env,
          npm_config_registry: registry,
          // Local scopes allow $all publish; token still set for tooling parity
          npm_config_always_auth: "true",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (b: Buffer) => {
        stdout += b.toString("utf-8");
      });
      proc.stderr?.on("data", (b: Buffer) => {
        stderr += b.toString("utf-8");
      });
      proc.on("exit", (code) => {
        resolve({ code: code ?? 1, stdout, stderr });
      });
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `npm publish failed (${result.code}): ${result.stderr || result.stdout}`.slice(
        0,
        1_500,
      ),
    );
  }
  return { ok: true, stdout: result.stdout, meta };
}

export type LibraryPublishStep = {
  step: "build" | "bump" | "publish" | "release-commit";
  command: string[];
  code: number;
  durationMs: number;
  note?: string;
};

export type LibraryPublishReport = {
  ok: boolean;
  name: string;
  version: string;
  toolchainKind: string;
  steps: LibraryPublishStep[];
  propagation?: PropagationResult[];
  meta: NpmRegistryMeta;
};

const REPUBLISH_CONFLICT_RE =
  /409|EPUBLISHCONFLICT|cannot publish over|previously published|already exists/i;

function readPackageJsonVersion(packageDir: string): {
  name: string;
  version: string;
} {
  const pkg = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf-8"),
  ) as { name?: string; version?: string };
  if (!pkg.name) throw new Error(`package.json missing name in ${packageDir}`);
  return { name: pkg.name, version: pkg.version ?? "0.0.0" };
}

/**
 * Toolchain-driven library publish: the project's OWN build system does the
 * work (build → version bump → publish), SlopControl only orchestrates and
 * records evidence. On 409 (version already in registry) bump once more and
 * retry — registries reject republishing an existing version.
 */
export async function publishLibraryToRegistry(opts: {
  dataDir: string;
  packageDir: string;
  bump?: "patch" | "minor" | "major";
  toolchain?: BuildToolchainSpec;
  /** Registered projects — used to find consumers for propagation. */
  projects?: Array<{ id?: string; name: string; rootPath: string }>;
  propagate?: boolean;
  resolveToolchain?: (root: string) => BuildToolchainSpec | null;
  /** Test seams. */
  runner?: typeof runToolchainCommand;
  ensureRegistry?: () => Promise<NpmRegistryMeta>;
  commandTimeoutMs?: number;
}): Promise<LibraryPublishReport> {
  const runner = opts.runner ?? runToolchainCommand;
  const meta = await (opts.ensureRegistry ?? (() => startNpmRegistry(opts.dataDir)))();
  const registryUrl = meta.url;
  const steps: LibraryPublishStep[] = [];

  const spec =
    opts.toolchain ??
    resolveProjectToolchain({
      projectRoot: opts.packageDir,
      configured: readProjectConfig(opts.packageDir).toolchain,
    }).spec;
  if (!spec) {
    throw new Error(
      `no build toolchain resolved for ${opts.packageDir} — run project_build_process_configure first`,
    );
  }
  const timeoutMs = opts.commandTimeoutMs ?? 10 * 60_000;
  // Toolchain steps run with the canonical registry env so committed .npmrc
  // env-var references (auth host + token) resolve during publish/consume.
  const registryEnv = npmRegistryEnvValues(meta);
  const run = (step: LibraryPublishStep["step"], command: string[]) =>
    runner({
      cmd: command,
      cwd: opts.packageDir,
      env: registryEnv,
      timeoutMs,
      redactSecrets: [meta.authToken],
    }).then((r) => {
      steps.push({
        step,
        command,
        code: r.code,
        durationMs: r.durationMs,
      });
      return r;
    });

  // 1. Build when dist is missing or older than src (build system's job).
  const buildCmd = toolchainBuildCmd(spec);
  if (buildCmd) {
    const srcMax = dirMaxMtimeMs(join(opts.packageDir, "src"));
    const distMax = dirMaxMtimeMs(join(opts.packageDir, "dist"));
    const needsBuild = distMax === null || (srcMax !== null && srcMax > distMax);
    if (needsBuild) {
      const r = await run("build", buildCmd);
      if (r.code !== 0) {
        throw new Error(
          `library build failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 1_000)}`,
        );
      }
    } else {
      steps.push({
        step: "build",
        command: buildCmd,
        code: 0,
        durationMs: 0,
        note: "dist up to date — skipped",
      });
    }
  }

  // 2. Bump via the build system's version command (never hand-edit).
  const bumpCmd = toolchainBumpVersionCmd(spec, opts.bump ?? "patch");
  if (!bumpCmd) {
    throw new Error(
      `toolchain ${spec.kind} has no bumpVersionCmd — configure one before publishing (immutable registry versions)`,
    );
  }
  {
    const r = await run("bump", bumpCmd);
    if (r.code !== 0) {
      throw new Error(
        `version bump failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 1_000)}`,
      );
    }
  }
  let { name, version } = readPackageJsonVersion(opts.packageDir);

  // 3. Publish; on 409 conflict bump again and retry once.
  const publishCmd = toolchainPublishCmd(spec, registryUrl);
  if (!publishCmd) {
    throw new Error(`toolchain ${spec.kind} has no publishCmd configured`);
  }
  let publish = await run("publish", publishCmd);
  if (publish.code !== 0 && REPUBLISH_CONFLICT_RE.test(publish.stderr + publish.stdout)) {
    const retryBump = await run("bump", bumpCmd);
    if (retryBump.code !== 0) {
      throw new Error(
        `version re-bump failed (${retryBump.code}): ${(retryBump.stderr || retryBump.stdout).slice(0, 1_000)}`,
      );
    }
    version = readPackageJsonVersion(opts.packageDir).version;
    publish = await run("publish", publishCmd);
  }
  if (publish.code !== 0) {
    throw new Error(
      `library publish failed (${publish.code}): ${(publish.stderr || publish.stdout).slice(0, 1_500)}`,
    );
  }

  // 3b. Commit the version bump (package.json + lockfiles) so git stays in
  // step with the registry; an uncommitted bump leaves the tree dirty, which
  // breaks the next bump and drifts git away from the published version.
  // Advisory: commit failure degrades to a step note, publish still counts.
  {
    const bumpFiles = ["package.json", ...spec.lockfiles];
    const commit = await run("release-commit", [
      "git",
      "commit",
      "-m",
      `chore(release): ${name}@${version}`,
      "--",
      ...bumpFiles,
    ]);
    if (commit.code !== 0) {
      const commitStep = steps[steps.length - 1];
      if (commitStep) {
        commitStep.note = /nothing to commit/i.test(
          `${commit.stdout}\n${commit.stderr}`,
        )
          ? "no version changes to commit"
          : `WARNING: version bump left uncommitted (${(commit.stderr || commit.stdout).trim().slice(0, 200)})`;
      }
    }
  }

  // 4. Evidence in REGISTRY.json.
  meta.publishedPackages = {
    ...(meta.publishedPackages ?? {}),
    [name]: {
      version,
      publishedAt: new Date().toISOString(),
      toolchainKind: spec.kind,
    },
  };
  meta.updatedAt = new Date().toISOString();
  writeNpmRegistryMeta(opts.dataDir, meta);

  // 5. Propagate to registered consumers via their own toolchains.
  let propagation: PropagationResult[] | undefined;
  if (opts.propagate !== false && opts.projects?.length) {
    const consumers = findRegisteredConsumers({
      projects: opts.projects,
      packageName: name,
      excludeRootPath: opts.packageDir,
    });
    propagation = await propagateLibraryVersion({
      consumers,
      packageName: name,
      version,
      resolveToolchain:
        opts.resolveToolchain ??
        ((root: string) =>
          resolveProjectToolchain({
            projectRoot: root,
            configured: readProjectConfig(root).toolchain,
          }).spec),
      runner,
      timeoutMs: 5 * 60_000,
    });
  }

  return {
    ok: true,
    name,
    version,
    toolchainKind: spec.kind,
    steps,
    propagation,
    meta,
  };
}

/**
 * Consume half of the registry cycle, callable on its own: bring ONE
 * consumer project to a published library version via the consumer's own
 * toolchain (pnpm add …) and commit the bump so it survives later phase
 * merges. Exists for projects imported before publish-time propagation (or
 * whose propagation failed) — no republish required.
 */
export async function consumeLibraryFromRegistry(opts: {
  dataDir: string;
  projectRoot: string;
  packageName: string;
  /** Defaults to the registry's dist-tags latest. */
  version?: string;
  commitBump?: boolean;
  runner?: typeof runToolchainCommand;
}): Promise<{
  ok: boolean;
  packageName: string;
  version: string;
  propagation: PropagationResult[];
}> {
  const version =
    opts.version ??
    listNpmRegistryPackages(opts.dataDir).find(
      (p) => p.name === opts.packageName,
    )?.latest;
  if (!version) {
    throw new Error(
      `no published version of ${opts.packageName} in the local registry`,
    );
  }
  const consumer = findRegisteredConsumers({
    projects: [{ name: basename(opts.projectRoot), rootPath: opts.projectRoot }],
    packageName: opts.packageName,
  })[0];
  if (!consumer) {
    throw new Error(
      `${opts.projectRoot} does not depend on ${opts.packageName}`,
    );
  }
  const propagation = await propagateLibraryVersion({
    consumers: [consumer],
    packageName: opts.packageName,
    version,
    resolveToolchain:
      ((root: string) =>
        resolveProjectToolchain({
          projectRoot: root,
          configured: readProjectConfig(root).toolchain,
        }).spec),
    runner: opts.runner,
    commitBump: opts.commitBump,
  });
  return {
    ok: propagation.every((r) => r.ok),
    packageName: opts.packageName,
    version,
    propagation,
  };
}
