import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import { writeSvgFallback } from "./design-tool.js";
import {
  parseTokensCssPalette,
  potraceAvailability,
  validateDesignSvg,
  vectorizeDesignAsset,
} from "./design-vectorize.js";

const potrace = potraceAvailability().available;

function skipWithoutPotrace(t: { skip: (reason?: string) => void }): void {
  if (!potrace) t.skip("potrace not installed");
}

async function fixtureMark(dir: string, name = "mark.png"): Promise<string> {
  const size = 256;
  const raw = Buffer.alloc(size * size * 4, 0);
  const set = (x: number, y: number, rgb: [number, number, number]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    raw[i] = rgb[0];
    raw[i + 1] = rgb[1];
    raw[i + 2] = rgb[2];
    raw[i + 3] = 255;
  };
  const orange: [number, number, number] = [0xd9, 0x48, 0x0f];
  const ink: [number, number, number] = [0x1b, 0x3a, 0x4b];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 66;
      const dy = y - 103;
      if (dx * dx + dy * dy <= 46 * 46) set(x, y, orange);
      if (x >= 90 && x <= 112 && y >= 40 && y <= 166) set(x, y, ink);
    }
  }
  const path = join(dir, name);
  await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(path);
  return path;
}

describe("design-vectorize", { concurrency: 1 }, () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  function root(): string {
    const dir = mkdtempSync(join(tmpdir(), "slop-vec-"));
    roots.push(dir);
    mkdirSync(join(dir, ".slopcontrol", "design-loops", "loop-1", "assets"), {
      recursive: true,
    });
    return dir;
  }

  it("parseTokensCssPalette reads :root hexes only", () => {
    const parsed = parseTokensCssPalette(`
      :root { --ink: #1B3A4B; --accent: #D9480F; --glass: rgba(0,0,0,0.4); }
      [data-theme="light"] { --ink: #FFFFFF; }
    `);
    assert.deepEqual(
      parsed.map((p) => p.name),
      ["--ink", "--accent"],
    );
    assert.equal(parsed[0]?.hex, "#1B3A4B");
    assert.equal(parsed.some((p) => p.hex === "#FFFFFF"), false);
  });

  it("traces a 2-colour mark", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const tight = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "mark.svg",
      square: false,
      variants: [],
      previewSizes: [64],
      palette: ["#D9480F", "#1B3A4B"],
    });
    assert.ok(Math.abs(tight.report.crop.w - 93) <= 4, JSON.stringify(tight.report.crop));
    assert.ok(Math.abs(tight.report.crop.h - 127) <= 4, JSON.stringify(tight.report.crop));
    const svg = readFileSync(tight.absolutePath, "utf8");
    const checks = await validateDesignSvg(svg, "master", {
      palette: ["#D9480F", "#1B3A4B"],
      snap: "tokens",
    });
    assert.equal(checks.find((c) => c.id === "is_svg")?.ok, true);
    assert.equal(checks.find((c) => c.id === "no_raster")?.ok, true);
    assert.equal(checks.find((c) => c.id === "renders")?.ok, true);
    assert.ok((svg.match(/<path\b/g) ?? []).length >= 2);
    assert.equal(new Set([...svg.matchAll(/fill="(#[0-9A-Fa-f]+)"/g)].map((m) => m[1])).size, 2);
    const vb = svg.match(/viewBox="([^"]+)"/)?.[1] ?? "";
    const parts = vb.split(/\s+/).map(Number);
    assert.ok(Math.abs((parts[2] ?? 0) - tight.report.crop.w) < 2, vb);
    assert.ok(Math.abs((parts[3] ?? 0) - tight.report.crop.h) < 2, vb);

    const squared = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "mark-square.svg",
      square: true,
      variants: [],
      previewSizes: [],
      palette: ["#D9480F", "#1B3A4B"],
    });
    const svb = readFileSync(squared.absolutePath, "utf8").match(/viewBox="([^"]+)"/)?.[1] ?? "";
    const sp = svb.split(/\s+/).map(Number);
    assert.ok(Math.abs((sp[2] ?? 0) - (sp[3] ?? 0)) < 0.2, svb);
    assert.ok(Math.abs((sp[2] ?? 0) - Math.max(tight.report.crop.w, tight.report.crop.h)) < 2, svb);
  });

  it("snaps to the palette and keeps a far colour only for tokens+extra", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const snapped = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "snapped.svg",
      variants: [],
      previewSizes: [],
      palette: ["#D4470E", "#1A3B4C"],
    });
    const fills = [
      ...readFileSync(snapped.absolutePath, "utf8").matchAll(/fill="(#[0-9A-Fa-f]+)"/g),
    ].map((m) => m[1]);
    assert.ok(fills.every((f) => f === "#D4470E" || f === "#1A3B4C"), fills.join(","));

    const raw = await sharp(join(dir, "mark.png")).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    });
    const px = raw.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 0x1b && px[i + 1] === 0x3a) {
        px[i] = 0x22;
        px[i + 1] = 0xc5;
        px[i + 2] = 0x5e;
      }
    }
    await sharp(px, {
      raw: { width: raw.info.width, height: raw.info.height, channels: 4 },
    })
      .png()
      .toFile(join(dir, "far.png"));
    const merged = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "far.png",
      filename: "far-tokens.svg",
      variants: [],
      previewSizes: [],
      snap: "tokens",
      palette: ["#D9480F", "#1B3A4B"],
    });
    assert.ok(merged.report.warnings.some((w) => w.startsWith("far_cluster")));
    const kept = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "far.png",
      filename: "far-extra.svg",
      variants: [],
      previewSizes: [],
      snap: "tokens+extra",
      palette: ["#D9480F", "#1B3A4B"],
    });
    const extraFills = [
      ...readFileSync(kept.absolutePath, "utf8").matchAll(/fill="(#[0-9A-Fa-f]+)"/g),
    ].map((m) => m[1]);
    assert.ok(extraFills.includes("#22C55E"), extraFills.join(","));
  });

  it("colorMap transparent removes a colour", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const out = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "mapped.svg",
      variants: [],
      previewSizes: [],
      palette: ["#D9480F", "#1B3A4B"],
      colorMap: [{ from: "#1B3A4B", to: "transparent" }],
    });
    const fills = [
      ...readFileSync(out.absolutePath, "utf8").matchAll(/fill="(#[0-9A-Fa-f]+)"/g),
    ].map((m) => m[1]);
    assert.deepEqual([...new Set(fills)], ["#D9480F"]);
  });

  it("variantsOnly dropRegions remove subpaths from the variant", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const out = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "dropped.svg",
      square: false,
      variants: [32],
      previewSizes: [],
      palette: ["#D9480F", "#1B3A4B"],
      dropRegions: [{ x: 0.55, y: 0, w: 0.45, h: 1, variantsOnly: true }],
    });
    const master = readFileSync(out.absolutePath, "utf8");
    const variant = readFileSync(join(dir, "dropped-32.svg"), "utf8");
    const sub = (svg: string) => svg.match(/[Mm]/g)?.length ?? 0;
    assert.ok(sub(variant) < sub(master), `${sub(variant)} vs ${sub(master)}`);
  });

  it("writes retraced 16 and 32 variants that pass bytes and elements", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const out = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "logo.svg",
      palette: ["#D9480F", "#1B3A4B"],
    });
    for (const name of ["logo-32.svg", "logo-16.svg"]) {
      const svg = readFileSync(join(dir, name), "utf8");
      const profile = name.includes("16") ? "micro" : "small";
      const checks = await validateDesignSvg(svg, profile, {
        palette: ["#D9480F", "#1B3A4B"],
        snap: "tokens",
      });
      assert.equal(checks.find((c) => c.id === "bytes")?.ok, true, name);
      assert.equal(checks.find((c) => c.id === "elements")?.ok, true, name);
    }
    assert.ok(existsSync(join(dir, "logo-contact-sheet.png")));
    assert.ok(existsSync(join(dir, "logo.vectorize.json")));
    assert.equal(
      readdirSync(dir).filter((n) => n.startsWith("logo-preview-")).length,
      8,
    );
    assert.equal(out.op, "vectorize");
  });

  it("traces a black mark on a transparent plate", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    const size = 128;
    const raw = Buffer.alloc(size * size * 4, 0);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - 64;
        const dy = y - 64;
        if (dx * dx + dy * dy > 30 * 30) continue;
        const i = (y * size + x) * 4;
        raw[i] = 0x11;
        raw[i + 1] = 0x11;
        raw[i + 2] = 0x11;
        raw[i + 3] = 255;
      }
    }
    await sharp(raw, { raw: { width: size, height: size, channels: 4 } })
      .png()
      .toFile(join(dir, "ink.png"));
    const out = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "ink.png",
      filename: "ink.svg",
      variants: [],
      previewSizes: [],
    });
    assert.match(out.report.warnings.join(" "), /no_palette/);
    assert.match(readFileSync(out.absolutePath, "utf8"), /<path\b/);
  });

  it("validator rejects raster, embedded images, placeholders, and huge path counts", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    const raster = await validateDesignSvg(png, "master");
    assert.equal(raster.find((c) => c.id === "is_svg")?.ok, false);

    const embedded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><image href="data:image/png;base64,aaaa"/></svg>`;
    const emb = await validateDesignSvg(embedded, "master");
    assert.equal(emb.find((c) => c.id === "no_raster")?.ok, false);

    const dir = root();
    const fallback = writeSvgFallback({
      outPath: join(dir, "ph.png"),
      prompt: "Mark",
      brandName: "Mark",
    });
    const ph = await validateDesignSvg(readFileSync(fallback.path), "master");
    assert.equal(ph.find((c) => c.id === "has_paths")?.ok, false);
    assert.equal(ph.find((c) => c.id === "flat_only")?.ok, false);

    const gradient = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><linearGradient id="g"/><path fill="url(#g)" d="M0 0h8v8z"/></svg>`;
    const grad = await validateDesignSvg(gradient, "master");
    assert.equal(grad.find((c) => c.id === "flat_only")?.ok, false);

    const paths = Array.from({ length: 500 }, (_, i) => `<path fill="#111111" d="M${i} 0h1v1z"/>`).join("");
    const huge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 2">${paths}</svg>`;
    const many = await validateDesignSvg(huge, "master");
    assert.equal(many.find((c) => c.id === "elements")?.ok, false);
    assert.equal(many.find((c) => c.id === "bytes")?.ok, false);
  });

  it("is deterministic and does not replace a passing svg when validation fails", async (t) => {
    skipWithoutPotrace(t);
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const a = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "stable.svg",
      variants: [],
      previewSizes: [],
      palette: ["#D9480F", "#1B3A4B"],
    });
    const b = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "stable.svg",
      variants: [],
      previewSizes: [],
      palette: ["#D9480F", "#1B3A4B"],
    });
    assert.equal(
      readFileSync(a.absolutePath).toString("utf8"),
      readFileSync(b.absolutePath).toString("utf8"),
    );
    const kept = readFileSync(a.absolutePath);
    writeFileSync(join(dir, "empty.png"), await sharp({
      create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer());
    await assert.rejects(
      () =>
        vectorizeDesignAsset({
          projectRoot,
          loopId: "loop-1",
          sourceFilename: "empty.png",
          filename: "stable.svg",
          variants: [],
          previewSizes: [],
        }),
      /invalid_params|empty artwork/,
    );
    assert.equal(readFileSync(join(dir, "stable.svg")).equals(kept), true);

    const passing = readFileSync(join(dir, "stable.svg"));
    const broken = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "mark.png",
      filename: "stable.svg",
      variants: [],
      previewSizes: [],
      potrace: { turdsize: 1_000_000 },
    });
    assert.equal(broken.status, "failed");
    assert.equal(readFileSync(join(dir, "stable.svg")).equals(passing), true);
    assert.ok(existsSync(join(dir, "stable.failed.svg")));
  });

  it("throws potrace_not_found when the binary is missing", async () => {
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    await fixtureMark(dir);
    const prev = process.env.SLOPCONTROL_POTRACE_BIN;
    process.env.SLOPCONTROL_POTRACE_BIN = "/nonexistent/potrace";
    try {
      await assert.rejects(
        () =>
          vectorizeDesignAsset({
            projectRoot,
            loopId: "loop-1",
            sourceFilename: "mark.png",
            filename: "missing.svg",
            variants: [],
            previewSizes: [],
          }),
        /potrace_not_found/,
      );
    } finally {
      if (prev === undefined) delete process.env.SLOPCONTROL_POTRACE_BIN;
      else process.env.SLOPCONTROL_POTRACE_BIN = prev;
    }
  });

  it("an svg source is validate-only and writes no new svg", async () => {
    const projectRoot = root();
    const dir = join(projectRoot, ".slopcontrol", "design-loops", "loop-1", "assets");
    const svgPath = join(dir, "already.svg");
    writeFileSync(
      svgPath,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" role="img"><title>mark</title><path fill="#D9480F" d="M1 1h8v8H1z"/></svg>\n`,
    );
    const before = readFileSync(svgPath);
    const out = await vectorizeDesignAsset({
      projectRoot,
      loopId: "loop-1",
      sourceFilename: "already.svg",
      palette: ["#D9480F"],
    });
    assert.equal(out.validateOnly, true);
    assert.equal(readFileSync(svgPath).equals(before), true);
    assert.equal(
      readdirSync(dir).filter((n) => n.endsWith(".svg")).length,
      1,
    );
  });
});
