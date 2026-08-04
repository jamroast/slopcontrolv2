import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const CONSUMED_LOGO_RE =
  /(?:src|href)=["']([^"']*\/(?:images\/logo[^"']*|brand\/(?![\w.-]*-reuse)[^"']*logo[^"']*))["']/gi;

const NEXT_IMAGE_LOGO_RE =
  /(?:src):\s*["']([^"']*(?:\/images\/logo[^"']*))["']/gi;

/** SlopControl design fallbacks — never treat as the sibling's real mark. */
export function isDesignFallbackBrandPath(path: string): boolean {
  const base = basename(path).toLowerCase();
  if (/-reuse\.svg$/i.test(base)) return true;
  try {
    if (existsSync(path) && statSync(path).size <= 400) {
      const body = readFileSync(path, "utf-8");
      if (
        /<circle\b/i.test(body) &&
        /<rect\b/i.test(body) &&
        /Status:\*\*\s*draft/i.test(body)
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Absolute or Projects-relative paths named in operator text. */
export function extractSiblingProjectPaths(description: string): string[] {
  const found = new Set<string>();
  const abs =
    description.match(
      /(?:^|[\s`"'(])(\/(?:Users|home|var)\/[^\s`"')]+)/g,
    ) ?? [];
  for (const raw of abs) {
    const p = raw.replace(/^[\s`"'(]+/, "").replace(/\/+$/, "");
    // Prefer project root: trim to …/Projects/<name>
    const m = p.match(/^(.+\/Projects\/[^/]+)/);
    found.add(m?.[1] ?? p);
  }
  return [...found];
}

export function collectConsumedLogoHints(siblingRoot: string): string[] {
  const hints = new Set<string>();
  const scanDirs = [
    join(siblingRoot, "src"),
    join(siblingRoot, "app"),
    join(siblingRoot, "components"),
  ];
  for (const dir of scanDirs) {
    if (!existsSync(dir)) continue;
    walkTsx(dir, (file, body) => {
      for (const re of [CONSUMED_LOGO_RE, NEXT_IMAGE_LOGO_RE]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
          const rel = m[1]?.replace(/^\//, "") ?? "";
          if (rel) hints.add(join(siblingRoot, "public", rel.replace(/^public\//, "")));
        }
      }
    });
  }
  return [...hints];
}

function walkTsx(
  dir: string,
  onFile: (path: string, body: string) => void,
  depth = 0,
): void {
  if (depth > 6) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name === "node_modules" || name === "dist") {
      continue;
    }
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkTsx(full, onFile, depth + 1);
    } else if (/\.(tsx?|jsx?)$/i.test(name)) {
      try {
        onFile(full, readFileSync(full, "utf-8"));
      } catch {
        /* ignore */
      }
    }
  }
}

export function preferAuthoritativeLogos(
  siblingRoot: string,
  consumed: string[],
): string[] {
  const preferred = [
    join(siblingRoot, "public", "images", "logo.svg"),
    join(siblingRoot, "public", "images", "logo-mark.svg"),
    join(siblingRoot, "public", "images", "logo-light.svg"),
  ].filter((p) => existsSync(p) && !isDesignFallbackBrandPath(p));

  const fromConsumed = consumed.filter(
    (p) => existsSync(p) && !isDesignFallbackBrandPath(p),
  );
  const merged = [...new Set([...fromConsumed, ...preferred])];
  return merged.slice(0, 6);
}

/** No built-in jam-family sibling dirs — callers may pass explicit names. */
export const DEFAULT_FAMILY_SIBLING_NAMES: string[] = [];

/** True when operator text asks about brand / theming / logo / landing. */
export function descriptionMentionsBrandTheming(description: string): boolean {
  return /them(?:e|ing)|brand|logo|content|landing/i.test(description ?? "");
}

export function projectTokenCandidates(root: string): string[] {
  return [
    join(root, "src", "app", "globals.css"),
    join(root, "public", "brand", "tokens.css"),
    join(root, "src", "app", "tokens.css"),
  ].filter((p) => existsSync(p));
}

/** Pull short landing copy from page.tsx / page.jsx for design-loop context. */
export function excerptLandingCopy(
  projectRoot: string,
  maxChars = 2_000,
): string {
  const candidates = [
    join(projectRoot, "src", "app", "page.tsx"),
    join(projectRoot, "src", "app", "page.jsx"),
    join(projectRoot, "app", "page.tsx"),
    join(projectRoot, "app", "page.jsx"),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, "utf-8");
      // Strip imports / JSX tags lightly; keep quoted marketing strings
      const strings = [...raw.matchAll(/["'`]([^"'`]{12,200})["'`]/g)]
        .map((m) => (m[1] ?? "").trim())
        .filter(
          (s) =>
            !/^(import|export|from|className|http|\/|#|\.|px-|flex|grid)/i.test(
              s,
            ) && /[a-zA-Z]{3,}/.test(s),
        );
      const body = strings.slice(0, 24).join("\n");
      if (!body.trim()) continue;
      if (body.length <= maxChars) return body;
      return `${body.slice(0, maxChars)}\n…[truncated landing copy]`;
    } catch {
      /* try next */
    }
  }
  return "";
}

/**
 * Brand pack for the **current** project (tokens, logos, landing copy).
 * Sibling pack alone skips projectRoot — design-loop needs this.
 */
export function buildProjectBrandRefPack(opts: {
  projectRoot: string;
  includeTokenExcerpts?: boolean;
  maxExcerptChars?: number;
  maxLandingChars?: number;
}): string {
  const root = opts.projectRoot;
  if (!existsSync(root)) return "";
  const maxExcerpt = opts.maxExcerptChars ?? 1_800;
  const consumed = collectConsumedLogoHints(root);
  const logos = preferAuthoritativeLogos(root, consumed);
  const tokensCandidates = projectTokenCandidates(root);
  const landing = excerptLandingCopy(root, opts.maxLandingChars ?? 2_000);

  if (!logos.length && !tokensCandidates.length && !landing) return "";

  const blocks: string[] = [
    "## This project brand (authoritative — match live site)",
    "",
    `Project root: \`${root}\``,
    "",
  ];
  if (logos.length) {
    blocks.push("Authoritative logo files:");
    for (const p of logos) blocks.push(`- \`${p}\``);
  } else {
    blocks.push("- (no authoritative logo path resolved)");
  }
  if (tokensCandidates.length) {
    blocks.push("Token / theme sources:");
    for (const p of tokensCandidates) blocks.push(`- \`${p}\``);
    if (opts.includeTokenExcerpts !== false) {
      for (const p of tokensCandidates.slice(0, 2)) {
        try {
          const raw = readFileSync(p, "utf-8");
          const excerpt = excerptCssTokens(raw, maxExcerpt);
          if (excerpt) {
            blocks.push(`Excerpt from \`${basename(p)}\`:`);
            blocks.push("```css");
            blocks.push(excerpt);
            blocks.push("```");
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  if (landing) {
    blocks.push("Landing / marketing copy cues (from page.tsx):");
    blocks.push("```");
    blocks.push(landing);
    blocks.push("```");
  }
  blocks.push("");
  return blocks.join("\n");
}

/**
 * Build a research prompt block for sibling brand references named in the
 * operator ask (absolute paths, literal sibling folder names, or optional
 * explicit familySiblingNames).
 */
export function buildSiblingBrandRefPack(opts: {
  projectRoot: string;
  description: string;
  /** Extra sibling directory names under the same parent as projectRoot. */
  familySiblingNames?: string[];
  /**
   * Inline CSS token excerpts so callers (design-loop) need not tool-walk siblings.
   * Default false for research prompts; design-loop should pass true.
   */
  includeTokenExcerpts?: boolean;
  /** Max chars per token file excerpt (default 1_800). */
  maxExcerptChars?: number;
}): string {
  const family = opts.familySiblingNames ?? DEFAULT_FAMILY_SIBLING_NAMES;
  const roots = new Set<string>(extractSiblingProjectPaths(opts.description));
  const parent = dirname(opts.projectRoot);
  const desc = opts.description ?? "";
  const theming = descriptionMentionsBrandTheming(desc);

  // Explicit familySiblingNames only (empty by default — no jam soft bias).
  for (const name of family) {
    const candidate = join(parent, name);
    if (
      existsSync(candidate) &&
      candidate !== opts.projectRoot &&
      theming
    ) {
      roots.add(candidate);
    }
  }

  // Literal sibling folder names mentioned in the brief.
  try {
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(".") || entry.length < 3) continue;
      const candidate = join(parent, entry);
      if (candidate === opts.projectRoot) continue;
      try {
        if (!statSync(candidate).isDirectory()) continue;
      } catch {
        continue;
      }
      const escaped = entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\b`, "i").test(desc)) {
        roots.add(candidate);
      }
    }
  } catch {
    /* ignore */
  }

  if (roots.size === 0) return "";

  const maxExcerpt = opts.maxExcerptChars ?? 1_800;
  const blocks: string[] = [
    "## Sibling brand references (authoritative — prefer consumed assets)",
    "",
    "Rules:",
    "- Logos the sibling **Header / shell actually mounts** (e.g. `public/images/logo.svg`) are authoritative.",
    "- Treat `public/brand/*-reuse.svg` and other tiny tile+circle stubs as **non-authoritative** SlopControl design fallbacks — do not model the mark after them.",
    "- Decide explicitly: **palette-only** vs **palette + shell/theme machinery** vs **full layout parity**. Do not silently freeze shells when the operator asked to apply theming.",
    "",
  ];

  for (const root of [...roots].sort()) {
    if (!existsSync(root) || root === opts.projectRoot) continue;
    const consumed = collectConsumedLogoHints(root);
    const logos = preferAuthoritativeLogos(root, consumed);
    const tokensCandidates = projectTokenCandidates(root);

    blocks.push(`### Sibling: \`${basename(root)}\` (\`${root}\`)`);
    if (logos.length) {
      blocks.push("Authoritative logo files:");
      for (const p of logos) {
        blocks.push(`- \`${p}\``);
      }
    } else {
      blocks.push("- (no authoritative logo path resolved — inspect Header yourself)");
    }
    const brandDir = join(root, "public", "brand");
    const fallbacks: string[] = [];
    if (existsSync(brandDir)) {
      try {
        for (const name of readdirSync(brandDir)) {
          if (!/-reuse\.svg$/i.test(name)) continue;
          const p = join(brandDir, name);
          if (isDesignFallbackBrandPath(p)) fallbacks.push(p);
        }
      } catch {
        /* ignore */
      }
    }
    if (fallbacks.length) {
      blocks.push("Non-authoritative fallbacks (ignore as mark reference):");
      for (const p of fallbacks) blocks.push(`- \`${p}\``);
    }
    if (tokensCandidates.length) {
      blocks.push("Token / theme sources:");
      for (const p of tokensCandidates) blocks.push(`- \`${p}\``);
      if (opts.includeTokenExcerpts) {
        for (const p of tokensCandidates.slice(0, 2)) {
          try {
            const raw = readFileSync(p, "utf-8");
            const excerpt = excerptCssTokens(raw, maxExcerpt);
            if (excerpt) {
              blocks.push(`Excerpt from \`${basename(p)}\`:`);
              blocks.push("```css");
              blocks.push(excerpt);
              blocks.push("```");
            }
          } catch {
            /* ignore */
          }
        }
      }
    }
    blocks.push("");
  }

  return blocks.join("\n");
}

/** Prefer :root / @theme blocks; otherwise head of the file. */
export function excerptCssTokens(css: string, maxChars: number): string {
  const trimmed = (css ?? "").trim();
  if (!trimmed) return "";
  const root = trimmed.match(/:root\s*\{[\s\S]*?\n\}/);
  const theme = trimmed.match(/@theme\b[\s\S]*?\{[\s\S]*?\n\}/);
  const dualBlocks = [
    ...trimmed.matchAll(/\.(?:dark|light)\s*\{[\s\S]*?\n\}/g),
    ...trimmed.matchAll(
      /(?:html)?\[data-theme\s*=\s*["'](?:dark|light)["']\]\s*\{[\s\S]*?\n\}/g,
    ),
  ].map((m) => m[0]);
  // Dedupe while preserving order
  const seen = new Set<string>();
  const uniqueDual: string[] = [];
  for (const b of dualBlocks) {
    if (seen.has(b)) continue;
    seen.add(b);
    uniqueDual.push(b);
  }
  const chunk =
    [root?.[0], theme?.[0], ...uniqueDual].filter(Boolean).join("\n\n") ||
    trimmed;
  if (chunk.length <= maxChars) return chunk;
  return `${chunk.slice(0, maxChars)}\n/* …truncated… */`;
}
