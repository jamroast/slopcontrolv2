/**
 * Cross-project design / theme share for design loops.
 *
 * Read a shareable design pack from another project (accepted loop pack or
 * sibling brand refs) and import it into a target loop: copy logos into the
 * loop's assets/, write SHARED_FROM.json, and expose a SHARED DESIGN prompt
 * block that outranks LIVE SITE for palette/logos.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  designLoopAssetsDir,
  designLoopDir,
  listDesignLoops,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  type DesignLoopMeta,
} from "./design-loop.js";
import {
  readDesignLoopPack,
  type DesignPack,
} from "./design-pack.js";
import {
  excerptCssTokens,
  extractSiblingProjectPaths,
  isDesignFallbackBrandPath,
  preferAuthoritativeLogos,
  projectTokenCandidates,
} from "./sibling-brand-refs.js";

export type DesignShareSourceRef =
  | { kind: "projectId"; value: string }
  | { kind: "rootPath"; value: string }
  | { kind: "name"; value: string };

export type DesignShareSource = {
  /** Registered project id when resolvable via the store. */
  projectId?: string;
  rootPath: string;
  name?: string;
};

export type ShareableDesign = {
  source: DesignShareSource;
  /** From accepted DESIGN_PACK.json when present. */
  pack: DesignPack | null;
  /** Loop id + version the pack/mock came from. */
  loopId?: string;
  version?: number;
  /** Canonical :root tokens css (pack.tokens or excerpted). */
  tokensCss: string;
  /** Absolute logo file paths to copy into the target loop. */
  logoFiles: string[];
  /** Design-pack/mock html when available (reference only). */
  mockHtml?: string;
};

export type ImportedDesignShare = {
  source: DesignShareSource;
  loopId: string;
  importedAt: string;
  tokensCss: string;
  /** Filenames copied into the target loop assets/. */
  copiedAssets: string[];
  /** Loop-relative asset paths for the copied logos. */
  logoAssetPaths: string[];
  pack?: DesignPack | null;
};

/** Loop sibling aliases (brand name → folder name) so prose resolves. */
const SHARE_ALIASES: Record<string, string> = {
  jamroast: "burntjam",
  "jam roast": "burntjam",
  jam_roast: "burntjam",
  jampress: "basic-web-agent",
  jamlight: "light-weight-crm-and-invoicing",
  "jam light": "light-weight-crm-and-invoicing",
  jam_light: "light-weight-crm-and-invoicing",
};

export function resolveShareAlias(name: string): string {
  const key = name.trim().toLowerCase();
  return SHARE_ALIASES[key] ?? name;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when share source is the same project as the target (self-import). */
export function isSameDesignShareRoot(
  targetRoot: string,
  sourceRoot: string,
): boolean {
  const norm = (p: string) => p.replace(/\/$/, "");
  if (norm(targetRoot) === norm(sourceRoot)) return true;
  return (
    basename(norm(targetRoot)).toLowerCase() ===
    basename(norm(sourceRoot)).toLowerCase()
  );
}

function rejectSelfShare(
  targetRoot: string,
  source: DesignShareSource | null,
): DesignShareSource | null {
  if (!source) return null;
  if (isSameDesignShareRoot(targetRoot, source.rootPath)) return null;
  return source;
}

/**
 * Chat auto-detect: find a shareable source project referenced in operator
 * text (absolute path, brand alias, sibling dir name, or registered name).
 * Returns null when nothing resolvable is mentioned.
 */
export function detectShareSourceFromText(opts: {
  targetRoot: string;
  text: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  findProjectByRootPath?: (rootPath: string) =>
    | { id: string; name: string; rootPath: string }
    | undefined;
}): DesignShareSource | null {
  const text = (opts.text ?? "").trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  const targetBase = basename(opts.targetRoot.replace(/\/$/, "")).toLowerCase();

  const tryName = (name: string): DesignShareSource | null =>
    rejectSelfShare(
      opts.targetRoot,
      resolveDesignShareSource({
        targetRoot: opts.targetRoot,
        fromName: name,
        listProjects: opts.listProjects,
        findProjectByRootPath: opts.findProjectByRootPath,
      }),
    );

  // 1. Explicit absolute paths (".../Projects/burntjam").
  for (const p of extractSiblingProjectPaths(text)) {
    const src = rejectSelfShare(
      opts.targetRoot,
      resolveDesignShareSource({
        targetRoot: opts.targetRoot,
        fromRootPath: p,
        listProjects: opts.listProjects,
        findProjectByRootPath: opts.findProjectByRootPath,
      }),
    );
    if (src) return src;
  }

  // 2. Brand aliases ("jamroast", "jamlight", "jampress").
  for (const alias of Object.keys(SHARE_ALIASES)) {
    if (new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(lower)) {
      const src = tryName(alias);
      if (src) return src;
    }
  }

  // 3. Registered project names / ids.
  for (const p of opts.listProjects?.() ?? []) {
    const base = basename(p.rootPath.replace(/\/$/, "")).toLowerCase();
    if (base === targetBase) continue;
    if (isSameDesignShareRoot(opts.targetRoot, p.rootPath)) continue;
    const candidates = [p.name, base].filter(Boolean);
    for (const c of candidates) {
      if (c.length < 3) continue;
      if (new RegExp(`\\b${escapeRegExp(c.toLowerCase())}\\b`, "i").test(lower)) {
        return { projectId: p.id, rootPath: p.rootPath, name: p.name };
      }
    }
  }

  // 4. Sibling dir names under the target's parent folder.
  const parent = join(opts.targetRoot, "..");
  let siblings: string[] = [];
  try {
    siblings = readdirSync(parent).filter((d) => {
      if (d.startsWith(".")) return false;
      try {
        return statSync(join(parent, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  for (const s of siblings) {
    if (s.toLowerCase() === targetBase || s.length < 3) continue;
    if (new RegExp(`\\b${escapeRegExp(s.toLowerCase())}\\b`, "i").test(lower)) {
      const src = tryName(s);
      if (src) return src;
    }
  }
  return null;
}

/**
 * Resolve a share source against registered projects (via lookup callback),
 * sibling dirs under the target's parent folder, and aliases.
 */
export function resolveDesignShareSource(opts: {
  targetRoot: string;
  fromProjectId?: string;
  fromRootPath?: string;
  fromName?: string;
  listProjects?: () => Array<{ id: string; name: string; rootPath: string }>;
  findProjectByRootPath?: (rootPath: string) =>
    | { id: string; name: string; rootPath: string }
    | undefined;
}): DesignShareSource | null {
  const projects = opts.listProjects?.() ?? [];
  let resolved: DesignShareSource | null = null;
  if (opts.fromProjectId) {
    const p = projects.find((x) => x.id === opts.fromProjectId);
    if (p) resolved = { projectId: p.id, rootPath: p.rootPath, name: p.name };
  }
  if (!resolved && opts.fromRootPath) {
    const viaStore = opts.findProjectByRootPath?.(opts.fromRootPath);
    if (viaStore) {
      resolved = {
        projectId: viaStore.id,
        rootPath: viaStore.rootPath,
        name: viaStore.name,
      };
    } else if (existsSync(opts.fromRootPath)) {
      const p = projects.find(
        (x) =>
          x.rootPath.replace(/\/$/, "") ===
          opts.fromRootPath!.replace(/\/$/, ""),
      );
      resolved = {
        projectId: p?.id,
        rootPath: opts.fromRootPath,
        name: p?.name,
      };
    }
  }
  if (!resolved && opts.fromName) {
    const want = resolveShareAlias(opts.fromName).toLowerCase();
    const byName = projects.find(
      (x) =>
        x.name.toLowerCase() === want ||
        x.rootPath.split("/").filter(Boolean).pop()?.toLowerCase() === want ||
        x.name.toLowerCase() === opts.fromName!.trim().toLowerCase(),
    );
    if (byName) {
      resolved = {
        projectId: byName.id,
        rootPath: byName.rootPath,
        name: byName.name,
      };
    } else {
      // Sibling dir under target's parent folder.
      const parent = join(opts.targetRoot, "..");
      const candidate = join(parent, resolveShareAlias(opts.fromName));
      if (existsSync(candidate)) {
        resolved = { rootPath: candidate, name: opts.fromName };
      }
    }
  }
  return rejectSelfShare(opts.targetRoot, resolved);
}

const LOGO_FILE_RE = /logo|mark|brand/i;
const LOGO_EXT_RE = /\.(svg|png|webp|jpg|jpeg)$/i;

function scanPublicLogos(rootPath: string, max = 6): string[] {
  const publicDir = join(rootPath, "public");
  if (!existsSync(publicDir)) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || out.length >= max) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full, depth + 1);
      } else if (
        LOGO_EXT_RE.test(name) &&
        LOGO_FILE_RE.test(name) &&
        !isDesignFallbackBrandPath(full)
      ) {
        out.push(full);
        if (out.length >= max) return;
      }
    }
  };
  walk(publicDir, 0);
  return out.sort();
}

function collectSourceLogoFiles(rootPath: string, pack: DesignPack | null): string[] {
  const files = new Set<string>();
  for (const p of preferAuthoritativeLogos(rootPath, [])) {
    if (existsSync(p) && !isDesignFallbackBrandPath(p)) files.add(p);
  }
  // Pack-declared logos (loop-relative or absolute).
  for (const l of pack?.logos ?? []) {
    const abs = l.path.startsWith("/") ? l.path : join(rootPath, l.path);
    if (
      existsSync(abs) &&
      LOGO_EXT_RE.test(abs) &&
      !isDesignFallbackBrandPath(abs)
    ) {
      files.add(abs);
    }
  }
  for (const p of scanPublicLogos(rootPath)) {
    if (!isDesignFallbackBrandPath(p)) files.add(p);
  }
  return [...files].slice(0, 8);
}

function pickSourceLoop(rootPath: string): DesignLoopMeta | null {
  const loops = listDesignLoops(rootPath);
  if (!loops.length) return null;
  const accepted = loops
    .filter((l) => l.status === "accepted" || l.status === "implemented")
    .sort((a, b) => (b.acceptedVersion ?? b.currentVersion) - (a.acceptedVersion ?? a.currentVersion));
  return accepted[0] ?? loops.sort((a, b) => b.currentVersion - a.currentVersion)[0] ?? null;
}

/** Read a shareable design from a source project root. */
export function readShareableDesign(source: DesignShareSource): ShareableDesign | null {
  const root = source.rootPath;
  if (!existsSync(root)) return null;

  const loop = pickSourceLoop(root);
  let pack: DesignPack | null = null;
  let mockHtml: string | undefined;
  let version: number | undefined;
  if (loop) {
    pack = readDesignLoopPack(root, loop.id);
    version = loop.acceptedVersion ?? loop.currentVersion;
    try {
      mockHtml = readDesignLoopMockHtml(root, loop.id, version) ?? undefined;
    } catch {
      mockHtml = undefined;
    }
  }

  let tokensCss = (pack?.tokens ?? "").trim();
  const lightCss = (pack?.theme?.lightTokensCss ?? "").trim();
  if (tokensCss && lightCss) {
    tokensCss = `${tokensCss}\n\n/* theme.lightTokensCss */\n${lightCss}`;
  }
  if (!tokensCss) {
    for (const cssPath of projectTokenCandidates(root)) {
      try {
        const ex = excerptCssTokens(readFileSync(cssPath, "utf-8"), 3_000);
        if (ex) {
          tokensCss = ex;
          break;
        }
      } catch {
        /* next */
      }
    }
  }

  const logoFiles = collectSourceLogoFiles(root, pack);

  if (!tokensCss && !logoFiles.length && !pack) return null;
  return {
    source,
    pack,
    loopId: loop?.id,
    version,
    tokensCss,
    logoFiles,
    mockHtml,
  };
}

export function sharedFromPath(projectRoot: string, loopId: string): string {
  return join(designLoopDir(projectRoot, loopId), "SHARED_FROM.json");
}

export function readSharedDesignImport(
  projectRoot: string,
  loopId: string,
): ImportedDesignShare | null {
  const path = sharedFromPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    const imported = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as ImportedDesignShare;
    // Ignore prior self-imports (e.g. jampress→jampress) so LIVE SITE/sibling
    // cues are not overridden by incomplete local tokens.
    if (
      imported?.source?.rootPath &&
      isSameDesignShareRoot(projectRoot, imported.source.rootPath)
    ) {
      return null;
    }
    return imported;
  } catch {
    return null;
  }
}

/**
 * Import a shareable design into a target loop: copy logos into assets/,
 * write SHARED_FROM.json. Does not touch product source.
 */
export function importDesignShareIntoLoop(opts: {
  targetRoot: string;
  loopId: string;
  share: ShareableDesign;
}): ImportedDesignShare {
  if (isSameDesignShareRoot(opts.targetRoot, opts.share.source.rootPath)) {
    throw new Error(
      `Refusing to import design from the same project (${opts.share.source.rootPath})`,
    );
  }
  const assetsDir = designLoopAssetsDir(opts.targetRoot, opts.loopId);
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(designLoopDir(opts.targetRoot, opts.loopId), { recursive: true });

  const copiedAssets: string[] = [];
  const logoAssetPaths: string[] = [];
  for (const abs of opts.share.logoFiles) {
    if (isDesignFallbackBrandPath(abs)) continue;
    const name = basename(abs);
    const dest = join(assetsDir, name);
    try {
      copyFileSync(abs, dest);
      copiedAssets.push(name);
      logoAssetPaths.push(
        `.slopcontrol/design-loops/${opts.loopId}/assets/${name}`,
      );
    } catch {
      /* skip unreadable */
    }
  }

  const imported: ImportedDesignShare = {
    source: opts.share.source,
    loopId: opts.loopId,
    importedAt: new Date().toISOString(),
    tokensCss: opts.share.tokensCss,
    copiedAssets,
    logoAssetPaths,
    pack: opts.share.pack,
  };
  writeFileSync(
    sharedFromPath(opts.targetRoot, opts.loopId),
    `${JSON.stringify(imported, null, 2)}\n`,
    "utf-8",
  );
  return imported;
}

/**
 * SHARED DESIGN prompt block — ranked above LIVE SITE for palette/logos when
 * an import exists (or adopt-theme intent). LIVE SITE still wins nav/routes.
 */
export function formatSharedDesignPromptBlock(
  imported: ImportedDesignShare | null | undefined,
  maxChars = 3_000,
): string {
  if (!imported) return "";
  const lines: string[] = [
    "## SHARED DESIGN (imported from another project — authoritative for palette, tokens, dual theme, and logos over LIVE SITE)",
    "",
    "CRITICAL: Apply these tokens/logos. Do not invent a new purple/cream palette. LIVE SITE wins only for nav/routes/screen copy.",
    "",
    `Source: ${imported.source.name ?? imported.source.rootPath}`,
    `Imported: ${imported.importedAt}`,
    "",
  ];
  if (imported.tokensCss.trim()) {
    lines.push(
      "### Shared tokens (apply over prior mock; include dark + light ladders when present)",
    );
    lines.push("```css");
    lines.push(imported.tokensCss.trim().slice(0, 2_200));
    lines.push("```");
    lines.push("");
  }
  if (imported.logoAssetPaths.length) {
    lines.push("### Shared logos (copied into this loop — use these paths)");
    for (const p of imported.logoAssetPaths) lines.push(`- \`${p}\``);
    lines.push("");
  }
  const body = lines.join("\n");
  return body.length <= maxChars
    ? body
    : `${body.slice(0, maxChars)}\n…[truncated SHARED DESIGN]`;
}
