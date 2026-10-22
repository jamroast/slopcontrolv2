/**
 * Deterministic extraction + existence check for the repo paths that a
 * PHASE.md Automated Check references.
 *
 * The phase-quality judge only sees RESEARCH.md + the phase description, so a
 * check that targets a real file RESEARCH never named looks "unverified" to it
 * (fail closed) even though the drafter verified it with repo tools. Feeding
 * the judge an on-disk existence list keeps the real defects (missing files,
 * speculative doc strings, no-op guards) and drops the false ones.
 *
 * This is structural extraction (fenced shells + path-shaped tokens), not a
 * judgment/classification, so it stays deterministic.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { extractSection } from "./markdown.js";

export type VerifiedCheckTarget = {
  path: string;
  exists: boolean;
  /** Path is declared in ## File Changes, i.e. this phase creates it. */
  declared: boolean;
};

const SHELL_FENCE_RE = /```(?:bash|sh|shell|zsh)\b[^\n]*\n([\s\S]*?)```/gi;
const PATH_TOKEN_RE =
  /(?:^|[\s'"=(:,])((?:\.\/)?[A-Za-z0-9_@.-]+\/[A-Za-z0-9_@./-]*[A-Za-z0-9_@-]\.[A-Za-z0-9]{1,10})(?=$|[\s'"),;|&])/g;

const SKIP_PREFIXES = ["node_modules/", ".git/", "http", "https"];
const MAX_TARGETS = 40;

/** Unique repo-relative paths referenced inside bash/sh/shell fences. */
export function extractCheckTargetPaths(
  phaseDoc: string,
  max = MAX_TARGETS,
): string[] {
  const seen = new Set<string>();
  for (const fence of phaseDoc.matchAll(SHELL_FENCE_RE)) {
    const body = fence[1] ?? "";
    for (const m of body.matchAll(PATH_TOKEN_RE)) {
      let token = (m[1] ?? "").trim();
      if (!token) continue;
      if (token.startsWith("./")) token = token.slice(2);
      if (!token || token.startsWith("/") || token.startsWith("~")) continue;
      if (/[*?{}[\]$<>]/.test(token)) continue;
      if (SKIP_PREFIXES.some((p) => token.startsWith(p))) continue;
      if (token.includes("://")) continue;
      if (!token.includes("/")) continue;
      seen.add(token);
      if (seen.size >= max) return [...seen].sort();
    }
  }
  return [...seen].sort();
}

/** Extract + stat each target relative to the project root. */
export function verifyCheckTargets(
  projectRoot: string,
  phaseDoc: string,
): VerifiedCheckTarget[] {
  // Only the prose/table part of ## File Changes — a fenced block after the
  // section (unlikely, but possible in a compact doc) is not a declaration.
  const fileChanges =
    (extractSection(phaseDoc, /^##\s+File Changes\s*$/im) ?? "").split(
      "```",
    )[0] ?? "";
  return extractCheckTargetPaths(phaseDoc).map((path) => ({
    path,
    exists: existsSync(join(projectRoot, path)),
    declared: fileChanges.includes(path),
  }));
}

/**
 * Judge-facing block. Empty string when the doc references no repo paths, so
 * the judge prompt stays unchanged for docs without file checks.
 */
export function formatCheckTargetsPromptBlock(
  targets: VerifiedCheckTarget[],
): string {
  if (targets.length === 0) return "";
  const lines = targets.map((t) => {
    const status = t.exists ? "exists" : t.declared ? "NEW" : "MISSING";
    return `- ${status}: ${t.path}`;
  });
  return [
    "## Automated Check targets (verified by SlopControl against the repo)",
    ...lines,
    "",
    "A check that targets an `exists` path is grounded even when RESEARCH.md does not name it — do not fail it for being absent from the research excerpt. A `NEW` path is declared in ## File Changes, so this phase creates it — a check may assert it. A `MISSING` path is neither present nor declared — that is a real defect.",
  ].join("\n");
}

export type VerifiedGrepToken = {
  /** The literal string a `grep -q` asserts exists in the target file. */
  token: string;
  path: string;
  /** true when the token appears verbatim in the on-disk file. */
  found: boolean;
};

/**
 * Deterministic grep-token verification: for each `grep -q '<literal>' <path>`
 * (or `grep -rq`) in a shell fence, check that the literal token actually
 * appears in the on-disk file. A token that does not is a no-op guard or a
 * speculative doc string — the check would fail at verify time.
 *
 * Only single literal tokens are checked (no regex metacharacters or `|`
 * alternation, which need a real engine to evaluate) — this stays structural.
 */
export function verifyGrepTokens(
  projectRoot: string,
  phaseDoc: string,
  max = 60,
): VerifiedGrepToken[] {
  const results: VerifiedGrepToken[] = [];
  const push = (token: string, path: string, found: boolean) => {
    if (results.length >= max) return;
    results.push({ token, path, found });
  };
  for (const fence of phaseDoc.matchAll(SHELL_FENCE_RE)) {
    const body = fence[1] ?? "";
    // grep -q / grep -rq with a quoted pattern and a target path. Single- and
    // double-quoted patterns are matched separately so a single-quoted pattern
    // may contain inner double quotes (e.g. grep -qF '"version": 2' file).
    const re = /\bgrep\s+(?:-[A-Za-z]+\s+)*(?:'([^']*)'|"([^"]*)")\s+([^\s;&|]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const pattern = match[1] ?? match[2] ?? "";
      const path = (match[3] ?? "").replace(/^\.\//, "");
      if (!pattern || !path) continue;
      // Only literal tokens — skip regex metacharacters and alternation.
      if (/[|.^$*+?(){}[\]\\]/.test(pattern)) continue;
      if (path.startsWith("/") || path.startsWith("~") || path.includes("://")) {
        continue;
      }
      // Existence verdicts belong to verifyCheckTargets (which marks NEW vs
      // MISSING). A grep against a not-yet-created file (declared in File
      // Changes) is a legitimate check pattern — do NOT emit a false
      // "token absent" mismatch for it. Only verify tokens against files that
      // already exist on disk.
      let found = false;
      try {
        const abs = join(projectRoot, path);
        if (!existsSync(abs)) continue;
        found = readFileSync(abs, "utf8").includes(pattern);
      } catch {
        // Unreadable path — skip rather than report a false mismatch.
        continue;
      }
      push(pattern, path, found);
    }
  }
  return results;
}

/**
 * Judge-facing block for grep tokens that do NOT appear in their target file
 * (no-op guards / speculative doc strings). Empty when every literal token is
 * grounded.
 */
export function formatGrepTokenMismatchesBlock(
  tokens: VerifiedGrepToken[],
): string {
  const mismatches = tokens.filter((t) => !t.found);
  if (mismatches.length === 0) return "";
  const lines = mismatches.map(
    (t) => `- \`grep -q '${t.token}' ${t.path}\` — token not present on disk`,
  );
  return [
    "## Unverifiable grep tokens (token absent from its target file)",
    ...lines,
    "",
    "These are real defects — a no-op guard or a speculative doc string the check can never satisfy. Flag them as gaps and require a concrete token that actually exists in the file.",
  ].join("\n");
}
