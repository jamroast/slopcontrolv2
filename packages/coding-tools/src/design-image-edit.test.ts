import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import sharp from "sharp";
import {
  deriveIconPackFromAsset,
  makeTransparentDesignAsset,
  promptLooksLikeImageEdit,
} from "./design-image-edit.js";

describe("design-image-edit", () => {
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

  it("makeTransparentDesignAsset produces RGBA with transparent corners", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-img-edit-"));
    roots.push(root);
    const loopId = "loop-1";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const src = join(dir, "mark.png");
    // 32x32: black border, orange center
    const size = 32;
    const buf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3;
        const edge = x < 2 || y < 2 || x >= size - 2 || y >= size - 2;
        if (edge) {
          buf[i] = 0;
          buf[i + 1] = 0;
          buf[i + 2] = 0;
        } else {
          buf[i] = 232;
          buf[i + 1] = 67;
          buf[i + 2] = 10;
        }
      }
    }
    await sharp(buf, { raw: { width: size, height: size, channels: 3 } })
      .png()
      .toFile(src);

    const out = await makeTransparentDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "mark.png",
      threshold: 20,
    });
    assert.equal(out.hasAlpha, true);
    assert.match(out.relativePath, /mark-alpha\.png$/);

    const meta = await sharp(out.absolutePath).metadata();
    assert.equal(meta.hasAlpha, true);
    const { data, info } = await sharp(out.absolutePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    // corner should be transparent
    assert.equal(data[3], 0);
    // center-ish should keep orange with high alpha
    const cx = Math.floor(info.width / 2);
    const cy = Math.floor(info.height / 2);
    const ci = (cy * info.width + cx) * 4;
    assert.ok(data[ci + 3]! > 200);
    assert.ok(data[ci]! > 200);
  });

  it("deriveIconPackFromAsset writes multiple sizes", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-icon-pack-"));
    roots.push(root);
    const loopId = "loop-2";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r: 232, g: 67, b: 10, alpha: 1 },
      },
    })
      .png()
      .toFile(join(dir, "logo.png"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "logo.png",
      sizes: [16, 32],
      prefix: "logo",
    });
    assert.equal(pack.files.length, 2);
    assert.ok(pack.files.some((f) => f.size === 16));
    assert.ok(pack.files.some((f) => f.filename === "logo-32.png"));
  });

  it("promptLooksLikeImageEdit classifies edit asks", () => {
    assert.equal(promptLooksLikeImageEdit("change to alpha channel"), true);
    assert.equal(promptLooksLikeImageEdit("invent a new logo mark"), false);
  });

  it("deriveIconPack redirects fake-alpha RGB to true RGBA sibling", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-fake-alpha-"));
    roots.push(root);
    const loopId = "loop-3";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });

    // Fake alpha (RGB black bg)
    await sharp({
      create: {
        width: 32,
        height: 32,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(join(dir, "jamroast-ember-monogram-alpha-v7.png"));

    // True RGBA
    const rgba = Buffer.alloc(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      rgba[i * 4] = 232;
      rgba[i * 4 + 1] = 67;
      rgba[i * 4 + 2] = 10;
      rgba[i * 4 + 3] = i < 32 ? 0 : 255;
    }
    await sharp(rgba, { raw: { width: 32, height: 32, channels: 4 } })
      .png()
      .toFile(join(dir, "ember-monogram-alpha.png"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "jamroast-ember-monogram-alpha-v7.png",
      preferredFilename: "ember-monogram-alpha.png",
      sizes: [16, 32],
      prefix: "icon-v9",
    });
    assert.equal(pack.sourceFilename, "ember-monogram-alpha.png");
    assert.equal(pack.redirectedFrom, "jamroast-ember-monogram-alpha-v7.png");
    assert.equal(pack.hasAlpha, true);
    const meta = await sharp(join(dir, "icon-v9-32.png")).metadata();
    assert.equal(meta.hasAlpha, true);
  });
});
