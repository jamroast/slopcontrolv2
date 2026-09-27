import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  mirrorAfterLocalPublish,
  mirrorPackageToUpstream,
  npmRegistryMirrorPath,
  resolveNpmRegistryMirror,
} from "./npm-registry-mirror.js";
import { runToolchainCommand } from "./build-toolchain.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-mirror-${name}-`));
}

function writePkg(dir: string, name: string, version = "1.2.3"): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version }),
    "utf-8",
  );
}

function writeMirrorConfig(dataDir: string, cfg: unknown): void {
  writeFileSync(npmRegistryMirrorPath(dataDir), JSON.stringify(cfg), "utf-8");
}

const READY_ENV = { GITHUB_PACKAGES_TOKEN: "ghp_test_token_123" };

describe("resolveNpmRegistryMirror", () => {
  it("is off when the config file does not exist", () => {
    const dataDir = tmp("off");
    try {
      assert.deepEqual(resolveNpmRegistryMirror(dataDir), { status: "off" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("is off when enabled is false", () => {
    const dataDir = tmp("disabled");
    try {
      writeMirrorConfig(dataDir, {
        enabled: false,
        owner: "jamroast",
        token: "x",
      });
      assert.deepEqual(resolveNpmRegistryMirror(dataDir), { status: "off" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("is invalid on bad JSON and on schema violations", () => {
    const dataDir = tmp("invalid");
    try {
      writeFileSync(npmRegistryMirrorPath(dataDir), "{not json", "utf-8");
      let r = resolveNpmRegistryMirror(dataDir);
      assert.equal(r.status, "invalid");
      assert.match((r as { reason: string }).reason, /bad JSON/);

      writeMirrorConfig(dataDir, { registryUrl: "https://npm.pkg.github.com/" });
      r = resolveNpmRegistryMirror(dataDir);
      assert.equal(r.status, "invalid");
      assert.match((r as { reason: string }).reason, /owner/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("is invalid when the token env placeholder is unset, naming the var", () => {
    const dataDir = tmp("missing-env");
    try {
      writeMirrorConfig(dataDir, {
        owner: "jamroast",
        token: "${GITHUB_PACKAGES_TOKEN}",
      });
      const r = resolveNpmRegistryMirror(dataDir, {});
      assert.equal(r.status, "invalid");
      assert.match(
        (r as { reason: string }).reason,
        /GITHUB_PACKAGES_TOKEN/,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolves token placeholders, defaults scope to @owner, normalizes url", () => {
    const dataDir = tmp("ready");
    try {
      writeMirrorConfig(dataDir, {
        owner: "JamRoast",
        token: "prefix-${GITHUB_PACKAGES_TOKEN}",
      });
      const r = resolveNpmRegistryMirror(dataDir, READY_ENV);
      assert.equal(r.status, "ready");
      if (r.status !== "ready") return;
      assert.equal(r.config.token, "prefix-ghp_test_token_123");
      assert.equal(r.config.registryUrl, "https://npm.pkg.github.com/");
      assert.deepEqual(r.config.scopes, ["@jamroast"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("mirrorPackageToUpstream", () => {
  const mirror = {
    registryUrl: "https://npm.pkg.github.com/",
    owner: "jamroast",
    token: "ghp_test_token_123",
    scopes: ["@jamroast"],
  };

  it("skips packages whose scope is not mirrored", async () => {
    const dir = tmp("scope-skip");
    try {
      writePkg(dir, "@other/thing");
      const r = await mirrorPackageToUpstream({ packageDir: dir, mirror });
      assert.equal(r.mirrored, false);
      assert.match(r.reason ?? "", /not in mirror scopes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips scopes that do not match the GitHub owner with a rename hint", async () => {
    const dir = tmp("owner-mismatch");
    try {
      writePkg(dir, "@jam/service-token");
      const r = await mirrorPackageToUpstream({
        packageDir: dir,
        mirror: { ...mirror, scopes: ["@jamroast", "@jam"] },
      });
      assert.equal(r.mirrored, false);
      assert.match(r.reason ?? "", /scope to match the owner/);
      assert.match(r.reason ?? "", /@jamroast\/service-token/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publishes with env scope override + temp userconfig auth, then cleans up", async () => {
    const dir = tmp("publish");
    try {
      writePkg(dir, "@jamroast/components", "0.0.7");
      let seen:
        | {
            cmd: string[];
            env?: NodeJS.ProcessEnv;
            redactSecrets?: string[];
            userconfigBody: string;
            userconfigDir: string;
          }
        | undefined;
      const runner = (async (run: {
        cmd: string[];
        cwd: string;
        env?: NodeJS.ProcessEnv;
        redactSecrets?: string[];
      }) => {
        const userconfig = run.cmd[run.cmd.indexOf("--userconfig") + 1]!;
        seen = {
          cmd: run.cmd,
          env: run.env,
          redactSecrets: run.redactSecrets,
          userconfigBody: readFileSync(userconfig, "utf-8"),
          userconfigDir: join(userconfig, ".."),
        };
        return { code: 0, stdout: "+ @jamroast/components@0.0.7", stderr: "", durationMs: 1, timedOut: false };
      }) as typeof runToolchainCommand;

      const r = await mirrorPackageToUpstream({
        packageDir: dir,
        mirror,
        runner,
      });
      assert.equal(r.mirrored, true);
      assert.equal(r.name, "@jamroast/components");
      assert.equal(r.version, "0.0.7");
      assert.ok(seen);
      assert.deepEqual(seen.cmd.slice(0, 4), [
        "npm",
        "publish",
        "--registry",
        "https://npm.pkg.github.com/",
      ]);
      // Scoped registry override travels via env so it beats the package-dir
      // .npmrc loopback mapping; the token only appears in the userconfig.
      assert.equal(
        seen.env?.["npm_config_@jamroast:registry"],
        "https://npm.pkg.github.com/",
      );
      assert.equal(
        seen.userconfigBody,
        "//npm.pkg.github.com/:_authToken=ghp_test_token_123\n",
      );
      assert.deepEqual(seen.redactSecrets, ["ghp_test_token_123"]);
      // Temp userconfig dir removed after publish.
      assert.equal(existsSync(seen.userconfigDir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a 409 conflict as already-mirrored (ok)", async () => {
    const dir = tmp("conflict");
    try {
      writePkg(dir, "@jamroast/components", "0.0.7");
      const runner = (async () => ({
        code: 1,
        stdout: "",
        stderr: "npm ERR! 409 Conflict - EPUBLISHCONFLICT",
        durationMs: 1,
        timedOut: false,
      })) as unknown as typeof runToolchainCommand;
      const r = await mirrorPackageToUpstream({
        packageDir: dir,
        mirror,
        runner,
      });
      assert.equal(r.mirrored, true);
      assert.equal(r.alreadyMirrored, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces publish failure without throwing", async () => {
    const dir = tmp("failure");
    try {
      writePkg(dir, "@jamroast/components", "0.0.7");
      const runner = (async () => ({
        code: 1,
        stdout: "",
        stderr: "npm ERR! 403 Forbidden — bad token",
        durationMs: 1,
        timedOut: false,
      })) as unknown as typeof runToolchainCommand;
      const r = await mirrorPackageToUpstream({
        packageDir: dir,
        mirror,
        runner,
      });
      assert.equal(r.mirrored, false);
      assert.match(r.reason ?? "", /403 Forbidden/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mirrorAfterLocalPublish", () => {
  it("returns null when mirroring is off", async () => {
    const dataDir = tmp("after-off");
    const dir = tmp("after-off-pkg");
    try {
      writePkg(dir, "@jamroast/components");
      const r = await mirrorAfterLocalPublish({ dataDir, packageDir: dir });
      assert.equal(r, null);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an unmirrored result (with reason) when config is invalid", async () => {
    const dataDir = tmp("after-invalid");
    const dir = tmp("after-invalid-pkg");
    try {
      writeMirrorConfig(dataDir, {
        owner: "jamroast",
        token: "${GITHUB_PACKAGES_TOKEN}",
      });
      writePkg(dir, "@jamroast/components", "0.0.11");
      const r = await mirrorAfterLocalPublish({
        dataDir,
        packageDir: dir,
        env: {},
      });
      assert.ok(r);
      assert.equal(r.mirrored, false);
      assert.equal(r.name, "@jamroast/components");
      assert.match(r.reason ?? "", /GITHUB_PACKAGES_TOKEN/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirrors when ready", async () => {
    const dataDir = tmp("after-ready");
    const dir = tmp("after-ready-pkg");
    try {
      writeMirrorConfig(dataDir, {
        owner: "jamroast",
        token: "${GITHUB_PACKAGES_TOKEN}",
      });
      writePkg(dir, "@jamroast/components", "0.0.11");
      const runner = (async () => ({
        code: 0,
        stdout: "+ ok",
        stderr: "",
        durationMs: 1,
        timedOut: false,
      })) as unknown as typeof runToolchainCommand;
      const r = await mirrorAfterLocalPublish({
        dataDir,
        packageDir: dir,
        runner,
        env: READY_ENV,
      });
      assert.ok(r);
      assert.equal(r.mirrored, true);
      assert.equal(r.registryUrl, "https://npm.pkg.github.com/");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
