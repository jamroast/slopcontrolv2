import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  defaultToolchainSpec,
  ensureNpmRegistryLayout,
  readNpmRegistryMeta,
  runToolchainCommand,
} from "@slopcontrol/artifacts";
import { consumeLibraryFromRegistry, publishLibraryToRegistry } from "./npm-registry.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-libpub-${name}-`));
}

type RunOpts = Parameters<typeof runToolchainCommand>[0];

function writeLibPkg(dir: string, version: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@jamroast/components",
      version,
      scripts: { build: "tsup" },
    }),
    "utf-8",
  );
}

/** Fake toolchain runner: simulates build/bump/publish per command shape. */
function fakeRunner(opts: { failFirstPublish409?: boolean }) {
  const calls: string[][] = [];
  let publishAttempts = 0;
  const runner = async (run: RunOpts) => {
    const cmd = run.cmd.join(" ");
    calls.push(run.cmd);
    if (run.cmd[1] === "run" && run.cmd[2] === "build") {
      mkdirSync(join(run.cwd, "dist"), { recursive: true });
      writeFileSync(join(run.cwd, "dist", "index.js"), "export {};\n", "utf-8");
      return { code: 0, stdout: "built", stderr: "", durationMs: 1, timedOut: false };
    }
    if (run.cmd[1] === "version") {
      const pkgPath = join(run.cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
      const [maj, min, pat] = pkg.version.split(".").map(Number);
      pkg.version = `${maj}.${min}.${(pat ?? 0) + 1}`;
      writeFileSync(pkgPath, JSON.stringify(pkg), "utf-8");
      return { code: 0, stdout: `v${pkg.version}`, stderr: "", durationMs: 1, timedOut: false };
    }
    if (run.cmd[1] === "publish" || cmd.includes("publish")) {
      publishAttempts += 1;
      if (opts.failFirstPublish409 && publishAttempts === 1) {
        return {
          code: 1,
          stdout: "",
          stderr: "npm ERR! 409 Conflict - EPUBLISHCONFLICT",
          durationMs: 1,
          timedOut: false,
        };
      }
      return { code: 0, stdout: "+ @jamroast/components", stderr: "", durationMs: 1, timedOut: false };
    }
    if (run.cmd[1] === "add") {
      // consumer consume-update: rewrite dep spec like pnpm add would
      const pkgPath = join(run.cwd, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        dependencies: Record<string, string>;
      };
      const dep = run.cmd[2] ?? "";
      const at = dep.lastIndexOf("@");
      pkg.dependencies[dep.slice(0, at)] = dep.slice(at + 1);
      writeFileSync(pkgPath, JSON.stringify(pkg), "utf-8");
      return { code: 0, stdout: "added", stderr: "", durationMs: 1, timedOut: false };
    }
    return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
  };
  return { calls, runner: runner as typeof runToolchainCommand };
}

describe("publishLibraryToRegistry", () => {
  it("builds → bumps → publishes → records evidence → propagates", async () => {
    const dataDir = tmp("data");
    const lib = tmp("lib");
    const consumer = tmp("consumer");
    try {
      const meta0 = ensureNpmRegistryLayout(dataDir);
      mkdirSync(join(lib, "src"), { recursive: true });
      writeFileSync(join(lib, "src", "index.ts"), "export {};\n", "utf-8");
      writeLibPkg(lib, "0.0.0");
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "jampress",
          dependencies: { "@jamroast/components": "0.0.0" },
        }),
        "utf-8",
      );
      writeFileSync(join(consumer, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");

      const { calls, runner } = fakeRunner({});
      const report = await publishLibraryToRegistry({
        dataDir,
        packageDir: lib,
        toolchain: defaultToolchainSpec("node-pnpm")!,
        projects: [
          { id: "lib", name: "jamroast-components", rootPath: lib },
          { id: "jp", name: "JamPress", rootPath: consumer },
        ],
        runner,
        ensureRegistry: async () => meta0,
      });

      assert.equal(report.ok, true);
      assert.equal(report.name, "@jamroast/components");
      assert.equal(report.version, "0.0.1");
      assert.equal(report.toolchainKind, "node-pnpm");

      const stepKinds = report.steps.map((s) => s.step);
      assert.deepEqual(stepKinds, ["build", "bump", "publish"]);
      assert.deepEqual(calls[0], ["pnpm", "run", "build"]);
      assert.deepEqual(calls[1], [
        "pnpm",
        "version",
        "patch",
        "--no-git-tag-version",
      ]);
      assert.match(calls[2]?.join(" ") ?? "", /pnpm publish --registry/);

      // Evidence recorded in REGISTRY.json.
      const meta = readNpmRegistryMeta(dataDir);
      assert.equal(
        meta?.publishedPackages["@jamroast/components"]?.version,
        "0.0.1",
      );

      // Consumer updated via its own toolchain (pnpm add).
      assert.equal(report.propagation?.length, 1);
      assert.equal(report.propagation?.[0]?.ok, true);
      const consumerPkg = JSON.parse(
        readFileSync(join(consumer, "package.json"), "utf-8"),
      ) as { dependencies: Record<string, string> };
      assert.equal(
        consumerPkg.dependencies["@jamroast/components"],
        "^0.0.1",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("409 conflict triggers one re-bump and retry", async () => {
    const dataDir = tmp("data409");
    const lib = tmp("lib409");
    try {
      const meta0 = ensureNpmRegistryLayout(dataDir);
      mkdirSync(join(lib, "src"), { recursive: true });
      writeFileSync(join(lib, "src", "index.ts"), "export {};\n", "utf-8");
      mkdirSync(join(lib, "dist"), { recursive: true });
      // dist newer than src → build skipped
      writeFileSync(join(lib, "dist", "index.js"), "export {};\n", "utf-8");
      await new Promise((r) => setTimeout(r, 20));
      writeLibPkg(lib, "0.0.0");

      const { calls, runner } = fakeRunner({ failFirstPublish409: true });
      const report = await publishLibraryToRegistry({
        dataDir,
        packageDir: lib,
        toolchain: defaultToolchainSpec("node-pnpm")!,
        projects: [],
        runner,
        ensureRegistry: async () => meta0,
      });

      assert.equal(report.version, "0.0.2");
      const stepKinds = report.steps.map((s) => s.step);
      assert.deepEqual(stepKinds, ["build", "bump", "publish", "bump", "publish"]);
      assert.equal(report.steps[0]?.note, "dist up to date — skipped");
      const publishCalls = calls.filter((c) => c.includes("publish"));
      assert.equal(publishCalls.length, 2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("fails loudly when no toolchain resolves", async () => {
    const dataDir = tmp("data-none");
    const lib = tmp("lib-none");
    try {
      const meta0 = ensureNpmRegistryLayout(dataDir);
      writeFileSync(join(lib, "Cargo.toml"), "[package]\n", "utf-8");
      await assert.rejects(
        publishLibraryToRegistry({
          dataDir,
          packageDir: lib,
          projects: [],
          ensureRegistry: async () => meta0,
        }),
        /project_build_process_configure/,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("consumeLibraryFromRegistry bumps the consumer via its toolchain + commits", async () => {
    const dataDir = tmp("datacons");
    const consumer = tmp("cons");
    try {
      ensureNpmRegistryLayout(dataDir);
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({
          name: "crm",
          dependencies: { "@jamroast/components": "0.0.0" },
        }),
        "utf-8",
      );
      writeFileSync(join(consumer, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      const calls: string[][] = [];
      const report = await consumeLibraryFromRegistry({
        dataDir,
        projectRoot: consumer,
        packageName: "@jamroast/components",
        version: "0.0.2",
        runner: async (run) => {
          calls.push(run.cmd);
          return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
        },
      });
      assert.equal(report.ok, true);
      assert.equal(report.version, "0.0.2");
      assert.deepEqual(calls[0], ["pnpm", "add", "@jamroast/components@^0.0.2"]);
      assert.equal(calls[1]?.[0], "git");
      assert.match(report.propagation[0]?.detail ?? "", /bump committed/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });

  it("consumeLibraryFromRegistry rejects projects that do not depend on the package", async () => {
    const dataDir = tmp("datana");
    const consumer = tmp("cons-na");
    try {
      ensureNpmRegistryLayout(dataDir);
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "other", dependencies: { react: "^19" } }),
        "utf-8",
      );
      await assert.rejects(
        consumeLibraryFromRegistry({
          dataDir,
          projectRoot: consumer,
          packageName: "@jamroast/components",
          version: "0.0.2",
          runner: async () => ({
            code: 0,
            stdout: "",
            stderr: "",
            durationMs: 1,
            timedOut: false,
          }),
        }),
        /does not depend on/,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(consumer, { recursive: true, force: true });
    }
  });
});
