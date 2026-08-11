import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
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

export interface SweptProcess {
  pid: number;
  pgid: number;
  command: string;
}

/**
 * Parse `ps -ax -o pid=,ppid=,pgid=,command=` output, keeping rows whose
 * command line mentions the repo rootDir (SlopControl-owned).
 * Pure — testable without touching the process table.
 */
export function parseOwnedProcesses(
  psOutput: string,
  rootDir: string,
  excludeIds: Set<number>,
): SweptProcess[] {
  const out: SweptProcess[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const pgid = Number(m[3]);
    const command = m[4] ?? "";
    if (!command.includes(rootDir)) continue;
    if (excludeIds.has(pid) || excludeIds.has(pgid)) continue;
    out.push({ pid, pgid, command });
  }
  return out;
}

/**
 * Ids that must never be killed by a sweep: the CLI process itself, its
 * ancestors (e.g. the `pnpm slopcontrol` wrapper), its descendants (e.g.
 * tsx's esbuild service child — killing it crashes the CLI mid-run), and
 * every process group any of those belong to.
 */
export function selfPreserveIds(psOutput: string, selfPid: number): Set<number> {
  const ids = new Set<number>([selfPid]);
  try {
    ids.add(process.ppid);
  } catch {
    /* ignore */
  }
  try {
    const getpgid = (process as { getpgid?: (pid: number) => number }).getpgid;
    if (getpgid) ids.add(getpgid.call(process, 0));
  } catch {
    /* ignore */
  }
  // Index ppid/pgid of every row.
  const ppidOf = new Map<number, number>();
  const pgidOf = new Map<number, number>();
  for (const line of psOutput.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+/);
    if (m) {
      ppidOf.set(Number(m[1]), Number(m[2]));
      pgidOf.set(Number(m[1]), Number(m[3]));
    }
  }
  // Walk the ppid chain to protect the whole ancestor line.
  let cur = selfPid;
  for (let i = 0; i < 64; i++) {
    const parent = ppidOf.get(cur);
    if (!parent || parent <= 1 || ids.has(parent)) break;
    ids.add(parent);
    cur = parent;
  }
  // Protect descendants (children whose ppid chain reaches the CLI).
  let grew = true;
  for (let pass = 0; pass < 16 && grew; pass++) {
    grew = false;
    for (const [pid, ppid] of ppidOf) {
      if (!ids.has(pid) && ids.has(ppid)) {
        ids.add(pid);
        grew = true;
      }
    }
  }
  // Protect the process groups of everything preserved.
  for (const pid of [...ids]) {
    const pgid = pgidOf.get(pid);
    if (pgid) ids.add(pgid);
  }
  return ids;
}

/** Group swept rows by process group so we kill whole trees. */
export function groupByPgid(rows: SweptProcess[]): Map<number, SweptProcess[]> {
  const map = new Map<number, SweptProcess[]>();
  for (const r of rows) {
    const list = map.get(r.pgid) ?? [];
    list.push(r);
    map.set(r.pgid, list);
  }
  return map;
}

function execOut(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return "";
  }
}

/**
 * Resolve the pid listening on a health URL's port (Unix/macOS only).
 * Used to adopt externally-started services so `down` can stop them.
 */
export function pidListeningOnPort(port: number): number | undefined {
  if (process.platform === "win32") return undefined;
  const out = execOut(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`).trim();
  const pid = Number(out.split("\n")[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

export function pidListeningOnHealthUrl(healthUrl: string): number | undefined {
  try {
    const url = new URL(healthUrl);
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return pidListeningOnPort(port);
  } catch {
    return undefined;
  }
}

/**
 * Find all SlopControl-owned processes: anything whose command line contains
 * the repo rootDir, plus listeners on the given ports whose command matches.
 * Returns rows grouped for tree killing. Unix/macOS only; [] on win32.
 */
export function findSlopControlProcesses(
  rootDir: string,
  ports: Array<number | string>,
): SweptProcess[] {
  if (process.platform === "win32") return [];
  const psOut = execOut("ps -ax -o pid=,ppid=,pgid=,command=");
  const preserve = selfPreserveIds(psOut, process.pid);
  const rows = parseOwnedProcesses(psOut, rootDir, preserve);
  const seen = new Set(rows.map((r) => r.pid));

  // Port listeners (e.g. orphaned opencode daemons) matched by pid lookup.
  const portSpec = ports.map((p) => `-iTCP:${p}`).join(" ");
  if (portSpec) {
    const pids = execOut(`lsof -nP ${portSpec} -sTCP:LISTEN -t`)
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && !preserve.has(n));
    for (const pid of pids) {
      if (seen.has(pid)) continue;
      const row = execOut(`ps -o pid=,ppid=,pgid=,command= -p ${pid}`).trim();
      const parsed = parseOwnedProcesses(row, rootDir, preserve);
      for (const r of parsed) {
        if (!seen.has(r.pid)) {
          seen.add(r.pid);
          rows.push(r);
        }
      }
    }
  }
  return rows;
}
