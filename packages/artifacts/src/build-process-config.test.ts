import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BuildToolchainSpecSchema } from "@slopcontrol/types";
import {
  allowedRunCommandBins,
  applyBuildProcessChanges,
  buildProcessEvidencePath,
  collectBuildProcessEvidence,
  readBuildProcessEvidence,
  writeBuildProcessEvidence,
} from "./build-process-config.js";
import {
  goldenDockerfileDepsSection,
  goldenProjectNpmrc,
} from "./ci-workflows.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-bpc-${name}-`));
}

const PNPM_SPEC = BuildToolchainSpecSchema.parse({
  kind: "node-pnpm",
  buildCmd: ["pnpm", "run", "build"],
  installCmd: ["pnpm", "install"],
  bumpVersionCmd: ["pnpm", "version", "{bump}", "--no-git-tag-version"],
  publishCmd: ["pnpm", "publish", "--registry", "{registryUrl}", "--no-git-checks"],
  consumeUpdateCmd: ["pnpm", "add", "{dep}"],
  lockfiles: ["pnpm-lock.yaml"],
  registryEnvKeys: ["SLOPCONTROL_NPM_REGISTRY_URL"],
});

describe("collectBuildProcessEvidence", () => {
  it("includes hint, tree, and manifest contents", () => {
    const root = tmp("evidence");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "lib", version: "0.0.0" }),
        "utf-8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const evidence = collectBuildProcessEvidence({
        projectRoot: root,
        configuredToolchain: null,
      });
      assert.match(evidence, /kind=node-pnpm/);
      assert.match(evidence, /--- package\.json ---/);
      assert.match(evidence, /"name":"lib"/);
      assert.match(evidence, /Currently resolved toolchain: \(none persisted\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("embeds golden .npmrc and Dockerfile patterns for node projects", () => {
    const root = tmp("evidence-goldens");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "lib", version: "0.0.0" }),
        "utf-8",
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const evidence = collectBuildProcessEvidence({
        projectRoot: root,
        configuredToolchain: null,
      });
      assert.match(evidence, /Golden committed \.npmrc/);
      assert.match(evidence, /@jamroast:registry=http:\/\/127\.0\.0\.1:4873\//);
      assert.match(evidence, /Golden Dockerfile dependency stage/);
      assert.match(evidence, /ARG SLOPCONTROL_NPM_REGISTRY_DOCKER_URL/);
      assert.match(evidence, /pnpm install --frozen-lockfile/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("golden templates substitute scopes and never embed a token value", () => {
    const npmrc = goldenProjectNpmrc(["@acme"]);
    assert.match(npmrc, /@acme:registry=http:\/\/127\.0\.0\.1:4873\//);
    assert.doesNotMatch(npmrc, /_authToken/);
    const docker = goldenDockerfileDepsSection(["@acme", "@other"]);
    assert.match(docker, /@acme:registry=%s/);
    assert.match(docker, /@other:registry=%s/);
    assert.match(docker, /_authToken=%s/);
    assert.match(docker, /"\$SLOPCONTROL_NPM_REGISTRY_TOKEN"/);
  });
});

describe("applyBuildProcessChanges guardrails", () => {
  it("write_file allowlisted path applies; source path rejected", () => {
    const root = tmp("apply");
    try {
      const { results } = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "write_file",
            path: ".github/workflows/ci.yml",
            content: "name: ci\n",
            rationale: "ci scaffold",
          },
          {
            op: "write_file",
            path: "src/evil.ts",
            content: "export {}\n",
            rationale: "not allowed",
          },
          {
            op: "write_file",
            path: "../escape.txt",
            content: "x",
            rationale: "escape",
          },
        ],
      });
      assert.equal(results[0]?.applied, true);
      assert.equal(results[1]?.applied, false);
      assert.match(results[1]?.detail ?? "", /allowlist/);
      assert.equal(results[2]?.applied, false);
      assert.match(results[2]?.detail ?? "", /escapes project root|allowlist/);
      assert.ok(
        readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf-8").includes("ci"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edit_json sets dot-paths on package.json; rejects non-json", () => {
    const root = tmp("editjson");
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "lib", scripts: { test: "node --test" } }),
        "utf-8",
      );
      const { results } = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "edit_json",
            path: "package.json",
            set: { "scripts.build": "tsup", "publishConfig.access": "public" },
            rationale: "build + publish config",
          },
          {
            op: "edit_json",
            path: ".npmrc",
            set: { x: 1 },
            rationale: "not json",
          },
        ],
      });
      assert.equal(results[0]?.applied, true);
      const doc = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      assert.equal(doc.scripts.build, "tsup");
      assert.equal(doc.scripts.test, "node --test");
      assert.equal(doc.publishConfig.access, "public");
      assert.equal(results[1]?.applied, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replace_section never splits a marker line (dangling continuation)", () => {
    const root = tmp("sectionline");
    try {
      writeFileSync(
        join(root, "Dockerfile"),
        [
          "FROM node:22-alpine AS deps",
          "COPY package.json pnpm-lock.yaml ./",
          "RUN --mount=type=cache,id=pnpm,target=/pnpm/store \\",
          "    pnpm install --frozen-lockfile",
          "",
        ].join("\n"),
        "utf-8",
      );
      const { results } = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "replace_section",
            path: "Dockerfile",
            markerStart: "COPY package.json pnpm-lock.yaml ./",
            // Marker is a PREFIX of the real line (which ends in ` \`).
            markerEnd: "RUN --mount=type=cache,id=pnpm,target=/pnpm/store",
            content: "ARG SLOPCONTROL_NPM_REGISTRY_TOKEN\nRUN printf 'x' > .npmrc",
            rationale: "registry wiring",
          },
        ],
      });
      assert.equal(results[0]?.applied, true);
      const out = readFileSync(join(root, "Dockerfile"), "utf-8");
      // Line-anchored match must NOT match the prefix; block is appended
      // instead, and the original RUN continuation survives intact.
      assert.match(out, /RUN --mount=type=cache,id=pnpm,target=\/pnpm\/store \\\n    pnpm install --frozen-lockfile/);
      assert.doesNotMatch(out, /pnpm\/store\n \\n/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replace_section inserts and replaces marker blocks", () => {
    const root = tmp("section");
    try {
      writeFileSync(join(root, "Dockerfile"), "FROM node:22\n", "utf-8");
      const mk = (content: string) => ({
        op: "replace_section" as const,
        path: "Dockerfile",
        markerStart: "# BEGIN slopcontrol-registry",
        markerEnd: "# END slopcontrol-registry",
        content,
        rationale: "registry wiring",
      });
      applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [mk("ARG NPM_REGISTRY_URL")],
      });
      const once = readFileSync(join(root, "Dockerfile"), "utf-8");
      assert.match(once, /FROM node:22/);
      assert.match(once, /ARG NPM_REGISTRY_URL/);

      applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [mk("ARG NPM_REGISTRY_URL\nARG NPM_REGISTRY_TOKEN")],
      });
      const twice = readFileSync(join(root, "Dockerfile"), "utf-8");
      assert.match(twice, /ARG NPM_REGISTRY_TOKEN/);
      assert.equal(
        (twice.match(/BEGIN slopcontrol-registry/g) ?? []).length,
        1,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yaml duplicate-key guard rejects corrupt compose writes", () => {
    const root = tmp("yamldup");
    try {
      const good = [
        "services:",
        "  app:",
        "    build:",
        "      args:",
        "        A: ${A}",
        "        B: ${B}",
        "",
      ].join("\n");
      const bad = [
        "services:",
        "  app:",
        "    build:",
        "      args:",
        "      args:",
        "        A: ${A}",
        "",
      ].join("\n");
      const ok = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "write_file",
            path: "docker-compose.yml",
            content: good,
            rationale: "valid",
          },
        ],
      });
      assert.equal(ok.results[0]?.applied, true);

      const rejected = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "write_file",
            path: "docker-compose.yml",
            content: bad,
            rationale: "corrupt",
          },
        ],
      });
      assert.equal(rejected.results[0]?.applied, false);
      assert.match(rejected.results[0]?.detail ?? "", /duplicate YAML key/);
      // Rejected write must leave the prior good file untouched.
      assert.equal(readFileSync(join(root, "docker-compose.yml"), "utf-8"), good);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("yaml guard allows repeated keys across list items (GH Actions steps)", () => {
    const root = tmp("ymlgh");
    try {
      const workflow = [
        "name: ci",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - uses: pnpm/action-setup@v4",
        "        with:",
        "          version: 10",
        "      - uses: actions/setup-node@v4",
        "        with:",
        "          node-version: 22",
        "      - name: Install",
        "        run: pnpm install --frozen-lockfile",
        "",
      ].join("\n");
      const { results } = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          {
            op: "write_file",
            path: ".github/workflows/ci.yml",
            content: workflow,
            rationale: "ci",
          },
        ],
      });
      assert.equal(results[0]?.applied, true, results[0]?.detail);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("run_command allowlist follows the toolchain bins", () => {
    const bins = allowedRunCommandBins(PNPM_SPEC);
    assert.ok(bins.has("pnpm"));
    assert.ok(bins.has("corepack"));
    assert.ok(!bins.has("rm"));

    const root = tmp("runcmd");
    try {
      const { results, pendingCommands } = applyBuildProcessChanges({
        projectRoot: root,
        toolchain: PNPM_SPEC,
        changes: [
          { op: "run_command", command: ["pnpm", "install"], rationale: "install" },
          { op: "run_command", command: ["rm", "-rf", "/"], rationale: "nope" },
        ],
      });
      assert.deepEqual(pendingCommands, [["pnpm", "install"]]);
      assert.equal(results[0]?.applied, true);
      assert.equal(results[1]?.applied, false);
      assert.match(results[1]?.detail ?? "", /not allowed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BUILD_PROCESS.json evidence", () => {
  it("round-trips evidence records", () => {
    const root = tmp("evidence-rw");
    try {
      assert.equal(readBuildProcessEvidence(root), null);
      writeBuildProcessEvidence(root, {
        toolchain: PNPM_SPEC,
        gaps: ["docker ARG missing"],
        notes: "audit only",
        confidence: "medium",
        origin: "llm",
        lastAuditAt: new Date().toISOString(),
        applied: [],
      });
      const back = readBuildProcessEvidence(root);
      assert.ok(back);
      assert.equal(back.origin, "llm");
      assert.equal(back.toolchain?.kind, "node-pnpm");
      assert.deepEqual(back.gaps, ["docker ARG missing"]);
      assert.ok(buildProcessEvidencePath(root).endsWith("BUILD_PROCESS.json"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
