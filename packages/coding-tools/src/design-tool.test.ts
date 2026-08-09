import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OllamaImagesDesignTool, writeSvgFallback, isLogoAssetBrief } from "./design-tool.js";
import { getDesignTool } from "./registry.js";

describe("DesignTool", () => {
  it("writeSvgFallback creates an svg placeholder", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-svg-"));
    try {
      const outPath = join(dir, "logo.png");
      const result = writeSvgFallback({
        outPath,
        prompt: "Acme brand mark",
        brandName: "Acme",
        palette: ["#111111", "#eeeeee", "#c45c26"],
      });
      assert.equal(result.format, "svg");
      assert.equal(result.skipped, true);
      assert.ok(existsSync(result.path));
      assert.match(readFileSync(result.path, "utf-8"), /Acme/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("OllamaImagesDesignTool falls back to SVG without endpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-designtool-"));
    try {
      const tool = new OllamaImagesDesignTool();
      const result = await tool.generateImage({
        prompt: "logo",
        outPath: join(dir, "logo.png"),
        brandName: "TestCo",
      });
      assert.equal(result.format, "svg");
      assert.equal(result.reason, "svg_fallback");
      assert.ok(existsSync(result.path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logoFailClosed does not write svg_fallback without designImage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-logo-fail-"));
    try {
      const tool = new OllamaImagesDesignTool();
      const outPath = join(dir, "logo.png");
      const result = await tool.generateImage({
        prompt: "Jam Light wordmark logo",
        outPath,
        brandName: "Jam Light",
        logoFailClosed: true,
      });
      assert.equal(result.reason, "logo_requires_designImage");
      assert.equal(result.bytes, 0);
      assert.equal(existsSync(outPath), false);
      assert.equal(existsSync(outPath.replace(/\.png$/, ".svg")), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("getDesignTool returns ollama-images by default", () => {
    assert.equal(getDesignTool().id, "ollama-images");
    assert.equal(getDesignTool("ollama-images").id, "ollama-images");
  });

  it("isLogoAssetBrief matches name/filename only — prompt text is ignored", () => {
    // Regression: "Mock reference (from Phase 21)" with a logo-mentioning
    // prompt must NOT become a fail-closed logo blocker.
    assert.equal(
      isLogoAssetBrief({
        name: "Mock reference (from Phase 21)",
        filename: "mock-reference.png",
        prompt: "mock dashboard showing the pinned logo in the menubar",
      }),
      false,
    );
    assert.equal(
      isLogoAssetBrief({
        name: "Alpha-channel logo",
        filename: "logo-alpha.png",
        prompt: "cut out the pinned mark",
      }),
      true,
    );
    // Plain "icon pack" is a derivative asset, not a generative logo brief.
    assert.equal(
      isLogoAssetBrief({ name: "Icon pack", filename: "icon-pack.png" }),
      false,
    );
    assert.equal(
      isLogoAssetBrief({ name: "App icon", filename: "app-icon.png" }),
      true,
    );
  });
});
