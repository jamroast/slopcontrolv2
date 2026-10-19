import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildProjectBrandRefPack,
  buildSiblingBrandRefPack,
  excerptCssTokens,
  extractSiblingProjectPaths,
  isDesignFallbackBrandPath,
} from "./sibling-brand-refs.js";

describe("sibling brand refs", () => {
  it("extractSiblingProjectPaths finds Projects roots", () => {
    const paths = extractSiblingProjectPaths(
      "Apply theming from /Users/brettchaldecott/Projects/sibling-app/src/app",
    );
    assert.ok(
      paths.some((p) => p.endsWith("/Projects/sibling-app")),
    );
  });

  it("buildSiblingBrandRefPack prefers images/logo over reuse stubs", () => {
    const parent = mkdtempSync(join(tmpdir(), "slop-sib-"));
    const crm = join(parent, "crm");
    const jam = join(parent, "sibling-app");
    try {
      mkdirSync(join(crm, ".slopcontrol"), { recursive: true });
      mkdirSync(join(jam, "public", "images"), { recursive: true });
      mkdirSync(join(jam, "public", "brand"), { recursive: true });
      mkdirSync(join(jam, "src", "components"), { recursive: true });
      writeFileSync(
        join(jam, "public", "images", "logo.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg"><title>real</title></svg>\n`,
      );
      writeFileSync(
        join(jam, "public", "brand", "logo-reuse.svg"),
        `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512"/><circle cx="256" cy="200" r="72"/><text>Status:** draft</text></svg>\n`,
      );
      writeFileSync(
        join(jam, "src", "components", "header.tsx"),
        `export function Header(){ return <img src="/images/logo.svg" alt="x" /> }\n`,
      );
      assert.equal(
        isDesignFallbackBrandPath(
          join(jam, "public", "brand", "logo-reuse.svg"),
        ),
        true,
      );
      const pack = buildSiblingBrandRefPack({
        projectRoot: crm,
        description: `Apply theming from ${jam} and a new logo`,
        familySiblingNames: ["sibling-app"],
      });
      assert.match(pack, /images\/logo\.svg/);
      assert.match(pack, /Non-authoritative fallbacks/);
      assert.match(pack, /palette-only/);

      mkdirSync(join(jam, "src", "app"), { recursive: true });
      writeFileSync(
        join(jam, "src", "app", "globals.css"),
        `:root { --accent: #E8430A; --bg: #0A0A0A; }\nbody { margin: 0; }\n`,
      );
      const withExcerpts = buildSiblingBrandRefPack({
        projectRoot: crm,
        description: `Apply theming from ${jam}`,
        familySiblingNames: ["sibling-app"],
        includeTokenExcerpts: true,
      });
      assert.match(withExcerpts, /--accent:\s*#E8430A/);
      assert.match(withExcerpts, /```css/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("detects placeholder and raster-named svg marks", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-fallback-"));
    try {
      const legacy = join(dir, "mark.svg");
      writeFileSync(
        legacy,
        `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512"/><circle cx="256" cy="200" r="72"/><text>Brand</text></svg>\n`,
      );
      const stamped = join(dir, "stamped.svg");
      writeFileSync(
        stamped,
        `<svg data-slopcontrol-fallback="svg_fallback" viewBox="0 0 8 8"><path d="M0 0"/></svg>\n`,
      );
      const draft = join(dir, "draft.svg");
      writeFileSync(
        draft,
        `<svg><rect/><circle/><text>Status:** draft</text></svg>\n`,
      );
      const reuse = join(dir, "mark-reuse.svg");
      writeFileSync(reuse, `<svg><path d="M0 0h1"/></svg>\n`);
      const raster = join(dir, "logo.svg");
      writeFileSync(
        raster,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const real = join(dir, "real.svg");
      writeFileSync(
        real,
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20z"/></svg>\n`,
      );
      assert.equal(isDesignFallbackBrandPath(legacy), true);
      assert.equal(isDesignFallbackBrandPath(stamped), true);
      assert.equal(isDesignFallbackBrandPath(draft), true);
      assert.equal(isDesignFallbackBrandPath(reuse), true);
      assert.equal(isDesignFallbackBrandPath(raster), true);
      assert.equal(isDesignFallbackBrandPath(real), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("excerptCssTokens prefers :root", () => {
    const out = excerptCssTokens(
      "body{}\n:root { --x: 1; }\n.footer{}",
      200,
    );
    assert.match(out, /:root/);
    assert.match(out, /--x/);
  });

  it("excerptCssTokens includes .dark / .light surface ladders", () => {
    const out = excerptCssTokens(
      [
        ":root { --brand-orange: #E8430A; }",
        ".dark { --background: #0A0A0A; --foreground: #F5F0E8; }",
        ".light { --background: #FDF8F3; --foreground: #1A1510; }",
        "body { margin: 0; }",
      ].join("\n"),
      800,
    );
    assert.match(out, /:root/);
    assert.match(out, /\.dark/);
    assert.match(out, /\.light/);
    assert.match(out, /#0A0A0A/);
    assert.match(out, /#FDF8F3/);
  });

  it("buildProjectBrandRefPack includes this project's tokens without a sibling", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-proj-brand-"));
    try {
      mkdirSync(join(root, "src", "app"), { recursive: true });
      mkdirSync(join(root, "public", "images"), { recursive: true });
      writeFileSync(
        join(root, "src", "app", "globals.css"),
        `:root { --acme-accent: #E8430A; --jam-bg: #0A0A0A; }\n`,
      );
      writeFileSync(
        join(root, "public", "images", "logo.svg"),
        `<svg xmlns="http://www.w3.org/2000/svg"><title>Acme</title></svg>\n`,
      );
      writeFileSync(
        join(root, "src", "app", "page.tsx"),
        `export default function Page(){ return <h1>{"Taste Room for builders"}</h1> }\n`,
      );
      const pack = buildProjectBrandRefPack({
        projectRoot: root,
        includeTokenExcerpts: true,
      });
      assert.match(pack, /This project brand/);
      assert.match(pack, /--acme-accent/);
      assert.match(pack, /images\/logo\.svg/);
      assert.match(pack, /Taste Room/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
