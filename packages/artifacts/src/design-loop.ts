import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  lastError?: DesignLoopLastError;
  createdAt: string;
  updatedAt: string;
};

export type DesignLoopVersionMeta = {
  version: number;
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

/** Stable fallbacks when mock has no parseable section labels. */
export const DESIGN_LOOP_FALLBACK_FEATURES: DesignLoopAcceptanceFeature[] = [
  { id: "palette", label: "Palette — sibling tokens", accepted: false },
  { id: "logo", label: "Logo / mark", accepted: false },
  { id: "type", label: "Typography", accepted: false },
  { id: "applied_shell", label: "Applied frames — shell / dashboard chrome", accepted: false },
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

/** Merge proposed features with prior ticks (preserve accepted when id matches). */
export function mergeAcceptanceFeatures(
  proposed: DesignLoopAcceptanceFeature[],
  prior?: DesignLoopAcceptanceFeature[] | null,
): DesignLoopAcceptanceFeature[] {
  const priorMap = new Map((prior ?? []).map((f) => [f.id, f.accepted]));
  const base =
    proposed.length > 0
      ? proposed
      : DESIGN_LOOP_FALLBACK_FEATURES.map((f) => ({ ...f }));
  const seen = new Set(base.map((f) => f.id));
  const merged = base.map((f) => ({
    ...f,
    accepted: priorMap.has(f.id) ? Boolean(priorMap.get(f.id)) : f.accepted,
  }));
  // Keep prior-only ids that were ticked (operator custom) when still relevant
  for (const f of prior ?? []) {
    if (seen.has(f.id)) continue;
    merged.push({ ...f });
  }
  // Ensure fallbacks exist when mock had partial sections
  for (const fb of DESIGN_LOOP_FALLBACK_FEATURES) {
    if (seen.has(fb.id)) continue;
    if (merged.some((x) => x.id === fb.id)) continue;
    merged.push({
      ...fb,
      accepted: priorMap.has(fb.id) ? Boolean(priorMap.get(fb.id)) : false,
    });
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
 * Preserves prior ticks by feature id.
 */
export function seedDesignLoopAcceptanceFromHtml(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  html: string;
}): DesignLoopAcceptance {
  const prior = readDesignLoopAcceptance(opts.projectRoot, opts.loopId);
  const extracted = extractFeaturesFromMockHtml(opts.html);
  const features = mergeAcceptanceFeatures(extracted, prior?.features);
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
): string {
  if (!acceptance?.features?.length) {
    return `Design-loop acceptance checklist: (missing — operator must accept features before implement)`;
  }
  const yes = acceptance.features.filter((f) => f.accepted);
  const no = acceptance.features.filter((f) => !f.accepted);
  const lines = [
    `Design-loop acceptance checklist (v${acceptance.version}${acceptance.acceptedAt ? `, accepted ${acceptance.acceptedAt}` : ""}):`,
    `IN SCOPE (must plan File Changes / Success Criteria / Automated Checks for each):`,
    ...(yes.length
      ? yes.map((f) => `- [x] ${f.id}: ${f.label}`)
      : ["- (none — invalid)"]),
    `OUT OF SCOPE (mustNot — do not expand into this phase):`,
    ...(no.length ? no.map((f) => `- [ ] ${f.id}: ${f.label}`) : ["- (none)"]),
  ];
  return lines.join("\n");
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
  writeFileSync(htmlPath, `${opts.html.trim()}\n`, "utf-8");
  writeFileSync(
    notesPath,
    `# Design loop v${opts.version}\n\n${(opts.notes ?? "").trim() || "(no notes)"}\n`,
    "utf-8",
  );
  if (opts.request !== undefined) {
    writeFileSync(requestPath, `${opts.request.trim()}\n`, "utf-8");
  }
  const versionMeta: DesignLoopVersionMeta = {
    version: opts.version,
    usedScaffold: Boolean(opts.usedScaffold),
    error: opts.error,
    updatedAt: new Date().toISOString(),
  };
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
}): DesignLoopMeta {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId: opts.projectId,
    brief: opts.brief.trim(),
    status: "open",
    phaseId: opts.phaseId,
    askId: opts.askId,
    currentVersion: 0,
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
export function extractTokensCssFromHtml(html: string): string {
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

/** Seed UI-SPEC.md from an accepted design-loop mock + feature checklist. */
export function uiSpecFromDesignLoopMock(opts: {
  brief: string;
  loopId: string;
  version: number;
  notes?: string;
  acceptance?: DesignLoopAcceptance | null;
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
  const hasLogo = accepted.some((f) => f.id === "logo");
  const hasShell = accepted.some((f) => f.id === "applied_shell");

  return `# UI-SPEC

**Source:** design loop \`${opts.loopId}\` v${opts.version} (accepted mock)
**Brief:** ${opts.brief.trim()}

## Accepted features

Implement **only** these checklist items (operator-accepted). Research/draft must turn each into Scope / File Changes / Success Criteria / Automated Checks.

${acceptedBlock}

## Out of scope

Do **not** expand this phase into:

${outBlock}

## Palette

${
  hasPalette
    ? "IN SCOPE. Derived from the accepted mock HTML (inline CSS `:root` tokens). Prefer those hex values in product tokens."
    : "OUT OF SCOPE for this accept — do not retune the full palette unless required by another accepted feature."
}

## Typography

${
  hasType
    ? "IN SCOPE. Match fonts declared in the accepted mock; fall back to the project brand stack."
    : "OUT OF SCOPE for this accept — keep existing type unless required by another accepted feature."
}

## Layout

${
  hasShell
    ? `IN SCOPE (applied_shell). Implement the structure and hierarchy shown in the accepted mock's applied frames (\`.slopcontrol/design-loops/${opts.loopId}/v${opts.version}/mock.html\`, also \`design/mock.html\`). Match header/nav/main/footer regions and spacing intent for those frames. Do not invent a competing shell.`
    : "OUT OF SCOPE (applied_shell not accepted). Do **not** rebuild portal/dashboard chrome from the mock frames. Brand/token/logo work may still proceed if those features are accepted."
}

## Logo brief

${
  hasLogo
    ? "IN SCOPE. Follow mark/wordmark treatment in the mock when present; otherwise reuse sibling family craft (consumed `public/images/logo.svg`), not tile+circle fallbacks."
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
    `${JSON.stringify(acceptance, null, 2)}\n`,
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

  const uiSpec = uiSpecFromDesignLoopMock({
    brief: meta.brief,
    loopId: opts.loopId,
    version,
    notes: notes ?? undefined,
    acceptance,
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

  const next: DesignLoopMeta = {
    ...meta,
    status: "implemented",
    phaseId: opts.phaseId,
    updatedAt: new Date().toISOString(),
  };
  writeDesignLoopMeta(opts.projectRoot, next);

  return {
    meta: next,
    version,
    mockPath,
    uiSpecPath: uiSpecFile,
  };
}
