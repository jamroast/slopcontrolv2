import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { runToolchainCommand } from "@slopcontrol/artifacts";
import { runProjectEnvSync } from "./env-sync.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-envsync-${name}-`));
}

describe("runProjectEnvSync", () => {
  it("returns no-env-sync-cmd when the project has no manage script", async () => {
    const root = tmp("none");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { build: "tsc" } }),
        "utf-8",
      );
      const result = await runProjectEnvSync({ projectRoot: root });
      assert.deepEqual(result, { ok: false, reason: "no-env-sync-cmd" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the detected envSyncCmd via the injected runner", async () => {
    const root = tmp("run");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { manage: "tsx scripts/cli.ts" } }),
        "utf-8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const calls: { cmd: string[]; cwd: string }[] = [];
      const fakeRunner: typeof runToolchainCommand = async (run) => {
        calls.push({ cmd: run.cmd, cwd: run.cwd });
        return {
          code: 0,
          stdout: "synced .env.local\n",
          stderr: "",
          durationMs: 1,
          timedOut: false,
        };
      };
      const result = await runProjectEnvSync({
        projectRoot: root,
        runner: fakeRunner,
      });
      assert.equal(result.ok, true);
      if (!("command" in result)) throw new Error("expected command result");
      assert.deepEqual(result.command, [
        "pnpm",
        "run",
        "manage",
        "--",
        "env",
        "sync",
      ]);
      assert.equal(result.code, 0);
      assert.match(result.stdoutTail, /synced/);
      assert.equal(calls[0]?.cwd, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("propagates a non-zero exit as ok:false", async () => {
    const root = tmp("fail");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ scripts: { manage: "tsx scripts/cli.ts" } }),
        "utf-8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const fakeRunner: typeof runToolchainCommand = async () => ({
        code: 1,
        stdout: "",
        stderr: "boom",
        durationMs: 1,
        timedOut: false,
      });
      const result = await runProjectEnvSync({
        projectRoot: root,
        runner: fakeRunner,
      });
      assert.equal(result.ok, false);
      if (!("code" in result)) throw new Error("expected command result");
      assert.equal(result.code, 1);
      assert.match(result.stdoutTail, /boom/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
