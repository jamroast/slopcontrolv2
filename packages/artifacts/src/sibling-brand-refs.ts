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

function collectConsumedLogoHints(siblingRoot: string): string[] {
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

function preferAuthoritativeLogos(
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

/**
 * Build a research prompt block for sibling brand references named in the
 * operator ask (and optional family siblings like burntjam).
 */
export function buildSiblingBrandRefPack(opts: {
  projectRoot: string;
  description: string;
  /** Extra sibling directory names under the same parent as projectRoot. */
  familySiblingNames?: string[];
}): string {
  const family = opts.familySiblingNames ?? ["burntjam", "basic-web-agent"];
  const roots = new Set<string>(extractSiblingProjectPaths(opts.description));
  const parent = dirname(opts.projectRoot);
  for (const name of family) {
    const candidate = join(parent, name);
    if (existsSync(candidate) && candidate !== opts.projectRoot) {
      // Only auto-add family siblings when description mentions brand/theming
      // or names the sibling / JamPress / jam family.
      const d = opts.description;
      if (
        /them(?:e|ing)|brand|logo|jampress|jam\s*roast|burntjam|basic-web-agent/i.test(
          d,
        )
      ) {
        roots.add(candidate);
      }
    }
  }

  if (roots.size === 0) return "";

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
    const tokensCandidates = [
      join(root, "src", "app", "globals.css"),
      join(root, "public", "brand", "tokens.css"),
      join(root, "src", "app", "tokens.css"),
    ].filter((p) => existsSync(p));

    blocks.push(`### Sibling: \`${basename(root)}\` (\`${root}\`)`);
    if (logos.length) {
      blocks.push("Authoritative logo files:");
      for (const p of logos) {
        blocks.push(`- \`${p}\``);
      }
    } else {
      blocks.push("- (no authoritative logo path resolved — inspect Header yourself)");
    }
    const fallbacks = [
      join(root, "public", "brand", "jampress-logo-reuse.svg"),
      join(root, "public", "brand", "jampress-mark-reuse.svg"),
    ].filter((p) => existsSync(p));
    if (fallbacks.length) {
      blocks.push("Non-authoritative fallbacks (ignore as mark reference):");
      for (const p of fallbacks) blocks.push(`- \`${p}\``);
    }
    if (tokensCandidates.length) {
      blocks.push("Token / theme sources:");
      for (const p of tokensCandidates) blocks.push(`- \`${p}\``);
    }
    blocks.push("");
  }

  return blocks.join("\n");
}
