import { loadConfig } from "./config.js";
import { resolveCodingEngine } from "./engines.js";
import { loadSlopcontrolEnv } from "./load-env.js";
import {
  ensureService,
  persistStack,
  stopManagedServices,
  waitForSignal,
  type RunningService,
} from "./process-manager.js";
import type { ManagedService } from "./process-manager.js";

export async function cmdUp(cwd: string = process.cwd()): Promise<void> {
  const { path, config, rootDir } = loadConfig(cwd);
  console.log(`Using config ${path}`);

  const { loaded } = loadSlopcontrolEnv({ rootDir });
  for (const envPath of loaded) {
    console.log(`Loaded env ${envPath}`);
  }
  if (loaded.length === 0) {
    console.log(
      "No .env files loaded (checked rootDir/.env, cwd/.env, ~/.slopcontrol/.env)",
    );
  }

  const codingMode = config.coding.mode ?? "per_project";
  process.env.SLOPCONTROL_CODING_MODE = codingMode;

  const services: RunningService[] = [];
  let codingHealthNote = "";

  try {
    if (codingMode === "shared") {
      const coding = resolveCodingEngine(config);
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
      services.push(await ensureService(codingSpec));
      codingHealthNote = `  coding  ${coding.healthUrl} (${coding.engineId}, shared)`;
    } else {
      console.log(
        "coding.mode=per_project — OpenCode daemons start lazily per project (ports 4100+)",
      );
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
    services.push(await ensureService(serverSpec));

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
      services.push(await ensureService(webSpec));
    }

    persistStack({ configPath: path, rootDir }, services);
    console.log("");
    console.log("Stack is up. Press Ctrl+C to stop managed processes.");
    console.log(`  server  ${config.server.health.http}`);
    console.log(codingHealthNote);
    if (web?.enabled) {
      console.log(`  web     ${web.health.http}`);
    }
    console.log("");

    const sig = await waitForSignal();
    console.log(`\nReceived ${sig}; shutting down…`);
  } finally {
    await stopManagedServices(services);
  }
}
