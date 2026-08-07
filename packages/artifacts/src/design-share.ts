/**
 * Cross-project design / theme share for design loops.
 *
 * Read a shareable design pack from another project (accepted loop pack or
 * sibling brand refs) and import it into a target loop: copy logos into the
 * loop's assets/, write SHARED_FROM.json, and expose a SHARED DESIGN prompt
 * block that outranks LIVE SITE for palette/logos.
 *
 * Same-project reuse (fresh loop after a dirty one) uses PRIOR_DESIGN.json via
 * pickProjectPriorDesign / importProjectPriorDesignIntoLoop — not SHARED_FROM.
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

/**
 * Normalize a share/from-project name (trim + collapse whitespace).
 * No built-in brand→folder aliases — resolve by registered name or literal dir.
 */
export function resolveShareAlias(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when `needle` appears in `haystack` as a whole project/folder token.
 * Identifier chars are `[a-z0-9_-]` so hyphens do not create a boundary —
 * "jamroast" does **not** match inside "jamroast-components".
 */
export function textMentionsProjectName(
  haystack: string,
  needle: string,
): boolean {
  const n = needle.trim().toLowerCase();
  if (n.length < 3) return false;
  const h = haystack.toLowerCase();
  const re = new RegExp(
    `(^|[^a-z0-9_-])${escapeRegExp(n)}($|[^a-z0-9_-])`,
    "i",
  );
  return re.test(h);
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
 * text (absolute path, registered name, or literal sibling dir name).
 * Returns null when nothing resolvable is mentioned.
 * When several names match, the **longest** identifier wins (hyphen-safe).
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

  // 1. Explicit absolute paths.
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

  // 2. Registered project names / folder basenames — longest match wins.
  type Hit = { matchLen: number; source: DesignShareSource };
  const registeredHits: Hit[] = [];
  for (const p of opts.listProjects?.() ?? []) {
    const base = basename(p.rootPath.replace(/\/$/, "")).toLowerCase();
    if (base === targetBase) continue;
    if (isSameDesignShareRoot(opts.targetRoot, p.rootPath)) continue;
    const candidates = [p.name, base].filter(Boolean);
    let bestLen = 0;
    for (const c of candidates) {
      if (!textMentionsProjectName(text, c)) continue;
      bestLen = Math.max(bestLen, c.trim().length);
    }
    if (bestLen > 0) {
      registeredHits.push({
        matchLen: bestLen,
        source: { projectId: p.id, rootPath: p.rootPath, name: p.name },
      });
    }
  }
  if (registeredHits.length) {
    registeredHits.sort((a, b) => b.matchLen - a.matchLen);
    return registeredHits[0]!.source;
  }

  // 3. Sibling dir names under the target's parent folder (literal match only).
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
  const siblingHits: Array<{ matchLen: number; name: string }> = [];
  for (const s of siblings) {
    if (s.toLowerCase() === targetBase || s.length < 3) continue;
    if (!textMentionsProjectName(text, s)) continue;
    siblingHits.push({ matchLen: s.length, name: s });
  }
  siblingHits.sort((a, b) => b.matchLen - a.matchLen);
  for (const hit of siblingHits) {
    const src = tryName(hit.name);
    if (src) return src;
  }
  return null;
}

/**
 * Resolve a share source against registered projects (via lookup callback)
 * and literal sibling dirs under the target's parent folder.
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
    const byName = projects.find((x) => {
      const base = x.rootPath.split("/").filter(Boolean).pop()?.toLowerCase();
      return (
        x.name.toLowerCase() === want ||
        base === want ||
        x.name.toLowerCase().replace(/\s+/g, " ") === want
      );
    });
    if (byName) {
      resolved = {
        projectId: byName.id,
        rootPath: byName.rootPath,
        name: byName.name,
      };
    } else {
      // Literal sibling dir under target's parent folder.
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
    "## SHARED DESIGN (imported from another project — authoritative for palette, tokens, dual theme, shell chrome, and logos over LIVE SITE)",
    "",
    "CRITICAL: Apply these tokens/logos and shell notes. Do not invent a new purple/cream palette or a competing day/night toggle when SHARED ELEMENTS includes theme-toggle. LIVE SITE wins only for nav/routes/screen copy.",
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
  const shellNotes = imported.pack?.shell?.filter((s) => s.trim()) ?? [];
  if (shellNotes.length) {
    lines.push(
      "### Shared shell / chrome (apply menubar slots + layout; do not invent competing theme controls)",
    );
    for (const s of shellNotes.slice(0, 12)) lines.push(`- ${s}`);
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

/** Prior design from the same project (accepted/implemented loop or phase design). */
export type ProjectPriorDesign = {
  kind: "loop" | "phase";
  /** Source loop id when kind=loop. */
  loopId?: string;
  /** Source phase id when kind=phase. */
  phaseId?: string;
  version?: number;
  pack: DesignPack | null;
  tokensCss: string;
  /** Absolute logo/asset paths to copy. */
  logoFiles: string[];
  /** Prior mock HTML when available (ground new v1 on this). */
  mockHtml?: string;
};

export type ImportedProjectPriorDesign = {
  kind: "loop" | "phase";
  sourceLoopId?: string;
  sourcePhaseId?: string;
  version?: number;
  loopId: string;
  importedAt: string;
  tokensCss: string;
  copiedAssets: string[];
  logoAssetPaths: string[];
  /** Prior mock HTML snapshot at seed time (may be large; used as revise base). */
  mockHtml?: string;
  pack?: DesignPack | null;
};

function scanDirLogos(dir: string, max = 8): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    if (!LOGO_EXT_RE.test(name)) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    if (isDesignFallbackBrandPath(full)) continue;
    out.push(full);
    if (out.length >= max) break;
  }
  return out.sort();
}

function pickPriorLoop(
  projectRoot: string,
  excludeLoopId?: string,
): DesignLoopMeta | null {
  const loops = listDesignLoops(projectRoot).filter(
    (l) => !excludeLoopId || l.id !== excludeLoopId,
  );
  if (!loops.length) return null;
  const accepted = loops
    .filter((l) => l.status === "accepted" || l.status === "implemented")
    .sort((a, b) => {
      const byUpdated = (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
      if (byUpdated !== 0) return byUpdated;
      return (
        (b.acceptedVersion ?? b.currentVersion) -
        (a.acceptedVersion ?? a.currentVersion)
      );
    });
  return accepted[0] ?? null;
}

function pickPhaseDesign(projectRoot: string): {
  phaseId: string;
  tokensCss: string;
  mockHtml?: string;
  logoFiles: string[];
  pack: DesignPack | null;
} | null {
  const phasesRoot = join(projectRoot, ".slopcontrol", "phases");
  if (!existsSync(phasesRoot)) return null;
  let names: string[] = [];
  try {
    names = readdirSync(phasesRoot).filter((n) => !n.startsWith("."));
  } catch {
    return null;
  }
  // Prefer newest mtime among phases that have design/tokens.css or mock.html
  type Cand = {
    phaseId: string;
    mtime: number;
    tokensPath: string;
    mockPath: string;
    assetsDir: string;
    packPath: string;
  };
  const cands: Cand[] = [];
  for (const phaseId of names) {
    const designDir = join(phasesRoot, phaseId, "design");
    const tokensPath = join(designDir, "tokens.css");
    const mockPath = join(designDir, "mock.html");
    const packPath = join(designDir, "DESIGN_PACK.json");
    if (!existsSync(tokensPath) && !existsSync(mockPath) && !existsSync(packPath)) {
      continue;
    }
    let mtime = 0;
    for (const p of [tokensPath, mockPath, packPath]) {
      if (!existsSync(p)) continue;
      try {
        mtime = Math.max(mtime, statSync(p).mtimeMs);
      } catch {
        /* skip */
      }
    }
    cands.push({
      phaseId,
      mtime,
      tokensPath,
      mockPath,
      assetsDir: join(designDir, "assets"),
      packPath,
    });
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  const best = cands[0];
  if (!best) return null;

  let pack: DesignPack | null = null;
  if (existsSync(best.packPath)) {
    try {
      pack = JSON.parse(readFileSync(best.packPath, "utf-8")) as DesignPack;
    } catch {
      pack = null;
    }
  }
  let tokensCss = (pack?.tokens ?? "").trim();
  const lightCss = (pack?.theme?.lightTokensCss ?? "").trim();
  if (tokensCss && lightCss) {
    tokensCss = `${tokensCss}\n\n/* theme.lightTokensCss */\n${lightCss}`;
  }
  if (!tokensCss && existsSync(best.tokensPath)) {
    try {
      tokensCss =
        excerptCssTokens(readFileSync(best.tokensPath, "utf-8"), 4_000) ||
        readFileSync(best.tokensPath, "utf-8").slice(0, 4_000);
    } catch {
      tokensCss = "";
    }
  }
  let mockHtml: string | undefined;
  if (existsSync(best.mockPath)) {
    try {
      mockHtml = readFileSync(best.mockPath, "utf-8");
    } catch {
      mockHtml = undefined;
    }
  }
  const logoFiles = [
    ...scanDirLogos(best.assetsDir),
    ...collectSourceLogoFiles(projectRoot, pack),
  ];
  const uniq = [...new Set(logoFiles)].slice(0, 8);
  if (!tokensCss && !mockHtml && !uniq.length && !pack) return null;
  return {
    phaseId: best.phaseId,
    tokensCss,
    mockHtml,
    logoFiles: uniq,
    pack,
  };
}

/**
 * Pick this project's prior design for seeding a fresh loop.
 * Prefers latest accepted/implemented loop (excluding excludeLoopId), else phase design.
 */
export function pickProjectPriorDesign(
  projectRoot: string,
  opts?: { excludeLoopId?: string },
): ProjectPriorDesign | null {
  const loop = pickPriorLoop(projectRoot, opts?.excludeLoopId);
  if (loop) {
    const pack = readDesignLoopPack(projectRoot, loop.id);
    const version = loop.acceptedVersion ?? loop.currentVersion;
    let mockHtml: string | undefined;
    try {
      mockHtml =
        readDesignLoopMockHtml(projectRoot, loop.id, version) ?? undefined;
    } catch {
      mockHtml = undefined;
    }
    if (!mockHtml) {
      const acceptedPath = join(
        designLoopDir(projectRoot, loop.id),
        "accepted-mock.html",
      );
      if (existsSync(acceptedPath)) {
        try {
          mockHtml = readFileSync(acceptedPath, "utf-8");
        } catch {
          /* ignore */
        }
      }
    }
    let tokensCss = (pack?.tokens ?? "").trim();
    const lightCss = (pack?.theme?.lightTokensCss ?? "").trim();
    if (tokensCss && lightCss) {
      tokensCss = `${tokensCss}\n\n/* theme.lightTokensCss */\n${lightCss}`;
    }
    if (!tokensCss) {
      for (const cssPath of projectTokenCandidates(projectRoot)) {
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
    const logoFiles = [
      ...scanDirLogos(designLoopAssetsDir(projectRoot, loop.id)),
      ...collectSourceLogoFiles(projectRoot, pack),
    ];
    const uniq = [...new Set(logoFiles)].slice(0, 8);
    if (tokensCss || mockHtml || uniq.length || pack) {
      return {
        kind: "loop",
        loopId: loop.id,
        version,
        pack,
        tokensCss,
        logoFiles: uniq,
        mockHtml,
      };
    }
  }

  const phase = pickPhaseDesign(projectRoot);
  if (!phase) return null;
  return {
    kind: "phase",
    phaseId: phase.phaseId,
    pack: phase.pack,
    tokensCss: phase.tokensCss,
    logoFiles: phase.logoFiles,
    mockHtml: phase.mockHtml,
  };
}

export function priorDesignPath(projectRoot: string, loopId: string): string {
  return join(designLoopDir(projectRoot, loopId), "PRIOR_DESIGN.json");
}

export function readProjectPriorDesignImport(
  projectRoot: string,
  loopId: string,
): ImportedProjectPriorDesign | null {
  const path = priorDesignPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    const imported = JSON.parse(
      readFileSync(path, "utf-8"),
    ) as ImportedProjectPriorDesign;
    if (!imported?.tokensCss && !imported?.mockHtml && !imported?.logoAssetPaths?.length) {
      return null;
    }
    return imported;
  } catch {
    return null;
  }
}

/**
 * Seed a loop from this project's prior design. Writes PRIOR_DESIGN.json
 * (distinct from SHARED_FROM so accidental self-share ignore stays valid).
 */
export function importProjectPriorDesignIntoLoop(opts: {
  projectRoot: string;
  loopId: string;
  prior: ProjectPriorDesign;
}): ImportedProjectPriorDesign {
  const assetsDir = designLoopAssetsDir(opts.projectRoot, opts.loopId);
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(designLoopDir(opts.projectRoot, opts.loopId), { recursive: true });

  const copiedAssets: string[] = [];
  const logoAssetPaths: string[] = [];
  for (const abs of opts.prior.logoFiles) {
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
      /* skip */
    }
  }

  const imported: ImportedProjectPriorDesign = {
    kind: opts.prior.kind,
    sourceLoopId: opts.prior.loopId,
    sourcePhaseId: opts.prior.phaseId,
    version: opts.prior.version,
    loopId: opts.loopId,
    importedAt: new Date().toISOString(),
    tokensCss: opts.prior.tokensCss,
    copiedAssets,
    logoAssetPaths,
    mockHtml: opts.prior.mockHtml?.slice(0, 120_000),
    pack: opts.prior.pack,
  };
  writeFileSync(
    priorDesignPath(opts.projectRoot, opts.loopId),
    `${JSON.stringify(imported, null, 2)}\n`,
    "utf-8",
  );
  return imported;
}

/**
 * PRIOR DESIGN prompt block — same authority as SHARED DESIGN for palette/logos
 * when the operator asked to reuse this project's existing theming.
 */
export function formatProjectPriorDesignPromptBlock(
  imported: ImportedProjectPriorDesign | null | undefined,
  maxChars = 3_000,
): string {
  if (!imported) return "";
  const sourceLabel =
    imported.kind === "loop"
      ? `prior design loop ${imported.sourceLoopId ?? "?"}@v${imported.version ?? "?"}`
      : `phase design ${imported.sourcePhaseId ?? "?"}`;
  const lines: string[] = [
    "## PRIOR DESIGN (same project — authoritative for palette, tokens, dual theme, and logos over LIVE SITE)",
    "",
    "CRITICAL: Apply these tokens/logos from this project's existing theming document. Do not invent a new purple/cream palette. Revise from the prior mock when provided. LIVE SITE wins only for nav/routes/screen copy.",
    "",
    `Source: ${sourceLabel}`,
    `Imported: ${imported.importedAt}`,
    "",
  ];
  if (imported.tokensCss.trim()) {
    lines.push(
      "### Prior tokens (apply over inventing a new system; include dark + light ladders when present)",
    );
    lines.push("```css");
    lines.push(imported.tokensCss.trim().slice(0, 2_200));
    lines.push("```");
    lines.push("");
  }
  if (imported.logoAssetPaths.length) {
    lines.push("### Prior logos (copied into this loop — use these paths)");
    for (const p of imported.logoAssetPaths) lines.push(`- \`${p}\``);
    lines.push("");
  }
  const body = lines.join("\n");
  return body.length <= maxChars
    ? body
    : `${body.slice(0, maxChars)}\n…[truncated PRIOR DESIGN]`;
}
