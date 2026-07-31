import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatWithImages } from "@slopcontrol/llm";
import {
  designLoopPreviewPath,
  designLoopReviewPath,
  renderMockHtmlToPng,
} from "./mock-screenshot.js";
import { listLoopRasterAssets } from "./design-media.js";

export type ReviewDesignLoopInput = {
  projectRoot: string;
  loopId: string;
  version: number;
  brief: string;
  visionEndpoint: LlmEndpoint;
  visionModelId?: string;
  /** Skip browser when preview.png already exists (tests). */
  reusePreview?: boolean;
  /** Force using an existing preview without rendering. */
  previewPathOverride?: string;
};

export type ReviewDesignLoopOutput = {
  critique: string;
  previewPath: string;
  reviewPath: string;
  imagePaths: string[];
};

export async function reviewDesignLoopLook(
  opts: ReviewDesignLoopInput,
): Promise<ReviewDesignLoopOutput> {
  if (!opts.visionEndpoint) {
    throw new Error(
      "designVision unbound — bind roles.designVision to a vision-capable model (e.g. kimi-k2.7-code or kimi-k3)",
    );
  }

  const mockPath = join(
    opts.projectRoot,
    ".slopcontrol",
    "design-loops",
    opts.loopId,
    `v${opts.version}`,
    "mock.html",
  );
  if (!existsSync(mockPath) && !opts.previewPathOverride) {
    throw new Error(`mock.html missing for loop ${opts.loopId} v${opts.version}`);
  }

  const previewPath =
    opts.previewPathOverride ??
    designLoopPreviewPath(opts.projectRoot, opts.loopId, opts.version);

  if (opts.previewPathOverride) {
    if (!existsSync(opts.previewPathOverride)) {
      throw new Error(`preview override missing: ${opts.previewPathOverride}`);
    }
  } else {
    await renderMockHtmlToPng({
      htmlPath: mockPath,
      outPath: previewPath,
      reuseExisting: opts.reusePreview !== false,
    });
  }

  const assetPaths = listLoopRasterAssets(
    opts.projectRoot,
    opts.loopId,
    2,
  );
  const imagePaths = [previewPath, ...assetPaths].filter((p) =>
    existsSync(p),
  );

  const critique = await chatWithImages({
    endpoint: opts.visionEndpoint,
    modelId: opts.visionModelId,
    imagePaths,
    timeoutMs: 120_000,
    prompt: `You are reviewing a UI look-and-feel mock (screenshot first; optional logo/hero assets after).

Brief:
${opts.brief.trim().slice(0, 2_500)}

Critique with concise bullets covering:
- Palette / contrast / hierarchy
- Brand presence (logo/wordmark treatment)
- Layout / spacing / shell fidelity
- Alignment with jam-family / sibling cues if relevant
- Concrete revise suggestions for the next mock iteration

Be direct. No preamble.`,
  });

  const reviewPath = designLoopReviewPath(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  const body = `# Design loop review — v${opts.version}

${critique.text.trim()}
`;
  writeFileSync(reviewPath, body, "utf-8");

  return {
    critique: critique.text.trim(),
    previewPath,
    reviewPath,
    imagePaths,
  };
}
