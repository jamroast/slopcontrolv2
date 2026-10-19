import { existsSync, mkdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import { designLoopAssetsDir } from "./design-media.js";

/**
 * Asset scope: a design loop (`loopId`) or an arbitrary project-relative dir
 * (`assetsDir`, e.g. a phase design dir during the design stage).
 */
export type AssetScope = {
  projectRoot: string;
  loopId?: string;
  assetsDir?: string;
};

export function scopeAssetsDir(scope: AssetScope): string {
  if (scope.assetsDir) {
    const abs = resolve(resolve(scope.projectRoot), scope.assetsDir);
    const root = resolve(scope.projectRoot);
    if (!abs.startsWith(root + sep) && abs !== root) {
      throw new Error("Invalid asset path");
    }
    return abs;
  }
  if (!scope.loopId) {
    throw new Error("loopId or assetsDir required for design asset op");
  }
  return resolve(designLoopAssetsDir(scope.projectRoot, scope.loopId));
}

export function safeBasename(name: string): string {
  const base = basename(String(name ?? "").trim());
  if (!base || base.includes("..") || base !== String(name ?? "").trim()) {
    throw new Error(`Invalid asset filename: ${name}`);
  }
  return base;
}

export function resolveScopedAsset(
  scope: AssetScope,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = scopeAssetsDir(scope);
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  if (!absolutePath.startsWith(dir + sep) && absolutePath !== dir) {
    throw new Error("Invalid asset path");
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`source_not_found: Asset not found: ${name}`);
  }
  return {
    absolutePath,
    relativePath: relative(resolve(scope.projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}

export function outPathScoped(
  scope: AssetScope,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = scopeAssetsDir(scope);
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  if (!absolutePath.startsWith(dir + sep) && absolutePath !== dir) {
    throw new Error("Invalid output path");
  }
  return {
    absolutePath,
    relativePath: relative(resolve(scope.projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}
