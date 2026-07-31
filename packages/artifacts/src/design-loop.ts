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

export function acceptDesignLoop(
  projectRoot: string,
  loopId: string,
  version?: number,
): DesignLoopMeta {
  const meta = readDesignLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Design loop not found: ${loopId}`);
  if (meta.status === "implemented") {
    throw new Error(`Design loop already implemented: ${loopId}`);
  }
  const v = version ?? meta.currentVersion;
  const html = readDesignLoopMockHtml(projectRoot, loopId, v);
  if (!html?.trim()) {
    throw new Error(`Design loop version v${v} has no mock.html`);
  }
  writeFileSync(designLoopAcceptedPath(projectRoot, loopId), `v${v}\n`, "utf-8");
  const next: DesignLoopMeta = {
    ...meta,
    status: "accepted",
    acceptedVersion: v,
    updatedAt: new Date().toISOString(),
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

/** Seed UI-SPEC.md from an accepted design-loop mock. */
export function uiSpecFromDesignLoopMock(opts: {
  brief: string;
  loopId: string;
  version: number;
  notes?: string;
}): string {
  return `# UI-SPEC

**Source:** design loop \`${opts.loopId}\` v${opts.version} (accepted mock)
**Brief:** ${opts.brief.trim()}

## Palette

Derived from the accepted mock HTML (inline CSS \`:root\` tokens). Prefer those hex values in product tokens.

## Typography

Match fonts declared in the accepted mock; fall back to the project brand stack.

## Layout

Implement the structure and hierarchy shown in \`.slopcontrol/design-loops/${opts.loopId}/v${opts.version}/mock.html\` (also copied to \`design/mock.html\` for this phase).
Do not invent a competing shell. Match header/nav/main/footer regions and spacing intent.

## Logo brief

Follow mark/wordmark treatment in the mock when present; otherwise reuse sibling family craft (consumed \`public/images/logo.svg\`), not tile+circle fallbacks.

## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| (from mock) | mock-reference.html | Accepted design-loop mock — implement fidelity, do not regenerate from scratch |

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
