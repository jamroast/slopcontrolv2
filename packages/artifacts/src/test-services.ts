import { existsSync } from "node:fs";
import { join } from "node:path";
import { runToolchainCommand } from "./build-toolchain.js";

/**
 * Test-service bring-up: projects whose tests need backing services
 * (Postgres, Redis, …) declare them in a compose file. Before verify runs
 * the test command we ensure the infra services are up so a stopped
 * container does not block a run with ECONNREFUSED.
 */

const COMPOSE_FILE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yml",
  "docker-compose.yaml",
] as const;

/** Service names treated as backing infra (safe to auto-start before tests). */
const INFRA_SERVICE_RE =
  /^(db|database|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|minio|localstack)$/;

export interface TestServicesResult {
  /** Whether any bring-up was attempted. */
  attempted: boolean;
  ok: boolean;
  composeFile?: string;
  services: string[];
  detail: string;
}

export function findComposeFile(projectRoot: string): string | null {
  for (const name of COMPOSE_FILE_CANDIDATES) {
    if (existsSync(join(projectRoot, name))) return name;
  }
  return null;
}

export function isInfraServiceName(name: string): boolean {
  return INFRA_SERVICE_RE.test(name.trim());
}

/**
 * Ensure test backing services are running. No-op when the project has no
 * compose file, no matching services, or the kill-switch is set.
 */
export async function ensureTestServices(opts: {
  projectRoot: string;
  /** Explicit service names from project config — wins over auto-detect. */
  configured?: string[];
  runner?: typeof runToolchainCommand;
  timeoutMs?: number;
}): Promise<TestServicesResult> {
  const none = (detail: string): TestServicesResult => ({
    attempted: false,
    ok: true,
    services: [],
    detail,
  });

  if (process.env.SLOPCONTROL_DISABLE_TEST_SERVICES === "1") {
    return none("test services disabled via SLOPCONTROL_DISABLE_TEST_SERVICES");
  }
  const composeFile = findComposeFile(opts.projectRoot);
  if (!composeFile) return none("no compose file");

  const runner = opts.runner ?? runToolchainCommand;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  let services = (opts.configured ?? []).map((s) => s.trim()).filter(Boolean);
  if (services.length === 0 && !opts.configured) {
    const list = await runner({
      cmd: ["docker", "compose", "config", "--services"],
      cwd: opts.projectRoot,
      timeoutMs: 30_000,
    });
    if (list.code !== 0) {
      return none(
        `could not list compose services (${(list.stderr || list.stdout).trim().slice(0, 200)})`,
      );
    }
    services = list.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && isInfraServiceName(s));
  }
  if (services.length === 0) {
    return none("no infra services in compose file");
  }

  const up = await runner({
    cmd: ["docker", "compose", "up", "-d", "--wait", ...services],
    cwd: opts.projectRoot,
    timeoutMs,
  });
  const detail = (up.stdout + "\n" + up.stderr).trim().slice(-1500);
  return {
    attempted: true,
    ok: up.code === 0,
    composeFile,
    services,
    detail:
      up.code === 0
        ? `test services up (${services.join(", ")}): ${detail}`
        : `test service bring-up FAILED (${services.join(", ")}): ${detail}`,
  };
}
