import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { designLoopAssetsDir } from "./design-media.js";
import { assertDesignImageOp } from "./design-image-catalog.js";

function claimsAlphaInName(name: string): boolean {
  return /(?:^|[-_.])alpha(?:[-_.]|$)|transparent|rgba/i.test(name);
}

/**
 * Asset scope: a design loop (`loopId`) or an arbitrary project-relative dir
 * (`assetsDir`, e.g. a phase design dir during the design stage).
 */
export type AssetScope = {
  projectRoot: string;
  loopId?: string;
  assetsDir?: string;
};

function scopeAssetsDir(scope: AssetScope): string {
  if (scope.assetsDir) {
    return resolve(resolve(scope.projectRoot), scope.assetsDir);
  }
  if (!scope.loopId) {
    throw new Error("loopId or assetsDir required for design asset op");
  }
  return resolve(designLoopAssetsDir(scope.projectRoot, scope.loopId));
}

async function assetHasAlpha(absolutePath: string): Promise<boolean> {
  const meta = await sharp(absolutePath).metadata();
  return meta.hasAlpha === true;
}

/**
 * Resolve a safe icon-pack source: reject fake-*alpha* RGB files when a true
 * RGBA sibling (or preferredFilename) exists.
 */
export async function resolveIconPackSourceFilename(opts: {
  projectRoot: string;
  loopId?: string;
  /** Project-relative assets dir — alternative to loopId (design stage). */
  assetsDir?: string;
  sourceFilename?: string;
  /** Pinned or preferred mark (used when source missing / invalid). */
  preferredFilename?: string;
}): Promise<{ filename: string; hasAlpha: boolean; redirectedFrom?: string }> {
  const dir = scopeAssetsDir(opts);
  mkdirSync(dir, { recursive: true });

  const tryFile = async (
    name: string | undefined,
  ): Promise<{ filename: string; hasAlpha: boolean } | null> => {
    if (!name?.trim()) return null;
    const base = safeBasename(name);
    const abs = resolve(dir, base);
    if (!existsSync(abs)) return null;
    return { filename: base, hasAlpha: await assetHasAlpha(abs) };
  };

  const listPngs = (): string[] => {
    try {
      return readdirSync(dir).filter((n) => /\.png$/i.test(n) && !n.startsWith("."));
    } catch {
      return [];
    }
  };

  const findTrueAlpha = async (
    preferStem?: string,
  ): Promise<{ filename: string; hasAlpha: boolean } | null> => {
    const names = listPngs();
    const scored: Array<{ filename: string; score: number }> = [];
    for (const n of names) {
      const abs = resolve(dir, n);
      if (!(await assetHasAlpha(abs))) continue;
      let score = 1;
      if (preferStem && n.toLowerCase().includes(preferStem.toLowerCase())) {
        score += 5;
      }
      if (/ember|monogram/i.test(n)) score += 2;
      if (claimsAlphaInName(n)) score += 1;
      scored.push({ filename: n, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored[0]) return null;
    return { filename: scored[0].filename, hasAlpha: true };
  };

  const preferred = await tryFile(opts.preferredFilename);
  const requested = await tryFile(opts.sourceFilename);

  if (requested) {
    if (requested.hasAlpha) {
      return requested;
    }
    if (claimsAlphaInName(requested.filename)) {
      const stem = requested.filename
        .replace(/\.[^.]+$/, "")
        .replace(/[-_]?alpha.*$/i, "")
        .replace(/[-_]?v\d+$/i, "");
      const better =
        (preferred?.hasAlpha ? preferred : null) ||
        (await findTrueAlpha(stem)) ||
        (await findTrueAlpha());
      if (better) {
        return {
          ...better,
          redirectedFrom: requested.filename,
        };
      }
      throw new Error(
        `Asset ${requested.filename} claims alpha in its name but hasAlpha=false (RGB). Run make_transparent on the real mark first, or pass a true RGBA source.`,
      );
    }
    // Opaque source: prefer true-alpha preferred/sibling when available
    if (preferred?.hasAlpha) {
      return { ...preferred, redirectedFrom: requested.filename };
    }
    const better = await findTrueAlpha(
      requested.filename.replace(/\.[^.]+$/, ""),
    );
    if (better) {
      return { ...better, redirectedFrom: requested.filename };
    }
    return requested;
  }

  if (preferred) {
    if (preferred.hasAlpha || !claimsAlphaInName(preferred.filename)) {
      return preferred;
    }
    const better = await findTrueAlpha(
      preferred.filename.replace(/\.[^.]+$/, ""),
    );
    if (better) return { ...better, redirectedFrom: preferred.filename };
    throw new Error(
      `Preferred logo ${preferred.filename} claims alpha but hasAlpha=false`,
    );
  }

  const anyAlpha = await findTrueAlpha();
  if (anyAlpha) return anyAlpha;

  throw new Error(
    "No suitable icon-pack source — pin a logo or pass sourceFilename (prefer true RGBA)",
  );
}

function safeBasename(name: string): string {
  const base = basename(String(name ?? "").trim());
  if (!base || base.includes("..") || base !== String(name ?? "").trim()) {
    throw new Error(`Invalid asset filename: ${name}`);
  }
  return base;
}

function resolveScopedAsset(
  scope: AssetScope,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = scopeAssetsDir(scope);
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  if (!absolutePath.startsWith(dir + sep) && absolutePath !== dir) {
    throw new Error("Invalid asset path");
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`Asset not found: ${name}`);
  }
  return {
    absolutePath,
    relativePath: relative(resolve(scope.projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}

function outPathScoped(
  scope: AssetScope,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = scopeAssetsDir(scope);
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  if (!absolutePath.startsWith(dir + sep) && absolutePath !== dir) {
    throw new Error("Invalid output path");
  }
  return {
    absolutePath,
    relativePath: relative(resolve(scope.projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}

function resolveLoopAsset(
  projectRoot: string,
  loopId: string,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  return resolveScopedAsset({ projectRoot, loopId }, filename);
}

function outPath(
  projectRoot: string,
  loopId: string,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  return outPathScoped({ projectRoot, loopId }, filename);
}

export type MakeTransparentResult = {
  relativePath: string;
  absolutePath: string;
  width: number;
  height: number;
  hasAlpha: true;
  sourceFilename: string;
  /** True when chroma left corners opaque and circular soft-mask was applied. */
  usedCircularFallback?: boolean;
  keyRgb?: [number, number, number];
  threshold?: number;
};

/** Collapse `foo-alpha` / `foo-alpha-alpha` → `foo-alpha.png` (no stacking). */
export function alphaOutputFilename(
  sourceName: string,
  explicit?: string,
): string {
  if (explicit?.trim()) return safeBasename(explicit);
  const stem = sourceName.replace(/\.[^.]+$/, "");
  const base = stem
    .replace(/(?:-alpha)+$/i, "")
    .replace(/(?:-cutout)+$/i, "");
  return `${base || stem}-alpha.png`;
}

/**
 * If `name` looks like a prior alpha output and a non-alpha sibling exists,
 * prefer the sibling (avoids re-keying a failed charcoal "alpha" plate).
 */
export function preferNonAlphaSiblingFilename(
  projectRoot: string,
  loopId: string,
  name: string,
): string {
  return preferNonAlphaSiblingInScope({ projectRoot, loopId }, name);
}

/** Scope variant: works for design loops and phase design dirs alike. */
export function preferNonAlphaSiblingInScope(
  scope: AssetScope,
  name: string,
): string {
  const base = safeBasename(name);
  if (
    !/(?:-alpha)+\.png$/i.test(base) &&
    !/-cutout\.png$/i.test(base)
  ) {
    return base;
  }
  const sibling = base
    .replace(/(?:-alpha)+\.png$/i, ".png")
    .replace(/-cutout\.png$/i, ".png");
  if (sibling === base) return base;
  const dir = scopeAssetsDir(scope);
  if (existsSync(resolve(dir, sibling))) return sibling;
  return base;
}

function medianChannel(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
  }
  return sorted[mid]!;
}

/** Median RGB of the four corner pixels (and a 1px inward neighbor each). */
export function sampleCornerKeyRgb(
  px: Buffer,
  width: number,
  height: number,
): [number, number, number] {
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * 4;
    return [px[i]!, px[i + 1]!, px[i + 2]!];
  };
  const xs = [0, Math.min(1, width - 1), Math.max(0, width - 2), width - 1];
  const ys = [0, Math.min(1, height - 1), Math.max(0, height - 2), height - 1];
  const samples: Array<[number, number, number]> = [];
  for (const x of new Set(xs)) {
    for (const y of new Set(ys)) {
      if (
        (x <= 1 || x >= width - 2) &&
        (y <= 1 || y >= height - 2)
      ) {
        samples.push(at(x, y));
      }
    }
  }
  // Always include exact corners
  samples.push(at(0, 0), at(width - 1, 0), at(0, height - 1), at(width - 1, height - 1));
  return [
    medianChannel(samples.map((s) => s[0])),
    medianChannel(samples.map((s) => s[1])),
    medianChannel(samples.map((s) => s[2])),
  ];
}

/**
 * Adaptive chroma distance: clear charcoal plates (~#222) without eating
 * saturated mark colors. Floor 28 (legacy pure-black default).
 */
export function adaptiveChromaThreshold(
  keyRgb: [number, number, number],
  explicit?: number,
): number {
  if (explicit != null) return explicit;
  const luma = 0.2126 * keyRgb[0] + 0.7152 * keyRgb[1] + 0.0722 * keyRgb[2];
  // Dark plate: distance from black ≈ |key|; need headroom past that + soft edge.
  const fromBlack = Math.hypot(keyRgb[0], keyRgb[1], keyRgb[2]);
  if (luma <= 80) {
    return Math.max(28, Math.min(96, Math.ceil(fromBlack + 18)));
  }
  // Lighter plates (white/cream): still key near the sampled color.
  return Math.max(28, Math.min(72, Math.ceil(24 + fromBlack * 0.15)));
}

function applyChromaKey(
  px: Buffer,
  keyRgb: [number, number, number],
  threshold: number,
  soft: number,
): void {
  const [kr, kg, kb] = keyRgb;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i]!;
    const g = px[i + 1]!;
    const b = px[i + 2]!;
    const dist = Math.hypot(r - kr, g - kg, b - kb);
    if (dist <= threshold) {
      px[i + 3] = 0;
    } else if (dist < threshold + soft) {
      const t = (dist - threshold) / soft;
      px[i + 3] = Math.round(255 * t);
    }
  }
}

/** Soft circular alpha: outside radius fully transparent; soft rim; interior untouched. */
export function applyCircularSoftMask(
  px: Buffer,
  width: number,
  height: number,
  softPx = 2,
): void {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) / 2;
  const soft = Math.max(1, softPx);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d >= radius) {
        px[i + 3] = 0;
      } else if (d > radius - soft) {
        const t = (radius - d) / soft;
        px[i + 3] = Math.round(Math.min(px[i + 3]!, 255 * t));
      }
    }
  }
}

/** True when any exact corner still looks opaque (failed plate key). */
export function cornersStillOpaque(
  px: Buffer,
  width: number,
  height: number,
  alphaFloor = 200,
): boolean {
  const corners = [
    0,
    (width - 1) * 4,
    ((height - 1) * width) * 4,
    ((height - 1) * width + (width - 1)) * 4,
  ];
  return corners.some((i) => px[i + 3]! > alphaFloor);
}

async function writeRgbaPng(
  px: Buffer,
  width: number,
  height: number,
  absolutePath: string,
): Promise<void> {
  await sharp(px, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toFile(absolutePath);
}

/**
 * Convert near-key-color pixels to transparent (true RGBA).
 * Auto-samples corner key when keyRgb omitted. Falls back to circular soft
 * mask when corners stay opaque after chroma. Does not invent a new mark.
 */
export async function makeTransparentDesignAsset(opts: {
  projectRoot: string;
  loopId?: string;
  /** Project-relative assets dir — alternative to loopId (design stage). */
  assetsDir?: string;
  sourceFilename: string;
  /** Output filename (default: stable *-alpha.png, never *-alpha-alpha) */
  filename?: string;
  /** Max RGB distance from key to treat as transparent (0–441). */
  threshold?: number;
  keyRgb?: [number, number, number];
  /** Soft edge width in distance units (default 8). */
  softEdge?: number;
  /** When true (default), apply circular soft mask if chroma leaves opaque corners. */
  circularFallback?: boolean;
}): Promise<MakeTransparentResult> {
  const scope: AssetScope = {
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    assetsDir: opts.assetsDir,
  };
  const resolvedName = preferNonAlphaSiblingInScope(scope, opts.sourceFilename);
  const src = resolveScopedAsset(scope, resolvedName);
  const out = outPathScoped(scope, alphaOutputFilename(src.name, opts.filename));
  const soft = opts.softEdge ?? 8;

  const { data, info } = await sharp(src.absolutePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels < 4) {
    throw new Error("Expected RGBA buffer from sharp");
  }
  const px = Buffer.from(data);
  const keyRgb =
    opts.keyRgb ?? sampleCornerKeyRgb(px, info.width, info.height);
  const threshold = adaptiveChromaThreshold(keyRgb, opts.threshold);

  applyChromaKey(px, keyRgb, threshold, soft);

  let usedCircularFallback = false;
  if (
    opts.circularFallback !== false &&
    cornersStillOpaque(px, info.width, info.height)
  ) {
    applyCircularSoftMask(px, info.width, info.height);
    usedCircularFallback = true;
  }

  await writeRgbaPng(px, info.width, info.height, out.absolutePath);

  const meta = await sharp(out.absolutePath).metadata();
  if (meta.hasAlpha !== true) {
    throw new Error("make_transparent failed to produce RGBA PNG");
  }

  return {
    relativePath: out.relativePath,
    absolutePath: out.absolutePath,
    width: info.width,
    height: info.height,
    hasAlpha: true,
    sourceFilename: src.name,
    usedCircularFallback,
    keyRgb,
    threshold,
  };
}

/**
 * Geometric circular cut-out: soft circular alpha on an EXISTING asset.
 * Keeps interior pixels; does not invent a new mark.
 */
export async function circularMaskDesignAsset(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  filename?: string;
  softPx?: number;
}): Promise<MakeTransparentResult> {
  const resolvedName = preferNonAlphaSiblingFilename(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    resolvedName,
  );
  const out = outPath(
    opts.projectRoot,
    opts.loopId,
    alphaOutputFilename(src.name, opts.filename),
  );

  const { data, info } = await sharp(src.absolutePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels < 4) {
    throw new Error("Expected RGBA buffer from sharp");
  }
  const px = Buffer.from(data);
  applyCircularSoftMask(px, info.width, info.height, opts.softPx ?? 2);
  await writeRgbaPng(px, info.width, info.height, out.absolutePath);

  const meta = await sharp(out.absolutePath).metadata();
  if (meta.hasAlpha !== true) {
    throw new Error("circular_mask failed to produce RGBA PNG");
  }

  return {
    relativePath: out.relativePath,
    absolutePath: out.absolutePath,
    width: info.width,
    height: info.height,
    hasAlpha: true,
    sourceFilename: src.name,
  };
}

export async function resizeDesignAsset(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  width: number;
  height?: number;
  filename?: string;
}): Promise<{ relativePath: string; width: number; height: number }> {
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const w = opts.width;
  const h = opts.height ?? opts.width;
  const stem = src.name.replace(/\.[^.]+$/, "");
  const out = outPath(
    opts.projectRoot,
    opts.loopId,
    opts.filename ?? `${stem}-${w}.png`,
  );
  await sharp(src.absolutePath)
    .resize(w, h, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(out.absolutePath);
  return { relativePath: out.relativePath, width: w, height: h };
}

export async function trimDesignAsset(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  filename?: string;
}): Promise<{ relativePath: string }> {
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const stem = src.name.replace(/\.[^.]+$/, "");
  const out = outPath(
    opts.projectRoot,
    opts.loopId,
    opts.filename ?? `${stem}-trim.png`,
  );
  await sharp(src.absolutePath).trim().png().toFile(out.absolutePath);
  return { relativePath: out.relativePath };
}

export async function padDesignAsset(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  size: number;
  filename?: string;
}): Promise<{ relativePath: string }> {
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const stem = src.name.replace(/\.[^.]+$/, "");
  const out = outPath(
    opts.projectRoot,
    opts.loopId,
    opts.filename ?? `${stem}-pad-${opts.size}.png`,
  );
  const size = opts.size;
  await sharp(src.absolutePath)
    .resize(size, size, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(out.absolutePath);
  return { relativePath: out.relativePath };
}

export type DeriveIconPackResult = {
  sourceFilename: string;
  redirectedFrom?: string;
  hasAlpha: boolean;
  files: Array<{ size: number; relativePath: string; filename: string }>;
};

/** Resize source into favicon/icon pack sizes (deterministic). */
export async function deriveIconPackFromAsset(opts: {
  projectRoot: string;
  loopId?: string;
  /** Project-relative assets dir — alternative to loopId (design stage). */
  assetsDir?: string;
  sourceFilename?: string;
  preferredFilename?: string;
  sizes?: number[];
  /** Output basename prefix (default icon-pack). Prefer icon-vN for loop versions. */
  prefix?: string;
  /**
   * When true (default), refuse sources that claim alpha in the filename but
   * are RGB-only, unless a true RGBA redirect is found.
   */
  requireRealAlphaIfClaimed?: boolean;
}): Promise<DeriveIconPackResult> {
  const scope: AssetScope = {
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    assetsDir: opts.assetsDir,
  };
  const resolved = await resolveIconPackSourceFilename({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    assetsDir: opts.assetsDir,
    sourceFilename: opts.sourceFilename,
    preferredFilename: opts.preferredFilename,
  });
  if (
    opts.requireRealAlphaIfClaimed !== false &&
    claimsAlphaInName(resolved.filename) &&
    !resolved.hasAlpha
  ) {
    throw new Error(
      `Refusing icon pack from ${resolved.filename}: claims alpha but hasAlpha=false`,
    );
  }
  const sizes = opts.sizes?.length
    ? opts.sizes
    : [16, 24, 32, 48, 64, 128, 192, 512];
  const src = resolveScopedAsset(scope, resolved.filename);
  const packPrefix = (opts.prefix?.trim() || "icon-pack").replace(
    /[^a-z0-9_-]+/gi,
    "-",
  );
  const files: DeriveIconPackResult["files"] = [];
  for (const size of sizes) {
    const filename = `${packPrefix}-${size}.png`;
    const out = outPathScoped(scope, filename);
    await sharp(src.absolutePath)
      .ensureAlpha()
      .resize(size, size, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toFile(out.absolutePath);
    files.push({ size, relativePath: out.relativePath, filename });
  }
  return {
    sourceFilename: src.name,
    redirectedFrom: resolved.redirectedFrom,
    hasAlpha: resolved.hasAlpha,
    files,
  };
}

/** True when operator text asks for pixel edits, not invention. */
export function promptLooksLikeImageEdit(text: string): boolean {
  return /\b(alpha|transparent|transparency|remove\s*background|strip\s*black|chroma|cut\s*out|circular\s*mask|icon\s*pack|favicon|browser\s*pack|resize|trim|pad\s*image|rotate|greyscale|blur|sharpen|tint|crop|extract|flatten|modulate)\b/i.test(
    text ?? "",
  );
}

export type ApplyDesignImageOpResult = {
  op: string;
  relativePath: string;
  absolutePath: string;
  sourceFilename: string;
  summary: string;
  /** Extra outputs (e.g. icon pack files). */
  files?: Array<{ filename: string; relativePath: string; size?: number }>;
};

function editedOutputFilename(
  sourceName: string,
  suffix: string,
  explicit?: string,
): string {
  if (explicit?.trim()) return safeBasename(explicit);
  const stem = sourceName
    .replace(/\.[^.]+$/, "")
    .replace(/(?:-alpha)+$/i, "")
    .replace(/(?:-cutout)+$/i, "");
  return `${stem}-${suffix}.png`;
}

/**
 * Generic catalog executor — LLM picks op ids; sharp does the pixels.
 */
export async function applyDesignImageOp(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  op: string;
  params?: Record<string, unknown>;
}): Promise<ApplyDesignImageOpResult> {
  const op = assertDesignImageOp(opts.op);
  const params = opts.params ?? {};
  const filename =
    typeof params.filename === "string" ? params.filename : undefined;

  if (op === "make_transparent") {
    const result = await makeTransparentDesignAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      filename,
      threshold:
        typeof params.threshold === "number" ? params.threshold : undefined,
      softEdge:
        typeof params.softEdge === "number" ? params.softEdge : undefined,
    });
    const fallback = result.usedCircularFallback
      ? " (circular soft-mask fallback)"
      : "";
    return {
      op,
      relativePath: result.relativePath,
      absolutePath: result.absolutePath,
      sourceFilename: result.sourceFilename,
      summary: `Keyed plate → alpha${fallback}: ${result.sourceFilename} → ${basename(result.relativePath)}`,
    };
  }

  if (op === "circular_mask") {
    const result = await circularMaskDesignAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      filename,
      softPx: typeof params.softPx === "number" ? params.softPx : undefined,
    });
    return {
      op,
      relativePath: result.relativePath,
      absolutePath: result.absolutePath,
      sourceFilename: result.sourceFilename,
      summary: `Circular cut-out: ${result.sourceFilename} → ${basename(result.relativePath)}`,
    };
  }

  if (op === "derive_icon_pack") {
    const sizes = Array.isArray(params.sizes)
      ? (params.sizes as unknown[]).filter(
          (n): n is number => typeof n === "number" && n > 0,
        )
      : undefined;
    const pack = await deriveIconPackFromAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      preferredFilename: opts.sourceFilename,
      sizes,
      prefix:
        typeof params.prefix === "string" ? params.prefix : undefined,
    });
    const first = pack.files[0];
    return {
      op,
      relativePath: first?.relativePath ?? "",
      absolutePath: first
        ? resolve(opts.projectRoot, first.relativePath)
        : "",
      sourceFilename: pack.sourceFilename,
      summary: `Icon pack ${pack.files.length} sizes from ${pack.sourceFilename}${
        pack.redirectedFrom ? ` (redirected from ${pack.redirectedFrom})` : ""
      }`,
      files: pack.files.map((f) => ({
        filename: f.filename,
        relativePath: f.relativePath,
        size: f.size,
      })),
    };
  }

  if (op === "resize") {
    const width = Number(params.width);
    if (!Number.isFinite(width) || width < 1) {
      throw new Error("resize requires params.width > 0");
    }
    const height =
      typeof params.height === "number" ? params.height : undefined;
    const result = await resizeDesignAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      width,
      height,
      filename,
    });
    return {
      op,
      relativePath: result.relativePath,
      absolutePath: resolve(opts.projectRoot, result.relativePath),
      sourceFilename: opts.sourceFilename,
      summary: `Resized to ${result.width}×${result.height}: ${basename(result.relativePath)}`,
    };
  }

  if (op === "trim") {
    const result = await trimDesignAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      filename,
    });
    return {
      op,
      relativePath: result.relativePath,
      absolutePath: resolve(opts.projectRoot, result.relativePath),
      sourceFilename: opts.sourceFilename,
      summary: `Trimmed borders → ${basename(result.relativePath)}`,
    };
  }

  if (op === "pad") {
    const size = Number(params.size);
    if (!Number.isFinite(size) || size < 1) {
      throw new Error("pad requires params.size > 0");
    }
    const result = await padDesignAsset({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: opts.sourceFilename,
      size,
      filename,
    });
    return {
      op,
      relativePath: result.relativePath,
      absolutePath: resolve(opts.projectRoot, result.relativePath),
      sourceFilename: opts.sourceFilename,
      summary: `Padded to ${size}×${size} → ${basename(result.relativePath)}`,
    };
  }

  // Remaining ops: direct sharp pipeline on a resolved source.
  const resolvedName = preferNonAlphaSiblingFilename(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    resolvedName,
  );
  const outName = editedOutputFilename(src.name, op, filename);
  const out = outPath(opts.projectRoot, opts.loopId, outName);
  let pipeline = sharp(src.absolutePath).ensureAlpha();

  switch (op) {
    case "rotate": {
      const angle = Number(params.angle ?? 0);
      pipeline = pipeline.rotate(angle, {
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      });
      break;
    }
    case "flip":
      pipeline = pipeline.flip();
      break;
    case "flop":
      pipeline = pipeline.flop();
      break;
    case "greyscale":
      pipeline = pipeline.greyscale();
      break;
    case "blur": {
      const sigma =
        typeof params.sigma === "number" && params.sigma > 0
          ? params.sigma
          : 1.5;
      pipeline = pipeline.blur(sigma);
      break;
    }
    case "sharpen":
      pipeline = pipeline.sharpen();
      break;
    case "modulate":
      pipeline = pipeline.modulate({
        brightness:
          typeof params.brightness === "number"
            ? params.brightness
            : undefined,
        saturation:
          typeof params.saturation === "number"
            ? params.saturation
            : undefined,
        hue: typeof params.hue === "number" ? params.hue : undefined,
      });
      break;
    case "tint": {
      const r = Number(params.r ?? 0);
      const g = Number(params.g ?? 0);
      const b = Number(params.b ?? 0);
      pipeline = pipeline.tint({ r, g, b });
      break;
    }
    case "extract": {
      const left = Number(params.left);
      const top = Number(params.top);
      const width = Number(params.width);
      const height = Number(params.height);
      if (
        ![left, top, width, height].every(
          (n) => Number.isFinite(n) && n >= 0,
        ) ||
        width < 1 ||
        height < 1
      ) {
        throw new Error(
          "extract requires left, top, width, height (positive size)",
        );
      }
      pipeline = pipeline.extract({ left, top, width, height });
      break;
    }
    case "flatten": {
      const r = Number(params.r ?? 255);
      const g = Number(params.g ?? 255);
      const b = Number(params.b ?? 255);
      pipeline = pipeline.flatten({ background: { r, g, b } });
      break;
    }
    default:
      throw new Error(`Unhandled image op: ${op}`);
  }

  await pipeline.png().toFile(out.absolutePath);
  return {
    op,
    relativePath: out.relativePath,
    absolutePath: out.absolutePath,
    sourceFilename: src.name,
    summary: `Applied ${op}: ${src.name} → ${out.name}`,
  };
}

/** Run catalog ops in order; each step uses the previous output as source. */
export async function applyDesignImagePipeline(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  ops: Array<{ op: string; params?: Record<string, unknown> }>;
}): Promise<{
  results: ApplyDesignImageOpResult[];
  primaryFilename: string;
  summaries: string[];
}> {
  if (!opts.ops.length) {
    throw new Error("applyDesignImagePipeline requires at least one op");
  }
  let source = opts.sourceFilename;
  const results: ApplyDesignImageOpResult[] = [];
  for (const step of opts.ops) {
    const result = await applyDesignImageOp({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      sourceFilename: source,
      op: step.op,
      params: step.params,
    });
    results.push(result);
    if (result.files?.length) {
      // Icon pack does not replace the primary logo source.
      continue;
    }
    source = basename(result.relativePath);
  }
  return {
    results,
    primaryFilename: source,
    summaries: results.map((r) => r.summary),
  };
}

