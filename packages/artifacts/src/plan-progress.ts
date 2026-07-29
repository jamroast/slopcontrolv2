import { extractSection } from "./markdown.js";

export type PlanProgressResult = {
  ok: boolean;
  plannedPaths: string[];
  changedPaths: string[];
  covered: string[];
  missing: string[];
  unexpected: string[];
  /** True when many changes exist but almost none match the plan (derail). */
  offTrack: boolean;
  summary: string;
};

/**
 * Parse paths listed under PHASE.md ## File Changes.
 * Accepts bullets like `- path/to/file.ts` or `` `path` ``.
 */
export function extractPlannedFileChanges(phaseDoc: string): string[] {
  const section = extractSection(phaseDoc, "File Changes");
  if (!section) return [];

  const paths: string[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^tbd\b/i.test(trimmed)) continue;
    // Skip prose that isn't a path-ish bullet
    const bullet = trimmed.replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, "");
    const tick = bullet.match(/`([^`]+)`/);
    const candidate = (tick?.[1] ?? bullet.split(/\s+[—–-]\s+/)[0] ?? bullet)
      .trim()
      .replace(/^\*\*?|\*\*?$/g, "");

    if (!looksLikePath(candidate)) continue;
    paths.push(normalizePath(candidate));
  }
  return [...new Set(paths)];
}

function looksLikePath(s: string): boolean {
  if (!s || s.length < 3 || s.length > 240) return false;
  if (/\s/.test(s)) return false;
  if (/^(none|n\/a|tbd|todo|same as|see )/i.test(s)) return false;
  // Require a path separator or a real file extension — a lone "." in prose is not enough
  if (s.includes("/")) return true;
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|yml|yaml|toml|css|scss|txt|sh|env|example)$/i.test(
    s,
  );
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

function pathMatches(planned: string, changed: string): boolean {
  const a = normalizePath(planned).toLowerCase();
  const b = normalizePath(changed).toLowerCase();
  if (a === b) return true;
  if (b.endsWith("/" + a) || a.endsWith("/" + b)) return true;
  // Directory planned → any file under it
  if (a.endsWith("/") && b.startsWith(a)) return true;
  if (!a.includes(".") && (b.startsWith(a + "/") || b.includes("/" + a + "/"))) {
    return true;
  }
  // Basename match for short planned names
  const baseA = a.split("/").pop() ?? a;
  const baseB = b.split("/").pop() ?? b;
  if (baseA === baseB && baseA.includes(".")) return true;
  return false;
}

/**
 * Compare PHASE ## File Changes to actual changed files from the coding session / git.
 */
export function evaluatePlanProgress(
  phaseDoc: string,
  changedFiles: string[],
): PlanProgressResult {
  const plannedPaths = extractPlannedFileChanges(phaseDoc);
  const changedPaths = [
    ...new Set(changedFiles.map(normalizePath).filter(Boolean)),
  ];

  if (plannedPaths.length === 0) {
    return {
      ok: true,
      plannedPaths,
      changedPaths,
      covered: [],
      missing: [],
      unexpected: changedPaths,
      offTrack: false,
      summary:
        "No concrete paths under ## File Changes (TBD/empty) — plan-progress gate skipped.",
    };
  }

  const covered: string[] = [];
  const missing: string[] = [];
  for (const planned of plannedPaths) {
    if (changedPaths.some((c) => pathMatches(planned, c))) {
      covered.push(planned);
    } else {
      missing.push(planned);
    }
  }

  const unexpected = changedPaths.filter(
    (c) => !plannedPaths.some((p) => pathMatches(p, c)),
  );

  const coverage = covered.length / plannedPaths.length;
  // Off-track: substantial unrelated edits with little plan coverage
  const offTrack =
    changedPaths.length >= 5 &&
    coverage < 0.25 &&
    unexpected.length >= Math.max(3, covered.length * 2);

  const ok = !offTrack && (coverage >= 0.5 || changedPaths.length === 0);

  const summary = [
    `Plan progress: ${covered.length}/${plannedPaths.length} planned paths touched (${Math.round(coverage * 100)}%).`,
    missing.length ? `Missing: ${missing.slice(0, 8).join(", ")}` : null,
    unexpected.length
      ? `Unexpected: ${unexpected.slice(0, 8).join(", ")}`
      : null,
    offTrack
      ? "OFF-TRACK: many changes outside ## File Changes with low plan coverage."
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    ok,
    plannedPaths,
    changedPaths,
    covered,
    missing,
    unexpected,
    offTrack,
    summary,
  };
}

export function formatPlanProgressAppendix(result: PlanProgressResult): string {
  if (result.plannedPaths.length === 0) return "";
  return [
    "## Plan progress",
    "",
    result.summary,
    "",
    result.offTrack
      ? "Return to PHASE.md ## File Changes. Do not continue derailing into unrelated scripts or infra bring-up."
      : "Prefer completing missing planned paths before expanding scope.",
    "",
  ].join("\n");
}
