import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { checkHttpHealth, waitForHealth, type HealthMode } from "./health.js";
import {
  appendServiceLog,
  resetServiceLog,
  serviceLogPath,
  ensureCliLogsDir,
} from "./log-store.js";
import {
  clearPidFile,
  isProcessAlive,
  pidListeningOnHealthUrl,
  stopProcess,
  writePidFile,
  type StackPidFile,
  type StackServicePid,
} from "./pid-store.js";

export interface ManagedService {
  id: string;
  label: string;
  command: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  healthUrl: string;
  healthMode: HealthMode;
  isHealthy?: () => Promise<boolean>;
  /** Skip spawning when already healthy */
  skipIfHealthy?: boolean;
}

export interface RunningService {
  id: string;
  label: string;
  pid?: number;
  child?: ChildProcess;
  external: boolean;
  healthUrl: string;
  healthMode: HealthMode;
}

export type EnsureServiceOpts = {
  /** Suppress console tee (still write log files). */
  quietConsole?: boolean;
  /** Truncate service log before spawn (default true). */
  resetLog?: boolean;
  /**
   * Redirect child stdio to the log file and detach so the CLI can exit
   * without closing pipes (required for `up -d`).
   */
  detach?: boolean;
};

function prefixLine(
  label: string,
  line: string,
  stream: "stdout" | "stderr",
  opts?: { serviceId?: string; quietConsole?: boolean },
): void {
  const prefixed = `[${label}] ${line}`;
  if (opts?.serviceId) {
    try {
      appendServiceLog(opts.serviceId, prefixed);
    } catch {
      /* best-effort log file */
    }
  }
  if (opts?.quietConsole) return;
  const out = stream === "stderr" ? process.stderr : process.stdout;
  out.write(`${prefixed}\n`);
}

function attachLogs(
  serviceId: string,
  label: string,
  child: ChildProcess,
  opts?: { quietConsole?: boolean },
): void {
  const pipe = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      prefixLine(label, line, stream, {
        serviceId,
        quietConsole: opts?.quietConsole,
      });
    }
  };
  child.stdout?.on("data", (c: Buffer) => pipe(c, "stdout"));
  child.stderr?.on("data", (c: Buffer) => pipe(c, "stderr"));
}

export async function ensureService(
  spec: ManagedService,
  opts?: EnsureServiceOpts,
): Promise<RunningService> {
  const already = spec.isHealthy
    ? await spec.isHealthy()
    : await checkHttpHealth(spec.healthUrl, spec.healthMode);

  if (already && spec.skipIfHealthy !== false) {
    // Adopt the real pid so `slopcontrol down` can stop this process later;
    // foreground Ctrl+C (stopManagedServices) still skips external services.
    const pid = pidListeningOnHealthUrl(spec.healthUrl);
    prefixLine(
      spec.label,
      `already healthy at ${spec.healthUrl}${
        pid
          ? ` — pid=${pid} not started by this CLI; \`slopcontrol down\` will stop it, Ctrl+C here will not`
          : ""
      }`,
      "stdout",
      {
        serviceId: spec.id,
        quietConsole: opts?.quietConsole,
      },
    );
    return {
      id: spec.id,
      label: spec.label,
      pid,
      external: true,
      healthUrl: spec.healthUrl,
      healthMode: spec.healthMode,
    };
  }

  const [cmd, ...args] = spec.command;
  if (!cmd) throw new Error(`Empty command for service ${spec.id}`);

  if (opts?.resetLog !== false) {
    try {
      resetServiceLog(spec.id);
    } catch {
      /* ignore */
    }
  }

  prefixLine(
    spec.label,
    `starting: ${spec.command.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`,
    "stdout",
    { serviceId: spec.id, quietConsole: opts?.quietConsole },
  );

  const detach = Boolean(opts?.detach);
  let logFd: number | undefined;
  let child: ChildProcess;

  if (detach) {
    ensureCliLogsDir();
    logFd = openSync(serviceLogPath(spec.id), "a");
    child = spawn(cmd, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", logFd, logFd],
      detached: process.platform !== "win32",
    });
    try {
      closeSync(logFd);
    } catch {
      /* ignore */
    }
    logFd = undefined;
  } else {
    child = spawn(cmd, args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    attachLogs(spec.id, spec.label, child, {
      quietConsole: opts?.quietConsole,
    });
  }

  child.on("exit", (code, signal) => {
    prefixLine(
      spec.label,
      `exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      "stderr",
      { serviceId: spec.id, quietConsole: opts?.quietConsole },
    );
  });

  if (!child.pid) {
    throw new Error(`Failed to spawn ${spec.label}`);
  }

  await waitForHealth(spec.healthUrl, {
    mode: spec.healthMode,
    label: spec.label,
    timeoutMs: 90_000,
  });
  prefixLine(spec.label, `healthy at ${spec.healthUrl}`, "stdout", {
    serviceId: spec.id,
    quietConsole: opts?.quietConsole,
  });

  return {
    id: spec.id,
    label: spec.label,
    pid: child.pid,
    child,
    external: false,
    healthUrl: spec.healthUrl,
    healthMode: spec.healthMode,
  };
}

/** Detach spawned children so the CLI can exit without killing them. */
export function detachRunningServices(services: RunningService[]): void {
  for (const s of services) {
    if (!s.child || s.external) continue;
    try {
      s.child.unref();
    } catch {
      /* ignore */
    }
  }
}

export function persistStack(
  meta: { configPath: string; rootDir: string },
  services: RunningService[],
): void {
  const map: Record<string, StackServicePid> = {};
  for (const s of services) {
    if (s.pid) {
      map[s.id] = {
        pid: s.pid,
        label: s.label,
        external: s.external || undefined,
      };
    } else if (s.external) {
      map[s.id] = { pid: 0, label: s.label, external: true };
    }
  }
  const data: StackPidFile = {
    configPath: meta.configPath,
    rootDir: meta.rootDir,
    startedAt: new Date().toISOString(),
    services: map,
  };
  writePidFile(data);
}

export async function stopManagedServices(
  services: RunningService[],
): Promise<void> {
  for (const s of [...services].reverse()) {
    // External services (adopted, not spawned by us) survive Ctrl+C;
    // explicit `slopcontrol down` (cmd-down.ts) is what stops them.
    if (s.external || !s.pid) continue;
    prefixLine(s.label, `stopping pid=${s.pid}`, "stdout", {
      serviceId: s.id,
    });
    stopProcess(s.pid, "SIGTERM");
  }
  // brief grace then SIGKILL
  await new Promise((r) => setTimeout(r, 1500));
  for (const s of [...services].reverse()) {
    if (s.external || !s.pid) continue;
    if (isProcessAlive(s.pid)) {
      prefixLine(s.label, `force-kill pid=${s.pid}`, "stderr", {
        serviceId: s.id,
      });
      stopProcess(s.pid, "SIGKILL");
    }
  }
  clearPidFile();
}

export function waitForSignal(): Promise<"SIGINT" | "SIGTERM"> {
  return new Promise((resolve) => {
    const onSig = (sig: "SIGINT" | "SIGTERM") => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(sig);
    };
    const onInt = () => onSig("SIGINT");
    const onTerm = () => onSig("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
  });
}
