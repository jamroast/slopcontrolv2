import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.slopcontrol/cli/logs */
export function cliLogsDir(): string {
  return join(homedir(), ".slopcontrol", "cli", "logs");
}

export function serviceLogPath(serviceId: string): string {
  const safe = serviceId.replace(/[^a-zA-Z0-9._-]+/g, "_") || "service";
  return join(cliLogsDir(), `${safe}.log`);
}

export function ensureCliLogsDir(): string {
  const dir = cliLogsDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Append a line (with trailing newline) to a service log file. */
export function appendServiceLog(serviceId: string, line: string): void {
  ensureCliLogsDir();
  const path = serviceLogPath(serviceId);
  const text = line.endsWith("\n") ? line : `${line}\n`;
  appendFileSync(path, text, "utf-8");
}

/** Truncate / create empty log for a fresh spawn. */
export function resetServiceLog(serviceId: string): void {
  ensureCliLogsDir();
  writeFileSync(serviceLogPath(serviceId), "", "utf-8");
}

export function listServiceLogFiles(): Array<{ id: string; path: string; size: number }> {
  const dir = cliLogsDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; path: string; size: number }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (!st.isFile()) continue;
      out.push({
        id: name.replace(/\.log$/, ""),
        path,
        size: st.size,
      });
    } catch {
      /* ignore */
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Last N lines of a file (small files; fine for CLI log tails). */
export function readLastLines(filePath: string, maxLines: number): string {
  if (!existsSync(filePath) || maxLines <= 0) return "";
  let text = "";
  try {
    text = readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-maxLines).join("\n");
}
