import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StackServicePid {
  pid: number;
  label: string;
  /** Process was already running; we did not spawn it */
  external?: boolean;
}

export interface StackPidFile {
  configPath: string;
  rootDir: string;
  startedAt: string;
  services: Record<string, StackServicePid>;
}

export function pidFilePath(): string {
  return join(homedir(), ".slopcontrol", "cli", "stack.pid.json");
}

export function readPidFile(): StackPidFile | undefined {
  const path = pidFilePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StackPidFile;
  } catch {
    return undefined;
  }
}

export function writePidFile(data: StackPidFile): void {
  const path = pidFilePath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function clearPidFile(): void {
  const path = pidFilePath();
  if (existsSync(path)) unlinkSync(path);
}

export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Kill a process group when possible (Unix), else the single PID. */
export function stopProcess(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!isProcessAlive(pid)) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, signal);
      return;
    }
  } catch {
    // fall through to single-pid kill
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
