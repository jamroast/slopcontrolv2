import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ensureTestServices,
  findComposeFile,
  isInfraServiceName,
} from "./test-services.js";
import type { RunCommandResult } from "./build-toolchain.js";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "slop-test-svc-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  delete process.env.SLOPCONTROL_DISABLE_TEST_SERVICES;
});

describe("test-services", () => {
  it("findComposeFile prefers compose.yaml and falls back in order", () => {
    const root = tmp();
    assert.equal(findComposeFile(root), null);
    writeFileSync(join(root, "docker-compose.yml"), "services: {}");
    assert.equal(findComposeFile(root), "docker-compose.yml");
    writeFileSync(join(root, "compose.yaml"), "services: {}");
    assert.equal(findComposeFile(root), "compose.yaml");
  });

  it("isInfraServiceName matches infra names only", () => {
    for (const ok of ["db", "database", "postgres", "postgresql", "mysql", "redis", "mongo", "minio"]) {
      assert.equal(isInfraServiceName(ok), true, ok);
    }
    for (const no of ["web", "api", "app", "frontend", "worker"]) {
      assert.equal(isInfraServiceName(no), false, no);
    }
  });

  it("no compose file is a no-op", async () => {
    const res = await ensureTestServices({ projectRoot: tmp() });
    assert.equal(res.attempted, false);
    assert.equal(res.ok, true);
  });

  it("kill-switch disables bring-up", async () => {
    const root = tmp();
    writeFileSync(join(root, "compose.yaml"), "services: { db: {} }");
    process.env.SLOPCONTROL_DISABLE_TEST_SERVICES = "1";
    const res = await ensureTestServices({ projectRoot: root });
    assert.equal(res.attempted, false);
  });

  it("auto-detects infra services from compose config and starts them", async () => {
    const root = tmp();
    writeFileSync(join(root, "docker-compose.yml"), "services: {}");
    const calls: string[][] = [];
    const runner = async (opts: { cmd: string[] }): Promise<RunCommandResult> => {
      calls.push(opts.cmd);
      if (opts.cmd.includes("--services")) {
        return { code: 0, stdout: "db\nweb\nredis\napi\n", stderr: "", durationMs: 1, timedOut: false };
      }
      return { code: 0, stdout: "started", stderr: "", durationMs: 1, timedOut: false };
    };
    const res = await ensureTestServices({ projectRoot: root, runner });
    assert.equal(res.attempted, true);
    assert.equal(res.ok, true);
    assert.deepEqual(res.services, ["db", "redis"]);
    assert.deepEqual(calls[1], ["docker", "compose", "up", "-d", "--wait", "db", "redis"]);
  });

  it("configured services win over auto-detect", async () => {
    const root = tmp();
    writeFileSync(join(root, "docker-compose.yml"), "services: {}");
    const calls: string[][] = [];
    const runner = async (opts: { cmd: string[] }): Promise<RunCommandResult> => {
      calls.push(opts.cmd);
      return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
    };
    const res = await ensureTestServices({
      projectRoot: root,
      configured: ["cache", "db"],
      runner,
    });
    assert.deepEqual(res.services, ["cache", "db"]);
    assert.equal(calls.length, 1); // no --services probe
  });

  it("reports failure when bring-up exits non-zero", async () => {
    const root = tmp();
    writeFileSync(join(root, "docker-compose.yml"), "services: {}");
    let n = 0;
    const runner = async (): Promise<RunCommandResult> => {
      n += 1;
      return n === 1
        ? { code: 0, stdout: "db\n", stderr: "", durationMs: 1, timedOut: false }
        : { code: 1, stdout: "", stderr: "docker daemon not running", durationMs: 1, timedOut: false };
    };
    const res = await ensureTestServices({ projectRoot: root, runner });
    assert.equal(res.attempted, true);
    assert.equal(res.ok, false);
    assert.match(res.detail, /FAILED/);
  });
});
