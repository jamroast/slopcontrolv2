import { createOpencodeServer } from "@opencode-ai/sdk";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { log } from "@slopcontrol/types";

interface ManagedServer {
  url: string;
  close(): void;
}

const managed = new Map<number, ManagedServer>();
const starting = new Map<number, Promise<void>>();

function healthUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/global/health`;
}

export async function isOpenCodeReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(healthUrl(baseUrl), {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { healthy?: boolean };
    return body.healthy === true;
  } catch {
    return false;
  }
}

function parsePort(baseUrl: string): number {
  try {
    const url = new URL(baseUrl);
    return Number(url.port || 4096);
  } catch {
    return Number(process.env.OPENCODE_PORT ?? 4096);
  }
}

/** Env for spawned OpenCode — enables Exa websearch when a key is present. */
export function buildOpenCodeEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const exaKey =
    base.EXA_API_KEY?.trim() || base.SLOPCONTROL_EXA_API_KEY?.trim() || "";
  const env: NodeJS.ProcessEnv = { ...base };
  if (base.OLLAMA_API_KEY) {
    env.OLLAMA_API_KEY = base.OLLAMA_API_KEY;
  }
  if (exaKey) {
    env.EXA_API_KEY = exaKey;
    env.OPENCODE_ENABLE_EXA = base.OPENCODE_ENABLE_EXA?.trim() || "1";
  } else if (base.OPENCODE_ENABLE_EXA) {
    env.OPENCODE_ENABLE_EXA = base.OPENCODE_ENABLE_EXA;
  }
  return env;
}

/**
 * Absolute path to the vendored `opencode` binary (opencode-ai dependency of
 * this package), or null when only a PATH install is available.
 */
export function resolveOpenCodeBinary(): string | null {
  // Workspace layout: this file is <pkg>/dist/ensure-opencode.js and pnpm
  // links declared deps into <pkg>/node_modules/.bin.
  const here = dirname(fileURLToPath(import.meta.url));
  const localShim = join(here, "..", "node_modules", ".bin", "opencode");
  if (existsSync(localShim)) return localShim;
  try {
    // Installed layout: resolve the real package, then its sibling .bin.
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve("opencode-ai/package.json");
    const shim = join(dirname(pkgJson), "..", ".bin", "opencode");
    if (existsSync(shim)) return shim;
  } catch {
    // opencode-ai not installed — fall back to PATH resolution by callers
  }
  return null;
}

/**
 * The SDK spawns `opencode serve` by name with the current process env —
 * apply the derived keys (SLOPCONTROL_EXA_API_KEY -> EXA_API_KEY,
 * OPENCODE_ENABLE_EXA) and prepend the vendored bin dir to PATH so the
 * vendored binary wins over whatever else is installed.
 */
function applyOpenCodeEnvToProcess(): void {
  const env = buildOpenCodeEnv(process.env);
  for (const key of [
    "EXA_API_KEY",
    "OPENCODE_ENABLE_EXA",
    "OLLAMA_API_KEY",
  ] as const) {
    const value = env[key];
    if (value && !process.env[key]) {
      process.env[key] = value;
    }
  }
  const binary = resolveOpenCodeBinary();
  if (binary) {
    const binDir = dirname(binary);
    const entries = (process.env.PATH ?? "").split(":");
    if (!entries.includes(binDir)) {
      process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;
    }
  }
}

async function spawnManagedServer(port: number, baseUrl: string): Promise<void> {
  log.warn("opencode", "not reachable; starting managed server via SDK", {
    baseUrl,
    port,
  });
  applyOpenCodeEnvToProcess();
  const controller = new AbortController();
  try {
    const server = await createOpencodeServer({
      hostname: "127.0.0.1",
      port,
      timeout: 20_000,
      signal: controller.signal,
    });
    managed.set(port, {
      url: server.url,
      close: () => {
        server.close();
        controller.abort();
      },
    });
    log.info("opencode", "managed server listening", {
      baseUrl,
      url: server.url,
    });
  } catch (error) {
    controller.abort();
    throw error;
  }

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await isOpenCodeReachable(baseUrl)) {
      log.info("opencode", "healthy", { baseUrl });
      return;
    }
    await delay(400);
  }
  throw new Error(
    `OpenCode started at ${baseUrl} but did not become healthy within 10s`,
  );
}

/**
 * Ensure a headless OpenCode server is reachable.
 * Attaches to an already-healthy server; otherwise spawns one via the
 * OpenCode SDK (which waits for readiness) and tracks it for shutdown.
 */
export async function ensureOpenCodeRunning(baseUrl: string): Promise<void> {
  if (await isOpenCodeReachable(baseUrl)) {
    log.debug("opencode", "already healthy", { baseUrl });
    return;
  }

  const port = parsePort(baseUrl);
  const inFlight = starting.get(port);
  if (inFlight) {
    log.info("opencode", "spawn already in progress; waiting", { port });
    await inFlight;
    return;
  }

  const spawnPromise = spawnManagedServer(port, baseUrl).finally(() => {
    starting.delete(port);
  });
  starting.set(port, spawnPromise);

  try {
    await spawnPromise;
  } catch (error) {
    log.error("opencode", "failed to become healthy", { baseUrl, port });
    throw new Error(
      `OpenCode is not reachable at ${baseUrl}: ` +
        `${error instanceof Error ? error.message : String(error)}. ` +
        `Start it with: opencode serve --port ${port}`,
    );
  }
}

/** Stop all SDK-managed servers spawned by this process. */
export function shutdownManagedOpenCodeServers(): void {
  for (const [port, server] of managed) {
    log.info("opencode", "stopping managed server", { port });
    server.close();
  }
  managed.clear();
}

/** Test helper — drop bookkeeping without stopping processes. */
export function resetManagedOpenCodeServersForTests(): void {
  managed.clear();
  starting.clear();
}
