import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildSiblingBrandRefPack,
  extractSiblingProjectPaths,
  isDesignFallbackBrandPath,
} from "./sibling-brand-refs.js";

describe("sibling brand refs", () => {
  it("extractSiblingProjectPaths finds Projects roots", () => {
    const paths = extractSiblingProjectPaths(
      "Apply theming from /Users/brettchaldecott/Projects/basic-web-agent/src/app",
    );
    assert.ok(
      paths.some((p) => p.endsWith("/Projects/basic-web-agent")),
    );
  });

  it("buildSiblingBrandRefPack prefers images/logo over reuse stubs", () => {
    const parent = mkdtempSync(join(tmpdir(), "slop-sib-"));
    const crm = join(parent, "crm");
    const jam = join(parent, "basic-web-agent");
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
        join(jam, "public", "brand", "jampress-logo-reuse.svg"),
        `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512"/><circle cx="256" cy="200" r="72"/><text>Status:** draft</text></svg>\n`,
      );
      writeFileSync(
        join(jam, "src", "components", "header.tsx"),
        `export function Header(){ return <img src="/images/logo.svg" alt="x" /> }\n`,
      );
      assert.equal(
        isDesignFallbackBrandPath(
          join(jam, "public", "brand", "jampress-logo-reuse.svg"),
        ),
        true,
      );
      const pack = buildSiblingBrandRefPack({
        projectRoot: crm,
        description: `Apply theming from ${jam} and a new logo`,
        familySiblingNames: ["basic-web-agent"],
      });
      assert.match(pack, /images\/logo\.svg/);
      assert.match(pack, /Non-authoritative fallbacks/);
      assert.match(pack, /palette-only/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
