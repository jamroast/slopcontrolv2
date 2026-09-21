import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  publishDesignElement,
  resolveDesignElement,
  listProjectElements,
  listRegistryElements,
  extractDesignElementFromMock,
  listExtractableDesignElementsFromMock,
  resolveExtractableDesignElement,
  collectSourceFilesForElement,
  importDesignElementIntoLoop,
  readDesignLoopElements,
  formatDesignElementsPromptBlock,
  applyPinnedDesignElementsToMock,
  applyPinnedLogoToMenubarRegion,
  extractConsumerBrandLabel,
  detectPinnedElementDrift,
  detectElementCapabilityGaps,
  unpinDesignElementsFromLoop,
  countExactClassToken,
  extractAndPublishDesignElementFromLoop,
  bindDesignElementsToPhase,
  findBaseLibraryProject,
  recordElementConsumer,
  promoteElementToBaseLibrary,
  recordElementPinAndMaybePromote,
  readDesignElementBundle,
  readDesignElementStyles,
  projectElementsRoot,
  registryElementsRoot,
  syncElementToProjectLibraryPackage,
  removeElementFromProjectLibraryPackage,
  removeDesignElement,
} from "./design-element.js";
import { jamPackageNameForElement } from "./npm-registry.js";
import {
  createDesignLoopMeta,
  readDesignLoopMeta,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import type { DesignLoopMetaWithElements } from "./design-element.js";
import { getDesignLoopSelections } from "./design-loop-selections.js";
import type { DesignLoopMetaWithSelections } from "./design-loop-selections.js";
import { compileDesignPackFromAccept } from "./design-pack.js";
import { detectMockDrift } from "./design-loop-continue.js";
import { CONTINUE_INTENT_DEFAULT } from "./continue-intent.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-el-${name}-`));
}

/** Simulate a Jam-estate project: .npmrc carries the estate scope. */
function tmpJam(name: string): string {
  const root = tmp(name);
  writeFileSync(join(root, ".npmrc"), "@jam:registry=http://127.0.0.1:4873/\n");
  return root;
}

const SAMPLE_MOCK = `<!DOCTYPE html>
<html data-theme="dark">
<head><style>
:root { --background:#0A0A0A; --foreground:#F5F0E8; }
[data-theme="light"] { --background:#FDF8F3; --foreground:#1A1510; }
.theme-toggle { padding: 0.5rem; }
</style></head>
<body>
<header>
<button type="button" class="theme-toggle" aria-label="Toggle theme">Dark / Light</button>
</header>
</body>
</html>`;

describe("design-element publish / resolve", () => {
  it("publishes to project library and bumps versions", () => {
    const root = tmpJam("pub");
    try {
      const v1 = publishDesignElement({
        projectRoot: root,
        elementId: "theme-toggle",
        label: "Theme toggle",
        spec: "# Theme toggle\n",
        mockHtml: SAMPLE_MOCK,
        srcFiles: { "theme-toggle.ts": "export const x = 1;\n" },
        mountHints: ["menubar"],
      });
      assert.equal(v1.version, 1);
      assert.equal(v1.hasCode, true);
      const listed = listProjectElements(root);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, "theme-toggle");

      const v2 = publishDesignElement({
        projectRoot: root,
        elementId: "theme-toggle",
        spec: "# Theme toggle v2\n",
        mockHtml: SAMPLE_MOCK,
      });
      assert.equal(v2.version, 2);
      const bundle = resolveDesignElement({
        elementId: "theme-toggle",
        targetRoot: root,
      });
      assert.ok(bundle);
      assert.equal(bundle!.meta.version, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishes to registry and resolves from another project", () => {
    const dataDir = tmp("data");
    const brand = tmp("brand");
    const app = tmp("app");
    try {
      publishDesignElement({
        projectRoot: brand,
        elementId: "theme-toggle",
        spec: "# Toggle\n",
        mockHtml: SAMPLE_MOCK,
        publishToRegistry: true,
        dataDir,
        sourceProjectId: "brand-1",
      });
      assert.ok(listRegistryElements(dataDir).some((e) => e.id === "theme-toggle"));

      const hit = resolveDesignElement({
        elementId: "theme-toggle",
        targetRoot: app,
        dataDir,
        origin: "registry",
      });
      assert.ok(hit);
      assert.equal(hit!.meta.id, "theme-toggle");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(brand, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("federated resolve finds sibling project library via listProjects", () => {
    const brand = tmp("jamroast");
    const app = tmp("jampress");
    try {
      publishDesignElement({
        projectRoot: brand,
        elementId: "theme-toggle",
        spec: "# Toggle\n",
        mockHtml: SAMPLE_MOCK,
      });
      const hit = resolveDesignElement({
        elementId: "theme-toggle",
        targetRoot: app,
        listProjects: () => [
          { id: "b", name: "JamRoast", rootPath: brand },
          { id: "a", name: "JamPress", rootPath: app },
        ],
      });
      assert.ok(hit);
      assert.equal(hit!.meta.sourceRootPath, brand);
    } finally {
      rmSync(brand, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  });
});

describe("design-element extract / import / pack", () => {
  it("extracts theme-toggle from mock with src scaffold", () => {
    const extracted = extractDesignElementFromMock({
      html: SAMPLE_MOCK,
      brief: "shell theme toggle",
    });
    assert.equal(extracted.elementId, "theme-toggle");
    assert.ok(extracted.mockHtml.includes("theme-toggle"));
    assert.ok(extracted.srcFiles["theme-toggle.ts"]);
    assert.ok(extracted.mountHints.includes("menubar"));
  });

  it("imports into loop, compiles pack elements, binds to phase", () => {
    const root = tmp("loop");
    try {
      const published = publishDesignElement({
        projectRoot: root,
        elementId: "theme-toggle",
        spec: "# Toggle\n",
        mockHtml: SAMPLE_MOCK,
        srcFiles: { "theme-toggle.ts": "export {}\n" },
      });
      const loop = createDesignLoopMeta({
        projectId: "p1",
        brief: "landing",
      });
      writeDesignLoopMeta(root, loop);
      writeDesignLoopVersion({
        projectRoot: root,
        loopId: loop.id,
        version: 1,
        html: SAMPLE_MOCK,
        notes: "ok",
        request: "landing",
        usedScaffold: false,
        parentVersion: null,
      });
      writeDesignLoopMeta(root, {
        ...loop,
        currentVersion: 1,
        status: "open",
        updatedAt: new Date().toISOString(),
      });

      const bundle = resolveDesignElement({
        elementId: "theme-toggle",
        targetRoot: root,
        version: published.version,
      });
      assert.ok(bundle);
      importDesignElementIntoLoop({
        targetRoot: root,
        loopId: loop.id,
        bundle: bundle!,
        origin: "project",
        sourceName: "self",
      });
      const refs = readDesignLoopElements(root, loop.id);
      assert.equal(refs.length, 1);
      assert.match(
        formatDesignElementsPromptBlock(refs, {
          projectRoot: root,
          loopId: loop.id,
        }),
        /SHARED ELEMENTS/,
      );

      const pack = compileDesignPackFromAccept({
        projectRoot: root,
        loopId: loop.id,
        version: 1,
        acceptance: {
          version: 1,
          features: [
            { id: "theme_modes", label: "Theme", accepted: true },
            { id: "palette", label: "Palette", accepted: true },
          ],
        },
      });
      assert.ok(pack.elements?.some((e) => e.id === "theme-toggle"));

      const fresh = readDesignLoopMeta(root, loop.id)!;
      const accepted: DesignLoopMetaWithElements = {
        ...fresh,
        status: "accepted",
        acceptedVersion: 1,
        currentVersion: 1,
        elements: refs,
        updatedAt: new Date().toISOString(),
      };
      writeDesignLoopMeta(root, accepted);

      const bound = bindDesignElementsToPhase({
        projectRoot: root,
        loopId: loop.id,
        phaseId: "01-test",
      });
      assert.equal(bound.length, 1);
      assert.ok(
        existsSync(
          join(
            root,
            ".slopcontrol",
            "phases",
            "01-test",
            "design",
            "elements",
            "theme-toggle",
            `v${published.version}`,
            "mock.html",
          ),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extractAndPublishDesignElementFromLoop writes library entry", () => {
    const root = tmpJam("extract-loop");
    try {
      const loop = createDesignLoopMeta({
        projectId: "p1",
        brief: "theme control",
      });
      writeDesignLoopMeta(root, loop);
      writeDesignLoopVersion({
        projectRoot: root,
        loopId: loop.id,
        version: 1,
        html: SAMPLE_MOCK,
        notes: "",
        request: "theme",
        usedScaffold: false,
        parentVersion: null,
      });
      writeDesignLoopMeta(root, {
        ...loop,
        currentVersion: 1,
        updatedAt: new Date().toISOString(),
      });
      const meta = extractAndPublishDesignElementFromLoop({
        projectRoot: root,
        loopId: loop.id,
        elementId: "theme-toggle",
      });
      assert.equal(meta.id, "theme-toggle");
      assert.ok(listProjectElements(root).length >= 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("listExtractableDesignElementsFromMock", () => {
  const RICH_MOCK = `<!DOCTYPE html>
<html data-theme="dark">
<head><style>
.menubar { display:flex; }
.menubar__logo-mark { width:2rem; }
.dashboard-layout { display:grid; }
.dashboard-sidebar { width:14rem; }
</style></head>
<body>
<header class="menubar" id="menubar-landing">
  <div class="menubar__inner">
    <div class="menubar__left">
      <a href="#" class="menubar__logo">
        <div class="menubar__logo-mark">JR</div>
      </a>
      <nav class="menubar-nav"><a href="/">Home</a></nav>
    </div>
    <div class="menubar__right">
      <div class="user-pill">Ada</div>
      <button type="button" class="theme-toggle" aria-label="Toggle theme">Dark / Light</button>
      <a href="#signin" class="menubar__nav-link">Sign In</a>
    </div>
  </div>
</header>
<div class="dashboard-layout" id="dashboard">
  <aside class="dashboard-sidebar">
    <div class="section-label">Dashboard Sidebar</div>
    <a href="/dash">Dash</a>
  </aside>
  <main class="dashboard-main"><p>Content</p></main>
</div>
<div data-element="promo-banner" class="promo">Hello</div>
</body>
</html>`;

/** Mock with chrome nav link + element comment + generic __stage preview. */
const ELEMENT_COMMENT_MOCK = `<!DOCTYPE html><html><head><style>
.auth-btn { padding: 0.5rem; border: 1px solid #ccc; }
.auth-btn--primary { background: #06c; color: #fff; }
.auth-btn__icon { width: 1rem; }
.account-chip { display: flex; gap: 0.5rem; }
.account-chip__name { font-weight: 600; }
.__nav-link { font-size: 0.875rem; }
</style></head><body>
<nav class="topbar">
  <a href="#auth" class="topbar__nav-link">Sign In</a>
</nav>
<main>
  <!-- component: AuthBtn -->
  <section class="preview">
    <div class="preview__stage">
      <button class="auth-btn" type="button">Sign In</button>
      <button class="auth-btn auth-btn--primary" type="button">Sign In</button>
    </div>
  </section>
  <!-- element: account-chip -->
  <section class="preview">
    <div class="preview__stage">
      <div class="account-chip"><span class="account-chip__name">Ada Lovelace</span></div>
    </div>
  </section>
</main>
</body></html>`;

  it("lists known chrome and data-element markers", () => {
    const listed = listExtractableDesignElementsFromMock(RICH_MOCK, {
      publishedIds: ["theme-toggle"],
    });
    const ids = listed.map((c) => c.id);
    assert.ok(ids.includes("theme-toggle"));
    assert.ok(ids.includes("menubar"));
    assert.ok(ids.includes("user-pill"));
    assert.ok(ids.includes("dashboard-sidebar"));
    assert.ok(ids.includes("dashboard-shell"));
    assert.ok(ids.includes("sign-in"));
    assert.ok(ids.includes("promo-banner"));
    const theme = listed.find((c) => c.id === "theme-toggle");
    assert.equal(theme?.alreadyPublished, true);
    assert.equal(
      listed.find((c) => c.id === "menubar")?.alreadyPublished,
      false,
    );
    assert.equal(
      listed.find((c) => c.id === "menubar")?.npmPackage,
      // No projectRoot → built-in default scope.
      "@slopcontrol/menubar",
    );
  });

  it("balanced menubar includes nested logo and Sign In", () => {
    const region = resolveExtractableDesignElement(RICH_MOCK, "menubar");
    assert.ok(region);
    assert.match(region!.html, /menubar__logo-mark/);
    assert.match(region!.html, /Sign In/);
    assert.match(region!.html, /theme-toggle/);
    assert.ok(region!.html.includes("</header>"));
  });

  it("balanced dashboard-shell includes nested sidebar", () => {
    const region = resolveExtractableDesignElement(RICH_MOCK, "dashboard-shell");
    assert.ok(region);
    assert.match(region!.html, /dashboard-sidebar/);
    assert.match(region!.html, /dashboard-main/);
    assert.match(region!.html, /Content/);
  });

  it("sign-in is a single complete control", () => {
    const region = resolveExtractableDesignElement(RICH_MOCK, "sign-in");
    assert.ok(region);
    assert.match(region!.html, /^<a\b/i);
    assert.match(region!.html, /Sign In/);
    assert.ok(!region!.html.includes("Pricing"));
  });

  it("element comment + __stage extracts full preview, not chrome nav link", () => {
    const region = resolveExtractableDesignElement(
      ELEMENT_COMMENT_MOCK,
      "auth-btn",
    );
    assert.ok(region);
    assert.match(region!.html, /preview__stage|auth-btn-variants/);
    assert.match(region!.html, /auth-btn--primary/);
    assert.ok(!/topbar__nav-link/.test(region!.html));
    const listed = listExtractableDesignElementsFromMock(ELEMENT_COMMENT_MOCK);
    assert.ok(listed.some((c) => c.id === "account-chip"));
    const chip = resolveExtractableDesignElement(
      ELEMENT_COMMENT_MOCK,
      "account-chip",
    );
    assert.ok(chip);
    assert.match(chip!.html, /account-chip/);
    assert.match(chip!.html, /account-chip__name/);
  });

  it("extract uses listed elementId (menubar, not theme-toggle default)", () => {
    const extracted = extractDesignElementFromMock({
      html: RICH_MOCK,
      elementId: "menubar",
      projectRoot: tmpJam("extract-listed"),
    });
    assert.equal(extracted.elementId, "menubar");
    assert.equal(extracted.label, "Menubar / top navigation");
    assert.equal(extracted.npmPackage, "@jam/menubar");
    assert.match(extracted.mockHtml, /class="menubar"/);
    assert.match(extracted.mockHtml, /menubar__logo-mark/);
    assert.match(extracted.mockHtml, /Sign In/);
  });

  const BEM_REGION_MOCK = `<!DOCTYPE html>
<html data-theme="dark">
<head><style>
:root { --background:#0A0A0A; --foreground:#F5F0E8; --accent:#D97A4A; }
[data-theme="light"] { --background:#FDF8F3; }
.env-pane { width: 320px; border-left: 1px solid var(--accent); }
.env-pane__title { font-size: 0.75rem; text-transform: uppercase; }
.card { background: color-mix(in oklab, var(--foreground) 4%, transparent); border-radius: 0.75rem; }
.secret-row { display: flex; justify-content: space-between; }
.unrelated { color: red; }
</style></head>
<body>
<aside data-element="application-environment-properties" class="env-pane">
  <h3 class="env-pane__title">Environment</h3>
  <div class="card">
    <div class="secret-row"><span>API_KEY</span><span>***</span></div>
  </div>
</aside>
<div class="unrelated">Outside region</div>
</body>
</html>`;

  it("harvests region markup classes into componentCss (BEM, not id-slug)", () => {
    const extracted = extractDesignElementFromMock({
      html: BEM_REGION_MOCK,
      elementId: "application-environment-properties",
    });
    assert.equal(extracted.elementId, "application-environment-properties");
    // Component rules carried even though class names don't match the id slug.
    assert.match(extracted.componentCss, /\.env-pane\s*\{/);
    assert.match(extracted.componentCss, /\.env-pane__title/);
    assert.match(extracted.componentCss, /\.card\s*\{/);
    assert.match(extracted.componentCss, /\.secret-row\s*\{/);
    // Rules for classes outside the region are not harvested.
    assert.doesNotMatch(extracted.componentCss, /\.unrelated\b/);
    // tokensCss keeps the token ladders alongside the component rules.
    assert.match(extracted.tokensCss, /:root\s*\{/);
    assert.match(extracted.tokensCss, /\.env-pane\s*\{/);
  });

  it("keeps id-slug harvesting for theme-toggle fallback", () => {
    const extracted = extractDesignElementFromMock({
      html: SAMPLE_MOCK,
      brief: "shell theme toggle",
    });
    assert.equal(extracted.elementId, "theme-toggle");
    assert.match(extracted.componentCss, /\.theme-toggle\s*\{/);
  });

  it("publish persists componentCss as styles.css with hasStyles meta", () => {
    const root = tmpJam("extract-styles");
    try {
      const loop = createDesignLoopMeta({ projectId: "p1", brief: "env pane" });
      writeDesignLoopMeta(root, loop);
      writeDesignLoopVersion({
        projectRoot: root,
        loopId: loop.id,
        version: 1,
        html: BEM_REGION_MOCK,
        notes: "",
        request: "env pane",
        usedScaffold: false,
        parentVersion: null,
      });
      writeDesignLoopMeta(root, {
        ...loop,
        currentVersion: 1,
        updatedAt: new Date().toISOString(),
      });
      const meta = extractAndPublishDesignElementFromLoop({
        projectRoot: root,
        loopId: loop.id,
        elementId: "application-environment-properties",
      });
      assert.equal(meta.hasStyles, true);
      const stylesPath = join(
        projectElementsRoot(root),
        "application-environment-properties",
        `v${meta.version}`,
        "styles.css",
      );
      assert.ok(existsSync(stylesPath));
      const css = readFileSync(stylesPath, "utf-8");
      assert.match(css, /\.env-pane\s*\{/);
      assert.match(css, /\.card\s*\{/);
      assert.equal(
        listProjectElements(root).find((e) => e.id === meta.id)?.hasStyles,
        true,
      );
      assert.match(
        readDesignElementStyles({ projectRoot: root, elementId: meta.id }) ??
          "",
        /\.secret-row\s*\{/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown explicit elementId", () => {
    assert.throws(
      () =>
        extractDesignElementFromMock({
          html: RICH_MOCK,
          elementId: "does-not-exist",
        }),
      /No extractable element/,
    );
  });

  it("copies project source into src and scaffolds @jam package", () => {
    const root = tmpJam("src-menubar");
    try {
      const srcPath = join(
        root,
        "src",
        "components",
        "shell",
        "menubar.tsx",
      );
      mkdirSync(join(srcPath, ".."), { recursive: true });
      writeFileSync(
        srcPath,
        `export function Menubar() { return <header className="menubar" />; }\n`,
        "utf-8",
      );
      const collected = collectSourceFilesForElement(root, "menubar");
      assert.ok(collected.sourcePaths.includes("src/components/shell/menubar.tsx"));
      assert.ok(collected.srcFiles["components/shell/menubar.tsx"]);

      const loop = createDesignLoopMeta({
        projectId: "p1",
        brief: "shell",
      });
      writeDesignLoopMeta(root, loop);
      writeDesignLoopVersion({
        projectRoot: root,
        loopId: loop.id,
        version: 1,
        html: RICH_MOCK,
        notes: "",
        request: "menubar",
        usedScaffold: false,
        parentVersion: null,
      });
      writeDesignLoopMeta(root, {
        ...loop,
        currentVersion: 1,
        updatedAt: new Date().toISOString(),
      });
      const meta = extractAndPublishDesignElementFromLoop({
        projectRoot: root,
        loopId: loop.id,
        elementId: "menubar",
      });
      assert.equal(meta.id, "menubar");
      assert.equal(meta.hasCode, true);
      assert.equal(jamPackageNameForElement(meta.id, "@jam"), "@jam/menubar");
      const pkgPath = join(
        root,
        ".slopcontrol",
        "elements",
        "menubar",
        "v1",
        "npm-package",
        "package.json",
      );
      assert.ok(existsSync(pkgPath));
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name: string;
        exports: Record<string, unknown>;
      };
      assert.equal(pkg.name, "@jam/menubar");
      assert.ok(
        existsSync(
          join(
            root,
            ".slopcontrol",
            "elements",
            "menubar",
            "v1",
            "src",
            "components",
            "shell",
            "menubar.tsx",
          ),
        ),
      );
      assert.ok(existsSync(
        join(root, ".slopcontrol", "elements", "menubar", "v1", "npm-package", "mock.html"),
      ));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("discovers source for an element not in the hardcoded map (slug fallback)", () => {
    const root = tmpJam("src-sign-in");
    try {
      const srcPath = join(root, "src", "components", "shell", "sign-in.tsx");
      mkdirSync(join(srcPath, ".."), { recursive: true });
      writeFileSync(
        srcPath,
        `export function SignIn() { return <button>Sign In</button>; }\n`,
        "utf-8",
      );
      const collected = collectSourceFilesForElement(root, "sign-in");
      assert.ok(
        collected.sourcePaths.includes("src/components/shell/sign-in.tsx"),
      );
      assert.ok(collected.srcFiles["components/shell/sign-in.tsx"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("mock-only element still gets npm-package with mock export", () => {
    const root = tmpJam("mock-only");
    try {
      const meta = publishDesignElement({
        projectRoot: root,
        elementId: "sign-in",
        label: "Sign-in control",
        kind: "control",
        spec: "# Sign in\n",
        mockHtml: "<a href='#signin'>Sign In</a>",
      });
      assert.equal(meta.hasCode, false);
      const pkgPath = join(
        root,
        ".slopcontrol",
        "elements",
        "sign-in",
        `v${meta.version}`,
        "npm-package",
        "package.json",
      );
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
        name: string;
        exports: Record<string, unknown>;
        main: string;
      };
      assert.equal(pkg.name, "@jam/sign-in");
      assert.equal(pkg.main, "mock.html");
      assert.equal(pkg.exports["./mock.html"], "./mock.html");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("applyPinnedDesignElementsToMock + prompt block", () => {
  it("replaces landing-header with menubar and rewrites logo", () => {
    const root = tmp("apply-menubar");
    try {
      const menubarMock = `<!DOCTYPE html><html><body>
<header class="menubar"><div class="menubar__inner">
  <a href="#" class="menubar__logo"><img src="old.png" alt="JR"/><span class="menubar__logo-text">JamRoast</span></a>
  <button class="theme-toggle">Dark / Light</button>
  <a href="#signin">Sign In</a>
</div></header>
</body></html>`;
      publishDesignElement({
        projectRoot: root,
        elementId: "menubar",
        kind: "shell",
        label: "Menubar",
        spec: "# Menubar\n",
        mockHtml: menubarMock,
        tokensCss: ".menubar { display: flex; }",
      });
      const loop = createDesignLoopMeta({ projectId: "p1", brief: "x" });
      writeDesignLoopMeta(root, loop);
      const bundle = resolveDesignElement({
        elementId: "menubar",
        targetRoot: root,
      });
      assert.ok(bundle);
      const ref = importDesignElementIntoLoop({
        targetRoot: root,
        loopId: loop.id,
        bundle: bundle!,
        origin: "project",
        sourceName: "jamroast-components",
      });

      const consumer = `<!DOCTYPE html><html><head><style>body{}</style></head><body>
<header class="landing-header"><div class="landing-header-inner">
  <a class="logo-link"><img src="jampress.png" alt="JamPress"/> JamPress</a>
  <nav><ul class="nav-list"><li>Home</li></ul></nav>
</div></header>
<main><h1>Hero</h1></main>
</body></html>`;

      const logoSrc =
        `.slopcontrol/design-loops/${loop.id}/assets/jampress-logo.png`;
      const out = applyPinnedDesignElementsToMock({
        html: consumer,
        elements: [ref],
        projectRoot: root,
        pinnedLogoSrc: logoSrc,
        brandName: "JamPress",
      });
      assert.match(out, /class="menubar"/);
      assert.ok(!/landing-header/.test(out));
      assert.ok(!/menubar__logo-mark/.test(out));
      assert.match(out, new RegExp(logoSrc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(out, /menubar__logo-text/);
      assert.match(out, />JamPress</);
      assert.ok(!/JamRoast/.test(out));
      assert.match(out, /theme-toggle/);
      assert.match(out, /\.menubar\s*\{/);
      assert.ok(!/\.dashboard-layout/.test(out));

      const block = formatDesignElementsPromptBlock([ref], {
        projectRoot: root,
        loopId: loop.id,
      });
      assert.match(block, /menubar/);
      assert.match(block, /class="menubar"/);
      assert.match(block, /menubar__logo-text/);
      assert.ok(!/theme-toggle-biased/.test(block));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps product name next to pinned logo (does not strip logo-text)", () => {
    const region = `<header class="menubar"><a href="#" class="menubar__logo"><div class="menubar__logo-mark">JR</div><span class="menubar__logo-text">JamRoast</span></a></header>`;
    const out = applyPinnedLogoToMenubarRegion(
      region,
      "assets/jampress.png",
      "JamPress",
    );
    assert.ok(!/menubar__logo-mark/.test(out));
    assert.match(out, /assets\/jampress\.png/);
    assert.match(out, /<span class="menubar__logo-text">JamPress<\/span>/);
    assert.equal(extractConsumerBrandLabel(out), "JamPress");
  });

  it("injects logo-text when pinned logo applied to image-only menubar", () => {
    const region = `<header class="menubar"><a href="#" class="menubar__logo"></a></header>`;
    const out = applyPinnedLogoToMenubarRegion(
      region,
      "assets/logo.png",
      "Acme",
    );
    assert.match(out, /menubar__logo-img/);
    assert.match(out, /<span class="menubar__logo-text">Acme<\/span>/);
  });

  it("does not inject dashboard CSS into landing mocks", () => {
    const root = tmp("no-dash-css");
    try {
      publishDesignElement({
        projectRoot: root,
        elementId: "menubar",
        kind: "shell",
        label: "Menubar",
        spec: "#",
        mockHtml:
          "<header class='menubar'><button class='theme-toggle'>T</button></header>",
        tokensCss: ".menubar{display:flex}",
      });
      publishDesignElement({
        projectRoot: root,
        elementId: "dashboard-shell",
        kind: "shell",
        label: "Dash",
        spec: "#",
        mockHtml: "<div class='dashboard-layout'></div>",
        tokensCss: ".dashboard-layout{display:flex;min-height:100vh}",
      });
      const loop = createDesignLoopMeta({ projectId: "p1", brief: "x" });
      writeDesignLoopMeta(root, loop);
      const refs = ["menubar", "dashboard-shell"].map((id) => {
        const bundle = resolveDesignElement({ elementId: id, targetRoot: root });
        return importDesignElementIntoLoop({
          targetRoot: root,
          loopId: loop.id,
          bundle: bundle!,
          origin: "project",
        });
      });
      const out = applyPinnedDesignElementsToMock({
        html: `<!DOCTYPE html><html><head><style>body{}</style></head><body>
<header class="landing-header">Old</header><main>Hi</main></body></html>`,
        elements: refs,
        projectRoot: root,
      });
      assert.match(out, /menubar/);
      assert.ok(!/\.dashboard-layout/.test(out));
      assert.ok(!/min-height:\s*100vh/.test(out));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies dashboard-shell/sidebar when includeDashboard forces a dashboard surface", () => {
    const root = tmp("force-dash");
    try {
      publishDesignElement({
        projectRoot: root,
        elementId: "dashboard-shell",
        kind: "shell",
        label: "Dashboard shell",
        spec: "#",
        mockHtml: "<div class='dashboard-layout'><main></main></div>",
        tokensCss: ".dashboard-layout{display:flex;min-height:100vh}",
      });
      publishDesignElement({
        projectRoot: root,
        elementId: "dashboard-sidebar",
        kind: "shell",
        label: "Dashboard sidebar",
        spec: "#",
        mockHtml: "<nav class='dashboard-sidebar'></nav>",
        tokensCss: ".dashboard-sidebar{width:288px}",
      });
      const loop = createDesignLoopMeta({ projectId: "p1", brief: "x" });
      writeDesignLoopMeta(root, loop);
      const refs = ["dashboard-shell", "dashboard-sidebar"].map((id) => {
        const bundle = resolveDesignElement({ elementId: id, targetRoot: root });
        return importDesignElementIntoLoop({
          targetRoot: root,
          loopId: loop.id,
          bundle: bundle!,
          origin: "project",
        });
      });
      // Sections-only consumer mock — no dashboard-* class token of its own.
      const out = applyPinnedDesignElementsToMock({
        html: `<!DOCTYPE html><html><head><style>body{}</style></head><body>
<main><h1>Management dashboard</h1><section>rows</section></main></body></html>`,
        elements: refs,
        projectRoot: root,
        includeDashboard: true,
      });
      assert.match(out, /dashboard-layout/);
      assert.match(out, /dashboard-sidebar/);
      assert.match(out, /\.dashboard-layout\s*\{/);
      assert.match(out, /\.dashboard-sidebar\s*\{/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("design-element drift", () => {
  it("detectPinnedElementDrift flags multiple theme toggles", () => {
    const html = `
      <button class="theme-toggle">A</button>
      <button class="theme-toggle">B</button>
    `;
    const issues = detectPinnedElementDrift({
      html,
      elements: [
        {
          id: "theme-toggle",
          version: 1,
          origin: "project",
          mountHints: [],
          hasCode: false,
        },
      ],
    });
    assert.ok(issues.some((i) => i.code === "element_invented"));
  });

  it("detectPinnedElementDrift allows a single toggle inside menubar", () => {
    const html = `
      <header class="menubar">
        <button class="theme-toggle">Dark / Light</button>
      </header>
      <main>ok</main>
    `;
    const issues = detectPinnedElementDrift({
      html,
      elements: [
        {
          id: "theme-toggle",
          version: 1,
          origin: "project",
          mountHints: [],
          hasCode: false,
        },
        {
          id: "menubar",
          version: 1,
          origin: "project",
          mountHints: [],
          hasCode: false,
        },
      ],
    });
    assert.equal(issues.length, 0);
  });

  it("detectMockDrift soft-flags competing toggles when element pinned (not hard)", () => {
    const prev = SAMPLE_MOCK;
    const next = SAMPLE_MOCK.replace(
      "</header>",
      `<button class="theme-toggle">Also</button></header>`,
    );
    const drift = detectMockDrift({
      previousHtml: prev,
      nextHtml: next,
      intent: { ...CONTINUE_INTENT_DEFAULT, scope: "sections" },
      pinnedElements: [{ id: "theme-toggle" }],
    });
    assert.ok(drift.some((d) => d.code === "element_invented"));
    assert.ok(drift.every((d) => d.code !== "element_invented" || d.severity === "soft"));
  });

  it("countExactClassToken ignores BEM children", () => {
    const html = `<button class="theme-toggle"><svg class="theme-toggle__sun"></svg><svg class="theme-toggle__moon"></svg></button>`;
    assert.equal(countExactClassToken(html, "theme-toggle"), 1);
  });

  it("unpinDesignElementsFromLoop removes dashboard pins and matching selections", () => {
    const root = tmp("unpin");
    try {
      const meta = createDesignLoopMeta({
        projectId: "p",
        brief: "b",
      });
      writeDesignLoopMeta(root, meta);
      const loopId = meta.id;
      const dashDir = join(
        root,
        ".slopcontrol",
        "design-loops",
        loopId,
        "elements",
        "dashboard-shell",
        "v1",
      );
      mkdirSync(dashDir, { recursive: true });
      writeFileSync(join(dashDir, "mock.html"), "<div></div>\n");
      writeDesignLoopMeta(root, {
        ...meta,
        elements: [
          {
            id: "menubar",
            version: 1,
            origin: "project",
            mountHints: [],
            hasCode: false,
          },
          {
            id: "dashboard-shell",
            version: 1,
            origin: "project",
            mountHints: [],
            hasCode: false,
            mockPath: `.slopcontrol/design-loops/${loopId}/elements/dashboard-shell/v1/mock.html`,
          },
        ],
        selections: [
          {
            slot: "logo",
            conceptId: "jampress-logo",
            asset: "logo.png",
            pinnedAt: new Date().toISOString(),
          },
          {
            slot: "element",
            conceptId: "dashboard-shell-2",
            label: "Dashboard shell",
            pinnedAt: new Date().toISOString(),
          },
          {
            slot: "element",
            conceptId: "dashboard-sidebar-2",
            label: "Dashboard sidebar",
            pinnedAt: new Date().toISOString(),
          },
          {
            slot: "element",
            conceptId: "menubar-2",
            label: "Menubar",
            pinnedAt: new Date().toISOString(),
          },
        ],
      } as DesignLoopMetaWithElements & DesignLoopMetaWithSelections);
      const kept = unpinDesignElementsFromLoop({
        projectRoot: root,
        loopId,
        elementIds: ["dashboard-shell", "dashboard-sidebar"],
      });
      assert.ok(kept.every((e) => e.id !== "dashboard-shell"));
      assert.ok(kept.some((e) => e.id === "menubar"));
      assert.ok(
        !existsSync(
          join(
            root,
            ".slopcontrol",
            "design-loops",
            loopId,
            "elements",
            "dashboard-shell",
          ),
        ),
      );
      const sels = getDesignLoopSelections(readDesignLoopMeta(root, loopId));
      assert.ok(!sels.some((s) => s.conceptId.startsWith("dashboard-shell")));
      assert.ok(!sels.some((s) => s.conceptId.startsWith("dashboard-sidebar")));
      assert.ok(sels.some((s) => s.conceptId === "menubar-2"));
      assert.ok(sels.some((s) => s.slot === "logo"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectElementCapabilityGaps flags a nested mock vs a flat pinned shell element", () => {
    const root = tmp("cap-gap");
    try {
      const loop = createDesignLoopMeta({ projectId: "p", brief: "b" });
      writeDesignLoopMeta(root, loop);
      const elDir = join(
        root,
        ".slopcontrol",
        "design-loops",
        loop.id,
        "elements",
        "dashboard-sidebar",
        "v2",
      );
      mkdirSync(elDir, { recursive: true });
      writeFileSync(
        join(elDir, "mock.html"),
        '<html><body><aside class="dashboard-sidebar"><a href="#">Home</a><a href="#">Chat</a></aside></body></html>\n',
      );
      const ref = {
        id: "dashboard-sidebar",
        version: 2,
        origin: "project" as const,
        kind: "shell" as const,
        mockPath: `.slopcontrol/design-loops/${loop.id}/elements/dashboard-sidebar/v2/mock.html`,
        mountHints: [],
        hasCode: false,
      };
      const nestedMock =
        '<html><body><div class="shell"><aside class="sidebar"><details><summary>Applications</summary><ul><li>App A</li></ul></details></aside></div></body></html>';
      const gaps = detectElementCapabilityGaps({
        html: nestedMock,
        elements: [ref],
        projectRoot: root,
      });
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]!.elementId, "dashboard-sidebar");
      assert.match(gaps[0]!.missingCapability, /nested|collapsible/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectElementCapabilityGaps reports no gap for a flat mock", () => {
    const root = tmp("cap-gap-none");
    try {
      const loop = createDesignLoopMeta({ projectId: "p", brief: "b" });
      writeDesignLoopMeta(root, loop);
      const elDir = join(
        root,
        ".slopcontrol",
        "design-loops",
        loop.id,
        "elements",
        "dashboard-sidebar",
        "v2",
      );
      mkdirSync(elDir, { recursive: true });
      writeFileSync(
        join(elDir, "mock.html"),
        '<html><body><aside class="dashboard-sidebar"><a href="#">Home</a></aside></body></html>\n',
      );
      const ref = {
        id: "dashboard-sidebar",
        version: 2,
        origin: "project" as const,
        kind: "shell" as const,
        mockPath: `.slopcontrol/design-loops/${loop.id}/elements/dashboard-sidebar/v2/mock.html`,
        mountHints: [],
        hasCode: false,
      };
      const flatMock =
        '<html><body><div class="shell"><aside class="sidebar"><a href="#">Home</a><a href="#">Chat</a></aside></div></body></html>';
      const gaps = detectElementCapabilityGaps({
        html: flatMock,
        elements: [ref],
        projectRoot: root,
      });
      assert.equal(gaps.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectElementCapabilityGaps marks a compose sub-element (even when pinned) instead of evolving the shell", () => {
    const root = tmp("cap-gap-compose");
    try {
      const loop = createDesignLoopMeta({ projectId: "p", brief: "b" });
      writeDesignLoopMeta(root, loop);
      const elDir = join(
        root,
        ".slopcontrol",
        "design-loops",
        loop.id,
        "elements",
        "dashboard-sidebar",
        "v2",
      );
      mkdirSync(elDir, { recursive: true });
      writeFileSync(
        join(elDir, "mock.html"),
        '<html><body><aside class="dashboard-sidebar"><a href="#">Home</a></aside></body></html>\n',
      );
      const ref = {
        id: "dashboard-sidebar",
        version: 2,
        origin: "project" as const,
        kind: "shell" as const,
        mockPath: `.slopcontrol/design-loops/${loop.id}/elements/dashboard-sidebar/v2/mock.html`,
        mountHints: [],
        hasCode: false,
      };
      const navRef = {
        id: "application-navigation",
        version: 1,
        origin: "project" as const,
        kind: "control" as const,
        mockPath: `.slopcontrol/design-loops/${loop.id}/elements/application-navigation/v1/mock.html`,
        mountHints: [],
        hasCode: true,
      };
      const composeMock =
        '<html><body><aside class="dashboard-sidebar" data-element="dashboard-sidebar"><div data-element="application-navigation"><details><summary>Applications</summary><ul><li>App A</li></ul></details></div></aside></body></html>';
      const gaps = detectElementCapabilityGaps({
        html: composeMock,
        elements: [ref, navRef],
        projectRoot: root,
      });
      assert.equal(gaps.length, 1);
      assert.equal(gaps[0]!.elementId, "dashboard-sidebar");
      assert.equal(gaps[0]!.composeWith, "application-navigation");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("design-element estate promotion", () => {
  function makeBaseLib(name: string): string {
    const root = tmp(name);
    mkdirSync(join(root, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(root, ".slopcontrol", "config.json"),
      JSON.stringify({ componentLibrary: true }),
    );
    return root;
  }

  it("findBaseLibraryProject returns the componentLibrary:true project", () => {
    const app = tmp("base-app");
    const lib = makeBaseLib("base-lib");
    try {
      const found = findBaseLibraryProject({
        listProjects: () => [
          { id: "app", name: "app", rootPath: app },
          { id: "lib", name: "lib", rootPath: lib },
        ],
      });
      assert.ok(found);
      assert.equal(found.id, "lib");
      assert.equal(findBaseLibraryProject({ listProjects: () => [] }), null);
    } finally {
      rmSync(app, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("recordElementConsumer dedupes repeated pins by the same project", () => {
    const dataDir = tmp("cons-data");
    const app = tmp("cons-app");
    try {
      const meta = publishDesignElement({
        projectRoot: app,
        elementId: "menubar",
        kind: "shell",
        label: "Menubar",
        spec: "top nav",
        mockHtml: "<header class='menubar'></header>",
        publishToRegistry: true,
        dataDir,
        sourceProjectId: "app",
      });
      const first = recordElementConsumer({
        dataDir,
        elementId: "menubar",
        version: meta.version,
        consumerProjectId: "b",
      });
      const second = recordElementConsumer({
        dataDir,
        elementId: "menubar",
        version: meta.version,
        consumerProjectId: "b",
      });
      assert.deepEqual(first, ["b"]);
      assert.deepEqual(second, ["b"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
    }
  });

  it("promotes an element to the base library when a second project pins it", () => {
    const dataDir = tmp("promote-data");
    const app = tmp("promote-app");
    const lib = makeBaseLib("promote-lib");
    try {
      const meta = publishDesignElement({
        projectRoot: app,
        elementId: "dashboard-sidebar",
        kind: "shell",
        label: "Dashboard sidebar",
        spec: "nested sidebar",
        mockHtml: "<aside class='sidebar'></aside>",
        srcFiles: { "index.tsx": "export const Sidebar = () => null;" },
        publishToRegistry: true,
        dataDir,
        sourceProjectId: "app",
      });

      const res = recordElementPinAndMaybePromote({
        dataDir,
        elementId: "dashboard-sidebar",
        version: meta.version,
        consumerProjectId: "other",
        listProjects: () => [
          { id: "app", name: "app", rootPath: app },
          { id: "lib", name: "lib", rootPath: lib },
        ],
      });
      assert.equal(res.promoted, true);
      assert.equal(res.promotedTo, "lib");

      const baseBundle = readDesignElementBundle(
        projectElementsRoot(lib),
        "dashboard-sidebar",
        meta.version,
      );
      assert.ok(baseBundle);
      assert.equal(baseBundle.meta.sourceProjectId, "lib");
      assert.ok(baseBundle.srcFiles["index.tsx"]);

      const regBundle = readDesignElementBundle(
        registryElementsRoot(dataDir),
        "dashboard-sidebar",
        meta.version,
      );
      assert.ok(regBundle);
      assert.equal(regBundle.meta.sourceProjectId, "lib");
      assert.ok(regBundle.meta.consumers.includes("other"));
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("does not promote when only the source project consumes the element", () => {
    const dataDir = tmp("no-promote-data");
    const app = tmp("no-promote-app");
    const lib = makeBaseLib("no-promote-lib");
    try {
      const meta = publishDesignElement({
        projectRoot: app,
        elementId: "theme-toggle",
        kind: "control",
        label: "Theme toggle",
        spec: "toggle",
        mockHtml: "<button class='theme-toggle'></button>",
        publishToRegistry: true,
        dataDir,
        sourceProjectId: "app",
      });
      const res = recordElementPinAndMaybePromote({
        dataDir,
        elementId: "theme-toggle",
        version: meta.version,
        consumerProjectId: "app",
        listProjects: () => [
          { id: "app", name: "app", rootPath: app },
          { id: "lib", name: "lib", rootPath: lib },
        ],
      });
      assert.equal(res.promoted, false);
      assert.equal(
        readDesignElementBundle(
          projectElementsRoot(lib),
          "theme-toggle",
          meta.version,
        ),
        null,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(app, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it("does not re-promote an element already owned by the base library", () => {
    const dataDir = tmp("already-base-data");
    const lib = makeBaseLib("already-base-lib");
    try {
      const meta = publishDesignElement({
        projectRoot: lib,
        elementId: "sign-in",
        kind: "control",
        label: "Sign In",
        spec: "sign-in form",
        mockHtml: "<form class='sign-in'></form>",
        publishToRegistry: true,
        dataDir,
        sourceProjectId: "lib",
      });
      const res = recordElementPinAndMaybePromote({
        dataDir,
        elementId: "sign-in",
        version: meta.version,
        consumerProjectId: "other",
        listProjects: () => [{ id: "lib", name: "lib", rootPath: lib }],
      });
      assert.equal(res.promoted, false);
      const regBundle = readDesignElementBundle(
        registryElementsRoot(dataDir),
        "sign-in",
        meta.version,
      );
      assert.ok(regBundle);
      assert.equal(regBundle.meta.sourceProjectId, "lib");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(lib, { recursive: true, force: true });
    }
  });
});

describe("project element-library package sync", () => {
  function makeAppWithLibrary(name: string): {
    root: string;
    pkgDir: string;
  } {
    const root = tmp(name);
    mkdirSync(join(root, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(root, ".slopcontrol", "config.json"),
      JSON.stringify({ elementLibraryPackagePath: "packages/app-components" }),
    );
    const pkgDir = join(root, "packages", "app-components");
    mkdirSync(join(pkgDir, "src", "components"), { recursive: true });
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "@x/app-components", version: "0.0.1" }),
    );
    return { root, pkgDir };
  }

  it("syncs a single-file element flat + regenerates the barrel", () => {
    const { root, pkgDir } = makeAppWithLibrary("sync-flat");
    try {
      const res = syncElementToProjectLibraryPackage({
        projectRoot: root,
        elementId: "application-navigation",
        srcFiles: {
          "application-navigation.tsx":
            "export const ApplicationNavigation = () => null;",
        },
      });
      assert.equal(res.synced, true);
      assert.equal(res.packagePath, "packages/app-components");
      assert.ok(
        existsSync(
          join(pkgDir, "src", "components", "application-navigation.tsx"),
        ),
      );
      const barrel = readFileSync(
        join(pkgDir, "src", "components", "index.ts"),
        "utf-8",
      );
      assert.match(barrel, /export \* from "\.\/application-navigation";/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("syncs a multi-file element into a directory with an inner barrel", () => {
    const { root, pkgDir } = makeAppWithLibrary("sync-multi");
    try {
      const res = syncElementToProjectLibraryPackage({
        projectRoot: root,
        elementId: "dashboard-shell",
        srcFiles: {
          "shell.tsx": "export const Shell = () => null;",
          "styles.css": ".shell {}",
        },
      });
      assert.equal(res.synced, true);
      assert.ok(
        existsSync(join(pkgDir, "src", "components", "dashboard-shell", "shell.tsx")),
      );
      assert.ok(
        existsSync(join(pkgDir, "src", "components", "dashboard-shell", "index.ts")),
      );
      const barrel = readFileSync(
        join(pkgDir, "src", "components", "index.ts"),
        "utf-8",
      );
      assert.match(barrel, /export \* from "\.\/dashboard-shell";/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a no-op without elementLibraryPackagePath", () => {
    const root = tmp("sync-noop");
    try {
      const res = syncElementToProjectLibraryPackage({
        projectRoot: root,
        elementId: "x",
        srcFiles: { "x.tsx": "export {};" },
      });
      assert.equal(res.synced, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes an element and regenerates the barrel", () => {
    const { root, pkgDir } = makeAppWithLibrary("sync-remove");
    try {
      syncElementToProjectLibraryPackage({
        projectRoot: root,
        elementId: "theme-toggle",
        srcFiles: { "theme-toggle.tsx": "export const ThemeToggle = () => null;" },
      });
      syncElementToProjectLibraryPackage({
        projectRoot: root,
        elementId: "sign-in",
        srcFiles: { "sign-in.tsx": "export const SignIn = () => null;" },
      });
      const removed = removeElementFromProjectLibraryPackage({
        projectRoot: root,
        elementId: "theme-toggle",
      });
      assert.equal(removed.removed, true);
      assert.equal(
        existsSync(join(pkgDir, "src", "components", "theme-toggle.tsx")),
        false,
      );
      const barrel = readFileSync(
        join(pkgDir, "src", "components", "index.ts"),
        "utf-8",
      );
      assert.doesNotMatch(barrel, /theme-toggle/);
      assert.match(barrel, /sign-in/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("publishDesignElement syncs into the project element-library package", () => {
    const { root, pkgDir } = makeAppWithLibrary("publish-sync");
    try {
      publishDesignElement({
        projectRoot: root,
        elementId: "company-navigation",
        kind: "shell",
        label: "Company navigation",
        spec: "company nav",
        mockHtml: "<nav class='company-nav'></nav>",
        srcFiles: {
          "company-navigation.tsx":
            "export const CompanyNavigation = () => null;",
        },
      });
      assert.ok(
        existsSync(
          join(pkgDir, "src", "components", "company-navigation.tsx"),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removeDesignElement deletes the element and drops it from the INDEX", () => {
    const root = tmp("remove-element");
    try {
      publishDesignElement({
        projectRoot: root,
        elementId: "sign-in",
        kind: "control",
        label: "Sign In",
        spec: "sign-in form",
        mockHtml: "<form class='sign-in'></form>",
      });
      const lib = projectElementsRoot(root);
      assert.ok(readDesignElementBundle(lib, "sign-in", 1));
      const res = removeDesignElement({ libraryRoot: lib, elementId: "sign-in" });
      assert.equal(res.removed, true);
      assert.ok(!res.remaining.includes("sign-in"));
      assert.equal(readDesignElementBundle(lib, "sign-in", 1), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
