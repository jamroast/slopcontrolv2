import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  snapshotCanonicalRuntimeEnv,
  tearDownComposeInDir,
} from "./compose-teardown.js";

describe("tearDownComposeInDir", () => {
  it("skips when no compose file is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-compose-"));
    try {
      const r = tearDownComposeInDir(dir);
      assert.equal(r.attempted, false);
      assert.equal(r.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attempts docker compose down when compose.yml exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-compose-"));
    try {
      writeFileSync(
        join(dir, "docker-compose.yml"),
        "services:\n  noop:\n    image: alpine:3.19\n    command: ['true']\n",
      );
      const r = tearDownComposeInDir(dir);
      assert.equal(r.attempted, true);
      // May fail if docker unavailable in CI — still must have attempted.
      assert.ok(typeof r.output === "string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("snapshotCanonicalRuntimeEnv", () => {
  it("captures registry keys from product .env files", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-canon-env-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        [
          "DB_PORT=5544",
          "SLOPCONTROL_NPM_REGISTRY_URL=http://127.0.0.1:4873/",
          "SLOPCONTROL_NPM_REGISTRY_DOCKER_URL=http://host.docker.internal:4873/",
          "SLOPCONTROL_NPM_REGISTRY_TOKEN=tok-abc123",
          "UNRELATED_KEY=nope",
          "",
        ].join("\n"),
        "utf-8",
      );
      const snap = snapshotCanonicalRuntimeEnv(dir);
      const env = snap.files[".env"];
      assert.ok(env);
      assert.equal(
        env.SLOPCONTROL_NPM_REGISTRY_URL,
        "http://127.0.0.1:4873/",
      );
      assert.equal(
        env.SLOPCONTROL_NPM_REGISTRY_DOCKER_URL,
        "http://host.docker.internal:4873/",
      );
      assert.equal(env.SLOPCONTROL_NPM_REGISTRY_TOKEN, "tok-abc123");
      assert.equal(env.UNRELATED_KEY, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
