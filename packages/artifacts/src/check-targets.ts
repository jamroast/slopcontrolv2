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

import { existsSync } from "node:fs";
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
