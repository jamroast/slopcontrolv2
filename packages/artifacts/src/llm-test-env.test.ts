import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ProjectConfigSchema } from "@slopcontrol/types";
import {
  resolveLlmTestEnv,
  resolveLlmTestEnvWithProbe,
  scaffoldLlmTestHarness,
} from "./llm-test-env.js";

describe("resolveLlmTestEnv", () => {
  it("prefers process.env over .env.test and defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-llm-env-"));
    try {
      writeFileSync(
        join(root, ".env.test"),
        "OLLAMA_BASE_URL=http://from-file:11434/v1\nAI_CHAT_MODEL=file-model\n",
      );
      const config = ProjectConfigSchema.parse({
        llmTestProfile: "local",
        llmModelMap: { "glm-5.2:cloud": "mapped-local" },
      });
      const resolved = resolveLlmTestEnv({
        projectRoot: root,
        config,
        processEnv: {
          OLLAMA_BASE_URL: "http://from-process:11434/v1",
          AI_CHAT_MODEL: "glm-5.2:cloud",
        },
      });
      assert.equal(resolved.env.OLLAMA_BASE_URL, "http://from-process:11434/v1");
      assert.equal(resolved.env.AI_CHAT_MODEL, "mapped-local");
      assert.equal(resolved.profile, "local");
      assert.match(resolved.source, /process/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses free-tier cloud URL for local profile", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-llm-refuse-"));
    try {
      writeFileSync(
        join(root, ".env.test"),
        "OLLAMA_BASE_URL=https://api.ollama.cloud/v1\nAI_CHAT_MODEL=glm-5.2\n",
      );
      const resolved = resolveLlmTestEnv({
        projectRoot: root,
        config: ProjectConfigSchema.parse({ llmTestProfile: "local" }),
        processEnv: {},
      });
      assert.equal(resolved.env.OLLAMA_BASE_URL, "http://127.0.0.1:11434/v1");
      assert.ok(resolved.notes.some((n) => /refusing free-tier/i.test(n)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to fixture when local probe fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-llm-probe-"));
    try {
      const resolved = await resolveLlmTestEnvWithProbe({
        projectRoot: root,
        config: ProjectConfigSchema.parse({ llmTestProfile: "local" }),
        processEnv: {},
        probe: async () => ({ ok: false, detail: "down" }),
      });
      assert.equal(resolved.profile, "fixture");
      assert.equal(resolved.probeOk, false);
      assert.equal(resolved.env.OLLAMA_BASE_URL, "fixture://llm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scaffolds repo-safe harness files once", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-llm-scaffold-"));
    try {
      const first = scaffoldLlmTestHarness(root);
      assert.ok(first.written.includes(".env.test.example"));
      assert.ok(existsSync(join(root, ".env.test.example")));
      assert.ok(existsSync(join(root, "tests/helpers/llm-test-client.ts")));
      assert.match(
        readFileSync(join(root, ".env.test.example"), "utf-8"),
        /127\.0\.0\.1:11434/,
      );
      const second = scaffoldLlmTestHarness(root);
      assert.deepEqual(second.written, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
