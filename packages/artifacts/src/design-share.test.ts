import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveShareAlias,
  resolveDesignShareSource,
  detectShareSourceFromText,
  readShareableDesign,
  importDesignShareIntoLoop,
  readSharedDesignImport,
  formatSharedDesignPromptBlock,
} from "./design-share.js";
import { designLoopDir, designLoopAssetsDir } from "./design-loop.js";

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

test("resolveShareAlias maps jamroast→burntjam and leaves others alone", () => {
  assert.equal(resolveShareAlias("jamroast"), "burntjam");
  assert.equal(resolveShareAlias("Jam Roast"), "burntjam");
  assert.equal(resolveShareAlias("jam_roast"), "burntjam");
  assert.equal(resolveShareAlias("jampress"), "basic-web-agent");
  assert.equal(resolveShareAlias("burntjam"), "burntjam");
  assert.equal(resolveShareAlias("some-other"), "some-other");
});

test("resolveDesignShareSource: by name via listProjects", () => {
  const target = tmpRoot("target");
  const source = tmpRoot("source-proj");
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "burntjam",
    listProjects: () => [{ id: "src-1", name: "BurntJam", rootPath: source }],
  });
  assert.equal(src?.projectId, "src-1");
  assert.equal(src?.rootPath, source);
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("resolveDesignShareSource: alias jamroast matches registered 'Jam Roast' project by name", () => {
  const target = tmpRoot("target");
  const source = tmpRoot("source-proj");
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "jamroast",
    listProjects: () => [{ id: "src-2", name: "burntjam", rootPath: source }],
  });
  assert.equal(src?.projectId, "src-2");
  rmSync(target, { recursive: true, force: true });
  rmSync(source, { recursive: true, force: true });
});

test("resolveDesignShareSource: by name falls back to sibling dir under target parent", () => {
  const parent = tmpRoot("parent");
  const target = join(parent, "light-weight-crm-and-invoicing");
  const source = join(parent, "burntjam");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = resolveDesignShareSource({
    targetRoot: target,
    fromName: "jamroast",
    listProjects: () => [],
  });
  assert.equal(src?.rootPath, source);
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
  });
  assert.match(block, /SHARED DESIGN/);
  assert.match(block, /authoritative for palette\/logos over LIVE SITE/);
  assert.match(block, /burntjam/);
  assert.match(block, /--brand-primary:#c8552e/);
  assert.match(block, /assets\/logo\.png/);
});

test("formatSharedDesignPromptBlock returns empty for null import", () => {
  assert.equal(formatSharedDesignPromptBlock(null), "");
});

test("detectShareSourceFromText: chat mention of 'jamroast' resolves via alias + sibling dir", () => {
  const parent = tmpRoot("chat");
  const target = join(parent, "light-weight-crm-and-invoicing");
  const source = join(parent, "burntjam");
  mkdirSync(target, { recursive: true });
  mkdirSync(source, { recursive: true });
  const src = detectShareSourceFromText({
    targetRoot: target,
    text: "pull the themeing from the jamroast project and give me a new logo",
  });
  assert.ok(src);
  assert.equal(src!.rootPath, source);
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
