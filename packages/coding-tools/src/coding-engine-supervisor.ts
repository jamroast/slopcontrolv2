import { createHash } from "node:crypto";
import type { CodingTool } from "./index.js";
import { OpenCodeAdapter } from "./opencode-adapter.js";
import { getCodingTool } from "./registry.js";

export type CodingEngineMode = "shared" | "per_project";

const DEFAULT_SHARED_PORT = Number(process.env.OPENCODE_PORT ?? 4096);
const PER_PROJECT_PORT_BASE = Number(
  process.env.SLOPCONTROL_OPENCODE_PORT_BASE ?? 4100,
);
const PER_PROJECT_PORT_SPAN = Number(
  process.env.SLOPCONTROL_OPENCODE_PORT_SPAN ?? 100,
);

/** Adapters keyed by baseUrl */
const adaptersByBaseUrl = new Map<string, OpenCodeAdapter>();

export function resolveCodingEngineMode(
  env: NodeJS.ProcessEnv = process.env,
): CodingEngineMode {
  const raw = (env.SLOPCONTROL_CODING_MODE ?? "per_project").trim().toLowerCase();
  return raw === "shared" ? "shared" : "per_project";
}

/**
 * Stable port in [base, base+span) from project id (or root path).
 */
export function portForProject(
  projectKey: string,
  opts?: { base?: number; span?: number },
): number {
  const base = opts?.base ?? PER_PROJECT_PORT_BASE;
  const span = opts?.span ?? PER_PROJECT_PORT_SPAN;
  const hash = createHash("sha256").update(projectKey).digest();
  const n = hash.readUInt32BE(0);
  return base + (n % Math.max(1, span));
}

export function baseUrlForProject(
  projectKey: string,
  hostname = "127.0.0.1",
): string {
  const port = portForProject(projectKey);
  return `http://${hostname}:${port}`;
}

export function sharedOpenCodeBaseUrl(
  hostname = "127.0.0.1",
  port = DEFAULT_SHARED_PORT,
): string {
  return `http://${hostname}:${port}`;
}

function getOrCreateAdapter(baseUrl: string): OpenCodeAdapter {
  const existing = adaptersByBaseUrl.get(baseUrl);
  if (existing) return existing;
  const adapter = new OpenCodeAdapter(baseUrl);
  adaptersByBaseUrl.set(baseUrl, adapter);
  return adapter;
}

export interface CodingToolForProjectInput {
  toolId?: string;
  projectId: string;
  projectRoot?: string;
  mode?: CodingEngineMode;
}

/**
 * Resolve a CodingTool for a project. In `per_project` mode, trunks to a
 * dedicated OpenCode baseUrl (lazy-spawned via ensureOpenCodeRunning).
 * In `shared` mode, uses the registry singleton / shared :4096 daemon.
 */
export function getCodingToolForProject(
  input: CodingToolForProjectInput,
): CodingTool {
  const toolId = input.toolId?.trim() || "opencode";
  const mode = input.mode ?? resolveCodingEngineMode();

  if (toolId !== "opencode") {
    return getCodingTool(toolId);
  }

  if (mode === "shared") {
    return getOrCreateAdapter(sharedOpenCodeBaseUrl());
  }

  const key = input.projectId || input.projectRoot || "default";
  const baseUrl = baseUrlForProject(key);
  return getOrCreateAdapter(baseUrl);
}

/** Test helper — clear adapter cache. */
export function clearCodingEngineAdapterCache(): void {
  adaptersByBaseUrl.clear();
}
