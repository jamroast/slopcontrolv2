import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { config as loadEnv } from "dotenv";

/**
 * Env files for the SlopControl *stack* (server + coding engine).
 * Shell / process.env already set wins (override: false).
 *
 * Preferred portable location: ~/.slopcontrol/.env
 * Also loads rootDir/.env and cwd/.env when present (local monorepo).
 */
export function slopcontrolEnvCandidates(rootDir?: string): string[] {
  const home =
    process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
  const list = [
    rootDir ? resolve(rootDir, ".env") : undefined,
    resolve(process.cwd(), ".env"),
    join(home, ".slopcontrol", ".env"),
  ];
  return [...new Set(list.filter((p): p is string => Boolean(p)))];
}

export function loadSlopcontrolEnv(opts?: {
  rootDir?: string;
  /** Mutate this env map (default: process.env) */
  env?: NodeJS.ProcessEnv;
}): { loaded: string[] } {
  const target = opts?.env ?? process.env;
  const loaded: string[] = [];
  const seen = new Set<string>();

  for (const path of slopcontrolEnvCandidates(opts?.rootDir)) {
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    const result = loadEnv({ path, processEnv: target, override: false });
    if (result.parsed && Object.keys(result.parsed).length > 0) {
      loaded.push(path);
    }
  }
  return { loaded };
}
