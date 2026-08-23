/**
 * Shared design elements — versioned controls/patterns (spec + mock + optional TS/JS).
 *
 * Origins (same artifact shape):
 *   A/C — project library: <project>/.slopcontrol/elements/
 *   B   — global registry: <dataDir>/shared-elements/
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  designLoopDir,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  writeDesignLoopMeta,
  type DesignLoopMeta,
} from "./design-loop.js";
import { resolveShareAlias } from "./design-share.js";
import {
  getDesignLoopSelections,
  pinDesignLoopSelection,
  refreshDesignLoopConcepts,
  type DesignLoopMetaWithSelections,
} from "./design-loop-selections.js";
import {
  jamPackageNameForElement,
  resolveProjectPublishScope,
  scaffoldElementNpmPackage,
} from "./npm-registry.js";

const SLOP_DIR = ".slopcontrol";

/** Publish scope for this project: explicit config publishScope → config
 * registryScopes[0] → .npmrc discovery → @slopcontrol default. */
function elementPublishScope(projectRoot: string): string {
  let configScopes: string[] | undefined;
  let publishScope: string | undefined;
  const cfgPath = join(projectRoot, SLOP_DIR, "config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        registryScopes?: string[];
        publishScope?: string;
      };
      configScopes = cfg.registryScopes;
      publishScope = cfg.publishScope;
    } catch {
      /* ignore */
    }
  }
  return resolveProjectPublishScope({
    projectRoot,
    configScopes,
    publishScope,
  });
}

export const DesignElementKindSchema = z.enum(["control", "shell", "pattern"]);
export type DesignElementKind = z.infer<typeof DesignElementKindSchema>;

export const DesignElementOriginSchema = z.enum(["project", "registry"]);
export type DesignElementOrigin = z.infer<typeof DesignElementOriginSchema>;

export const DesignElementMetaSchema = z.object({
  id: z.string().min(1),
  kind: DesignElementKindSchema,
  label: z.string().min(1),
  version: z.number().int().positive(),
  states: z.array(z.string()).default([]),
  a11y: z.array(z.string()).default([]),
  mountHints: z.array(z.string()).default([]),
  themeRequirements: z.array(z.string()).default([]),
  deps: z.array(z.string()).default([]),
  hasCode: z.boolean().default(false),
  status: z.enum(["draft", "published"]).default("published"),
  sourceProjectId: z.string().optional(),
  sourceRootPath: z.string().optional(),
  /** Published npm package name when bridged to the private registry. */
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
  publishedAt: z.string(),
  updatedAt: z.string(),
});
export type DesignElementMeta = z.infer<typeof DesignElementMetaSchema>;

export const DesignElementRefSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  origin: DesignElementOriginSchema,
  /** Project root when origin=project (absolute). */
  sourceRootPath: z.string().optional(),
  sourceName: z.string().optional(),
  label: z.string().optional(),
  kind: DesignElementKindSchema.optional(),
  mountHints: z.array(z.string()).default([]),
  hasCode: z.boolean().default(false),
  /** Loop-relative or phase-relative paths after import. */
  mockPath: z.string().optional(),
  specPath: z.string().optional(),
  codePath: z.string().optional(),
  pinnedAt: z.string().optional(),
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
});
export type DesignElementRef = z.infer<typeof DesignElementRefSchema>;

export const DesignElementIndexEntrySchema = z.object({
  id: z.string(),
  latestVersion: z.number().int().positive(),
  kind: DesignElementKindSchema,
  label: z.string(),
  status: z.enum(["draft", "published"]),
  hasCode: z.boolean().default(false),
  updatedAt: z.string(),
  npmPackage: z.string().optional(),
  npmVersion: z.string().optional(),
});
export type DesignElementIndexEntry = z.infer<
  typeof DesignElementIndexEntrySchema
>;

export const DesignElementIndexSchema = z.object({
  updatedAt: z.string(),
  elements: z.array(DesignElementIndexEntrySchema).default([]),
});
export type DesignElementIndex = z.infer<typeof DesignElementIndexSchema>;

export type DesignElementBundle = {
  meta: DesignElementMeta;
  spec: string;
  mockHtml: string;
  tokensCss: string;
  /** Relative paths under src/ → file contents */
  srcFiles: Record<string, string>;
  rootPath: string;
};

function slugElementId(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "element"
  );
}

export { slugElementId };

/** Candidate control/shell region that can be extracted from a mock. */
export type ExtractableDesignElement = {
  id: string;
  label: string;
  kind: DesignElementKind;
  /** Detection source for the UI. */
  reason: string;
  /** Short HTML excerpt for preview (may be truncated). */
  previewHtml: string;
  /** True when this id already exists in the project element library. */
  alreadyPublished: boolean;
  /** True when matching project source files were found for @jam packaging. */
  hasProjectSource: boolean;
  /** Relative source paths that would be copied into element src/. */
  sourcePaths: string[];
  /** Target npm package name when published. */
  npmPackage: string;
};

const VOID_HTML_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Extract a complete HTML element starting at `openTagIndex` by balancing
 * the same tag name (skips comments, script/style bodies, void tags).
 */
export function extractBalancedElement(
  html: string,
  openTagIndex: number,
): string {
  if (openTagIndex < 0 || openTagIndex >= html.length) return "";
  if (html[openTagIndex] !== "<") return "";
  const openMatch = html
    .slice(openTagIndex)
    .match(/^<([a-zA-Z][\w:-]*)(\s[^>]*)?>/);
  if (!openMatch) return "";
  const tag = openMatch[1]!.toLowerCase();
  const openLen = openMatch[0].length;
  // Self-closing open tag
  if (/\/\s*>$/.test(openMatch[0]) || VOID_HTML_TAGS.has(tag)) {
    return html.slice(openTagIndex, openTagIndex + openLen);
  }

  let i = openTagIndex + openLen;
  let depth = 1;
  const lower = html.toLowerCase();
  const openNeedle = `<${tag}`;
  const closeNeedle = `</${tag}`;

  while (i < html.length && depth > 0) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    if (lower.startsWith("<script", i)) {
      const end = lower.indexOf("</script>", i + 7);
      i = end === -1 ? html.length : end + "</script>".length;
      continue;
    }
    if (lower.startsWith("<style", i)) {
      const end = lower.indexOf("</style>", i + 6);
      i = end === -1 ? html.length : end + "</style>".length;
      continue;
    }
    if (lower.startsWith(closeNeedle, i)) {
      const after = html.slice(i + closeNeedle.length);
      if (after.match(/^\s*>/)) {
        depth -= 1;
        const closeEnd = i + closeNeedle.length + after.match(/^\s*>/)![0].length;
        if (depth === 0) {
          return html.slice(openTagIndex, closeEnd);
        }
        i = closeEnd;
        continue;
      }
    }
    if (lower.startsWith(openNeedle, i)) {
      const rest = html.slice(i + openNeedle.length);
      // word boundary after tag name
      if (rest.match(/^[\s/>]/)) {
        const tagEnd = html.indexOf(">", i + 1);
        if (tagEnd === -1) break;
        const fullOpen = html.slice(i, tagEnd + 1);
        if (!/\/\s*>$/.test(fullOpen) && !VOID_HTML_TAGS.has(tag)) {
          depth += 1;
        }
        i = tagEnd + 1;
        continue;
      }
    }
    i += 1;
  }
  return "";
}

function classAttrHas(classAttr: string, className: string): boolean {
  return classAttr
    .split(/\s+/)
    .filter(Boolean)
    .some((c) => c.toLowerCase() === className.toLowerCase());
}

/** Find first element with a given class (optional tag allow-list) and return balanced outerHTML. */
export function extractByClass(
  html: string,
  className: string,
  tagHint?: string[],
): string {
  const re = /<([a-zA-Z][\w:-]*)\b([^>]*?)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[1]!.toLowerCase();
    if (tagHint?.length && !tagHint.map((t) => t.toLowerCase()).includes(tag)) {
      continue;
    }
    const attrs = m[2] ?? "";
    const classMatch = attrs.match(/\bclass\s*=\s*(["'])([^"']*)\1/i);
    if (!classMatch) continue;
    if (!classAttrHas(classMatch[2] ?? "", className)) continue;
    const block = extractBalancedElement(html, m.index);
    if (block) return block;
  }
  return "";
}

/** Find first element with attr="value" and return balanced outerHTML. */
export function extractByAttr(
  html: string,
  attr: string,
  value: string,
): string {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<([a-zA-Z][\\w:-]*)\\b([^>]*?\\b${attr}\\s*=\\s*(["'])${escaped}\\3[^>]*)>`,
    "i",
  );
  const m = re.exec(html);
  if (!m) return "";
  return extractBalancedElement(html, m.index);
}

function extractSignInControl(html: string): string {
  // Prefer explicit sign-in markers on the control itself.
  const byAttr =
    extractByAttr(html, "href", "#signin") ||
    extractByAttr(html, "href", "#sign-in") ||
    extractByAttr(html, "id", "signin") ||
    extractByAttr(html, "id", "sign-in") ||
    extractByClass(html, "sign-in", ["a", "button"]) ||
    extractByClass(html, "signin", ["a", "button"]);
  if (byAttr) return byAttr;

  const re = /<(a|button)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const block = extractBalancedElement(html, m.index);
    if (!block) continue;
    const text = block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (/^sign[\s-]?in$/i.test(text) || /\bsign[\s-]?in\b/i.test(text)) {
      // Avoid grabbing a huge parent; require the control's own text to mention sign-in
      // and keep length modest.
      if (block.length <= 800) return block;
    }
  }
  return "";
}

type KnownExtractPattern = {
  id: string;
  label: string;
  kind: DesignElementKind;
  test: (html: string) => boolean;
  snippet: (html: string) => string;
  reason: string;
};

const KNOWN_EXTRACT_PATTERNS: KnownExtractPattern[] = [
  {
    id: "theme-toggle",
    label: "Theme toggle (day / night)",
    kind: "control",
    reason: "class theme-toggle or day/night toggle button",
    test: (html) =>
      /\btheme-toggle\b/i.test(html) ||
      /<(?:button|div|label)[^>]*>[\s\S]{0,200}?(?:dark\s*\/\s*light|day\s*\/\s*night|theme\s*toggle)/i.test(
        html,
      ),
    snippet: (html) =>
      extractByClass(html, "theme-toggle", ["button", "div", "label"]) ||
      extractByAttr(html, "data-element", "theme-toggle") ||
      "",
  },
  {
    id: "menubar",
    label: "Menubar / top navigation",
    kind: "shell",
    reason: "class menubar or topbar header chrome",
    test: (html) => /\b(?:menubar|topbar)\b/i.test(html),
    snippet: (html) =>
      extractByClass(html, "menubar", ["header", "nav", "div"]) ||
      extractByClass(html, "topbar", ["header", "nav", "div"]) ||
      "",
  },
  {
    id: "user-pill",
    label: "User pill / account control",
    kind: "control",
    reason: "class user-pill",
    test: (html) => /\buser-pill\b/i.test(html),
    snippet: (html) =>
      extractByClass(html, "user-pill", ["div", "button", "a"]) || "",
  },
  {
    id: "view-switcher",
    label: "View switcher",
    kind: "control",
    reason: "class view-switcher",
    test: (html) => /\bview-switcher\b/i.test(html),
    snippet: (html) =>
      extractByClass(html, "view-switcher", ["div", "nav", "ul"]) || "",
  },
  {
    id: "dashboard-sidebar",
    label: "Dashboard sidebar",
    kind: "shell",
    reason: "class dashboard-sidebar or dash-sidebar",
    test: (html) => /\b(?:dashboard-sidebar|dash-sidebar)\b/i.test(html),
    snippet: (html) =>
      extractByClass(html, "dashboard-sidebar", ["aside", "nav", "div"]) ||
      extractByClass(html, "dash-sidebar", ["aside", "nav", "div"]) ||
      "",
  },
  {
    id: "dashboard-shell",
    label: "Dashboard shell / layout",
    kind: "shell",
    reason: "class dashboard-shell or dashboard-layout",
    test: (html) => /\b(?:dashboard-shell|dashboard-layout)\b/i.test(html),
    snippet: (html) =>
      extractByClass(html, "dashboard-shell", ["div", "section", "main"]) ||
      extractByClass(html, "dashboard-layout", ["div", "section", "main"]) ||
      "",
  },
  {
    id: "sign-in",
    label: "Sign-in control",
    kind: "control",
    reason: "sign-in link or control in chrome",
    test: (html) =>
      /\bsign-?in\b/i.test(html) &&
      /<(?:a|button)\b/i.test(html),
    snippet: (html) => extractSignInControl(html),
  },
];

/** Default project-relative source candidates for known element ids. */
const ELEMENT_SOURCE_CANDIDATES: Record<string, string[]> = {
  "theme-toggle": [
    "src/components/shell/theme-toggle.tsx",
    "src/components/shell/theme-toggle.ts",
    "src/hooks/useTheme.ts",
  ],
  menubar: [
    "src/components/shell/menubar.tsx",
    "src/components/shell/menubar.ts",
  ],
  "user-pill": [
    "src/components/shell/user-pill.tsx",
    "src/components/shell/user-pill.ts",
  ],
  "view-switcher": [
    "src/components/shell/view-switcher.tsx",
    "src/components/shell/view-switcher.ts",
  ],
  "dashboard-sidebar": [
    "src/components/dashboard/dashboard-sidebar.tsx",
    "src/components/dashboard/dashboard-sidebar.ts",
  ],
  "dashboard-shell": [
    "src/components/dashboard/dashboard-shell.tsx",
    "src/components/dashboard/dashboard-shell.ts",
  ],
};

/**
 * Resolve existing source files for an element under a project root.
 * Returns paths relative to projectRoot and file contents keyed for element src/.
 */
export function collectSourceFilesForElement(
  projectRoot: string,
  elementId: string,
): { sourcePaths: string[]; srcFiles: Record<string, string> } {
  const id = slugElementId(elementId);
  const candidates = ELEMENT_SOURCE_CANDIDATES[id] ?? [];
  const sourcePaths: string[] = [];
  const srcFiles: Record<string, string> = {};
  if (!projectRoot || !existsSync(projectRoot)) {
    return { sourcePaths, srcFiles };
  }
  for (const rel of candidates) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    sourcePaths.push(rel);
    // Strip leading src/ for element src/ tree
    const underSrc = rel.replace(/^src\//, "");
    srcFiles[underSrc] = readFileSync(abs, "utf-8");
  }
  return { sourcePaths, srcFiles };
}

function truncatePreview(html: string, max = 400): string {
  const t = html.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** Harvest CSS rules whose selectors mention the root class. */
export function harvestCssForClass(html: string, className: string): string {
  const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (m) => m[1] ?? "",
  );
  if (!styles.length) return "";
  const css = styles.join("\n");
  const needle = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules: string[] = [];
  // Rough rule splitter — good enough for mock <style> blocks.
  const chunks = css.split(/\}/);
  for (const chunk of chunks) {
    const body = chunk.trim();
    if (!body) continue;
    const rule = `${body}}`;
    if (new RegExp(`\\.${needle}\\b`, "i").test(rule)) {
      rules.push(rule.trim());
    }
  }
  // Also keep :root / data-theme tokens when harvesting theme-related classes
  if (/theme/i.test(className)) {
    for (const m of css.matchAll(/:root\s*\{[\s\S]*?\}/g)) {
      rules.unshift(m[0]);
    }
    for (const m of css.matchAll(
      /\[data-theme\s*=\s*["'][^"']+["']\]\s*\{[\s\S]*?\}/g,
    )) {
      rules.push(m[0]);
    }
  }
  return [...new Set(rules)].join("\n\n");
}

type ExtractableRegion = {
  id: string;
  label: string;
  kind: DesignElementKind;
  reason: string;
  html: string;
};

/** Collect full HTML regions for extractable controls (deduped by id). */
function collectExtractableRegions(html: string): ExtractableRegion[] {
  const source = html ?? "";
  const byId = new Map<string, ExtractableRegion>();

  const push = (c: ExtractableRegion) => {
    const id = slugElementId(c.id);
    if (!id || byId.has(id)) return;
    byId.set(id, { ...c, id });
  };

  // 1. Explicit data-element markers (authoritative names).
  for (const m of source.matchAll(/data-element=["']([^"']+)["']/gi)) {
    const rawId = m[1]?.trim() ?? "";
    if (!rawId) continue;
    const id = slugElementId(rawId);
    // Walk back to the opening '<' of this tag
    let openIdx = m.index ?? 0;
    while (openIdx > 0 && source[openIdx] !== "<") openIdx -= 1;
    const block =
      extractByAttr(source, "data-element", rawId) ||
      extractBalancedElement(source, openIdx) ||
      `<div data-element="${id}"></div>`;
    push({
      id,
      label: id
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
      kind: /shell|menubar|sidebar|layout/i.test(id) ? "shell" : "control",
      reason: `data-element="${rawId}"`,
      html: block,
    });
  }

  // 2. Known chrome patterns.
  for (const p of KNOWN_EXTRACT_PATTERNS) {
    if (!p.test(source)) continue;
    const snip = p.snippet(source);
    push({
      id: p.id,
      label: p.label,
      kind: p.kind,
      reason: p.reason,
      html: snip || `<div class="${p.id}" data-element="${p.id}"></div>`,
    });
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Scan mock HTML for extractable shared-element candidates.
 * Prefer `data-element` markers; also detect known chrome patterns
 * (menubar, theme-toggle, user-pill, …). Ids are stable slugs for extract.
 */
export function listExtractableDesignElementsFromMock(
  html: string,
  opts?: { publishedIds?: Iterable<string>; projectRoot?: string },
): ExtractableDesignElement[] {
  const published = new Set(
    [...(opts?.publishedIds ?? [])].map((id) => slugElementId(id)),
  );
  const npmScope = opts?.projectRoot
    ? elementPublishScope(opts.projectRoot)
    : undefined;
  return collectExtractableRegions(html).map((r) => {
    const source = opts?.projectRoot
      ? collectSourceFilesForElement(opts.projectRoot, r.id)
      : { sourcePaths: [] as string[], srcFiles: {} };
    return {
      id: r.id,
      label: r.label,
      kind: r.kind,
      reason: r.reason,
      previewHtml: truncatePreview(r.html),
      alreadyPublished: published.has(r.id),
      hasProjectSource: source.sourcePaths.length > 0,
      sourcePaths: source.sourcePaths,
      npmPackage: jamPackageNameForElement(r.id, npmScope),
    };
  });
}

/**
 * Resolve one extractable region by id (full HTML, not preview-truncated).
 */
export function resolveExtractableDesignElement(
  html: string,
  elementId: string,
): ExtractableRegion | null {
  const id = slugElementId(elementId);
  return collectExtractableRegions(html).find((r) => r.id === id) ?? null;
}

/**
 * List extractable candidates from a design-loop mock version.
 * Marks ids already published in the project element library.
 */
export function listExtractableDesignElementsFromLoop(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
}): ExtractableDesignElement[] {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const version = opts.version ?? meta.currentVersion;
  const html =
    readDesignLoopMockHtml(opts.projectRoot, opts.loopId, version) ?? "";
  if (!html.trim()) {
    throw new Error(`No mock HTML for ${opts.loopId} v${version}`);
  }
  const publishedIds = listProjectElements(opts.projectRoot).map((e) => e.id);
  return listExtractableDesignElementsFromMock(html, {
    publishedIds,
    projectRoot: opts.projectRoot,
  });
}

export function projectElementsRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR, "elements");
}

export function registryElementsRoot(dataDir: string): string {
  return join(dataDir, "shared-elements");
}

export function elementVersionDir(
  libraryRoot: string,
  elementId: string,
  version: number,
): string {
  return join(libraryRoot, elementId, `v${version}`);
}

export function elementIndexPath(libraryRoot: string): string {
  return join(libraryRoot, "INDEX.json");
}

export function readElementIndex(libraryRoot: string): DesignElementIndex {
  const path = elementIndexPath(libraryRoot);
  if (!existsSync(path)) {
    return { updatedAt: new Date().toISOString(), elements: [] };
  }
  try {
    return DesignElementIndexSchema.parse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
  } catch {
    return { updatedAt: new Date().toISOString(), elements: [] };
  }
}

function writeElementIndex(
  libraryRoot: string,
  index: DesignElementIndex,
): void {
  mkdirSync(libraryRoot, { recursive: true });
  writeFileSync(
    elementIndexPath(libraryRoot),
    `${JSON.stringify({ ...index, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
}

function upsertIndexEntry(
  libraryRoot: string,
  meta: DesignElementMeta,
): void {
  const index = readElementIndex(libraryRoot);
  const next: DesignElementIndexEntry = {
    id: meta.id,
    latestVersion: meta.version,
    kind: meta.kind,
    label: meta.label,
    status: meta.status,
    hasCode: meta.hasCode,
    updatedAt: meta.updatedAt,
    npmPackage: meta.npmPackage,
    npmVersion: meta.npmVersion,
  };
  const others = index.elements.filter((e) => e.id !== meta.id);
  writeElementIndex(libraryRoot, {
    updatedAt: meta.updatedAt,
    elements: [...others, next].sort((a, b) => a.id.localeCompare(b.id)),
  });
}

function readSrcTree(srcDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(srcDir)) return out;
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, rel);
      else if (st.isFile() && st.size < 400_000) {
        try {
          out[rel] = readFileSync(full, "utf-8");
        } catch {
          /* skip binary */
        }
      }
    }
  };
  walk(srcDir, "");
  return out;
}

function writeSrcTree(srcDir: string, files: Record<string, string>): void {
  mkdirSync(srcDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const dest = join(srcDir, rel);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, body, "utf-8");
  }
}

export function readDesignElementBundle(
  libraryRoot: string,
  elementId: string,
  version: number,
): DesignElementBundle | null {
  const dir = elementVersionDir(libraryRoot, elementId, version);
  const metaPath = join(dir, "ELEMENT.json");
  if (!existsSync(metaPath)) return null;
  try {
    const meta = DesignElementMetaSchema.parse(
      JSON.parse(readFileSync(metaPath, "utf-8")),
    );
    const spec = existsSync(join(dir, "SPEC.md"))
      ? readFileSync(join(dir, "SPEC.md"), "utf-8")
      : "";
    const mockHtml = existsSync(join(dir, "mock.html"))
      ? readFileSync(join(dir, "mock.html"), "utf-8")
      : "";
    const tokensCss = existsSync(join(dir, "tokens.css"))
      ? readFileSync(join(dir, "tokens.css"), "utf-8")
      : "";
    return {
      meta,
      spec,
      mockHtml,
      tokensCss,
      srcFiles: readSrcTree(join(dir, "src")),
      rootPath: dir,
    };
  } catch {
    return null;
  }
}

export function listProjectElements(
  projectRoot: string,
): DesignElementIndexEntry[] {
  return readElementIndex(projectElementsRoot(projectRoot)).elements;
}

export function listRegistryElements(dataDir: string): DesignElementIndexEntry[] {
  return readElementIndex(registryElementsRoot(dataDir)).elements;
}

export type ResolveDesignElementOpts = {
  elementId: string;
  version?: number;
  /** Explicit: registry | project:<name|id|path> */
  origin?: string;
  targetRoot: string;
  dataDir?: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
};

function libraryForOrigin(
  origin: DesignElementOrigin,
  opts: { projectRoot?: string; dataDir?: string },
): string | null {
  if (origin === "registry") {
    return opts.dataDir ? registryElementsRoot(opts.dataDir) : null;
  }
  return opts.projectRoot ? projectElementsRoot(opts.projectRoot) : null;
}

function resolveProjectRootByName(
  name: string,
  targetRoot: string,
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>,
): string | null {
  const want = resolveShareAlias(name).toLowerCase();
  const projects = listProjects?.() ?? [];
  const byStore = projects.find(
    (p) =>
      p.name.toLowerCase() === want ||
      p.name.toLowerCase() === name.toLowerCase() ||
      p.id === name ||
      basename(p.rootPath.replace(/\/$/, "")).toLowerCase() === want,
  );
  if (byStore) return byStore.rootPath;
  const parent = join(targetRoot, "..");
  const candidate = join(parent, resolveShareAlias(name));
  if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * Resolve an element id across project libs, registry, aliases, and federated store.
 */
export function resolveDesignElement(
  opts: ResolveDesignElementOpts,
): DesignElementBundle | null {
  const id = slugElementId(opts.elementId);
  const dataDir = opts.dataDir;

  const tryLib = (
    libraryRoot: string | null,
    version?: number,
  ): DesignElementBundle | null => {
    if (!libraryRoot) return null;
    const index = readElementIndex(libraryRoot);
    const entry = index.elements.find((e) => e.id === id);
    const v = version ?? entry?.latestVersion;
    if (!v) return null;
    return readDesignElementBundle(libraryRoot, id, v);
  };

  // 1. Explicit origin
  if (opts.origin?.trim()) {
    const o = opts.origin.trim().toLowerCase();
    if (o === "registry") {
      return tryLib(
        dataDir ? registryElementsRoot(dataDir) : null,
        opts.version,
      );
    }
    const projMatch = o.match(/^project:(.+)$/);
    if (projMatch?.[1]) {
      const nameOrPath = projMatch[1];
      const root = nameOrPath.startsWith("/")
        ? nameOrPath
        : resolveProjectRootByName(
            nameOrPath,
            opts.targetRoot,
            opts.listProjects,
          );
      return root ? tryLib(projectElementsRoot(root), opts.version) : null;
    }
  }

  // 2. Target project library
  const local = tryLib(projectElementsRoot(opts.targetRoot), opts.version);
  if (local) return local;

  // 3. Global registry
  if (dataDir) {
    const reg = tryLib(registryElementsRoot(dataDir), opts.version);
    if (reg) return reg;
  }

  // 4. Federated scan of registered projects
  for (const p of opts.listProjects?.() ?? []) {
    if (p.rootPath.replace(/\/$/, "") === opts.targetRoot.replace(/\/$/, "")) {
      continue;
    }
    const hit = tryLib(projectElementsRoot(p.rootPath), opts.version);
    if (hit) return hit;
  }

  return null;
}

export type PublishDesignElementOpts = {
  projectRoot: string;
  elementId: string;
  kind?: DesignElementKind;
  label?: string;
  spec: string;
  mockHtml: string;
  tokensCss?: string;
  srcFiles?: Record<string, string>;
  states?: string[];
  a11y?: string[];
  mountHints?: string[];
  themeRequirements?: string[];
  deps?: string[];
  /** Also copy into ~/.slopcontrol/shared-elements (B). */
  publishToRegistry?: boolean;
  dataDir?: string;
  sourceProjectId?: string;
  status?: "draft" | "published";
};

export function publishDesignElement(
  opts: PublishDesignElementOpts,
): DesignElementMeta {
  const id = slugElementId(opts.elementId);
  const libraryRoot = projectElementsRoot(opts.projectRoot);
  mkdirSync(libraryRoot, { recursive: true });
  const index = readElementIndex(libraryRoot);
  const prior = index.elements.find((e) => e.id === id);
  const version = (prior?.latestVersion ?? 0) + 1;
  const now = new Date().toISOString();
  const srcFiles = opts.srcFiles ?? {};
  const hasCode = Object.keys(srcFiles).length > 0;
  const meta = DesignElementMetaSchema.parse({
    id,
    kind: opts.kind ?? "control",
    label: opts.label?.trim() || id,
    version,
    states: opts.states ?? [],
    a11y: opts.a11y ?? [],
    mountHints: opts.mountHints ?? [],
    themeRequirements: opts.themeRequirements ?? [],
    deps: opts.deps ?? [],
    hasCode,
    status: opts.status ?? "published",
    sourceProjectId: opts.sourceProjectId,
    sourceRootPath: opts.projectRoot,
    publishedAt: now,
    updatedAt: now,
  });

  const dir = elementVersionDir(libraryRoot, id, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ELEMENT.json"), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(dir, "SPEC.md"), opts.spec.trim() + "\n", "utf-8");
  writeFileSync(join(dir, "mock.html"), opts.mockHtml.trim() + "\n", "utf-8");
  if (opts.tokensCss?.trim()) {
    writeFileSync(join(dir, "tokens.css"), opts.tokensCss.trim() + "\n", "utf-8");
  }
  if (hasCode) writeSrcTree(join(dir, "src"), srcFiles);
  // Always scaffold @<scope>/<id> — code entry when present, else mock/tokens exports.
  const scope = elementPublishScope(opts.projectRoot);
  scaffoldElementNpmPackage({
    outDir: join(dir, "npm-package"),
    elementId: id,
    version,
    label: meta.label,
    srcFiles,
    description: meta.label,
    mockHtml: opts.mockHtml,
    tokensCss: opts.tokensCss,
    scope,
  });
  writeFileSync(
    join(dir, "META.json"),
    `${JSON.stringify(
      {
        publishedAt: now,
        sourceProjectId: opts.sourceProjectId,
        sourceRootPath: opts.projectRoot,
        status: meta.status,
      },
      null,
      2,
    )}\n`,
  );
  upsertIndexEntry(libraryRoot, meta);

  if (opts.publishToRegistry && opts.dataDir) {
    const regRoot = registryElementsRoot(opts.dataDir);
    const regDir = elementVersionDir(regRoot, id, version);
    mkdirSync(regDir, { recursive: true });
    for (const name of [
      "ELEMENT.json",
      "SPEC.md",
      "mock.html",
      "tokens.css",
      "META.json",
    ]) {
      const src = join(dir, name);
      if (existsSync(src)) copyFileSync(src, join(regDir, name));
    }
    if (hasCode) {
      const regSrc = join(regDir, "src");
      if (existsSync(regSrc)) rmSync(regSrc, { recursive: true, force: true });
      writeSrcTree(regSrc, srcFiles);
    }
    scaffoldElementNpmPackage({
      outDir: join(regDir, "npm-package"),
      elementId: id,
      version,
      label: meta.label,
      srcFiles,
      description: meta.label,
      mockHtml: opts.mockHtml,
      tokensCss: opts.tokensCss,
      scope,
    });
    upsertIndexEntry(regRoot, meta);
  }

  return meta;
}

/** Extract a theme-toggle (or generic control) snippet from full mock HTML. */
export function extractDesignElementFromMock(opts: {
  html: string;
  elementId?: string;
  kind?: DesignElementKind;
  label?: string;
  brief?: string;
  /** When set, copy matching project source into src/ for @jam packaging. */
  projectRoot?: string;
}): {
  elementId: string;
  kind: DesignElementKind;
  label: string;
  mockHtml: string;
  spec: string;
  tokensCss: string;
  states: string[];
  a11y: string[];
  mountHints: string[];
  themeRequirements: string[];
  srcFiles: Record<string, string>;
  sourcePaths: string[];
  npmPackage: string;
} {
  const html = opts.html ?? "";
  const requestedId = opts.elementId?.trim()
    ? slugElementId(opts.elementId)
    : "";
  const region = requestedId
    ? resolveExtractableDesignElement(html, requestedId)
    : null;
  const candidates = collectExtractableRegions(html);
  const fallbackRegion =
    region ??
    (!requestedId
      ? (candidates.find((c) => c.id === "theme-toggle") ??
        candidates[0] ??
        null)
      : null);

  const isTheme =
    (fallbackRegion?.id === "theme-toggle" ||
      requestedId === "theme-toggle" ||
      /theme\.?toggle/i.test(opts.elementId ?? "")) &&
    (Boolean(fallbackRegion) ||
      /\btheme-toggle\b/i.test(html) ||
      /\b(day|night|dark\s*\/\s*light|theme)\s*toggle\b/i.test(
        opts.brief ?? "",
      ));

  const elementId = slugElementId(
    requestedId ||
      fallbackRegion?.id ||
      (isTheme ? "theme-toggle" : "shared-control"),
  );
  const kind: DesignElementKind =
    opts.kind ?? fallbackRegion?.kind ?? (isTheme ? "control" : "control");
  const label =
    opts.label?.trim() ||
    fallbackRegion?.label ||
    (isTheme ? "Theme toggle (day / night)" : elementId);

  // Prefer the resolved region for the requested / listed id.
  let snippet = fallbackRegion?.html?.trim() ?? "";
  if (!snippet && isTheme) {
    snippet =
      extractByClass(html, "theme-toggle", ["button", "div", "label"]) ||
      extractByAttr(html, "data-element", "theme-toggle") ||
      "";
  }
  if (!snippet.trim()) {
    if (requestedId && !fallbackRegion) {
      throw new Error(
        `No extractable element "${elementId}" in mock. Call list_extractable_design_elements first and use a listed id.`,
      );
    }
    snippet = isTheme
      ? `<button type="button" class="theme-toggle" aria-label="Toggle dark and light theme" data-element="theme-toggle">Dark / Light</button>
<script>
(function(){
  var root=document.documentElement;
  var btn=document.querySelector('[data-element="theme-toggle"],.theme-toggle');
  if(!btn) return;
  btn.addEventListener('click',function(){
    var next=root.getAttribute('data-theme')==='light'?'dark':'light';
    root.setAttribute('data-theme',next);
  });
})();
</script>`
      : `<div data-element="${elementId}" class="shared-element"><!-- define control --></div>`;
  }

  const classRoots = [
    elementId,
    ...(elementId === "dashboard-shell" ? ["dashboard-layout"] : []),
    ...(elementId === "menubar" ? ["topbar"] : []),
  ];
  const harvested = classRoots
    .map((c) => harvestCssForClass(html, c))
    .filter(Boolean)
    .join("\n\n");
  const styleChunks = [
    harvested,
    ...(html.match(/:root\s*\{[\s\S]*?\}/) ?? []),
    ...(html.match(/\[data-theme\s*=\s*["']light["']\]\s*\{[\s\S]*?\}/) ?? []),
  ].filter(Boolean);
  const tokensCss = [...new Set(styleChunks)].join("\n\n");

  const wrapInHeader =
    kind === "control" || elementId === "theme-toggle" || elementId === "sign-in";
  const mockHtml = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8"/>
<title>${label}</title>
<style>
${tokensCss || `:root{--background:#0A0A0A;--foreground:#F5F0E8}[data-theme="light"]{--background:#FDF8F3;--foreground:#1A1510}`}
body{margin:0;font-family:system-ui,sans-serif;background:var(--background);color:var(--foreground);padding:2rem}
.theme-toggle, [data-element]{cursor:pointer}
</style>
</head>
<body>
${wrapInHeader ? `<header data-mount="menubar">\n${snippet}\n</header>` : snippet}
</body>
</html>`;

  const states = isTheme
    ? ["dark", "light", "toggle"]
    : ["default"];
  const a11y = isTheme
    ? [
        "Button has accessible name (aria-label or visible text)",
        "Toggle updates html[data-theme] between dark and light",
      ]
    : ["Control is keyboard focusable"];
  const mountHints = isTheme
    ? ["menubar", "header", "topbar"]
    : kind === "shell"
      ? ["host", elementId]
      : ["host"];
  const themeRequirements = isTheme
    ? [
        "Toggle must set document.documentElement.dataset.theme (html[data-theme])",
        "Do not invent a second competing theme control when this element is pinned",
      ]
    : [];

  const fromProject = opts.projectRoot
    ? collectSourceFilesForElement(opts.projectRoot, elementId)
    : { sourcePaths: [] as string[], srcFiles: {} as Record<string, string> };

  const themeFallbackSrc: Record<string, string> = isTheme
    ? {
        "theme-toggle.ts": `/** Plain TS theme toggle — framework apps wrap as needed. */
export type ThemeMode = "dark" | "light";

export function getThemeMode(root: HTMLElement = document.documentElement): ThemeMode {
  return root.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function setThemeMode(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  root.setAttribute("data-theme", mode);
}

export function toggleThemeMode(root: HTMLElement = document.documentElement): ThemeMode {
  const next: ThemeMode = getThemeMode(root) === "light" ? "dark" : "light";
  setThemeMode(next, root);
  return next;
}

export function bindThemeToggle(button: HTMLElement, root: HTMLElement = document.documentElement): () => void {
  const onClick = () => { toggleThemeMode(root); };
  button.addEventListener("click", onClick);
  return () => button.removeEventListener("click", onClick);
}
`,
        "theme-toggle.css": `.theme-toggle {
  appearance: none;
  border: 1px solid color-mix(in oklab, var(--foreground) 35%, transparent);
  background: color-mix(in oklab, var(--background) 80%, var(--foreground));
  color: var(--foreground);
  border-radius: 0.5rem;
  padding: 0.35rem 0.75rem;
  font: inherit;
  cursor: pointer;
}
.theme-toggle:focus-visible { outline: 2px solid var(--foreground); outline-offset: 2px; }
`,
      }
    : {};

  // Prefer project source over hardcoded theme scaffold.
  const srcFiles =
    Object.keys(fromProject.srcFiles).length > 0
      ? fromProject.srcFiles
      : themeFallbackSrc;

  const npmPackage = jamPackageNameForElement(
    elementId,
    opts.projectRoot ? elementPublishScope(opts.projectRoot) : undefined,
  );

  const spec = [
    `# ${label}`,
    "",
    `Element id: \`${elementId}\``,
    `Kind: ${kind}`,
    `npm: \`${npmPackage}\``,
    "",
    "## Behavior",
    isTheme
      ? "- Clicking the control toggles `html[data-theme]` between `dark` and `light`."
      : "- Implement per mock and mount hints.",
    "",
    "## Mount",
    ...mountHints.map((h) => `- ${h}`),
    "",
    "## Accessibility",
    ...a11y.map((a) => `- ${a}`),
    "",
    ...(fromProject.sourcePaths.length
      ? [
          "## Source",
          ...fromProject.sourcePaths.map((p) => `- \`${p}\``),
          "",
        ]
      : []),
    "## Must not",
    "- Do not invent a competing control when this element is pinned in a design loop.",
    opts.brief?.trim() ? `\n## Source brief\n${opts.brief.trim().slice(0, 800)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    elementId,
    kind,
    label,
    mockHtml,
    spec,
    tokensCss,
    states,
    a11y,
    mountHints,
    themeRequirements,
    srcFiles,
    sourcePaths: fromProject.sourcePaths,
    npmPackage,
  };
}

export type DesignLoopMetaWithElements = DesignLoopMeta & {
  elements?: DesignElementRef[];
};

export function getDesignLoopElements(
  meta: DesignLoopMeta | null | undefined,
): DesignElementRef[] {
  const raw = (meta as DesignLoopMetaWithElements | null)?.elements;
  return Array.isArray(raw) ? raw : [];
}

export function readDesignLoopElements(
  projectRoot: string,
  loopId: string,
): DesignElementRef[] {
  return getDesignLoopElements(readDesignLoopMeta(projectRoot, loopId));
}

/** Copy element assets into the loop and pin as a selection + META.elements. */
export function importDesignElementIntoLoop(opts: {
  targetRoot: string;
  loopId: string;
  bundle: DesignElementBundle;
  origin: DesignElementOrigin;
  sourceName?: string;
}): DesignElementRef {
  const meta = readDesignLoopMeta(opts.targetRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);

  const elDir = join(
    designLoopDir(opts.targetRoot, opts.loopId),
    "elements",
    opts.bundle.meta.id,
    `v${opts.bundle.meta.version}`,
  );
  mkdirSync(elDir, { recursive: true });
  writeFileSync(
    join(elDir, "ELEMENT.json"),
    `${JSON.stringify(opts.bundle.meta, null, 2)}\n`,
  );
  writeFileSync(join(elDir, "SPEC.md"), opts.bundle.spec.trim() + "\n");
  writeFileSync(join(elDir, "mock.html"), opts.bundle.mockHtml.trim() + "\n");
  if (opts.bundle.tokensCss.trim()) {
    writeFileSync(join(elDir, "tokens.css"), opts.bundle.tokensCss.trim() + "\n");
  }
  if (Object.keys(opts.bundle.srcFiles).length) {
    writeSrcTree(join(elDir, "src"), opts.bundle.srcFiles);
  }

  const base = `.slopcontrol/design-loops/${opts.loopId}/elements/${opts.bundle.meta.id}/v${opts.bundle.meta.version}`;
  const ref = DesignElementRefSchema.parse({
    id: opts.bundle.meta.id,
    version: opts.bundle.meta.version,
    origin: opts.origin,
    sourceRootPath: opts.bundle.meta.sourceRootPath,
    sourceName: opts.sourceName,
    label: opts.bundle.meta.label,
    kind: opts.bundle.meta.kind,
    mountHints: opts.bundle.meta.mountHints,
    hasCode: opts.bundle.meta.hasCode,
    mockPath: `${base}/mock.html`,
    specPath: `${base}/SPEC.md`,
    codePath: opts.bundle.meta.hasCode ? `${base}/src` : undefined,
    pinnedAt: new Date().toISOString(),
  });

  const prior = getDesignLoopElements(meta).filter((e) => e.id !== ref.id);
  const nextMeta: DesignLoopMetaWithElements = {
    ...meta,
    elements: [...prior, ref],
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.targetRoot, nextMeta);

  try {
    pinDesignLoopSelection({
      projectRoot: opts.targetRoot,
      loopId: opts.loopId,
      slot: "element",
      conceptId: `${ref.id}@${ref.version}`,
      label: ref.label || ref.id,
      excerpt: `Shared element ${ref.id} v${ref.version}`,
    });
  } catch {
    /* pin best-effort */
  }

  return ref;
}

/** Inner HTML of element mock `<body>` (or full document fallback). */
export function extractElementBodyHtml(mockHtml: string): string {
  const body = mockHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1]?.trim();
  return body || mockHtml.trim();
}

function elementTokensPath(mockPath: string): string {
  return mockPath.replace(/mock\.html$/i, "tokens.css");
}

export function formatDesignElementsPromptBlock(
  elements: DesignElementRef[] | null | undefined,
  opts?: { projectRoot?: string; loopId?: string },
): string {
  if (!elements?.length) return "";
  const lines: string[] = [
    "## SHARED ELEMENTS (authoritative controls — embed these; do NOT invent competing controls)",
    "",
    "Replace consumer chrome with shell elements (e.g. swap landing-header for menubar).",
    "Keep product logo/content. Embed each snippet once. One theme control only.",
    "Keep the product/project name as visible text next to the logo (menubar__logo-text); do not leave a logo-only mark.",
    "",
  ];
  for (const el of elements) {
    lines.push(
      `### ${el.id}@${el.version} (${el.kind ?? "control"}) — ${el.label ?? el.id}`,
    );
    lines.push(`- origin: ${el.origin}${el.sourceName ? ` (${el.sourceName})` : ""}`);
    if (el.mountHints?.length) {
      lines.push(`- mount: ${el.mountHints.join(", ")}`);
    }
    if (el.mockPath) lines.push(`- mock: \`${el.mockPath}\``);
    if (el.specPath) lines.push(`- spec: \`${el.specPath}\``);
    if (el.codePath) lines.push(`- code: \`${el.codePath}\` (prefer mounting this TS/JS)`);
    if (opts?.projectRoot && el.mockPath) {
      const abs = join(opts.projectRoot, el.mockPath);
      if (existsSync(abs)) {
        const mock = readFileSync(abs, "utf-8");
        const body = extractElementBodyHtml(mock);
        const snippet = body.slice(0, 6_000);
        lines.push("```html");
        lines.push(snippet.trim());
        if (body.length > 6_000) lines.push("<!-- …truncated -->");
        lines.push("```");
      }
      const tokensAbs = join(opts.projectRoot, elementTokensPath(el.mockPath));
      if (existsSync(tokensAbs)) {
        const css = readFileSync(tokensAbs, "utf-8").trim().slice(0, 3_000);
        if (css) {
          lines.push("```css");
          lines.push(css);
          if (readFileSync(tokensAbs, "utf-8").trim().length > 3_000) {
            lines.push("/* …truncated */");
          }
          lines.push("```");
        }
      }
    }
    lines.push("");
  }
  lines.push(
    "CRITICAL: When an element is listed here, reuse its markup/behavior. A second invented day/night button is a defect.",
  );
  return lines.join("\n");
}

const APPLY_CHROME_IDS = new Set([
  "menubar",
  "theme-toggle",
  "sign-in",
  "user-pill",
  "view-switcher",
]);
const APPLY_DASHBOARD_IDS = new Set([
  "dashboard-shell",
  "dashboard-sidebar",
]);

/** Count elements with an exact class token (ignores BEM children like `theme-toggle__sun`). */
export function countExactClassToken(html: string, token: string): number {
  const re = /class=["']([^"']*)["']/gi;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tokens = (m[1] ?? "").split(/\s+/).filter(Boolean);
    if (tokens.includes(token)) n += 1;
  }
  return n;
}

/** Remove theme-toggle controls that sit outside the menubar region. */
export function stripExtraThemeTogglesOutsideMenubar(html: string): string {
  const menubarIdx = html.search(
    /<header\b[^>]*class=["'][^"']*\bmenubar\b/i,
  );
  let menubarBlock = "";
  let before = html;
  let after = "";
  if (menubarIdx >= 0) {
    menubarBlock = extractBalancedElement(html, menubarIdx);
    if (menubarBlock) {
      before = html.slice(0, menubarIdx);
      after = html.slice(menubarIdx + menubarBlock.length);
    }
  }
  const strip = (chunk: string) =>
    chunk
      .replace(
        /<(?:button|div|label)[^>]*class=["'][^"']*\btheme-toggle\b[^"']*["'][^>]*>[\s\S]*?<\/(?:button|div|label)>/gi,
        "",
      )
      .replace(
        /<(?:button|div|label)[^>]*>[\s\S]{0,120}?(?:dark\s*\/\s*light|day\s*\/\s*night)[\s\S]{0,120}?<\/(?:button|div|label)>/gi,
        "",
      );
  if (!menubarBlock) return strip(html);
  return before + menubarBlock + strip(after);
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Visible product name beside a logo link (menubar wordmark or logo-link text). */
export function extractConsumerBrandLabel(html: string): string | null {
  const logoText = html.match(
    /<span\b[^>]*class=["'][^"']*\bmenubar__logo-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i,
  );
  const logoInner = logoText?.[1];
  if (logoInner) {
    const t = logoInner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (t) return t.slice(0, 64);
  }
  const link = html.match(
    /<(?:a|div)\b[^>]*class=["'][^"']*\b(?:menubar__logo|logo-link|brand(?:-link)?)\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div)>/i,
  );
  const linkInner = link?.[1];
  if (linkInner) {
    const t = linkInner
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (t && t.length <= 48) return t;
  }
  return null;
}

/**
 * Swap sibling monogram for the consumer logo image, but keep the product
 * name wordmark (`menubar__logo-text`) — never strip brand text next to the mark.
 */
export function applyPinnedLogoToMenubarRegion(
  region: string,
  logoSrc: string,
  brandName?: string | null,
): string {
  let out = region;
  const name = brandName?.trim() || null;
  const alt = name ? escapeHtmlText(name) : "";

  // Drop monogram / placeholder mark only — keep logo-text wordmark.
  out = out.replace(
    /<div\b[^>]*class=["'][^"']*\bmenubar__logo-mark\b[^"']*["'][^>]*>[\s\S]*?<\/div>/gi,
    "",
  );

  if (
    /<a\b[^>]*class=["'][^"']*\bmenubar__logo\b[^"']*["'][^>]*>[\s\S]*?<img\b/i.test(
      out,
    )
  ) {
    out = out.replace(
      /(<a\b[^>]*class=["'][^"']*\bmenubar__logo\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*\bsrc=["'])([^"']+)(["'])/i,
      `$1${logoSrc}$3`,
    );
    if (name) {
      out = out.replace(
        /(<a\b[^>]*class=["'][^"']*\bmenubar__logo\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*\balt=["'])([^"']*)(["'])/i,
        `$1${alt}$3`,
      );
    }
  } else {
    out = out.replace(
      /(<a\b[^>]*class=["'][^"']*\bmenubar__logo\b[^"']*["'][^>]*>)/i,
      `$1<img class="menubar__logo-img" src="${logoSrc}" alt="${alt}" width="34" height="34"/>`,
    );
  }

  if (name) {
    const safe = escapeHtmlText(name);
    if (/\bmenubar__logo-text\b/i.test(out)) {
      out = out.replace(
        /(<span\b[^>]*class=["'][^"']*\bmenubar__logo-text\b[^"']*["'][^>]*>)[\s\S]*?(<\/span>)/gi,
        `$1${safe}$2`,
      );
    } else {
      out = out.replace(
        /(<a\b[^>]*class=["'][^"']*\bmenubar__logo\b[^"']*["'][^>]*>[\s\S]*?<img\b[^>]*\/?>)/i,
        `$1<span class="menubar__logo-text">${safe}</span>`,
      );
    }
  }

  return out;
}

/**
 * Deterministically merge pinned shared elements into consumer mock HTML.
 * Landing chrome only by default — dashboard CSS/HTML is not dumped onto
 * landing mocks (that previously broke layout).
 */
export function applyPinnedDesignElementsToMock(opts: {
  html: string;
  elements: DesignElementRef[];
  projectRoot: string;
  pinnedLogoSrc?: string | null;
  /** Consumer product/project name shown next to the pinned logo. */
  brandName?: string | null;
  /** Force dashboard element CSS/HTML even on landing mocks. */
  includeDashboard?: boolean;
}): string {
  let html = opts.html ?? "";
  if (!html.trim() || !opts.elements.length) return html;

  const consumerHasDashboard = /\b(?:dashboard-layout|dashboard-shell|dashboard-sidebar)\b/i.test(
    html,
  );
  const includeDashboard =
    opts.includeDashboard === true || consumerHasDashboard;
  const brandName =
    opts.brandName?.trim() || extractConsumerBrandLabel(html) || null;

  const readMock = (ref: DesignElementRef): string | null => {
    if (!ref.mockPath) return null;
    const abs = join(opts.projectRoot, ref.mockPath);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf-8");
  };

  const applicable = opts.elements.filter((e) => {
    if (APPLY_DASHBOARD_IDS.has(e.id)) return includeDashboard;
    if (APPLY_CHROME_IDS.has(e.id)) return true;
    // Unknown ids: apply tokens only if not dashboard-like
    return !/^dashboard-/i.test(e.id);
  });

  const menubarRef = applicable.find((e) => e.id === "menubar");
  if (menubarRef) {
    const mock = readMock(menubarRef);
    if (mock) {
      let region =
        extractByClass(extractElementBodyHtml(mock), "menubar", [
          "header",
          "nav",
          "div",
        ]) || extractElementBodyHtml(mock);

      if (opts.pinnedLogoSrc?.trim()) {
        region = applyPinnedLogoToMenubarRegion(
          region,
          opts.pinnedLogoSrc.trim(),
          brandName,
        );
      } else if (brandName && /\bmenubar__logo-text\b/i.test(region)) {
        const safe = escapeHtmlText(brandName);
        region = region.replace(
          /(<span\b[^>]*class=["'][^"']*\bmenubar__logo-text\b[^"']*["'][^>]*>)[\s\S]*?(<\/span>)/gi,
          `$1${safe}$2`,
        );
      }

      const landingIdx = html.search(
        /<header\b[^>]*class=["'][^"']*\blanding-header\b/i,
      );
      const menubarIdx = html.search(
        /<header\b[^>]*class=["'][^"']*\bmenubar\b/i,
      );
      const anyHeaderIdx = html.search(/<header\b/i);
      const replaceAt = (idx: number) => {
        const old = extractBalancedElement(html, idx);
        if (!old) return false;
        html = html.slice(0, idx) + region + html.slice(idx + old.length);
        return true;
      };
      if (landingIdx >= 0) replaceAt(landingIdx);
      else if (menubarIdx >= 0) replaceAt(menubarIdx);
      else if (anyHeaderIdx >= 0) replaceAt(anyHeaderIdx);
      else {
        html = html.replace(/<body([^>]*)>/i, `<body$1>\n${region}\n`);
      }
    }
  }

  // Ensure theme-toggle present once when pinned and missing from menubar
  const themeRef = applicable.find((e) => e.id === "theme-toggle");
  if (themeRef && !/\btheme-toggle\b/i.test(html)) {
    const mock = readMock(themeRef);
    if (mock) {
      const btn =
        extractByClass(extractElementBodyHtml(mock), "theme-toggle", [
          "button",
          "div",
          "label",
        ]) || extractElementBodyHtml(mock);
      if (btn) {
        if (/\bmenubar__right\b/i.test(html)) {
          html = html.replace(
            /(<div\b[^>]*class=["'][^"']*\bmenubar__right\b[^"']*["'][^>]*>)/i,
            `$1\n${btn}\n`,
          );
        } else if (/<\/header>/i.test(html)) {
          html = html.replace(/<\/header>/i, `${btn}\n</header>`);
        }
      }
    }
  }

  html = stripExtraThemeTogglesOutsideMenubar(html);

  // Merge tokens only for chrome we applied (never dump dashboard CSS on landing).
  const styleChunks: string[] = [];
  for (const el of applicable) {
    if (APPLY_DASHBOARD_IDS.has(el.id) && !includeDashboard) continue;
    if (!el.mockPath) continue;
    // Prefer menubar / theme-toggle tokens; skip sign-in (tiny) noise OK
    if (
      el.id !== "menubar" &&
      el.id !== "theme-toggle" &&
      !APPLY_DASHBOARD_IDS.has(el.id)
    ) {
      continue;
    }
    const tokensAbs = join(opts.projectRoot, elementTokensPath(el.mockPath));
    if (!existsSync(tokensAbs)) continue;
    let css = readFileSync(tokensAbs, "utf-8").trim();
    if (!css) continue;
    // Drop dashboard rules accidentally harvested into menubar tokens
    if (el.id === "menubar" || el.id === "theme-toggle") {
      css = css
        .split(/\}/)
        .filter((chunk) => {
          const rule = chunk.trim();
          if (!rule) return false;
          if (/\.dashboard-/i.test(rule)) return false;
          return true;
        })
        .map((c) => `${c.trim()}}`)
        .filter((r) => r !== "}")
        .join("\n");
    }
    if (!css.trim()) continue;
    const probe =
      el.id === "menubar"
        ? ".menubar"
        : el.id === "theme-toggle"
          ? ".theme-toggle"
          : css.match(/\.[a-zA-Z_-][\w-]*/)?.[0];
    if (probe && new RegExp(`${probe.replace(".", "\\.")}\\s*\\{`).test(html)) {
      continue;
    }
    styleChunks.push(`/* shared element ${el.id} */\n${css}`);
  }
  if (styleChunks.length) {
    const inject = styleChunks.join("\n\n");
    if (/<style\b[^>]*>/i.test(html)) {
      // Append before </style> — do not prepend (avoids dashboard rules winning)
      html = html.replace(/<\/style>/i, `\n${inject}\n</style>`);
    } else if (/<\/head>/i.test(html)) {
      html = html.replace(
        /<\/head>/i,
        `<style>\n${inject}\n</style>\n</head>`,
      );
    }
  }

  // Strip previously injected shared-element dashboard CSS blocks from landing.
  if (!includeDashboard) {
    html = html.replace(
      /\/\*\s*shared element dashboard-[^*]+\*\/[\s\S]*?(?=\/\*\s*shared element|\n\s*\/\*|<\/style>)/gi,
      "",
    );
  }

  return html;
}

/** Count theme toggles outside `.menubar` (pinned menubar may contain one). */
function countThemeTogglesOutsideMenubar(html: string): number {
  const menubarIdx = html.search(
    /<(?:header|div|nav)\b[^>]*class=["'][^"']*\bmenubar\b/i,
  );
  let scan = html;
  if (menubarIdx >= 0) {
    const block = extractBalancedElement(html, menubarIdx);
    if (block) {
      scan =
        html.slice(0, menubarIdx) + html.slice(menubarIdx + block.length);
    }
  }
  return countExactClassToken(scan, "theme-toggle");
}

/** Detect competing theme toggles when theme-toggle element is pinned. */
export function detectPinnedElementDrift(opts: {
  html: string;
  elements: DesignElementRef[];
}): Array<{ code: "element_invented"; detail: string }> {
  const issues: Array<{ code: "element_invented"; detail: string }> = [];
  const hasThemeEl = opts.elements.some(
    (e) =>
      e.id === "theme-toggle" ||
      /theme.?toggle/i.test(e.id) ||
      e.id === "menubar",
  );
  if (!hasThemeEl) return issues;
  const outside = countThemeTogglesOutsideMenubar(opts.html ?? "");
  if (outside > 0) {
    issues.push({
      code: "element_invented",
      detail: `Pinned theme-toggle/menubar but mock has ${outside} extra theme control(s) outside the menubar — keep a single shared toggle`,
    });
  }
  return issues;
}

/** True when a selection conceptId refers to the given element id (slug or @ver). */
export function selectionConceptMatchesElementId(
  conceptId: string,
  elementId: string,
): boolean {
  const c = conceptId.trim().toLowerCase();
  const id = elementId.trim().toLowerCase();
  if (!c || !id) return false;
  return c === id || c.startsWith(`${id}-`) || c.startsWith(`${id}@`);
}

/**
 * Remove pinned elements from loop META and delete their loop `elements/` dirs.
 * Also drops matching `slot=element` selections (e.g. dashboard-shell-2).
 * Used to drop stale dashboard pins on landing import-all.
 */
export function unpinDesignElementsFromLoop(opts: {
  projectRoot: string;
  loopId: string;
  elementIds: string[];
}): DesignElementRef[] {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const remove = new Set(
    opts.elementIds.map((id) => id.trim()).filter(Boolean),
  );
  if (!remove.size) return getDesignLoopElements(meta);

  const kept = getDesignLoopElements(meta).filter((e) => !remove.has(e.id));
  for (const id of remove) {
    const elRoot = join(
      designLoopDir(opts.projectRoot, opts.loopId),
      "elements",
      id,
    );
    if (existsSync(elRoot)) {
      rmSync(elRoot, { recursive: true, force: true });
    }
  }
  const priorSel = getDesignLoopSelections(meta);
  const nextSel = priorSel.filter((s) => {
    if (s.slot !== "element") return true;
    for (const id of remove) {
      if (selectionConceptMatchesElementId(s.conceptId, id)) return false;
    }
    return true;
  });
  const nextMeta: DesignLoopMetaWithElements & DesignLoopMetaWithSelections = {
    ...meta,
    elements: kept,
    selections: nextSel,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, nextMeta);
  refreshDesignLoopConcepts({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  return kept;
}

/** Copy imported loop elements into phase design/elements/ on implement. */
export function bindDesignElementsToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): DesignElementRef[] {
  const refs = readDesignLoopElements(opts.projectRoot, opts.loopId);
  if (!refs.length) return [];
  const phaseElRoot = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "design",
    "elements",
  );
  mkdirSync(phaseElRoot, { recursive: true });
  const bound: DesignElementRef[] = [];
  for (const ref of refs) {
    const srcDir = join(
      designLoopDir(opts.projectRoot, opts.loopId),
      "elements",
      ref.id,
      `v${ref.version}`,
    );
    if (!existsSync(srcDir)) continue;
    const dest = join(phaseElRoot, ref.id, `v${ref.version}`);
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      if (name === "src") continue;
      const full = join(srcDir, name);
      if (statSync(full).isFile()) copyFileSync(full, join(dest, name));
    }
    const srcTree = join(srcDir, "src");
    if (existsSync(srcTree)) {
      writeSrcTree(join(dest, "src"), readSrcTree(srcTree));
    }
    const base = `.slopcontrol/phases/${opts.phaseId}/design/elements/${ref.id}/v${ref.version}`;
    bound.push({
      ...ref,
      mockPath: `${base}/mock.html`,
      specPath: `${base}/SPEC.md`,
      codePath: ref.hasCode ? `${base}/src` : undefined,
    });
  }
  writeFileSync(
    join(phaseElRoot, "ELEMENTS.json"),
    `${JSON.stringify(bound, null, 2)}\n`,
  );
  return bound;
}

/** Detect element import intent from chat (theme-toggle from sibling project). */
export function detectElementImportFromText(opts: {
  text: string;
  targetRoot: string;
  dataDir?: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
}): DesignElementBundle | null {
  const t = opts.text ?? "";
  const idMatch =
    t.match(
      /\b(?:use|import|pin|adopt|pull)\b.{0,40}\b(theme-toggle|[\w-]+-toggle|[\w-]+-control)\b/i,
    ) ||
    t.match(/\b(theme-toggle)@?(\d+)?\b/i);
  const elementId = idMatch?.[1] ? slugElementId(idMatch[1]) : null;
  if (!elementId && !/\b(shared\s+element|design\s+element)\b/i.test(t)) {
    // theme language + from sibling still tries theme-toggle
    if (
      !/\b(theme\s*toggle|day\s*\/\s*night|dark\s*(and|&|\/)\s*light\s*button)\b/i.test(
        t,
      )
    ) {
      return null;
    }
  }
  const id = elementId || "theme-toggle";
  let origin: string | undefined;
  const fromMatch = t.match(/\bfrom\s+(registry|[\w.-]+)/i);
  if (fromMatch?.[1]) {
    const name = fromMatch[1].toLowerCase();
    origin = name === "registry" ? "registry" : `project:${name}`;
  }
  return resolveDesignElement({
    elementId: id,
    targetRoot: opts.targetRoot,
    dataDir: opts.dataDir,
    listProjects: opts.listProjects,
    origin,
  });
}

/** Convenience: extract from loop mock version then publish. */
export function extractAndPublishDesignElementFromLoop(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
  elementId?: string;
  kind?: DesignElementKind;
  label?: string;
  publishToRegistry?: boolean;
  dataDir?: string;
  sourceProjectId?: string;
  srcFiles?: Record<string, string>;
}): DesignElementMeta {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const version = opts.version ?? meta.currentVersion;
  const html =
    readDesignLoopMockHtml(opts.projectRoot, opts.loopId, version) ?? "";
  if (!html.trim()) {
    throw new Error(`No mock HTML for ${opts.loopId} v${version}`);
  }
  const extracted = extractDesignElementFromMock({
    html,
    elementId: opts.elementId,
    kind: opts.kind,
    label: opts.label,
    brief: meta.brief,
    projectRoot: opts.projectRoot,
  });
  return publishDesignElement({
    projectRoot: opts.projectRoot,
    elementId: extracted.elementId,
    kind: extracted.kind,
    label: extracted.label,
    spec: extracted.spec,
    mockHtml: extracted.mockHtml,
    tokensCss: extracted.tokensCss,
    srcFiles: opts.srcFiles ?? extracted.srcFiles,
    states: extracted.states,
    a11y: extracted.a11y,
    mountHints: extracted.mountHints,
    themeRequirements: extracted.themeRequirements,
    publishToRegistry: opts.publishToRegistry,
    dataDir: opts.dataDir,
    sourceProjectId: opts.sourceProjectId ?? meta.projectId,
  });
}

/**
 * Prepare (or refresh) npm-package/ under an element version for registry publish.
 */
export function prepareDesignElementNpmPackage(opts: {
  projectRoot: string;
  elementId: string;
  version?: number;
  libraryRoot?: string;
}): {
  packageRoot: string;
  packageName: string;
  packageVersion: string;
  meta: DesignElementMeta;
} {
  const id = slugElementId(opts.elementId);
  const libraryRoot =
    opts.libraryRoot ?? projectElementsRoot(opts.projectRoot);
  const index = readElementIndex(libraryRoot);
  const entry = index.elements.find((e) => e.id === id);
  const version = opts.version ?? entry?.latestVersion;
  if (!version) {
    throw new Error(`Element not found in library: ${id}`);
  }
  const bundle = readDesignElementBundle(libraryRoot, id, version);
  if (!bundle) {
    throw new Error(`Element bundle missing: ${id}@${version}`);
  }
  // The published ELEMENT.json npmPackage is authoritative — it was minted
  // under the project's scope at publish time. Fall back to re-resolving
  // only when the bundle predates persisted package names.
  const scope = bundle.meta.npmPackage?.match(/^(@[\w.-]+)\//)?.[1] ??
    elementPublishScope(opts.projectRoot);
  const scaffold = scaffoldElementNpmPackage({
    outDir: join(bundle.rootPath, "npm-package"),
    elementId: id,
    version: bundle.meta.version,
    label: bundle.meta.label,
    srcFiles: bundle.srcFiles,
    description: bundle.meta.label,
    mockHtml: bundle.mockHtml,
    tokensCss: bundle.tokensCss,
    scope,
  });
  return {
    packageRoot: scaffold.packageRoot,
    packageName: scaffold.packageName,
    packageVersion: scaffold.packageVersion,
    meta: bundle.meta,
  };
}

/** Persist npmPackage/npmVersion on ELEMENT.json + INDEX after a successful npm publish. */
export function recordDesignElementNpmPublish(opts: {
  projectRoot: string;
  elementId: string;
  version: number;
  npmPackage: string;
  npmVersion: string;
  libraryRoot?: string;
}): DesignElementMeta {
  const libraryRoot =
    opts.libraryRoot ?? projectElementsRoot(opts.projectRoot);
  const dir = elementVersionDir(libraryRoot, opts.elementId, opts.version);
  const metaPath = join(dir, "ELEMENT.json");
  if (!existsSync(metaPath)) {
    throw new Error(`ELEMENT.json missing for ${opts.elementId}@${opts.version}`);
  }
  const meta = DesignElementMetaSchema.parse({
    ...JSON.parse(readFileSync(metaPath, "utf-8")),
    npmPackage:
      opts.npmPackage ||
      jamPackageNameForElement(opts.elementId, elementPublishScope(opts.projectRoot)),
    npmVersion: opts.npmVersion,
    updatedAt: new Date().toISOString(),
  });
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  upsertIndexEntry(libraryRoot, meta);
  return meta;
}
