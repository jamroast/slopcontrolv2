import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

const requireDesignPack = createRequire(import.meta.url);

const SLOP_DIR = ".slopcontrol";

export type DesignLoopStatus = "open" | "accepted" | "implemented";

export type DesignLoopLastError = {
  version: number;
  reason: string;
  at: string;
};

export type DesignLoopMeta = {
  id: string;
  projectId: string;
  brief: string;
  status: DesignLoopStatus;
  phaseId?: string;
  askId?: string;
  currentVersion: number;
  acceptedVersion?: number;
  /**
   * Features shipped via the last successful implement_design bind.
   * Used so a logo-only extension accept does not re-open prior screens/theme.
   */
  lastImplementedVersion?: number;
  lastImplementedFeatureIds?: string[];
  lastError?: DesignLoopLastError;
  /** Dynamic conceptual-model scope frame (product / shell / screen / component / flow). */
  scope?: import("./design-conceptual-model.js").DesignScope;
  createdAt: string;
  updatedAt: string;
};

export type DesignLoopVersionStatus = "active" | "invalid";

export type DesignLoopVersionMeta = {
  version: number;
  /** Prior version this mock was revised from (`null` for v1). */
  parentVersion: number | null;
  status: DesignLoopVersionStatus;
  invalidReason?: string;
  invalidatedAt?: string;
  usedScaffold: boolean;
  error?: string;
  updatedAt: string;
};

export type DesignLoopAcceptanceFeature = {
  id: string;
  label: string;
  accepted: boolean;
};

export type DesignLoopAcceptance = {
  version: number;
  features: DesignLoopAcceptanceFeature[];
  acceptedAt?: string;
  updatedAt?: string;
};

/** Stable fallbacks when mock has no parseable section labels (product scope). */
export const DESIGN_LOOP_FALLBACK_FEATURES: DesignLoopAcceptanceFeature[] = [
  { id: "palette", label: "Palette — sibling tokens", accepted: false },
  { id: "logo", label: "Logo / mark", accepted: false },
  { id: "type", label: "Typography", accepted: false },
  { id: "applied_shell", label: "Applied frames — shell / dashboard chrome", accepted: false },
  {
    id: "theme_modes",
    label: "Theme modes — dark / light (data-theme)",
    accepted: false,
  },
];

export function designLoopsRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR, "design-loops");
}

export function designLoopDir(projectRoot: string, loopId: string): string {
  return join(designLoopsRoot(projectRoot), loopId);
}

export function designLoopVersionDir(
  projectRoot: string,
  loopId: string,
  version: number,
): string {
  return join(designLoopDir(projectRoot, loopId), `v${version}`);
}

export function ensureDesignLoopDir(
  projectRoot: string,
  loopId: string,
): string {
  mkdirSync(join(projectRoot, SLOP_DIR), { recursive: true });
  const dir = designLoopDir(projectRoot, loopId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function designLoopMetaPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "META.json");
}

export function designLoopTranscriptPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "TRANSCRIPT.md");
}

export function designLoopAcceptedPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "ACCEPTED");
}

export function designLoopAcceptancePath(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "ACCEPTANCE.json");
}

export function designLoopAssetsDir(
  projectRoot: string,
  loopId: string,
): string {
  return join(designLoopDir(projectRoot, loopId), "assets");
}

/** HTTP path (no host) for a loop asset — dashboard prefixes its proxy. */
export function designLoopHttpAssetPath(
  projectId: string,
  loopId: string,
  filename: string,
): string {
  const name = basename(filename);
  return `/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/assets/${encodeURIComponent(name)}`;
}

/**
 * Path-safe resolve of a file under design-loops/<loopId>/assets/.
 * Rejects traversal; returns null if missing.
 */
export function resolveDesignLoopAssetFile(
  projectRoot: string,
  loopId: string,
  name: string,
): string | null {
  const base = basename(String(name ?? ""));
  if (!base || base !== String(name ?? "") || base.includes("..")) return null;
  const dir = resolve(designLoopAssetsDir(projectRoot, loopId));
  const absolute = resolve(dir, base);
  if (!absolute.startsWith(dir + sep) && absolute !== dir) return null;
  if (!existsSync(absolute)) return null;
  return absolute;
}

export type DesignLoopAssetListing = {
  name: string;
  /** Path-only URL under SlopControl (prefix with dashboard proxy for browsers). */
  url: string;
};

/** List raster/assets in a loop assets/ folder. */
export function listDesignLoopAssets(
  projectRoot: string,
  projectId: string,
  loopId: string,
): DesignLoopAssetListing[] {
  const dir = designLoopAssetsDir(projectRoot, loopId);
  if (!existsSync(dir)) return [];
  const out: DesignLoopAssetListing[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    if (name.endsWith(".json") || name.endsWith(".md")) continue;
    const abs = resolveDesignLoopAssetFile(projectRoot, loopId, name);
    if (!abs) continue;
    out.push({
      name,
      url: designLoopHttpAssetPath(projectId, loopId, name),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Rewrite project-relative design-loop asset paths in mock HTML to HTTP paths
 * for remote preview. Does not mutate files on disk.
 *
 * `assetBase` is prepended (e.g. "" or "http://host:3020"). Default "".
 */
export function rewriteDesignLoopAssetUrls(
  html: string,
  opts: {
    projectId: string;
    loopId: string;
    /** Optional origin/prefix; paths always start with /projects/... */
    assetBase?: string;
  },
): string {
  if (!html?.trim()) return html;
  const loopId = opts.loopId.trim();
  if (!loopId) return html;
  const base = (opts.assetBase ?? "").replace(/\/$/, "");
  // Match .slopcontrol/design-loops/<loopId>/assets/<file> with optional ./ or
  // leading /. Any loop id is accepted: inherited mocks legitimately reference
  // a source loop's assets, and every loop has its own servable route, so the
  // rewrite preserves the loop id found in the path.
  const re =
    /(?:\.\/|\/)?(?:\.slopcontrol\/design-loops\/([^\s"'<>?#+/]+)\/assets\/)([^\s"'<>?#+]+)/gi;
  return html.replace(re, (_full, srcLoopId: string, file: string) => {
    const name = basename(String(file).split("?")[0] ?? "");
    if (!name || name.includes("..")) return _full;
    const path = designLoopHttpAssetPath(opts.projectId, srcLoopId, name);
    return `${base}${path}`;
  });
}

/**
 * Normalize stored-mock asset refs to this loop's own assets dir. Inherited or
 * generated mocks can carry `.slopcontrol/design-loops/<otherLoop>/assets/<name>`
 * refs; when this loop already holds a file with the same name (brand-asset
 * carry, prior-design import), repoint the ref to this loop's copy. Refs to
 * files this loop does not hold are left untouched — the serve-time rewrite
 * still resolves them via the source loop's route.
 */
export function normalizeDesignLoopMockAssetRefs(opts: {
  projectRoot: string;
  loopId: string;
  html: string;
}): string {
  const html = opts.html;
  if (!html?.trim()) return html;
  const loopId = opts.loopId.trim();
  if (!loopId) return html;
  const assetsDir = designLoopAssetsDir(opts.projectRoot, loopId);
  const re =
    /(?:\.\/)?\.slopcontrol\/design-loops\/([^\s"'<>?#+/]+)\/assets\/([^\s"'<>?#+]+)/gi;
  return html.replace(re, (full, srcLoopId: string, file: string) => {
    if (srcLoopId === loopId) return full;
    const name = basename(String(file).split("?")[0] ?? "");
    if (!name || name.includes("..")) return full;
    if (!existsSync(join(assetsDir, name))) return full;
    return `.slopcontrol/design-loops/${loopId}/assets/${name}`;
  });
}

/** Slug for checklist id from a section label. */
export function slugifyDesignFeatureId(label: string): string {
  const lower = label.toLowerCase();
  // Map common mock section wording onto stable ids (match on original text)
  if (/\bpalette\b/.test(lower) || /\bswatch/.test(lower)) return "palette";
  if (/\blogo\b/.test(lower) || /\bmark\b/.test(lower) || /\blockup/.test(lower))
    return "logo";
  if (
    /\btype\b/.test(lower) ||
    /\btypo/.test(lower) ||
    /\bfont/.test(lower) ||
    /\bdisplay type\b/.test(lower)
  ) {
    return "type";
  }
  if (
    /\bapplied\b/.test(lower) ||
    /\bframe/.test(lower) ||
    /\bshell\b/.test(lower) ||
    /\bdashboard\b/.test(lower) ||
    /\bwireframe/.test(lower)
  ) {
    return "applied_shell";
  }
  if (
    /\btheme\s*modes?\b/.test(lower) ||
    /\bdark\b.*\blight\b/.test(lower) ||
    /\blight\b.*\bdark\b/.test(lower) ||
    /\bdata-theme\b/.test(lower)
  ) {
    return "theme_modes";
  }
  if (
    /\badoption\b/.test(lower) ||
    /\bchecklist\b/.test(lower) ||
    /\bhand to build\b/.test(lower)
  ) {
    return "adoption_assets";
  }
  const raw = lower
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
  return raw || "feature";
}

/**
 * Parse mock HTML `section-label` headings into checklist features.
 * Defaults accepted: false. Dedupes by id (first label wins).
 */
export function extractFeaturesFromMockHtml(
  html: string,
): DesignLoopAcceptanceFeature[] {
  const features: DesignLoopAcceptanceFeature[] = [];
  const seen = new Set<string>();
  const re =
    /class="[^"]*section-label[^"]*"[^>]*>\s*<b>\d+<\/b>\s*([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const label = (m[1] ?? "")
      .replace(/\s+/g, " ")
      .replace(/✓\s*locked/gi, "")
      .replace(/✓\s*ready/gi, "")
      .trim();
    if (!label) continue;
    const id = slugifyDesignFeatureId(label);
    if (seen.has(id)) continue;
    seen.add(id);
    features.push({ id, label, accepted: false });
  }
  return features;
}

function slugDesignFocus(focus: string): string {
  return (
    focus
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "element"
  );
}

/**
 * Feature ids that remain eligible to keep `accepted: true` on a narrow
 * continue (component/logo/icon). `null` means preserve all prior ticks.
 */
export function preservableAcceptedFeatureIdsForScope(
  scope: import("./design-conceptual-model.js").DesignScope | null | undefined,
): Set<string> | null {
  if (!scope) return null;
  if (scope.kind === "product") return null;
  const slug = slugDesignFocus(scope.focus);
  const keep = new Set<string>([`focus_${slug}`]);
  if (scope.kind === "component" || scope.kind === "flow") {
    if (/logo|mark|icon/i.test(scope.focus)) keep.add("logo");
    if (/palette|token|color/i.test(scope.focus)) keep.add("palette");
    if (/type|typograph|font/i.test(scope.focus)) keep.add("type");
    if (/chat|composer/i.test(scope.focus)) {
      keep.add("focus_chat");
      keep.add("focus_chat_composer");
    }
    return keep;
  }
  if (scope.kind === "shell") {
    keep.add("applied_shell");
    if (/theme/i.test(scope.focus)) keep.add("theme_modes");
    if (/logo|mark|icon/i.test(scope.focus)) keep.add("logo");
    if (/palette|token|color/i.test(scope.focus)) keep.add("palette");
    if (/nav|menubar/i.test(scope.focus)) keep.add("applied_shell");
    return keep;
  }
  if (scope.kind === "screen") {
    keep.add(`screen_${slug}`);
    return keep;
  }
  return null;
}

/** Whether this conceptual scope should clear prior acceptance ticks outside focus. */
export function shouldResetAcceptanceTicksOutsideScope(
  scope: import("./design-conceptual-model.js").DesignScope | null | undefined,
): boolean {
  return preservableAcceptedFeatureIdsForScope(scope) != null;
}

/**
 * Resolve research/develop inScope from current ticks + last implemented set.
 * Trusts current ticks after narrow-continue reset; strips preserved prior ticks
 * only when every prior id is still ticked and at least one new id was added
 * (JamPress V5 failure mode without tick reset).
 */
export function resolveDesignImplementInScope(opts: {
  acceptedFeatureIds: string[];
  lastImplementedFeatureIds?: string[] | null;
}): { inScope: string[]; alreadyApplied: string[] } {
  const accepted = [
    ...new Set(opts.acceptedFeatureIds.map((id) => String(id).trim()).filter(Boolean)),
  ];
  const last = [
    ...new Set(
      (opts.lastImplementedFeatureIds ?? [])
        .map((id) => String(id).trim())
        .filter(Boolean),
    ),
  ];
  if (last.length === 0) {
    return { inScope: accepted, alreadyApplied: [] };
  }
  const lastSet = new Set(last);
  const newOnly = accepted.filter((id) => !lastSet.has(id));
  const allPriorStillTicked = last.every((id) => accepted.includes(id));
  if (allPriorStillTicked && newOnly.length > 0) {
    return { inScope: newOnly, alreadyApplied: last };
  }
  return { inScope: accepted, alreadyApplied: last };
}

/** Phase description for implement_design → research after a design accept. */
export function phaseDescriptionFromDesignAccept(opts: {
  request?: string | null;
  briefFallback: string;
  inScopeIds: string[];
  features?: DesignLoopAcceptanceFeature[];
  /** When true, prefer request + delta labels over the original loop brief. */
  isExtensionImplement?: boolean;
}): string {
  const labelFor = (id: string): string => {
    const hit = opts.features?.find((f) => f.id === id);
    return hit?.label?.trim() || id;
  };
  const request = (opts.request ?? "").trim();
  const brief = opts.briefFallback.trim();
  const scopeLines = opts.inScopeIds.map((id) => `- ${id}: ${labelFor(id)}`);
  if (opts.isExtensionImplement) {
    const head =
      request ||
      (opts.inScopeIds.length
        ? `Implement accepted design extension: ${opts.inScopeIds.join(", ")}`
        : brief);
    const parts = [
      head.slice(0, 800),
      "",
      "In scope for this implement (delta vs prior applied design):",
      ...(scopeLines.length ? scopeLines : ["- (none)"]),
    ];
    return parts.join("\n").slice(0, 4_000);
  }
  if (request && request !== brief) {
    return [request.slice(0, 800), "", brief.slice(0, 1_200)]
      .join("\n")
      .slice(0, 4_000);
  }
  return brief.slice(0, 4_000);
}

/** Merge proposed features with prior ticks (preserve accepted when id matches). */
export function mergeAcceptanceFeatures(
  proposed: DesignLoopAcceptanceFeature[],
  prior?: DesignLoopAcceptanceFeature[] | null,
  opts?: {
    scope?: import("./design-conceptual-model.js").DesignScope | null;
    includeThemeModes?: boolean;
    /**
     * When set, only these feature ids may keep prior `accepted: true`.
     * Others are listed but forced to `accepted: false`. Matching scope
     * fallbacks are defaulted to accepted for a ready logo-only accept.
     */
    preserveAcceptedIds?: Set<string> | null;
  },
): DesignLoopAcceptanceFeature[] {
  // Lazy import avoids circular init with conceptual-model helpers.
  const {
    fallbackFeaturesForScope,
    defaultProductScope,
  } = requireDesignPack("./design-conceptual-model.js") as typeof import("./design-conceptual-model.js");
  const scope = opts?.scope ?? defaultProductScope();
  const fallbacks = fallbackFeaturesForScope(scope, {
    includeThemeModes: opts?.includeThemeModes,
  });
  const preserve = opts?.preserveAcceptedIds ?? null;
  const priorMap = new Map((prior ?? []).map((f) => [f.id, f.accepted]));
  const resolveAccepted = (id: string, fallbackAccepted: boolean): boolean => {
    if (!preserve) {
      return priorMap.has(id) ? Boolean(priorMap.get(id)) : fallbackAccepted;
    }
    if (preserve.has(id)) {
      // Prefer prior tick when present; otherwise default in-scope to true so
      // a logo-only continue is ready to accept without re-ticking.
      if (priorMap.has(id)) return Boolean(priorMap.get(id));
      return true;
    }
    return false;
  };
  const base =
    proposed.length > 0
      ? proposed
      : fallbacks.map((f) => ({ ...f }));
  const seen = new Set(base.map((f) => f.id));
  const merged = base.map((f) => ({
    ...f,
    accepted: resolveAccepted(f.id, f.accepted),
  }));
  // Keep prior-only ids that were ticked (operator custom) when still relevant
  for (const f of prior ?? []) {
    if (seen.has(f.id)) continue;
    merged.push({
      ...f,
      accepted: resolveAccepted(f.id, f.accepted),
    });
    seen.add(f.id);
  }
  // Ensure scope fallbacks exist when mock had partial sections
  for (const fb of fallbacks) {
    if (seen.has(fb.id)) continue;
    if (merged.some((x) => x.id === fb.id)) continue;
    merged.push({
      ...fb,
      accepted: resolveAccepted(fb.id, false),
    });
    seen.add(fb.id);
  }
  // Product scope: still ensure classic fallbacks when kind is product
  if (scope.kind === "product") {
    for (const fb of DESIGN_LOOP_FALLBACK_FEATURES) {
      if (fb.id === "theme_modes" && !opts?.includeThemeModes) continue;
      if (seen.has(fb.id)) continue;
      merged.push({
        ...fb,
        accepted: resolveAccepted(fb.id, false),
      });
      seen.add(fb.id);
    }
  }
  return merged;
}

export function readDesignLoopAcceptance(
  projectRoot: string,
  loopId: string,
): DesignLoopAcceptance | null {
  const path = designLoopAcceptancePath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as DesignLoopAcceptance;
    if (!raw || !Array.isArray(raw.features)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeDesignLoopAcceptance(
  projectRoot: string,
  loopId: string,
  acceptance: DesignLoopAcceptance,
): void {
  ensureDesignLoopDir(projectRoot, loopId);
  const next: DesignLoopAcceptance = {
    ...acceptance,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(
    designLoopAcceptancePath(projectRoot, loopId),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Seed/refresh ACCEPTANCE.json from mock HTML after start/continue/retry.
 * Preserves prior ticks by feature id unless the loop conceptual scope is
 * narrow (component/logo/…), in which case out-of-focus prior ticks are cleared.
 */
export function seedDesignLoopAcceptanceFromHtml(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  html: string;
  /**
   * When true, clear prior ticks outside the current conceptual scope.
   * Defaults to true when META.scope is component/flow/shell/screen.
   */
  resetOutsideScope?: boolean;
}): DesignLoopAcceptance {
  const prior = readDesignLoopAcceptance(opts.projectRoot, opts.loopId);
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  const {
    getDesignLoopScope,
    extractThemeContractFromHtml,
  } = requireDesignPack("./design-conceptual-model.js") as typeof import("./design-conceptual-model.js");
  const scope = getDesignLoopScope(meta);
  const theme = extractThemeContractFromHtml(opts.html);
  const extracted = extractFeaturesFromMockHtml(opts.html);
  if (theme && !extracted.some((f) => f.id === "theme_modes")) {
    extracted.push({
      id: "theme_modes",
      label: "Theme modes — dark / light (data-theme)",
      accepted: false,
    });
  }
  const reset =
    opts.resetOutsideScope ?? shouldResetAcceptanceTicksOutsideScope(scope);
  const preserveAcceptedIds = reset
    ? preservableAcceptedFeatureIdsForScope(scope)
    : null;
  const features = mergeAcceptanceFeatures(extracted, prior?.features, {
    scope,
    includeThemeModes: Boolean(theme),
    preserveAcceptedIds,
  });
  const acceptance: DesignLoopAcceptance = {
    version: opts.version,
    features,
    acceptedAt: prior?.acceptedAt,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopAcceptance(opts.projectRoot, opts.loopId, acceptance);
  return acceptance;
}

/** Normalize operator feature ticks into a full feature list. */
export function applyAcceptanceFeatureTicks(opts: {
  features: DesignLoopAcceptanceFeature[];
  /** Prefer full feature objects from the client. */
  nextFeatures?: DesignLoopAcceptanceFeature[];
  /** Or just the accepted ids. */
  acceptedFeatureIds?: string[];
}): DesignLoopAcceptanceFeature[] {
  if (opts.nextFeatures && opts.nextFeatures.length > 0) {
    return opts.nextFeatures.map((f) => ({
      id: String(f.id).trim(),
      label: String(f.label ?? f.id).trim() || String(f.id),
      accepted: Boolean(f.accepted),
    }));
  }
  const accepted = new Set(
    (opts.acceptedFeatureIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  );
  if (accepted.size === 0) {
    return opts.features.map((f) => ({ ...f }));
  }
  return opts.features.map((f) => ({
    ...f,
    accepted: accepted.has(f.id),
  }));
}

export function countAcceptedFeatures(
  features: DesignLoopAcceptanceFeature[],
): number {
  return features.filter((f) => f.accepted).length;
}

/** Phase-bound copy written by bindAcceptedDesignLoopToPhase. */
export function readPhaseDesignAcceptance(
  projectRoot: string,
  phaseId: string,
): DesignLoopAcceptance | null {
  const path = join(
    projectRoot,
    SLOP_DIR,
    "phases",
    phaseId,
    "design",
    "ACCEPTANCE.json",
  );
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as DesignLoopAcceptance;
    if (!raw || !Array.isArray(raw.features)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Prompt block for research / draft / develop. */
export function formatAcceptancePromptBlock(
  acceptance: DesignLoopAcceptance | null | undefined,
  opts?: {
    /** Feature ids treated as the implement change set (delta). */
    inScopeIds?: string[] | null;
    /** Previously shipped feature ids — do not re-plan unless also inScope. */
    alreadyAppliedIds?: string[] | null;
  },
): string {
  if (!acceptance?.features?.length) {
    return `Design-loop acceptance checklist: (missing — operator must accept features before implement)`;
  }
  const inScopeSet =
    opts?.inScopeIds != null
      ? new Set(opts.inScopeIds)
      : new Set(
          acceptance.features.filter((f) => f.accepted).map((f) => f.id),
        );
  const alreadySet = new Set(opts?.alreadyAppliedIds ?? []);
  const yes = acceptance.features.filter((f) => inScopeSet.has(f.id));
  const applied = acceptance.features.filter(
    (f) => alreadySet.has(f.id) && !inScopeSet.has(f.id),
  );
  const no = acceptance.features.filter(
    (f) => !inScopeSet.has(f.id) && !alreadySet.has(f.id),
  );
  const lines = [
    `Design-loop acceptance checklist (v${acceptance.version}${acceptance.acceptedAt ? `, accepted ${acceptance.acceptedAt}` : ""}):`,
    `IN SCOPE (must plan File Changes / Success Criteria / Automated Checks for each — delta for this phase only):`,
    ...(yes.length
      ? yes.map((f) => `- [x] ${f.id}: ${f.label}`)
      : ["- (none — invalid)"]),
  ];
  if (applied.length) {
    lines.push(
      `ALREADY APPLIED (prior implement — do not re-theme / re-land / re-shell unless also IN SCOPE):`,
      ...applied.map((f) => `- [~] ${f.id}: ${f.label}`),
    );
  }
  lines.push(
    `OUT OF SCOPE (mustNot — do not expand into this phase):`,
    ...(no.length ? no.map((f) => `- [ ] ${f.id}: ${f.label}`) : ["- (none)"]),
  );
  return lines.join("\n");
}

/**
 * Structured previous-mock block for design-loop continue (tokens + assets +
 * sections always present; HTML body clipped so the model does not amnesiate).
 */
export function formatDesignLoopReviseBlock(opts: {
  projectRoot: string;
  projectId: string;
  loopId: string;
  previousHtml: string;
  maxHtmlChars?: number;
}): string {
  const html = opts.previousHtml.trim();
  if (!html) return "(no previous mock — create v1)";
  const maxHtml = opts.maxHtmlChars ?? 16_000;
  const tokens = extractTokensCssFromHtml(html);
  const features = extractFeaturesFromMockHtml(html);
  const assets = listDesignLoopAssets(
    opts.projectRoot,
    opts.projectId,
    opts.loopId,
  );
  const parts: string[] = [
    "Previous mock (revise this — do not start from scratch unless asked):",
    "",
    "### Tokens from previous mock",
    "```css",
    tokens.trim() || "/* (none extracted) */",
    "```",
    "",
  ];
  if (assets.length) {
    parts.push("### Loop assets (embed these paths; do not invent a competing mark)");
    for (const a of assets) {
      parts.push(`- ${a.name} → \`.slopcontrol/design-loops/${opts.loopId}/assets/${a.name}\``);
    }
    parts.push("");
  }
  if (features.length) {
    parts.push("### Section outline");
    for (const f of features) parts.push(`- ${f.id}: ${f.label}`);
    parts.push("");
  }
  const clipped =
    html.length <= maxHtml
      ? html
      : `${html.slice(0, maxHtml)}\n\n…[truncated previous mock: ${html.length} chars total; keep tokens/assets/sections above]`;
  parts.push("### HTML (may be truncated — preserve structure below the fold)");
  parts.push("```html");
  parts.push(clipped);
  parts.push("```");
  return parts.join("\n");
}

/**
 * On generate failure: keep previousHtml when present; only scaffold for v1.
 */
export function resolveDesignLoopGenerateFallback(opts: {
  brief: string;
  previousHtml?: string | null;
  errorDetail: string;
  scaffold: (brief: string) => string;
}): { html: string; notes: string; usedScaffold: boolean } {
  const prior = opts.previousHtml?.trim();
  if (prior) {
    return {
      html: prior,
      notes: `Kept previous mock (agent error — not scaffolding over it): ${opts.errorDetail}`,
      usedScaffold: false,
    };
  }
  return {
    html: opts.scaffold(opts.brief),
    notes: `Scaffold fallback (agent error): ${opts.errorDetail}`,
    usedScaffold: true,
  };
}

/**
 * Research/draft prompt digest when phase design/mock.html is bound.
 */
export function formatPhaseBoundMockPromptBlock(opts: {
  projectRoot: string;
  phaseId: string;
  maxHtmlChars?: number;
}): string {
  const designDir = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "design",
  );
  const mockPath = join(designDir, "mock.html");
  const tokensPath = join(designDir, "tokens.css");
  const assetsDir = join(designDir, "assets");
  if (!existsSync(mockPath)) return "";

  let html = "";
  try {
    html = readFileSync(mockPath, "utf-8");
  } catch {
    return "";
  }
  if (!html.trim()) return "";

  const maxHtml = opts.maxHtmlChars ?? 10_000;
  const tokensFromFile = existsSync(tokensPath)
    ? readFileSync(tokensPath, "utf-8")
    : "";
  const tokens = tokensFromFile.trim() || extractTokensCssFromHtml(html);
  const features = extractFeaturesFromMockHtml(html);
  const assetNames: string[] = [];
  if (existsSync(assetsDir)) {
    try {
      for (const name of readdirSync(assetsDir)) {
        if (name.startsWith(".") || name.endsWith(".json")) continue;
        assetNames.push(name);
      }
    } catch {
      /* ignore */
    }
  }

  const relMock = `.slopcontrol/phases/${opts.phaseId}/design/mock.html`;
  const parts: string[] = [
    `Accepted design-loop mock (authoritative visual reference for IN-SCOPE features only):`,
    `- Full mock: \`${relMock}\` — RESEARCH must cite this path and plan File Changes against **accepted checklist items only** (see acceptance / DESIGN_PACK.inScope).`,
    `- Do NOT re-implement already-applied screens/theme/shell from a prior design implement unless those features are IN SCOPE for this phase.`,
    `- Do NOT invent a competing logo/mark metaphor when assets exist under \`.slopcontrol/phases/${opts.phaseId}/design/assets/\`.`,
    `- Mount accepted assets (or copy into public/) rather than drawing a new monogram.`,
    "",
    "### tokens.css",
    "```css",
    tokens.trim().slice(0, 3_000) || "/* missing */",
    "```",
    "",
  ];
  if (assetNames.length) {
    parts.push("### design/assets/");
    for (const n of assetNames.sort()) {
      parts.push(`- \`.slopcontrol/phases/${opts.phaseId}/design/assets/${n}\``);
    }
    parts.push("");
  }
  if (features.length) {
    parts.push("### Mock section outline");
    for (const f of features) parts.push(`- ${f.id}: ${f.label}`);
    parts.push("");
  }
  const clipped =
    html.length <= maxHtml
      ? html
      : `${html.slice(0, maxHtml)}\n\n…[truncated mock.html: ${html.length} chars; read \`${relMock}\` for the rest]`;
  parts.push("### mock.html excerpt");
  parts.push("```html");
  parts.push(clipped);
  parts.push("```");
  return parts.join("\n");
}

export function writeDesignLoopMeta(
  projectRoot: string,
  meta: DesignLoopMeta,
): void {
  ensureDesignLoopDir(projectRoot, meta.id);
  writeFileSync(
    designLoopMetaPath(projectRoot, meta.id),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf-8",
  );
}

export function readDesignLoopMeta(
  projectRoot: string,
  loopId: string,
): DesignLoopMeta | null {
  const path = designLoopMetaPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DesignLoopMeta;
  } catch {
    return null;
  }
}

export function appendDesignLoopTranscript(
  projectRoot: string,
  loopId: string,
  role: "user" | "assistant",
  content: string,
): void {
  ensureDesignLoopDir(projectRoot, loopId);
  const path = designLoopTranscriptPath(projectRoot, loopId);
  const at = new Date().toISOString();
  const label = role === "user" ? "User" : "Assistant";
  const block = `### ${label} (${at})\n\n${content.trim()}\n\n`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# Design loop — ${loopId}\n\n## Transcript\n\n${block}`,
      "utf-8",
    );
    return;
  }
  writeFileSync(path, readFileSync(path, "utf-8") + block, "utf-8");
}

export function readDesignLoopTranscript(
  projectRoot: string,
  loopId: string,
): string {
  const path = designLoopTranscriptPath(projectRoot, loopId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeDesignLoopVersion(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  html: string;
  notes?: string;
  /** Operator prompt that produced this version (brief or continue message). */
  request?: string;
  usedScaffold?: boolean;
  error?: string;
  /**
   * Prior version this revision is based on. Defaults to version-1 (or null for v1)
   * when omitted. Retry should pass the existing parent.
   */
  parentVersion?: number | null;
  /**
   * When true (default on write), mark version active and clear invalid markers
   * (used by successful regenerate/retry).
   */
  clearInvalid?: boolean;
}): { htmlPath: string; notesPath: string; requestPath: string; metaPath: string } {
  const dir = designLoopVersionDir(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  mkdirSync(dir, { recursive: true });
  const htmlPath = join(dir, "mock.html");
  const notesPath = join(dir, "NOTES.md");
  const requestPath = join(dir, "REQUEST.md");
  const metaPath = join(dir, "META.json");
  const html = normalizeDesignLoopMockAssetRefs({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    html: opts.html,
  });
  writeFileSync(htmlPath, `${html.trim()}\n`, "utf-8");
  writeFileSync(
    notesPath,
    `# Design loop v${opts.version}\n\n${(opts.notes ?? "").trim() || "(no notes)"}\n`,
    "utf-8",
  );
  if (opts.request !== undefined) {
    writeFileSync(requestPath, `${opts.request.trim()}\n`, "utf-8");
  }
  const prior = readDesignLoopVersionMeta(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  const parentVersion =
    opts.parentVersion !== undefined
      ? opts.parentVersion
      : prior?.parentVersion !== undefined
        ? prior.parentVersion
        : opts.version <= 1
          ? null
          : opts.version - 1;
  const clearInvalid = opts.clearInvalid !== false;
  const versionMeta: DesignLoopVersionMeta = {
    version: opts.version,
    parentVersion,
    status: clearInvalid ? "active" : (prior?.status ?? "active"),
    usedScaffold: Boolean(opts.usedScaffold),
    error: opts.error,
    updatedAt: new Date().toISOString(),
  };
  if (!clearInvalid && prior?.status === "invalid") {
    if (prior.invalidReason) versionMeta.invalidReason = prior.invalidReason;
    if (prior.invalidatedAt) versionMeta.invalidatedAt = prior.invalidatedAt;
  }
  writeFileSync(metaPath, `${JSON.stringify(versionMeta, null, 2)}\n`, "utf-8");
  return { htmlPath, notesPath, requestPath, metaPath };
}

export function readDesignLoopMockHtml(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    designLoopVersionDir(projectRoot, loopId, version),
    "mock.html",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readDesignLoopNotes(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    designLoopVersionDir(projectRoot, loopId, version),
    "NOTES.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readDesignLoopRequest(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    designLoopVersionDir(projectRoot, loopId, version),
    "REQUEST.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readDesignLoopVersionMeta(
  projectRoot: string,
  loopId: string,
  version: number,
): DesignLoopVersionMeta | null {
  const path = join(
    designLoopVersionDir(projectRoot, loopId, version),
    "META.json",
  );
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DesignLoopVersionMeta;
  } catch {
    return null;
  }
}

/** Record a scaffold/timeout failure on loop META; clear when regenerate succeeds. */
export function setDesignLoopLastError(
  projectRoot: string,
  loopId: string,
  error: DesignLoopLastError | null,
): DesignLoopMeta | null {
  const meta = readDesignLoopMeta(projectRoot, loopId);
  if (!meta) return null;
  const next: DesignLoopMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
  };
  if (error) next.lastError = error;
  else delete next.lastError;
  writeDesignLoopMeta(projectRoot, next);
  return next;
}

export function designLoopVersionExists(
  projectRoot: string,
  loopId: string,
  version: number,
): boolean {
  return existsSync(
    join(designLoopVersionDir(projectRoot, loopId, version), "mock.html"),
  );
}

/**
 * Re-open an accepted/implemented loop so the operator can continue to a new
 * version (v2…). Keeps phaseId + acceptedVersion as history until they accept again.
 * Does not delete prior vN mocks or rewrite product code.
 */
export function reopenDesignLoopForIterate(
  projectRoot: string,
  loopId: string,
): DesignLoopMeta {
  const meta = readDesignLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Design loop not found: ${loopId}`);
  if (meta.status === "open") return meta;
  const next: DesignLoopMeta = {
    ...meta,
    status: "open",
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(projectRoot, next);
  return next;
}

export function acceptDesignLoop(
  projectRoot: string,
  loopId: string,
  version?: number,
  featureTicks?: {
    features?: DesignLoopAcceptanceFeature[];
    acceptedFeatureIds?: string[];
  },
): DesignLoopMeta {
  const meta = readDesignLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Design loop not found: ${loopId}`);
  if (meta.status === "implemented") {
    throw new Error(
      `Design loop already implemented: ${loopId}. Call design_loop_continue to reopen and iterate (e.g. v2), then accept again.`,
    );
  }
  const v = version ?? meta.currentVersion;
  const versionMeta = readDesignLoopVersionMeta(projectRoot, loopId, v);
  if (versionMeta?.status === "invalid") {
    throw new Error(
      `Cannot accept invalid version v${v} — discard was applied; pick an active version`,
    );
  }
  const html = readDesignLoopMockHtml(projectRoot, loopId, v);
  if (!html?.trim()) {
    throw new Error(`Design loop version v${v} has no mock.html`);
  }

  let acceptance =
    readDesignLoopAcceptance(projectRoot, loopId) ??
    seedDesignLoopAcceptanceFromHtml({
      projectRoot,
      loopId,
      version: v,
      html,
    });

  const features = applyAcceptanceFeatureTicks({
    features: acceptance.features,
    nextFeatures: featureTicks?.features,
    acceptedFeatureIds: featureTicks?.acceptedFeatureIds,
  });
  if (countAcceptedFeatures(features) < 1) {
    throw new Error(
      "Accept requires at least one ticked feature (palette, logo, applied_shell, …)",
    );
  }
  const now = new Date().toISOString();
  acceptance = {
    version: v,
    features,
    acceptedAt: now,
    updatedAt: now,
  };
  writeDesignLoopAcceptance(projectRoot, loopId, acceptance);

  writeFileSync(designLoopAcceptedPath(projectRoot, loopId), `v${v}\n`, "utf-8");
  const next: DesignLoopMeta = {
    ...meta,
    status: "accepted",
    acceptedVersion: v,
    updatedAt: now,
  };
  writeDesignLoopMeta(projectRoot, next);
  try {
    const { compileAndWriteDesignPackOnAccept } = requireDesignPack(
      "./design-pack.js",
    ) as typeof import("./design-pack.js");
    compileAndWriteDesignPackOnAccept({
      projectRoot,
      loopId,
      version: v,
      acceptance,
    });
  } catch {
    /* accept succeeds even if pack compile fails */
  }
  return next;
}

export function listDesignLoops(projectRoot: string): DesignLoopMeta[] {
  const root = designLoopsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out: DesignLoopMeta[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const meta = readDesignLoopMeta(projectRoot, name);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createDesignLoopMeta(opts: {
  projectId: string;
  brief: string;
  phaseId?: string;
  askId?: string;
  scope?: import("./design-conceptual-model.js").DesignScope;
}): DesignLoopMeta {
  const now = new Date().toISOString();
  const { defaultProductScope } =
    requireDesignPack("./design-conceptual-model.js") as typeof import("./design-conceptual-model.js");
  // Scope refined after LLM continue-intent in designLoopGenerate.
  const scope = opts.scope ?? defaultProductScope("start");
  return {
    id: randomUUID(),
    projectId: opts.projectId,
    brief: opts.brief.trim(),
    status: "open",
    phaseId: opts.phaseId,
    askId: opts.askId,
    currentVersion: 0,
    scope,
    createdAt: now,
    updatedAt: now,
  };
}

/** Extract first HTML document from agent output. */
export function extractHtmlDocument(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim()) {
    const body = fenced[1].trim();
    if (/<html[\s>]/i.test(body) || /<!DOCTYPE/i.test(body)) return body;
    return wrapHtmlFragment(body);
  }
  const doctype = trimmed.search(/<!DOCTYPE\s+html/i);
  const htmlTag = trimmed.search(/<html[\s>]/i);
  const start = doctype >= 0 ? doctype : htmlTag;
  if (start >= 0) {
    return trimmed.slice(start).trim();
  }
  if (/<(?:div|main|header|section|body)\b/i.test(trimmed)) {
    return wrapHtmlFragment(trimmed);
  }
  return null;
}

function wrapHtmlFragment(fragment: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Design mock</title>
</head>
<body>
${fragment}
</body>
</html>`;
}

/** Minimal scaffold when the design agent returns no HTML. */
export function scaffoldDesignLoopMock(brief: string): string {
  const title = escapeHtml(brief.trim().slice(0, 80) || "Design mock");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    :root {
      --bg: #0A0A0A;
      --surface: #151515;
      --text: #F5F0E8;
      --muted: #9A8F80;
      --accent: #E8430A;
      --font: "Space Grotesk", system-ui, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.5rem;
      border-bottom: 1px solid #222;
      background: color-mix(in srgb, var(--surface) 90%, transparent);
    }
    .brand { font-weight: 700; letter-spacing: 0.02em; }
    .brand span { color: var(--accent); }
    main { padding: 2rem 1.5rem; max-width: 720px; margin: 0 auto; }
    .card {
      background: var(--surface);
      border-radius: 12px;
      padding: 1.25rem;
      border: 1px solid #2a2a2a;
    }
    .muted { color: var(--muted); font-size: 0.95rem; }
    .cta {
      display: inline-block;
      margin-top: 1rem;
      padding: 0.6rem 1rem;
      background: var(--accent);
      color: var(--text);
      border-radius: 8px;
      text-decoration: none;
      font-weight: 600;
    }
    .wire { outline: 1px dashed #444; min-height: 120px; margin-top: 1rem; padding: 1rem; }
  </style>
</head>
<body>
  <header>
    <div class="brand">Product <span>Mark</span></div>
    <nav class="muted">Nav · Nav · Nav</nav>
  </header>
  <main>
    <h1>${title}</h1>
    <p class="muted">Scaffold wireframe — refine via design_loop_continue.</p>
    <div class="card">
      <strong>Primary surface</strong>
      <div class="wire muted">Content / form / chat region</div>
      <a class="cta" href="#">Primary action</a>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Pull `:root { … }` from mock HTML for tokens.css. */
/**
 * Extract :root tokens plus [data-theme="light"] overrides when present.
 * Prefer extractThemeTokenBlocks for structured dark/light split.
 */
export function extractTokensCssFromHtml(html: string): string {
  try {
    const { extractThemeTokenBlocks } = requireDesignPack(
      "./design-conceptual-model.js",
    ) as typeof import("./design-conceptual-model.js");
    return extractThemeTokenBlocks(html).combinedTokensCss;
  } catch {
    const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)];
    for (const m of styleBlocks) {
      const css = m[1] ?? "";
      const root = css.match(/:root\s*\{([\s\S]*?)\}/);
      const body = root?.[1]?.trim();
      if (body) {
        return `:root {\n${body}\n}\n`;
      }
    }
    return `:root {
  /* seeded from design-loop mock — refine if needed */
  --color-bg: #0A0A0A;
  --color-text: #F5F0E8;
  --color-accent: #E8430A;
}\n`;
  }
}

/** Seed UI-SPEC.md from an accepted design-loop mock + feature checklist. */
export function uiSpecFromDesignLoopMock(opts: {
  brief: string;
  loopId: string;
  version: number;
  notes?: string;
  acceptance?: DesignLoopAcceptance | null;
  scope?: import("./design-conceptual-model.js").DesignScope | null;
  theme?: import("./design-conceptual-model.js").ThemeContract | null;
  /** Concrete DESIGN_PACK.shell bullets (menubar content-max, slots, …). */
  shellNotes?: string[] | null;
  /** Operator-pinned logo selection (phase-relative asset path when bound). */
  pinnedLogo?: { name: string; label?: string; path: string } | null;
}): string {
  const features = opts.acceptance?.features ?? [];
  const accepted = features.filter((f) => f.accepted);
  const out = features.filter((f) => !f.accepted);
  const acceptedBlock = accepted.length
    ? accepted.map((f) => `- [x] **${f.id}**: ${f.label}`).join("\n")
    : "- (none — invalid accept)";
  const outBlock = out.length
    ? out.map((f) => `- [ ] **${f.id}**: ${f.label}`).join("\n")
    : "- (none)";
  const hasPalette = accepted.some((f) => f.id === "palette");
  const hasType = accepted.some((f) => f.id === "type");
  const hasLogo = accepted.some(
    (f) => f.id === "logo" || f.id === "focus_logo" || /^focus_.*logo/i.test(f.id),
  );
  const hasShell = accepted.some((f) => f.id === "applied_shell");
  // Theme is IN SCOPE only when ticked — inherited dual-theme mock HTML must not widen.
  const hasTheme = accepted.some((f) => f.id === "theme_modes");
  const scope = opts.scope;
  const theme = opts.theme;

  const scopeSection = scope
    ? `## Scope (conceptual model)

- **kind:** ${scope.kind}
- **focus:** ${scope.focus}
- **preserve:** ${scope.preserve.length ? scope.preserve.join(", ") : "(none)"}
${scope.focusPaths.length ? `- **focusPaths:** ${scope.focusPaths.join(", ")}\n` : ""}
Implement only within this focus. Do not expand into preserved or out-of-scope surfaces.
`
    : "";

  const themeSection = hasTheme
    ? `## Theme

IN SCOPE (theme_modes / theme contract). Implement dark and light modes using \`html[data-theme="dark"|"light"]\`.
${
  theme
    ? `
- mechanism: ${theme.mechanism}
- defaultMode: ${theme.defaultMode}
- modes: ${theme.modes.join(", ")}
- togglePresent: ${theme.togglePresent}

Requirements:
${theme.requirements.map((r) => `- ${r}`).join("\n")}
${
  theme.togglePresent
    ? `
**Visibility (mandatory when togglePresent):** The day/night control must be **visible** in the playground/app shell menubar — not only mounted in the DOM / able to set \`data-theme\`.
- Consumer CSS entry (e.g. \`playground/src/index.css\`) must \`@source\` / scan package component trees that host the toggle (e.g. \`@source "../src/**/*.{ts,tsx}"\`), **or** the toggle must not rely on Tailwind utilities that only exist in unscanned files (use inline \`style={{ color: 'var(--text-secondary)' }}\` / CSS module sizing).
- Success Criteria must claim the control is **visible** (icons/chrome readable on dark and light).
- Automated Checks must prove **both** mount (\`<ThemeToggle\` in shell menubar **and** \`<Menubar\` in playground App) **and** style emission (\`@source\` covering \`../src\`, **or** after \`vite build\` grep built \`dist/assets/*.css\` for ThemeToggle utilities such as \`text-text-secondary\` / size, **or** non-utility color/size fallback). Import-order-only greps (\`@import "tailwindcss"\` first) are **insufficient**.
`
    : ""
}

Light token block from accepted mock (must land in product CSS):
\`\`\`css
${(theme.lightTokensCss || "/* implement light ladder */").trim().slice(0, 2_500)}
\`\`\`
`
    : `
- Drive theme via \`data-theme\` on \`<html>\` (not an unused \`.light\` class alone).
- Remap semantic tokens (\`--background\`, \`--surface\`, \`--foreground\`) under \`[data-theme="light"]\`.
- Body/chrome must consume those vars — not hard-coded \`--color-dark-*\` that ignore the toggle.
- If a theme toggle control is in scope: it must be **visible** in playground/app shell; prove mount + Tailwind \`@source\` / built-CSS utilities (not import-order alone).
`
}
`
    : `## Theme

OUT OF SCOPE for this accept — do not add a dual-mode theme system unless required by another accepted feature.
`;

  return `# UI-SPEC

**Source:** design loop \`${opts.loopId}\` v${opts.version} (accepted mock)
**Brief:** ${opts.brief.trim()}

${scopeSection}
## Accepted features

Implement **only** these checklist items (operator-accepted). Research/draft must turn each into Scope / File Changes / Success Criteria / Automated Checks.

${acceptedBlock}

## Out of scope

Do **not** expand this phase into:

${outBlock}

## Palette

${
  hasPalette
    ? "IN SCOPE. Derived from the accepted mock HTML (inline CSS `:root` tokens + light overrides when present). Prefer those hex values in product tokens."
    : "OUT OF SCOPE for this accept — do not retune the full palette unless required by another accepted feature."
}

## Typography

${
  hasType
    ? "IN SCOPE. Match fonts declared in the accepted mock; fall back to the project brand stack."
    : "OUT OF SCOPE for this accept — keep existing type unless required by another accepted feature."
}

${themeSection}
## Layout

${
  hasShell
    ? `IN SCOPE (applied_shell). Implement the structure and hierarchy shown in the accepted mock's applied frames (\`.slopcontrol/design-loops/${opts.loopId}/v${opts.version}/mock.html\`, also \`design/mock.html\`). Match header/nav/main/footer regions and spacing intent for those frames. Do not invent a competing shell.
${
  (opts.shellNotes ?? []).filter((s) =>
    /menubar|content-max|shell|nav\s*slot|inner bar/i.test(s),
  ).length
    ? `
### Shell layout contract (from accepted mock — implement + prove in Automated Checks)

${(opts.shellNotes ?? [])
  .filter((s) => /menubar|content-max|shell|nav\s*slot|inner bar|dashboard|theme toggle/i.test(s))
  .map((s) => `- ${s}`)
  .join("\n")}

File Changes must update the product Menubar (or equivalent shell) to match — e.g. centered inner bar at \`var(--content-max)\`, left logo+nav / right auth+theme — not only add a view-switcher prop. When shell notes distinguish landing vs dashboard: landing stays content-max; dashboard uses a full-viewport-width bar and a viewport-filling shell (\`min-height: calc(100vh - var(--bar-h))\`, sidebar + main like jamroast \`DashboardShell\`). Automated Checks must grep for \`--content-max\` (or equivalent) on the landing/menubar path and Menubar/JampressMenubar mount in playground App **or** product layout shell.
`
    : ""
}`
    : "OUT OF SCOPE (applied_shell not accepted). Do **not** rebuild portal/dashboard chrome from the mock frames. Brand/token/logo work may still proceed if those features are accepted."
}

## Logo brief

${
  hasLogo
    ? opts.pinnedLogo
      ? `IN SCOPE. The operator-pinned logo is \`${opts.pinnedLogo.name}\`${opts.pinnedLogo.label ? ` (${opts.pinnedLogo.label})` : ""} at \`${opts.pinnedLogo.path}\`. Copy THIS exact file into the product's static brand dir (e.g. \`public/brand/${opts.pinnedLogo.name}\`) and wire it as THE product logo — menubar \`logoSrc\`, favicon/app icons. Do NOT substitute older brand files, other logo variants from the assets, or tile+circle fallbacks. Automated Checks must grep the shell/layout for the pinned filename.`
      : "IN SCOPE. Follow mark/wordmark treatment in the mock when present; otherwise reuse sibling family craft (consumed `public/images/logo.svg`), not tile+circle fallbacks."
    : "OUT OF SCOPE for this accept — do not replace logo family unless required by another accepted feature."
}

## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| (from mock) | mock-reference.html | Accepted design-loop mock — implement fidelity for **accepted features only** |

## Accepted mock notes

${(opts.notes ?? "").trim() || "(none)"}

UI_SPEC_COMPLETE
`;
}

/**
 * Copy accepted mock into phase design/, write UI-SPEC + tokens, mark DESIGN_COMPLETE.
 * Does not edit product source.
 */
export function bindAcceptedDesignLoopToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): {
  meta: DesignLoopMeta;
  version: number;
  mockPath: string;
  uiSpecPath: string;
  inScope: string[];
  alreadyApplied: string[];
} {
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Design loop not found: ${opts.loopId}`);
  if (meta.status !== "accepted" && meta.status !== "implemented") {
    throw new Error(
      `Design loop must be accepted before implement (status=${meta.status})`,
    );
  }
  const version = meta.acceptedVersion ?? meta.currentVersion;
  const html = readDesignLoopMockHtml(opts.projectRoot, opts.loopId, version);
  if (!html?.trim()) {
    throw new Error(`Accepted mock missing for loop ${opts.loopId} v${version}`);
  }
  const notes =
    readDesignLoopNotes(opts.projectRoot, opts.loopId, version) ?? undefined;
  const acceptance = readDesignLoopAcceptance(opts.projectRoot, opts.loopId);
  if (!acceptance?.features?.length || countAcceptedFeatures(acceptance.features) < 1) {
    throw new Error(
      `Design loop ${opts.loopId} has no accepted features checklist — call design_loop_accept with at least one feature ticked`,
    );
  }

  const acceptedIds = acceptance.features
    .filter((f) => f.accepted)
    .map((f) => f.id);
  const { inScope, alreadyApplied } = resolveDesignImplementInScope({
    acceptedFeatureIds: acceptedIds,
    lastImplementedFeatureIds: meta.lastImplementedFeatureIds,
  });
  const inScopeSet = new Set(inScope);
  /** Phase checklist reflects implement delta (not preserved prior ticks). */
  const phaseAcceptance: DesignLoopAcceptance = {
    ...acceptance,
    features: acceptance.features.map((f) => ({
      ...f,
      accepted: inScopeSet.has(f.id),
    })),
  };

  const designDir = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "design",
  );
  mkdirSync(designDir, { recursive: true });
  const mockPath = join(designDir, "mock.html");
  writeFileSync(mockPath, `${html.trim()}\n`, "utf-8");
  writeFileSync(
    join(designDir, "ACCEPTANCE.json"),
    `${JSON.stringify(phaseAcceptance, null, 2)}\n`,
    "utf-8",
  );

  // Also keep a stable copy next to the loop ACCEPTED pointer
  const acceptedHtml = join(
    designLoopDir(opts.projectRoot, opts.loopId),
    "accepted-mock.html",
  );
  try {
    copyFileSync(
      join(
        designLoopVersionDir(opts.projectRoot, opts.loopId, version),
        "mock.html",
      ),
      acceptedHtml,
    );
  } catch {
    writeFileSync(acceptedHtml, `${html.trim()}\n`, "utf-8");
  }

  const {
    getDesignLoopScope,
    extractThemeContractFromHtml,
  } = requireDesignPack("./design-conceptual-model.js") as typeof import("./design-conceptual-model.js");
  const scope = getDesignLoopScope(meta);
  const request =
    readDesignLoopRequest(opts.projectRoot, opts.loopId, version) ?? meta.brief;
  const theme = extractThemeContractFromHtml(html, {
    request,
    notes,
  });
  const isExtensionImplement = Boolean(
    meta.lastImplementedVersion != null ||
      (meta.lastImplementedFeatureIds?.length ?? 0) > 0,
  );
  const uiSpecBrief = phaseDescriptionFromDesignAccept({
    request,
    briefFallback: meta.brief,
    inScopeIds: inScope,
    features: acceptance.features,
    isExtensionImplement,
  });
  let shellNotes: string[] = [];
  try {
    const { extractShellNotes } = requireDesignPack(
      "./design-pack.js",
    ) as typeof import("./design-pack.js");
    shellNotes = extractShellNotes(html, request, notes ?? "");
  } catch {
    shellNotes = [];
  }
  let pinnedLogo: { name: string; label?: string; path: string } | null = null;
  try {
    const { getDesignLoopSelections } = requireDesignPack(
      "./design-loop-selections.js",
    ) as typeof import("./design-loop-selections.js");
    const sel = getDesignLoopSelections(meta).find(
      (s) => s.slot === "logo" && s.asset,
    );
    if (sel?.asset) {
      pinnedLogo = {
        name: sel.asset,
        label: sel.label,
        path: `.slopcontrol/phases/${opts.phaseId}/design/assets/${sel.asset}`,
      };
    }
  } catch {
    pinnedLogo = null;
  }
  const uiSpec = uiSpecFromDesignLoopMock({
    brief: uiSpecBrief,
    loopId: opts.loopId,
    version,
    notes: notes ?? undefined,
    acceptance: phaseAcceptance,
    scope,
    theme: inScopeSet.has("theme_modes") ? theme : null,
    shellNotes,
    pinnedLogo,
  });
  const uiSpecFile = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "UI-SPEC.md",
  );
  mkdirSync(join(opts.projectRoot, SLOP_DIR, "phases", opts.phaseId), {
    recursive: true,
  });
  writeFileSync(uiSpecFile, uiSpec, "utf-8");
  // Dark :root + light [data-theme="light"] when present
  writeFileSync(
    join(designDir, "tokens.css"),
    extractTokensCssFromHtml(html),
    "utf-8",
  );
  writeFileSync(
    join(designDir, "STATUS.md"),
    `# Design status\n\nDESIGN_COMPLETE\n\nSource: design-loop ${opts.loopId} v${version}\n`,
    "utf-8",
  );

  // Copy loop assets (+ attribution) into phase design/assets/
  const loopAssets = join(
    designLoopDir(opts.projectRoot, opts.loopId),
    "assets",
  );
  const phaseAssets = join(designDir, "assets");
  if (existsSync(loopAssets)) {
    mkdirSync(phaseAssets, { recursive: true });
    for (const name of readdirSync(loopAssets)) {
      if (name.startsWith(".")) continue;
      copyFileSync(join(loopAssets, name), join(phaseAssets, name));
    }
  }
  const reviewSrc = join(
    designLoopVersionDir(opts.projectRoot, opts.loopId, version),
    "REVIEW.md",
  );
  if (existsSync(reviewSrc)) {
    copyFileSync(reviewSrc, join(designDir, "LOOP-REVIEW.md"));
    const reviewBody = readFileSync(reviewSrc, "utf-8").trim();
    writeFileSync(
      uiSpecFile,
      `${readFileSync(uiSpecFile, "utf-8").trim()}\n\n## Design-loop vision review\n\n${reviewBody}\n`,
      "utf-8",
    );
  }

  try {
    const { copyDesignPackToPhase, compileAndWriteDesignPackOnAccept } =
      requireDesignPack("./design-pack.js") as typeof import("./design-pack.js");
    // Always recompile so extension accepts get delta inScope vs lastImplemented.
    compileAndWriteDesignPackOnAccept({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      version,
      acceptance,
    });
    copyDesignPackToPhase({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      phaseId: opts.phaseId,
    });
  } catch {
    /* bind still succeeds */
  }

  try {
    const { bindDesignElementsToPhase } = requireDesignPack(
      "./design-element.js",
    ) as typeof import("./design-element.js");
    bindDesignElementsToPhase({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      phaseId: opts.phaseId,
    });
  } catch {
    /* elements optional */
  }

  const shippedIds = [
    ...new Set([...(meta.lastImplementedFeatureIds ?? []), ...inScope]),
  ];
  const next: DesignLoopMeta = {
    ...meta,
    status: "implemented",
    phaseId: opts.phaseId,
    lastImplementedVersion: version,
    lastImplementedFeatureIds: shippedIds,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, next);

  return {
    meta: next,
    version,
    mockPath,
    uiSpecPath: uiSpecFile,
    inScope,
    alreadyApplied,
  };
}
