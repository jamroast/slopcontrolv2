import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  readBuildProcessEvidence,
  readProjectConfig,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  onboardProjectBuildProcess,
  suggestComponentLibrary,
} from "./build-process.js";

const ENDPOINT: LlmEndpoint = {
  id: "test",
  label: "test",
  baseUrl: "http://llm.test/v1",
  apiType: "openai-chat",
  modelId: "test-model",
  capabilities: { chat: true, vision: false, imageGen: false },
};

const REGISTRY_META = {
  url: "http://127.0.0.1:4873/",
  port: 4873,
  authToken: "tok-onboard-1",
};

const LLM_RESULT = {
  toolchain: {
    kind: "node-pnpm",
    buildCmd: ["pnpm", "run", "build"],
    installCmd: ["pnpm", "install"],
    bumpVersionCmd: ["pnpm", "version", "{bump}", "--no-git-tag-version"],
    publishCmd: [
      "pnpm",
      "publish",
      "--registry",
      "{registryUrl}",
      "--no-git-checks",
    ],
    consumeUpdateCmd: ["pnpm", "add", "{dep}"],
    lockfiles: ["pnpm-lock.yaml"],
    registryEnvKeys: ["SLOPCONTROL_NPM_REGISTRY_URL"],
  },
  gaps: ["no Dockerfile registry wiring"],
  changes: [
    {
      op: "write_file",
      path: ".npmrc",
      content: "@jamroast:registry=http://127.0.0.1:4873/\n",
      rationale: "commit the literal loopback registry",
    },
  ],
  notes: "configured",
  confidence: "high",
};

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-onboard-${name}-`));
}

function seedNodeProject(root: string): void {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "@acme/widgets",
      version: "1.2.3",
      scripts: { build: "tsc -p tsconfig.json" },
    }),
    "utf-8",
  );
  writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
  writeFileSync(join(root, ".gitignore"), "node_modules\n.env\n", "utf-8");
}

function mockLlm(reply: unknown): () => void {
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(reply) } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  return () => fetchMock.mock.restore();
}

describe("suggestComponentLibrary", () => {
  it("flags scoped public packages, not apps or private packages", () => {
    const root = tmp("suggest");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@acme/widgets",
          version: "1.0.0",
          scripts: { build: "tsc" },
        }),
        "utf-8",
      );
      assert.equal(suggestComponentLibrary(root), true);

      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "@acme/widgets",
          private: true,
          scripts: { build: "tsc" },
        }),
        "utf-8",
      );
      assert.equal(suggestComponentLibrary(root), false);

      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "my-app", scripts: { build: "tsc" } }),
        "utf-8",
      );
      assert.equal(suggestComponentLibrary(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("onboardProjectBuildProcess", () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    process.env.TEST_LLM_KEY = "k";
  });
  afterEach(() => {
    restore?.();
    restore = null;
    delete process.env.TEST_LLM_KEY;
  });

  it("configures, persists toolchain, injects registry env, records status", async () => {
    const root = tmp("happy");
    try {
      seedNodeProject(root);
      restore = mockLlm(LLM_RESULT);

      const report = await onboardProjectBuildProcess({
        projectRoot: root,
        endpoint: ENDPOINT,
        registryMeta: REGISTRY_META,
        componentLibrary: true,
      });

      assert.equal(report.status, "applied");
      assert.equal(report.toolchainKind, "node-pnpm");
      assert.equal(report.suggestedComponentLibrary, true);
      assert.ok(report.envFiles.includes(".env"));

      // LLM-proposed .npmrc was applied through the guardrails.
      const npmrc = readFileSync(join(root, ".npmrc"), "utf-8");
      assert.match(npmrc, /@jamroast:registry=http:\/\/127\.0\.0\.1:4873\//);

      // Toolchain + componentLibrary persisted to project config.
      const config = readProjectConfig(root);
      assert.equal(config.toolchain?.kind, "node-pnpm");
      assert.equal(config.componentLibrary, true);

      // Deterministic env injection (token allowed: .env is gitignored).
      const envBody = readFileSync(join(root, ".env"), "utf-8");
      assert.match(envBody, /SLOPCONTROL_NPM_REGISTRY_TOKEN=tok-onboard-1/);

      // Onboarding status recorded in evidence.
      const evidence = readBuildProcessEvidence(root);
      assert.equal(evidence?.onboarding, "applied");
      assert.ok(evidence?.lastOnboardAt);
      assert.equal(evidence?.origin, "llm");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records audit-only when the LLM reports low confidence", async () => {
    const root = tmp("lowconf");
    try {
      seedNodeProject(root);
      restore = mockLlm({ ...LLM_RESULT, confidence: "low" });

      const report = await onboardProjectBuildProcess({
        projectRoot: root,
        endpoint: ENDPOINT,
        registryMeta: REGISTRY_META,
      });

      assert.equal(report.status, "audit-only");
      const evidence = readBuildProcessEvidence(root);
      assert.equal(evidence?.onboarding, "audit-only");
      // Nothing applied: no .npmrc written by the LLM change.
      assert.throws(() => readFileSync(join(root, ".npmrc"), "utf-8"));
      // Env injection still runs — the contract is deterministic.
      assert.ok(report.envFiles.includes(".env"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never throws: LLM failure records onboarding failed", async () => {
    const root = tmp("llmfail");
    try {
      seedNodeProject(root);
      const fetchMock = mock.method(globalThis, "fetch", async () => {
        throw new Error("llm offline");
      });
      restore = () => fetchMock.mock.restore();

      const report = await onboardProjectBuildProcess({
        projectRoot: root,
        endpoint: ENDPOINT,
        registryMeta: REGISTRY_META,
      });

      assert.equal(report.status, "failed");
      assert.ok(report.error);
      const evidence = readBuildProcessEvidence(root);
      assert.equal(evidence?.onboarding, "failed");
      assert.match(evidence?.notes ?? "", /onboarding failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
