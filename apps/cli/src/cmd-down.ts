import {
  clearPidFile,
  isProcessAlive,
  readPidFile,
  stopProcess,
} from "./pid-store.js";

export async function cmdDown(): Promise<void> {
  const file = readPidFile();
  if (!file) {
    console.log("No stack PID file (~/.slopcontrol/cli/stack.pid.json). Nothing to stop.");
    return;
  }

  const entries = Object.entries(file.services);
  if (entries.length === 0) {
    clearPidFile();
    console.log("PID file empty; cleared.");
    return;
  }

  for (const [id, svc] of [...entries].reverse()) {
    if (svc.external || !svc.pid) {
      console.log(`[${svc.label ?? id}] external/untracked — skipped`);
      continue;
    }
    if (!isProcessAlive(svc.pid)) {
      console.log(`[${svc.label ?? id}] pid=${svc.pid} already gone`);
      continue;
    }
    console.log(`[${svc.label ?? id}] stopping pid=${svc.pid}`);
    stopProcess(svc.pid, "SIGTERM");
  }

  await new Promise((r) => setTimeout(r, 1500));

  for (const [id, svc] of [...entries].reverse()) {
    if (svc.external || !svc.pid) continue;
    if (isProcessAlive(svc.pid)) {
      console.log(`[${svc.label ?? id}] force-kill pid=${svc.pid}`);
      stopProcess(svc.pid, "SIGKILL");
    }
  }

  clearPidFile();
  console.log("Stack stopped.");
}
