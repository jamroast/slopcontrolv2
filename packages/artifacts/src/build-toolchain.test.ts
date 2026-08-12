import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  commandTemplateComplete,
  defaultToolchainSpec,
  detectBuildToolchain,
  resolveProjectToolchain,
  runToolchainCommand,
  substituteCommandArgs,
  toolchainBumpVersionCmd,
  toolchainConsumeUpdateCmd,
  toolchainInstallCmd,
  toolchainPublishCmd,
} from "./build-toolchain.js";
import { BuildToolchainSpecSchema } from "@slopcontrol/types";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-toolchain-${name}-`));
}

describe("build-toolchain defaults + detect", () => {
  it("normalizes drifted persisted specs: appends --no-git-tag-version", () => {
    const drifted = BuildToolchainSpecSchema.parse({
      ...defaultToolchainSpec("node-pnpm"),
      bumpVersionCmd: ["pnpm", "version", "{bump}"],
    });
    const { spec, source } = resolveProjectToolchain({
      projectRoot: "/nonexistent",
      configured: drifted,
    });
    assert.equal(source, "config");
    assert.deepEqual(spec?.bumpVersionCmd, [
      "pnpm",
      "version",
      "{bump}",
      "--no-git-tag-version",
    ]);
  });

  it("normalization is a no-op when the flag is already present", () => {
    const current = defaultToolchainSpec("node-pnpm");
    const { spec } = resolveProjectToolchain({
      projectRoot: "/nonexistent",
      configured: current,
    });
    assert.deepEqual(spec?.bumpVersionCmd, current?.bumpVersionCmd);
  });

  it("normalization leaves non-node kinds untouched", () => {
    const cargo = BuildToolchainSpecSchema.parse({
      kind: "rust-cargo",
      bumpVersionCmd: ["cargo", "version", "{bump}"],
      lockfiles: ["Cargo.lock"],
    });
    const { spec } = resolveProjectToolchain({
      projectRoot: "/nonexistent",
      configured: cargo,
    });
    assert.deepEqual(spec?.bumpVersionCmd, ["cargo", "version", "{bump}"]);
  });

  it("default specs exist for node-pnpm and node-npm", () => {
    const pnpm = defaultToolchainSpec("node-pnpm");
    assert.ok(pnpm);
    assert.deepEqual(pnpm.buildCmd, ["pnpm", "run", "build"]);
    const npm = defaultToolchainSpec("node-npm");
    assert.ok(npm);
    assert.deepEqual(npm.frozenInstallCmd, ["npm", "ci"]);
    assert.equal(defaultToolchainSpec("rust-cargo"), null);
  });

  it("detectBuildToolchain prefers pnpm when both lockfiles exist", () => {
    const root = tmp("detect");
    try {
      writeFileSync(join(root, "package.json"), "{}", "utf-8");
      writeFileSync(join(root, "package-lock.json"), "{}", "utf-8");
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const hint = detectBuildToolchain(root);
      assert.equal(hint.kind, "node-pnpm");
      assert.equal(hint.hasDefaultSpec, true);
      assert.ok(hint.matched.includes("pnpm-lock.yaml"));
      assert.ok(hint.matched.includes("package-lock.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectBuildToolchain flags non-node ecosystems without defaults", () => {
    const root = tmp("rust");
    try {
      writeFileSync(join(root, "Cargo.toml"), "[package]\n", "utf-8");
      const hint = detectBuildToolchain(root);
      assert.equal(hint.kind, "rust-cargo");
      assert.equal(hint.hasDefaultSpec, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveProjectToolchain: config wins, then default, then none", () => {
    const root = tmp("resolve");
    try {
      writeFileSync(join(root, "Cargo.toml"), "[package]\n", "utf-8");
      const none = resolveProjectToolchain({ projectRoot: root });
      assert.equal(none.source, "none");
      assert.equal(none.spec, null);

      const custom = BuildToolchainSpecSchema.parse({
        kind: "rust-cargo",
        buildCmd: ["cargo", "build", "--release"],
        lockfiles: ["Cargo.lock"],
      });
      const fromConfig = resolveProjectToolchain({
        projectRoot: root,
        configured: custom,
      });
      assert.equal(fromConfig.source, "config");
      assert.deepEqual(fromConfig.spec?.buildCmd, ["cargo", "build", "--release"]);

      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const fromDefault = resolveProjectToolchain({ projectRoot: root });
      assert.equal(fromDefault.source, "default");
      assert.equal(fromDefault.spec?.kind, "node-pnpm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("build-toolchain command templating", () => {
  it("substitutes placeholders and flags incomplete templates", () => {
    const out = substituteCommandArgs(
      ["pnpm", "publish", "--registry", "{registryUrl}"],
      { registryUrl: "http://127.0.0.1:4873/" },
    );
    assert.deepEqual(out, [
      "pnpm",
      "publish",
      "--registry",
      "http://127.0.0.1:4873/",
    ]);
    assert.equal(commandTemplateComplete(out), true);
    assert.equal(
      commandTemplateComplete(["pnpm", "version", "{bump}"]),
      false,
    );
  });

  it("builds bump/publish/consume/install commands from spec", () => {
    const spec = defaultToolchainSpec("node-pnpm");
    assert.ok(spec);
    assert.deepEqual(toolchainBumpVersionCmd(spec, "patch"), [
      "pnpm",
      "version",
      "patch",
      "--no-git-tag-version",
    ]);
    assert.deepEqual(toolchainPublishCmd(spec, "http://127.0.0.1:4873/"), [
      "pnpm",
      "publish",
      "--registry",
      "http://127.0.0.1:4873/",
      "--no-git-checks",
    ]);
    assert.deepEqual(toolchainConsumeUpdateCmd(spec, "@jamroast/components@^0.0.1"), [
      "pnpm",
      "add",
      "@jamroast/components@^0.0.1",
    ]);
    assert.deepEqual(toolchainInstallCmd(spec, { frozen: true }), [
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
    assert.deepEqual(toolchainInstallCmd(spec, { frozen: false }), [
      "pnpm",
      "install",
    ]);
  });

  it("returns null for unconfigured commands", () => {
    const spec = BuildToolchainSpecSchema.parse({ kind: "python", lockfiles: [] });
    assert.equal(toolchainPublishCmd(spec, "http://x/"), null);
    assert.equal(toolchainBumpVersionCmd(spec, "patch"), null);
  });
});

describe("runToolchainCommand", () => {
  it("captures output, exit code, and redacts secrets", async () => {
    const res = await runToolchainCommand({
      cmd: ["node", "-e", "console.log('token=tok-abcd1234'); process.exit(3)"],
      cwd: tmpdir(),
      redactSecrets: ["tok-abcd1234"],
    });
    assert.equal(res.code, 3);
    assert.match(res.stdout, /token=\*\*\*/);
    assert.ok(!res.stdout.includes("tok-abcd1234"));
  });
});
