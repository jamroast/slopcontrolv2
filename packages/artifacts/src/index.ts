import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  PhaseStatusSchema,
  ProjectConfigSchema,
  type IterationMemoryEntry,
  type PhaseStatus,
  type ProjectConfig,
} from "@slopcontrol/types";
import {
  extractMarkdownDocument,
  extractSection,
  stripCompletionTokens,
} from "./markdown.js";
import { loadDotEnvFile } from "./dotenv.js";
import { redactSecrets } from "./redact-secrets.js";
import {
  readChangeIntent,
  reconcileBlueprintDecisions,
  extractLiveDecisions,
  changeIntentIsBrandTheming,
  changeIntentIsThemeWiringOnly,
  isNotApplicableDesignSection,
} from "./change-intent.js";
import type { ChangeIntent } from "./change-intent.js";
import { probeProjectForDecisions } from "./blueprint-probes.js";

export const SLOP_DIR = ".slopcontrol";

export * from "./markdown.js";
export * from "./project-empty.js";
export * from "./blueprint-contract.js";
export * from "./project-inventory.js";
export * from "./blueprint-fallback.js";
export * from "./learnings.js";
export * from "./failure-classify.js";
export * from "./compose-teardown.js";
export * from "./change-intent.js";
export * from "./research-intent-reconcile.js";
export * from "./blueprint-probes.js";
export * from "./redact-secrets.js";
export * from "./plan-progress.js";
export * from "./verify-preflight.js";
export * from "./llm-test-env.js";
export * from "./project-env.js";
export * from "./sibling-brand-refs.js";
export * from "./shell-checks.js";
export * from "./check-runners.js";
export * from "./claim-vs-proof.js";
export * from "./design-delivery.js";
export * from "./phase-complete-gate.js";
export * from "./development-handoff.js";
export * from "./ask-session.js";
export * from "./chat-task-description.js";
export * from "./agent-session.js";
export * from "./design-loop.js";
export * from "./design-pack.js";
export * from "./design-conceptual-model.js";
export * from "./design-loop-selections.js";
export * from "./design-loop-continue.js";
export * from "./design-loop-versions.js";
export * from "./live-site-inventory.js";
export * from "./screen-content.js";
export * from "./continue-intent.js";
export * from "./design-share.js";
export * from "./design-element.js";
export * from "./npm-registry.js";
export * from "./build-toolchain.js";
export * from "./test-services.js";
export * from "./build-process-config.js";
export * from "./verify-recovery-execute.js";
export * from "./verify-recovery-evidence.js";
export * from "./ci-workflows.js";
export * from "./library-propagate.js";
export * from "./workspace-package.js";
export * from "./cross-project-catalog.js";
export * from "./sibling-code-refs.js";
export * from "./plan-loop.js";
export * from "./plan-pack.js";
export * from "./plan-continue-intent.js";
export * from "./loop-chat.js";
export { loadDotEnvFile } from "./dotenv.js";

export function slopcontrolRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR);
}

export function ensureSlopcontrolDir(projectRoot: string): string {
  const root = slopcontrolRoot(projectRoot);
  mkdirSync(join(root, "phases"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });
  mkdirSync(join(root, "archive"), { recursive: true });
  mkdirSync(join(root, "learnings"), { recursive: true });
  mkdirSync(join(root, "asks"), { recursive: true });
  return root;
}

export function blueprintPath(projectRoot: string): string {
  return join(slopcontrolRoot(projectRoot), "BLUEPRINT.md");
}

export function roadmapPath(projectRoot: string): string {
  return join(slopcontrolRoot(projectRoot), "ROADMAP.md");
}

export function archiveDir(projectRoot: string): string {
  return join(slopcontrolRoot(projectRoot), "archive");
}

export function projectConfigPath(projectRoot: string): string {
  return join(slopcontrolRoot(projectRoot), "config.json");
}

export function phaseDir(projectRoot: string, phaseId: string): string {
  return join(slopcontrolRoot(projectRoot), "phases", phaseId);
}

export function phaseDocPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "PHASE.md");
}

export function researchPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "RESEARCH.md");
}

export function appendixPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "APPENDIX.md");
}

export function phaseStatusPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "status.json");
}

export function uiSpecPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "UI-SPEC.md");
}

export function designDir(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "design");
}

export function designStatusPath(projectRoot: string, phaseId: string): string {
  return join(designDir(projectRoot, phaseId), "STATUS.md");
}

export function tokensCssPath(projectRoot: string, phaseId: string): string {
  return join(designDir(projectRoot, phaseId), "tokens.css");
}

export function ensureDesignDir(projectRoot: string, phaseId: string): string {
  const dir = designDir(projectRoot, phaseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}


export function runDir(projectRoot: string, runId: string): string {
  return join(slopcontrolRoot(projectRoot), "runs", runId);
}

export function runLogPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "log.txt");
}

export function runMemoryPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "memory.json");
}

/** Slugify a description into a short filesystem-safe token. */
export function slugify(input: string, maxLen = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug || "phase";
}

export function formatPhaseId(ordinal: number, slug: string): string {
  return `${String(ordinal).padStart(2, "0")}-${slug}`;
}

/**
 * Scan existing phase directories for the next ordinal.
 * Accepts both `01-slug` and legacy UUID folder names (UUIDs do not bump ordinal).
 */
export function nextPhaseOrdinal(projectRoot: string): number {
  const phasesRoot = join(slopcontrolRoot(projectRoot), "phases");
  if (!existsSync(phasesRoot)) return 1;

  let max = 0;
  for (const name of readdirSync(phasesRoot)) {
    const match = /^(\d{2,})-/.exec(name);
    if (match) {
      max = Math.max(max, Number(match[1]));
    }
  }
  return max + 1;
}

/**
 * First meaningful content line of a phase description. Ask-derived
 * descriptions start with a "## Operator request" wrapper and may contain
 * markdown headings — skip those so titles and slugs reflect the actual ask.
 */
export function descriptionContentLine(
  description: string | undefined,
): string {
  const line = (description ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .filter((l) => !/^#+\s*operator request\s*$/i.test(l))
    .map((l) => l.replace(/^#+\s*/, ""))
    .find(Boolean);
  return (line ?? description ?? "").replace(/\s+/g, " ").trim();
}

export function allocatePhaseId(
  projectRoot: string,
  description: string,
): { id: string; ordinal: number; slug: string } {
  ensureSlopcontrolDir(projectRoot);
  const ordinal = nextPhaseOrdinal(projectRoot);
  const slug = slugify(descriptionContentLine(description));
  return { id: formatPhaseId(ordinal, slug), ordinal, slug };
}

export function readBlueprint(projectRoot: string): string {
  const path = blueprintPath(projectRoot);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeBlueprint(projectRoot: string, content: string): void {
  ensureSlopcontrolDir(projectRoot);
  writeFileSync(
    blueprintPath(projectRoot),
    extractMarkdownDocument(content) || content.trim(),
    "utf-8",
  );
}

export function appendBlueprint(projectRoot: string, delta: string): void {
  const existing = readBlueprint(projectRoot);
  const separator = existing.trim() ? "\n\n---\n\n" : "";
  writeBlueprint(projectRoot, `${existing}${separator}${delta}`);
}

/**
 * Archive current BLUEPRINT.md to `.slopcontrol/archive/BLUEPRINT-<iso>.md`.
 * Returns archive path, or null if no blueprint existed.
 */
export function archiveBlueprint(projectRoot: string): string | null {
  const path = blueprintPath(projectRoot);
  if (!existsSync(path)) return null;

  ensureSlopcontrolDir(projectRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(archiveDir(projectRoot), `BLUEPRINT-${stamp}.md`);
  renameSync(path, dest);
  return dest;
}

/**
 * Move planning artifacts into archive/reinit-<stamp>/ and recreate empty
 * phases/ + runs/ so ordinals restart at 01 (phase zero).
 * Preserves config.json. Archives BLUEPRINT.md and ROADMAP.md when present.
 */
export function resetProjectToPhaseZero(projectRoot: string): {
  archiveRoot: string;
  archivedBlueprint: boolean;
  archivedRoadmap: boolean;
  archivedPhaseDirs: number;
  archivedRunDirs: number;
} {
  ensureSlopcontrolDir(projectRoot);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveRoot = join(archiveDir(projectRoot), `reinit-${stamp}`);
  mkdirSync(archiveRoot, { recursive: true });

  let archivedBlueprint = false;
  let archivedRoadmap = false;
  let archivedPhaseDirs = 0;
  let archivedRunDirs = 0;

  const bp = blueprintPath(projectRoot);
  if (existsSync(bp)) {
    renameSync(bp, join(archiveRoot, "BLUEPRINT.md"));
    archivedBlueprint = true;
  }

  const rm = roadmapPath(projectRoot);
  if (existsSync(rm)) {
    renameSync(rm, join(archiveRoot, "ROADMAP.md"));
    archivedRoadmap = true;
  }

  const phasesRoot = join(slopcontrolRoot(projectRoot), "phases");
  const phasesArchive = join(archiveRoot, "phases");
  if (existsSync(phasesRoot)) {
    mkdirSync(phasesArchive, { recursive: true });
    for (const name of readdirSync(phasesRoot)) {
      renameSync(join(phasesRoot, name), join(phasesArchive, name));
      archivedPhaseDirs += 1;
    }
    // recreate empty phases dir
    rmSync(phasesRoot, { recursive: true, force: true });
  }
  mkdirSync(phasesRoot, { recursive: true });

  const runsRoot = join(slopcontrolRoot(projectRoot), "runs");
  const runsArchive = join(archiveRoot, "runs");
  if (existsSync(runsRoot)) {
    mkdirSync(runsArchive, { recursive: true });
    for (const name of readdirSync(runsRoot)) {
      renameSync(join(runsRoot, name), join(runsArchive, name));
      archivedRunDirs += 1;
    }
    rmSync(runsRoot, { recursive: true, force: true });
  }
  mkdirSync(runsRoot, { recursive: true });

  writeRoadmap(
    projectRoot,
    "# Roadmap\n\n| Phase | Title | Status | Depends on |\n|-------|-------|--------|------------|\n",
  );

  return {
    archiveRoot,
    archivedBlueprint,
    archivedRoadmap,
    archivedPhaseDirs,
    archivedRunDirs,
  };
}

export function readRoadmap(projectRoot: string): string {
  const path = roadmapPath(projectRoot);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeRoadmap(projectRoot: string, content: string): void {
  ensureSlopcontrolDir(projectRoot);
  writeFileSync(
    roadmapPath(projectRoot),
    extractMarkdownDocument(content) || content.trim(),
    "utf-8",
  );
}

/** Roadmap titles must stay single-line table cells: collapse whitespace,
 * neutralize pipes, and cap runaway raw descriptions. */
export function sanitizeRoadmapTitle(title: string): string {
  const t = (title ?? "")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}

/**
 * Rows written before title sanitization broke across lines, leaving orphan
 * fragments (" | accepted | — |" and bare text). Once the table body starts,
 * only pipe-rows and heading lines are valid — drop the rest.
 */
export function dropBrokenRoadmapRowFragments(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("|")) {
      inTable = true;
      out.push(line);
    } else if (!inTable || /^\s*#/.test(line)) {
      out.push(line);
    }
  }
  return out.join("\n");
}

export function upsertRoadmapEntry(
  projectRoot: string,
  phaseId: string,
  title: string,
  status: string,
  dependsOn: string[] = [],
): void {
  const depsLabel = dependsOn.length > 0 ? dependsOn.join(", ") : "—";
  const existing = readRoadmap(projectRoot);
  const line = `| ${phaseId} | ${sanitizeRoadmapTitle(title)} | ${status} | ${depsLabel} |`;
  const header =
    "# Roadmap\n\n| Phase | Title | Status | Depends on |\n|-------|-------|--------|------------|\n";

  if (!existing.trim()) {
    writeRoadmap(projectRoot, `${header}${line}\n`);
    return;
  }

  const lines = dropBrokenRoadmapRowFragments(existing).split("\n");
  const rowRe = new RegExp(
    `^\\|\\s*${phaseId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\|`,
  );
  let replaced = false;
  const next = lines.map((row) => {
    if (rowRe.test(row)) {
      replaced = true;
      return line;
    }
    return row;
  });

  if (!replaced) {
    if (!/^\| Phase \|/m.test(existing)) {
      writeRoadmap(projectRoot, `${existing.trim()}\n\n${header}${line}\n`);
      return;
    }
    // Upgrade old 3-column header if present
    const upgraded = next.map((row) => {
      if (/^\| Phase \| Title \| Status \|\s*$/.test(row)) {
        return "| Phase | Title | Status | Depends on |";
      }
      if (/^\|[-| ]+\|$/.test(row) && row.includes("Status") === false) {
        return "|-------|-------|--------|------------|";
      }
      return row;
    });
    upgraded.push(line);
    writeRoadmap(projectRoot, `${upgraded.join("\n").trim()}\n`);
    return;
  }
  writeRoadmap(projectRoot, `${next.join("\n").trim()}\n`);
}

/**
 * Merge an accepted phase into the living BLUEPRINT.md.
 * Prefers "## Blueprint Update" full replacement body, else "## Blueprint Deltas"
 * appended under ## Decisions, else a short pointer.
 * Always runs intent-aware reconcile (dedupe + Live decisions).
 */
export function mergePhaseIntoBlueprint(
  projectRoot: string,
  phaseId: string,
  phaseDoc: string,
  description: string,
): void {
  const trimmed = extractMarkdownDocument(phaseDoc);
  if (!trimmed) return;

  const intent = readChangeIntent(projectRoot, phaseId);

  const update = extractSection(trimmed, /Blueprint\s+Update/i);
  if (update) {
    const existing = readBlueprint(projectRoot);
    if (!existing.trim()) {
      writeBlueprint(projectRoot, update);
    } else {
      // Append update as a dated decisions block when a living blueprint exists
      const date = new Date().toISOString().split("T")[0];
      appendBlueprint(
        projectRoot,
        `## Decisions — ${phaseId} (${date})\n\n${update}\n`,
      );
    }
  } else {
    const deltaMatch = trimmed.match(
      /##\s*(Blueprint\s*Deltas?|Key\s*Decisions?|Architecture\s*Changes?)\s*\n([\s\S]*?)(?=\n##\s|$)/i,
    );

    const body = deltaMatch
      ? deltaMatch[2]?.trim()
      : `_Accepted phase_\n\n${description}\n\nSee \`.slopcontrol/phases/${phaseId}/PHASE.md\` for full detail.`;

    const date = new Date().toISOString().split("T")[0];
    appendBlueprint(
      projectRoot,
      `## Decisions — ${phaseId} (${date})\n\n${body ?? ""}\n`,
    );
  }

  const current = readBlueprint(projectRoot);
  const probes = probeProjectForDecisions(projectRoot);
  const { blueprint: cleaned } = reconcileBlueprintDecisions(
    current,
    intent,
    probes,
  );
  if (cleaned !== current) {
    writeBlueprint(projectRoot, cleaned);
  }
}

/**
 * Run Blueprint reconcile on an existing project without merging a phase
 * (e.g. one-time JamPress cleanup). Uses INTENT for phaseId when provided,
 * else defaults to prefer composer when live mount conflict exists.
 */
export function reconcileProjectBlueprint(
  projectRoot: string,
  phaseId?: string,
  opts?: { dryRun?: boolean },
): {
  changed: boolean;
  report: string[];
  liveDecisions: string;
  dryRun: boolean;
  blueprintPreviewChars: number;
} {
  const intent: ChangeIntent | null = phaseId
    ? readChangeIntent(projectRoot, phaseId)
    : {
        title: "reconcile",
        goal: "reconcile",
        uiMount: "composer",
        refinementOf: [],
        supersedes: ["BD-IN-BUBBLE-FORMS"],
        mustNot: [],
        rawDescription: "",
      };
  const current = readBlueprint(projectRoot);
  if (!current.trim()) {
    return {
      changed: false,
      report: ["empty blueprint"],
      liveDecisions: "",
      dryRun: Boolean(opts?.dryRun),
      blueprintPreviewChars: 0,
    };
  }
  const probes = probeProjectForDecisions(projectRoot);
  const { blueprint, report } = reconcileBlueprintDecisions(
    current,
    intent,
    probes,
  );
  const verified =
    extractSection(blueprint, /Live decisions\s*[—-]\s*verified/i)?.trim() ??
    "";
  const claimed =
    extractSection(
      blueprint,
      /Live decisions\s*[—-]\s*claimed unverified/i,
    )?.trim() ?? "";
  const liveDecisions = [verified, claimed]
    .filter(Boolean)
    .join("\n\n")
    .trim() || extractLiveDecisions(blueprint);
  const changed = blueprint !== current;
  if (changed && !opts?.dryRun) {
    writeBlueprint(projectRoot, blueprint);
  }
  return {
    changed,
    report: [
      ...report,
      `probes: mount=${probes.mount}; evidence=${probes.evidence.slice(0, 3).join("; ") || "none"}`,
    ],
    liveDecisions,
    dryRun: Boolean(opts?.dryRun),
    blueprintPreviewChars: blueprint.length,
  };
}

/**
 * Extract ## Proposed Roadmap from a blueprint/research doc and write ROADMAP.md.
 * Always overwrites when a non-empty proposed roadmap section exists (fixes reinit stub bug).
 */
export function applyProposedRoadmap(
  projectRoot: string,
  markdown: string,
): boolean {
  const doc = extractMarkdownDocument(markdown);
  const roadmap = extractSection(doc, /^##\s+Proposed\s+Roadmap\s*$/i);
  if (!roadmap?.trim()) return false;
  writeRoadmap(
    projectRoot,
    roadmap.startsWith("#") ? roadmap : `# Roadmap\n\n${roadmap}`,
  );
  return true;
}

/**
 * If research contains "## Proposed Blueprint", write it as BLUEPRINT.md
 * (after optional archive). Also writes "## Proposed Roadmap" when present.
 */
export function bootstrapFromResearch(
  projectRoot: string,
  research: string,
  opts?: { archiveExisting?: boolean },
): { blueprintWritten: boolean; archivePath: string | null } {
  const doc = extractMarkdownDocument(research);
  const proposed =
    extractSection(doc, /Proposed\s+Blueprint/i) ??
    extractSection(doc, /Living\s+Blueprint/i);

  let archivePath: string | null = null;
  if (!proposed) {
    // Still try to apply roadmap from a full # Blueprint document
    applyProposedRoadmap(projectRoot, doc);
    return { blueprintWritten: false, archivePath: null };
  }

  if (opts?.archiveExisting && readBlueprint(projectRoot).trim()) {
    archivePath = archiveBlueprint(projectRoot);
  }

  writeBlueprint(
    projectRoot,
    proposed.startsWith("#") ? proposed : `# Blueprint\n\n${proposed}`,
  );

  applyProposedRoadmap(projectRoot, doc);

  return { blueprintWritten: true, archivePath };
}

export function readProjectConfig(projectRoot: string): ProjectConfig {
  const path = projectConfigPath(projectRoot);
  if (!existsSync(path)) {
    return ProjectConfigSchema.parse({});
  }
  return ProjectConfigSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

export function writeProjectConfig(
  projectRoot: string,
  config: ProjectConfig,
): void {
  ensureSlopcontrolDir(projectRoot);
  writeFileSync(
    projectConfigPath(projectRoot),
    JSON.stringify(config, null, 2),
    "utf-8",
  );
}

export function ensurePhaseDir(projectRoot: string, phaseId: string): string {
  const dir = phaseDir(projectRoot, phaseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writePhaseDoc(
  projectRoot: string,
  phaseId: string,
  content: string,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  writeFileSync(
    phaseDocPath(projectRoot, phaseId),
    extractMarkdownDocument(content) || stripCompletionTokens(content),
    "utf-8",
  );
}

/**
 * If the worktree PHASE.md validates and differs from the project canonical
 * copy, promote it (coding agent often fixes Automated Checks in-worktree).
 */
export function promotePhaseDocFromWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
  phaseId: string;
}): { promoted: boolean; issues?: string[] } {
  const wtDoc = readPhaseDoc(opts.worktreePath, opts.phaseId);
  if (!wtDoc.trim()) {
    return { promoted: false };
  }
  const gate = validatePhaseDocForDev(wtDoc);
  if (!gate.ok) {
    return { promoted: false, issues: gate.issues };
  }
  const current = readPhaseDoc(opts.projectRoot, opts.phaseId);
  if (current === wtDoc) {
    return { promoted: false };
  }
  writePhaseDoc(opts.projectRoot, opts.phaseId, wtDoc);
  return { promoted: true };
}

export function readPhaseDoc(projectRoot: string, phaseId: string): string {
  const path = phaseDocPath(projectRoot, phaseId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/**
 * Remove a canonical PHASE.md that does not align with RESEARCH so the planner
 * cannot remix a retitled prior-phase plan via tools.
 */
export function clearMisalignedPhaseDoc(opts: {
  projectRoot: string;
  phaseId: string;
  research: string;
  description?: string;
}): { cleared: boolean; issues: string[] } {
  const existing = readPhaseDoc(opts.projectRoot, opts.phaseId);
  if (!existing.trim()) {
    return { cleared: false, issues: [] };
  }
  const align = phaseDocAlignsWithResearch(
    existing,
    opts.research,
    opts.description,
  );
  if (align.ok) {
    return { cleared: false, issues: [] };
  }
  try {
    rmSync(phaseDocPath(opts.projectRoot, opts.phaseId), { force: true });
  } catch {
    /* ignore */
  }
  return { cleared: true, issues: align.issues };
}

export function writeResearch(
  projectRoot: string,
  phaseId: string,
  content: string,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  writeFileSync(
    researchPath(projectRoot, phaseId),
    extractMarkdownDocument(content) || stripCompletionTokens(content),
    "utf-8",
  );
}

export function readResearch(projectRoot: string, phaseId: string): string {
  const path = researchPath(projectRoot, phaseId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

/** True when RESEARCH.md is substantial enough to draft from without re-research. */
export function researchLooksSolid(research: string): boolean {
  const body = (research ?? "").trim();
  return (
    body.length >= 400 &&
    (/RESEARCH_COMPLETE/i.test(body) || /^#\s+/m.test(body))
  );
}

/**
 * True when the planner returned chat refusal instead of a PHASE.md document.
 * Only applies when output lacks a valid phase doc structure.
 */
export function isPlannerRefusalOutput(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return false;
  const hasPhaseStructure =
    /^#\s+Phase\b/im.test(trimmed) && /^##\s+Scope\b/im.test(trimmed);
  if (hasPhaseStructure) return false;
  return (
    /I don'?t have (a )?phase/i.test(trimmed) ||
    /request came through empty/i.test(trimmed) ||
    (/Please provide/i.test(trimmed) && !/^#\s+/m.test(trimmed))
  );
}

export function appendAppendix(
  projectRoot: string,
  phaseId: string,
  content: string,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  const path = appendixPath(projectRoot, phaseId);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Appendix\n\n";
  const separator = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${existing}${separator}${content}\n`, "utf-8");
}

export function readAppendix(projectRoot: string, phaseId: string): string {
  const path = appendixPath(projectRoot, phaseId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeUiSpec(
  projectRoot: string,
  phaseId: string,
  content: string,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  writeFileSync(
    uiSpecPath(projectRoot, phaseId),
    extractMarkdownDocument(content) || stripCompletionTokens(content),
    "utf-8",
  );
}

export function readUiSpec(projectRoot: string, phaseId: string): string {
  const path = uiSpecPath(projectRoot, phaseId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeTokensCss(
  projectRoot: string,
  phaseId: string,
  content: string,
): void {
  ensureDesignDir(projectRoot, phaseId);
  writeFileSync(tokensCssPath(projectRoot, phaseId), content, "utf-8");
}

export function readTokensCss(projectRoot: string, phaseId: string): string {
  const path = tokensCssPath(projectRoot, phaseId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function markDesignComplete(projectRoot: string, phaseId: string): void {
  ensureDesignDir(projectRoot, phaseId);
  writeFileSync(
    designStatusPath(projectRoot, phaseId),
    `# Design status\n\nDESIGN_COMPLETE\n`,
    "utf-8",
  );
}

export function isDesignComplete(projectRoot: string, phaseId: string): boolean {
  const path = designStatusPath(projectRoot, phaseId);
  if (!existsSync(path)) return false;
  return /DESIGN_COMPLETE/m.test(readFileSync(path, "utf-8"));
}

/**
 * True when the phase already has a usable logo mark: an operator-pinned
 * logo selection in the design pack, or any logo/mark file in the phase
 * design assets dir or the project brand dir. Lets the design stage skip
 * generative logo briefs for non-identity phases instead of failing closed.
 */
export function phaseHasUsableLogo(
  projectRoot: string,
  phaseId: string,
): boolean {
  try {
    const pack = readPhaseDesignPack(projectRoot, phaseId);
    if (pack?.selections?.some((s) => s.slot === "logo" && s.asset)) {
      return true;
    }
  } catch {
    /* fall through to filesystem probe */
  }
  const dirs = [
    join(projectRoot, ".slopcontrol", "phases", phaseId, "design", "assets"),
    join(projectRoot, "public", "brand"),
  ];
  for (const dir of dirs) {
    try {
      if (!existsSync(dir)) continue;
      const hit = readdirSync(dir).some(
        (n) =>
          /logo|wordmark|mark/i.test(n) &&
          /\.(png|svg|webp|jpe?g)$/i.test(n) &&
          !n.startsWith("."),
      );
      if (hit) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** PHASE explicitly asks for a visual design pass (Brand / Assets / Requires yes). */
export function phaseForcesVisualDesign(phaseDoc: string): boolean {
  if (!phaseDoc.trim()) return false;
  if (/Requires\s+design\s+pass\s*:\s*yes/i.test(phaseDoc)) return true;
  if (/Requires\s+design\s+pass\s*:\s*no/i.test(phaseDoc)) return false;
  if (/^##\s+Brand\b/im.test(phaseDoc)) {
    const brand = extractSection(phaseDoc, "Brand") ?? "";
    if (!isNotApplicableDesignSection(brand)) return true;
  }
  if (/^##\s+Assets\b/im.test(phaseDoc)) {
    const assets = extractSection(phaseDoc, "Assets") ?? "";
    if (!isNotApplicableDesignSection(assets)) return true;
  }
  return false;
}

/**
 * True when this phase should run the design stage before coding.
 * Brand identity / sibling theming Intents need design. Theme-toggle wiring
 * alone does not. Stock component-library adoption is design-by-reference
 * (the design lives in the library) and skips the generative design pass.
 * chrome-hide / backend skip unless PHASE forces visuals.
 * Other kinds keep UI-SPEC / real Brand / Assets signals.
 */
export function phaseNeedsDesign(
  projectRoot: string,
  phaseId: string,
  config?: ProjectConfig | null,
): boolean {
  const cfg = config ?? readProjectConfig(projectRoot);
  if (cfg.enableDesignPass === false) return false;

  const phaseDoc = readPhaseDoc(projectRoot, phaseId);
  const forcedVisual = phaseForcesVisualDesign(phaseDoc);
  const intent = readChangeIntent(projectRoot, phaseId);
  const kind = intent?.changeKind;
  const brandAsk = intent ? changeIntentIsBrandTheming(intent) : false;
  const themeWiringOnly = intent ? changeIntentIsThemeWiringOnly(intent) : false;

  // Stock component-library adoption: the design already exists in the
  // library; coding adopts it. No generative design pass (unless PHASE was
  // explicitly written to force visuals for a genuinely generative sub-ask).
  if (intent?.stockAdoption === true) return forcedVisual;

  // Asset swap: wire/point at an EXISTING named asset — pure coding.
  if (intent?.assetSwap === true) return forcedVisual;

  // Brand identity / apply sibling theming needs design (even if mislabeled
  // backend). Theme toggle / data-theme wiring alone does not.
  if (brandAsk && !themeWiringOnly) return true;

  if (kind === "chrome-hide" || kind === "backend") {
    // Do not treat leftover UI-SPEC as requiring design for structural/non-UI work.
    return forcedVisual;
  }

  if (existsSync(uiSpecPath(projectRoot, phaseId))) return true;
  if (!phaseDoc.trim()) return false;
  return forcedVisual;
}

export interface DesignAssetBrief {
  name: string;
  prompt: string;
  filename: string;
  /**
   * Existing asset to DERIVE from (4th `Source` column in ## Assets tables).
   * Derivative briefs never hit generative image models — they run through
   * deterministic asset ops (alpha cut-out / icon pack resize).
   */
  source?: string;
}

/** Derivative ops: icon pack / alpha / resize from an existing asset. */
const DERIVATIVE_ASSET_RE =
  /\b(?:icon\s*pack|favicon|alpha(?:[- ]channel)?|transparent|cut\s*out|resize|sizes)\b/i;

/** Documentation-only rows: name or prompt marks the asset as reference. */
const REFERENCE_ROW_NAME_RE =
  /(?:\(|\b)(?:authority|reference|existing|pinned|do[- ]not[- ]generate)(?:\)|\b)/i;
const REFERENCE_ROW_PROMPT_RE =
  /\b(?:already\s+on\s+disk|do\s+not\s+generate|not\s+(?:to\s+be\s+)?(?:re)?-?generated?|reference\s+only|for\s+reference)\b/i;

/**
 * True when the brief describes deriving new files from an EXISTING asset
 * (icon pack, alpha cut-out, resize) rather than generating new artwork.
 */
export function isDerivativeAssetBrief(brief: {
  name: string;
  filename: string;
  prompt?: string;
  source?: string;
}): boolean {
  if (brief.source?.trim()) return true;
  return DERIVATIVE_ASSET_RE.test(`${brief.name} ${brief.filename}`);
}

/**
 * Parse asset rows from UI-SPEC or PHASE ## Assets tables / logo brief.
 * Caps at `max` entries (default 3).
 * Only reads the ## Assets section (and Logo brief fallback) — never Palette tables.
 * Optional 4th column `Source` names an existing asset to derive from.
 */
export function parseDesignAssetBriefs(
  markdown: string,
  max = 3,
): DesignAssetBrief[] {
  const briefs: DesignAssetBrief[] = [];
  const seen = new Set<string>();

  // Prefer ## Assets heading only — never scan Palette / other tables.
  const assetsSection = extractSection(markdown, "Assets");
  const tableSource = assetsSection?.trim() ? assetsSection : "";

  // Header-aware table gating: only tables with BOTH a Name and a
  // Filename/File column are generation-brief tables. Inventory tables
  // (Asset | Path | Status) document existing files — never briefs.
  const splitRow = (line: string): string[] =>
    line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim());
  const isSeparatorRow = (line: string): boolean =>
    /^\|[\s:|-]+\|?\s*$/.test(line.trim()) && /-{2,}/.test(line);
  const PLACEHOLDER_CELL_RE = /^[-–—\s`]*$/;

  const lines = tableSource.split("\n");
  const briefRows: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const headerLine = lines[i] ?? "";
    if (!headerLine.trim().startsWith("|")) continue;
    const sepLine = lines[i + 1] ?? "";
    if (!sepLine.trim().startsWith("|") || !isSeparatorRow(sepLine)) continue;
    const headers = splitRow(headerLine);
    const hasName = headers.some((h) => /^name$/i.test(h));
    const hasFile = headers.some((h) => /^file(?:name)?$/i.test(h));
    const body: string[][] = [];
    let j = i + 2;
    while (j < lines.length && (lines[j] ?? "").trim().startsWith("|")) {
      body.push(splitRow(lines[j] ?? ""));
      j++;
    }
    i = j - 1;
    if (!hasName || !hasFile) continue;
    briefRows.push(...body);
  }

  for (const cols of briefRows) {
    const col1 = cols[0] ?? "";
    const col2 = cols[1] ?? "";
    const col3 = cols[2] ?? "";
    const col4 = cols[3] ?? "";
    if (/^[-:]+$/.test(col1.replace(/\s/g, ""))) continue;
    // Placeholder rows ("— | — | No new assets …") are not briefs.
    if (PLACEHOLDER_CELL_RE.test(col1) || PLACEHOLDER_CELL_RE.test(col2)) {
      continue;
    }
    // Skip palette-ish rows that lack a filename and look like color tokens
    if (
      !/\.(png|svg|webp|jpe?g)$/i.test(`${col1} ${col2} ${col3}`) &&
      /^#?[0-9a-fA-F]{3,8}$/.test(col2)
    ) {
      continue;
    }

    const filenameGuess =
      [col1, col2, col3].find((c) => /\.(png|svg|webp|jpe?g)$/i.test(c)) ??
      `${slugifyAsset(col1) || "asset"}.png`;
    const prompt =
      [col3, col2, col1].find(
        (c) =>
          c &&
          !/\.(png|svg|webp|jpe?g)$/i.test(c) &&
          !/^name$/i.test(c) &&
          !/^#?[0-9a-fA-F]{3,8}$/.test(c),
      ) ?? col1;
    // Documentation rows (pinned/authority/reference/existing assets) are
    // not generation requests — skip them entirely.
    if (
      REFERENCE_ROW_NAME_RE.test(col1) ||
      REFERENCE_ROW_PROMPT_RE.test(prompt)
    ) {
      continue;
    }
    const name = col1 || filenameGuess;
    const col4Clean = col4.replace(/^`+|`+$/g, "").trim();
    const source = /\.(png|svg|webp|jpe?g)$/i.test(col4Clean)
      ? col4Clean
      : undefined;
    const key = filenameGuess.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    briefs.push({
      name,
      prompt: prompt || name,
      filename: filenameGuess.includes(".")
        ? filenameGuess
        : `${filenameGuess}.png`,
      ...(source ? { source } : {}),
    });
    if (briefs.length >= max) return briefs;
  }

  const logoBrief = extractSection(markdown, /Logo\s*brief/i);
  // Logo brief is a fallback only when ## Assets yielded nothing.
  if (logoBrief?.trim() && briefs.length === 0) {
    briefs.push({
      name: "logo",
      prompt: logoBrief.trim().slice(0, 500),
      filename: "logo.png",
    });
  }

  return briefs.slice(0, max);
}

/** Relative paths under phases/<id>/design/ for coding prompts. */
export function listDesignAssetPaths(
  projectRoot: string,
  phaseId: string,
): string[] {
  const dir = designDir(projectRoot, phaseId);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "." || name === ".." || name === "STATUS.md") continue;
      const childAbs = join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      try {
        const st = statSync(childAbs);
        if (st.isDirectory()) walk(childAbs, childRel);
        else if (st.isFile()) {
          out.push(
            `.slopcontrol/phases/${phaseId}/design/${childRel}`.replace(
              /\\/g,
              "/",
            ),
          );
        }
      } catch {
        /* skip */
      }
    }
  };
  walk(dir, "");
  return out.sort();
}

function slugifyAsset(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/**
 * Harvest UI-SPEC.md from agent output (markdown extract starting with # UI-SPEC).
 */
export function harvestUiSpecFromAgentOutput(agentOutput: string): string {
  const extracted = extractMarkdownDocument(agentOutput);
  if (/^#\s+UI-SPEC\b/im.test(extracted) || /^#\s+UI Spec\b/im.test(extracted)) {
    return stripCompletionTokens(extracted);
  }
  const fence = agentOutput.match(/```(?:markdown|md)\s*\n([\s\S]*?)```/i);
  if (fence?.[1] && /^#\s+UI-SPEC\b/im.test(fence[1])) {
    return stripCompletionTokens(fence[1].trim());
  }
  return "";
}

/**
 * Harvest a CSS tokens block from agent output (```css ... ``` preferred).
 */
export function harvestTokensCssFromAgentOutput(agentOutput: string): string {
  const cssFence = agentOutput.match(/```css\s*\n([\s\S]*?)```/i);
  if (cssFence?.[1]?.trim()) return cssFence[1].trim();
  const rootBlock = agentOutput.match(/(:root\s*\{[\s\S]*?\})/);
  return rootBlock?.[1]?.trim() ?? "";
}


export function writePhaseStatus(
  projectRoot: string,
  phaseId: string,
  status: PhaseStatus,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  writeFileSync(
    phaseStatusPath(projectRoot, phaseId),
    JSON.stringify({ status: PhaseStatusSchema.parse(status) }, null, 2),
    "utf-8",
  );
  if (status === "complete") {
    clearPhaseDiagnosis(projectRoot, phaseId);
  }
}

export function diagnosisPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "diagnosis.json");
}

export function phaseDiagnosisPath(projectRoot: string, phaseId: string): string {
  return join(phaseDir(projectRoot, phaseId), "diagnosis.json");
}

export type PersistedDiagnosis = {
  audience: "operator" | "coding";
  operatorActions: string[];
  class: string;
  confidence: string;
  title: string;
  rootCause: string;
  evidence: string;
  nextActions: string;
  fingerprint: string;
  codingAgentShouldFix: boolean;
  /** Classifier tags for coding-retry routing (long-lived, host-utility, …). */
  tags?: string[];
  failingStep?: {
    name: string;
    command?: string;
    exitCode: number;
    /** Stable id matching verify_steps[].id when present. */
    stepId?: string;
  };
  phaseId?: string;
  runId?: string;
  updatedAt: string;
};

/** Replace failure diagnosis with a success stub when the phase completes. */
export function clearPhaseDiagnosis(
  projectRoot: string,
  phaseId: string,
): void {
  ensurePhaseDir(projectRoot, phaseId);
  const payload = completeDiagnosisStub(phaseId);
  writeFileSync(
    phaseDiagnosisPath(projectRoot, phaseId),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
}

/** Clear a run's diagnosis.json so a prior blocked iteration does not linger. */
export function clearRunDiagnosis(
  projectRoot: string,
  runId: string,
  phaseId?: string,
): void {
  ensureRunDir(projectRoot, runId);
  const payload = completeDiagnosisStub(phaseId, runId);
  writeFileSync(
    diagnosisPath(projectRoot, runId),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf-8",
  );
  if (phaseId) {
    clearPhaseDiagnosis(projectRoot, phaseId);
  }
}

function completeDiagnosisStub(
  phaseId?: string,
  runId?: string,
): PersistedDiagnosis {
  return {
    audience: "coding",
    operatorActions: [],
    class: "product",
    confidence: "high",
    title: "Phase complete",
    rootCause: "Development completed successfully.",
    evidence: "",
    nextActions: "None — phase is complete.",
    fingerprint: "complete",
    codingAgentShouldFix: false,
    phaseId,
    runId,
    updatedAt: new Date().toISOString(),
  };
}

export function readPhaseStatus(
  projectRoot: string,
  phaseId: string,
): PhaseStatus | null {
  const path = phaseStatusPath(projectRoot, phaseId);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as { status: PhaseStatus };
  return PhaseStatusSchema.parse(parsed.status);
}

export function ensureRunDir(projectRoot: string, runId: string): string {
  const dir = runDir(projectRoot, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Directory for full success-check / verify dumps (analysis-friendly). */
export function runChecksDir(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "checks");
}

/**
 * Persist full success-check output under `.slopcontrol/runs/<runId>/checks/`.
 * Returns the absolute path written (also updates latest-<name>.txt).
 */
export function writeCheckReport(
  projectRoot: string,
  runId: string,
  name: string,
  content: string,
): string {
  const dir = runChecksDir(projectRoot, runId);
  mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "") || "check";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stamped = join(dir, `${stamp}-${safe}.txt`);
  const latest = join(dir, `latest-${safe}.txt`);
  const redacted = redactSecrets(content);
  writeFileSync(stamped, redacted, "utf-8");
  writeFileSync(latest, redacted, "utf-8");
  return stamped;
}

/** One Automated Checks / verify step for MCP / dashboard. */
export type VerifyStepReport = {
  id: string;
  name: string;
  command?: string;
  exitCode: number;
  ok: boolean;
  outputExcerpt: string;
};

export type VerifyStepsReport = {
  ok: boolean;
  updatedAt: string;
  steps: VerifyStepReport[];
  firstFailure?: VerifyStepReport;
  summary: string;
};

export function verifyStepsReportPath(
  projectRoot: string,
  runId: string,
): string {
  return join(runChecksDir(projectRoot, runId), "verify-steps.json");
}

function slugVerifyStepId(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "step"
  );
}

/** Assign stable unique ids from step names (suffix -2, -3 on collision). */
export function assignVerifyStepIds(
  steps: Array<{ name: string }>,
): string[] {
  const seen = new Map<string, number>();
  return steps.map((s) => {
    const base = slugVerifyStepId(s.name);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  });
}

/**
 * Persist structured SuccessCheck steps under
 * `.slopcontrol/runs/<runId>/checks/verify-steps.json`.
 */
export function writeVerifyStepsReport(
  projectRoot: string,
  runId: string,
  result: {
    ok: boolean;
    summary?: string;
    steps: Array<{
      name: string;
      command?: string;
      exitCode: number;
      output?: string;
    }>;
    firstFailure?: {
      name: string;
      command?: string;
      exitCode: number;
      output?: string;
    } | null;
  },
): VerifyStepsReport {
  const dir = runChecksDir(projectRoot, runId);
  mkdirSync(dir, { recursive: true });
  const ids = assignVerifyStepIds(result.steps);
  const steps: VerifyStepReport[] = result.steps.map((s, i) => ({
    id: ids[i]!,
    name: s.name,
    command: s.command,
    exitCode: s.exitCode,
    ok: s.exitCode === 0,
    outputExcerpt: redactSecrets(lastLinesForExcerpt(s.output ?? "", 40)),
  }));
  let firstFailure: VerifyStepReport | undefined;
  if (result.firstFailure) {
    const idx = result.steps.findIndex(
      (s) =>
        s.name === result.firstFailure!.name &&
        s.exitCode === result.firstFailure!.exitCode &&
        (s.command ?? "") === (result.firstFailure!.command ?? ""),
    );
    firstFailure =
      idx >= 0
        ? steps[idx]
        : {
            id: slugVerifyStepId(result.firstFailure.name),
            name: result.firstFailure.name,
            command: result.firstFailure.command,
            exitCode: result.firstFailure.exitCode,
            ok: false,
            outputExcerpt: redactSecrets(
              lastLinesForExcerpt(result.firstFailure.output ?? "", 40),
            ),
          };
  } else {
    firstFailure = steps.find((s) => !s.ok);
  }
  const report: VerifyStepsReport = {
    ok: result.ok,
    updatedAt: new Date().toISOString(),
    steps,
    firstFailure,
    summary: (result.summary ?? "").trim() || (result.ok ? "Verify OK" : "Verify failed"),
  };
  const latest = verifyStepsReportPath(projectRoot, runId);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stamped = join(dir, `${stamp}-verify-steps.json`);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(latest, body, "utf-8");
  writeFileSync(stamped, body, "utf-8");
  return report;
}

function lastLinesForExcerpt(text: string, n: number): string {
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  return lines.slice(-n).join("\n").slice(0, 4_000);
}

export function readVerifyStepsReport(
  projectRoot: string,
  runId: string,
): VerifyStepsReport | null {
  const path = verifyStepsReportPath(projectRoot, runId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as VerifyStepsReport;
    if (!raw || !Array.isArray(raw.steps)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writeDiagnosis(
  projectRoot: string,
  runId: string,
  diagnosis: PersistedDiagnosis,
  phaseId?: string,
): string {
  ensureRunDir(projectRoot, runId);
  const path = diagnosisPath(projectRoot, runId);
  const payload: PersistedDiagnosis = {
    ...diagnosis,
    runId,
    phaseId: phaseId ?? diagnosis.phaseId,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  if (phaseId) {
    mkdirSync(phaseDir(projectRoot, phaseId), { recursive: true });
    writeFileSync(
      phaseDiagnosisPath(projectRoot, phaseId),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf-8",
    );
  }
  return path;
}

/**
 * Structured diagnosis for research/draft process failures (Change Intent
 * reject, empty research, needs_intent, etc.) — same shape as develop failures
 * so get_run / get_phase_status / dashboard can show it.
 */
export function buildPlanningFailureDiagnosis(opts: {
  stage: "research" | "draft";
  title: string;
  detail: string;
  phaseId: string;
  runId: string;
  /** Stable class tag for fingerprint (e.g. change-intent, empty-research). */
  kind?: string;
  operatorActions?: string[];
}): PersistedDiagnosis {
  const detail = (opts.detail ?? "").trim() || "(no detail)";
  const kind =
    opts.kind?.trim() ||
    (opts.stage === "draft" ? "draft-failed" : "research-failed");
  const fingerprint = createHash("sha256")
    .update(`planning:${opts.stage}:${kind}:${detail.slice(0, 400)}`)
    .digest("hex")
    .slice(0, 16);
  const defaultActions =
    opts.stage === "draft"
      ? [
          "Call retry_draft (research intact) — do not rerun_research unless RESEARCH.md is missing or stale.",
          "Retry draft after fixing PHASE.md Success Criteria / Automated Checks to match Change Intent (form contracts need fill+submit proof; click-to-navigate needs click / onClick / href / router.push; chat mounts (composer/bubble) with a form contract also need live AI SDK static tool parts: type: tool-<name> / parseToolResult / extractActiveForm — not only tool-invocation fixtures). Runtime proofs on dockerized apps must be finite: docker compose up -d <svc> + trap 'docker compose down' EXIT, then probe.",
          "Inspect get_run.dev_output / diagnosis.evidence for the exact gate issues.",
        ]
      : [
          "Retry research with a clearer change description / intent, or open_project with a non-empty intent if BLUEPRINT is missing.",
          "Inspect get_run.dev_output / diagnosis.evidence for the research failure detail.",
        ];
  return {
    audience: "coding",
    operatorActions: opts.operatorActions?.length
      ? opts.operatorActions
      : defaultActions,
    class: "process",
    confidence: "high",
    title: opts.title.slice(0, 160),
    rootCause: detail.slice(0, 2_000),
    evidence: detail.slice(0, 4_000),
    nextActions:
      opts.stage === "draft"
        ? "Retry draft (research intact)."
        : "Retry research or fix bootstrap intent.",
    fingerprint: `planning-${kind}-${fingerprint}`,
    codingAgentShouldFix: true,
    tags: ["planning", opts.stage, kind],
    phaseId: opts.phaseId,
    runId: opts.runId,
    updatedAt: new Date().toISOString(),
  };
}

export function readDiagnosis(
  projectRoot: string,
  runId: string,
): PersistedDiagnosis | null {
  const path = diagnosisPath(projectRoot, runId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PersistedDiagnosis;
  } catch {
    return null;
  }
}

export function readLatestDiagnosisForPhase(
  projectRoot: string,
  phaseId: string,
): PersistedDiagnosis | null {
  const path = phaseDiagnosisPath(projectRoot, phaseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PersistedDiagnosis;
  } catch {
    return null;
  }
}

export function appendRunLog(
  projectRoot: string,
  runId: string,
  line: string,
): void {
  ensureRunDir(projectRoot, runId);
  const path = runLogPath(projectRoot, runId);
  writeFileSync(path, `${line}\n`, { flag: "a", encoding: "utf-8" });
}

export function readRunLog(projectRoot: string, runId: string): string {
  const path = runLogPath(projectRoot, runId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writeRunMemory(
  projectRoot: string,
  runId: string,
  entries: IterationMemoryEntry[],
): void {
  ensureRunDir(projectRoot, runId);
  writeFileSync(
    runMemoryPath(projectRoot, runId),
    JSON.stringify(entries, null, 2),
    "utf-8",
  );
}

export function readRunMemory(
  projectRoot: string,
  runId: string,
): IterationMemoryEntry[] {
  const path = runMemoryPath(projectRoot, runId);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8")) as IterationMemoryEntry[];
}

export function fingerprintErrors(output: string): string {
  const errors = output
    .split("\n")
    .filter((line) =>
      /error|failed|cannot|not found|undefined|exception/i.test(line),
    )
    .map((line) =>
      line
        .replace(/\d+:\d+/g, "")
        .replace(/\/Users\/[^ ]*\//g, "")
        .replace(/\d+/g, "N"),
    )
    .sort()
    .join("\n");

  let hash = 0;
  for (let i = 0; i < errors.length; i++) {
    hash = ((hash << 5) - hash + errors.charCodeAt(i)) | 0;
  }
  return hash.toString(16);
}

export function countErrors(output: string): number {
  return output
    .split("\n")
    .filter((line) =>
      /error|failed|cannot|not found|undefined|exception/i.test(line),
    ).length;
}

/** Heuristic: phase affirmatively plans DB / DDL artifacts (not bare "docker"). */
export function isDatabasePhase(phaseDoc: string): boolean {
  // Affirmative DDL signals only — "no docker compose" / negation must not match.
  if (/CREATE\s+TABLE/i.test(phaseDoc)) return true;
  if (/init-db\.sql/i.test(phaseDoc)) return true;
  if (/database tables/i.test(phaseDoc)) return true;
  if (/\bpostgres(ql)?\b/i.test(phaseDoc)) return true;
  // drizzle alone is weak; require schema/migrate/sql path context
  if (
    /\bdrizzle\b/i.test(phaseDoc) &&
    /\b(schema|migrate|migration|\.sql)\b/i.test(phaseDoc)
  ) {
    return true;
  }
  return false;
}

import {
  extractCheckCells,
  createDefaultCheckRegistry,
} from "./check-runners.js";
import { validateRuntimeClaimProofs } from "./claim-vs-proof.js";
import { readPhaseDesignAcceptance } from "./design-loop.js";
import { readPhaseDesignPack } from "./design-pack.js";

/**
 * Extract runnable check bodies from PHASE.md `## Automated Checks`.
 * One fence = one body (never split on newlines). Prefer {@link extractCheckCells}.
 */
export function extractAutomatedChecks(phaseDoc: string): string[] {
  return extractCheckCells(phaseDoc).map((c) => c.body);
}

const SECRET_PROBE_RE =
  /\b(curl|wget|httpie|fetch)\b[\s\S]{0,200}\b(Authorization|Bearer|API_KEY|OLLAMA_API_KEY|\$\{?OLLAMA)/i;

export function isSecretBearingCheck(command: string): boolean {
  return SECRET_PROBE_RE.test(command);
}

/**
 * True when a check command uses `|| echo FAIL` (always exits 0).
 * Prefer `|| exit 1` so the shell exit code reflects failure.
 */
export function isSoftFailEchoCheck(command: string): boolean {
  return /\|\|\s*echo\s+(['"]?)FAIL\b/i.test(command);
}

/**
 * Detect printed FAIL markers from soft-fail echo checks (exit code still 0).
 */
export function automatedCheckReportedFailure(output: string): boolean {
  return /(?:^|\n)\s*FAIL\b[:\s]/m.test(output);
}

/**
 * True when PHASE.md looks like planner chat preamble rather than a real phase doc.
 * Chatty-phrase sniff applies only to the **first non-empty line** (document start).
 * Scope may quote transcripts (`Here's what it needs:`) without failing the gate.
 */
export function isPhaseDocPreamble(phaseDoc: string): boolean {
  const trimmed = phaseDoc.trim();
  if (!trimmed) return true;
  if (!/^#\s+/m.test(trimmed)) return true;
  const firstLine =
    trimmed.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  if (
    /^(Let me |I'll |I will |Here(?:'s| is) |Now I |PHASE\.md has been written)/i.test(
      firstLine,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Automated Checks must not force free-tier Ollama Cloud / `:cloud` model IDs.
 * That anti-pattern "fixes" paid-tier 404s by regressing product to free tier.
 */
export function isFreeTierForceCheck(command: string): boolean {
  const c = command ?? "";
  if (/OLLAMA_TIER\s*=\s*free/i.test(c)) return true;
  if (/grep\b[^|\n]*OLLAMA_TIER=free/i.test(c)) return true;
  if (/AI_(CHAT|CODE|EMBEDDING)_MODEL=[^\s'"]*:cloud/i.test(c)) return true;
  if (/grep\b[^|\n]*:cloud[^\n]*AI_(CHAT|CODE|EMBEDDING)_MODEL/i.test(c)) {
    return true;
  }
  return false;
}

/**
 * Development gate: PHASE.md must declare runnable Automated Checks
 * (manual-only success criteria are not enough). Rejects secret-bearing probes.
 * Rejects truncated extracts that lack a real `# Phase` title / `## Scope`.
 */
export function validatePhaseDocForDev(
  phaseDoc: string,
  opts?: { projectRoot?: string; phaseId?: string },
): {
  ok: boolean;
  issues: string[];
} {
  const issues: string[] = [];
  if (isPhaseDocPreamble(phaseDoc)) {
    issues.push(
      "PHASE.md looks like planner chat preamble — rewrite starting with # and required sections",
    );
  }
  if (!/^#\s+Phase\b/im.test(phaseDoc.trim())) {
    issues.push(
      "PHASE.md must start with a `# Phase …` title (truncated extracts that begin with in-fence `#` comments are rejected)",
    );
  }
  if (!/^##\s+Scope\b/im.test(phaseDoc)) {
    issues.push("PHASE.md missing ## Scope section");
  }
  if (!/^##\s+Automated Checks\s*$/im.test(phaseDoc)) {
    issues.push(
      "PHASE.md missing ## Automated Checks section with runnable commands",
    );
  } else {
    const cells = extractCheckCells(phaseDoc);
    if (cells.length === 0) {
      issues.push(
        "## Automated Checks must include at least one runnable command (prefer a ```bash fence)",
      );
    }
    // Validation-only registry (run is unused)
    const registry = createDefaultCheckRegistry(async () => ({
      exitCode: 0,
      output: "",
    }));
    for (const cell of cells) {
      const command = cell.body;
      for (const issue of registry.validate(cell)) {
        issues.push(issue);
      }
      if (isSecretBearingCheck(command)) {
        issues.push(
          `Forbidden secret-bearing Automated Check (no curl/http with API keys): ${command.slice(0, 120)}`,
        );
      }
      if (isFreeTierForceCheck(command)) {
        issues.push(
          `Forbidden free-tier force Automated Check (do not require OLLAMA_TIER=free or :cloud model IDs): ${command.slice(0, 120)}`,
        );
      }
    }
  }
  if (!/^##\s+(File Changes|Success Criteria)\b/im.test(phaseDoc)) {
    issues.push(
      "PHASE.md missing required section (File Changes or Success Criteria)",
    );
  }
  if (
    /Update `\.?env\.docker`[^\n]{0,60}OLLAMA_TIER=free|change `OLLAMA_TIER=paid`\s*→\s*`OLLAMA_TIER=free`|OLLAMA_TIER=free` \(matching the free-tier/i.test(
      phaseDoc,
    )
  ) {
    issues.push(
      "PHASE.md must not mandate switching product env to OLLAMA_TIER=free / free-tier :cloud models — that is an operator entitlement decision, not a coding fix",
    );
  }
  for (const issue of validateRuntimeClaimProofs(phaseDoc, opts)) {
    issues.push(issue);
  }
  return { ok: issues.length === 0, issues };
}

export type FileStatSnapshot = Map<
  string,
  { mtimeMs: number; size: number } | null
>;

/** Snapshot mtime/size for paths (missing files → null). */
export function snapshotFileStats(paths: string[]): FileStatSnapshot {
  const map: FileStatSnapshot = new Map();
  for (const path of paths) {
    try {
      if (!existsSync(path)) {
        map.set(path, null);
        continue;
      }
      const st = statSync(path);
      map.set(path, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      map.set(path, null);
    }
  }
  return map;
}

/** Paths that are new or changed since the snapshot. */
export function filesChangedSince(
  before: FileStatSnapshot,
  paths: string[],
): string[] {
  const changed: string[] = [];
  for (const path of paths) {
    const prev = before.get(path) ?? null;
    let next: { mtimeMs: number; size: number } | null = null;
    try {
      if (existsSync(path)) {
        const st = statSync(path);
        next = { mtimeMs: st.mtimeMs, size: st.size };
      }
    } catch {
      next = null;
    }
    if (!next) continue;
    if (
      !prev ||
      prev.mtimeMs !== next.mtimeMs ||
      prev.size !== next.size
    ) {
      changed.push(path);
    }
  }
  return changed;
}

/**
 * Paths the phase planner / review agent may write via tools
 * (canonical + common mistakes like project-root PHASE.md).
 */
export function phaseDocWatchPaths(
  projectRoot: string,
  phaseId: string,
): string[] {
  return [
    phaseDocPath(projectRoot, phaseId),
    join(projectRoot, "PHASE.md"),
    join(projectRoot, "phase.md"),
    join(slopcontrolRoot(projectRoot), "PHASE.md"),
  ];
}

export function researchDocWatchPaths(
  projectRoot: string,
  phaseId: string,
): string[] {
  return [
    researchPath(projectRoot, phaseId),
    join(projectRoot, "RESEARCH.md"),
    join(projectRoot, "research.md"),
    join(slopcontrolRoot(projectRoot), "RESEARCH.md"),
  ];
}

export function isThinResearch(doc: string): boolean {
  const trimmed = extractMarkdownDocument(doc).trim();
  if (!trimmed) return true;
  if (isPhaseDocPreamble(trimmed)) return true;
  if (trimmed.length < 400) return true;
  if (!/^#\s+/m.test(trimmed)) return true;
  return false;
}

const RESEARCH_OVERCLAIM_RE =
  /(?:~?\s*90\s*%|already\s+(?:substantially\s+)?(?:exists|implemented|works)|already\s+implements\s+~?\s*\d+|~?\s*\d+\s*%\s+of\s+(?:this|it|the\s+request))/i;

const RESEARCH_RESIDUAL_RISK_RE =
  /\b(?:residual|blocking|release[- ]gate|does\s+not\s+survive|open\s+engagement|toolName|type\s*[:=]\s*["'`]?tool-|live\s+static|parseToolResult|not\s+proof|hypothesis|unverified|confirmed\s+(?:break|gap|risk))\b/i;

/**
 * When Change Intent has an interaction contract, reject RESEARCH that
 * overclaims fill/submit already works without residual engagement risks.
 * Chrome-hide / backend Intents skip this detector (no fill/submit contract).
 */
export function researchEngagementQuality(
  doc: string,
  intent: ChangeIntent | null | undefined,
): { ok: boolean; issues: string[] } {
  if (
    !intent?.interaction ||
    intent.interaction.mount === "n/a" ||
    intent.changeKind === "chrome-hide" ||
    intent.changeKind === "backend"
  ) {
    return { ok: true, issues: [] };
  }
  const body = extractMarkdownDocument(doc);
  const issues: string[] = [];
  if (RESEARCH_OVERCLAIM_RE.test(body) && !RESEARCH_RESIDUAL_RISK_RE.test(body)) {
    issues.push(
      "Engagement RESEARCH overclaims prior form work as already done without residual engagement risks (toolName / live tool-part / blocking / hypothesis)",
    );
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Prefer a structure-valid PHASE.md from agent text and/or files the agent
 * wrote during the turn (tool write_file often lands at project-root PHASE.md).
 *
 * Every candidate must match the current phase id (or description). Stale
 * prior-phase docs at project-root PHASE.md must never win. When RESEARCH is
 * provided, candidates that ignore its focus (retitled prior plans) are skipped.
 */
export function resolvePhaseDocFromAgentTurn(opts: {
  projectRoot: string;
  phaseId: string;
  agentOutput: string;
  /** Snapshot taken before the agent ran */
  beforeStats: FileStatSnapshot;
  description?: string;
  /** When set, reject candidates that do not align with this RESEARCH.md */
  research?: string;
}): {
  doc: string;
  source: "agent_output" | "tool_write" | "none";
  path?: string;
  gate: ReturnType<typeof validatePhaseDocForDev>;
  alignIssues?: string[];
} {
  const canonical = phaseDocPath(opts.projectRoot, opts.phaseId);
  const watch = phaseDocWatchPaths(opts.projectRoot, opts.phaseId);
  const changed = new Set(filesChangedSince(opts.beforeStats, watch));
  const candidates: Array<{
    doc: string;
    source: "agent_output" | "tool_write";
    path?: string;
    priority: number;
  }> = [];
  const alignRejections: string[] = [];
  const claimOpts = {
    projectRoot: opts.projectRoot,
    phaseId: opts.phaseId,
  };

  const pathPriority = (path: string): number => {
    if (path === canonical) return 0; // prefer canonical
    if (changed.has(path)) return 2; // mistake paths that changed this turn
    return 3; // unchanged leftovers
  };

  const acceptsContent = (doc: string): boolean => {
    if (!phaseDocMatchesPhase(doc, opts.phaseId, opts.description)) {
      return false;
    }
    if (opts.research !== undefined) {
      const align = phaseDocAlignsWithResearch(
        doc,
        opts.research,
        opts.description,
      );
      if (!align.ok) {
        alignRejections.push(...align.issues);
        return false;
      }
    }
    return true;
  };

  const pushFile = (path: string) => {
    try {
      const raw = readFileSync(path, "utf-8");
      const doc = extractMarkdownDocument(raw);
      if (!doc.trim()) return;
      if (!acceptsContent(doc)) return;
      candidates.push({
        doc,
        source: "tool_write",
        path,
        priority: pathPriority(path),
      });
    } catch {
      /* ignore */
    }
  };

  for (const path of changed) {
    pushFile(path);
  }

  const fromOutput = extractMarkdownDocument(opts.agentOutput);
  if (fromOutput.trim() && acceptsContent(fromOutput)) {
    candidates.push({
      doc: fromOutput,
      source: "agent_output",
      priority: 1,
    });
  }

  // Re-run safety: a prior failed draft may have left a valid PHASE.md that
  // did not change this turn (canonical or matching root).
  for (const path of watch) {
    if (changed.has(path)) continue;
    if (!existsSync(path)) continue;
    pushFile(path);
  }

  candidates.sort((a, b) => a.priority - b.priority);

  for (const candidate of candidates) {
    if (!acceptsContent(candidate.doc)) {
      continue;
    }
    const gate = validatePhaseDocForDev(candidate.doc, claimOpts);
    if (gate.ok) {
      return {
        doc: candidate.doc,
        source: candidate.source,
        path: candidate.path,
        gate,
      };
    }
  }

  const fallback = candidates.find((c) => acceptsContent(c.doc));
  if (fallback) {
    return {
      doc: fallback.doc,
      source: fallback.source,
      path: fallback.path,
      gate: validatePhaseDocForDev(fallback.doc, claimOpts),
    };
  }

  const alignIssues = [...new Set(alignRejections)];
  return {
    doc: "",
    source: "none",
    gate: validatePhaseDocForDev("", claimOpts),
    ...(alignIssues.length > 0 ? { alignIssues } : {}),
  };
}

/**
 * True when the PHASE.md content is about this phase (not a stale prior phase).
 * Rejects H1 titles that embed a different numeric phase id (e.g. Phase 30 when
 * drafting 31-…).
 */
export function phaseDocMatchesPhase(
  doc: string,
  phaseId: string,
  description?: string,
): boolean {
  const targetNum = /^(\d+)/.exec(phaseId)?.[1];
  const h1 = /^#\s+(.+)$/m.exec(doc)?.[1] ?? "";
  const h1PhaseToken = /\b(\d{2,}-[a-z0-9-]{4,})/i.exec(h1)?.[1];
  const h1Num =
    /^(\d+)/.exec(h1PhaseToken ?? "")?.[1] ??
    /\bPhase\s+(\d+)\b/i.exec(h1)?.[1];
  if (targetNum && h1Num && h1Num !== targetNum) {
    return false;
  }

  const lower = doc.toLowerCase();
  if (lower.includes(phaseId.toLowerCase())) return true;
  // Same phase number in the H1 is enough (e.g. "# Phase 09: …" for 09-…).
  if (targetNum && h1Num && h1Num === targetNum) return true;
  const slug = phaseId.replace(/^\d+-/, "").toLowerCase();
  if (slug.length >= 12 && lower.includes(slug.slice(0, 16))) return true;
  if (!description?.trim()) return false;
  const words = description
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 5)
    .slice(0, 5);
  const hits = words.filter((w) => lower.includes(w)).length;
  return hits >= 2;
}

/** Theme scores used to catch retitled prior-phase plans. */
function themeScores(text: string): {
  modelNaming: number;
  hostRouting: number;
  codePaths: string[];
} {
  const t = text ?? "";
  const modelNaming = [
    /:cloud\b/i,
    /\bmodel-resolver\b/i,
    /\bresolveModelId\b/i,
    /\bverbatim\b/i,
    /\bstrip(?:ping|s)?\b.*:cloud|:cloud.*\bstrip/i,
    /\bAI_(CHAT|CODE|EMBEDDING)_MODEL\b/,
    /\bpass env model names\b/i,
  ].filter((re) => re.test(t)).length;

  const hostRouting = [
    /\bhost\.docker\.internal\b/i,
    /\bextra_hosts\b/i,
    /\bhost-gateway\b/i,
    /\b192\.168\.\d+\.\d+\b/,
    /\bbox[- ]?lan[- ]?ip\b/i,
    /\breplace box-lan/i,
  ].filter((re) => re.test(t)).length;

  const codePaths: string[] = [];
  for (const m of t.matchAll(
    /(?:^|[\s`"'(])((?:src|packages|app|lib|server)\/[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))/gim,
  )) {
    const path = m[1];
    if (path) codePaths.push(path.replace(/\\/g, "/"));
  }

  return { modelNaming, hostRouting, codePaths };
}

/**
 * Reject PHASE.md that keeps a prior phase's plan after retitling the H1.
 * Example: RESEARCH is model-resolver / :cloud passthrough, but PHASE is still
 * host.docker.internal / extra_hosts from the previous phase.
 */
export function phaseDocAlignsWithResearch(
  phaseDoc: string,
  research: string,
  description?: string,
): { ok: boolean; issues: string[] } {
  if (!phaseDoc.trim()) {
    return { ok: false, issues: ["PHASE.md is empty"] };
  }
  if (!research.trim()) {
    return { ok: true, issues: [] };
  }
  // Still align against short RESEARCH — theme drift can show up in thin docs.
  // Only skip chat-preamble garbage that is not real research.
  if (isPhaseDocPreamble(research)) {
    return { ok: true, issues: [] };
  }

  const researchTheme = themeScores(research);
  const phaseTheme = themeScores(phaseDoc);
  const issues: string[] = [];

  // Research focuses on model naming; phase is host-routing with no model work.
  if (
    researchTheme.modelNaming >= 2 &&
    phaseTheme.modelNaming === 0 &&
    phaseTheme.hostRouting >= 2
  ) {
    issues.push(
      "PHASE.md does not address RESEARCH (model naming / :cloud passthrough); it looks like a prior host-routing phase (host.docker.internal / extra_hosts)",
    );
  }

  // Research names product source files; phase File Changes ignore all of them
  // and instead center on docker/env host routing that research did not request.
  const researchPaths = [...new Set(researchTheme.codePaths.map((p) => p.toLowerCase()))];
  if (researchPaths.length > 0) {
    const phaseLower = phaseDoc.toLowerCase();
    const pathHits = researchPaths.filter((p) => phaseLower.includes(p));
    if (
      pathHits.length === 0 &&
      phaseTheme.hostRouting >= 2 &&
      researchTheme.hostRouting < phaseTheme.hostRouting &&
      researchTheme.modelNaming >= 1
    ) {
      issues.push(
        `PHASE.md never mentions RESEARCH source files (${researchPaths.slice(0, 3).join(", ")}) and instead plans host-routing work`,
      );
    }
  }

  // Description about model mapping but phase is host routing.
  if (description?.trim()) {
    const descTheme = themeScores(description);
    if (
      descTheme.modelNaming >= 1 &&
      phaseTheme.modelNaming === 0 &&
      phaseTheme.hostRouting >= 2
    ) {
      issues.push(
        "PHASE.md does not match the phase description (model mapping); body is host-routing from a prior phase",
      );
    }
  }

  return { ok: issues.length === 0, issues };
}

export function resolveResearchFromAgentTurn(opts: {
  projectRoot: string;
  phaseId: string;
  agentOutput: string;
  beforeStats: FileStatSnapshot;
}): {
  doc: string;
  source: "agent_output" | "tool_write" | "none";
  path?: string;
  thin: boolean;
} {
  const watch = researchDocWatchPaths(opts.projectRoot, opts.phaseId);
  const changed = filesChangedSince(opts.beforeStats, watch);
  const candidates: Array<{
    doc: string;
    source: "agent_output" | "tool_write";
    path?: string;
  }> = [];

  for (const path of changed) {
    try {
      const raw = readFileSync(path, "utf-8");
      const doc = extractMarkdownDocument(raw);
      if (doc.trim()) {
        candidates.push({ doc, source: "tool_write", path });
      }
    } catch {
      /* ignore */
    }
  }

  const fromOutput = extractMarkdownDocument(opts.agentOutput);
  if (fromOutput.trim()) {
    candidates.push({ doc: fromOutput, source: "agent_output" });
  }

  candidates.sort((a, b) => {
    if (a.source === b.source) return 0;
    return a.source === "tool_write" ? -1 : 1;
  });

  for (const candidate of candidates) {
    if (!isThinResearch(candidate.doc)) {
      return {
        doc: candidate.doc,
        source: candidate.source,
        path: candidate.path,
        thin: false,
      };
    }
  }

  const fallback = candidates[0];
  if (fallback) {
    return {
      doc: fallback.doc,
      source: fallback.source,
      path: fallback.path,
      thin: isThinResearch(fallback.doc),
    };
  }

  return { doc: "", source: "none", thin: true };
}

/** Clip long / chat-dump phase descriptions for scaffold Scope (keep schema-valid). */
export function clipPhaseDescriptionForScaffold(
  description: string,
  maxChars = 500,
): string {
  const t = description.trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const breakAt = Math.max(
    cut.lastIndexOf("\n\n"),
    cut.lastIndexOf(". "),
    cut.lastIndexOf(".\n"),
  );
  const body =
    breakAt > maxChars * 0.35
      ? cut.slice(0, breakAt + (cut[breakAt] === "." ? 1 : 0)).trimEnd()
      : cut.trimEnd();
  return `${body}\n\n_(description clipped for scaffold)_`;
}

/**
 * Last-resort PHASE.md so drafting can reach in_review when the LLM only
 * narrates / writes to the wrong path and repair still fails.
 */
export function scaffoldPhaseDoc(opts: {
  phaseId: string;
  description: string;
  research?: string;
  testCommand?: string;
  /** When set with interaction, prefer failing closed in the orchestrator instead. */
  intent?: ChangeIntent | null;
  /** When set, design-bound shell/theme acceptance drives shell scaffold checks. */
  projectRoot?: string;
}): string {
  const clipped = clipPhaseDescriptionForScaffold(opts.description);
  const title =
    clipped.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim().slice(0, 80) ||
    opts.phaseId;
  const testCmd = opts.testCommand?.trim() || "npm test";
  const engagement = Boolean(
    opts.intent?.interaction && opts.intent.interaction.mount !== "n/a",
  );

  const acceptance =
    opts.projectRoot != null
      ? readPhaseDesignAcceptance(opts.projectRoot, opts.phaseId)
      : null;
  const pack =
    opts.projectRoot != null
      ? readPhaseDesignPack(opts.projectRoot, opts.phaseId)
      : null;
  const designShellOrTheme = Boolean(
    acceptance?.features.some(
      (f) =>
        f.accepted && (f.id === "theme_modes" || f.id === "applied_shell"),
    ) ||
      pack?.inScope?.includes("theme_modes") ||
      pack?.inScope?.includes("applied_shell"),
  );
  const contentAlignedShell = Boolean(
    pack?.inScope?.includes("applied_shell") &&
      pack.shell?.some((s) =>
        /content-max|menubar__inner|inner bar|Landing menubar/i.test(s),
      ),
  );
  const designBoundShell = designShellOrTheme || contentAlignedShell;

  // Do not paste research dumps into Scope for design-bound scaffolds — they
  // re-trigger claim-vs-proof ThemeToggle/content-max without matching checks.
  const researchExcerpt = designBoundShell
    ? ""
    : (opts.research ?? "").trim().slice(0, 1200);

  const brand = Boolean(
    !designBoundShell &&
      opts.intent &&
      (opts.intent.changeKind === "other" || !opts.intent.changeKind) &&
      changeIntentIsBrandTheming(opts.intent),
  );
  const mount = opts.intent?.interaction?.mount ?? opts.intent?.uiMount ?? "n/a";

  const successBlock = engagement
    ? `- Fillable UI at locked mount (${mount}) with enabled input and submit
- Automated Checks prove fill+submit (chat mounts also prove live AI SDK \`type: tool-<name>\` name resolution via parseToolResult / extractActiveForm)
- Manual smoke of the reported failure path succeeds when applicable`
    : designBoundShell
      ? `- ThemeToggle mounted in shell menubar and visible (utilities / tokens resolve)
- Menubar/JampressMenubar mounted in playground App **or** product layout shell (marketing/portal)
- Landing/content-max menubar inner bar uses \`var(--content-max)\` when applied_shell requires it
- Build succeeds (\`pnpm build\` / \`next build\` / \`vite build\` as applicable)`
      : brand
        ? `- Brand tokens / logos applied; no SlopControl tile+circle fallback SVGs under public/brand/
- Shells reference the new lockup (not unused orphan files only)
- Token names match family or PHASE documents intentional remaps
- Manual visual smoke vs sibling brand (JamPress / family) when applicable`
        : `- Change is implemented and builds
- Automated Checks pass
- Manual smoke of the reported failure path succeeds when applicable`;

  const shellChecksBlock = `\`\`\`bash
${testCmd}
\`\`\`

Structural (design shell — mount + content-max + visibility):

\`\`\`bash
grep -n '<ThemeToggle' src/components/layout/jampress-menubar.tsx src/components/shell/menubar.tsx 2>/dev/null | head -1 || grep -rn '<ThemeToggle' src --include='*menubar*' | head -1 || exit 1
grep -nE '--content-max|maxWidth.*content-max|max-w-\\[var\\(--content-max\\)\\]' src/components/layout/jampress-menubar.tsx src/components/shell/menubar.tsx 2>/dev/null | head -1 || grep -rnE '--content-max|maxWidth.*content-max' src --include='*menubar*' | head -1 || exit 1
grep -n 'JampressMenubar\\|<Menubar' src/components/layout/marketing-shell.tsx src/components/layout/portal-shell.tsx playground/src/App.tsx 2>/dev/null | head -1 || grep -rn 'JampressMenubar\\|<Menubar' src/components/layout playground/src --include='*.tsx' | head -1 || exit 1
pnpm build || npm run build || npx next build || pnpm exec vite build || exit 1
grep -qE 'text-text-secondary|--text-secondary' src/app/globals.css node_modules/@jamroast/components/dist/styles/*.css playground/src/index.css 2>/dev/null || exit 1
\`\`\``;

  const checksBlock = engagement
    ? `\`\`\`bash
${testCmd}
\`\`\`

Structural (engagement — fill+submit at mount; chat mounts also prove live tool-part shape, not chip-only):

\`\`\`bash
grep -qE 'parseToolResult|extractActiveForm|tool-' . || exit 1
\`\`\``
    : designBoundShell
      ? shellChecksBlock
      : brand
        ? `\`\`\`bash
${testCmd}
\`\`\`

Structural (brand — reject design fallbacks + glued wordmarks):

\`\`\`bash
! grep -Rql 'Status:\\*\\* draft' public/brand 2>/dev/null || exit 1
! grep -RqlE '<circle[^>]+r="72".*<text' public/brand 2>/dev/null || exit 1
! grep -RqlE '>JamLight<|>JamPress<' public/brand 2>/dev/null || exit 1
\`\`\``
        : `\`\`\`bash
${testCmd}
\`\`\``;

  const requiresDesign =
    brand || designBoundShell ? "Requires design pass: yes\n\n" : "";

  return `# Phase ${opts.phaseId}: ${title}

${requiresDesign}## Scope

${clipped || "Investigate and fix per the phase description."}

${
  researchExcerpt
    ? `### Research notes\n\n${researchExcerpt}\n`
    : designBoundShell
      ? "Implement accepted design shell/theme contract (DESIGN_PACK / mock). Do not invent competing chrome.\n"
      : "Investigate and fix per the phase description. Research was thin; re-check the codebase during implementation.\n"
}

${
  brand
    ? `## Brand

Port sibling theming; produce cleaner logo/wordmark set.

## Assets
| Name | Filename | Prompt |
| --- | --- | --- |
| logo | logo.png | Cleaner jam-family brand mark aligned with sibling craft |
`
    : ""
}## File Changes

- TBD during development (derive from Scope and Research)

## Success Criteria

${successBlock}

## Automated Checks

${checksBlock}

## Blueprint Deltas

None (scaffold — update during development if durable design changes are made).
`;
}

export function scaffoldResearch(opts: {
  phaseId: string;
  description: string;
}): string {
  return `# Research: ${opts.description.trim().slice(0, 80) || opts.phaseId}

## Summary

Scaffolded research — the research agent returned empty or chat-only output.
Re-run research or expand during phase review.

## Problem

${opts.description.trim()}

## Codebase notes

Not collected (agent output was thin). Coding should inspect relevant files before editing.

## Risks

- Incomplete context; verify assumptions against source before implementing.
`;
}

/**
 * When OLLAMA_BASE_URL points at Ollama Cloud (live smoke only), model IDs
 * should include a tag. Develop gates should use llmTestProfile=local/fixture
 * instead of free-tier cloud workarounds.
 */
export function verifyOllamaCloudModelIds(projectRoot: string): {
  ok: boolean;
  output: string;
  remediation: string[];
  env: Record<string, string>;
} {
  const dockerPath = join(projectRoot, ".env.docker");
  const localPath = join(projectRoot, ".env.local");
  const dockerEnv = loadDotEnvFile(dockerPath);
  const localEnv = loadDotEnvFile(localPath);
  const env =
    Object.keys(dockerEnv).length > 0
      ? { ...localEnv, ...dockerEnv }
      : { ...dockerEnv, ...localEnv };

  const base = env.OLLAMA_BASE_URL ?? "";
  if (!/ollama\.cloud|api\.ollama/i.test(base)) {
    return {
      ok: true,
      output: "Ollama Cloud model-id check skipped (not an Ollama Cloud base URL).",
      remediation: [],
      env,
    };
  }

  const bad: string[] = [];
  const remediation: string[] = [];
  for (const key of ["AI_CHAT_MODEL", "AI_CODE_MODEL"] as const) {
    const value = env[key]?.trim();
    if (!value) continue;
    if (!value.includes(":")) {
      bad.push(`${key}=${value}`);
      remediation.push(
        `For live cloud smoke, set ${key} to a tagged model id in .env.docker (e.g. glm-5.2:cloud). Prefer SlopControl llmTestProfile=local / llmSmokeMode=off for develop gates.`,
      );
    }
  }

  if (bad.length > 0) {
    remediation.push(
      "Do NOT have the coding agent curl Ollama with API keys.",
      "Do NOT switch product models to free-tier cloud IDs to pass verify.",
      "Use llmTestProfile=local (or fixture) and llmModelMap, or set pipeline OLLAMA_* env vars.",
      "For live runtime only: edit .env.docker, sync worktree env, recreate containers as needed.",
    );
    return {
      ok: false,
      output: [
        `Ollama Cloud model IDs missing a tag: ${bad.join(", ")}.`,
        ...remediation.map((r) => `- ${r}`),
      ].join("\n"),
      remediation,
      env,
    };
  }

  return {
    ok: true,
    output: "Ollama Cloud model IDs include a tag.",
    remediation: [],
    env,
  };
}

/**
 * Chat smoke against a resolved env (local test or live cloud).
 * Prefer gating via ProjectConfig.llmSmokeMode (default off).
 * Legacy skip: SLOPCONTROL_SKIP_OLLAMA_SMOKE=1.
 */
export async function verifyOllamaCloudChatAccess(
  projectRoot: string,
  opts?: {
    env?: Record<string, string>;
    label?: string;
  },
): Promise<{
  ok: boolean;
  output: string;
  remediation: string[];
}> {
  if (process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE === "1") {
    return {
      ok: true,
      output: "Ollama chat smoke skipped (SLOPCONTROL_SKIP_OLLAMA_SMOKE=1).",
      remediation: [],
    };
  }

  const label = opts?.label ?? "Ollama Cloud chat smoke";
  const staticCheck = opts?.env
    ? {
        ok: true as const,
        output: "",
        remediation: [] as string[],
        env: opts.env,
      }
    : verifyOllamaCloudModelIds(projectRoot);
  const env = staticCheck.env;
  const base = (env.OLLAMA_BASE_URL ?? "").replace(/\/$/, "");
  if (!base) {
    return {
      ok: false,
      output: `${label} FAILED: OLLAMA_BASE_URL missing.`,
      remediation: [
        "Set OLLAMA_BASE_URL via process.env, .env.test, or llmTestProfile=local defaults",
      ],
    };
  }

  if (!opts?.env && !/ollama\.cloud|api\.ollama/i.test(base)) {
    return {
      ok: true,
      output: `${label} skipped (not an Ollama Cloud base URL).`,
      remediation: [],
    };
  }

  if (!opts?.env && !staticCheck.ok) {
    return staticCheck;
  }

  const apiKey = env.OLLAMA_API_KEY?.trim();
  const model = env.AI_CHAT_MODEL?.trim();
  if (!apiKey) {
    return {
      ok: false,
      output: `${label} FAILED: OLLAMA_API_KEY missing.`,
      remediation: [
        "Set OLLAMA_API_KEY in process.env / .env.test (local) or .env.docker (live smoke only)",
        "Do not fall back to free-tier Ollama Cloud",
      ],
    };
  }
  if (!model) {
    return {
      ok: false,
      output: `${label} FAILED: AI_CHAT_MODEL missing.`,
      remediation: [
        "Set AI_CHAT_MODEL via process.env, .env.test, or llmModelMap",
      ],
    };
  }

  const url = `${base}/chat/completions`;
  const timeoutMs = Math.max(
    10_000,
    Number(process.env.SLOPCONTROL_OLLAMA_SMOKE_MS ?? 60_000) || 60_000,
  );
  const maxAttempts = Math.max(
    1,
    Number(process.env.SLOPCONTROL_OLLAMA_SMOKE_RETRIES ?? 2) || 2,
  );

  let lastError = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 4,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const bodyText = await res.text();
      const bodySafe = bodyText.replace(apiKey, "***").slice(0, 400);

      if (res.status === 200) {
        return {
          ok: true,
          output: `${label} OK for AI_CHAT_MODEL=${model} (key reaches API${attempt > 1 ? `, attempt ${attempt}` : ""}).`,
          remediation: [],
        };
      }

      if (res.status === 429) {
        return {
          ok: false,
          output: [
            `${label} FAILED: HTTP 429 (quota / rate limit) for AI_CHAT_MODEL=${model}.`,
            `API response (redacted): ${bodySafe}`,
            "- Infra: wait for quota reset, or use llmTestProfile=local / llmSmokeMode=off",
            "- Do NOT switch product models to free-tier cloud IDs",
          ].join("\n"),
          remediation: [
            "Set llmSmokeMode=off or llmTestProfile=local; do not burn iterations on free-tier model swaps",
          ],
        };
      }

      if (res.status === 401 || res.status === 403) {
        const subscription = /subscription|upgrade for access/i.test(bodyText);
        if (subscription) {
          const remediation = [
            `AI_CHAT_MODEL=${model} is not entitled on this account (403 subscription).`,
            "For develop/verify: use llmTestProfile=local with llmModelMap (or fixture) — do NOT switch to free-tier cloud models.",
            "For live runtime only: use an entitled cloud model in .env.docker and recreate containers.",
            "Do NOT have the coding agent curl with secrets — SlopControl already probed entitlement.",
          ];
          return {
            ok: false,
            output: [
              `${label} FAILED: model entitlement 403 for AI_CHAT_MODEL=${model}.`,
              `API response (redacted): ${bodySafe}`,
              ...remediation.map((r) => `- ${r}`),
            ].join("\n"),
            remediation,
          };
        }
        return {
          ok: false,
          output: [
            `${label} FAILED: HTTP ${res.status} (auth/key problem) for model=${model}.`,
            `API response (redacted): ${bodySafe}`,
            "- Check OLLAMA_API_KEY in process.env / .env.test / .env.docker",
            "- Ensure worktree sync copied env files from project root",
          ].join("\n"),
          remediation: [
            "Fix OLLAMA_API_KEY and re-sync worktree env; prefer local test profile for gates",
          ],
        };
      }

      return {
        ok: false,
        output: [
          `${label} FAILED: HTTP ${res.status} for AI_CHAT_MODEL=${model}.`,
          `API response (redacted): ${bodySafe}`,
          "- Prefer llmTestProfile=local + llmModelMap over free-tier cloud fallbacks",
        ].join("\n"),
        remediation: [
          "Use local Ollama / pipeline env; do not switch to free-tier cloud models",
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = message.replace(apiKey, "***");
      const isTimeout = /aborted|timeout|TimeoutError/i.test(message);
      if (isTimeout && attempt < maxAttempts) {
        continue;
      }
      if (isTimeout && process.env.SLOPCONTROL_OLLAMA_SMOKE_SOFT === "1") {
        return {
          ok: true,
          output: `${label} timed out after ${maxAttempts} attempt(s) (${timeoutMs}ms) — treating as soft OK (SLOPCONTROL_OLLAMA_SMOKE_SOFT=1). Last error: ${lastError}`,
          remediation: [],
        };
      }
      return {
        ok: false,
        output: [
          `${label} errored after ${attempt} attempt(s): ${lastError}`,
          `- Network/API issue — increase SLOPCONTROL_OLLAMA_SMOKE_MS (current ${timeoutMs}) or set llmSmokeMode=off`,
        ].join("\n"),
        remediation: [
          "Check endpoint reachability (local Ollama or cloud)",
          `Increase SLOPCONTROL_OLLAMA_SMOKE_MS (was ${timeoutMs})`,
          "Or set llmSmokeMode=off / SLOPCONTROL_SKIP_OLLAMA_SMOKE=1",
        ],
      };
    }
  }

  return {
    ok: false,
    output: `${label} errored: ${lastError}`,
    remediation: ["Check endpoint reachability"],
  };
}

/** APPENDIX body when env/model gate fails. */
export function envModelFailureAppendix(verifyOutput: string): string {
  return `## Env / model gate failure

${verifyOutput}

Instructions for the coding tool (no live curls with secrets — SlopControl already probed):
1. Do **not** switch product models to free-tier Ollama Cloud IDs to pass verify.
2. Prefer SlopControl \`llmTestProfile=local\` (local Ollama + \`llmModelMap\`) or \`fixture\`; set \`OLLAMA_*\` via process.env / pipelines when needed.
3. Ensure gitignored \`.env*\` / \`.env.test\` are synced from project root into the worktree.
4. For live runtime only: fix \`.env.docker\` with an entitled model, then recreate containers.
5. Add/adjust local unit tests under the test profile; run Automated Checks.
`;
}

/**
 * Detect coding-session derail patterns (secret curls, long sleep+curl loops).
 * Must stay aligned with @slopcontrol/coding-tools probe-abuse
 * (Bearer only for non-local hosts; curl→URL shape for cloud).
 */
export function detectCodingProbeAbuse(text: string): string | null {
  if (!text) return null;

  const bearerSegments =
    text.match(/\bcurl\b[^\n]{0,400}Authorization:\s*Bearer[^\n]{0,400}/gi) ??
    [];
  const localHttp =
    /https?:\/\/(?:127\.0\.0\.1|localhost|host\.docker\.internal)(?::\d+)?(?:\/|\s|$|"|')|https?:\/\/ollama(?::\d+)?(?:\/|\s|$|"|')/i;
  const nonLocalHttp =
    /https?:\/\/(?!127\.0\.0\.1(?::\d+)?(?:\/|\s|$|"|')|localhost(?::\d+)?(?:\/|\s|$|"|')|host\.docker\.internal(?::\d+)?(?:\/|\s|$|"|')|ollama(?::\d+)?(?:\/|\s|$|"|'))[^\s"'\\]+/i;
  for (const segment of bearerSegments) {
    if (localHttp.test(segment)) continue;
    if (
      nonLocalHttp.test(segment) ||
      /api\.ollama\.cloud|ollama\.com/i.test(segment)
    ) {
      return "Coding session used curl with Authorization Bearer (secret probe). Abort and edit files instead.";
    }
  }

  if (/sleep\s+\d+\s*&&\s*curl\b/i.test(text)) {
    return "Coding session ran sleep+curl probe loops. Abort and edit files instead.";
  }
  if (
    /\bcurl\b\s+[^\n]{0,300}(?:session usage limit|upgrade for higher limits)/i.test(
      text,
    )
  ) {
    return "Coding session hit Ollama rate limits while probing. Abort; do not wait/retry live APIs.";
  }
  if (
    /\bcurl\b\s+[^\n]{0,200}https?:\/\/api\.ollama\.cloud\/v1\/(?:chat|models)/i.test(
      text,
    )
  ) {
    return "Coding session probed Ollama Cloud HTTP APIs. Abort and rely on local Automated Checks.";
  }
  return null;
}

/**
 * Verify DB phase artifacts: init-db.sql and/or drizzle must contain CREATE TABLE.
 * Extension-only init-db.sql (vector bootstrap) is allowed when drizzle has DDL.
 */
export function verifyDatabaseArtifacts(projectRoot: string): {
  ok: boolean;
  output: string;
} {
  const candidates = [
    join(projectRoot, "docker", "init-db.sql"),
    join(projectRoot, "init-db.sql"),
  ];

  const initNotes: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const sql = readFileSync(path, "utf-8");
    if (/CREATE\s+TABLE/i.test(sql)) {
      return {
        ok: true,
        output: `Database DDL present in ${path} (CREATE TABLE found).`,
      };
    }
    initNotes.push(
      `${path} is present without CREATE TABLE (extension-only bootstrap OK if drizzle has DDL).`,
    );
  }

  const drizzleDir = join(projectRoot, "drizzle");
  if (existsSync(drizzleDir)) {
    for (const name of readdirSync(drizzleDir)) {
      if (!name.endsWith(".sql")) continue;
      const sql = readFileSync(join(drizzleDir, name), "utf-8");
      if (/CREATE\s+TABLE/i.test(sql)) {
        return {
          ok: true,
          output: [
            ...initNotes,
            `Database DDL present in drizzle/${name}.`,
          ]
            .filter(Boolean)
            .join(" "),
        };
      }
    }
  }

  return {
    ok: false,
    output: [
      ...initNotes,
      "No CREATE TABLE found in docker/init-db.sql, init-db.sql, or drizzle/*.sql — DB phase incomplete.",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
