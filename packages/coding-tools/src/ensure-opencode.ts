import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { log } from "@slopcontrol/types";

const managed = new Map<number, ChildProcess>();

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
 * Ensure a headless OpenCode server is reachable.
 * If not, spawn `opencode serve --port <n>` and wait until healthy.
 */
export async function ensureOpenCodeRunning(baseUrl: string): Promise<void> {
  if (await isOpenCodeReachable(baseUrl)) {
    log.debug("opencode", "already healthy", { baseUrl });
    return;
  }

  const port = parsePort(baseUrl);
  log.warn("opencode", "not reachable; starting headless server", { baseUrl, port });
  if (managed.has(port) && !managed.get(port)?.killed) {
    log.info("opencode", "spawn already in progress; waiting", { port });
  } else {
    const child = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        stdio: "ignore",
        detached: true,
        env: buildOpenCodeEnv(),
      },
    );
    child.unref();
    managed.set(port, child);
    log.info("opencode", "started headless server", {
      baseUrl,
      pid: child.pid,
    });
  }

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await isOpenCodeReachable(baseUrl)) {
      log.info("opencode", "healthy", { baseUrl });
      return;
    }
    await delay(400);
  }

  log.error("opencode", "failed to become healthy", { baseUrl, port });
  throw new Error(
    `OpenCode is not reachable at ${baseUrl}. ` +
      `Start it with: opencode serve --port ${port}`,
  );
}
