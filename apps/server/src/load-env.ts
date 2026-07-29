import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { log } from "@slopcontrol/types";

/**
 * pnpm --filter runs with cwd = apps/server, so default dotenv/config
 * misses the monorepo root .env. Load known locations explicitly.
 *
 * Import this module first (side-effect) before anything that reads process.env.
 */
function loadSlopcontrolEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"), // apps/server → monorepo root
    resolve(here, "../../../.env"), // src/ or dist/ → monorepo root
    resolve(process.env.HOME ?? "", ".slopcontrol/.env"),
  ];

  const seen = new Set<string>();
  for (const path of candidates) {
    if (!path || seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    const result = loadEnv({ path, override: false });
    if (result.parsed && Object.keys(result.parsed).length > 0) {
      log.info("env", `loaded ${path}`);
    }
  }
}

loadSlopcontrolEnv();
