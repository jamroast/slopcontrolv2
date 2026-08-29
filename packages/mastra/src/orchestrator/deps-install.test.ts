import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  depsInstallCommand,
  needsDepsInstall,
  nodeModulesIsSymlink,
} from "./deps-install.js";

describe("deps-install", () => {
  it("needsDepsInstall treats a symlinked node_modules as missing", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-deps-symlink-"));
    const real = mkdtempSync(join(tmpdir(), "sc-deps-real-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", packageManager: "pnpm@9" }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      // Real install lives elsewhere; worktree symlinks to it.
      mkdirSync(join(real, "node_modules"), { recursive: true });
      symlinkSync(join(real, "node_modules"), join(root, "node_modules"));

      assert.equal(nodeModulesIsSymlink(root), true);
      assert.equal(needsDepsInstall(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("needsDepsInstall accepts a real node_modules directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-deps-real-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", packageManager: "pnpm@9" }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      mkdirSync(join(root, "node_modules"), { recursive: true });

      assert.equal(nodeModulesIsSymlink(root), false);
      assert.equal(needsDepsInstall(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("depsInstallCommand prefixes pnpm with CI=1", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-deps-cmd-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", packageManager: "pnpm@9" }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      assert.equal(
        depsInstallCommand(root),
        "CI=1 pnpm install --frozen-lockfile",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
