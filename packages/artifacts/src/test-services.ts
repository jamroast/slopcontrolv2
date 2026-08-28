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
  /^(?:db|database|postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|minio|localstack)$|(?:^|-)(?:postgres(?:ql)?|mysql|mariadb|mongo(?:db)?|redis|valkey|db|database)$/i;

/** Set on verify env when ensureTestServices brought up (or reused) infra. */
export const SLOPCONTROL_TEST_SERVICES_READY_ENV = "SLOPCONTROL_TEST_SERVICES_READY";
/** Comma-separated infra service names started by test-services. */
export const SLOPCONTROL_TEST_SERVICES_ENV = "SLOPCONTROL_TEST_SERVICES";

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
 * True when ALL target services are already running. Checks the compose
 * project first, then falls back to docker ps by name to catch fixed
 * `container_name` entries started from another project/worktree.
 */
export async function servicesRunning(
  projectRoot: string,
  services: string[],
  runner: typeof runToolchainCommand,
): Promise<boolean> {
  const ps = await runner({
    cmd: ["docker", "compose", "ps", "--status", "running", "--format", "{{.Service}}"],
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (ps.code === 0) {
    const up = new Set(
      ps.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (services.every((s) => up.has(s))) return true;
  }
  // Fixed container_name fallback: `docker ps --filter name=<svc>` catches
  // containers owned by another compose project (e.g. main tree).
  const dockerPs = await runner({
    cmd: [
      "docker",
      "ps",
      "--format",
      "{{.Names}}",
      ...services.flatMap((s) => ["--filter", `name=${s}`]),
    ],
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (dockerPs.code !== 0) return false;
  const names = new Set(
    dockerPs.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return services.every(
    (s) => names.has(s) || [...names].some((n) => n.endsWith(`-${s}-1`) || n.endsWith(`_${s}_1`)),
  );
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

  // Reuse already-running services: a fixed container_name or a shared main-tree
  // stack can already satisfy the dependency — a second `up` then fails with a
  // container-name conflict (and PHASE checks hang on trap teardown → CHECK_TIMEOUT).
  // Check both the compose project view and, for fixed container_names, docker ps.
  const running = await servicesRunning(opts.projectRoot, services, runner);
  if (running) {
    return {
      attempted: true,
      ok: true,
      composeFile,
      services,
      detail: `test services already running (${services.join(", ")}) — reusing, skipped bring-up`,
    };
  }

  const up = await runner({
    cmd: ["docker", "compose", "up", "-d", "--no-recreate", "--wait", ...services],
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
