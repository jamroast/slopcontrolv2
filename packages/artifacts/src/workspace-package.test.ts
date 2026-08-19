import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  bumpWorkspacePackageVersion,
  resolveWorkspacePackageDir,
} from "./workspace-package.js";

describe("workspace-package", () => {
  it("resolveWorkspacePackageDir joins project root and rejects escape", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-wspkg-"));
    const pkgDir = join(root, "packages", "service-token");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@jam/service-token", version: "0.1.0" }),
      "utf-8",
    );
    assert.equal(
      resolveWorkspacePackageDir(root, "packages/service-token"),
      pkgDir,
    );
    assert.throws(() => resolveWorkspacePackageDir(root, "../outside"));
  });

  it("bumpWorkspacePackageVersion increments patch", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-wspkg-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@jam/x", version: "0.1.1" }),
      "utf-8",
    );
    const bumped = bumpWorkspacePackageVersion(root, "patch");
    assert.equal(bumped.version, "0.1.2");
    const onDisk = JSON.parse(
      readFileSync(join(root, "package.json"), "utf-8"),
    ) as { version: string };
    assert.equal(onDisk.version, "0.1.2");
  });
});
