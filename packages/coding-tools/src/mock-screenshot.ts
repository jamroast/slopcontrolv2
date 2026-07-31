import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export type RenderMockHtmlOptions = {
  htmlPath: string;
  outPath: string;
  width?: number;
  height?: number;
  /** When true and outPath already exists, skip browser render. */
  reuseExisting?: boolean;
};

/**
 * Render a local HTML file to PNG via Playwright Chromium.
 * Throws a clear error when Playwright / browser is unavailable.
 */
export async function renderMockHtmlToPng(
  opts: RenderMockHtmlOptions,
): Promise<string> {
  if (opts.reuseExisting !== false && existsSync(opts.outPath)) {
    return opts.outPath;
  }

  let chromium: { launch: (o?: { headless?: boolean }) => Promise<unknown> };
  try {
    const mod = (await import("playwright")) as {
      chromium: { launch: (o?: { headless?: boolean }) => Promise<unknown> };
    };
    chromium = mod.chromium;
  } catch {
    throw new Error(
      "Playwright is not installed. Run: pnpm --filter @slopcontrol/coding-tools exec playwright install chromium",
    );
  }

  mkdirSync(dirname(opts.outPath), { recursive: true });
  const browser = (await chromium.launch({ headless: true })) as {
    newPage: () => Promise<{
      setViewportSize: (s: { width: number; height: number }) => Promise<void>;
      goto: (
        url: string,
        o?: { waitUntil?: "networkidle"; timeout?: number },
      ) => Promise<unknown>;
      screenshot: (o: { path: string; fullPage?: boolean }) => Promise<Buffer>;
    }>;
    close: () => Promise<void>;
  };
  try {
    const page = await browser.newPage();
    await page.setViewportSize({
      width: opts.width ?? 1280,
      height: opts.height ?? 800,
    });
    const url = pathToFileURL(opts.htmlPath).href;
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
    await page.screenshot({ path: opts.outPath, fullPage: true });
    return opts.outPath;
  } finally {
    await browser.close();
  }
}

/** Write a minimal PNG for tests when Playwright is unavailable. */
export function writeFixturePreviewPng(outPath: string): string {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, png);
  return outPath;
}

export function designLoopPreviewPath(
  projectRoot: string,
  loopId: string,
  version: number,
): string {
  return join(
    projectRoot,
    ".slopcontrol",
    "design-loops",
    loopId,
    `v${version}`,
    "preview.png",
  );
}

export function designLoopReviewPath(
  projectRoot: string,
  loopId: string,
  version: number,
): string {
  return join(
    projectRoot,
    ".slopcontrol",
    "design-loops",
    loopId,
    `v${version}`,
    "REVIEW.md",
  );
}
