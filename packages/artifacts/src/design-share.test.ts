import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveShareAlias,
  resolveDesignShareSource,
  detectShareSourceFromText,
  textMentionsProjectName,
  readShareableDesign,
  importDesignShareIntoLoop,
  readSharedDesignImport,
  formatSharedDesignPromptBlock,
  pickProjectPriorDesign,
  importProjectPriorDesignIntoLoop,
  readProjectPriorDesignImport,
  formatProjectPriorDesignPromptBlock,
} from "./design-share.js";
import {
  designLoopDir,
  designLoopAssetsDir,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import { writeDesignLoopPack } from "./design-pack.js";
import { existsSync } from "node:fs";

function tmpRoot(name: string): string {
  const base = mkdtempSync(join(tmpdir(), `sc-share-${name}-`));
  return base;
}

function writeTokensCss(root: string, body: string): void {
  const p = join(root, "src", "app");
  mkdirSync(p, { recursive: true });
  writeFileSync(join(p, "globals.css"), body, "utf-8");
}

function writeLogo(root: string, name = "logo.png"): string {
  const p = join(root, "public", "brand");
  mkdirSync(p, { recursive: true });
  const file = join(p, name);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]), null);
  return file;
}

test("resolveShareAlias is identity (trim + collapse whitespace, no brand rewrite)", () => {
  assert.equal(resolveShareAlias("jamroast"), "jamroast");
  assert.equal(resolveShareAlias("Jam Roast"), "Jam Roast");
  assert.equal(resolveShareAlias("  some-other  "), "some-other");
  assert.equal(resolveShareAlias("Acme  Brand"), "Acme Brand");
});

test("resolveDesignShareSource: by name via listProjects", () => {
  const target = tmpRoot("target");
  const source = tmpRoot("source-proj");
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "MyBrand",
    listProjects: () => [{ id: "src-1", name: "MyBrand", rootPath: source }],
  });
  assert.equal(src?.projectId, "src-1");
  assert.equal(src?.rootPath, source);
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("resolveDesignShareSource: registered project name JamRoast matches without folder alias", () => {
  const target = tmpRoot("target");
  const source = tmpRoot("source-proj");
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "JamRoast",
    listProjects: () => [{ id: "src-2", name: "JamRoast", rootPath: source }],
  });
  assert.equal(src?.projectId, "src-2");
  // Unrelated registered name must not match via alias rewrite
  const miss = resolveDesignShareSource({
    targetRoot: target,
    fromName: "jamroast",
    listProjects: () => [{ id: "src-x", name: "burntjam", rootPath: source }],
  });
  assert.equal(miss, null);
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("resolveDesignShareSource: by name falls back to literal sibling dir under target parent", () => {
  const parent = tmpRoot("parent");
  const target = join(parent, "app-a");
  const source = join(parent, "my-brand");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "my-brand",
    listProjects: () => [],
  });
  assert.equal(src?.rootPath, source);
  const miss = resolveDesignShareSource({
    targetRoot: target,
    fromName: "jamroast",
    listProjects: () => [],
  });
  assert.equal(miss, null);
  rmSync(parent, { recursive: true, force: true });
});

test("resolveDesignShareSource: by rootPath via findProjectByRootPath", () => {
  const target = tmpRoot("target");
  const source = tmpRoot("source-by-path");
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromRootPath: source,
    findProjectByRootPath: (p) =>
      p === source ? { id: "src-9", name: "ByPath", rootPath: source } : undefined,
  });
  assert.equal(src?.projectId, "src-9");
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("readShareableDesign picks up tokens + logos from source root", () => {
  const source = tmpRoot("readable");
  writeTokensCss(
    source,
    ":root{ --brand-primary:#c8552e; --bg:#0d0b09; }\nbody{color:var(--brand-primary)}\n",
  );
  writeLogo(source);
  const share = readShareableDesign({ rootPath: source, name: "Readable" });
  assert.ok(share);
  assert.match(share!.tokensCss, /--brand-primary:#c8552e/);
  assert.equal(share!.logoFiles.length, 1);
  assert.match(share!.logoFiles[0]!, /logo\.png$/);
  rmSync(source, { recursive: true, force: true });
});

test("readShareableDesign returns null when nothing shareable", () => {
  const source = tmpRoot("empty");
  const share = readShareableDesign({ rootPath: source, name: "Empty" });
  assert.equal(share, null);
  rmSync(source, { recursive: true, force: true });
});

test("importDesignShareIntoLoop copies logos into target loop assets + persists SHARED_FROM.json", () => {
  const source = tmpRoot("srcproj");
  const target = tmpRoot("tgtproj");
  const loopId = "dl_share_test";
  writeTokensCss(source, ":root{ --accent:#f4a261; }\n");
  writeLogo(source, "mark.png");
  const share = readShareableDesign({ rootPath: source, name: "Src" })!;
  assert.ok(share);

  const imported = importDesignShareIntoLoop({ targetRoot: target, loopId, share });
  assert.equal(imported.loopId, loopId);
  assert.equal(imported.source.name, "Src");
  assert.deepEqual(imported.copiedAssets, ["mark.png"]);
  assert.match(imported.logoAssetPaths[0]!, /\.slopcontrol\/design-loops\/dl_share_test\/assets\/mark\.png$/);
  assert.match(imported.tokensCss, /--accent:#f4a261/);

  // Asset file actually landed in the target loop.
  const assetFile = join(designLoopAssetsDir(target, loopId), "mark.png");
  assert.ok(readSharedDesignImport(target, loopId), "SHARED_FROM.json readable");
  const roundTrip = readSharedDesignImport(target, loopId)!;
  assert.equal(roundTrip.loopId, loopId);
  assert.deepEqual(roundTrip.copiedAssets, ["mark.png"]);
  assert.ok(imported.tokensCss.length > 0);
  void assetFile;
  rmSync(source, { recursive: true, force: true });
  rmSync(target, { recursive: true, force: true });
});

test("formatSharedDesignPromptBlock ranks above live site and includes tokens + logos", () => {
  const block = formatSharedDesignPromptBlock({
    source: { rootPath: "/x/burntjam", name: "burntjam" },
    loopId: "dl_1",
    importedAt: "2026-08-02T09:00:00.000Z",
    tokensCss: ":root{ --brand-primary:#c8552e; }",
    copiedAssets: ["logo.png"],
    logoAssetPaths: [".slopcontrol/design-loops/dl_1/assets/logo.png"],
    pack: {
      name: "burntjam",
      version: 1,
      loopId: "src",
      projectId: "p",
      sourceMockVersion: 1,
      tokens: "",
      logos: [],
      typography: [],
      shell: [
        "Menubar: content-max inner; logo+nav left; auth/theme right.",
      ],
      contentPillars: [],
      inScope: [],
      mustNot: [],
      mockPath: "",
      createdAt: "2026-08-02T09:00:00.000Z",
      updatedAt: "2026-08-02T09:00:00.000Z",
    },
  });
  assert.match(block, /SHARED DESIGN/);
  assert.match(block, /authoritative for palette/);
  assert.match(block, /shell chrome/);
  assert.match(block, /LIVE SITE wins only for nav/);
  assert.match(block, /burntjam/);
  assert.match(block, /--brand-primary:#c8552e/);
  assert.match(block, /assets\/logo\.png/);
  assert.match(block, /Menubar: content-max/);
});

test("formatSharedDesignPromptBlock returns empty for null import", () => {
  assert.equal(formatSharedDesignPromptBlock(null), "");
});

test("detectShareSourceFromText: chat mention of literal sibling dir resolves", () => {
  const parent = tmpRoot("chat");
  const target = join(parent, "app-a");
  const source = join(parent, "my-brand");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "pull the themeing from the my-brand project and give me a new logo",
  });
  assert.ok(src);
  assert.equal(src!.rootPath, source);
  // Alias-only name with no matching dir/project → null
  const miss = detectShareSourceFromText({
    targetRoot: target,
    text: "pull the themeing from the jamroast project and give me a new logo",
  });
  assert.equal(miss, null);
  rmSync(parent, { recursive: true, force: true });
});

test("detectShareSourceFromText: absolute path mention resolves", () => {
  const parent = tmpRoot("chat-abs");
  const target = join(parent, "proj-a");
  const source = join(parent, "proj-b");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: `use the branding from ${source} please`,
  });
  assert.ok(src);
  assert.equal(src!.rootPath, source);
  rmSync(parent, { recursive: true, force: true });
});

test("detectShareSourceFromText: registered project name mention resolves", () => {
  const target = tmpRoot("chat-reg-target");
  const source = tmpRoot("chat-reg-source");
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "adopt the BurntJam palette",
    listProjects: () => [{ id: "p-7", name: "BurntJam", rootPath: source }],
  });
  assert.ok(src);
  assert.equal(src!.projectId, "p-7");
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("detectShareSourceFromText: no mention returns null", () => {
  const parent = tmpRoot("chat-none");
  const target = join(parent, "proj-a");
  mkdirSync(target, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "make the hero section bolder",
  });
  assert.equal(src, null);
  rmSync(parent, { recursive: true, force: true });
});

test("detectShareSourceFromText: naming this project's own folder is self — returns null", () => {
  const parent = tmpRoot("chat-self");
  const target = join(parent, "my-app");
  mkdirSync(target, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "pull my-app theming into this mock",
  });
  assert.equal(src, null);
  rmSync(parent, { recursive: true, force: true });
});

test("detectShareSourceFromText: literal sibling dir name resolves (no brand alias)", () => {
  const parent = tmpRoot("chat-sib");
  const target = join(parent, "app-a");
  const source = join(parent, "brand-kit");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "adopt the brand-kit palette and dark/light theme",
  });
  assert.ok(src);
  assert.equal(src!.rootPath, source);
  rmSync(parent, { recursive: true, force: true });
});

test("textMentionsProjectName: hyphen is part of the identifier (not a word boundary)", () => {
  assert.equal(textMentionsProjectName("use jamroast-components", "jamroast"), false);
  assert.equal(
    textMentionsProjectName("use jamroast-components", "jamroast-components"),
    true,
  );
  assert.equal(textMentionsProjectName("from the JamRoast project", "JamRoast"), true);
  assert.equal(textMentionsProjectName("from the JamRoast project", "jamroast"), true);
});

test("detectShareSourceFromText: jamroast-components beats JamRoast prefix (regression)", () => {
  const target = tmpRoot("jp-target");
  const burntjam = tmpRoot("burntjam");
  const components = tmpRoot("jamroast-components");
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "please can you pull in the theming and design standards from the jamroast-components project and apply them to this mockup",
    // JamRoast listed first — old \\b matcher returned this incorrectly.
    listProjects: () => [
      { id: "jamroast", name: "JamRoast", rootPath: burntjam },
      {
        id: "components",
        name: "jamroast-components",
        rootPath: components,
      },
    ],
  });
  assert.ok(src);
  assert.equal(src!.projectId, "components");
  assert.equal(src!.rootPath, components);
  rmSync(target, { recursive: true, force: true });
  rmSync(burntjam, { recursive: true, force: true });
  rmSync(components, { recursive: true, force: true });
});

test("detectShareSourceFromText: bare JamRoast still resolves when only that is named", () => {
  const target = tmpRoot("jp-target2");
  const burntjam = tmpRoot("burntjam2");
  const components = tmpRoot("jamroast-components2");
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "pull the theming from the JamRoast project",
    listProjects: () => [
      { id: "jamroast", name: "JamRoast", rootPath: burntjam },
      {
        id: "components",
        name: "jamroast-components",
        rootPath: components,
      },
    ],
  });
  assert.ok(src);
  assert.equal(src!.projectId, "jamroast");
  assert.equal(src!.rootPath, burntjam);
  rmSync(target, { recursive: true, force: true });
  rmSync(burntjam, { recursive: true, force: true });
  rmSync(components, { recursive: true, force: true });
});

test("detectShareSourceFromText: longest sibling dir wins (brand-kit over brand)", () => {
  const parent = tmpRoot("chat-long");
  const target = join(parent, "app-a");
  const brand = join(parent, "brand");
  const brandKit = join(parent, "brand-kit");
  mkdirSync(target, { recursive: true });
  mkdirSync(brand, { recursive: true });
  mkdirSync(brandKit, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "adopt the brand-kit palette",
  });
  assert.ok(src);
  assert.equal(src!.rootPath, brandKit);
  rmSync(parent, { recursive: true, force: true });
});

test("importDesignShareIntoLoop refuses self-import", () => {
  const root = tmpRoot("self-import");
  assert.throws(
    () =>
      importDesignShareIntoLoop({
        targetRoot: root,
        loopId: "loop-1",
        share: {
          source: { rootPath: root, name: "jampress" },
          pack: null,
          tokensCss: ":root{}",
          logoFiles: [],
        },
      }),
    /same project/,
  );
  rmSync(root, { recursive: true, force: true });
});

test("readSharedDesignImport ignores prior self-import on disk", () => {
  const root = tmpRoot("read-self");
  const loopId = "loop-self";
  mkdirSync(designLoopDir(root, loopId), { recursive: true });
  writeFileSync(
    join(designLoopDir(root, loopId), "SHARED_FROM.json"),
    JSON.stringify({
      source: { rootPath: root, name: "jampress" },
      loopId,
      importedAt: new Date().toISOString(),
      tokensCss: ":root{}",
      copiedAssets: [],
      logoAssetPaths: [],
    }),
    "utf-8",
  );
  assert.equal(readSharedDesignImport(root, loopId), null);
  rmSync(root, { recursive: true, force: true });
});

test("pickProjectPriorDesign prefers implemented loop excluding current; seeds PRIOR_DESIGN", () => {
  const root = tmpRoot("prior-loop");
  const oldLoop = "loop-old";
  const newLoop = "loop-new";
  const now = new Date().toISOString();
  writeDesignLoopMeta(root, {
    id: oldLoop,
    projectId: "proj-1",
    brief: "prior system",
    status: "implemented",
    currentVersion: 2,
    acceptedVersion: 2,
    createdAt: now,
    updatedAt: now,
  });
  writeDesignLoopVersion({
    projectRoot: root,
    loopId: oldLoop,
    version: 2,
    html: `<html><style>:root{--brand-orange:#E8430A}</style><body>Kitchen Sink</body></html>`,
    notes: "v2",
    request: "prior",
  });
  mkdirSync(designLoopAssetsDir(root, oldLoop), { recursive: true });
  writeFileSync(
    join(designLoopAssetsDir(root, oldLoop), "mark.png"),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  );
  writeDesignLoopPack(root, oldLoop, {
    name: "prior",
    version: 1,
    loopId: oldLoop,
    projectId: "proj-1",
    sourceMockVersion: 2,
    tokens: ":root { --brand-orange: #E8430A; --background: #0A0A0A; }",
    logos: [],
    typography: ["Space Grotesk"],
    shell: [],
    contentPillars: [],
    inScope: ["palette"],
    mustNot: [],
    mockPath: `.slopcontrol/design-loops/${oldLoop}/v2/mock.html`,
    createdAt: now,
    updatedAt: now,
  });

  // Empty new loop meta so exclude works
  writeDesignLoopMeta(root, {
    id: newLoop,
    projectId: "proj-1",
    brief: "pull current theming",
    status: "open",
    currentVersion: 0,
    createdAt: now,
    updatedAt: now,
  });

  const prior = pickProjectPriorDesign(root, { excludeLoopId: newLoop });
  assert.ok(prior);
  assert.equal(prior!.kind, "loop");
  assert.equal(prior!.loopId, oldLoop);
  assert.match(prior!.tokensCss, /--brand-orange/);
  assert.ok(prior!.mockHtml?.includes("Kitchen Sink"));

  const imported = importProjectPriorDesignIntoLoop({
    projectRoot: root,
    loopId: newLoop,
    prior: prior!,
  });
  assert.ok(existsSync(join(designLoopDir(root, newLoop), "PRIOR_DESIGN.json")));
  assert.ok(imported.copiedAssets.includes("mark.png"));
  assert.ok(
    existsSync(join(designLoopAssetsDir(root, newLoop), "mark.png")),
  );
  const readBack = readProjectPriorDesignImport(root, newLoop);
  assert.ok(readBack);
  assert.equal(readBack!.sourceLoopId, oldLoop);
  const block = formatProjectPriorDesignPromptBlock(readBack);
  assert.match(block, /PRIOR DESIGN/);
  assert.match(block, /--brand-orange/);

  // Self SHARED_FROM still ignored
  writeFileSync(
    join(designLoopDir(root, newLoop), "SHARED_FROM.json"),
    JSON.stringify({
      source: { rootPath: root, name: "self" },
      loopId: newLoop,
      importedAt: now,
      tokensCss: ":root{}",
      copiedAssets: [],
      logoAssetPaths: [],
    }),
    "utf-8",
  );
  assert.equal(readSharedDesignImport(root, newLoop), null);

  rmSync(root, { recursive: true, force: true });
});

test("pickProjectPriorDesign falls back to phase design when no accepted loop", () => {
  const root = tmpRoot("prior-phase");
  const designDir = join(root, ".slopcontrol", "phases", "05-theme", "design");
  mkdirSync(designDir, { recursive: true });
  writeFileSync(
    join(designDir, "tokens.css"),
    ":root { --brand-orange: #E8430A; }\n",
    "utf-8",
  );
  writeFileSync(
    join(designDir, "mock.html"),
    "<html><body>Phase mock</body></html>\n",
    "utf-8",
  );
  mkdirSync(join(designDir, "assets"), { recursive: true });
  writeFileSync(
    join(designDir, "assets", "logo.svg"),
    "<svg></svg>\n",
    "utf-8",
  );

  const prior = pickProjectPriorDesign(root, { excludeLoopId: "any" });
  assert.ok(prior);
  assert.equal(prior!.kind, "phase");
  assert.equal(prior!.phaseId, "05-theme");
  assert.match(prior!.tokensCss, /--brand-orange/);
  assert.ok(prior!.mockHtml?.includes("Phase mock"));
  assert.ok(prior!.logoFiles.some((p) => p.endsWith("logo.svg")));
  rmSync(root, { recursive: true, force: true });
});

test("pickProjectPriorDesign returns null when nothing prior", () => {
  const root = tmpRoot("prior-empty");
  assert.equal(pickProjectPriorDesign(root), null);
  rmSync(root, { recursive: true, force: true });
});
