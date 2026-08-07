import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuildProcessConfigResultSchema } from "@slopcontrol/types";
import { BUILD_PROCESS_CONFIG_SYSTEM_PROMPT } from "./build-process-config-llm.js";

describe("build-process-config-llm", () => {
  it("system prompt covers the capability checklist + safety rules", () => {
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /JSON/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /BUILD/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /PUBLISH/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /CONSUME/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /DOCKER/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /CI/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /\{bump\}/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /\{registryUrl\}/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /\{dep\}/);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /never hard-coded localhost/i);
    assert.match(BUILD_PROCESS_CONFIG_SYSTEM_PROMPT, /NEVER propose source code/);
  });

  it("result schema accepts a node-pnpm resolution with changes", () => {
    const parsed = BuildProcessConfigResultSchema.parse({
      toolchain: {
        kind: "node-pnpm",
        buildCmd: ["pnpm", "run", "build"],
        installCmd: ["pnpm", "install"],
        frozenInstallCmd: ["pnpm", "install", "--frozen-lockfile"],
        bumpVersionCmd: ["pnpm", "version", "{bump}", "--no-git-tag-version"],
        publishCmd: ["pnpm", "publish", "--registry", "{registryUrl}", "--no-git-checks"],
        consumeUpdateCmd: ["pnpm", "add", "{dep}"],
        lockfiles: ["pnpm-lock.yaml"],
        registryEnvKeys: ["SLOPCONTROL_NPM_REGISTRY_URL"],
      },
      gaps: ["docker build lacks registry ARG"],
      changes: [
        {
          op: "edit_json",
          path: "package.json",
          set: { "scripts.build": "tsup" },
          rationale: "ensure build script",
        },
        {
          op: "replace_section",
          path: "Dockerfile",
          markerStart: "# BEGIN slopcontrol-registry",
          markerEnd: "# END slopcontrol-registry",
          content: "ARG NPM_REGISTRY_URL",
          rationale: "docker registry reachability",
        },
      ],
      notes: "Standard pnpm library; only docker wiring missing.",
      confidence: "high",
    });
    assert.equal(parsed.toolchain.kind, "node-pnpm");
    assert.equal(parsed.changes.length, 2);
    assert.equal(parsed.confidence, "high");
  });

  it("result schema accepts non-node toolchains (rust)", () => {
    const parsed = BuildProcessConfigResultSchema.parse({
      toolchain: {
        kind: "rust-cargo",
        buildCmd: ["cargo", "build", "--release"],
        lockfiles: ["Cargo.lock"],
        registryEnvKeys: [],
      },
      gaps: [],
      changes: [],
      notes: "",
      confidence: "medium",
    });
    assert.equal(parsed.toolchain.kind, "rust-cargo");
    assert.equal(parsed.toolchain.publishCmd, undefined);
  });

  it("result schema rejects malformed changes", () => {
    assert.throws(() =>
      BuildProcessConfigResultSchema.parse({
        toolchain: { kind: "node-pnpm", lockfiles: [], registryEnvKeys: [] },
        gaps: [],
        changes: [{ op: "delete_everything", path: "/" }],
        notes: "",
        confidence: "high",
      }),
    );
  });
});
