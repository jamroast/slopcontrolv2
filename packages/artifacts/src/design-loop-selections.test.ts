import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  createDesignLoopMeta,
  writeDesignLoopMeta,
  writeDesignLoopVersion,
} from "./design-loop.js";
import {
  buildDesignLoopConceptCatalog,
  extractConceptsFromMockHtml,
  formatDesignLoopSelectionsPromptBlock,
  pinDesignLoopSelection,
  unpinDesignLoopSelection,
  maybeAutoPinDominantLogoFromMock,
  maybeAutoPinFromOperatorMessage,
  pinDesignLoopLogoAsset,
  getDesignLoopSelections,
} from "./design-loop-selections.js";
import { readDesignLoopMeta } from "./design-loop.js";

describe("design-loop-selections", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("extractConceptsFromMockHtml maps Concept C to asset", () => {
    const html = `
<div class="logo-card">
  <img class="logo-card-img" src=".slopcontrol/design-loops/x/assets/logo-symbolic-3-ember-monogram.png" alt="x">
  <div class="logo-card-label">Ember Monogram</div>
  <span class="logo-card-badge">Concept C</span>
</div></div>`;
    const concepts = extractConceptsFromMockHtml(html);
    assert.ok(concepts.some((c) => c.conceptId === "concept-c"));
    assert.ok(
      concepts.some((c) => c.asset === "logo-symbolic-3-ember-monogram.png"),
    );
  });

  it("pin and unpin update META and prompt block", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-sel-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, meta);
    mkdirSync(
      join(root, ".slopcontrol", "design-loops", meta.id, "assets"),
      { recursive: true },
    );
    writeFileSync(
      join(
        root,
        ".slopcontrol",
        "design-loops",
        meta.id,
        "assets",
        "logo-symbolic-3-ember-monogram.png",
      ),
      "fake",
    );
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: `<div class="logo-card">
  <img src=".slopcontrol/design-loops/${meta.id}/assets/logo-symbolic-3-ember-monogram.png">
  <span class="logo-card-badge">Concept C</span>
</div></div>
<div class="section-label"><b>1</b> Palette — warm</div>`,
      notes: "ok",
    });

    pinDesignLoopSelection({
      projectRoot: root,
      loopId: meta.id,
      slot: "logo",
      conceptId: "Concept C",
    });
    const catalog = buildDesignLoopConceptCatalog({
      projectRoot: root,
      loopId: meta.id,
    });
    assert.ok(catalog.some((c) => c.pinned && c.conceptId === "concept-c"));

    const block = formatDesignLoopSelectionsPromptBlock({
      projectRoot: root,
      loopId: meta.id,
    });
    assert.match(block, /PINNED/);
    assert.match(block, /logo-symbolic-3-ember-monogram/);
    assert.match(block, /make_transparent/);
    assert.match(block, /circular_mask/);
    assert.match(block, /CANDIDATES/);

    const inventBlock = formatDesignLoopSelectionsPromptBlock({
      projectRoot: root,
      loopId: meta.id,
      inventLogo: true,
    });
    assert.match(inventBlock, /SUPERSEDED/);
    assert.match(inventBlock, /inventNew=true/);
    assert.match(inventBlock, /do not re-embed/);

    unpinDesignLoopSelection({
      projectRoot: root,
      loopId: meta.id,
      slot: "logo",
    });
    const after = buildDesignLoopConceptCatalog({
      projectRoot: root,
      loopId: meta.id,
    });
    assert.ok(!after.some((c) => c.pinned && c.conceptId === "concept-c"));
  });

  it("maybeAutoPinFromOperatorMessage pins explicit filename from assets/", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-file-pin-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, meta);
    const assetsDir = join(
      root,
      ".slopcontrol",
      "design-loops",
      meta.id,
      "assets",
    );
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "jamlight-logo-modern-v4-alpha.png"), "fake");
    writeFileSync(join(assetsDir, "jam-light-mark-v1-alpha.png"), "fake");
    // Empty mock — filename must still pin from disk, not CONCEPTS cards.
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: `<p>no logo cards</p>`,
      notes: "ok",
    });

    const next = maybeAutoPinFromOperatorMessage({
      projectRoot: root,
      loopId: meta.id,
      message:
        "Please can you pin this logo jamlight-logo-modern-v4-alpha.png",
    });
    assert.ok(next);
    const logo = getDesignLoopSelections(next).find((s) => s.slot === "logo");
    assert.equal(logo?.asset, "jamlight-logo-modern-v4-alpha.png");
  });

  it("maybeAutoPinFromOperatorMessage ignores style phrases without a filename", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-modern-pin-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, meta);
    const assetsDir = join(
      root,
      ".slopcontrol",
      "design-loops",
      meta.id,
      "assets",
    );
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "jamlight-logo-modern-v4-alpha.png"), "fake");
    writeDesignLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      html: `<img src=".slopcontrol/design-loops/${meta.id}/assets/jamlight-logo-modern-v4-alpha.png">`,
      notes: "ok",
    });

    const next = maybeAutoPinFromOperatorMessage({
      projectRoot: root,
      loopId: meta.id,
      message:
        "Please go with the modern logo. Please generate an icon pack for that.",
    });
    assert.equal(next, null);
  });

  it("pin survives continue-handler re-read merge (stale working must not wipe selections)", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-pin-merge-"));
    roots.push(root);
    const working = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, working);
    const assetsDir = join(
      root,
      ".slopcontrol",
      "design-loops",
      working.id,
      "assets",
    );
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(
      join(assetsDir, "jamlight-logo-modern-v4-alpha.png"),
      "fake",
    );

    // Simulate generate writing a pin after `working` was loaded.
    pinDesignLoopSelection({
      projectRoot: root,
      loopId: working.id,
      slot: "logo",
      asset: "jamlight-logo-modern-v4-alpha.png",
    });

    // Bug pattern: spreading stale working wipes selections.
    const wiped = {
      ...working,
      currentVersion: 2,
      updatedAt: new Date().toISOString(),
    };
    assert.equal(
      getDesignLoopSelections(wiped as typeof working).length,
      0,
      "stale spread must demonstrate the wipe",
    );

    // Fix pattern: re-read before write.
    const fresh = readDesignLoopMeta(root, working.id) ?? working;
    const next = {
      ...fresh,
      currentVersion: 2,
      updatedAt: new Date().toISOString(),
    };
    writeDesignLoopMeta(root, next);
    const persisted = readDesignLoopMeta(root, working.id)!;
    const logo = getDesignLoopSelections(persisted).find(
      (s) => s.slot === "logo",
    );
    assert.equal(logo?.asset, "jamlight-logo-modern-v4-alpha.png");
  });

  it("maybeAutoPinDominantLogoFromMock pins most-used mark", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-dom-pin-"));
    roots.push(root);
    const meta = createDesignLoopMeta({
      projectId: "p1",
      brief: "theme",
    });
    writeDesignLoopMeta(root, meta);
    mkdirSync(
      join(root, ".slopcontrol", "design-loops", meta.id, "assets"),
      { recursive: true },
    );
    writeFileSync(
      join(
        root,
        ".slopcontrol",
        "design-loops",
        meta.id,
        "assets",
        "ember-monogram-alpha.png",
      ),
      "fake",
    );
    const html = `
<img src=".slopcontrol/design-loops/${meta.id}/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/${meta.id}/assets/ember-monogram-alpha.png">
<img src=".slopcontrol/design-loops/${meta.id}/assets/ember-monogram-alpha.png">
`;
    const next = maybeAutoPinDominantLogoFromMock({
      projectRoot: root,
      loopId: meta.id,
      previousHtml: html,
    });
    assert.ok(next);
    pinDesignLoopLogoAsset({
      projectRoot: root,
      loopId: meta.id,
      asset: "ember-monogram-alpha.png",
    });
    const block = formatDesignLoopSelectionsPromptBlock({
      projectRoot: root,
      loopId: meta.id,
    });
    assert.match(block, /ember-monogram-alpha\.png/);
  });
});
