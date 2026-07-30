import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { tearDownComposeInDir } from "./compose-teardown.js";

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
