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

/**
 * `cd <dir>` tracking inside a fenced cell. Checks are written as scripts —
 * `cd packages/web && grep -q 'token' src/app.ts`, or a leading `cd` line
 * followed by commands — and every relative path after the `cd` resolves
 * against that dir, not the repo root. Resolving against the root marked
 * those real files MISSING and sent draft/judge into a regen loop (the
 * env-scoped-gates follow-up failure). Only plain relative dirs (no `..`,
 * no absolute/variable targets) are tracked; any other `cd` form resets
 * resolution to the repo root. Structural shell parsing, not a judgment.
 */
type CwdSegment = { from: number; dir: string };

const CD_STATEMENT_RE =
  /(?:^|\n|;|&&|\|\|)\s*cd\s+(?:'([^']+)'|"([^"]+)"|([^\s;&|]+))/g;

function cwdSegments(body: string): CwdSegment[] {
  const segs: CwdSegment[] = [{ from: 0, dir: "" }];
  for (const m of body.matchAll(CD_STATEMENT_RE)) {
    const dir = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\/+$/, "");
    const from = m.index + m[0].length;
    if (
      !dir ||
      dir.startsWith("/") ||
      dir.startsWith("~") ||
      dir.includes("..") ||
      dir.includes("$")
    ) {
      // Opaque target — fall back to repo-root resolution from here on.
      segs.push({ from, dir: "" });
    } else {
      segs.push({ from, dir });
    }
  }
  return segs;
}

function cwdAt(segs: CwdSegment[], pos: number): string {
  let dir = "";
  for (const s of segs) {
    if (s.from <= pos) dir = s.dir;
    else break;
  }
  return dir;
}

/** Resolve a fence-relative token against the tracked `cd` dir. */
function resolveAgainstCwd(token: string, cwd: string): string {
  if (!cwd) return token;
  if (token.startsWith("/") || token.startsWith("~")) return token;
  if (token === cwd || token.startsWith(`${cwd}/`)) return token;
  return `${cwd}/${token}`;
}

/** Unique repo-relative paths referenced inside bash/sh/shell fences. */
export function extractCheckTargetPaths(
  phaseDoc: string,
  max = MAX_TARGETS,
): string[] {
  const seen = new Set<string>();
  for (const fence of phaseDoc.matchAll(SHELL_FENCE_RE)) {
    const body = fence[1] ?? "";
    const segs = cwdSegments(body);
    for (const m of body.matchAll(PATH_TOKEN_RE)) {
      let token = (m[1] ?? "").trim();
      if (!token) continue;
      if (token.startsWith("./")) token = token.slice(2);
      if (!token || token.startsWith("/") || token.startsWith("~")) continue;
      if (/[*?{}[\]$<>]/.test(token)) continue;
      if (SKIP_PREFIXES.some((p) => token.startsWith(p))) continue;
      if (token.includes("://")) continue;
      if (!token.includes("/")) continue;
      token = resolveAgainstCwd(token, cwdAt(segs, m.index));
      seen.add(token);
      if (seen.size >= max) return [...seen].sort();
    }
  }
  return [...seen].sort();
}

/**
 * Prose/table text of ## File Changes with fenced contents stripped — fence
 * commands and mandated implementation snippets are not declarations — while
 * keeping the prose BETWEEN fences: items declared after the section's first
 * fence still count (truncating at the first fence silently undeclared them,
 * the phase-202 jamauth loop). extractSection bounds the section at the next
 * `##` heading.
 */
function fileChangesProse(phaseDoc: string): string {
  const section = extractSection(phaseDoc, /^##\s+File Changes\s*$/im) ?? "";
  return section
    .split("```")
    .filter((_, i) => i % 2 === 0)
    .join("\n");
}

/**
 * True when ## File Changes declares product/code paths (anything outside
 * `.slopcontrol/` planning artifacts). A phase that declares code changes
 * but ships zero Automated Check cells verifies green while proving
 * nothing — the "green suite that checks nothing" defect. Structural prose
 * extraction only; declaration content stays judged by the LLM gates.
 */
export function fileChangesDeclaresProductCode(phaseDoc: string): boolean {
  return fileChangesProse(phaseDoc)
    .split("\n")
    .map((l) => l.trim())
    .some(
      (l) =>
        /\b[A-Za-z0-9_][\w.-]*\/[\w./-]+\.\w{1,5}\b/.test(l) &&
        !l.includes(".slopcontrol") &&
        !l.includes("://"),
    );
}

/** Extract + stat each target relative to the project root. */
export function verifyCheckTargets(
  projectRoot: string,
  phaseDoc: string,
): VerifiedCheckTarget[] {
  const fileChanges = fileChangesProse(phaseDoc);
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
  // Declared paths (EDIT/NEW) — same fence-stripped prose verifyCheckTargets
  // uses. A missing token in one of these is expected post-edit content.
  const fileChanges = fileChangesProse(phaseDoc);
  const isDeclared = (path: string): boolean =>
    path.length > 0 && fileChanges.includes(path);
  for (const fence of phaseDoc.matchAll(SHELL_FENCE_RE)) {
    const body = fence[1] ?? "";
    const segs = cwdSegments(body);
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
      const path = resolveAgainstCwd(
        (match[4] ?? "").replace(/^\.\//, ""),
        cwdAt(segs, match.index),
      );
      if (!pattern || !path) continue;
      // Negated assertions (`! grep -q 'forbidden' file`) assert ABSENCE —
      // token existence is not their grounding question. Skip them entirely:
      // an absent token is the check's success condition, never a mismatch,
      // and a present one is for the check to catch at verify time.
      if (/![\s]*$/.test(body.slice(0, match.index))) continue;
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
 * Judge-facing block for grep tokens that are absent from their target file
 * but quoted verbatim in RESEARCH.md — new content the phase is mandated to
 * create (a new table/route/column/test string in an existing file). Absence
 * on disk is EXPECTED for these: the check runs after the edit lands. This is
 * the token-level analogue of the `NEW` path carve-out — without it the
 * judge fails exactly the tokens RESEARCH told the drafter to grep, and no
 * draft can ever pass (the phase-202 jamauth loop). Empty when researchText
 * is unavailable or no absent token is research-quoted.
 */
export function formatResearchMandatedTokensBlock(
  tokens: VerifiedGrepToken[],
  researchText: string,
  max = 40,
): string {
  if (!researchText) return "";
  const mandated = tokens
    .filter((t) => !t.found && researchText.includes(t.token))
    .slice(0, max);
  if (mandated.length === 0) return "";
  const lines = mandated.map((t) => `- \`${t.token}\` — ${t.path}`);
  return [
    "## Research-mandated new-content tokens (quoted in RESEARCH.md; absent on disk because the phase creates them)",
    ...lines,
    "",
    "RESEARCH.md quotes these exact literals as content this phase adds — absence on disk is expected (the check runs after the edit lands). Treat them as grounded: do NOT fail them as unverified, and do NOT demand a token that already exists in their place — that would make the check unable to prove the new content. If the target file is missing from ## File Changes, flag THAT as the gap, not the token.",
  ].join("\n");
}

/**
 * Judge-facing block for grep tokens that do NOT appear in their target file
 * and are NOT quoted in RESEARCH.md (when supplied) — the residual class
 * after disk-verified and research-mandated tokens are partitioned out.
 * Empty when every literal token is grounded. These keep the gate
 * fail-closed: a speculative string in a file the phase does not touch, or a
 * new-content token missing its grounding (RESEARCH quote / File Changes
 * declaration).
 */
export function formatGrepTokenMismatchesBlock(
  tokens: VerifiedGrepToken[],
  researchText = "",
): string {
  const mismatches = tokens.filter(
    (t) => !t.found && !(researchText && researchText.includes(t.token)),
  );
  if (mismatches.length === 0) return "";
  const lines = mismatches.map(
    (t) => `- \`grep -q '${t.token}' ${t.path}\` — token not present on disk`,
  );
  return [
    "## Unverifiable grep tokens (absent from the target file; not quoted in RESEARCH.md)",
    ...lines,
    "",
    "These tokens are neither on disk nor quoted in RESEARCH.md. Judge them on the evidence: a token that should already exist in a file this phase does not touch is a real defect (a no-op guard or speculative string the check can never satisfy). A token the phase intends to ADD is missing its grounding instead — RESEARCH.md must quote the exact literal and ## File Changes must declare the file. Flag the gap with the missing grounding; never ask the drafter to re-assert the flagged token unchanged, and never demand an on-disk token for content the phase creates.",
  ].join("\n");
}
