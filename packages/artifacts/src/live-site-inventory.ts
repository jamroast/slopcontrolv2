/**
 * Deterministic read-only inventory of the live project for design-loop mocks.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { designLoopDir } from "./design-loop.js";
import {
  collectConsumedLogoHints,
  excerptCssTokens,
  excerptLandingCopy,
  preferAuthoritativeLogos,
  projectTokenCandidates,
} from "./sibling-brand-refs.js";
import {
  buildScreenContentInventory,
  collectRouteFiles,
  type EntityFieldGroup,
  type ScreenContent,
} from "./screen-content.js";

export type LiveSiteNavLink = {
  label: string;
  href: string;
  source: string;
};

export type LiveSiteInventory = {
  projectRoot: string;
  nav: LiveSiteNavLink[];
  ctaLinks: LiveSiteNavLink[];
  routes: string[];
  tokenFiles: string[];
  tokenExcerpt: string;
  publicAssets: string[];
  logoPaths: string[];
  landingCues: string;
  shellHints: string[];
  /** Per-route UI copy (headings, columns, fields, buttons). */
  screens: ScreenContent[];
  /** Domain entity field names (interfaces / zod / prisma). */
  entities: EntityFieldGroup[];
  updatedAt: string;
};

export type { ScreenContent, EntityFieldGroup };

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  "out",
  ".slopcontrol",
]);

const HEADER_FILE_RE = /(?:^|\/)(?:header|site-header|navbar|nav|main-nav|site-nav)[^/]*\.(tsx|jsx|ts|js)$/i;
/** Header conversion CTAs (not primary nav items like /contact). */
const CTA_HREF_RE = /^\/(sign-in|sign-up|login|tasting-room|get-started)/i;

function walkFiles(
  root: string,
  dir: string,
  out: string[],
  maxFiles: number,
  depth = 0,
): void {
  if (out.length >= maxFiles || depth > 8) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= maxFiles) return;
    if (name.startsWith(".") || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(root, full, out, maxFiles, depth + 1);
    } else if (st.isFile()) {
      out.push(full);
    }
  }
}

function toProjectRelative(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).replace(/\\/g, "/");
}

/** Parse `{ href: "/x", label: "Y" }` style arrays. */
export function extractNavLinksFromSource(
  source: string,
  body: string,
): { nav: LiveSiteNavLink[]; ctaLinks: LiveSiteNavLink[] } {
  const nav: LiveSiteNavLink[] = [];
  const ctaLinks: LiveSiteNavLink[] = [];
  const seen = new Set<string>();

  const arrayBlocks = [
    ...body.matchAll(
      /(?:const|let|var|export\s+const)\s+(navLinks|NAV_LINKS|mainNav|MAIN_NAV|navigation|navItems)\s*=\s*\[([\s\S]*?)\];/gi,
    ),
  ];
  for (const block of arrayBlocks) {
    const inner = block[2] ?? "";
    for (const m of inner.matchAll(
      /\{\s*href\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*label\s*:\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      const href = (m[1] ?? "").trim();
      const label = (m[2] ?? "").trim();
      if (!href || !label) continue;
      const key = `${href}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = { label, href, source };
      if (CTA_HREF_RE.test(href)) ctaLinks.push(link);
      else nav.push(link);
    }
    for (const m of inner.matchAll(
      /\{\s*label\s*:\s*["'`]([^"'`]+)["'`]\s*,\s*href\s*:\s*["'`]([^"'`]+)["'`]/gi,
    )) {
      const label = (m[1] ?? "").trim();
      const href = (m[2] ?? "").trim();
      if (!href || !label) continue;
      const key = `${href}|${label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const link = { label, href, source };
      if (CTA_HREF_RE.test(href)) ctaLinks.push(link);
      else nav.push(link);
    }
  }

  if (nav.length === 0) {
    // Fallback: Link/a inside <nav>…</nav>
    const navBodies = [...body.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/gi)].map(
      (m) => m[1] ?? "",
    );
    for (const nb of navBodies.length ? navBodies : [body]) {
      for (const link of extractJsxLinks(nb, source)) {
        const key = `${link.href}|${link.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (CTA_HREF_RE.test(link.href)) ctaLinks.push(link);
        else nav.push(link);
      }
    }
  }

  // Header CTAs outside navLinks (sign-in / tasting-room)
  for (const link of extractJsxLinks(body, source)) {
    if (!CTA_HREF_RE.test(link.href)) continue;
    const key = `${link.href}|${link.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ctaLinks.push(link);
  }

  return { nav, ctaLinks };
}

/** Parse <Link>/<a> without choking on JSX `=>` inside attributes. */
function extractJsxLinks(
  body: string,
  source: string,
): LiveSiteNavLink[] {
  const out: LiveSiteNavLink[] = [];
  for (const tag of ["Link", "a"] as const) {
    const re =
      tag === "Link"
        ? /<Link\b([\s\S]*?)>([\s\S]*?)<\/Link>/gi
        : /<a\b([\s\S]*?)>([\s\S]*?)<\/a>/gi;
    for (const m of body.matchAll(re)) {
      const attrs = m[1] ?? "";
      const hrefM = attrs.match(/\bhref\s*=\s*["'`]([^"'`]+)["'`]/i);
      if (!hrefM) continue;
      const href = (hrefM[1] ?? "").trim();
      const label = (m[2] ?? "")
        .replace(/\{[\s\S]*?\}/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!href || !label || label.length > 40) continue;
      if (/[{}=]|className|onClick|setMobile/i.test(label)) continue;
      out.push({ label, href, source });
    }
  }
  return out;
}

function collectRoutes(projectRoot: string, files: string[]): string[] {
  return collectRouteFiles(projectRoot, files).map((r) => r.route);
}

function collectPublicAssets(projectRoot: string): string[] {
  const out: string[] = [];
  for (const sub of ["images", "brand", "icons"]) {
    const dir = join(projectRoot, "public", sub);
    if (!existsSync(dir)) continue;
    const files: string[] = [];
    walkFiles(projectRoot, dir, files, 80);
    for (const abs of files) {
      if (!/\.(svg|png|jpe?g|webp|gif|ico)$/i.test(abs)) continue;
      out.push(toProjectRelative(projectRoot, abs));
      if (out.length >= 40) return out;
    }
  }
  return out;
}

function findShellHints(projectRoot: string, files: string[]): string[] {
  const hints: string[] = [];
  for (const abs of files) {
    const rel = toProjectRelative(projectRoot, abs);
    if (
      /(?:layout|sidebar|shell|header|footer)/i.test(basename(rel)) &&
      /\.(tsx|jsx)$/i.test(rel)
    ) {
      hints.push(rel);
    }
    if (hints.length >= 16) break;
  }
  return hints.sort();
}

export function buildLiveSiteInventory(
  projectRoot: string,
): LiveSiteInventory {
  const root = projectRoot;
  const updatedAt = new Date().toISOString();
  if (!existsSync(root)) {
    return {
      projectRoot: root,
      nav: [],
      ctaLinks: [],
      routes: [],
      tokenFiles: [],
      tokenExcerpt: "",
      publicAssets: [],
      logoPaths: [],
      landingCues: "",
      shellHints: [],
      screens: [],
      entities: [],
      updatedAt,
    };
  }

  const files: string[] = [];
  for (const sub of ["src", "app", "components"]) {
    const d = join(root, sub);
    if (existsSync(d)) walkFiles(root, d, files, 500);
  }

  const nav: LiveSiteNavLink[] = [];
  const ctaLinks: LiveSiteNavLink[] = [];
  const seenNav = new Set<string>();
  const headerFiles = files.filter((f) =>
    HEADER_FILE_RE.test(toProjectRelative(root, f)),
  );
  const scanFiles =
    headerFiles.length > 0
      ? headerFiles
      : files.filter((f) => /header|nav/i.test(basename(f)));

  for (const abs of scanFiles) {
    let body = "";
    try {
      body = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const source = toProjectRelative(root, abs);
    const extracted = extractNavLinksFromSource(source, body);
    for (const link of extracted.nav) {
      const key = `${link.href}|${link.label}`;
      if (seenNav.has(key)) continue;
      seenNav.add(key);
      nav.push(link);
    }
    for (const link of extracted.ctaLinks) {
      const key = `cta:${link.href}|${link.label}`;
      if (seenNav.has(key)) continue;
      seenNav.add(key);
      ctaLinks.push(link);
    }
  }

  const tokenFiles = projectTokenCandidates(root).map((p) =>
    toProjectRelative(root, p),
  );
  let tokenExcerpt = "";
  for (const rel of tokenFiles.slice(0, 2)) {
    try {
      const raw = readFileSync(join(root, rel), "utf-8");
      const ex = excerptCssTokens(raw, 1_800);
      if (ex) {
        tokenExcerpt = tokenExcerpt
          ? `${tokenExcerpt}\n\n/* ${rel} */\n${ex}`
          : `/* ${rel} */\n${ex}`;
      }
    } catch {
      /* ignore */
    }
  }

  const consumed = collectConsumedLogoHints(root);
  const logoAbs = preferAuthoritativeLogos(root, consumed);
  const logoPaths = logoAbs.map((p) => toProjectRelative(root, p));

  const { screens, entities } = buildScreenContentInventory(root);

  return {
    projectRoot: root,
    nav,
    ctaLinks,
    routes: collectRoutes(root, files),
    tokenFiles,
    tokenExcerpt: tokenExcerpt.slice(0, 3_500),
    publicAssets: collectPublicAssets(root),
    logoPaths,
    landingCues: excerptLandingCopy(root, 1_500),
    shellHints: findShellHints(root, files),
    screens,
    entities,
    updatedAt,
  };
}

export function liveSiteInventoryPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "SITE_INVENTORY.json");
}

export function writeLiveSiteInventory(
  projectRoot: string,
  loopId: string,
  inventory?: LiveSiteInventory,
): LiveSiteInventory {
  const inv = inventory ?? buildLiveSiteInventory(projectRoot);
  ensureLoopDir(projectRoot, loopId);
  writeFileSync(
    liveSiteInventoryPath(projectRoot, loopId),
    `${JSON.stringify(inv, null, 2)}\n`,
    "utf-8",
  );
  return inv;
}

export function readLiveSiteInventory(
  projectRoot: string,
  loopId: string,
): LiveSiteInventory | null {
  const path = liveSiteInventoryPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as LiveSiteInventory;
    return {
      ...raw,
      screens: Array.isArray(raw.screens) ? raw.screens : [],
      entities: Array.isArray(raw.entities) ? raw.entities : [],
    };
  } catch {
    return null;
  }
}

function ensureLoopDir(projectRoot: string, loopId: string): void {
  mkdirSync(designLoopDir(projectRoot, loopId), { recursive: true });
}

/** Compact summary for API / MCP / Hermes (no large excerpts). */
export function summarizeLiveSiteInventory(inv: LiveSiteInventory) {
  const screens = inv.screens ?? [];
  const entities = inv.entities ?? [];
  return {
    nav: inv.nav,
    ctaLinks: inv.ctaLinks,
    routes: inv.routes.slice(0, 40),
    tokenFiles: inv.tokenFiles,
    logoPaths: inv.logoPaths,
    publicAssets: inv.publicAssets.slice(0, 20),
    shellHints: inv.shellHints.slice(0, 12),
    screens: screens.slice(0, 40).map((s) => ({
      route: s.route,
      headingCount: s.headings?.length ?? 0,
      fieldCount: (s.formFields?.length ?? 0) + (s.tableColumns?.length ?? 0),
      buttonCount: s.buttons?.length ?? 0,
    })),
    entityCount: entities.length,
    updatedAt: inv.updatedAt,
    navLabels: inv.nav.map((n) => n.label),
    navSource: inv.nav[0]?.source ?? null,
  };
}

function formatScreenLine(s: ScreenContent, maxChars = 400): string {
  const parts: string[] = [];
  if (s.headings.length) parts.push(`headings: ${s.headings.slice(0, 6).join(" · ")}`);
  if (s.tableColumns.length) {
    parts.push(`columns: ${s.tableColumns.slice(0, 10).join(", ")}`);
  }
  if (s.formFields.length) {
    parts.push(`fields: ${s.formFields.slice(0, 10).join(", ")}`);
  }
  if (s.buttons.length) parts.push(`buttons: ${s.buttons.slice(0, 8).join(", ")}`);
  if (s.copy.length && parts.length < 3) {
    parts.push(`copy: ${s.copy.slice(0, 4).join(" · ")}`);
  }
  const line = `- \`${s.route}\` (${s.source}): ${parts.join(" | ") || "(structure only)"}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}…`;
}

export function formatLiveSiteInventoryPromptBlock(
  inv: LiveSiteInventory | null | undefined,
  maxChars = 6_500,
  opts?: { sharedDesignActive?: boolean },
): string {
  if (!inv) return "";
  const screens = inv.screens ?? [];
  const entities = inv.entities ?? [];
  const shared = Boolean(opts?.sharedDesignActive);
  const lines: string[] = [
    shared
      ? "## LIVE SITE (authoritative for nav/routes/screen copy only — palette/tokens/logos deferred to SHARED DESIGN)"
      : "## LIVE SITE (authoritative — match this; do not invent nav/menus/tokens/screen copy)",
    "",
    `Project root: \`${inv.projectRoot}\``,
    "",
  ];
  if (inv.nav.length) {
    lines.push("### Primary navigation");
    for (const n of inv.nav) {
      lines.push(`- ${n.label} → \`${n.href}\` (from \`${n.source}\`)`);
    }
    lines.push("");
  } else {
    lines.push("### Primary navigation");
    lines.push("- (none extracted — inspect header/nav components)");
    lines.push("");
  }
  if (inv.ctaLinks.length) {
    lines.push("### Header CTAs");
    for (const n of inv.ctaLinks) {
      lines.push(`- ${n.label} → \`${n.href}\` (from \`${n.source}\`)`);
    }
    lines.push("");
  }
  if (inv.routes.length) {
    lines.push("### App routes (page.tsx)");
    for (const r of inv.routes.slice(0, 40)) lines.push(`- \`${r}\``);
    lines.push("");
  }
  if (screens.length) {
    lines.push(
      "### Screen content (real UI copy — use this verbatim, not placeholder text)",
    );
    for (const s of screens.slice(0, 24)) {
      lines.push(formatScreenLine(s));
    }
    lines.push("");
  }
  if (entities.length) {
    lines.push(
      "### Domain entities (real field names for tables/cards/forms)",
    );
    for (const e of entities.slice(0, 12)) {
      lines.push(`- ${e.name}: ${e.fields.join(", ")} (from \`${e.source}\`)`);
    }
    lines.push("");
  }
  if (inv.logoPaths.length) {
    lines.push("### Logos");
    for (const p of inv.logoPaths) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (inv.tokenFiles.length) {
    lines.push("### Token / theme files");
    for (const p of inv.tokenFiles) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (inv.tokenExcerpt.trim()) {
    lines.push("### Token excerpt");
    lines.push("```css");
    lines.push(inv.tokenExcerpt.trim().slice(0, 2_500));
    lines.push("```");
    lines.push("");
  }
  if (inv.publicAssets.length) {
    lines.push("### Public assets (sample)");
    for (const p of inv.publicAssets.slice(0, 20)) lines.push(`- \`${p}\``);
    lines.push("");
  }
  if (inv.shellHints.length) {
    lines.push("### Shell / layout files");
    for (const p of inv.shellHints.slice(0, 12)) lines.push(`- \`${p}\``);
    lines.push("");
  }
  // Root landing cues only when no structured / screen exists.
  const hasRootScreen = screens.some((s) => s.route === "/");
  if (inv.landingCues.trim() && !hasRootScreen) {
    lines.push("### Landing copy cues");
    lines.push("```");
    lines.push(inv.landingCues.trim().slice(0, 1_200));
    lines.push("```");
    lines.push("");
  }
  const body = lines.join("\n");
  if (body.length <= maxChars) return body;
  return `${body.slice(0, maxChars)}\n…[truncated LIVE SITE inventory]`;
}

/**
 * Replace primary topbar/nav link list in mock HTML with live inventory nav.
 * Preserves surrounding shell markup.
 */
export function patchMockNavFromInventory(
  html: string,
  nav: LiveSiteNavLink[],
): string {
  if (!html.trim() || !nav.length) return html;
  const items = nav
    .map(
      (n, i) =>
        `        <li><a href="${escapeHtmlAttr(n.href)}"${
          i === 0 ? ' class="active"' : ""
        }>${escapeHtmlText(n.label)}</a></li>`,
    )
    .join("\n");

  // Prefer ul.topbar-nav
  if (/class=["'][^"']*topbar-nav[^"']*["']/i.test(html)) {
    return html.replace(
      /(<ul\b[^>]*class=["'][^"']*topbar-nav[^"']*["'][^>]*>)([\s\S]*?)(<\/ul>)/i,
      `$1\n${items}\n      $3`,
    );
  }
  // Fallback: first <nav>…</nav> inner ul or whole nav
  if (/<nav\b/i.test(html)) {
    if (/<nav\b[^>]*>[\s\S]*?<ul\b/i.test(html)) {
      return html.replace(
        /(<nav\b[^>]*>[\s\S]*?<ul\b[^>]*>)([\s\S]*?)(<\/ul>)/i,
        `$1\n${items}\n      $3`,
      );
    }
    return html.replace(
      /(<nav\b[^>]*>)([\s\S]*?)(<\/nav>)/i,
      `$1\n      <ul class="topbar-nav">\n${items}\n      </ul>\n    $3`,
    );
  }
  return html;
}

function escapeHtmlAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
