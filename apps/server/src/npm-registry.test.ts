import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ensureNpmRegistryLayout } from "@slopcontrol/artifacts";
import { getNpmRegistryStatus, pingNpmRegistry } from "./npm-registry.js";

describe("server npm-registry helpers", () => {
  it("getNpmRegistryStatus after ensure reports enabled meta", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "sc-srv-npm-"));
    try {
      process.env.SLOPCONTROL_NPM_REGISTRY = "1";
      ensureNpmRegistryLayout(dataDir);
      const st = getNpmRegistryStatus(dataDir);
      assert.equal(st.enabled, true);
      assert.ok(st.meta?.url);
      assert.equal(st.up, false);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("pingNpmRegistry returns false for dead port", async () => {
    const ok = await pingNpmRegistry("http://127.0.0.1:59999/", 400);
    assert.equal(ok, false);
  });
});
