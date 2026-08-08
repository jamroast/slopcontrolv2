import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultToolchainSpec } from "./build-toolchain.js";
import {
  renderCiWorkflowYaml,
  renderPublishWorkflowYaml,
} from "./ci-workflows.js";
import { collectBuildProcessEvidence } from "./build-process-config.js";
import { BuildToolchainSpecSchema } from "@slopcontrol/types";

describe("ci workflow templates", () => {
  it("ci.yml runs frozen install + build from the toolchain spec", () => {
    const spec = defaultToolchainSpec("node-pnpm");
    assert.ok(spec);
    const yaml = renderCiWorkflowYaml(spec);
    assert.ok(yaml);
    assert.match(yaml, /name: ci/);
    assert.match(yaml, /pnpm\/action-setup@v4/);
    assert.match(yaml, /run: pnpm install --frozen-lockfile/);
    assert.match(yaml, /run: pnpm run build/);
  });

  it("ci.yml generates .npmrc from secrets for registry-aware toolchains", () => {
    const spec = defaultToolchainSpec("node-pnpm");
    assert.ok(spec);
    const yaml = renderCiWorkflowYaml(spec)!;
    const npmrcIdx = yaml.indexOf("Generate .npmrc from SlopControl secrets");
    const installIdx = yaml.indexOf("pnpm install --frozen-lockfile");
    assert.ok(npmrcIdx !== -1, "npmrc step present");
    assert.ok(npmrcIdx < installIdx, "npmrc step precedes install");
    assert.match(yaml, /@jamroast:registry=%s/);
    assert.match(yaml, /secrets\.SLOPCONTROL_NPM_REGISTRY_TOKEN/);
    assert.ok(!yaml.includes("127.0.0.1"));
  });

  it("ci.yml omits the npmrc step when the toolchain ignores registries", () => {
    const spec = BuildToolchainSpecSchema.parse({
      kind: "rust-cargo",
      buildCmd: ["cargo", "build"],
      installCmd: ["cargo", "fetch"],
      frozenInstallCmd: ["cargo", "fetch", "--locked"],
      lockfiles: ["Cargo.lock"],
      registryEnvKeys: [],
    });
    const yaml = renderCiWorkflowYaml(spec);
    if (yaml) assert.doesNotMatch(yaml, /npmrc/);
  });

  it("ci.yml for node-npm uses npm ci", () => {
    const spec = defaultToolchainSpec("node-npm");
    assert.ok(spec);
    const yaml = renderCiWorkflowYaml(spec);
    assert.ok(yaml);
    assert.match(yaml, /run: npm ci/);
    assert.match(yaml, /cache: npm/);
  });

  it("publish.yml bumps + publishes with secret-driven registry", () => {
    const spec = defaultToolchainSpec("node-pnpm");
    assert.ok(spec);
    const yaml = renderPublishWorkflowYaml(spec);
    assert.ok(yaml);
    assert.match(yaml, /name: publish/);
    assert.match(yaml, /run: pnpm version patch --no-git-tag-version/);
    assert.match(
      yaml,
      /run: pnpm publish --registry "\$SLOPCONTROL_NPM_REGISTRY_URL" --no-git-checks/,
    );
    assert.match(
      yaml,
      /SLOPCONTROL_NPM_REGISTRY_URL: \$\{\{ secrets\.SLOPCONTROL_NPM_REGISTRY_URL \}\}/,
    );
    assert.ok(!yaml.includes("127.0.0.1"));
  });

  it("returns null for ecosystems without defaults", () => {
    const spec = BuildToolchainSpecSchema.parse({
      kind: "rust-cargo",
      buildCmd: ["cargo", "build", "--release"],
      lockfiles: ["Cargo.lock"],
      registryEnvKeys: [],
    });
    assert.equal(renderCiWorkflowYaml(spec), null);
    assert.equal(renderPublishWorkflowYaml(spec), null);
  });
});

describe("evidence bundle CI reference", () => {
  it("includes the reference ci.yml when the kind has defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "sc-bpc-ci-"));
    try {
      writeFileSync(join(root, "package.json"), "{}", "utf-8");
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n", "utf-8");
      const evidence = collectBuildProcessEvidence({
        projectRoot: root,
        configuredToolchain: null,
      });
      assert.match(evidence, /Reference ci\.yml for kind=node-pnpm/);
      assert.match(evidence, /run: pnpm install --frozen-lockfile/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
