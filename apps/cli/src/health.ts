import { setTimeout as delay } from "node:timers/promises";

export type HealthMode = "http-ok" | "opencode";

export async function checkHttpHealth(
  url: string,
  mode: HealthMode = "http-ok",
): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    if (mode === "opencode") {
      const body = (await res.json()) as { healthy?: boolean };
      return body.healthy === true;
    }
    // Prefer JSON ok when present; otherwise status 2xx is enough
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = (await res.json()) as { ok?: boolean };
      if (typeof body.ok === "boolean") return body.ok;
    }
    return true;
  } catch {
    return false;
  }
}

export async function waitForHealth(
  url: string,
  opts: {
    mode?: HealthMode;
    timeoutMs?: number;
    intervalMs?: number;
    label?: string;
  } = {},
): Promise<void> {
  const mode = opts.mode ?? "http-ok";
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 400;
  const label = opts.label ?? url;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHttpHealth(url, mode)) return;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label} (${url})`);
}
