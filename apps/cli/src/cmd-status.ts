import { loadConfig } from "./config.js";
import { resolveCodingEngine } from "./engines.js";
import { checkHttpHealth } from "./health.js";
import { isProcessAlive, readPidFile } from "./pid-store.js";

function statusWord(healthy: boolean, trackedAlive?: boolean): string {
  if (healthy) return "healthy";
  if (trackedAlive) return "running (not healthy)";
  return "down";
}

export async function cmdStatus(cwd: string = process.cwd()): Promise<void> {
  let configPath: string | undefined;
  let rootDir: string | undefined;
  try {
    const loaded = loadConfig(cwd);
    configPath = loaded.path;
    rootDir = loaded.rootDir;
    const { config } = loaded;
    const codingMode = config.coding.mode ?? "per_project";
    const pid = readPidFile();

    console.log(`config: ${configPath}`);
    if (rootDir) console.log(`root:   ${rootDir}`);
    console.log(`coding.mode: ${codingMode}`);
    if (pid) {
      console.log(`pidfile startedAt: ${pid.startedAt}`);
    } else {
      console.log("pidfile: (none)");
    }
    console.log("");

    if (codingMode === "shared") {
      const coding = resolveCodingEngine(config);
      const codingHealthy = coding.isHealthy
        ? await coding.isHealthy()
        : await checkHttpHealth(coding.healthUrl, coding.healthMode);
      const codingPid = pid?.services.coding;
      console.log(
        `coding (${coding.engineId}): ${statusWord(
          codingHealthy,
          codingPid ? isProcessAlive(codingPid.pid) : undefined,
        )}  ${coding.healthUrl}` +
          (codingPid?.pid ? `  pid=${codingPid.pid}` : ""),
      );
    } else {
      console.log(
        "coding: per_project (lazy OpenCode per project — check develop logs for port)",
      );
    }

    const serverHealthy = await checkHttpHealth(
      config.server.health.http,
      "http-ok",
    );
    const serverPid = pid?.services.server;
    console.log(
      `server: ${statusWord(
        serverHealthy,
        serverPid ? isProcessAlive(serverPid.pid) : undefined,
      )}  ${config.server.health.http}` +
        (serverPid?.pid ? `  pid=${serverPid.pid}` : ""),
    );

    if (config.web?.enabled) {
      const webHealthy = await checkHttpHealth(config.web.health.http, "http-ok");
      const webPid = pid?.services.web;
      console.log(
        `web:    ${statusWord(
          webHealthy,
          webPid ? isProcessAlive(webPid.pid) : undefined,
        )}  ${config.web.health.http}` +
          (webPid?.pid ? `  pid=${webPid.pid}` : ""),
      );
    } else {
      console.log("web:    disabled");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exitCode = 1;
  }
}
