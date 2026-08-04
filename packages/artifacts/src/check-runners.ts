import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSection } from "./markdown.js";
import {
  isIncompleteShellCompound,
  hasTrailingShellContinuation,
  joinShellContinuations,
} from "./shell-checks.js";

export type CheckCell = {
  /** Normalized language id (bash, zsh, javascript, typescript, …). */
  language: string;
  /** Full fence body — never split for execution. */
  body: string;
  meta?: Record<string, string>;
  source: "fence" | "bullet";
};

export type CheckRunContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type CheckRunResult = {
  exitCode: number;
  output: string;
};

export type CheckCommandRunner = (
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<CheckRunResult>;

export type CheckRunner = {
  id: string;
  languages: string[];
  validate?(cell: CheckCell): string[];
  run(cell: CheckCell, ctx: CheckRunContext): Promise<CheckRunResult>;
};

/** Runme-aligned language aliases → canonical id. */
const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  sh: "bash",
  shell: "bash",
  zsh: "zsh",
  javascript: "javascript",
  js: "javascript",
  jsx: "javascript",
  typescript: "typescript",
  ts: "typescript",
  tsx: "typescript",
};

const SHELL_LANGUAGES = new Set(["bash", "zsh"]);

export function normalizeCheckLanguage(raw: string | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (!key) return "bash";
  return LANGUAGE_ALIASES[key] ?? key;
}

export function isShellCheckLanguage(language: string): boolean {
  return SHELL_LANGUAGES.has(normalizeCheckLanguage(language));
}

/**
 * Parse fence info string: `bash`, `typescript`, `python cmd=python3`, `js cmd="node {file}"`.
 */
export function parseFenceInfo(info: string): {
  language: string;
  meta: Record<string, string>;
} {
  const trimmed = (info ?? "").trim();
  if (!trimmed) return { language: "bash", meta: {} };

  const meta: Record<string, string> = {};
  const tokens: string[] = [];
  const re = /([^\s="]+)=("([^"]*)"|'([^']*)'|(\S+))|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    if (m[1]) {
      meta[m[1]] = m[3] ?? m[4] ?? m[5] ?? "";
    } else if (m[6]) {
      tokens.push(m[6]);
    }
  }

  const language = normalizeCheckLanguage(tokens[0]);
  return { language, meta };
}

function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

async function runViaTempFile(
  runner: CheckCommandRunner,
  body: string,
  ext: string,
  commandFor: (file: string) => string,
  ctx: CheckRunContext,
): Promise<CheckRunResult> {
  const dir = mkdtempSync(join(tmpdir(), "slop-check-"));
  const file = join(dir, `check${ext}`);
  try {
    writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, "utf8");
    return await runner(commandFor(file), ctx.cwd, ctx.env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stripQuotedRegionsForShellValidation(s: string): string {
  // Strip single- and double-quoted / backtick regions (including multi-line)
  // so JS `for`/`if` inside `npx tsx -e "…"` does not look like shell compounds.
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += quote;
      i += 1;
      while (i < s.length) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === quote) {
          out += quote;
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Join `\` continuations in a fence body before validate/run heuristics. */
export function normalizeShellCheckBody(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  return joinShellContinuations(lines).join("\n");
}

/** Detect `echo "VAR=$?"` which prints but does not assign. */
export function hasEchoExitCodeCaptureAntipattern(body: string): boolean {
  return /echo\s+["'][A-Z_][A-Z0-9_]*=\$\?["']/i.test(body);
}

/** Detect `cd /absolute/path` that bypasses verify cwd. */
export function hasAbsoluteCdInCheck(body: string): boolean {
  // cd /Users/..., /home/..., /var/..., /tmp/..., /opt/..., or any cd /path
  return /(?:^|[\n;&|])\s*cd\s+(?:["'])?\/(?:Users|home|var|tmp|opt|root|private|[A-Za-z0-9._-]+)/im.test(
    body,
  );
}

/**
 * Strip leading `cd <cwd> &&` / `cd <cwd>;` so legacy absolute-path checks
 * still run relative to the verify cwd.
 */
export function stripRedundantCwdCd(body: string, cwd: string): string {
  const trimmedCwd = cwd.replace(/\/+$/, "");
  if (!trimmedCwd) return body;
  const escaped = trimmedCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(^|[\\n;&|])\\s*cd\\s+(?:["']${escaped}["']|${escaped})\\s*(?:&&|;|\\n)\\s*`,
    "g",
  );
  return body.replace(re, "$1");
}

/** Detect bare GNU `timeout` / `gtimeout` (not available on macOS by default). */
export function hasGnuTimeoutInCheck(body: string): boolean {
  // Match `timeout 8 …` / `timeout -- …` / `gtimeout 5 …` as a command (not a word in a comment about timeout)
  return /(?:^|[\n;&|])\s*(?:g?timeout)(?:\.exe)?\s+(?:--|\d)/im.test(body);
}

/** Detect long-lived server start commands that hang verify. */
export function hasLongLivedServerInCheck(body: string): boolean {
  if (/(?:^|[\n;&|])\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b/im.test(body)) {
    return true;
  }
  if (/(?:^|[\n;&|])\s*next\s+dev\b/im.test(body)) return true;
  if (/(?:^|[\n;&|])\s*nuxi?\s+dev\b/im.test(body)) return true;
  // bare `vite` / `vite …` but not `vite build`
  if (/(?:^|[\n;&|])\s*vite(?:\s|$)/im.test(body) && !/\bvite\s+build\b/im.test(body)) {
    return true;
  }
  // docker compose up without one-shot abort
  if (
    /\bdocker\s+compose\s+up\b/im.test(body) &&
    !/--abort-on-container-exit\b/im.test(body)
  ) {
    return true;
  }
  return false;
}

/** Background `&` plus `wait` — classic hang when children outlive kill. */
export function hasBackgroundWaitHangAntipattern(body: string): boolean {
  const hasBg = /&\s*(?:#.*)?$/m.test(body) || /&\s*\n/.test(body);
  const hasWait = /(?:^|[\n;&|])\s*wait\b/m.test(body);
  return hasBg && hasWait;
}

function shellValidate(cell: CheckCell): string[] {
  const issues: string[] = [];
  if (!cell.body.trim()) {
    issues.push("Empty Automated Check cell");
    return issues;
  }
  const normalized = normalizeShellCheckBody(cell.body);
  if (hasTrailingShellContinuation(normalized)) {
    issues.push(
      `Broken Automated Check ends with '\\' (line continuation was not joined). Put the full command on one line: ${normalized.slice(0, 120)}`,
    );
  }
  const forCompound = stripQuotedRegionsForShellValidation(normalized);
  if (isIncompleteShellCompound(forCompound)) {
    issues.push(
      `Broken Automated Check is an incomplete shell compound (e.g. \`if\` without \`fi\`). Use one complete fence with a closed if/fi (while/done) block: ${normalized.slice(0, 120)}`,
    );
  }
  if (hasEchoExitCodeCaptureAntipattern(normalized)) {
    issues.push(
      `Broken Automated Check uses \`echo "VAR=$?"\` which prints but does not assign. Prefer \`cmd || exit 1\` or \`VAR=$?\` then \`test "$VAR" -eq 0\`: ${normalized.slice(0, 120)}`,
    );
  }
  if (hasAbsoluteCdInCheck(normalized)) {
    issues.push(
      `Broken Automated Check uses absolute \`cd /…\` — checks already run in the verify cwd. Use relative commands (e.g. \`pnpm build || exit 1\`), not \`cd /Users/…\`: ${normalized.slice(0, 120)}`,
    );
  }
  if (hasGnuTimeoutInCheck(normalized)) {
    issues.push(
      `Broken Automated Check uses GNU \`timeout\`/\`gtimeout\`, which is not available on macOS by default. Prefer finite structural checks (grep/config asserts) — do not start long-lived servers: ${normalized.slice(0, 120)}`,
    );
  }
  if (hasLongLivedServerInCheck(normalized)) {
    issues.push(
      `Broken Automated Check starts a long-lived server (pnpm/npm/yarn/bun dev|start|serve, vite, next dev, docker compose up). Automated Checks must be finite — use structural asserts (grep alias/config) or a short Node one-shot: ${normalized.slice(0, 120)}`,
    );
  }
  if (hasBackgroundWaitHangAntipattern(normalized)) {
    issues.push(
      `Broken Automated Check backgrounds a process (\`&\`) and then \`wait\` — children often outlive kill and hang verify. Do not background servers in Automated Checks: ${normalized.slice(0, 120)}`,
    );
  }
  return issues;
}

export function createShellFamilyRunner(runner: CheckCommandRunner): CheckRunner {
  return {
    id: "shell",
    languages: ["bash", "zsh"],
    validate: shellValidate,
    async run(cell, ctx) {
      const lang = normalizeCheckLanguage(cell.language);
      const bin = lang === "zsh" ? "zsh" : "bash";
      const body = stripRedundantCwdCd(
        normalizeShellCheckBody(cell.body),
        ctx.cwd,
      );
      return runViaTempFile(
        runner,
        body,
        ".sh",
        (file) => `${bin} ${shellQuote(file)}`,
        ctx,
      );
    },
  };
}

export function createNodeFamilyRunner(runner: CheckCommandRunner): CheckRunner {
  return {
    id: "node",
    languages: ["javascript", "typescript"],
    validate(cell) {
      return cell.body.trim() ? [] : ["Empty Automated Check cell"];
    },
    async run(cell, ctx) {
      const lang = normalizeCheckLanguage(cell.language);
      if (lang === "typescript") {
        return runViaTempFile(
          runner,
          cell.body,
          ".ts",
          (file) => `npx --yes tsx ${shellQuote(file)}`,
          ctx,
        );
      }
      return runViaTempFile(
        runner,
        cell.body,
        ".js",
        (file) => `node ${shellQuote(file)}`,
        ctx,
      );
    },
  };
}

export function createMetaCmdRunner(runner: CheckCommandRunner): CheckRunner {
  return {
    id: "meta-cmd",
    languages: ["*"],
    validate(cell) {
      if (!cell.meta?.cmd?.trim()) {
        return [`No runner registered for language \`${cell.language}\` (add cmd=… meta or a supported fence tag)`];
      }
      return cell.body.trim() ? [] : ["Empty Automated Check cell"];
    },
    async run(cell, ctx) {
      const template = cell.meta?.cmd?.trim() ?? "";
      return runViaTempFile(
        runner,
        cell.body,
        ".check",
        (file) => {
          const quoted = shellQuote(file);
          if (template.includes("{file}")) {
            return template.replaceAll("{file}", quoted);
          }
          return `${template} ${quoted}`;
        },
        ctx,
      );
    },
  };
}

export type CheckRunnerRegistry = {
  resolve(cell: CheckCell): CheckRunner | null;
  validate(cell: CheckCell): string[];
  run(cell: CheckCell, ctx: CheckRunContext): Promise<CheckRunResult>;
};

export function createCheckRunnerRegistry(
  runners: CheckRunner[],
  fallback?: CheckRunner,
): CheckRunnerRegistry {
  const byLang = new Map<string, CheckRunner>();
  for (const r of runners) {
    for (const lang of r.languages) {
      if (lang === "*") continue;
      byLang.set(normalizeCheckLanguage(lang), r);
    }
  }

  return {
    resolve(cell) {
      if (cell.meta?.cmd?.trim() && fallback) return fallback;
      return byLang.get(normalizeCheckLanguage(cell.language)) ?? fallback ?? null;
    },
    validate(cell) {
      const runner = this.resolve(cell);
      if (!runner) {
        return [
          `No runner registered for language \`${cell.language}\` (use bash/zsh/js/ts or cmd=… meta)`,
        ];
      }
      return runner.validate?.(cell) ?? [];
    },
    async run(cell, ctx) {
      const runner = this.resolve(cell);
      if (!runner) {
        return {
          exitCode: 1,
          output: `No runner registered for language \`${cell.language}\``,
        };
      }
      return runner.run(cell, ctx);
    },
  };
}

export function createDefaultCheckRegistry(
  runner: CheckCommandRunner,
): CheckRunnerRegistry {
  const meta = createMetaCmdRunner(runner);
  return createCheckRunnerRegistry(
    [createShellFamilyRunner(runner), createNodeFamilyRunner(runner)],
    meta,
  );
}

const BULLET_CMD_RE = /^(npm|pnpm|yarn|npx|node|tsx|grep|test|\[|if)\b/;

/**
 * Extract Automated Checks as atomic cells (one fence = one cell).
 * Bullet lines are used only when no fences are present.
 */
export function extractCheckCells(phaseDoc: string): CheckCell[] {
  const section = extractSection(phaseDoc, /^##\s+Automated Checks\s*$/i);
  if (!section) return [];

  const cells: CheckCell[] = [];
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(section)) !== null) {
    const { language, meta } = parseFenceInfo(match[1] ?? "");
    const body = (match[2] ?? "").replace(/^\n+/, "").replace(/\n+$/, "");
    if (!body.trim()) continue;
    // Skip obvious non-check fences (json/yaml/text) unless cmd= is set
    if (
      /^(json|yaml|yml|text|markdown|md|diff|html|css)$/i.test(language) &&
      !meta.cmd
    ) {
      continue;
    }
    cells.push({
      language,
      body,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      source: "fence",
    });
  }

  if (cells.length > 0) return cells;

  for (const line of section.split("\n")) {
    const trimmed = line.replace(/^[-*]\s+/, "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (BULLET_CMD_RE.test(trimmed)) {
      cells.push({
        language: "bash",
        body: trimmed,
        source: "bullet",
      });
    }
  }

  return cells;
}

/** Display label for logs / step.command (first line of body). */
export function checkCellLabel(cell: CheckCell): string {
  const first = cell.body.split("\n").find((l) => l.trim() && !l.trim().startsWith("#"));
  const preview = (first ?? cell.body).trim().slice(0, 160);
  return cell.language === "bash"
    ? preview
    : `[${cell.language}] ${preview}`;
}
