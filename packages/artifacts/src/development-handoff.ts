import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractSection } from "./markdown.js";

function slopRoot(projectRoot: string): string {
  return join(projectRoot, ".slopcontrol");
}

function phaseDir(projectRoot: string, phaseId: string): string {
  return join(slopRoot(projectRoot), "phases", phaseId);
}

function runDir(projectRoot: string, runId: string): string {
  return join(slopRoot(projectRoot), "runs", runId);
}

function ensurePhaseDir(projectRoot: string, phaseId: string): string {
  const dir = phaseDir(projectRoot, phaseId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureRunDir(projectRoot: string, runId: string): string {
  const dir = runDir(projectRoot, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type HandoffOutcome = "complete" | "blocked" | "interrupted";

export type HandoffRequirementStatus = "met" | "unmet" | "unknown";

export type HandoffRequirement = {
  text: string;
  status: HandoffRequirementStatus;
};

export type HandoffMergeInfo = {
  autoMerged: boolean;
  worktreePresent: boolean;
  branch?: string;
  commit?: string;
  /** False when a pre-merge operator stash could not be restored */
  stashRestored?: boolean;
  /** Stash ref left behind when stashRestored is false */
  stashRef?: string | null;
};

export type HandoffDiagnosisSnippet = {
  fingerprint?: string;
  title?: string;
  class?: string;
  rootCause?: string;
  operatorActions?: string[];
  /** Latest diagnosis nextActions for coding retry routing. */
  nextActions?: string;
  /** Classifier tags (long-lived, host-utility, …). */
  tags?: string[];
};

export type DevelopmentHandoff = {
  outcome: HandoffOutcome;
  phaseId: string;
  runId: string;
  updatedAt: string;
  summary: string;
  requirements: HandoffRequirement[];
  knowledge: string[];
  operatorRequirements: string[];
  nextSteps: string[];
  merge: HandoffMergeInfo;
  diagnosis?: HandoffDiagnosisSnippet;
  checksSummary?: string;
  source: "agent_appendix" | "orchestrator" | "both";
};

export type HarvestedOperatorHandoff = {
  operatorRequirements: string[];
  knowledge: string[];
  followUps: string[];
  found: boolean;
};

/** Extract bullet / numbered-list lines from a markdown subsection body. */
export function extractBulletLines(sectionBody: string | null): string[] {
  if (!sectionBody?.trim()) return [];
  const out: string[] = [];
  for (const line of sectionBody.split("\n")) {
    const m =
      /^\s*[-*+]\s+(.+)$/.exec(line) ??
      /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (!m?.[1]) continue;
    const text = m[1].trim();
    if (!text || /^none\.?$/i.test(text)) continue;
    out.push(text);
  }
  return out;
}

/**
 * Parse PHASE ## Success Criteria items (bullets or numbered lists).
 * Prefers the bold title on a numbered criterion when present.
 */
export function extractSuccessCriteriaBullets(phaseDoc: string): string[] {
  const body = extractSection(phaseDoc, "Success Criteria");
  if (!body?.trim()) return [];

  const items: string[] = [];
  const lines = body.split("\n");
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const joined = current.join(" ").replace(/\s+/g, " ").trim();
    current = [];
    if (!joined || /^none\.?$/i.test(joined)) return;
    // Prefer "**Title**" lead-in when authors use numbered bold headings
    const bold = /^\*\*(.+?)\*\*/.exec(joined);
    if (bold?.[1] && bold[1].length >= 8) {
      items.push(bold[1].trim());
      return;
    }
    items.push(joined.slice(0, 240));
  };

  for (const line of lines) {
    const bullet =
      /^\s*[-*+]\s+(.+)$/.exec(line) ?? /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet?.[1]) {
      flush();
      current = [bullet[1].trim()];
      continue;
    }
    // Continuation under a numbered/bulleted item (indented or bare prose)
    if (current.length > 0 && line.trim() && !/^#{1,3}\s/.test(line)) {
      // Skip fenced code / pure command-only continuations for the handoff title
      if (/^```/.test(line.trim())) continue;
      if (/^`[^`]+`$/.test(line.trim())) continue;
      continue;
    }
  }
  flush();

  // Fallback: flat bullet extract if block parser found nothing
  if (items.length === 0) {
    return extractBulletLines(body);
  }
  return items;
}

/**
 * Harvest `## Operator handoff` from APPENDIX.md (or any markdown).
 * Subheads: Operator requirements, Knowledge, Follow-ups.
 */
export function harvestOperatorHandoffFromAppendix(
  appendix: string,
): HarvestedOperatorHandoff {
  const body = extractSection(appendix, /Operator\s+handoff/i);
  if (!body?.trim()) {
    return {
      operatorRequirements: [],
      knowledge: [],
      followUps: [],
      found: false,
    };
  }

  const reqBody =
    extractSubsection(body, /Operator\s+requirements/i) ??
    extractSubsection(body, /Requirements/i);
  const knowledgeBody = extractSubsection(body, /Knowledge/i);
  const followBody =
    extractSubsection(body, /Follow-?ups/i) ??
    extractSubsection(body, /Next\s+steps/i);

  return {
    operatorRequirements: extractBulletLines(reqBody),
    knowledge: extractBulletLines(knowledgeBody),
    followUps: extractBulletLines(followBody),
    found: true,
  };
}

/** Extract ### Subsection until next ### or end. */
function extractSubsection(
  markdown: string,
  title: RegExp,
): string | null {
  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^###\s+/.test(line) && title.test(line.replace(/^###\s+/, ""))) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^###\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start, end).join("\n").trim();
  return body || null;
}

export function buildRequirementsFromPhase(
  phaseDoc: string,
  checksOk: boolean | undefined,
): HandoffRequirement[] {
  const bullets = extractSuccessCriteriaBullets(phaseDoc);
  if (bullets.length === 0) {
    return [
      {
        text: "PHASE Success Criteria (none listed)",
        status:
          checksOk === true ? "met" : checksOk === false ? "unmet" : "unknown",
      },
    ];
  }
  const status: HandoffRequirementStatus =
    checksOk === true ? "met" : checksOk === false ? "unmet" : "unknown";
  return bullets.map((text) => ({ text, status }));
}

export function formatHandoffMarkdown(handoff: DevelopmentHandoff): string {
  const lines: string[] = [
    `# Development handoff — ${handoff.phaseId}`,
    "",
    `- **Outcome:** ${handoff.outcome}`,
    `- **Run:** ${handoff.runId}`,
    `- **Updated:** ${handoff.updatedAt}`,
    "",
    "## Summary",
    "",
    handoff.summary,
    "",
    "## Requirements",
    "",
  ];
  for (const r of handoff.requirements) {
    lines.push(`- [${r.status}] ${r.text}`);
  }
  if (handoff.requirements.length === 0) lines.push("- (none)");

  lines.push("", "## Operator requirements", "");
  if (handoff.operatorRequirements.length === 0) {
    lines.push("- None");
  } else {
    for (const r of handoff.operatorRequirements) lines.push(`- ${r}`);
  }

  lines.push("", "## Knowledge", "");
  if (handoff.knowledge.length === 0) {
    lines.push("- None");
  } else {
    for (const k of handoff.knowledge) lines.push(`- ${k}`);
  }

  lines.push("", "## Next steps", "");
  if (handoff.nextSteps.length === 0) {
    lines.push("- None");
  } else {
    for (const s of handoff.nextSteps) lines.push(`- ${s}`);
  }

  lines.push(
    "",
    "## Merge",
    "",
    `- autoMerged: ${handoff.merge.autoMerged}`,
    `- worktreePresent: ${handoff.merge.worktreePresent}`,
  );
  if (handoff.merge.branch) lines.push(`- branch: ${handoff.merge.branch}`);
  if (handoff.merge.commit) lines.push(`- commit: ${handoff.merge.commit}`);
  if (handoff.merge.stashRestored === false) {
    lines.push(`- stashRestored: false`);
    if (handoff.merge.stashRef) {
      lines.push(`- stashRef: ${handoff.merge.stashRef}`);
    }
  }

  if (handoff.diagnosis) {
    lines.push("", "## Diagnosis", "");
    if (handoff.diagnosis.title) lines.push(`- title: ${handoff.diagnosis.title}`);
    if (handoff.diagnosis.class) lines.push(`- class: ${handoff.diagnosis.class}`);
    if (handoff.diagnosis.fingerprint) {
      lines.push(`- fingerprint: ${handoff.diagnosis.fingerprint}`);
    }
    for (const a of handoff.diagnosis.operatorActions ?? []) {
      lines.push(`- action: ${a}`);
    }
  }

  if (handoff.checksSummary?.trim()) {
    lines.push("", "## Checks summary", "", handoff.checksSummary.trim().slice(0, 2000));
  }

  lines.push("");
  return lines.join("\n");
}

export type BuildHandoffInput = {
  outcome: HandoffOutcome;
  phaseId: string;
  runId: string;
  phaseDoc: string;
  appendix: string;
  checksOk?: boolean;
  checksSummary?: string;
  merge?: Partial<HandoffMergeInfo>;
  diagnosis?: HandoffDiagnosisSnippet;
  worktreeBranch?: string;
};

export function buildDevelopmentHandoff(
  input: BuildHandoffInput,
): DevelopmentHandoff {
  const harvested = harvestOperatorHandoffFromAppendix(input.appendix);
  const requirements = buildRequirementsFromPhase(
    input.phaseDoc,
    input.checksOk,
  );

  const knowledge = [...harvested.knowledge];
  const operatorRequirements = [...harvested.operatorRequirements];
  const nextSteps = [...harvested.followUps];

  if (input.outcome === "complete") {
    if (nextSteps.length === 0) {
      nextSteps.push(
        "Review operator requirements above, then start the next change or phase.",
      );
    }
    if (
      input.merge?.autoMerged === false &&
      input.merge?.worktreePresent !== false
    ) {
      nextSteps.unshift(
        "Call MCP merge_phase if the phase worktree was not auto-merged.",
      );
    }
  } else if (input.outcome === "blocked") {
    if (input.diagnosis?.operatorActions?.length) {
      for (const a of input.diagnosis.operatorActions) {
        if (!operatorRequirements.includes(a)) operatorRequirements.push(a);
      }
    }
    const infraBlocked =
      input.diagnosis?.class === "infra" ||
      input.diagnosis?.tags?.some((t) =>
        /^(infra|runtime-dependency|db|postgres|redis)$/.test(t),
      );
    if (input.merge?.autoMerged && input.merge?.commit) {
      nextSteps.unshift(
        "Phase merged but root verify failed — call MCP retry_root_verify to re-run post-merge checks on project root (no coding).",
      );
    } else if (infraBlocked) {
      nextSteps.unshift(
        "Call MCP get_operator_suggestions for remediation, then retry_root_verify after restoring runtime dependencies (do not retry_development — the same verify command will fail the same way).",
      );
    } else {
      nextSteps.unshift(
        "Call MCP get_operator_suggestions for remediation, then retry_development.",
      );
    }
    if (!knowledge.some((k) => /blocked|diagnosis/i.test(k))) {
      knowledge.push(
        input.diagnosis?.title
          ? `Develop blocked: ${input.diagnosis.title}`
          : "Develop blocked — see diagnosis and APPENDIX.",
      );
    }
  } else {
    nextSteps.unshift(
      "Development was interrupted. Resume with retry_development when ready.",
    );
  }

  let summary: string;
  if (input.outcome === "complete") {
    summary = `Phase ${input.phaseId} development completed successfully.`;
    if (operatorRequirements.length > 0) {
      summary += ` ${operatorRequirements.length} follow-up note(s) recorded for the operator.`;
    }
  } else if (input.outcome === "blocked") {
    summary = `Phase ${input.phaseId} development blocked${
      input.diagnosis?.title ? `: ${input.diagnosis.title}` : "."
    }`;
  } else {
    summary = `Phase ${input.phaseId} development interrupted before completion.`;
  }

  const source: DevelopmentHandoff["source"] = harvested.found
    ? "both"
    : "orchestrator";

  return {
    outcome: input.outcome,
    phaseId: input.phaseId,
    runId: input.runId,
    updatedAt: new Date().toISOString(),
    summary,
    requirements,
    knowledge,
    operatorRequirements,
    nextSteps,
    merge: {
      autoMerged: input.merge?.autoMerged ?? false,
      worktreePresent: input.merge?.worktreePresent ?? true,
      branch: input.merge?.branch ?? input.worktreeBranch,
      commit: input.merge?.commit,
      stashRestored: input.merge?.stashRestored,
      stashRef: input.merge?.stashRef,
    },
    // Never carry a prior failure diagnosis into a successful complete handoff
    diagnosis: input.outcome === "complete" ? undefined : input.diagnosis,
    checksSummary: input.checksSummary?.slice(0, 4000),
    source,
  };
}

export function phaseHandoffJsonPath(
  projectRoot: string,
  phaseId: string,
): string {
  return join(phaseDir(projectRoot, phaseId), "handoff.json");
}

export function phaseHandoffMdPath(
  projectRoot: string,
  phaseId: string,
): string {
  return join(phaseDir(projectRoot, phaseId), "HANDOFF.md");
}

export function runHandoffJsonPath(projectRoot: string, runId: string): string {
  return join(runDir(projectRoot, runId), "handoff.json");
}

export function writeDevelopmentHandoff(
  projectRoot: string,
  opts: { phaseId: string; runId: string; handoff: DevelopmentHandoff },
): { phaseJson: string; runJson: string; phaseMd: string } {
  ensurePhaseDir(projectRoot, opts.phaseId);
  ensureRunDir(projectRoot, opts.runId);
  const payload = {
    ...opts.handoff,
    phaseId: opts.phaseId,
    runId: opts.runId,
    updatedAt: opts.handoff.updatedAt || new Date().toISOString(),
  };
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  const md = formatHandoffMarkdown(payload);
  const phaseJson = phaseHandoffJsonPath(projectRoot, opts.phaseId);
  const runJson = runHandoffJsonPath(projectRoot, opts.runId);
  const phaseMd = phaseHandoffMdPath(projectRoot, opts.phaseId);
  writeFileSync(phaseJson, json, "utf-8");
  writeFileSync(runJson, json, "utf-8");
  writeFileSync(phaseMd, md, "utf-8");
  return { phaseJson, runJson, phaseMd };
}

export function readRunHandoff(
  projectRoot: string,
  runId: string,
): DevelopmentHandoff | null {
  const path = runHandoffJsonPath(projectRoot, runId);
  return readHandoffFile(path);
}

export function readLatestHandoffForPhase(
  projectRoot: string,
  phaseId: string,
): DevelopmentHandoff | null {
  const path = phaseHandoffJsonPath(projectRoot, phaseId);
  return readHandoffFile(path);
}

function readHandoffFile(path: string): DevelopmentHandoff | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as DevelopmentHandoff;
    if (!parsed?.outcome || !parsed?.phaseId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export type HandoffSummary = {
  outcome: HandoffOutcome;
  summary: string;
  operatorRequirementsCount: number;
  updatedAt: string;
};

export function handoffSummary(
  handoff: DevelopmentHandoff | null,
): HandoffSummary | null {
  if (!handoff) return null;
  return {
    outcome: handoff.outcome,
    summary: handoff.summary,
    operatorRequirementsCount: handoff.operatorRequirements.length,
    updatedAt: handoff.updatedAt,
  };
}
