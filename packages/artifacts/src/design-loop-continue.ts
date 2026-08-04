/**
 * Narrow design-loop continues: classify asks, freeze structure, reject drift.
 *
 * Note: primary classification is LLM-based via `continue-intent.ts` +
 * `classifyContinueIntentWithLlm` (mastra). The regexes here are the
 * deterministic fallback and feed legacy `DesignLoopContinueMode` for tests.
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

export type DesignLoopContinueKind =
  | "asset_only"
  | "nav_align"
  | "section_touch"
  | "full_revise";

export type DesignLoopContinueMode = {
  kind: DesignLoopContinueKind;
  assetEdit: boolean;
  /** Normalized section keywords mentioned by the operator (positive asks only). */
  sections: string[];
  /** Operator asked to keep layout/copy/shell/hero unchanged. */
  preserveLayout: boolean;
  /** Align mock topbar/nav with live project inventory. */
  navAlign: boolean;
};

const SECTION_PATTERNS: Array<{ id: string; re: RegExp }> = [
  { id: "tasting-room", re: /\btasting\s*room\b/i },
  { id: "landing", re: /\b(landing|home\s*page|hero)\b/i },
  { id: "dashboard", re: /\bdashboard\b/i },
  { id: "chat", re: /\b(chat|agent\s*panel)\b/i },
  { id: "settings", re: /\bsettings?\b/i },
  { id: "lockups", re: /\blockups?\b/i },
  { id: "palette", re: /\bpalette\b/i },
  { id: "typography", re: /\btypograph/i },
];

/**
 * Strip "do not change …" / "keep the …" spans so section keywords inside
 * negations ("Do not change hero") are not treated as section asks.
 */
export function textForPositiveSectionDetection(text: string): string {
  return (text ?? "")
    .replace(
      /\b(?:do\s+not|don't|dont)\s+(?:change|touch|alter|rewrite|modify|update)\b[^.!?\n]*/gi,
      " ",
    )
    .replace(
      /\bwithout\s+(?:changing|touching|altering|modifying)\b[^.!?\n]*/gi,
      " ",
    )
    .replace(
      /\b(?:keep|preserve|maintain)\s+(?:the\s+)?[^.!?\n]*/gi,
      " ",
    );
}

export function askPreservesLayout(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(?:keep|preserve|maintain)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    ) ||
    /\b(?:do\s+not|don't|dont)\s+(?:change|touch|alter|rewrite|modify)\b.{0,60}\b(layout|copy|shell|hero|structure|mock|menu|nav)\b/i.test(
      t,
    )
  );
}

/** Align mock menus with live code / what exists today. */
export function askAlignsNavWithCode(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(align|match|sync|update)\b.{0,50}\b(menu|nav|navigation|header\s*links?)\b/i.test(
      t,
    ) ||
    /\b(menu|nav|navigation)\b.{0,50}\b(align|match|code|today|current|in\s*place|exists|live)\b/i.test(
      t,
    ) ||
    /\b(menu|nav|navigation).{0,80}\b(in\s+the\s+code|what\s+we\s+have|what\s+exists|what\s+is\s+in\s+place)\b/i.test(
      t,
    )
  );
}

export function classifyDesignLoopContinueAsk(
  text: string,
): DesignLoopContinueMode {
  const t = text ?? "";
  const preserveLayout = askPreservesLayout(t);
  const navAlign = askAlignsNavWithCode(t);
  const assetEdit =
    /\b(alpha|transparent|transparency|remove\s*background|strip\s*black|chroma|icon\s*pack|favicon|browser\s*pack|resize|trim|pad\s*image|make_transparent|derive_icon)\b/i.test(
      t,
    );
  const sectionScan = textForPositiveSectionDetection(t);
  const sections = SECTION_PATTERNS.filter((p) => p.re.test(sectionScan)).map(
    (p) => p.id,
  );
  // Positive rewrite asks only (negated "do not change hero" already stripped).
  const wantsFull =
    /\b(redesign|from scratch|rewrite (the )?(whole|entire|full)|overhaul|new layout|restyle everything|start over)\b/i.test(
      t,
    ) ||
    /\b(rewrite|change|replace)\b.{0,40}\b(hero|headline|copy|tagline)\b/i.test(
      sectionScan,
    );

  if (wantsFull && !preserveLayout && !navAlign) {
    return {
      kind: "full_revise",
      assetEdit,
      sections,
      preserveLayout,
      navAlign: false,
    };
  }
  // Nav align wins over asset-only short-circuit (v11 bug: icon pack skipped menu sync).
  if (navAlign) {
    return {
      kind: "nav_align",
      assetEdit,
      sections: [...new Set([...sections, "nav"])],
      preserveLayout: true,
      navAlign: true,
    };
  }
  // Icon pack / alpha + keep layout → never open the door to a full rewrite.
  if (assetEdit && (sections.length === 0 || preserveLayout)) {
    return {
      kind: "asset_only",
      assetEdit: true,
      sections: preserveLayout ? [] : sections,
      preserveLayout,
      navAlign: false,
    };
  }
  if (sections.length > 0 || assetEdit) {
    return {
      kind: "section_touch",
      assetEdit,
      sections,
      preserveLayout,
      navAlign: false,
    };
  }
  // Default continue: preserve structure (still allow small tweaks).
  return {
    kind: "section_touch",
    assetEdit: false,
    sections: [],
    preserveLayout,
    navAlign: false,
  };
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

export function extractMockStructureFingerprint(
  html: string,
): MockStructureFingerprint {
  const heroMatch =
    html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
    html.match(/class=["'][^"']*hero[^"']*["'][^>]*>[\s\S]*?<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const heroRaw = (heroMatch?.[1] ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokenKeys = [
    ...html.matchAll(/--([a-zA-Z0-9-]+)\s*:/g),
  ].map((m) => m[1]!);
  const uniqueTokens = [...new Set(tokenKeys)].slice(0, 80);
  const sectionIds = [
    ...html.matchAll(/<(?:section|div)\b[^>]*\bid=["']([^"']+)["']/gi),
  ].map((m) => m[1]!);
  const logoAssetCounts = countMockLogoAssets(html);
  return {
    heroH1: heroRaw.slice(0, 200),
    tokenKeys: uniqueTokens,
    sectionIds: [...new Set(sectionIds)].slice(0, 40),
    navLabels: extractNavLabels(html),
    hasDashboardShell:
      /\bdashboard-shell\b/i.test(html) || /\bdash-sidebar\b/i.test(html),
    primaryLogoAsset: dominantMockLogoAsset(html),
    logoAssetCounts,
  };
}

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
};

/**
 * Reject structural / logo regressions on narrow continues.
 * Pass `intent` (LLM or fallback) for target-based gating; `mode` remains as
 * legacy regex classification when no intent was resolved.
 */
export function detectMockDrift(opts: {
  previousHtml: string;
  nextHtml: string;
  mode?: DesignLoopContinueMode;
  intent?: ContinueIntent;
  pinnedLogoAsset?: string | null;
  /** Pinned shared elements — competing theme toggles are rejected. */
  pinnedElements?: Array<{ id: string }>;
}): MockDriftIssue[] {
  const mode = opts.mode;
  const intent = opts.intent;
  if (!mode && !intent && !opts.pinnedElements?.length) return [];
  const isFullRevise = intent
    ? intent.scope === "full_revise"
    : mode?.kind === "full_revise";
  if (isFullRevise) return [];

  // LLM intent wins: theme/logo redesign with preserveChrome=false must not be
  // vetoed by hero/logo/token/nav fingerprints (keeps prior mock = silent no-op).
  // Element invent checks still apply when shared elements are pinned.
  const skipStructureDrift = Boolean(
    intent &&
      continueIntentAllowsRedesign(intent) &&
      !intent.preserveChrome,
  );

  const prev = extractMockStructureFingerprint(opts.previousHtml);
  const next = extractMockStructureFingerprint(opts.nextHtml);
  const issues: MockDriftIssue[] = [];

  const hasThemeEl = (opts.pinnedElements ?? []).some(
    (e) => e.id === "theme-toggle" || /theme.?toggle/i.test(e.id),
  );
  if (hasThemeEl) {
    const html = opts.nextHtml ?? "";
    const toggleNodes =
      html.match(
        /<(?:button|div|label|a)[^>]*>[\s\S]{0,200}?(?:dark\s*\/\s*light|day\s*\/\s*night|theme\s*toggle)[\s\S]{0,200}?<\/(?:button|div|label|a)>/gi,
      ) ?? [];
    const classToggles =
      html.match(/class=["'][^"']*theme-toggle[^"']*["']/gi) ?? [];
    const count = Math.max(toggleNodes.length, classToggles.length);
    if (count > 1) {
      issues.push({
        code: "element_invented",
        detail: `Pinned theme-toggle but mock has ${count} theme controls — embed the shared element once`,
      });
    }
  }

  if (skipStructureDrift) return issues;
  if (!mode && !intent) return issues;

  const preserveChrome = intent
    ? intent.preserveChrome
    : Boolean(mode && (mode.kind === "asset_only" || mode.kind === "nav_align" || mode.preserveLayout));
  const assetsOnly = intent
    ? intent.scope === "assets_only"
    : mode?.kind === "asset_only";
  const mayTouchHero = intent
    ? continueIntentMayTouchHero(intent)
    : !preserveChrome &&
      mode?.kind === "section_touch" &&
      mode.sections.some((s) => s === "landing");
  const allowTokenChurn = intent
    ? continueIntentAllowsTokenChurn(intent)
    : false;
  const allowLogoSwap = intent
    ? continueIntentAllowsLogoSwap(intent)
    : false;
  const mayTouchNav = intent
    ? continueIntentMayTouchNav(intent)
    : Boolean(
        mode &&
          (mode.kind === "nav_align" ||
            mode.navAlign ||
            (!preserveChrome &&
              mode.kind === "section_touch" &&
              mode.sections.some((s) =>
                ["dashboard", "landing", "settings", "nav"].includes(s),
              ))),
      );
  const mayTouchShell = intent
    ? continueIntentMayTouchShell(intent)
    : !preserveChrome &&
      mode?.kind === "section_touch" &&
      mode.sections.some((s) => s === "dashboard");

  if (
    prev.heroH1 &&
    next.heroH1 &&
    normalizeCopy(prev.heroH1) !== normalizeCopy(next.heroH1)
  ) {
    if (!mayTouchHero) {
      issues.push({
        code: "hero_changed",
        detail: `Hero changed from "${prev.heroH1.slice(0, 60)}" to "${next.heroH1.slice(0, 60)}"`,
      });
    }
  }

  if (!allowTokenChurn && prev.tokenKeys.length >= 8) {
    const nextSet = new Set(next.tokenKeys);
    const kept = prev.tokenKeys.filter((k) => nextSet.has(k)).length;
    const ratio = kept / prev.tokenKeys.length;
    if (ratio < 0.7) {
      issues.push({
        code: "tokens_dropped",
        detail: `Kept ${kept}/${prev.tokenKeys.length} prior :root token keys`,
      });
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
      issues.push({
        code: "logo_swapped",
        detail: `Primary/pinned logo ${pinned} missing from new mock`,
      });
    }
    // Detect swap to a differently named *alpha* file that crowds out the pinned mark
    const fakeAlpha = Object.keys(next.logoAssetCounts).find(
      (n) =>
        /alpha/i.test(n) &&
        n !== pinned &&
        (next.logoAssetCounts[n] ?? 0) >= 1,
    );
    if (
      fakeAlpha &&
      prevPinnedCount >= 2 &&
      nextPinnedCount === 0
    ) {
      issues.push({
        code: "logo_swapped",
        detail: `Swapped pinned ${pinned} for ${fakeAlpha}`,
      });
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
      issues.push({
        code: "section_ids_dropped",
        detail: `Narrow continue dropped section ids (${kept}/${prev.sectionIds.length})`,
      });
    }
  }

  if (
    !mayTouchNav &&
    prev.navLabels.length >= 2 &&
    normalizeCopy(prev.navLabels.join("|")) !==
      normalizeCopy(next.navLabels.join("|"))
  ) {
    issues.push({
      code: "nav_changed",
      detail: `Nav changed from [${prev.navLabels.join(", ")}] to [${next.navLabels.join(", ")}]`,
    });
  }

  if (!mayTouchShell && prev.hasDashboardShell && !next.hasDashboardShell) {
    issues.push({
      code: "shell_dropped",
      detail: "Dashboard shell / sidebar chrome was removed",
    });
  }

  return issues;
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

export function formatContinueModePromptBlock(
  mode: DesignLoopContinueMode,
): string {
  return formatLegacyContinueModePromptBlock(mode);
}

function formatLegacyContinueModePromptBlock(
  mode: DesignLoopContinueMode,
): string {
  const lines = [
    `CONTINUE MODE: ${mode.kind}${mode.preserveLayout ? " (preserve layout)" : ""}`,
    mode.assetEdit
      ? "- Asset edits allowed via make_transparent / derive_icon_pack / resize tools only."
      : "- No asset regeneration unless the operator asked.",
  ];
  if (mode.kind === "nav_align") {
    lines.push(
      "- NAV ALIGN: update topbar/primary nav labels+hrefs to match LIVE SITE inventory only.",
      "- Keep hero, dashboard shell, tokens, and pinned logos identical.",
      "- Prefer MOCK_ASSETS_ONLY / omit HTML — the system can patch nav from inventory.",
    );
  } else if (mode.kind === "asset_only" || mode.preserveLayout) {
    lines.push(
      "- ASSET ONLY / PRESERVE: do NOT rewrite layout, hero copy, topbar nav labels, dashboard shell, or CSS architecture.",
      "- Call edit tools, then return the PRIOR mock HTML with only asset src / icon-pack tile updates — or omit HTML and the system will patch the prior mock.",
      "- End with MOCK_ASSETS_ONLY if you intentionally skip a full HTML rewrite.",
    );
  } else if (mode.kind === "section_touch") {
    lines.push(
      "- SURGICAL: copy the previous mock verbatim as the base.",
      "- Change ONLY the requested sections" +
        (mode.sections.length
          ? ` (${mode.sections.join(", ")})`
          : " (minimal tweaks)") +
        " and any pinned/asset updates.",
      "- Keep hero headline, topbar nav, dashboard shell, :root token names, and pinned logo paths identical unless those sections were named.",
    );
  } else {
    lines.push("- Full revise allowed; still prefer pinned logos over inventing a new mark.");
  }
  return lines.join("\n");
}
