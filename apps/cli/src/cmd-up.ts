import { loadConfig } from "./config.js";
import { resolveCodingEngine } from "./engines.js";
import { loadSlopcontrolEnv } from "./load-env.js";
import { cliLogsDir } from "./log-store.js";
import {
  detachRunningServices,
  ensureService,
  persistStack,
  stopManagedServices,
  waitForSignal,
  type RunningService,
} from "./process-manager.js";
import type { ManagedService } from "./process-manager.js";

export type CmdUpOptions = {
  /** Start services and exit; leave processes running (use `slopcontrol logs -f`). */
  detach?: boolean;
  /** Suppress console tee (still write log files). Useful when starting from `logs --up`. */
  quietConsole?: boolean;
  cwd?: string;
};

function parseUpArgs(argv: string[]): CmdUpOptions {
  const opts: CmdUpOptions = {};
  for (const a of argv) {
    if (a === "-d" || a === "--detach") opts.detach = true;
    else if (a === "-q" || a === "--quiet") opts.quietConsole = true;
  }
  return opts;
}

export async function cmdUp(
  cwdOrOpts: string | CmdUpOptions = process.cwd(),
  argv: string[] = [],
): Promise<void> {
  const fromArgv = parseUpArgs(argv);
  const base: CmdUpOptions =
    typeof cwdOrOpts === "string" ? { cwd: cwdOrOpts } : { ...cwdOrOpts };
  const opts: CmdUpOptions = { ...base, ...fromArgv };
  const cwd = opts.cwd ?? process.cwd();
  const detach = Boolean(opts.detach);
  const quietConsole = Boolean(opts.quietConsole);

  const { path, config, rootDir } = loadConfig(cwd);
  if (!quietConsole) console.log(`Using config ${path}`);

  const { loaded } = loadSlopcontrolEnv({ rootDir });
  if (!quietConsole) {
    for (const envPath of loaded) {
      console.log(`Loaded env ${envPath}`);
    }
    if (loaded.length === 0) {
      console.log(
        "No .env files loaded (checked rootDir/.env, cwd/.env, ~/.slopcontrol/.env)",
      );
    }
  }

  const codingMode = config.coding.mode ?? "per_project";
  process.env.SLOPCONTROL_CODING_MODE = codingMode;

  const services: RunningService[] = [];
  let codingHealthNote = "";

  try {
    if (codingMode === "shared") {
      const coding = resolveCodingEngine(config);
      if (coding) {
        const codingSpec: ManagedService = {
          id: coding.serviceId,
          label: coding.label,
          command: coding.command,
          cwd: rootDir,
          env: coding.env,
          healthUrl: coding.healthUrl,
          healthMode: coding.healthMode,
          isHealthy: coding.isHealthy,
          skipIfHealthy: true,
        };
        services.push(
          await ensureService(codingSpec, { quietConsole, detach }),
        );
        codingHealthNote = `  coding  ${coding.healthUrl} (${coding.engineId}, shared)`;
      } else {
        const engineId = config.coding.engine.trim() || "opencode";
        if (!quietConsole) {
          console.log(
            `coding.engine=${engineId} — runs in-process inside the server (no daemon to start)`,
          );
        }
        codingHealthNote = `  coding  ${engineId} (in-process SDK — no daemon)`;
      }
    } else if (config.coding.engine.trim() === "pi") {
      if (!quietConsole) {
        console.log(
          "coding.engine=pi — in-process SDK; no per-project daemons needed",
        );
      }
      codingHealthNote = "  coding  pi (in-process SDK — no daemon)";
    } else if (!quietConsole) {
      console.log(
        "coding.mode=per_project — OpenCode daemons start lazily per project (ports 4100+)",
      );
      codingHealthNote =
        "  coding  per_project (lazy OpenCode per projectId; SLOPCONTROL_CODING_MODE=per_project)";
    } else {
      codingHealthNote =
        "  coding  per_project (lazy OpenCode per projectId; SLOPCONTROL_CODING_MODE=per_project)";
    }

    const serverEnv = {
      ...process.env,
      SLOPCONTROL_CODING_MODE: codingMode,
    };

    const serverSpec: ManagedService = {
      id: "server",
      label: "server",
      command: config.server.command,
      cwd: rootDir,
      env: serverEnv,
      healthUrl: config.server.health.http,
      healthMode: "http-ok",
      skipIfHealthy: true,
    };
    services.push(await ensureService(serverSpec, { quietConsole, detach }));

    const web = config.web;
    if (web?.enabled) {
      const webSpec: ManagedService = {
        id: "web",
        label: "web",
        command: web.command,
        cwd: rootDir,
        env: { ...process.env },
        healthUrl: web.health.http,
        healthMode: "http-ok",
        skipIfHealthy: true,
      };
      services.push(await ensureService(webSpec, { quietConsole, detach }));
    }

    persistStack({ configPath: path, rootDir }, services);

    if (detach) {
      detachRunningServices(services);
      console.log("");
      console.log("Stack started in background (detached).");
      console.log(`  info  ${config.server.health.http}`);
      console.log(codingHealthNote);
      if (web?.enabled) {
        console.log(`  web     ${web.health.http}`);
      }
      console.log(`  logs   ${cliLogsDir()}`);
      console.log("");
      console.log("Follow logs:  slopcontrol logs -f");
      console.log("Stop stack:   slopcontrol down");
      return;
    }

    console.log("");
    console.log("Stack is up. Press Ctrl+C to stop managed processes.");
    console.log(`  server  ${config.server.health.http}`);
    console.log(codingHealthNote);
    if (web?.enabled) {
      console.log(`  web     ${web.health.http}`);
    }
    console.log(`  logs   ${cliLogsDir()}  (also: slopcontrol logs -f)`);
    console.log("");

    const sig = await waitForSignal();
    console.log(`\nReceived ${sig}; shutting down…`);
  } finally {
    if (!detach) {
      await stopManagedServices(services);
    }
  }
}
