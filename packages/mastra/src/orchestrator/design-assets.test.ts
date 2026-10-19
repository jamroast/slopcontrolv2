import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyDerivativeOp, resolveVisionImagePaths } from "./design-assets.js";

const ROOT = "/tmp/slop-project";

describe("resolveVisionImagePaths", () => {
  it("prefers raster generated assets and caps the count", () => {
    const paths = resolveVisionImagePaths({
      projectRoot: ROOT,
      generatedPaths: [
        "/abs/a.png",
        "design/b.png",
        "design/c.png",
        "design/d.png",
        "/abs/e.md",
      ],
      previewPaths: ["design/x-contact-sheet.png"],
    });
    assert.deepEqual(paths, ["/abs/a.png", "/tmp/slop-project/design/b.png", "/tmp/slop-project/design/c.png"]);
    assert.equal(paths.length, 3);
  });

  it("falls back to previews (sheet first, then size desc, dark before light)", () => {
    const paths = resolveVisionImagePaths({
      projectRoot: ROOT,
      generatedPaths: ["design/mark.svg", "design/mark-16.svg"],
      previewPaths: [
        "design/mark-preview-16-light.png",
        "design/mark-preview-32-dark.png",
        "design/mark-preview-32-light.png",
        "design/mark-preview-256-dark.png",
        "design/mark-contact-sheet.png",
        "design/mark.svg",
      ],
      max: 4,
    });
    assert.deepEqual(paths, [
      "/tmp/slop-project/design/mark-contact-sheet.png",
      "/tmp/slop-project/design/mark-preview-256-dark.png",
      "/tmp/slop-project/design/mark-preview-32-dark.png",
      "/tmp/slop-project/design/mark-preview-32-light.png",
    ]);
  });

  it("returns an empty list when there is nothing raster to review", () => {
    assert.deepEqual(
      resolveVisionImagePaths({
        projectRoot: ROOT,
        generatedPaths: ["design/mark.svg"],
        previewPaths: [],
      }),
      [],
    );
    assert.deepEqual(
      resolveVisionImagePaths({
        projectRoot: ROOT,
        generatedPaths: [],
        previewPaths: [],
      }),
      [],
    );
  });
});

describe("classifyDerivativeOp", () => {
  const cases: Array<[string, string, string]> = [
    ["Icon pack (8 sizes)", "icon-pack.png", "icon_pack"],
    ["Favicon", "favicon.png", "favicon_pack"],
    ["Maskable app icons", "maskable-512.png", "favicon_pack"],
    ["Site icon", "site.ico", "favicon_pack"],
    ["Circular mask", "mark-circle.png", "circular_mask"],
    ["Circular cut-out", "mark-round.png", "circular_mask"],
    ["Transparent mark", "mark-alpha.png", "alpha"],
    ["Alpha channel", "mark.png", "alpha"],
    ["Hero artwork", "hero.png", "alpha"],
  ];
  for (const [name, filename, expected] of cases) {
    it(`classifies "${name}" as ${expected}`, () => {
      assert.equal(classifyDerivativeOp({ name, filename }), expected);
    });
  }
});
