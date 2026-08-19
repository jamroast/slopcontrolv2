/**
 * Resolve nested workspace packages inside registered SlopControl projects.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type WorkspacePackageJson = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
};

/** Absolute path to a nested package folder (must contain package.json). */
export function resolveWorkspacePackageDir(
  projectRoot: string,
  packagePath: string,
): string {
  const root = resolve(projectRoot);
  const rel = packagePath.trim().replace(/^\/+/, "");
  if (!rel || rel.includes("..")) {
    throw new Error(`invalid packagePath: ${packagePath}`);
  }
  const dir = resolve(root, rel);
  if (!dir.startsWith(root)) {
    throw new Error(`packagePath escapes project root: ${packagePath}`);
  }
  if (!existsSync(join(dir, "package.json"))) {
    throw new Error(
      `no package.json at ${dir} — pass packagePath relative to project root (e.g. packages/service-token)`,
    );
  }
  return dir;
}

export function readWorkspacePackageJson(
  packageDir: string,
): WorkspacePackageJson & { name: string; version: string } {
  const pkg = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf-8"),
  ) as WorkspacePackageJson;
  if (!pkg.name?.trim()) {
    throw new Error(`package.json missing name in ${packageDir}`);
  }
  return {
    ...pkg,
    name: pkg.name.trim(),
    version: pkg.version?.trim() || "0.0.0",
  };
}

/** Bump semver in package.json (no git tag). */
export function bumpWorkspacePackageVersion(
  packageDir: string,
  bump: "patch" | "minor" | "major" = "patch",
): { name: string; version: string } {
  const path = join(packageDir, "package.json");
  const pkg = readWorkspacePackageJson(packageDir);
  const parts = pkg.version.split(".").map((p) => parseInt(p, 10));
  while (parts.length < 3) parts.push(0);
  let major = parts[0] ?? 0;
  let minor = parts[1] ?? 0;
  let patch = parts[2] ?? 0;
  if (Number.isNaN(major)) major = 0;
  if (Number.isNaN(minor)) minor = 0;
  if (Number.isNaN(patch)) patch = 0;
  if (bump === "major") {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === "minor") {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  const version = `${major}.${minor}.${patch}`;
  const next = { ...pkg, version };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return { name: pkg.name, version };
}
