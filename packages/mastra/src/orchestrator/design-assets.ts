/**
 * Pure helpers for the design-stage asset pipeline.
 *
 * - `resolveVisionImagePaths`: pick the raster images a design-vision pass
 *   should receive. Vectorized assets are SVG, which vision providers reject,
 *   so the pass falls back to the vectorize preview PNGs (contact sheet +
 *   per-size previews) instead of skipping the review.
 * - `classifyDerivativeOp`: structural routing of an `## Assets` brief to the
 *   deterministic op that produces it (icon pack / circular mask / alpha).
 *   Recognises explicit op words, not operator intent (no LLM needed).
 */

import { isAbsolute, join } from "node:path";
import { filterRasterVisionPaths } from "@slopcontrol/llm";

export type VisionImagePathsInput = {
  projectRoot: string;
  /** Paths of generated assets — absolute or project-relative (mixed today). */
  generatedPaths: string[];
  /** Vectorize preview/sheet paths — project-relative. */
  previewPaths: string[];
  /** Maximum images to send (default 3). */
  max?: number;
};

function absolutise(projectRoot: string, path: string): string {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

function previewRank(path: string): {
  sheet: number;
  size: number;
  mat: number;
} {
  const base = path.split(/[\\/]/).pop() ?? path;
  const size = Number(/-preview-(\d+)-/i.exec(base)?.[1] ?? 0);
  return {
    sheet: /-contact-sheet\.png$/i.test(base) ? 0 : 1,
    size: Number.isFinite(size) ? size : 0,
    mat: /-dark\.png$/i.test(base) ? 0 : 1,
  };
}

/**
 * Raster generated assets win (current behaviour). When the generated set is
 * SVG-only, use the vectorize previews: contact sheet first, then previews by
 * size descending, then dark before light. Returns absolute paths.
 */
export function resolveVisionImagePaths(
  opts: VisionImagePathsInput,
): string[] {
  const max = Math.max(1, Math.floor(opts.max ?? 3));

  const generated = filterRasterVisionPaths(
    opts.generatedPaths.map((p) => absolutise(opts.projectRoot, p)),
  );
  if (generated.length > 0) {
    return [...new Set(generated)].slice(0, max);
  }

  const previews = filterRasterVisionPaths(
    opts.previewPaths.map((p) => absolutise(opts.projectRoot, p)),
  );
  if (previews.length === 0) return [];

  const sorted = [...new Set(previews)].sort((a, b) => {
    const ra = previewRank(a);
    const rb = previewRank(b);
    return (
      ra.sheet - rb.sheet ||
      rb.size - ra.size ||
      ra.mat - rb.mat ||
      a.localeCompare(b)
    );
  });
  return sorted.slice(0, max);
}

export type DerivativeOp = "favicon_pack" | "icon_pack" | "circular_mask" | "alpha";

const FAVICON_RE = /\bfavicon\b|maskable|\.ico\b/i;
const ICON_PACK_RE = /\bicon\s*pack\b|\bsizes\b/i;
const CIRCULAR_RE = /\bcircular\s*(?:mask|cut[\s-]?out)\b/i;

/** Deterministic op for a derivative asset brief (name + filename only). */
export function classifyDerivativeOp(brief: {
  name: string;
  filename: string;
}): DerivativeOp {
  const text = `${brief.name} ${brief.filename}`;
  if (FAVICON_RE.test(text)) return "favicon_pack";
  if (ICON_PACK_RE.test(text)) return "icon_pack";
  if (CIRCULAR_RE.test(text)) return "circular_mask";
  return "alpha";
}
