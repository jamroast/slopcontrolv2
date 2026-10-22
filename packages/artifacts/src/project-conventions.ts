/**
 * Project verification conventions — the project's OWN declared contract
 * (its AGENTS.md / CONTRIBUTING docs and CI check commands), extracted
 * verbatim into .slopcontrol/CONVENTIONS.md at onboarding / configure time
 * and cited generically by planning prompts as "the project's declared
 * conventions". SlopControl never hardcodes any estate's vocabulary here:
 * everything in the artifact is quoted from the project's own files.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** Convention source docs, in priority order (first present wins per slot). */
const CONVENTION_SOURCE_DOCS = [
  "AGENTS.md",
  "CONTRIBUTING.md",
  join(".github", "CONTRIBUTING.md"),
  join("docs", "CONTRIBUTING.md"),
];

const MAX_DOC_CHARS = 6_000;
const MAX_WORKFLOW_FILES = 4;
const MAX_CI_COMMANDS = 20;
const PROMPT_BLOCK_MAX_CHARS = 4_000;

export interface ProjectConventions {
  /** Relative paths of the files the conventions were extracted from. */
  sources: string[];
  /** Verbatim excerpts of the declared-convention docs (capped). */
  docExcerpts: Array<{ path: string; excerpt: string }>;
  /** `run:` commands quoted from CI workflows (deduped, order preserved). */
  ciCheckCommands: string[];
}

function readCapped(path: string, maxChars: number): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const body = readFileSync(path, "utf-8");
    return body.length > maxChars
      ? `${body.slice(0, maxChars)}\n…(truncated)`
      : body;
  } catch {
    return null;
  }
}

/**
 * Structural extraction of `run:` commands from a GitHub workflow body
 * (inline `run: cmd` and `run: |` / `run: >` block scalars). This is YAML
 * line-shape extraction, not classification — no judgment applied.
 */
export function extractWorkflowRunCommands(body: string): string[] {
  const commands: string[] = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^(\s*)-?\s*run:\s*([|>])?\s*(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1]!.length;
    const blockScalar = m[2];
    const inline = m[3]!.trim();
    if (!blockScalar && inline) {
      commands.push(inline);
      continue;
    }
    if (blockScalar) {
      const blockLines: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j]!;
        if (next.trim() === "") {
          blockLines.push("");
          continue;
        }
        const nextIndent = next.length - next.trimStart().length;
        if (nextIndent <= indent) break;
        blockLines.push(next.trim());
        i = j;
      }
      const joined = blockLines
        .filter((l) => l && !l.startsWith("#"))
        .join(blockScalar === ">" ? " " : " && ");
      if (joined) commands.push(joined);
    }
  }
  return commands;
}

/**
 * Collect the project's declared conventions. Returns null when the project
 * declares none (no convention docs and no CI run commands).
 */
export function collectProjectConventions(
  projectRoot: string,
): ProjectConventions | null {
  const sources: string[] = [];
  const docExcerpts: Array<{ path: string; excerpt: string }> = [];
  for (const rel of CONVENTION_SOURCE_DOCS) {
    const body = readCapped(join(projectRoot, rel), MAX_DOC_CHARS);
    if (body !== null && body.trim()) {
      sources.push(rel);
      docExcerpts.push({ path: rel, excerpt: body.trim() });
    }
  }

  const ciCheckCommands: string[] = [];
  const wfDir = join(projectRoot, ".github", "workflows");
  if (existsSync(wfDir)) {
    try {
      const workflows = readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .slice(0, MAX_WORKFLOW_FILES);
      for (const f of workflows) {
        const body = readCapped(join(wfDir, f), 40_000);
        if (body === null) continue;
        const cmds = extractWorkflowRunCommands(body);
        if (cmds.length > 0 && !sources.includes(`.github/workflows/${f}`)) {
          sources.push(`.github/workflows/${f}`);
        }
        for (const cmd of cmds) {
          if (
            ciCheckCommands.length < MAX_CI_COMMANDS &&
            !ciCheckCommands.includes(cmd)
          ) {
            ciCheckCommands.push(cmd);
          }
        }
      }
    } catch {
      /* workflows dir unreadable */
    }
  }

  if (docExcerpts.length === 0 && ciCheckCommands.length === 0) return null;
  return { sources, docExcerpts, ciCheckCommands };
}

export function projectConventionsPath(projectRoot: string): string {
  return join(projectRoot, ".slopcontrol", "CONVENTIONS.md");
}

/** Render the conventions artifact body (deterministic, verbatim quotes). */
export function renderProjectConventions(c: ProjectConventions): string {
  const parts: string[] = [
    "# Project verification conventions (declared)",
    "",
    "Extracted verbatim from the project's own files — follow these over any",
    "generic defaults when they declare a convention for the same thing.",
    `Sources: ${c.sources.join(", ")}`,
    "",
  ];
  for (const { path, excerpt } of c.docExcerpts) {
    parts.push(`## ${path} (verbatim)`, "", excerpt, "");
  }
  if (c.ciCheckCommands.length > 0) {
    parts.push("## CI check commands (quoted from workflows)", "");
    for (const cmd of c.ciCheckCommands) {
      parts.push(`- \`${cmd}\``);
    }
    parts.push("");
  }
  return `${parts.join("\n").trim()}\n`;
}

/**
 * Write .slopcontrol/CONVENTIONS.md from the project's declared conventions.
 * Returns the written path, or null when the project declares none (a stale
 * artifact is removed so prompts never cite vanished conventions).
 */
export function writeProjectConventions(projectRoot: string): string | null {
  const conventions = collectProjectConventions(projectRoot);
  const path = projectConventionsPath(projectRoot);
  if (!conventions) {
    try {
      unlinkSync(path);
    } catch {
      /* absent */
    }
    return null;
  }
  mkdirSync(join(projectRoot, ".slopcontrol"), { recursive: true });
  writeFileSync(path, renderProjectConventions(conventions), "utf-8");
  return path;
}

/**
 * Generic prompt citation block for planning agents. Empty when the project
 * declares no conventions — the block is phrased so it never names any
 * estate-specific vocabulary itself.
 */
export function readProjectConventionsPromptBlock(
  projectRoot: string,
  maxChars: number = PROMPT_BLOCK_MAX_CHARS,
): string {
  const body = readCapped(projectConventionsPath(projectRoot), maxChars);
  if (!body) return "";
  return [
    "The project's declared conventions (.slopcontrol/CONVENTIONS.md — extracted",
    "from its own AGENTS.md / CONTRIBUTING / CI config). When a declared",
    "convention covers how to build, test, or verify, follow it:",
    body.trim(),
  ].join("\n");
}
