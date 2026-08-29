import { lstatSync } from "node:fs";
import { join } from "node:path";

/**
 * Common gitignored dependency install roots. Agents may `ln -s` the main tree's
 * install into a worktree; a symlink *file* bypasses `.gitignore`'s `dir/` rule,
 * gets committed on merge, and can become a self-referential loop (ELOOP).
 */
export const DEPENDENCY_INSTALL_ROOTS = [
  "node_modules",
  ".venv",
  "vendor",
] as const;

export type DependencyInstallRoot = (typeof DEPENDENCY_INSTALL_ROOTS)[number];

export function normalizeRelativePath(p: string): string {
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

export function isDependencyInstallRoot(relPath: string): boolean {
  const n = normalizeRelativePath(relPath);
  return DEPENDENCY_INSTALL_ROOTS.some(
    (root) => n === root || n.startsWith(`${root}/`),
  );
}

/** True when any known install root under projectRoot is a symlink (not a real tree). */
export function dependencyInstallRootIsSymlink(projectRoot: string): boolean {
  for (const root of DEPENDENCY_INSTALL_ROOTS) {
    try {
      if (lstatSync(join(projectRoot, root)).isSymbolicLink()) return true;
    } catch {
      /* missing */
    }
  }
  return false;
}
