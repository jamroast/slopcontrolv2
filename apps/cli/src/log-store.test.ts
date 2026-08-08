import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  appendServiceLog,
  cliLogsDir,
  listServiceLogFiles,
  readLastLines,
  resetServiceLog,
  serviceLogPath,
  serviceLogPrevPath,
} from "./log-store.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("log-store", () => {
  it("serviceLogPath lives under cli logs dir", () => {
    assert.equal(serviceLogPath("server"), join(cliLogsDir(), "server.log"));
    assert.match(serviceLogPath("weird/name"), /weird_name\.log$/);
  });

  it("append + readLastLines round-trip", () => {
    // Use real home logs dir briefly with a unique id, then leave file (ok)
    const id = `test-${Date.now()}`;
    resetServiceLog(id);
    appendServiceLog(id, "line one");
    appendServiceLog(id, "line two\n");
    appendServiceLog(id, "line three");
    const path = serviceLogPath(id);
    const text = readFileSync(path, "utf-8");
    assert.match(text, /line one/);
    assert.match(text, /line three/);
    assert.equal(readLastLines(path, 2), "line two\nline three");
    assert.ok(listServiceLogFiles().some((f) => f.id === id));
    rmSync(path, { force: true });
  });

  it("resetServiceLog rotates the current log to .prev instead of truncating", () => {
    const id = `test-rotate-${Date.now()}`;
    const path = serviceLogPath(id);
    const prev = serviceLogPrevPath(id);
    try {
      appendServiceLog(id, "old run output");
      resetServiceLog(id);
      assert.equal(readFileSync(path, "utf-8"), "");
      assert.match(readFileSync(prev, "utf-8"), /old run output/);
      // .prev stays out of the service listing (no fake "server.prev" service)
      assert.ok(!listServiceLogFiles().some((f) => f.path === prev));
      // Second rotation replaces the older prev
      appendServiceLog(id, "new run output");
      resetServiceLog(id);
      assert.match(readFileSync(prev, "utf-8"), /new run output/);
      assert.ok(!readFileSync(prev, "utf-8").includes("old run output"));
    } finally {
      rmSync(path, { force: true });
      rmSync(prev, { force: true });
    }
  });

  it("readLastLines returns empty for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-log-"));
    roots.push(dir);
    assert.equal(readLastLines(join(dir, "nope.log"), 10), "");
  });
});
