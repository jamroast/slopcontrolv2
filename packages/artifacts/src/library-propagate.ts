/**
 * Library → consumer propagation.
 *
 * Kept out of npm-registry.ts on purpose: design-element/design-pack are
 * lazy-loaded through a CJS `createRequire` chain (see design-loop.ts) where
 * ESM-only packages like @slopcontrol/types cannot resolve at runtime. This
 * module pulls in build-toolchain.js (which parses types schemas at load),
 * so it must stay outside that chain — the barrel exports it for the server.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildToolchainSpec } from "@slopcontrol/types";
import {
  runToolchainCommand,
  toolchainConsumeUpdateCmd,
} from "./build-toolchain.js";

export type RegisteredConsumer = {
  id?: string;
  name: string;
  rootPath: string;
  /** Current dep spec in the consumer's package.json (e.g. "0.0.0", "^0.0.1"). */
  depSpec: string;
};

/**
 * Scan registered projects for ones depending on `packageName`
 * (dependencies or devDependencies). The library itself is excluded.
 */
export function findRegisteredConsumers(opts: {
  projects: Array<{ id?: string; name: string; rootPath: string }>;
  packageName: string;
  excludeRootPath?: string;
}): RegisteredConsumer[] {
  const out: RegisteredConsumer[] = [];
  for (const p of opts.projects) {
    if (opts.excludeRootPath && p.rootPath === opts.excludeRootPath) continue;
    const pkgPath = join(p.rootPath, "package.json");
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const depSpec =
        pkg.dependencies?.[opts.packageName] ??
        pkg.devDependencies?.[opts.packageName];
      if (depSpec) {
        out.push({ id: p.id, name: p.name, rootPath: p.rootPath, depSpec });
      }
    } catch {
      /* unreadable package.json — skip */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type PropagationResult = {
  consumer: RegisteredConsumer;
  ok: boolean;
  command: string[] | null;
  code?: number;
  detail: string;
};

/**
 * Update each consumer to `name@^version` via the consumer's OWN toolchain
 * (pnpm add / npm install …) so the lockfile refreshes natively. Never
 * hand-edit manifests or lockfiles.
 */
export async function propagateLibraryVersion(opts: {
  consumers: RegisteredConsumer[];
  packageName: string;
  version: string;
  resolveToolchain: (consumerRoot: string) => BuildToolchainSpec | null;
  runner?: typeof runToolchainCommand;
  timeoutMs?: number;
}): Promise<PropagationResult[]> {
  const runner = opts.runner ?? runToolchainCommand;
  const dep = `${opts.packageName}@^${opts.version}`;
  const results: PropagationResult[] = [];
  for (const consumer of opts.consumers) {
    const spec = opts.resolveToolchain(consumer.rootPath);
    const command = spec ? toolchainConsumeUpdateCmd(spec, dep) : null;
    if (!command) {
      results.push({
        consumer,
        ok: false,
        command: null,
        detail:
          "no consumeUpdateCmd for consumer toolchain — run project_build_process_configure",
      });
      continue;
    }
    const run = await runner({
      cmd: command,
      cwd: consumer.rootPath,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      redactSecrets: [process.env.SLOPCONTROL_NPM_REGISTRY_TOKEN ?? ""],
    });
    results.push({
      consumer,
      ok: run.code === 0,
      command,
      code: run.code,
      detail:
        run.code === 0
          ? `updated to ${dep}`
          : `consume update failed (${run.code}): ${(run.stderr || run.stdout).slice(0, 400)}`,
    });
  }
  return results;
}
