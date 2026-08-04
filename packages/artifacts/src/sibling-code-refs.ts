/**
 * Sibling codebase investigation pack for plan_loop (learn-from-X asks).
 * Read-only path inventory + short excerpts — does not write sibling trees.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { resolveShareAlias } from "./design-share.js";
import type { ListProjectsFn } from "./cross-project-catalog.js";

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
]);

const SIGNAL_NAME_RE =
  /chat|composer|message|tool|schema|agent|workflow|gather|prompt|ai-sdk|mastra/i;

const FAMILY_DIRS = [
  "burntjam",
  "basic-web-agent",
  "light-weight-crm-and-invoicing",
  "jamroast-components",
];

/** True when the brief asks to investigate siblings / learn from other apps. */
export function briefWantsSiblingInvestigation(text: string): boolean {
  const t = text ?? "";
  return (
    /\b(investigate|research\s+this|learn\s+from|look\s+at)\b/i.test(t) ||
    /\b(jampress|jamroast|jam\s*roast|jamlight|burntjam|basic-web-agent)\b/i.test(
      t,
    )
  );
}

function walkSignalFiles(
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
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Prefer descending into signal-named dirs first by always walking
      walkSignalFiles(root, full, out, maxFiles);
    } else if (entry.isFile()) {
      const rel = relative(root, full).replace(/\\/g, "/");
      if (
        SIGNAL_NAME_RE.test(rel) &&
        /\.(tsx?|jsx?|md)$/i.test(entry.name)
      ) {
        out.push(rel);
      }
    }
  }
}

function resolveSiblingRoots(opts: {
  targetRoot: string;
  brief: string;
  listProjects?: ListProjectsFn;
}): Array<{ name: string; rootPath: string }> {
  const found = new Map<string, { name: string; rootPath: string }>();
  const t = opts.brief ?? "";
  const parent = dirname(opts.targetRoot.replace(/\/$/, ""));
  const targetNorm = opts.targetRoot.replace(/\/$/, "");

  const add = (name: string, rootPath: string) => {
    const root = rootPath.replace(/\/$/, "");
    if (!root || root === targetNorm) return;
    if (!existsSync(root)) return;
    try {
      if (!statSync(root).isDirectory()) return;
    } catch {
      return;
    }
    const key = root.toLowerCase();
    if (!found.has(key)) found.set(key, { name, rootPath: root });
  };

  // Named aliases in prose
  const aliasHits =
    t.match(
      /\b(jampress|jam\s*roast|jamroast|jamlight|jam\s*light|burntjam)\b/gi,
    ) ?? [];
  for (const raw of aliasHits) {
    const alias = resolveShareAlias(raw.replace(/\s+/g, " ").trim());
    add(alias, join(parent, alias));
    // Also try registered project names
    for (const p of opts.listProjects?.() ?? []) {
      if (
        p.name.toLowerCase().includes(raw.toLowerCase().replace(/\s+/g, "")) ||
        basename(p.rootPath).toLowerCase() === alias.toLowerCase()
      ) {
        add(p.name, p.rootPath);
      }
    }
  }

  // Registered projects mentioned by name
  for (const p of opts.listProjects?.() ?? []) {
    const nameRe = new RegExp(
      `\\b${p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    );
    if (nameRe.test(t)) add(p.name, p.rootPath);
  }

  // Family scan when investigate language present
  if (briefWantsSiblingInvestigation(t)) {
    for (const dir of FAMILY_DIRS) {
      add(dir, join(parent, dir));
    }
  }

  return [...found.values()].slice(0, 3);
}

function excerptFile(absPath: string, maxChars: number): string {
  try {
    const body = readFileSync(absPath, "utf-8");
    const clipped =
      body.length <= maxChars
        ? body
        : `${body.slice(0, maxChars)}\n…[truncated]`;
    return clipped;
  } catch {
    return "";
  }
}

/**
 * Prompt block with absolute sibling roots + high-signal file excerpts.
 */
export function buildSiblingInvestigationPack(opts: {
  targetRoot: string;
  brief: string;
  listProjects?: ListProjectsFn;
  maxChars?: number;
  maxExcerptChars?: number;
}): string {
  if (!briefWantsSiblingInvestigation(opts.brief)) return "";

  const siblings = resolveSiblingRoots(opts);
  if (!siblings.length) return "";

  const maxTotal = opts.maxChars ?? 6_000;
  const maxExcerpt = opts.maxExcerptChars ?? 1_500;
  const lines: string[] = [
    "## SIBLING INVESTIGATION (authoritative for learn-from-X)",
    "",
    "CRITICAL: Cite these absolute paths in Likely areas / Approach. Use read_file with absolute paths before inventing architecture. Do not invent APIs that are not evidenced here.",
    "",
  ];

  for (const sib of siblings) {
    lines.push(`### ${sib.name}`);
    lines.push(`- root: \`${sib.rootPath}\``);
    const signals: string[] = [];
    walkSignalFiles(sib.rootPath, sib.rootPath, signals, 24);
    // Prefer shallower / chat-heavy paths
    signals.sort((a, b) => {
      const score = (p: string) =>
        ( /chat/i.test(p) ? 0 : 2) +
        ( /composer|tool|schema/i.test(p) ? 0 : 1) +
        p.split("/").length;
      return score(a) - score(b);
    });
    const pick = signals.slice(0, 4);
    if (!pick.length) {
      lines.push("- (no chat/tool/schema signal files found in shallow walk)");
      lines.push("");
      continue;
    }
    lines.push("- signal files:");
    for (const rel of pick) {
      lines.push(`  - \`${join(sib.rootPath, rel)}\``);
    }
    for (const rel of pick.slice(0, 2)) {
      const abs = join(sib.rootPath, rel);
      const body = excerptFile(abs, maxExcerpt);
      if (!body.trim()) continue;
      lines.push("");
      lines.push(`#### Excerpt: \`${rel}\``);
      lines.push("```");
      lines.push(body.trim());
      lines.push("```");
    }
    lines.push("");
  }

  const body = lines.join("\n");
  return body.length <= maxTotal
    ? body
    : `${body.slice(0, maxTotal)}\n…[truncated SIBLING INVESTIGATION]`;
}
