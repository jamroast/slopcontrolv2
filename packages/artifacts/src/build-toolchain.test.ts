import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  commandTemplateComplete,
  defaultToolchainSpec,
  detectBuildToolchain,
  detectEnvSyncCmd,
  resolveProjectToolchain,
  runToolchainCommand,
  substituteCommandArgs,
  toolchainBumpVersionCmd,
  toolchainConsumeUpdateCmd,
  toolchainInstallCmd,
  toolchainLintCmd,
  toolchainPublishCmd,
  toolchainTargetedTestCmd,
  toolchainTestCmd,
  toolchainTypecheckCmd,
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
    assert.equal(defaultToolchainSpec("haskell-cabal"), null);
  });

  it("default verification commands exist for cargo, go and python", () => {
    const cargo = defaultToolchainSpec("rust-cargo");
    assert.ok(cargo);
    assert.deepEqual(cargo.targetedTestCmd, ["cargo", "test", "{ref}"]);
    assert.deepEqual(cargo.typecheckCmd, ["cargo", "check"]);
    assert.deepEqual(cargo.lintCmd, ["cargo", "clippy"]);

    const go = defaultToolchainSpec("go");
    assert.ok(go);
    assert.deepEqual(go.testCmd, ["go", "test", "./..."]);
    assert.deepEqual(go.targetedTestCmd, ["go", "test", "./...", "-run", "{ref}"]);

    const python = defaultToolchainSpec("python");
    assert.ok(python);
    assert.deepEqual(python.targetedTestCmd, ["python", "-m", "pytest", "{ref}"]);
  });

  it("node defaults gain verification commands (vitest targeted, tsc static)", () => {
    const pnpm = defaultToolchainSpec("node-pnpm");
    assert.ok(pnpm);
    assert.deepEqual(pnpm.testCmd, ["pnpm", "test"]);
    assert.deepEqual(pnpm.targetedTestCmd, [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "{ref}",
    ]);
    assert.deepEqual(pnpm.typecheckCmd, ["pnpm", "exec", "tsc", "--noEmit"]);
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

  it("detectBuildToolchain flags non-node ecosystems with defaults", () => {
    const root = tmp("rust");
    try {
      writeFileSync(join(root, "Cargo.toml"), "[package]\n", "utf-8");
      const hint = detectBuildToolchain(root);
      assert.equal(hint.kind, "rust-cargo");
      assert.equal(hint.hasDefaultSpec, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectEnvSyncCmd finds a manage script; resolveProjectToolchain overlays it", () => {
    const root = tmp("envsync");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          scripts: { manage: "tsx scripts/cli.ts" },
        }),
        "utf-8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");

      assert.deepEqual(detectEnvSyncCmd(root, "node-pnpm"), [
        "pnpm",
        "run",
        "manage",
        "--",
        "env",
        "sync",
      ]);
      assert.deepEqual(detectEnvSyncCmd(root, "node-npm"), [
        "npm",
        "run",
        "manage",
        "--",
        "env",
        "sync",
      ]);
      assert.equal(detectEnvSyncCmd(root, "rust-cargo"), null);

      // Overlay attaches the detected command when the spec lacks one.
      const resolved = resolveProjectToolchain({ projectRoot: root });
      assert.equal(resolved.source, "default");
      assert.deepEqual(resolved.spec?.envSyncCmd, [
        "pnpm",
        "run",
        "manage",
        "--",
        "env",
        "sync",
      ]);

      // Persisted config envSyncCmd wins over detection.
      const configured = resolveProjectToolchain({
        projectRoot: root,
        configured: BuildToolchainSpecSchema.parse({
          ...defaultToolchainSpec("node-pnpm"),
          envSyncCmd: ["./scripts/env.sh"],
        }),
      });
      assert.deepEqual(configured.spec?.envSyncCmd, ["./scripts/env.sh"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectEnvSyncCmd returns null without a manage script", () => {
    const root = tmp("envsync-none");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { build: "tsc" } }),
        "utf-8",
      );
      assert.equal(detectEnvSyncCmd(root, "node-pnpm"), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveProjectToolchain: config wins, then default, then none", () => {
    const root = tmp("resolve");
    try {
      const none = resolveProjectToolchain({ projectRoot: root });
      assert.equal(none.source, "none");
      assert.equal(none.spec, null);

      writeFileSync(join(root, "Cargo.toml"), "[package]\n", "utf-8");
      const cargoDefault = resolveProjectToolchain({ projectRoot: root });
      assert.equal(cargoDefault.source, "default");
      assert.equal(cargoDefault.spec?.kind, "rust-cargo");

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

  it("builds verification commands from spec (targeted ref substitution)", () => {
    const cargo = defaultToolchainSpec("rust-cargo");
    assert.ok(cargo);
    assert.deepEqual(toolchainTargetedTestCmd(cargo, "tests::resolve_route"), [
      "cargo",
      "test",
      "tests::resolve_route",
    ]);
    assert.deepEqual(toolchainTestCmd(cargo), ["cargo", "test"]);
    assert.deepEqual(toolchainTypecheckCmd(cargo), ["cargo", "check"]);
    assert.deepEqual(toolchainLintCmd(cargo), ["cargo", "clippy"]);

    const pnpm = defaultToolchainSpec("node-pnpm");
    assert.ok(pnpm);
    assert.deepEqual(toolchainTargetedTestCmd(pnpm, "src/routes.test.ts"), [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "src/routes.test.ts",
    ]);
  });

  it("verification accessors return null when the spec declares none", () => {
    const spec = BuildToolchainSpecSchema.parse({
      kind: "haskell-cabal",
      lockfiles: [],
    });
    assert.equal(toolchainTestCmd(spec), null);
    assert.equal(toolchainTargetedTestCmd(spec, "Spec.hs"), null);
    assert.equal(toolchainTypecheckCmd(spec), null);
    assert.equal(toolchainLintCmd(spec), null);
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
