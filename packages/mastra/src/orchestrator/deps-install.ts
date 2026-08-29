import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type PackageManager = "pnpm" | "yarn" | "npm";

/**
 * Detect the project package manager from package.json#packageManager
 * and/or lockfiles (pnpm > yarn > npm).
 */
export function detectPackageManager(cwd: string): PackageManager {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { packageManager?: string };
    const pm = String(pkg.packageManager ?? "");
    if (pm.startsWith("pnpm@")) return "pnpm";
    if (pm.startsWith("yarn@")) return "yarn";
    if (pm.startsWith("npm@")) return "npm";
  } catch {
    // fall through to lockfiles
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Install command for the project cwd (frozen when a lockfile is present).
 */
export function depsInstallCommand(cwd: string): string {
  const manager = detectPackageManager(cwd);
  if (manager === "pnpm") {
    const cmd = existsSync(join(cwd, "pnpm-lock.yaml"))
      ? "pnpm install --frozen-lockfile"
      : "pnpm install";
    // CI=1 suppresses pnpm's interactive "remove and reinstall?" prompt when
    // node_modules is a broken symlink or otherwise inconsistent.
    return `CI=1 ${cmd}`;
  }
  if (manager === "yarn") {
    return existsSync(join(cwd, "yarn.lock"))
      ? "yarn install --frozen-lockfile"
      : "yarn install";
  }
  const useCi =
    existsSync(join(cwd, "package-lock.json")) ||
    existsSync(join(cwd, "npm-shrinkwrap.json"));
  return useCi
    ? "npm ci --no-audit --no-fund"
    : "npm install --no-audit --no-fund";
}

function manifestPaths(cwd: string): string[] {
  return [
    join(cwd, "package.json"),
    join(cwd, "pnpm-lock.yaml"),
    join(cwd, "yarn.lock"),
    join(cwd, "package-lock.json"),
    join(cwd, "npm-shrinkwrap.json"),
  ].filter((p) => existsSync(p));
}

/**
 * True when `node_modules` is a symlink rather than a real install directory.
 * Coding agents sometimes `ln -s` the main tree's node_modules into a worktree;
 * that symlink becomes a self-referential loop after merge and must be treated
 * as missing so deps-install recreates a real install.
 */
export function nodeModulesIsSymlink(cwd: string): boolean {
  try {
    return lstatSync(join(cwd, "node_modules")).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * True when deps should be (re)installed before verify:
 * missing node_modules, forced, or package.json/lockfile newer than node_modules.
 */
export function needsDepsInstall(
  cwd: string,
  opts?: { force?: boolean },
): boolean {
  if (!existsSync(join(cwd, "package.json"))) return false;
  if (opts?.force) return true;
  const nm = join(cwd, "node_modules");
  if (!existsSync(nm)) return true;
  // A symlinked node_modules is not a real install — treat as missing.
  if (nodeModulesIsSymlink(cwd)) return true;
  let nmMtime: number;
  try {
    nmMtime = statSync(nm).mtimeMs;
  } catch {
    return true;
  }
  for (const p of manifestPaths(cwd)) {
    try {
      if (statSync(p).mtimeMs > nmMtime) return true;
    } catch {
      // ignore unreadable path
    }
  }
  return false;
}
