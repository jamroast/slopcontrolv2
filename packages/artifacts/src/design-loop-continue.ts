/**
 * Narrow design-loop continues: freeze structure, reject drift.
 *
 * Classification is LLM-based via `continue-intent.ts` +
 * `classifyContinueIntentWithLlm` (mastra). This module is the deterministic
 * drift/patch machinery fed by the structured `ContinueIntent`.
 */

import type { ContinueIntent } from "./continue-intent.js";
import {
  continueIntentAllowsLogoSwap,
  continueIntentAllowsRedesign,
  continueIntentAllowsTokenChurn,
  continueIntentMayTouchHero,
  continueIntentMayTouchNav,
  continueIntentMayTouchShell,
} from "./continue-intent.js";

/** Exact class-token count (avoids BEM child false positives). Local to avoid cycle with design-element. */
function countExactClassToken(html: string, token: string): number {
  const re = /class=["']([^"']*)["']/gi;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tokens = (m[1] ?? "").split(/\s+/).filter(Boolean);
    if (tokens.includes(token)) n += 1;
  }
  return n;
}

export type MockStructureFingerprint = {
  heroH1: string;
  tokenKeys: string[];
  sectionIds: string[];
  /** Topbar / primary nav link labels (order preserved). */
  navLabels: string[];
  /** True when dashboard-shell / dash-sidebar chrome is present. */
  hasDashboardShell: boolean;
  primaryLogoAsset: string | null;
  logoAssetCounts: Record<string, number>;
};

/** Dominant <img> asset basename under design-loops/.../assets/. */
export function countMockLogoAssets(html: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const re =
    /(?:src|href)=["'][^"']*design-loops\/[^"']+\/assets\/([^"'?#]+\.(?:png|jpe?g|webp|gif|svg))["']/gi;
  for (const m of html.matchAll(re)) {
    const name = m[1]!;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
}

export function dominantMockLogoAsset(html: string): string | null {
  const counts = countMockLogoAssets(html);
  let best: string | null = null;
  let n = 0;
  for (const [name, c] of Object.entries(counts)) {
    // Prefer marks over tiny icon-pack tiles for pinning.
    const isPack = /^icon-v\d+-\d+\.png$/i.test(name) || /-\d{2,3}\.png$/i.test(name) && /icon/i.test(name);
    const score = isPack ? c * 0.25 : c;
    if (score > n) {
      n = score;
      best = name;
    }
  }
  return best;
}

export function extractNavLabels(html: string): string[] {
  const labels: string[] = [];
  // Prefer topbar / primary nav lists
  const navBlocks = [
    ...html.matchAll(
      /<(?:ul|nav)[^>]*class=["'][^"']*(?:topbar-nav|nav)[^"']*["'][^>]*>([\s\S]*?)<\/(?:ul|nav)>/gi,
    ),
  ];
  const bodies =
    navBlocks.length > 0
      ? navBlocks.map((m) => m[1] ?? "")
      : [html.match(/<nav\b[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? ""];
  for (const body of bodies) {
    for (const m of body.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
      const label = (m[1] ?? "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (label && label.length < 80) labels.push(label);
    }
  }
  return labels.slice(0, 24);
}

function stripHtmlText(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Landing/hero-scoped H1 for drift. Prefer #landing / .hero / #brand regions;
 * do not treat a dashboard greeting as the landing hero.
 */
export function extractLandingHeroH1(html: string): string {
  const landingRegion = html.match(
    /<(?:section|div|main)\b[^>]*(?:id=["'](?:landing|hero|brand)["']|class=["'][^"']*\b(?:hero|landing|brand)\b[^"']*["'])[^>]*>([\s\S]{0,12000}?)<\/(?:section|div|main)>/i,
  )?.[1];
  if (landingRegion) {
    const h1 = landingRegion.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (h1) return stripHtmlText(h1).slice(0, 200);
  }

  const dashH1 = html.match(
    /<(?:section|div|main)\b[^>]*(?:id=["']dashboard["']|class=["'][^"']*\bdashboard(?:-shell)?\b[^"']*["'])[^>]*>[\s\S]{0,400}?<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
  )?.[1];
  const dashText = dashH1 ? stripHtmlText(dashH1) : "";

  const allH1 = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) =>
    stripHtmlText(m[1] ?? ""),
  );
  const nonDash = allH1.find((t) => t && t !== dashText);
  if (nonDash) return nonDash.slice(0, 200);
  // Dashboard-only / greeting-only: no landing hero fingerprint.
  if (dashText && allH1.every((t) => !t || t === dashText)) return "";
  return (allH1[0] ?? "").slice(0, 200);
}

export function extractMockStructureFingerprint(
  html: string,
): MockStructureFingerprint {
  const tokenKeys = [
    ...html.matchAll(/--([a-zA-Z0-9-]+)\s*:/g),
  ].map((m) => m[1]!);
  const uniqueTokens = [...new Set(tokenKeys)].slice(0, 80);
  const sectionIds = [
    ...html.matchAll(/<(?:section|div)\b[^>]*\bid=["']([^"']+)["']/gi),
  ].map((m) => m[1]!);
  const logoAssetCounts = countMockLogoAssets(html);
  return {
    heroH1: extractLandingHeroH1(html),
    tokenKeys: uniqueTokens,
    sectionIds: [...new Set(sectionIds)].slice(0, 40),
    navLabels: extractNavLabels(html),
    hasDashboardShell:
      /\bdashboard-shell\b/i.test(html) || /\bdash-sidebar\b/i.test(html),
    primaryLogoAsset: dominantMockLogoAsset(html),
    logoAssetCounts,
  };
}

export type MockDriftSeverity = "hard" | "soft";

export type MockDriftIssue = {
  code:
    | "hero_changed"
    | "tokens_dropped"
    | "logo_swapped"
    | "section_ids_dropped"
    | "nav_changed"
    | "shell_dropped"
    | "element_invented";
  detail: string;
  /** hard → discard agent mock; soft → keep agent mock + NOTES warning. */
  severity: MockDriftSeverity;
};

/** Issues that should discard the agent mock and keep the prior tip. */
export function hardMockDriftIssues(
  issues: MockDriftIssue[],
): MockDriftIssue[] {
  return issues.filter((i) => i.severity === "hard");
}

export function softMockDriftIssues(
  issues: MockDriftIssue[],
): MockDriftIssue[] {
  return issues.filter((i) => i.severity === "soft");
}

/**
 * Structure codes are hard on narrow preserve modes; soft on surgical continues.
 * Logo swap defaults hard. Pinned-element invent is soft when callers pass
 * severity explicitly (LLM honor judge is the semantic arbiter).
 */
export function mockDriftIssueSeverity(
  code: MockDriftIssue["code"],
  opts: {
    preserveChrome: boolean;
    assetsOnly: boolean;
    navAlign: boolean;
  },
): MockDriftSeverity {
  if (code === "logo_swapped") return "hard";
  // Default for element_invented kept hard for non-pinned callers; pinned
  // theme-toggle path passes severity "soft" explicitly.
  if (code === "element_invented") return "hard";
  if (opts.preserveChrome || opts.assetsOnly || opts.navAlign) return "hard";
  return "soft";
}

/**
 * Detect structural / logo regressions vs ContinueIntent.
 * Diff first, then allowlist by intent. Issues carry hard|soft severity —
 * orchestrator only discards on hard.
 */
export function detectMockDrift(opts: {
  previousHtml: string;
  nextHtml: string;
  intent?: ContinueIntent;
  pinnedLogoAsset?: string | null;
  /** Pinned shared elements — competing theme toggles are rejected. */
  pinnedElements?: Array<{ id: string }>;
}): MockDriftIssue[] {
  const intent = opts.intent;
  if (!intent && !opts.pinnedElements?.length) return [];
  if (intent?.scope === "full_revise") return [];

  // Intent-aligned redesign: skip structure vetoes when chrome may change.
  // Element invent checks still apply when shared elements are pinned.
  const skipStructureDrift = Boolean(
    intent &&
      continueIntentAllowsRedesign(intent) &&
      !intent.preserveChrome,
  );

  const prev = extractMockStructureFingerprint(opts.previousHtml);
  const next = extractMockStructureFingerprint(opts.nextHtml);
  const issues: MockDriftIssue[] = [];

  const preserveChrome = Boolean(intent?.preserveChrome);
  const assetsOnly = intent?.scope === "assets_only";
  const navAlign = Boolean(
    intent?.navAlign || intent?.scope === "nav_align",
  );
  const sevOpts = { preserveChrome, assetsOnly, navAlign };
  const push = (
    code: MockDriftIssue["code"],
    detail: string,
    severity?: MockDriftSeverity,
  ) => {
    issues.push({
      code,
      detail,
      severity: severity ?? mockDriftIssueSeverity(code, sevOpts),
    });
  };

  // Pinned shared elements: do NOT hard-reject on brittle class-count regex
  // (BEM children like theme-toggle__sun false-positive). Semantic honor is
  // judged by classifyElementHonorViaLlm after deterministic apply.
  const hasThemeEl = (opts.pinnedElements ?? []).some(
    (e) =>
      e.id === "theme-toggle" ||
      /theme.?toggle/i.test(e.id) ||
      e.id === "menubar",
  );
  if (hasThemeEl) {
    // Soft heuristic only — never discard the mock from this signal alone.
    const html = opts.nextHtml ?? "";
    const exact = countExactClassToken(html, "theme-toggle");
    if (exact > 1) {
      push(
        "element_invented",
        `Heuristic: ${exact} theme-toggle controls (exact class token) — LLM honor judge / apply will reconcile; not a hard reject`,
        "soft",
      );
    }
  }

  if (skipStructureDrift) return issues;
  if (!intent) return issues;

  const mayTouchHero = continueIntentMayTouchHero(intent);
  const allowTokenChurn = continueIntentAllowsTokenChurn(intent);
  const allowLogoSwap = continueIntentAllowsLogoSwap(intent);
  const mayTouchNav = continueIntentMayTouchNav(intent);
  const mayTouchShell = continueIntentMayTouchShell(intent);

  if (
    prev.heroH1 &&
    next.heroH1 &&
    normalizeCopy(prev.heroH1) !== normalizeCopy(next.heroH1)
  ) {
    if (!mayTouchHero) {
      push(
        "hero_changed",
        `Hero changed from "${prev.heroH1.slice(0, 60)}" to "${next.heroH1.slice(0, 60)}"`,
      );
    }
  }

  if (!allowTokenChurn && prev.tokenKeys.length >= 8) {
    const nextSet = new Set(next.tokenKeys);
    const kept = prev.tokenKeys.filter((k) => nextSet.has(k)).length;
    const ratio = kept / prev.tokenKeys.length;
    if (ratio < 0.7) {
      push(
        "tokens_dropped",
        `Kept ${kept}/${prev.tokenKeys.length} prior :root token keys`,
      );
    }
  }

  const pinned = opts.pinnedLogoAsset?.trim() || prev.primaryLogoAsset;
  if (pinned && !allowLogoSwap) {
    const nextPinnedCount = next.logoAssetCounts[pinned] ?? 0;
    const prevPinnedCount = prev.logoAssetCounts[pinned] ?? 0;
    const nextUsesPinned =
      nextPinnedCount > 0 ||
      Object.keys(next.logoAssetCounts).some((n) =>
        isDerivedFromPinned(n, pinned),
      );
    if (prevPinnedCount > 0 && !nextUsesPinned) {
      push(
        "logo_swapped",
        `Primary/pinned logo ${pinned} missing from new mock`,
        "hard",
      );
    }
    const fakeAlpha = Object.keys(next.logoAssetCounts).find(
      (n) =>
        /alpha/i.test(n) &&
        n !== pinned &&
        (next.logoAssetCounts[n] ?? 0) >= 1,
    );
    if (fakeAlpha && prevPinnedCount >= 2 && nextPinnedCount === 0) {
      push(
        "logo_swapped",
        `Swapped pinned ${pinned} for ${fakeAlpha}`,
        "hard",
      );
    }
  }

  if (
    (preserveChrome || assetsOnly) &&
    prev.sectionIds.length >= 3 &&
    next.sectionIds.length > 0
  ) {
    const nextSet = new Set(next.sectionIds);
    const kept = prev.sectionIds.filter((id) => nextSet.has(id)).length;
    if (kept / prev.sectionIds.length < 0.5) {
      push(
        "section_ids_dropped",
        `Narrow continue dropped section ids (${kept}/${prev.sectionIds.length})`,
      );
    }
  }

  // Nav: compare label **sets** (order-insensitive). Pure reorder is never drift.
  if (!mayTouchNav && prev.navLabels.length >= 2) {
    const prevSet = navLabelSetKey(prev.navLabels);
    const nextSet = navLabelSetKey(next.navLabels);
    if (prevSet !== nextSet) {
      push(
        "nav_changed",
        `Nav changed from [${prev.navLabels.join(", ")}] to [${next.navLabels.join(", ")}]`,
      );
    }
  }

  if (!mayTouchShell && prev.hasDashboardShell && !next.hasDashboardShell) {
    push("shell_dropped", "Dashboard shell / sidebar chrome was removed");
  }

  return issues;
}

function navLabelSetKey(labels: string[]): string {
  return [...new Set(labels.map((l) => normalizeCopy(l)).filter(Boolean))]
    .sort()
    .join("|");
}

function normalizeCopy(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function isDerivedFromPinned(name: string, pinned: string): boolean {
  const stem = pinned.replace(/\.[^.]+$/, "").toLowerCase();
  const n = name.toLowerCase();
  if (n === pinned.toLowerCase()) return true;
  if (n.startsWith("icon-v") && /\.png$/i.test(n)) return true;
  return n.includes(stem) || stem.includes(n.replace(/\.[^.]+$/, ""));
}

/**
 * Patch prior mock: keep structure; refresh icon-pack img srcs and force primary logo.
 */
export function patchMockForAssetContinue(opts: {
  previousHtml: string;
  loopId: string;
  primaryLogoAsset?: string | null;
  /** New pack files from derive_icon_pack */
  iconPackFiles?: Array<{ size: number; filename: string }>;
  /** Replace these basenames with primaryLogoAsset in img srcs */
  replaceLogoAssets?: string[];
}): string {
  let html = opts.previousHtml;
  const loopId = opts.loopId;

  if (opts.primaryLogoAsset) {
    const primary = opts.primaryLogoAsset;
    const replace = new Set(
      (opts.replaceLogoAssets ?? []).filter((n) => n && n !== primary),
    );
    // Replace competing marks/logos in the mock (not icon-pack size tiles).
    for (const n of Object.keys(countMockLogoAssets(html))) {
      if (n === primary) continue;
      const isPackTile =
        /^icon-v\d+-\d+\.png$/i.test(n) ||
        (/icon/i.test(n) && /-\d{2,3}\.png$/i.test(n));
      if (isPackTile) continue;
      const isCompetingMark =
        /alpha/i.test(n) ||
        /\bmark\b/i.test(n) ||
        /logo/i.test(n) ||
        /ember|monogram|jamroast|jam-?light/i.test(n);
      if (isCompetingMark) replace.add(n);
    }
    for (const bad of replace) {
      const re = new RegExp(
        `(\\.slopcontrol/design-loops/${escapeRe(loopId)}/assets/)${escapeRe(bad)}`,
        "g",
      );
      html = html.replace(re, `$1${primary}`);
    }
  }

  if (opts.iconPackFiles?.length) {
    const base =
      `\\.slopcontrol/design-loops/${escapeRe(loopId)}/assets/`;
    for (const f of opts.iconPackFiles) {
      const re = new RegExp(
        `(${base})(?:icon-v\\d+|icon-pack)-${f.size}\\.png`,
        "gi",
      );
      html = html.replace(re, `$1${f.filename}`);
    }
  }

  return html;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip leftover agent planning prose / HTML from design-loop version NOTES.
 * Returns empty string when the remnant is not operator-facing.
 */
export function sanitizeDesignLoopAgentNotes(raw: string): string {
  const text = (raw ?? "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<!DOCTYPE[\s\S]*/i, "")
    .replace(/<\/?(?:html|head|body|style|script)\b[\s\S]*/i, "")
    .replace(/MOCK_HTML_COMPLETE/gi, "")
    .replace(/MOCK_ASSETS_ONLY/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_500);
  if (!text) return "";
  if (
    /^(i'll|i will|i'm going to|let me|here'?s)\b/i.test(text) ||
    /\bi'll\s+apply\b/i.test(text)
  ) {
    return "";
  }
  return text;
}

/**
 * Build version NOTES: honor + soft drift first; agent notes only when honor is empty.
 */
export function composeDesignLoopVersionNotes(opts: {
  elementHonorNotes?: string;
  softDriftNotes?: string;
  agentRaw?: string;
  version: number;
}): string {
  const honor = (opts.elementHonorNotes ?? "").trim();
  const soft = (opts.softDriftNotes ?? "").trim();
  const agent = honor
    ? ""
    : sanitizeDesignLoopAgentNotes(opts.agentRaw ?? "");
  const notes = [honor, soft, agent || (honor || soft ? "" : `v${opts.version}`)]
    .filter(Boolean)
    .join(" ")
    .slice(0, 1_500);
  return notes || `v${opts.version}`;
}
