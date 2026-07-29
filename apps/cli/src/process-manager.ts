import { spawn, type ChildProcess } from "node:child_process";
import { checkHttpHealth, waitForHealth, type HealthMode } from "./health.js";
import {
  clearPidFile,
  isProcessAlive,
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

function prefixLine(label: string, line: string, stream: "stdout" | "stderr"): void {
  const out = stream === "stderr" ? process.stderr : process.stdout;
  out.write(`[${label}] ${line}\n`);
}

function attachLogs(label: string, child: ChildProcess): void {
  const pipe = (chunk: Buffer, stream: "stdout" | "stderr") => {
    const text = chunk.toString("utf-8");
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      prefixLine(label, line, stream);
    }
  };
  child.stdout?.on("data", (c: Buffer) => pipe(c, "stdout"));
  child.stderr?.on("data", (c: Buffer) => pipe(c, "stderr"));
}

export async function ensureService(
  spec: ManagedService,
): Promise<RunningService> {
  const already = spec.isHealthy
    ? await spec.isHealthy()
    : await checkHttpHealth(spec.healthUrl, spec.healthMode);

  if (already && spec.skipIfHealthy !== false) {
    prefixLine(spec.label, `already healthy at ${spec.healthUrl}`, "stdout");
    return {
      id: spec.id,
      label: spec.label,
      external: true,
      healthUrl: spec.healthUrl,
      healthMode: spec.healthMode,
    };
  }

  const [cmd, ...args] = spec.command;
  if (!cmd) throw new Error(`Empty command for service ${spec.id}`);

  prefixLine(
    spec.label,
    `starting: ${spec.command.map((c) => (/\s/.test(c) ? JSON.stringify(c) : c)).join(" ")}`,
    "stdout",
  );

  const child = spawn(cmd, args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  attachLogs(spec.label, child);

  child.on("exit", (code, signal) => {
    prefixLine(
      spec.label,
      `exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      "stderr",
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
  prefixLine(spec.label, `healthy at ${spec.healthUrl}`, "stdout");

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
    if (s.external || !s.pid) continue;
    prefixLine(s.label, `stopping pid=${s.pid}`, "stdout");
    stopProcess(s.pid, "SIGTERM");
  }
  // brief grace then SIGKILL
  await new Promise((r) => setTimeout(r, 1500));
  for (const s of [...services].reverse()) {
    if (s.external || !s.pid) continue;
    if (isProcessAlive(s.pid)) {
      prefixLine(s.label, `force-kill pid=${s.pid}`, "stderr");
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
