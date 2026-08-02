import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";
import sharp from "sharp";
import { designLoopAssetsDir } from "./design-media.js";

function claimsAlphaInName(name: string): boolean {
  return /(?:^|[-_.])alpha(?:[-_.]|$)|transparent|rgba/i.test(name);
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
  loopId: string;
  sourceFilename?: string;
  /** Pinned or preferred mark (used when source missing / invalid). */
  preferredFilename?: string;
}): Promise<{ filename: string; hasAlpha: boolean; redirectedFrom?: string }> {
  const dir = resolve(designLoopAssetsDir(opts.projectRoot, opts.loopId));
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

function resolveLoopAsset(
  projectRoot: string,
  loopId: string,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = resolve(designLoopAssetsDir(projectRoot, loopId));
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
    relativePath: relative(resolve(projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}

function outPath(
  projectRoot: string,
  loopId: string,
  filename: string,
): { absolutePath: string; relativePath: string; name: string } {
  const name = safeBasename(filename);
  const dir = resolve(designLoopAssetsDir(projectRoot, loopId));
  mkdirSync(dir, { recursive: true });
  const absolutePath = resolve(dir, name);
  if (!absolutePath.startsWith(dir + sep) && absolutePath !== dir) {
    throw new Error("Invalid output path");
  }
  return {
    absolutePath,
    relativePath: relative(resolve(projectRoot), absolutePath).replace(
      /\\/g,
      "/",
    ),
    name,
  };
}

export type MakeTransparentResult = {
  relativePath: string;
  absolutePath: string;
  width: number;
  height: number;
  hasAlpha: true;
  sourceFilename: string;
};

/**
 * Convert near-key-color pixels to transparent (true RGBA).
 * Default key = black. Does not invent a new mark.
 */
export async function makeTransparentDesignAsset(opts: {
  projectRoot: string;
  loopId: string;
  sourceFilename: string;
  /** Output filename (default: source stem + -alpha.png) */
  filename?: string;
  /** Max RGB distance from key to treat as transparent (0–441). Default 28. */
  threshold?: number;
  keyRgb?: [number, number, number];
  /** Soft edge width in distance units (default 8). */
  softEdge?: number;
}): Promise<MakeTransparentResult> {
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    opts.sourceFilename,
  );
  const stem = src.name.replace(/\.[^.]+$/, "");
  const out = outPath(
    opts.projectRoot,
    opts.loopId,
    opts.filename ?? `${stem}-alpha.png`,
  );
  const threshold = opts.threshold ?? 28;
  const soft = opts.softEdge ?? 8;
  const [kr, kg, kb] = opts.keyRgb ?? [0, 0, 0];

  const { data, info } = await sharp(src.absolutePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  if (channels < 4) {
    throw new Error("Expected RGBA buffer from sharp");
  }
  const px = Buffer.from(data);
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

  await sharp(px, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toFile(out.absolutePath);

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
  loopId: string;
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
  const resolved = await resolveIconPackSourceFilename({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
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
  const src = resolveLoopAsset(
    opts.projectRoot,
    opts.loopId,
    resolved.filename,
  );
  const packPrefix = (opts.prefix?.trim() || "icon-pack").replace(
    /[^a-z0-9_-]+/gi,
    "-",
  );
  const files: DeriveIconPackResult["files"] = [];
  for (const size of sizes) {
    const filename = `${packPrefix}-${size}.png`;
    const out = outPath(opts.projectRoot, opts.loopId, filename);
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
  return /\b(alpha|transparent|transparency|remove\s*background|strip\s*black|chroma|icon\s*pack|favicon|browser\s*pack|resize|trim|pad\s*image)\b/i.test(
    text ?? "",
  );
}
