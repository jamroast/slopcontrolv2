import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractMockCustomProperties,
  findUndefinedCssVarRefs,
  collectProjectCssVarNames,
  findMissingMockTokensInProject,
} from "./css-tokens.js";

describe("css-tokens", () => {
  it("extracts :root and [data-theme] custom properties from a mock", () => {
    const html = `<html><head><style>
:root {
  --background: #0A0A0A;
  --sidebar-w: 288px;
  --pane-w: 400px;
}
[data-theme="light"] {
  --background: #F5F0E8;
}
</style></head><body><aside style="width:var(--pane-w)"></aside></body></html>`;
    const props = extractMockCustomProperties(html);
    const names = props.map((p) => p.name);
    assert.ok(names.includes("--sidebar-w"));
    assert.ok(names.includes("--pane-w"));
    const pane = props.find((p) => p.name === "--pane-w");
    assert.equal(pane?.value, "400px");
  });

  it("findUndefinedCssVarRefs reports var() refs missing from defined set", () => {
    const code = `width: var(--pane-w); height: var(--shell-gap); color: var(--foreground);`;
    const undefinedRefs = findUndefinedCssVarRefs({
      code,
      definedVars: ["--pane-w", "--foreground"],
    });
    assert.deepEqual(undefinedRefs, ["--shell-gap"]);
  });

  it("collectProjectCssVarNames + findMissingMockTokensInProject detects an unwired mock token", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-css-tokens-"));
    try {
      mkdirSync(join(root, "web", "src"), { recursive: true });
      writeFileSync(
        join(root, "web", "src", "index.css"),
        ":root{--foreground:#F5F0E8;}",
      );
      const html = `<style>:root{--foreground:#0A0A0A;--pane-w:400px;}</style>`;
      const defined = collectProjectCssVarNames(root);
      assert.ok(defined.has("--foreground"));
      assert.ok(!defined.has("--pane-w"));
      const missing = findMissingMockTokensInProject({ projectRoot: root, html });
      assert.deepEqual(
        missing.map((m) => m.name),
        ["--pane-w"],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
