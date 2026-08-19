import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRecoveryEnv,
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

  it("rejects deny-list bypass via ./ prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    const result = validateRecoveryExecute({
      execute: "rm -rf ./src",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, false);
  });

  it("rejects deny-list bypass via reordered flags", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    const result = validateRecoveryExecute({
      execute: "rm -fr src",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, false);
  });

  it("rejects rm target escaping the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    writeFileSync(join(root, "package.json"), "{}");
    const result = validateRecoveryExecute({
      execute: "rm -rf node_modules/../../src",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /escapes project root/);
  });

  it("accepts rm of an in-root node_modules path with subdirectory", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-recover-"));
    writeFileSync(join(root, "package.json"), "{}");
    const result = validateRecoveryExecute({
      execute: "rm -rf node_modules/.cache && npm ci",
      verifyCwd: root,
      projectRoot: root,
      confidence: "high",
    });
    assert.equal(result.ok, true);
  });
});

describe("buildRecoveryEnv", () => {
  it("allowlists npm/pnpm/docker vars and drops secrets", () => {
    const env = buildRecoveryEnv({
      PATH: "/usr/bin",
      HOME: "/home/x",
      npm_config_registry: "https://npm.example.com",
      COMPOSE_PROJECT_NAME: "proj",
      OPENAI_API_KEY: "sk-secret",
      ANTHROPIC_API_KEY: "sk-secret-2",
      GITHUB_TOKEN: "ghp_secret",
    });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.npm_config_registry, "https://npm.example.com");
    assert.equal(env.COMPOSE_PROJECT_NAME, "proj");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
  });
});
