import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ensureNpmRegistryLayout,
  ensureProjectNpmrc,
  formatScopedNpmrc,
  jamPackageNameForElement,
  listNpmRegistryPackages,
  npmRegistryDockerUrl,
  npmRegistryEnvValues,
  npmRegistryPackageFreshness,
  readNpmRegistryMeta,
  scaffoldElementNpmPackage,
  buildVerdaccioConfigYaml,
  writeProjectRegistryEnv,
} from "./npm-registry.js";
import {
  findRegisteredConsumers,
  propagateLibraryVersion,
  type RegisteredConsumer,
} from "./library-propagate.js";
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
      assert.ok(meta.scopes.includes("@jamroast"));
      const again = ensureNpmRegistryLayout(dataDir);
      assert.equal(again.authToken, meta.authToken);
      const cfg = readFileSync(
        join(dataDir, "npm-registry", "config.yaml"),
        "utf-8",
      );
      assert.match(cfg, /@jam\/\*/);
      assert.match(cfg, /@jamroast\/\*/);
      assert.match(cfg, /proxy: npmjs/);
      assert.ok(readNpmRegistryMeta(dataDir));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ensureNpmRegistryLayout honors SLOPCONTROL_NPM_REGISTRY_HOST", () => {
    const dataDir = tmp("host");
    const prior = process.env.SLOPCONTROL_NPM_REGISTRY_HOST;
    process.env.SLOPCONTROL_NPM_REGISTRY_HOST = "0.0.0.0";
    try {
      const meta = ensureNpmRegistryLayout(dataDir);
      assert.equal(meta.host, "0.0.0.0");
      assert.match(meta.url, /0\.0\.0\.0/);
      const cfg = readFileSync(
        join(dataDir, "npm-registry", "config.yaml"),
        "utf-8",
      );
      assert.match(cfg, /listen: 0\.0\.0\.0:/);
    } finally {
      if (prior === undefined) delete process.env.SLOPCONTROL_NPM_REGISTRY_HOST;
      else process.env.SLOPCONTROL_NPM_REGISTRY_HOST = prior;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("npmRegistryDockerUrl points at host.docker.internal", () => {
    assert.equal(
      npmRegistryDockerUrl({ port: 4873 }),
      "http://host.docker.internal:4873/",
    );
  });

  it("npmRegistryEnvValues emits the canonical registry env keys", () => {
    const env = npmRegistryEnvValues({
      url: "http://127.0.0.1:4873/",
      port: 4873,
      authToken: "tok-abcdef",
    });
    assert.deepEqual(env, {
      SLOPCONTROL_NPM_REGISTRY_URL: "http://127.0.0.1:4873/",
      SLOPCONTROL_NPM_REGISTRY_DOCKER_URL: "http://host.docker.internal:4873/",
      SLOPCONTROL_NPM_REGISTRY_AUTH_HOST: "127.0.0.1:4873",
      SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST: "host.docker.internal:4873",
      SLOPCONTROL_NPM_REGISTRY_TOKEN: "tok-abcdef",
    });
  });

  it("writeProjectRegistryEnv upserts keys, preserves unrelated, guards the token", () => {
    const root = tmp("registry-env");
    try {
      // .env exists with an unrelated key; .gitignore covers .env only.
      writeFileSync(join(root, ".env"), "APP_NAME=demo\n", "utf-8");
      writeFileSync(join(root, ".gitignore"), "node_modules\n.env\n", "utf-8");
      const meta = {
        url: "http://127.0.0.1:4873/",
        port: 4873,
        authToken: "tok-secret-1",
      };
      const first = writeProjectRegistryEnv({ projectRoot: root, meta });
      assert.deepEqual(first.files.sort(), [".env", ".env.docker"]);
      assert.equal(first.tokenWritten, true);

      const envBody = readFileSync(join(root, ".env"), "utf-8");
      assert.match(envBody, /APP_NAME=demo/);
      assert.match(envBody, /SLOPCONTROL_NPM_REGISTRY_URL=http:\/\/127\.0\.0\.1:4873\//);
      assert.match(envBody, /SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST=host\.docker\.internal:4873/);
      assert.match(envBody, /SLOPCONTROL_NPM_REGISTRY_TOKEN=tok-secret-1/);

      const dockerBody = readFileSync(join(root, ".env.docker"), "utf-8");
      assert.match(dockerBody, /SLOPCONTROL_NPM_REGISTRY_DOCKER_URL=http:\/\/host\.docker\.internal:4873\//);
      // .env.docker is NOT gitignored here -> token withheld.
      assert.doesNotMatch(dockerBody, /_TOKEN=/);

      // Idempotent + rotates values in place.
      const second = writeProjectRegistryEnv({
        projectRoot: root,
        meta: { ...meta, authToken: "tok-secret-2" },
      });
      assert.equal(second.files.length, 1); // only .env changed (new token)
      const rotated = readFileSync(join(root, ".env"), "utf-8");
      assert.match(rotated, /TOKEN=tok-secret-2/);
      assert.equal((rotated.match(/SLOPCONTROL_NPM_REGISTRY_URL=/g) ?? []).length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("npmRegistryPackageFreshness flags stale / fresh / unpublished", () => {
    const dataDir = tmp("fresh");
    const proj = tmp("lib");
    try {
      ensureNpmRegistryLayout(dataDir);
      const pkgDir = join(
        dataDir,
        "npm-registry",
        "storage",
        "@jamroast",
        "components",
      );
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify({
          name: "@jamroast/components",
          versions: { "0.0.0": {} },
          "dist-tags": { latest: "0.0.0" },
        }),
        "utf-8",
      );
      const distDir = join(proj, "dist");
      mkdirSync(distDir, { recursive: true });

      // Never-published package → stale.
      const missing = npmRegistryPackageFreshness({
        dataDir,
        name: "@jamroast/nope",
        distDir,
      });
      assert.equal(missing.stale, true);
      assert.match(missing.reason, /not found/);

      // Tarball newer than dist → fresh.
      writeFileSync(join(distDir, "index.js"), "export {};\n", "utf-8");
      const past = new Date(Date.now() - 60_000);
      utimesSync(join(distDir, "index.js"), past, past);
      writeFileSync(join(pkgDir, "components-0.0.0.tgz"), "tarball", "utf-8");
      const fresh = npmRegistryPackageFreshness({
        dataDir,
        name: "@jamroast/components",
        distDir,
      });
      assert.equal(fresh.stale, false);

      // Dist rebuilt after publish → stale.
      writeFileSync(join(distDir, "index.d.ts"), "export {}\n", "utf-8");
      const stale = npmRegistryPackageFreshness({
        dataDir,
        name: "@jamroast/components",
        distDir,
      });
      assert.equal(stale.stale, true);
      assert.match(stale.reason, /newer than the published tarball/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(proj, { recursive: true, force: true });
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
      assert.match(block, /@jamroast:registry=/);
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

describe("consumer propagation", () => {
  it("findRegisteredConsumers scans deps and excludes the library", () => {
    const lib = tmp("lib");
    const consumer = tmp("consumer");
    const devConsumer = tmp("devconsumer");
    const unrelated = tmp("unrelated");
    try {
      for (const [dir, pkg] of [
        [lib, { name: "lib" }],
        [consumer, { name: "a", dependencies: { "@jamroast/components": "0.0.0" } }],
        [devConsumer, { name: "b", devDependencies: { "@jamroast/components": "^0.0.0" } }],
        [unrelated, { name: "c", dependencies: { react: "^19" } }],
      ] as const) {
        writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf-8");
      }
      const consumers = findRegisteredConsumers({
        projects: [
          { id: "lib", name: "jamroast-components", rootPath: lib },
          { id: "a", name: "JamPress", rootPath: consumer },
          { id: "b", name: "crm", rootPath: devConsumer },
          { id: "c", name: "other", rootPath: unrelated },
        ],
        packageName: "@jamroast/components",
        excludeRootPath: lib,
      });
      assert.equal(consumers.length, 2);
      assert.deepEqual(
        consumers.map((c) => c.name).sort(),
        ["JamPress", "crm"],
      );
      const jp = consumers.find((c) => c.name === "JamPress");
      assert.equal(jp?.depSpec, "0.0.0");
    } finally {
      for (const d of [lib, consumer, devConsumer, unrelated]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });

  it("propagateLibraryVersion runs the consumer toolchain consumeUpdateCmd", async () => {
    const consumer: RegisteredConsumer = {
      name: "JamPress",
      rootPath: tmp("propc"),
      depSpec: "0.0.0",
    };
    try {
      const seen: string[][] = [];
      const results = await propagateLibraryVersion({
        consumers: [consumer],
        packageName: "@jamroast/components",
        version: "0.0.1",
        resolveToolchain: () => ({
          kind: "node-pnpm",
          consumeUpdateCmd: ["pnpm", "add", "{dep}"],
          lockfiles: ["pnpm-lock.yaml"],
          registryEnvKeys: [],
        }),
        runner: async (opts) => {
          seen.push(opts.cmd);
          return { code: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
        },
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.ok, true);
      assert.deepEqual(seen[0], ["pnpm", "add", "@jamroast/components@^0.0.1"]);
    } finally {
      rmSync(consumer.rootPath, { recursive: true, force: true });
    }
  });

  it("propagateLibraryVersion reports missing toolchain command", async () => {
    const consumer: RegisteredConsumer = {
      name: "rust-app",
      rootPath: tmp("propr"),
      depSpec: "0.0.0",
    };
    try {
      const results = await propagateLibraryVersion({
        consumers: [consumer],
        packageName: "@jamroast/components",
        version: "0.0.1",
        resolveToolchain: () => null,
      });
      assert.equal(results[0]?.ok, false);
      assert.match(results[0]?.detail ?? "", /project_build_process_configure/);
    } finally {
      rmSync(consumer.rootPath, { recursive: true, force: true });
    }
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
        mockHtml: "<button class='theme-toggle'>x</button>",
        tokensCss: ".theme-toggle{}",
      });
      assert.equal(scaffold.packageName, "@jam/theme-toggle");
      assert.equal(scaffold.packageVersion, "3.0.0");
      const pkg = JSON.parse(
        readFileSync(join(out, "package.json"), "utf-8"),
      ) as { name: string; version: string; exports: Record<string, unknown> };
      assert.equal(pkg.name, "@jam/theme-toggle");
      assert.equal(pkg.version, "3.0.0");
      assert.equal(pkg.exports["./mock.html"], "./mock.html");
      assert.equal(pkg.exports["./tokens.css"], "./tokens.css");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it("scaffoldElementNpmPackage mock-only exports mock.html as main", () => {
    const out = tmp("pkg-mock");
    try {
      const scaffold = scaffoldElementNpmPackage({
        outDir: out,
        elementId: "menubar",
        version: 1,
        srcFiles: {},
        mockHtml: "<header class='menubar'></header>",
      });
      assert.equal(scaffold.packageName, "@jam/menubar");
      const pkg = JSON.parse(
        readFileSync(join(out, "package.json"), "utf-8"),
      ) as { main: string; exports: Record<string, unknown> };
      assert.equal(pkg.main, "mock.html");
      assert.equal(pkg.exports["."], "./mock.html");
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
