import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";

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
  "data",
  "data-test",
  "data-test-chat",
  "test-data",
]);

const MUST_READ_CANDIDATES = [
  "package.json",
  "Dockerfile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".env.example",
  ".env.docker.example",
  "drizzle.config.ts",
  "drizzle.config.js",
  "vercel.json",
  "AGENTS.md",
  "README.md",
  "BLUEPRINT.md",
  "PHASE.md",
  "src/lib/db/schema.ts",
  "src/mastra/index.ts",
  "src/lib/chat-tools.ts",
  "src/lib/store.ts",
  "src/lib/skills.ts",
  "src/app/api/chat/route.ts",
];

export interface ProjectInventory {
  rootPath: string;
  topLevel: string[];
  treePaths: string[];
  mustReadPresent: string[];
  mustReadMissing: string[];
  packageSummary: string | null;
  apiRoutes: string[];
  pages: string[];
  dockerFiles: string[];
  sqlFiles: string[];
  /** Compact markdown for injection into agent prompts */
  markdown: string;
}

function safeRead(path: string, maxChars = 4000): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf-8").slice(0, maxChars);
  } catch {
    return null;
  }
}

function walkTree(
  root: string,
  dir: string,
  out: string[],
  maxFiles: number,
): void {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.name === ".DS_Store") continue;

    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      walkTree(root, full, out, maxFiles);
      continue;
    }
    if (entry.isFile()) {
      out.push(rel);
    }
  }
}

function summarizePackageJson(projectRoot: string): string | null {
  const raw = safeRead(join(projectRoot, "package.json"), 20_000);
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw) as {
      name?: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const scripts = Object.keys(pkg.scripts ?? {});
    const deps = Object.keys(pkg.dependencies ?? {});
    const devDeps = Object.keys(pkg.devDependencies ?? {});
    return [
      `name: ${pkg.name ?? "(unnamed)"}`,
      `scripts (${scripts.length}): ${scripts.join(", ") || "(none)"}`,
      `dependencies (${deps.length}): ${deps.join(", ") || "(none)"}`,
      `devDependencies (${devDeps.length}): ${devDeps.join(", ") || "(none)"}`,
    ].join("\n");
  } catch {
    return raw.slice(0, 1500);
  }
}

function collectByPattern(
  treePaths: string[],
  test: (rel: string) => boolean,
): string[] {
  return treePaths.filter((p) => !p.endsWith("/") && test(p)).sort();
}

/**
 * Deterministic project inventory for reverse-engineering BLUEPRINT.md.
 * Skips node_modules/.git/.next/etc. Caps tree size for prompt injection.
 */
export function buildProjectInventory(
  projectRoot: string,
  opts?: { maxTreePaths?: number },
): ProjectInventory {
  const maxTreePaths = opts?.maxTreePaths ?? 400;
  const topLevel: string[] = [];
  if (existsSync(projectRoot)) {
    try {
      for (const name of readdirSync(projectRoot).sort()) {
        if (SKIP_DIRS.has(name) && name !== ".slopcontrol") continue;
        const full = join(projectRoot, name);
        try {
          topLevel.push(statSync(full).isDirectory() ? `${name}/` : name);
        } catch {
          topLevel.push(name);
        }
      }
    } catch {
      /* ignore */
    }
  }

  const treePaths: string[] = [];
  walkTree(projectRoot, projectRoot, treePaths, maxTreePaths);

  const mustReadPresent: string[] = [];
  const mustReadMissing: string[] = [];
  for (const candidate of MUST_READ_CANDIDATES) {
    if (existsSync(join(projectRoot, candidate))) {
      mustReadPresent.push(candidate);
    } else {
      mustReadMissing.push(candidate);
    }
  }

  // Also pick up docker/**/*.sql and any Dockerfile*
  for (const rel of treePaths) {
    if (rel.endsWith("/")) continue;
    if (/^docker\/.+\.sql$/i.test(rel) || /Dockerfile/i.test(rel)) {
      if (!mustReadPresent.includes(rel)) mustReadPresent.push(rel);
    }
  }

  const apiRoutes = collectByPattern(
    treePaths,
    (p) =>
      /\/api\/.+\/route\.(ts|js|tsx|jsx)$/i.test(p) ||
      /^src\/app\/api\/.+\/route\.(ts|js)$/i.test(p) ||
      /^app\/api\/.+\/route\.(ts|js)$/i.test(p),
  );
  const pages = collectByPattern(
    treePaths,
    (p) =>
      /(^|\/)page\.(tsx|jsx|ts|js)$/i.test(p) &&
      !p.includes("node_modules") &&
      !p.includes("/api/"),
  );
  const dockerFiles = collectByPattern(
    treePaths,
    (p) =>
      /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/i.test(p) ||
      /^docker\//i.test(p),
  );
  const sqlFiles = collectByPattern(treePaths, (p) => /\.sql$/i.test(p));

  const packageSummary = summarizePackageJson(projectRoot);

  const treePreview = treePaths.slice(0, maxTreePaths).join("\n");
  const truncated = treePaths.length >= maxTreePaths;

  const markdown = [
    `# Project inventory (deterministic)`,
    ``,
    `Root: ${projectRoot}`,
    ``,
    `## Top-level`,
    topLevel.map((t) => `- ${t}`).join("\n") || "- (empty)",
    ``,
    `## package.json summary`,
    packageSummary ?? "(no package.json)",
    ``,
    `## Must-read files present (open these with read_file before writing BLUEPRINT)`,
    mustReadPresent.map((p) => `- ${p}`).join("\n") || "- (none)",
    ``,
    `## Must-read candidates missing`,
    mustReadMissing
      .filter((p) => !p.includes("/")) // only show top-level misses to keep short
      .map((p) => `- ${p}`)
      .join("\n") || "- (none notable)",
    ``,
    `## Docker / infra files`,
    dockerFiles.map((p) => `- ${p}`).join("\n") || "- (none found)",
    ``,
    `## SQL files`,
    sqlFiles.map((p) => `- ${p}`).join("\n") || "- (none found)",
    ``,
    `## API routes`,
    apiRoutes.map((p) => `- ${p}`).join("\n") || "- (none found)",
    ``,
    `## App pages`,
    pages.map((p) => `- ${p}`).join("\n") || "- (none found)",
    ``,
    `## File tree (partial${truncated ? ", truncated" : ""})`,
    "```",
    treePreview || "(empty)",
    "```",
  ].join("\n");

  return {
    rootPath: projectRoot,
    topLevel,
    treePaths,
    mustReadPresent,
    mustReadMissing,
    packageSummary,
    apiRoutes,
    pages,
    dockerFiles,
    sqlFiles,
    markdown,
  };
}

/**
 * Discover shell/chrome component files for mount-check generation.
 * Generic: any project layout works (JamPress finds jampress-menubar.tsx;
 * other projects find whatever they have). Capped for prompt safety.
 */
export function discoverShellComponentPaths(
  projectRoot: string,
  opts?: { maxPaths?: number },
): string[] {
  const { treePaths } = buildProjectInventory(projectRoot);
  const shell = treePaths.filter(
    (p) =>
      !p.endsWith("/") &&
      /\.(tsx?|jsx?|css)$/.test(p) &&
      /menubar|menu-bar|navbar|nav-bar|topbar|top-bar|shell|header|layout/i.test(
        p,
      ),
  );
  const appShell = treePaths.filter(
    (p) =>
      /^(playground\/src\/App\.|src\/App\.|src\/app\/layout\.)/i.test(p),
  );
  const globalsCss = treePaths.filter((p) =>
    /^(src\/app\/globals\.css|src\/index\.css|playground\/src\/index\.css)$/i.test(
      p,
    ),
  );
  const out = [...new Set([...shell, ...appShell, ...globalsCss])].sort();
  return out.slice(0, opts?.maxPaths ?? 12);
}

/**
 * Discover text-bearing wordmarks under public/brand (for stale-wordmark
 * rejection checks). Returns the visible text contents found in SVGs.
 */
export function discoverBrandWordmarkTexts(
  projectRoot: string,
  opts?: { maxTexts?: number },
): string[] {
  const brandDir = join(projectRoot, "public", "brand");
  if (!existsSync(brandDir)) return [];
  const out = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || out.size >= (opts?.maxTexts ?? 8)) return;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      try {
        if (statSync(full).isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
      } catch {
        continue;
      }
      if (!/\.svg$/i.test(name)) continue;
      try {
        const body = readFileSync(full, "utf-8").slice(0, 20_000);
        for (const m of body.matchAll(/>([A-Z][A-Za-z]{2,24})</g)) {
          out.add(m[1]!);
        }
      } catch {
        /* ignore */
      }
    }
  };
  walk(brandDir, 0);
  return [...out];
}
