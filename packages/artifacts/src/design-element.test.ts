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
  unpinDesignElementsFromLoop,
  countExactClassToken,
  extractAndPublishDesignElementFromLoop,
  bindDesignElementsToPhase,
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
});
