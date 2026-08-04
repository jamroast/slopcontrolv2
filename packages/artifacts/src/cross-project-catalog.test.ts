import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildCrossProjectCatalog,
  detectDependencyIntentFromText,
  formatAskDependencyTaskBriefNudge,
  formatCrossProjectCatalogPromptBlock,
  formatDependencyIntentPromptBlock,
  parsePlanDependencyLines,
  resolveDependencyRecommendation,
} from "./cross-project-catalog.js";
import {
  publishDesignElement,
  recordDesignElementNpmPublish,
} from "./design-element.js";
import { ensureNpmRegistryLayout } from "./npm-registry.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-xcat-${name}-`));
}

describe("cross-project-catalog", () => {
  it("builds catalog across two fake projects + registry package storage", () => {
    const parent = tmp("parent");
    const jamroast = join(parent, "burntjam");
    const jampress = join(parent, "basic-web-agent");
    const dataDir = join(parent, "data");
    try {
      mkdirSync(jamroast, { recursive: true });
      mkdirSync(jampress, { recursive: true });
      writeFileSync(
        join(jamroast, "package.json"),
        JSON.stringify({
          name: "@jam/roast-app",
          dependencies: { "@jam/theme-toggle": "1.0.0" },
        }),
      );
      writeFileSync(
        join(jampress, "package.json"),
        JSON.stringify({ name: "@jam/press-app" }),
      );

      const meta = publishDesignElement({
        projectRoot: jamroast,
        elementId: "theme-toggle",
        label: "Theme toggle",
        spec: "# Theme\n",
        mockHtml: "<button class='theme-toggle'>T</button>",
        srcFiles: { "theme-toggle.ts": "export {}\n" },
      });
      recordDesignElementNpmPublish({
        projectRoot: jamroast,
        elementId: "theme-toggle",
        version: meta.version,
        npmPackage: "@jam/theme-toggle",
        npmVersion: "1.0.0",
      });

      ensureNpmRegistryLayout(dataDir);
      const storagePkg = join(
        dataDir,
        "npm-registry",
        "storage",
        "@jam",
        "theme-toggle",
      );
      mkdirSync(storagePkg, { recursive: true });
      writeFileSync(
        join(storagePkg, "package.json"),
        JSON.stringify({
          name: "@jam/theme-toggle",
          versions: { "1.0.0": {} },
          "dist-tags": { latest: "1.0.0" },
        }),
      );

      const catalog = buildCrossProjectCatalog({
        targetRoot: jampress,
        dataDir,
        listProjects: () => [
          { id: "jr", name: "jamroast", rootPath: jamroast },
          { id: "jp", name: "jampress", rootPath: jampress },
        ],
      });

      assert.ok(catalog.elements.some((e) => e.id === "theme-toggle"));
      assert.ok(
        catalog.projects.some(
          (p) => p.name === "jamroast" || p.rootPath === jamroast,
        ),
      );
      assert.ok(
        catalog.npmPackages.some((p) => p.name === "@jam/theme-toggle") ||
          catalog.elements.some((e) => e.npmPackage === "@jam/theme-toggle"),
      );

      const block = formatCrossProjectCatalogPromptBlock(catalog);
      assert.match(block, /CRITICAL/);
      assert.match(block, /npm link/i);
      assert.match(block, /theme-toggle/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("detectDependencyIntentFromText: element from jamroast, npm package, and npm link forbid", () => {
    const el = detectDependencyIntentFromText(
      "use theme-toggle from jamroast",
    );
    assert.equal(el.useElement?.id, "theme-toggle");
    assert.equal(el.useElement?.fromProject, "jamroast");
    assert.equal(el.forbidNpmLink, true);

    const pkg = detectDependencyIntentFromText(
      "please add @jam/theme-toggle@1.0.0",
    );
    assert.equal(pkg.useNpmPackage?.name, "@jam/theme-toggle");
    assert.equal(pkg.useNpmPackage?.version, "1.0.0");

    const link = detectDependencyIntentFromText(
      "just npm link the package from jamroast",
    );
    assert.equal(link.forbidNpmLink, true);
    assert.match(link.notes, /link/i);

    const intentBlock = formatDependencyIntentPromptBlock(el);
    assert.match(intentBlock, /Do NOT recommend/i);
    assert.match(intentBlock, /npm link/i);

    const nudge = formatAskDependencyTaskBriefNudge(el);
    assert.match(nudge, /Element:/);
  });

  it("resolve_dependency recommends ensure_rc + import/pnpm_add, never link", () => {
    const parent = tmp("resolve");
    const jamroast = join(parent, "burntjam");
    const jampress = join(parent, "press");
    try {
      mkdirSync(jamroast, { recursive: true });
      mkdirSync(jampress, { recursive: true });
      const meta = publishDesignElement({
        projectRoot: jamroast,
        elementId: "theme-toggle",
        label: "Theme",
        spec: "#",
        mockHtml: "<button></button>",
      });
      recordDesignElementNpmPublish({
        projectRoot: jamroast,
        elementId: "theme-toggle",
        version: meta.version,
        npmPackage: "@jam/theme-toggle",
        npmVersion: "1.0.0",
      });
      const catalog = buildCrossProjectCatalog({
        targetRoot: jampress,
        listProjects: () => [
          { id: "1", name: "jamroast", rootPath: jamroast },
        ],
      });
      const { recommended } = resolveDependencyRecommendation({
        text: "use theme-toggle from jamroast",
        catalog,
      });
      assert.ok(recommended.some((r) => r.action === "ensure_rc"));
      assert.ok(recommended.some((r) => r.action === "import_element"));
      assert.ok(
        recommended.some(
          (r) =>
            r.action === "pnpm_add" && r.packageName === "@jam/theme-toggle",
        ),
      );
      assert.ok(!recommended.some((r) => /npm link/i.test(r.detail)));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("parsePlanDependencyLines extracts npm and element deps", () => {
    const deps = parsePlanDependencyLines(`
- deps: @jam/theme-toggle@1.0.0 from jamroast
- element:theme-toggle from burntjam
- project: jamroast
`);
    assert.ok(
      deps.some((d) => d.kind === "npm" && d.id === "@jam/theme-toggle"),
    );
    assert.ok(
      deps.some((d) => d.kind === "element" && d.id === "theme-toggle"),
    );
    assert.ok(deps.some((d) => d.kind === "project"));
  });
});
