import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  designLoopDir,
  listDesignLoopAssets,
  readDesignLoopMeta,
  readDesignLoopMockHtml,
  writeDesignLoopMeta,
  type DesignLoopMeta,
} from "./design-loop.js";
import { dominantMockLogoAsset } from "./design-loop-continue.js";

export type DesignLoopSelectionSlot =
  | "logo"
  | "palette"
  | "type"
  | "shell"
  | "content"
  | "element"
  | string;

export type DesignLoopSelection = {
  slot: DesignLoopSelectionSlot;
  conceptId: string;
  label?: string;
  asset?: string;
  excerpt?: string;
  pinnedAt: string;
};

export type DesignLoopConcept = {
  conceptId: string;
  label: string;
  slot: DesignLoopSelectionSlot;
  asset?: string;
  excerpt?: string;
  pinned: boolean;
};

export type DesignLoopMetaWithSelections = DesignLoopMeta & {
  selections?: DesignLoopSelection[];
};

export function designLoopConceptsPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "CONCEPTS.json");
}

export function getDesignLoopSelections(
  meta: DesignLoopMeta | null | undefined,
): DesignLoopSelection[] {
  const raw = (meta as DesignLoopMetaWithSelections | null)?.selections;
  return Array.isArray(raw) ? raw : [];
}

export function readDesignLoopSelections(
  projectRoot: string,
  loopId: string,
): DesignLoopSelection[] {
  return getDesignLoopSelections(readDesignLoopMeta(projectRoot, loopId));
}

function slugConceptId(label: string): string {
  const m = label.match(/concept\s*([a-z0-9]+)/i);
  if (m?.[1]) return `concept-${m[1].toLowerCase()}`;
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "concept"
  );
}

function inferSlot(label: string, hasAsset: boolean): DesignLoopSelectionSlot {
  const l = label.toLowerCase();
  if (/\belement\b|\btoggle\b|\bcontrol\b|\bpattern\b/.test(l)) return "element";
  if (/\bpalette\b|\bswatch|\bcolor/.test(l)) return "palette";
  if (/\btype\b|\btypo|\bfont/.test(l)) return "type";
  if (/\bshell\b|\bframe|\bdashboard|\bchrome/.test(l)) return "shell";
  if (/\bcontent\b|\bagency|\bplatform|\bcopy/.test(l)) return "content";
  if (hasAsset || /\blogo\b|\bmark\b|\bmonogram|\bconcept\b/.test(l)) {
    return "logo";
  }
  return hasAsset ? "logo" : "content";
}

/** Extract concept cards from mock HTML. */
export function extractConceptsFromMockHtml(
  html: string,
): Omit<DesignLoopConcept, "pinned">[] {
  const out: Omit<DesignLoopConcept, "pinned">[] = [];
  const seen = new Set<string>();

  const push = (c: Omit<DesignLoopConcept, "pinned">) => {
    if (seen.has(c.conceptId)) return;
    seen.add(c.conceptId);
    out.push(c);
  };

  const cardRe =
    /<div[^>]*class="[^"]*logo-card[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1] ?? "";
    const img = block.match(
      /src=["'][^"']*\/assets\/([^"'/?#]+\.(?:png|jpe?g|webp|gif|svg))["']/i,
    );
    const badge = block.match(/logo-card-badge[^>]*>\s*([^<]+)/i)?.[1]?.trim();
    const labelEl = block.match(
      /logo-card-label[^>]*>\s*([^<]+)/i,
    )?.[1]?.trim();
    const label = badge || labelEl || (img?.[1] ? basename(img[1]) : "");
    if (!label && !img?.[1]) continue;
    push({
      conceptId: slugConceptId(badge || label || img?.[1] || "logo"),
      label: badge || label,
      slot: "logo",
      asset: img?.[1],
    });
  }

  const conceptImgRe =
    /Concept\s+([A-Z0-9]+)[\s\S]{0,400}?assets\/([^"'/?#]+\.(?:png|jpe?g|webp|gif|svg))/gi;
  while ((m = conceptImgRe.exec(html)) !== null) {
    const letter = m[1] ?? "";
    const asset = m[2] ?? "";
    if (!letter || !asset) continue;
    push({
      conceptId: `concept-${letter.toLowerCase()}`,
      label: `Concept ${letter}`,
      slot: "logo",
      asset,
    });
  }

  const imgConceptRe =
    /assets\/([^"'/?#]+\.(?:png|jpe?g|webp|gif|svg))[\s\S]{0,400}?Concept\s+([A-Z0-9]+)/gi;
  while ((m = imgConceptRe.exec(html)) !== null) {
    const asset = m[1] ?? "";
    const letter = m[2] ?? "";
    if (!letter || !asset) continue;
    push({
      conceptId: `concept-${letter.toLowerCase()}`,
      label: `Concept ${letter}`,
      slot: "logo",
      asset,
    });
  }

  const sectionRe =
    /class="[^"]*section-label[^"]*"[^>]*>\s*<b>\d+<\/b>\s*([^<]+)/gi;
  while ((m = sectionRe.exec(html)) !== null) {
    const label = (m[1] ?? "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    push({
      conceptId: slugConceptId(label),
      label,
      slot: inferSlot(label, false),
      excerpt: label.slice(0, 200),
    });
  }

  return out;
}

function latestMockVersion(
  projectRoot: string,
  loopId: string,
  preferred?: number,
): number {
  if (preferred && preferred > 0) {
    if (readDesignLoopMockHtml(projectRoot, loopId, preferred)) return preferred;
  }
  for (let v = 40; v >= 1; v--) {
    if (readDesignLoopMockHtml(projectRoot, loopId, v)) return v;
  }
  return 0;
}

export function buildDesignLoopConceptCatalog(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
  html?: string | null;
}): DesignLoopConcept[] {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) return [];
  const version = latestMockVersion(
    opts.projectRoot,
    opts.loopId,
    opts.version ?? meta.currentVersion,
  );
  const html =
    opts.html ??
    (version > 0
      ? readDesignLoopMockHtml(opts.projectRoot, opts.loopId, version)
      : null) ??
    "";
  const extracted = extractConceptsFromMockHtml(html);
  const assets = listDesignLoopAssets(
    opts.projectRoot,
    meta.projectId,
    opts.loopId,
  );
  const haveAsset = new Set(
    extracted.map((c) => c.asset).filter(Boolean) as string[],
  );
  for (const a of assets) {
    if (haveAsset.has(a.name)) continue;
    extracted.push({
      conceptId: slugConceptId(a.name.replace(/\.[^.]+$/, "")),
      label: a.name,
      slot: "logo",
      asset: a.name,
    });
  }
  const selections = getDesignLoopSelections(meta);
  const pinnedByConcept = new Set(selections.map((s) => s.conceptId));
  const pinnedByAsset = new Set(
    selections.map((s) => s.asset).filter(Boolean) as string[],
  );
  for (const s of selections) {
    if (extracted.some((c) => c.conceptId === s.conceptId)) continue;
    extracted.push({
      conceptId: s.conceptId,
      label: s.label || s.conceptId,
      slot: s.slot,
      asset: s.asset,
      excerpt: s.excerpt,
    });
  }
  return extracted.map((c) => ({
    ...c,
    pinned:
      pinnedByConcept.has(c.conceptId) ||
      Boolean(c.asset && pinnedByAsset.has(c.asset)),
  }));
}

export function writeDesignLoopConcepts(
  projectRoot: string,
  loopId: string,
  concepts: DesignLoopConcept[],
): void {
  writeFileSync(
    designLoopConceptsPath(projectRoot, loopId),
    `${JSON.stringify({ concepts }, null, 2)}\n`,
    "utf-8",
  );
}

export function refreshDesignLoopConcepts(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
}): DesignLoopConcept[] {
  const concepts = buildDesignLoopConceptCatalog(opts);
  writeDesignLoopConcepts(opts.projectRoot, opts.loopId, concepts);
  return concepts;
}

export function pinDesignLoopSelection(opts: {
  projectRoot: string;
  loopId: string;
  slot: DesignLoopSelectionSlot;
  conceptId?: string;
  asset?: string;
  label?: string;
  excerpt?: string;
}): DesignLoopMeta {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const catalog = buildDesignLoopConceptCatalog({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  let conceptId = opts.conceptId?.trim();
  let asset = opts.asset?.trim();
  let label = opts.label?.trim();
  let excerpt = opts.excerpt?.trim();

  if (conceptId) {
    const slug = slugConceptId(conceptId);
    const needle = conceptId.toLowerCase();
    const hit =
      catalog.find((c) => c.conceptId === conceptId || c.conceptId === slug) ||
      catalog.find((c) => c.label.toLowerCase() === needle) ||
      catalog.find((c) => c.label.toLowerCase().includes(needle)) ||
      catalog.find((c) => c.asset && needle.includes(c.asset.toLowerCase()));
    if (hit) {
      conceptId = hit.conceptId;
      asset = asset || hit.asset;
      label = label || hit.label;
      excerpt = excerpt || hit.excerpt;
    } else {
      conceptId = slug;
      // Fall back: asset filename containing concept letter / slug
      if (!asset) {
        const fromAsset = catalog.find(
          (c) =>
            c.asset &&
            (c.asset.toLowerCase().includes(slug.replace(/^concept-/, "")) ||
              c.conceptId.includes(slug)),
        );
        if (fromAsset) {
          asset = fromAsset.asset;
          label = label || fromAsset.label;
          conceptId = fromAsset.conceptId.startsWith("concept-")
            ? slug
            : fromAsset.conceptId;
        }
      }
    }
  } else if (asset) {
    const hit = catalog.find((c) => c.asset === asset);
    conceptId = hit?.conceptId || slugConceptId(asset);
    label = label || hit?.label || asset;
  } else {
    throw new Error("pin requires conceptId and/or asset");
  }

  if (asset) {
    const assets = listDesignLoopAssets(
      opts.projectRoot,
      meta.projectId,
      opts.loopId,
    );
    if (!assets.some((a) => a.name === asset)) {
      throw new Error(`Asset not found in loop assets/: ${asset}`);
    }
  }

  const selection: DesignLoopSelection = {
    slot: opts.slot,
    conceptId: conceptId!,
    label,
    asset,
    excerpt,
    pinnedAt: new Date().toISOString(),
  };
  // Element pins are multi-valued (theme-toggle + others); other slots stay 1:1.
  const prior = getDesignLoopSelections(meta).filter((s) =>
    opts.slot === "element"
      ? !(s.slot === "element" && s.conceptId === conceptId)
      : s.slot !== opts.slot,
  );
  const next: DesignLoopMetaWithSelections = {
    ...meta,
    selections: [...prior, selection],
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, next);
  refreshDesignLoopConcepts({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  return next;
}

export function unpinDesignLoopSelection(opts: {
  projectRoot: string;
  loopId: string;
  slot?: DesignLoopSelectionSlot;
}): DesignLoopMeta {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const prior = getDesignLoopSelections(meta);
  const nextSel = opts.slot ? prior.filter((s) => s.slot !== opts.slot) : [];
  const next: DesignLoopMetaWithSelections = {
    ...meta,
    selections: nextSel,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, next);
  refreshDesignLoopConcepts({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  return next;
}

export function replaceDesignLoopSelections(opts: {
  projectRoot: string;
  loopId: string;
  selections: DesignLoopSelection[];
}): DesignLoopMeta {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  const bySlot = new Map<string, DesignLoopSelection>();
  for (const s of opts.selections) {
    if (!s.slot || !s.conceptId) continue;
    bySlot.set(s.slot, {
      ...s,
      pinnedAt: s.pinnedAt || new Date().toISOString(),
    });
  }
  const next: DesignLoopMetaWithSelections = {
    ...meta,
    selections: [...bySlot.values()],
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, next);
  refreshDesignLoopConcepts({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  return next;
}

export function formatDesignLoopSelectionsPromptBlock(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
  /** When true, prior logo pin may be replaced via generate_image + pin_logo. */
  inventLogo?: boolean;
}): string {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) return "";
  const concepts = buildDesignLoopConceptCatalog({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    version: opts.version,
  });
  const selections = getDesignLoopSelections(meta);
  const inventLogo = Boolean(opts.inventLogo);
  const lines: string[] = [];

  if (inventLogo) {
    lines.push(
      "PINNED (logo pin SUPERSEDED this turn — invent a NEW mark with generate_image inventNew=true, then pin_logo the new file):",
    );
  } else {
    lines.push(
      "PINNED (authoritative — keep these; do NOT regenerate or replace with generate_image):",
    );
  }
  if (!selections.length) {
    lines.push("- (none pinned)");
  } else {
    for (const s of selections) {
      const path = s.asset
        ? `.slopcontrol/design-loops/${opts.loopId}/assets/${s.asset}`
        : "";
      const logoNote =
        inventLogo && s.slot === "logo"
          ? " (superseded — do not re-embed; invent + pin a replacement)"
          : "";
      lines.push(
        `- ${s.slot}: ${s.label || s.conceptId}${path ? ` → ${path}` : ""}${logoNote}${
          s.excerpt ? ` — ${s.excerpt.slice(0, 120)}` : ""
        }`,
      );
    }
  }

  const pinnedIds = new Set(selections.map((s) => s.conceptId));
  const candidates = concepts.filter(
    (c) => !c.pinned && !pinnedIds.has(c.conceptId),
  );
  lines.push("");
  lines.push("CANDIDATES (not pinned — do not promote unless operator asks):");
  if (!candidates.length) {
    lines.push("- (none)");
  } else {
    for (const c of candidates.slice(0, 24)) {
      lines.push(
        `- ${c.slot} ${c.label}${c.asset ? ` → assets/${c.asset}` : ""}`,
      );
    }
  }

  lines.push("");
  lines.push("IMAGE EDITS (deterministic — do NOT generate_image):");
  lines.push(
    "- strip black / alpha / transparent background → make_transparent(sourceFilename=pinned or named asset)",
  );
  lines.push(
    "- icon pack / favicons / browser pack → derive_icon_pack(sourceFilename=...)",
  );
  lines.push("- resize / trim / pad → resize_image / trim_image / pad_image");
  if (inventLogo) {
    lines.push(
      "- generate_image: REQUIRED this turn for a NEW mark — pass inventNew=true, then pin_logo the result. Never reuse the superseded logo path.",
    );
  } else {
    lines.push(
      "- generate_image is ONLY for inventing a NEW mark when nothing is pinned and the operator asks to invent — never to 'fix' alpha or packs.",
    );
  }
  lines.push("");
  lines.push(
    "ELEMENTS: when META pins slot=element (or SHARED ELEMENTS block is present), embed that control once — do not invent a second day/night toggle.",
  );

  return lines.join("\n");
}

function resolveCatalogHitByStylePhrase(
  catalog: ReturnType<typeof buildDesignLoopConceptCatalog>,
  msg: string,
): (typeof catalog)[number] | undefined {
  // "go with the modern logo" / "use the rustic mark" → prefer *-alpha.png marks.
  const styleFirst = msg.match(
    /\b(modern|rustic|craft|vintage|abstract|circle|circular|symbolic)\b.{0,40}\b(logo|mark|symbol|monogram)\b/i,
  );
  if (styleFirst?.[1]) {
    return pickStyleLogoFromCatalog(catalog, styleFirst[1].toLowerCase());
  }
  const nounFirst = msg.match(
    /\b(logo|mark|symbol)\b.{0,40}\b(modern|rustic|craft|vintage|abstract|circle|circular)\b/i,
  );
  if (nounFirst?.[2]) {
    return pickStyleLogoFromCatalog(catalog, nounFirst[2].toLowerCase());
  }
  return undefined;
}

function pickStyleLogoFromCatalog(
  catalog: ReturnType<typeof buildDesignLoopConceptCatalog>,
  style: string,
): (typeof catalog)[number] | undefined {
  const logoish = catalog.filter(
    (c) =>
      (c.slot === "logo" || !c.slot) &&
      c.asset &&
      new RegExp(style, "i").test(c.asset),
  );
  if (!logoish.length) return undefined;
  const alpha = logoish.find((c) => /alpha/i.test(c.asset ?? ""));
  const mark = logoish.find((c) => /logo|mark/i.test(c.asset ?? ""));
  return alpha || mark || logoish[0];
}

/**
 * Chat-driven pin: operator names a file, concept, or style ("modern logo").
 * Explicit filenames pin directly from loop assets/ even when not in CONCEPTS.
 */
export function maybeAutoPinFromOperatorMessage(opts: {
  projectRoot: string;
  loopId: string;
  message: string;
}): DesignLoopMeta | null {
  const msg = opts.message.trim();
  if (!msg) return null;
  if (
    !/\b(use|select|like|pin|go with|chosen|choose|set|switch\s+to|make)\b/i.test(
      msg,
    )
  ) {
    return null;
  }
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) return null;

  // 1. Explicit asset filename in the message — authoritative, no catalog required.
  const fileMatch = msg.match(
    /([a-z0-9._-]+\.(?:png|jpe?g|webp|gif|svg))/i,
  );
  if (fileMatch?.[1]) {
    const filename = fileMatch[1];
    const assets = listDesignLoopAssets(
      opts.projectRoot,
      meta.projectId,
      opts.loopId,
    );
    const onDisk = assets.find(
      (a) => a.name.toLowerCase() === filename.toLowerCase(),
    );
    if (onDisk) {
      try {
        return pinDesignLoopSelection({
          projectRoot: opts.projectRoot,
          loopId: opts.loopId,
          slot: "logo",
          asset: onDisk.name,
          conceptId: onDisk.name.replace(/\.[^.]+$/, ""),
          label: onDisk.name,
        });
      } catch {
        return null;
      }
    }
  }

  const catalog = buildDesignLoopConceptCatalog({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
  });
  const conceptMatch = msg.match(/concept\s*([a-z0-9]+)/i);
  let hit = conceptMatch
    ? catalog.find(
        (c) =>
          c.conceptId === `concept-${conceptMatch[1]!.toLowerCase()}` ||
          c.label.toLowerCase() ===
            `concept ${conceptMatch[1]!.toLowerCase()}`,
      )
    : undefined;
  if (!hit && fileMatch?.[1]) {
    const needle = fileMatch[1].toLowerCase();
    hit = catalog.find((c) => c.asset?.toLowerCase() === needle);
  }
  if (!hit) {
    hit = resolveCatalogHitByStylePhrase(catalog, msg);
  }
  if (!hit) return null;
  try {
    return pinDesignLoopSelection({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      slot: hit.slot || "logo",
      conceptId: hit.conceptId,
      asset: hit.asset,
      label: hit.label,
      excerpt: hit.excerpt,
    });
  } catch {
    return null;
  }
}

export function designLoopAskNeedsImageEdit(text: string): boolean {
  return /\b(alpha|transparent|transparency|remove\s*background|strip\s*black|chroma|icon\s*pack|favicon|browser\s*pack|resize|trim|pad\s*image|make_transparent|derive_icon)\b/i.test(
    text ?? "",
  );
}

/**
 * Pin a logo asset (e.g. make_transparent output). No-op if already pinned to same file.
 */
export function pinDesignLoopLogoAsset(opts: {
  projectRoot: string;
  loopId: string;
  asset: string;
  label?: string;
}): DesignLoopMeta | null {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) return null;
  const current = getDesignLoopSelections(meta).find((s) => s.slot === "logo");
  if (current?.asset === opts.asset) return meta;
  try {
    return pinDesignLoopSelection({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      slot: "logo",
      asset: opts.asset,
      conceptId: opts.asset.replace(/\.[^.]+$/, ""),
      label: opts.label || opts.asset,
    });
  } catch {
    return null;
  }
}

/**
 * If no logo is pinned, pin the dominant mark from the previous mock HTML.
 */
export function maybeAutoPinDominantLogoFromMock(opts: {
  projectRoot: string;
  loopId: string;
  previousHtml?: string | null;
}): DesignLoopMeta | null {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) return null;
  if (getDesignLoopSelections(meta).some((s) => s.slot === "logo" && s.asset)) {
    return null;
  }
  const html = opts.previousHtml?.trim();
  if (!html) return null;
  const asset = dominantMockLogoAsset(html);
  if (!asset) return null;
  return pinDesignLoopLogoAsset({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    asset,
    label: `Dominant mock mark (${asset})`,
  });
}
