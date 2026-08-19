import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseRecoveryExecutePayload,
  validateRecoveryExecute,
} from "./verify-recovery-execute.js";

describe("parseRecoveryExecutePayload", () => {
  it("parses bare JSON", () => {
    const payload = parseRecoveryExecutePayload(
      '{"execute":"rm -rf node_modules && npm ci","rationale":"stale tree","confidence":"high"}',
    );
    assert.ok(payload);
    assert.equal(payload!.execute, "rm -rf node_modules && npm ci");
    assert.equal(payload!.confidence, "high");
  });

  it("parses fenced JSON", () => {
    const payload = parseRecoveryExecutePayload(
      'Here is the fix:\n```json\n{"execute":"npm cache clean --force","rationale":"cache","confidence":"medium"}\n```',
    );
    assert.ok(payload);
    assert.match(payload!.execute, /cache clean/);
  });
});

describe("validateRecoveryExecute", () => {
  it("accepts node_modules clean + install", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    writeFileSync(join(root, "package.json"), "{}");
    const result = validateRecoveryExecute({
      execute: "rm -rf node_modules && npm ci --no-audit",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, true);
  });

  it("rejects rm -rf src", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    const result = validateRecoveryExecute({
      execute: "rm -rf src",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, false);
  });

  it("rejects low confidence", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    const result = validateRecoveryExecute({
      execute: "npm ci",
      verifyCwd: root,
      projectRoot: root,
      confidence: "low",
    });
    assert.equal(result.ok, false);
  });
});
