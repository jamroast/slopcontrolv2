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
 * Resolve each target service's pinned `container_name` (when set) via
 * `docker compose config --format json`. A fixed name that differs from the
 * service name is invisible to service-name-based docker ps matching, so
 * reuse detection must look it up explicitly. Best-effort: any failure
 * (older compose without --format json, parse error) degrades to an empty
 * map, preserving the previous behaviour.
 */
async function pinnedContainerNames(
  projectRoot: string,
  services: string[],
  runner: typeof runToolchainCommand,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const cfg = await runner({
    cmd: ["docker", "compose", "config", "--format", "json"],
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (cfg.code !== 0) return out;
  try {
    const parsed = JSON.parse(cfg.stdout) as {
      services?: Record<string, { container_name?: unknown }>;
    };
    for (const svc of services) {
      const name = parsed.services?.[svc]?.container_name;
      if (typeof name === "string" && name.trim()) out.set(svc, name.trim());
    }
  } catch {
    // not JSON — degrade to service-name matching only
  }
  return out;
}

/**
 * True when ALL target services are already running. Checks the compose
 * project first, then falls back to docker ps to catch containers owned by
 * another compose project (main tree / worktree, or a checkout renamed
 * after the stack started — the compose project label no longer matches
 * the directory) or started outside compose under a fixed `container_name`.
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
  // Fallback: match running containers by pinned container_name (resolved
  // from compose config — a fixed name may be unrelated to the service
  // name), by exact/generated service name, or by the compose-service label
  // (survives a project-directory rename that orphans the project label).
  const pinned = await pinnedContainerNames(projectRoot, services, runner);
  const dockerPs = await runner({
    cmd: [
      "docker",
      "ps",
      "--format",
      '{{.Names}}\t{{.Label "com.docker.compose.service"}}',
    ],
    cwd: projectRoot,
    timeoutMs: 30_000,
  });
  if (dockerPs.code !== 0) return false;
  const names = new Set<string>();
  const labelledServices = new Set<string>();
  for (const line of dockerPs.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, label] = trimmed.split("\t");
    if (name?.trim()) names.add(name.trim());
    if (label?.trim()) labelledServices.add(label.trim());
  }
  return services.every((s) => {
    const fixed = pinned.get(s);
    return (
      (fixed !== undefined && names.has(fixed)) ||
      names.has(s) ||
      labelledServices.has(s) ||
      [...names].some((n) => n.endsWith(`-${s}-1`) || n.endsWith(`_${s}_1`))
    );
  });
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
