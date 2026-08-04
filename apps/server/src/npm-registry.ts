/**
 * Verdaccio process lifecycle for SlopControl's private npm registry.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ensureNpmRegistryLayout,
  isNpmRegistryDisabled,
  listNpmRegistryPackages,
  npmRegistryConfigPath,
  readNpmRegistryMeta,
  writeNpmRegistryMeta,
  type NpmRegistryMeta,
} from "@slopcontrol/artifacts";

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
