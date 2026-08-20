import {
  buildOpenCodeEnv,
  isOpenCodeReachable,
  listCodingTools,
  resolveOpenCodeBinary,
} from "@slopcontrol/coding-tools";
import type { SlopcontrolYaml } from "./config-schema.js";
import type { HealthMode } from "./health.js";

export interface EngineStartPlan {
  /** Service key in PID file / logs */
  serviceId: string;
  /** Log prefix */
  label: string;
  engineId: string;
  command: string[];
  env: NodeJS.ProcessEnv;
  healthUrl: string;
  healthMode: HealthMode;
  /** Optional pre-check that skips spawn when true */
  isHealthy?: () => Promise<boolean>;
}

export function buildOpenCodeCommand(opts: {
  port: number;
  hostname: string;
  commandOverride?: string[];
}): string[] {
  if (opts.commandOverride?.length) return [...opts.commandOverride];
  // Prefer the opencode-ai binary vendored via @slopcontrol/coding-tools so
  // we never depend on whatever `opencode` happens to be on PATH.
  const binary = resolveOpenCodeBinary() ?? "opencode";
  return [
    binary,
    "serve",
    "--port",
    String(opts.port),
    "--hostname",
    opts.hostname,
  ];
}

export function buildOpenCodeHealthUrl(hostname: string, port: number): string {
  return `http://${hostname}:${port}/global/health`;
}

/**
 * Resolve the CLI start plan for the configured coding engine, or `null`
 * when the engine runs in-process inside the server (e.g. pi) and there is
 * no daemon for the CLI to spawn or health-check.
 */
export function resolveCodingEngine(
  config: SlopcontrolYaml,
  baseEnv: NodeJS.ProcessEnv = process.env,
): EngineStartPlan | null {
  const engineId = config.coding.engine.trim() || "pi";
  const known = listCodingTools().map((t) => t.id);
  if (!known.includes(engineId)) {
    throw new Error(
      `Unknown coding engine "${engineId}". Registered: ${known.join(", ") || "(none)"}`,
    );
  }

  if (engineId === "pi") {
    // Pi runs in-process via its SDK — no daemon, no port, no health URL.
    return null;
  }

  if (engineId === "opencode") {
    const oc = config.coding.opencode ?? {
      port: 4096,
      hostname: "127.0.0.1",
      enableExa: true,
    };
    const port = oc.port ?? 4096;
    const hostname = oc.hostname ?? "127.0.0.1";
    const healthUrl =
      oc.health?.http ?? buildOpenCodeHealthUrl(hostname, port);
    const env = buildOpenCodeEnv({ ...baseEnv });
    if (oc.enableExa !== false) {
      const exaKey =
        env.EXA_API_KEY?.trim() || env.SLOPCONTROL_EXA_API_KEY?.trim() || "";
      if (exaKey) {
        env.OPENCODE_ENABLE_EXA = env.OPENCODE_ENABLE_EXA?.trim() || "1";
      } else if (oc.enableExa) {
        // Mirror pnpm dev:opencode default when enableExa is true
        env.OPENCODE_ENABLE_EXA = env.OPENCODE_ENABLE_EXA?.trim() || "1";
      }
    }
    const baseUrl = `http://${hostname}:${port}`;
    return {
      serviceId: "coding",
      label: "opencode",
      engineId,
      command: buildOpenCodeCommand({
        port,
        hostname,
        commandOverride: oc.command,
      }),
      env,
      healthUrl,
      healthMode: "opencode",
      isHealthy: () => isOpenCodeReachable(baseUrl),
    };
  }

  throw new Error(
    `Coding engine "${engineId}" is registered but has no CLI starter yet. ` +
      `Add a starter in apps/cli/src/engines/.`,
  );
}
