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
  dependencyInstallRootIsSymlink,
  isDependencyInstallRoot,
} from "./dependency-install-root.js";

describe("dependency-install-root", () => {
  it("recognizes install roots and nested paths", () => {
    assert.equal(isDependencyInstallRoot("node_modules"), true);
    assert.equal(isDependencyInstallRoot("node_modules/foo"), true);
    assert.equal(isDependencyInstallRoot(".venv/lib"), true);
    assert.equal(isDependencyInstallRoot("vendor/autoload.php"), true);
    assert.equal(isDependencyInstallRoot("src/index.ts"), false);
  });

  it("detects symlinked install roots", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-install-root-"));
    const real = mkdtempSync(join(tmpdir(), "sc-install-real-"));
    try {
      mkdirSync(join(real, "node_modules"), { recursive: true });
      symlinkSync(join(real, "node_modules"), join(root, "node_modules"));
      assert.equal(dependencyInstallRootIsSymlink(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("accepts a real install directory", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-install-real-dir-"));
    try {
      writeFileSync(join(root, "package.json"), "{}");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      assert.equal(dependencyInstallRootIsSymlink(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
