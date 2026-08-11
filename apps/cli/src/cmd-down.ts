import { loadConfig } from "./config.js";
import {
  clearPidFile,
  findSlopControlProcesses,
  groupByPgid,
  isProcessAlive,
  readPidFile,
  stopProcess,
  type StackPidFile,
} from "./pid-store.js";

function stopPidFileEntries(file: StackPidFile): void {
  const entries = Object.entries(file.services);

  for (const [id, svc] of [...entries].reverse()) {
    if (!svc.pid) {
      console.log(`[${svc.label ?? id}] external/untracked — skipped`);
      continue;
    }
    if (!isProcessAlive(svc.pid)) {
      console.log(`[${svc.label ?? id}] pid=${svc.pid} already gone`);
      continue;
    }
    const note = svc.external ? " (external; down stops it anyway)" : "";
    console.log(`[${svc.label ?? id}] stopping pid=${svc.pid}${note}`);
    stopProcess(svc.pid, "SIGTERM");
  }

  // No sleep here when nothing was signalled.
}

function killRemainingPidFileEntries(file: StackPidFile): void {
  for (const [id, svc] of [...Object.entries(file.services)].reverse()) {
    if (!svc.pid) continue;
    if (isProcessAlive(svc.pid)) {
      console.log(`[${svc.label ?? id}] force-kill pid=${svc.pid}`);
      stopProcess(svc.pid, "SIGKILL");
    }
  }
}

/**
 * Kill whole process groups of SlopControl-owned leftovers that were never
 * (or no longer) tracked in the pid file: dev watchers, orphaned pnpm trees,
 * lazy opencode daemons. Only matches command lines containing rootDir.
 */
function sweepLeftovers(rootDir: string, ports: Array<number | string>): number {
  const rows = findSlopControlProcesses(rootDir, ports);
  if (rows.length === 0) return 0;
  const groups = groupByPgid(rows);
  for (const [pgid, members] of groups) {
    const sample = members[0]?.command ?? "";
    console.log(
      `[sweep] stopping pgid=${pgid} (${members.length} proc): ${sample.slice(0, 110)}`,
    );
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {
      for (const m of members) stopProcess(m.pid, "SIGTERM");
    }
  }
  return groups.size;
}

function sweepForceKill(rootDir: string, ports: Array<number | string>): void {
  const rows = findSlopControlProcesses(rootDir, ports);
  for (const [pgid] of groupByPgid(rows)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}

export async function cmdDown(cwd: string = process.cwd()): Promise<void> {
  const file = readPidFile();

  let rootDir = file?.rootDir;
  let ports: Array<number | string> = ["4100-4199"];
  try {
    const { config, rootDir: cfgRoot } = loadConfig(cwd);
    rootDir = rootDir ?? cfgRoot;
    ports = [
      config.server.port,
      ...(config.web?.enabled ? [config.web.port] : []),
      config.coding.opencode?.port ?? 4096,
      "4100-4199",
    ];
  } catch {
    rootDir = rootDir ?? cwd;
  }

  let signalled = 0;
  if (file) {
    const entries = Object.entries(file.services);
    if (entries.length === 0) {
      console.log("PID file empty; cleared.");
      clearPidFile();
    } else {
      stopPidFileEntries(file);
      signalled = entries.filter(([, s]) => s.pid).length;
    }
  } else {
    console.log(
      "No stack PID file (~/.slopcontrol/cli/stack.pid.json) — sweeping for SlopControl processes.",
    );
  }

  signalled += sweepLeftovers(rootDir, ports);
  if (signalled > 0) {
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (file) killRemainingPidFileEntries(file);
  sweepForceKill(rootDir, ports);

  clearPidFile();
  console.log("Stack stopped.");
}
