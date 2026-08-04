import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  publishDesignElement,
  resolveDesignElement,
  listProjectElements,
  listRegistryElements,
  extractDesignElementFromMock,
  importDesignElementIntoLoop,
  readDesignLoopElements,
  formatDesignElementsPromptBlock,
  detectPinnedElementDrift,
  extractAndPublishDesignElementFromLoop,
  bindDesignElementsToPhase,
} from "./design-element.js";
import {
  createDesignLoopMeta,
  readDesignLoopMeta,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import type { DesignLoopMetaWithElements } from "./design-element.js";
import { compileDesignPackFromAccept } from "./design-pack.js";
import { detectMockDrift } from "./design-loop-continue.js";
import { CONTINUE_INTENT_DEFAULT } from "./continue-intent.js";

function tmp(name: string): string {
  return mkdtempSync(join(tmpdir(), `sc-el-${name}-`));
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
    const root = tmp("pub");
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
    const root = tmp("extract-loop");
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

  it("detectMockDrift rejects competing toggles when element pinned", () => {
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
  });
});
