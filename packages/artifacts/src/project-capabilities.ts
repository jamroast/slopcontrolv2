/**
 * Structural inventory of routes and files a project already has.
 * Used so a phase mustNot cannot forbid a capability that already exists.
 * Route literals are extracted as syntax, not classified.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { extractSection } from "./markdown.js";

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".slopcontrol",
  ".next",
  ".turbo",
]);

const SOURCE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|py|go)$/;

/** Structural: a route method call whose first argument is a path literal. */
const ROUTE_LITERAL =
  /\.(?:get|post|put|patch|delete|all|route)\(\s*['"`](\/[A-Za-z0-9._~:/#[\]@!$&()*+,;=%-]*)['"`]/g;

const FILE_ROOTS = ["docs", "public", "web/public", "static"] as const;

export type ProjectCapabilities = {
  routes: string[];
  files: string[];
};

export function collectProjectCapabilities(
  projectRoot: string,
  opts?: { maxRoutes?: number; maxFiles?: number; maxSourceFiles?: number },
): ProjectCapabilities {
  const maxRoutes = opts?.maxRoutes ?? 80;
  const maxFiles = opts?.maxFiles ?? 80;
  const maxSourceFiles = opts?.maxSourceFiles ?? 200;
  const routes = new Set<string>();
  const files: string[] = [];

  const sources: string[] = [];
  walkSources(projectRoot, projectRoot, sources, maxSourceFiles);
  for (const abs of sources) {
    if (routes.size >= maxRoutes) break;
    let text = "";
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    if (text.length > 200_000) text = text.slice(0, 200_000);
    ROUTE_LITERAL.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_LITERAL.exec(text)) && routes.size < maxRoutes) {
      const path = match[1]?.trim();
      if (path) routes.add(path);
    }
  }

  for (const rel of FILE_ROOTS) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    listFiles(abs, projectRoot, files, maxFiles);
    if (files.length >= maxFiles) break;
  }

  return {
    routes: [...routes].sort(),
    files: files.slice(0, maxFiles).sort(),
  };
}

function walkSources(
  root: string,
  dir: string,
  out: string[],
  max: number,
): void {
  if (out.length >= max) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= max) return;
    if (name.startsWith(".") && name !== ".") continue;
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSources(root, abs, out, max);
      continue;
    }
    if (SOURCE_EXT.test(name)) out.push(abs);
  }
}

function listFiles(
  dir: string,
  root: string,
  out: string[],
  max: number,
): void {
  if (out.length >= max) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= max) return;
    if (name.startsWith(".")) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listFiles(abs, root, out, max);
      continue;
    }
    out.push(relative(root, abs));
  }
}

export function formatProjectCapabilitiesPrompt(
  capabilities: ProjectCapabilities,
): string {
  if (!capabilities.routes.length && !capabilities.files.length) return "";
  const lines = [
    "PROJECT CAPABILITIES (already served — do not forbid them in mustNot or Out of scope):",
  ];
  if (capabilities.routes.length) {
    lines.push("Routes:");
    for (const route of capabilities.routes) lines.push(`- ${route}`);
  }
  if (capabilities.files.length) {
    lines.push("Files:");
    for (const file of capabilities.files) lines.push(`- ${file}`);
  }
  return lines.join("\n");
}

/** Out-of-scope / must-not bullets already written into a phase doc. */
export function mustNotCandidatesFromPhaseDoc(doc: string): string[] {
  const section =
    extractSection(doc, /^##\s+(?:Out of scope|Must not|Non-goals)\b/im) ?? "";
  if (!section.trim()) return [];
  const items: string[] = [];
  for (const raw of section.split("\n")) {
    const text = raw.replace(/^\s*[-*]\s+/, "").trim();
    if (!text || text.startsWith("#")) continue;
    items.push(text);
  }
  return items;
}

export function dropMustNotEntries(
  mustNot: string[],
  drop: readonly string[],
): string[] {
  const dropSet = new Set(drop.map((item) => item.trim()).filter(Boolean));
  return mustNot.filter((item) => !dropSet.has(item.trim()));
}

export function dropMustNotLinesFromPhaseDoc(
  doc: string,
  drop: readonly string[],
): string {
  const dropSet = new Set(drop.map((item) => item.trim()).filter(Boolean));
  if (!dropSet.size) return doc;
  return doc
    .split("\n")
    .filter((line) => {
      const text = line.replace(/^\s*[-*]\s+/, "").trim();
      return !dropSet.has(text) && !dropSet.has(line.trim());
    })
    .join("\n");
}
