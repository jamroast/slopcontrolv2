import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import sharp from "sharp";
import {
  alphaOutputFilename,
  buildIcoFromPngs,
  circularMaskDesignAsset,
  deriveFaviconPackFromAsset,
  deriveIconPackFromAsset,
  applyDesignImagePipeline,
  makeTransparentDesignAsset,
  promptLooksLikeImageEdit,
  sampleCornerKeyRgb,
} from "./design-image-edit.js";
import { potraceAvailability } from "./design-vectorize.js";

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

  it("alphaOutputFilename never stacks -alpha-alpha", () => {
    assert.equal(alphaOutputFilename("mark.png"), "mark-alpha.png");
    assert.equal(alphaOutputFilename("mark-alpha.png"), "mark-alpha.png");
    assert.equal(
      alphaOutputFilename("mark-alpha-alpha.png"),
      "mark-alpha.png",
    );
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
      circularFallback: false,
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

  it("auto-keys charcoal plate corners (charcoal plate)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-charcoal-"));
    roots.push(root);
    const loopId = "loop-charcoal";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const size = 64;
    const buf = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 3;
        const dx = x - size / 2;
        const dy = y - size / 2;
        const inCircle = Math.hypot(dx, dy) < size * 0.35;
        if (inCircle) {
          buf[i] = 232;
          buf[i + 1] = 67;
          buf[i + 2] = 10;
        } else {
          // charcoal plate (~#222), not pure black
          buf[i] = 34;
          buf[i + 1] = 36;
          buf[i + 2] = 35;
        }
      }
    }
    await sharp(buf, { raw: { width: size, height: size, channels: 3 } })
      .png()
      .toFile(join(dir, "circular-mark.png"));

    const out = await makeTransparentDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "circular-mark.png",
      circularFallback: false,
    });
    assert.equal(out.relativePath.endsWith("circular-mark-alpha.png"), true);
    const { data, info } = await sharp(out.absolutePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.ok(data[3]! < 16, "corner should be transparent after auto-key");
    const ci =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
      4;
    assert.ok(data[ci + 3]! > 200);
    assert.ok(data[ci]! > 200);
  });

  it("circularMaskDesignAsset clears outside circle, keeps interior", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-circle-mask-"));
    roots.push(root);
    const loopId = "loop-circle";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const size = 64;
    await sharp({
      create: {
        width: size,
        height: size,
        channels: 3,
        background: { r: 34, g: 36, b: 35 },
      },
    })
      .composite([
        {
          input: await sharp({
            create: {
              width: 30,
              height: 30,
              channels: 3,
              background: { r: 232, g: 67, b: 10 },
            },
          })
            .png()
            .toBuffer(),
          left: 17,
          top: 17,
        },
      ])
      .png()
      .toFile(join(dir, "plate.png"));

    const out = await circularMaskDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "plate.png",
    });
    assert.match(out.relativePath, /plate-alpha\.png$/);
    const { data, info } = await sharp(out.absolutePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 0);
    const ci =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
      4;
    assert.ok(data[ci + 3]! > 200);
  });

  it("re-keying an -alpha source overwrites without -alpha-alpha", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-no-stack-"));
    roots.push(root);
    const loopId = "loop-stack";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(join(dir, "mark.png"));
    await sharp({
      create: {
        width: 16,
        height: 16,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toFile(join(dir, "mark-alpha.png"));

    const out = await makeTransparentDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "mark-alpha.png",
      circularFallback: false,
    });
    // Prefer non-alpha sibling mark.png → out mark-alpha.png (not mark-alpha-alpha)
    assert.equal(out.sourceFilename, "mark.png");
    assert.match(out.relativePath, /mark-alpha\.png$/);
    assert.equal(out.relativePath.includes("alpha-alpha"), false);
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
    assert.equal(promptLooksLikeImageEdit("cut out the circular logo"), true);
    assert.equal(promptLooksLikeImageEdit("invent a new logo mark"), false);
    assert.equal(promptLooksLikeImageEdit("vectorize the logo"), true);
    assert.equal(promptLooksLikeImageEdit("trace this png"), true);
    assert.equal(promptLooksLikeImageEdit("convert the png to svg"), true);
    assert.equal(promptLooksLikeImageEdit("make an SVG version of the mark"), true);
    assert.equal(promptLooksLikeImageEdit("remove the background"), true);
    assert.equal(promptLooksLikeImageEdit("remove its bg"), true);
    assert.equal(promptLooksLikeImageEdit("invent a new logo for a coffee brand"), false);
    assert.equal(promptLooksLikeImageEdit("generate a wide hero banner"), false);
    assert.equal(promptLooksLikeImageEdit("design an icon set from scratch"), false);
    assert.equal(promptLooksLikeImageEdit("an svg-friendly flat style"), false);
  });

  it("does not key a disk that is already on a transparent plate", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-alpha-disk-"));
    roots.push(root);
    const loopId = "loop-alpha";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const size = 48;
    const raw = Buffer.alloc(size * size * 4, 0);
    const paint = (rgb: [number, number, number]) => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const dx = x - size / 2;
          const dy = y - size / 2;
          if (Math.hypot(dx, dy) >= size * 0.28) continue;
          const i = (y * size + x) * 4;
          raw[i] = rgb[0];
          raw[i + 1] = rgb[1];
          raw[i + 2] = rgb[2];
          raw[i + 3] = 255;
        }
      }
    };
    paint([0, 0, 0]);
    const { data: cornerPx, info: cornerInfo } = await sharp(raw, {
      raw: { width: size, height: size, channels: 4 },
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(sampleCornerKeyRgb(cornerPx, cornerInfo.width, cornerInfo.height), null);

    await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "mark.png"));
    const black = await makeTransparentDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "mark.png",
      filename: "mark-alpha.png",
    });
    assert.equal(black.alreadyTransparent, true);
    const blackRaw = await sharp(black.absolutePath).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const bci =
      (Math.floor(blackRaw.info.height / 2) * blackRaw.info.width +
        Math.floor(blackRaw.info.width / 2)) *
      4;
    assert.equal(blackRaw.data[bci + 3], 255);

    raw.fill(0);
    paint([0x11, 0x11, 0x11]);
    await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "char.png"));
    const charcoal = await makeTransparentDesignAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "char.png",
      filename: "char-alpha.png",
    });
    const cRaw = await sharp(charcoal.absolutePath).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const cci =
      (Math.floor(cRaw.info.height / 2) * cRaw.info.width +
        Math.floor(cRaw.info.width / 2)) *
      4;
    assert.equal(cRaw.data[cci + 3], 255);
    assert.equal(cRaw.data[cci], 0x11);
  });

  it("assetsDir scope: icon pack + alpha derive without a loopId (design stage)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-phase-assets-"));
    roots.push(root);
    const assetsDir = ".slopcontrol/phases/22-x/design/assets";
    const dir = join(root, assetsDir);
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
      .toFile(join(dir, "pinned-logo.png"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "pinned-logo.png",
      sizes: [16, 32],
      prefix: "icon-pack",
    });
    assert.equal(pack.files.length, 2);
    assert.ok(
      pack.files.every((f) =>
        f.relativePath.startsWith(".slopcontrol/phases/22-x/design/assets/"),
      ),
    );

    const alpha = await makeTransparentDesignAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "pinned-logo.png",
    });
    assert.equal(alpha.hasAlpha, true);
    assert.match(alpha.relativePath, /22-x\/design\/assets\/pinned-logo-alpha\.png$/);
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
      .toFile(join(dir, "mark-alpha-v7.png"));

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
      .toFile(join(dir, "mark-alpha.png"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "mark-alpha-v7.png",
      preferredFilename: "mark-alpha.png",
      sizes: [16, 32],
      prefix: "icon-v9",
    });
    assert.equal(pack.sourceFilename, "mark-alpha.png");
    assert.equal(pack.redirectedFrom, "mark-alpha-v7.png");
    assert.equal(pack.hasAlpha, true);
    const meta = await sharp(join(dir, "icon-v9-32.png")).metadata();
    assert.equal(meta.hasAlpha, true);
  });

  it("vectorize must be the last pipeline op", async () => {
    await assert.rejects(
      () =>
        applyDesignImagePipeline({
          projectRoot: "/tmp/unused",
          loopId: "loop-1",
          sourceFilename: "mark.png",
          ops: [
            { op: "vectorize" },
            { op: "resize", params: { width: 16 } },
          ],
        }),
      /vectorize must be the last op/,
    );
  });

  it("trim then vectorize traces the trimmed raster", async (t) => {
    if (!potraceAvailability().available) t.skip("potrace not installed");
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-pipe-"));
    roots.push(projectRoot);
    const loopId = "loop-vec";
    const dir = join(projectRoot, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const size = 48;
    const raw = Buffer.alloc(size * size * 4, 0);
    for (let y = 8; y < 40; y++) {
      for (let x = 8; x < 40; x++) {
        const i = (y * size + x) * 4;
        raw[i] = 0xd9;
        raw[i + 1] = 0x48;
        raw[i + 2] = 0x0f;
        raw[i + 3] = 255;
      }
    }
    await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "mark.png"));
    const out = await applyDesignImagePipeline({
      projectRoot,
      loopId,
      sourceFilename: "mark.png",
      ops: [{ op: "trim" }, { op: "vectorize", params: { variants: [], previewSizes: [] } }],
    });
    assert.match(out.summaries.join("\n"), /Vectorized/);
    assert.ok(out.results.at(-1)?.relativePath.endsWith(".svg"));
  });

  it("icon pack source prefers the larger true-RGBA raster when names tie", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-icon-area-"));
    roots.push(root);
    const loopId = "loop-icon-area";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });

    // Requested file claims alpha but is RGB — forces the sibling search.
    await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toFile(join(dir, "brand-fake-alpha.png"));

    // Two true-RGBA candidates with identical naming signals: only area can
    // break the tie (the bigger raster is the master, not a derived tile).
    const writeRgba = async (name: string, size: number): Promise<void> => {
      const px = Buffer.alloc(size * size * 4, 0);
      for (let i = 0; i < size * size; i++) {
        px[i * 4] = 0xd9;
        px[i * 4 + 1] = 0x48;
        px[i * 4 + 2] = 0x0f;
        px[i * 4 + 3] = i < size ? 0 : 255;
      }
      await sharp(px, { raw: { width: size, height: size, channels: 4 } })
        .png()
        .toFile(join(dir, name));
    };
    await writeRgba("small-alpha.png", 24);
    await writeRgba("large-alpha.png", 96);

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "brand-fake-alpha.png",
      sizes: [16],
      prefix: "icon-area",
    });
    assert.equal(pack.sourceFilename, "large-alpha.png");
    assert.equal(pack.redirectedFrom, "brand-fake-alpha.png");
  });

  it("circularMaskDesignAsset runs on an assetsDir scope without a loopId", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-circle-scope-"));
    roots.push(root);
    const assetsDir = ".slopcontrol/phases/p1/design/assets";
    const dir = join(root, assetsDir);
    mkdirSync(dir, { recursive: true });
    const size = 64;
    const px = Buffer.alloc(size * size * 4, 0);
    for (let i = 0; i < size * size; i++) {
      px[i * 4] = 0x1b;
      px[i * 4 + 1] = 0x3a;
      px[i * 4 + 2] = 0x4b;
      px[i * 4 + 3] = 255;
    }
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "mark.png"));

    const out = await circularMaskDesignAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "mark.png",
      filename: "mark-circle.png",
    });
    assert.equal(out.relativePath, `${assetsDir}/mark-circle.png`);
    assert.ok(existsSync(out.absolutePath));
    const meta = await sharp(out.absolutePath).metadata();
    assert.equal(meta.hasAlpha, true);
    // Corner masked away, centre kept.
    const { data, info } = await sharp(out.absolutePath)
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.channels, 4);
    assert.equal(data[3], 0);
    const centre = ((info.height >> 1) * info.width + (info.width >> 1)) * 4;
    assert.equal(data[centre + 3], 255);
  });

  it("deriveIconPackFromAsset renders 16/32 from SVG variants and larger sizes from the master", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-icon-svg-"));
    roots.push(root);
    const assetsDir = ".slopcontrol/phases/p1/design/assets";
    const dir = join(root, assetsDir);
    mkdirSync(dir, { recursive: true });
    const size = 64;
    const px = Buffer.alloc(size * size * 4, 0);
    for (let i = 0; i < size * size; i++) px[i * 4 + 3] = 255;
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "mark.png"));

    const svg = (label: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img"><title>${label}</title><path fill="#D9480F" d="M0 0h16v16H0z"/></svg>\n`;
    writeFileSync(join(dir, "mark-16.svg"), svg("m16"));
    writeFileSync(join(dir, "mark-32.svg"), svg("m32"));
    writeFileSync(join(dir, "mark.svg"), svg("master"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "mark.png",
      sizes: [16, 32, 64],
      prefix: "icon-v1",
    });
    assert.deepEqual(
      pack.files.map((f) => [f.size, f.renderedFrom?.filename, f.renderedFrom?.kind]),
      [
        [16, "mark-16.svg", "variant"],
        [32, "mark-32.svg", "variant"],
        [64, "mark.svg", "master"],
      ],
    );
    const tile = readFileSync(join(dir, "icon-v1-16.png"));
    assert.equal(tile.subarray(0, 4).toString("hex"), "89504e47");
    const meta = await sharp(join(dir, "icon-v1-16.png")).metadata();
    assert.equal(meta.width, 16);
    assert.equal(meta.hasAlpha, true);
    // The 16px tile comes from the full-bleed variant, not a padded downscale.
    const { data, info } = await sharp(join(dir, "icon-v1-16.png"))
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(data[3], 255);
    assert.equal(info.width, 16);
  });

  it("raster-only icon packs trim transparent padding before resizing", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-icon-trim-"));
    roots.push(root);
    const loopId = "loop-trim";
    const dir = join(root, ".slopcontrol", "design-loops", loopId, "assets");
    mkdirSync(dir, { recursive: true });
    const size = 96;
    const px = Buffer.alloc(size * size * 4, 0);
    for (let y = 36; y < 60; y++) {
      for (let x = 36; x < 60; x++) {
        const i = (y * size + x) * 4;
        px[i] = 0xd9;
        px[i + 1] = 0x48;
        px[i + 2] = 0x0f;
        px[i + 3] = 255;
      }
    }
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "padded.png"));

    const pack = await deriveIconPackFromAsset({
      projectRoot: root,
      loopId,
      sourceFilename: "padded.png",
      sizes: [16],
      prefix: "icon-trim",
    });
    assert.equal(pack.files[0]?.renderedFrom?.kind, "raster");
    const { data, info } = await sharp(
      join(dir, "icon-trim-16.png"),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    let minX = info.width;
    let maxX = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (data[(y * info.width + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    // Untrimmed would be 24/96 of 16px ≈ 4px wide; trimmed fills the tile.
    assert.ok(maxX - minX + 1 >= 12, `opaque bbox ${maxX - minX + 1}px too small`);
  });

  it("buildIcoFromPngs writes header, directory entries and PNG payloads", () => {
    const a = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const b = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 5, 6, 7, 8]);
    const ico = buildIcoFromPngs([
      { size: 16, png: a },
      { size: 32, png: b },
    ]);
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    const e0 = 6;
    const e1 = 6 + 16;
    assert.equal(ico.readUInt8(e0), 16);
    assert.equal(ico.readUInt8(e1), 32);
    assert.equal(ico.readUInt16LE(e0 + 6), 32); // 32bpp
    const off0 = ico.readUInt32LE(e0 + 12);
    const off1 = ico.readUInt32LE(e1 + 12);
    assert.equal(off0, 6 + 16 * 2);
    assert.equal(off1, off0 + a.length);
    assert.equal(ico.readUInt32LE(e0 + 8), a.length);
    assert.deepEqual(ico.subarray(off0, off0 + a.length), a);
    assert.deepEqual(ico.subarray(off1, off1 + b.length), b);
  });

  it("favicon pack: multi-size ico + maskable PNGs from SVG variants", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-favicon-"));
    roots.push(root);
    const assetsDir = ".slopcontrol/phases/p1/design/assets";
    const dir = join(root, assetsDir);
    mkdirSync(dir, { recursive: true });
    const size = 64;
    const px = Buffer.alloc(size * size * 4, 0);
    for (let i = 0; i < size * size; i++) px[i * 4 + 3] = 255;
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "mark.png"));
    const svg = (label: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" role="img"><title>${label}</title><path fill="#D9480F" d="M0 0h16v16H0z"/></svg>\n`;
    writeFileSync(join(dir, "mark-16.svg"), svg("m16"));
    writeFileSync(join(dir, "mark-32.svg"), svg("m32"));
    writeFileSync(join(dir, "mark.svg"), svg("master"));

    const pack = await deriveFaviconPackFromAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "mark.png",
      prefix: "site",
    });
    assert.equal(pack.icoFilename, "site.ico");
    assert.deepEqual(
      pack.files.map((f) => f.filename),
      ["site.ico", "site-maskable-192.png", "site-maskable-512.png"],
    );
    for (const file of pack.files) {
      assert.ok(existsSync(join(dir, file.filename)));
    }

    const ico = readFileSync(join(dir, "site.ico"));
    assert.equal(ico.readUInt16LE(0), 0);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 3);
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const base = 6 + i * 16;
      sizes.push(ico.readUInt8(base));
      const len = ico.readUInt32LE(base + 8);
      const off = ico.readUInt32LE(base + 12);
      assert.equal(ico.subarray(off, off + 4).toString("hex"), "89504e47");
      assert.ok(off + len <= ico.length);
    }
    assert.deepEqual(sizes, [16, 32, 48]);

    const maskableAbs = join(dir, "site-maskable-192.png");
    const meta = await sharp(maskableAbs).metadata();
    assert.equal(meta.width, 192);
    assert.equal(meta.height, 192);
    assert.equal(meta.hasAlpha, true);
    const raw = await sharp(maskableAbs).raw().toBuffer({ resolveWithObject: true });
    let minX = raw.info.width;
    let maxX = -1;
    for (let y = 0; y < raw.info.height; y++) {
      for (let x = 0; x < raw.info.width; x++) {
        if (raw.data[(y * raw.info.width + x) * 4 + 3]! > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    // 80% safe zone: 192 * 0.8 = 153.6 → 154px of content.
    const bbox = maxX - minX + 1;
    assert.ok(bbox >= 150 && bbox <= 158, `maskable bbox ${bbox} outside safe zone`);
    assert.equal(raw.data[3], 0); // transparent padding by default
  });

  it("favicon pack raster fallback fills the padding with the requested background", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-favicon-bg-"));
    roots.push(root);
    const assetsDir = ".slopcontrol/phases/p1/design/assets";
    const dir = join(root, assetsDir);
    mkdirSync(dir, { recursive: true });
    const size = 96;
    const px = Buffer.alloc(size * size * 4, 0);
    for (let y = 36; y < 60; y++) {
      for (let x = 36; x < 60; x++) {
        const i = (y * size + x) * 4;
        px[i] = 0xd9;
        px[i + 1] = 0x48;
        px[i + 2] = 0x0f;
        px[i + 3] = 255;
      }
    }
    await sharp(px, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "padded.png"));

    const pack = await deriveFaviconPackFromAsset({
      projectRoot: root,
      assetsDir,
      sourceFilename: "padded.png",
      prefix: "fallback",
      icoSizes: [16],
      maskableSizes: [64],
      background: "#112233",
    });
    assert.equal(pack.files[1]?.renderedFrom?.kind, "raster");
    const { data, info } = await sharp(
      join(dir, "fallback-maskable-64.png"),
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.deepEqual([...data.subarray(0, 4)], [0x11, 0x22, 0x33, 255]);
    let minX = info.width;
    let maxX = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        if (data[i] !== 0x11 || data[i + 1] !== 0x22 || data[i + 2] !== 0x33) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
        }
      }
    }
    // Art trimmed then scaled to 64 * 0.8 = 51.
    const bbox = maxX - minX + 1;
    assert.ok(bbox >= 48 && bbox <= 54, `art bbox ${bbox} not 80% of 64`);
  });
});
