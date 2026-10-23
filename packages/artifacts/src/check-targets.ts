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
 * Pattern shape per grep mode, from a soundness standpoint (plain substring
 * checks must never produce a wrong verdict):
 * - `literal` — the pattern is a pure fixed string in this mode, so
 *   `includes` is exact in both directions (found AND absent).
 * - `dot-only` — the only metacharacter is `.`, which self-matches at a
 *   verbatim occurrence: a found verdict is sound (the pattern matches the
 *   literal occurrence), but an absent verdict is not (the dot could match a
 *   different char) — verify found-only.
 * - `engine` — structural metacharacters (classes, anchors, quantifiers,
 *   groups, alternation, escapes) need a real regex engine — skip.
 *
 * BRE (plain `grep -q`) treats `(){}+?|` as literal, so
 * `grep -q 'isReadyMessage(event.data)'` is verifiable; ERE (`-E`) and
 * escaped forms stay skipped. `-F` is always literal.
 */
type GrepPatternShape = "literal" | "dot-only" | "engine";

function grepPatternShape(
  pattern: string,
  mode: "fixed" | "bre" | "ere",
): GrepPatternShape {
  if (mode === "fixed") return "literal";
  const structural =
    mode === "ere" ? /[|^$*+?(){}[\]\\]/ : /[*[\]^$\\]/;
  if (structural.test(pattern)) return "engine";
  return pattern.includes(".") ? "dot-only" : "literal";
}

/**
 * Deterministic grep-token verification: for each `grep -q '<literal>' <path>`
 * (or `grep -rq`) in a shell fence, check that the literal token actually
 * appears in the on-disk file. A token that does not is a no-op guard or a
 * speculative doc string — the check would fail at verify time.
 *
 * Only patterns whose shape a substring check can evaluate soundly are
 * verified (see grepPatternShape) — this stays structural.
 *
 * Files the phase declares in ## File Changes are exempt from mismatch
 * reporting: a grep asserting post-edit content legitimately does not match
 * the pre-development file yet. Mismatches stay reported for files the phase
 * does NOT touch — a token absent there is a speculative string the check
 * can never satisfy.
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
  // Declared paths (EDIT/NEW) — same prose/table section verifyCheckTargets
  // uses. A missing token in one of these is expected post-edit content.
  const fileChanges =
    (extractSection(phaseDoc, /^##\s+File Changes\s*$/im) ?? "").split(
      "```",
    )[0] ?? "";
  const isDeclared = (path: string): boolean =>
    path.length > 0 && fileChanges.includes(path);
  for (const fence of phaseDoc.matchAll(SHELL_FENCE_RE)) {
    const body = fence[1] ?? "";
    // grep -q / grep -rq with a quoted pattern and a target path. Single- and
    // double-quoted patterns are matched separately so a single-quoted pattern
    // may contain inner double quotes (e.g. grep -qF '"version": 2' file).
    // Flags are captured so pattern shape is judged per grep mode (BRE/ERE/-F).
    const re =
      /\bgrep\s+((?:-[A-Za-z]+\s+)*)(?:'([^']*)'|"([^"]*)")\s+([^\s;&|]+)/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(body)) !== null) {
      const flags = match[1] ?? "";
      const pattern = match[2] ?? match[3] ?? "";
      const path = (match[4] ?? "").replace(/^\.\//, "");
      if (!pattern || !path) continue;
      const mode = flags.includes("F")
        ? "fixed"
        : flags.includes("E")
          ? "ere"
          : "bre";
      const shape = grepPatternShape(pattern, mode);
      // Needs a real regex engine — skip rather than risk a wrong verdict.
      if (shape === "engine") continue;
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
      // Dot-only patterns: an absent verdict is unsound (the dot could match
      // a different char) — only positive grounding is reported for them.
      if (!found && shape === "dot-only") continue;
      // A missing token in a file this phase declares (EDIT/NEW) is expected
      // post-edit content, not a speculative string — the check runs after
      // the edit lands. Skip the mismatch; a PRESENT token still reports
      // found=true (positive grounding).
      if (!found && isDeclared(path)) continue;
      push(pattern, path, found);
    }
  }
  return results;
}

/**
 * Judge-facing block for grep tokens that DO appear verbatim in their target
 * file — the positive complement of the mismatch block. The judge only sees a
 * (possibly clipped) RESEARCH excerpt, so a disk-real token RESEARCH never
 * quoted looks "unverified" to it; this block grounds those tokens
 * deterministically, the token-level analogue of the `exists` path carve-out
 * in formatCheckTargetsPromptBlock. Empty when no token verified on disk —
 * unlisted tokens (NEW-file content, post-edit strings) stay fully within
 * the judge's discretion, keeping the gate fail-closed.
 */
export function formatVerifiedGrepTokensBlock(
  tokens: VerifiedGrepToken[],
  max = 40,
): string {
  const verified = tokens.filter((t) => t.found).slice(0, max);
  if (verified.length === 0) return "";
  const lines = verified.map((t) => `- \`${t.token}\` — ${t.path}`);
  return [
    "## Verified grep tokens (confirmed verbatim on disk by SlopControl)",
    ...lines,
    "",
    "These tokens are verified verbatim against the target repo file — treat them as grounded even when the RESEARCH excerpt does not quote them; do NOT fail them as unverified. Tokens not listed here were not verifiable on disk (e.g. NEW-file or post-edit content) — judge those on the remaining evidence.",
  ].join("\n");
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
