import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ensureNpmRegistryLayout,
  ensureProjectNpmrc,
  formatScopedNpmrc,
  jamPackageNameForElement,
  listNpmRegistryPackages,
  readNpmRegistryMeta,
  scaffoldElementNpmPackage,
  buildVerdaccioConfigYaml,
} from "./npm-registry.js";
import {
  publishDesignElement,
  prepareDesignElementNpmPackage,
  recordDesignElementNpmPublish,
} from "./design-element.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-npm-${name}-`));
}

describe("npm-registry layout + rc", () => {
  it("ensureNpmRegistryLayout writes config, storage, REGISTRY.json", () => {
    const dataDir = tmp("data");
    try {
      const meta = ensureNpmRegistryLayout(dataDir);
      assert.match(meta.url, /127\.0\.0\.1/);
      assert.ok(meta.authToken.length >= 8);
      assert.ok(meta.scopes.includes("@jam"));
      const again = ensureNpmRegistryLayout(dataDir);
      assert.equal(again.authToken, meta.authToken);
      const cfg = readFileSync(
        join(dataDir, "npm-registry", "config.yaml"),
        "utf-8",
      );
      assert.match(cfg, /@jam\/\*/);
      assert.match(cfg, /proxy: npmjs/);
      assert.ok(readNpmRegistryMeta(dataDir));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("formatScopedNpmrc and ensureProjectNpmrc write managed block", () => {
    const root = tmp("proj");
    try {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, ".npmrc"), "shamefully-hoist=true\n", "utf-8");
      const block = formatScopedNpmrc({
        registryUrl: "http://127.0.0.1:4873/",
        authToken: "tok12345678",
      });
      assert.match(block, /@jam:registry=/);
      assert.match(block, /@slopcontrol:registry=/);
      assert.match(block, /_authToken=tok12345678/);

      ensureProjectNpmrc({
        projectRoot: root,
        registryUrl: "http://127.0.0.1:4873/",
        authToken: "tok12345678",
      });
      const body = readFileSync(join(root, ".npmrc"), "utf-8");
      assert.match(body, /shamefully-hoist/);
      assert.match(body, /BEGIN slopcontrol-npm-registry/);
      assert.match(body, /@jam:registry=/);

      ensureProjectNpmrc({
        projectRoot: root,
        registryUrl: "http://127.0.0.1:4873/",
        authToken: "tok-updated-999",
      });
      const body2 = readFileSync(join(root, ".npmrc"), "utf-8");
      assert.equal(
        (body2.match(/BEGIN slopcontrol-npm-registry/g) ?? []).length,
        1,
      );
      assert.match(body2, /tok-updated-999/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("listNpmRegistryPackages reads verdaccio-style storage docs", () => {
    const dataDir = tmp("list");
    try {
      ensureNpmRegistryLayout(dataDir);
      const pkgDir = join(
        dataDir,
        "npm-registry",
        "storage",
        "@jam",
        "theme-toggle",
      );
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@jam/theme-toggle",
          versions: { "1.0.0": {}, "2.0.0": {} },
          "dist-tags": { latest: "2.0.0" },
        }),
        "utf-8",
      );
      const pkgs = listNpmRegistryPackages(dataDir);
      assert.equal(pkgs.length, 1);
      assert.equal(pkgs[0]?.name, "@jam/theme-toggle");
      assert.equal(pkgs[0]?.latest, "2.0.0");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("buildVerdaccioConfigYaml includes listen host:port", () => {
    const yaml = buildVerdaccioConfigYaml({
      storageDir: "/tmp/storage",
      htpasswdPath: "/tmp/htpasswd",
      host: "127.0.0.1",
      port: 4873,
    });
    assert.match(yaml, /listen: 127\.0\.0\.1:4873/);
  });
});

describe("element npm scaffold", () => {
  it("jamPackageNameForElement and scaffoldElementNpmPackage", () => {
    assert.equal(jamPackageNameForElement("theme-toggle"), "@jam/theme-toggle");
    const out = tmp("pkg");
    try {
      const scaffold = scaffoldElementNpmPackage({
        outDir: out,
        elementId: "theme-toggle",
        version: 3,
        srcFiles: {
          "theme-toggle.ts": "export function toggle() {}\n",
        },
      });
      assert.equal(scaffold.packageName, "@jam/theme-toggle");
      assert.equal(scaffold.packageVersion, "3.0.0");
      const pkg = JSON.parse(
        readFileSync(join(out, "package.json"), "utf-8"),
      ) as { name: string; version: string };
      assert.equal(pkg.name, "@jam/theme-toggle");
      assert.equal(pkg.version, "3.0.0");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("prepareDesignElementNpmPackage + recordDesignElementNpmPublish", () => {
    const root = tmp("el");
    try {
      const meta = publishDesignElement({
        projectRoot: root,
        elementId: "theme-toggle",
        spec: "# Toggle\n",
        mockHtml: "<button class='theme-toggle'>x</button>",
        srcFiles: { "theme-toggle.ts": "export const x = 1;\n" },
      });
      const prepared = prepareDesignElementNpmPackage({
        projectRoot: root,
        elementId: "theme-toggle",
        version: meta.version,
      });
      assert.equal(prepared.packageName, "@jam/theme-toggle");
      assert.ok(prepared.packageRoot.includes("npm-package"));

      const recorded = recordDesignElementNpmPublish({
        projectRoot: root,
        elementId: "theme-toggle",
        version: meta.version,
        npmPackage: prepared.packageName,
        npmVersion: prepared.packageVersion,
      });
      assert.equal(recorded.npmPackage, "@jam/theme-toggle");
      assert.equal(recorded.npmVersion, prepared.packageVersion);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
