import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChangeIntent } from "./change-intent.js";
import { extractSection } from "./markdown.js";
import { writeChangeIntent } from "./change-intent.js";
import { readLatestHandoffForPhase } from "./development-handoff.js";

export type IntentReconcileResult = {
  updated: boolean;
  patches: string[];
  intent: ChangeIntent;
};

/** One-line + detail for chat when research lands in_review. */
export function extractResearchConclusion(research: string): string {
  const trimmed = research.trim();
  if (!trimmed) return "";

  const summary =
    extractSection(trimmed, /^##\s+Summary\s*$/im)?.trim() ??
    trimmed.match(/^#\s+RESEARCH[^\n]*\n+([\s\S]*?)(?=\n##\s|\n###\s|$)/im)?.[1]?.trim() ??
    "";

  const recommendation =
    extractSection(trimmed, /^###\s+Recommendation\b/im)?.trim() ??
    extractSection(trimmed, /^##\s+Recommendation\b/im)?.trim() ??
    "";

  const conflict =
    trimmed.match(/##\s*⚠?\s*Critical conflict:[^\n]*\n([\s\S]*?)(?=\n##\s|\n###\s+Recommendation|$)/im)?.[1]?.trim() ??
    "";

  const parts: string[] = [];
  if (summary) {
    parts.push(summary.split("\n").filter(Boolean).slice(0, 3).join(" "));
  }
  if (recommendation) {
    parts.push(
      `Recommendation: ${recommendation.split("\n").filter(Boolean).slice(0, 2).join(" ")}`,
    );
  } else if (conflict) {
    const tail = conflict.split("\n").filter(Boolean).slice(-2).join(" ");
    if (tail) parts.push(`Conflict resolved: ${tail}`);
  }

  const oneLiner = parts.join(" ").replace(/\s+/g, " ").trim();
  if (oneLiner.length <= 900) return oneLiner;
  return `${oneLiner.slice(0, 897)}…`;
}

export function readResearchConclusionForPhase(
  projectRoot: string,
  phaseId: string,
): string {
  const path = join(projectRoot, ".slopcontrol", "phases", phaseId, "RESEARCH.md");
  if (!existsSync(path)) return "";
  try {
    return extractResearchConclusion(readFileSync(path, "utf-8"));
  } catch {
    return "";
  }
}

/**
 * Annotate (never rewrite) INTENT.json with a research-backed correction.
 * Conflict DETECTION is the caller's job (LLM classification in
 * packages/llm — never regex). The operator's goal/rawDescription stay
 * verbatim; corrections go to mustNot + a researchNote line so the planner
 * sees both the original ask and the research-backed adjustment.
 */
export function reconcileChangeIntentFromResearch(
  projectRoot: string,
  phaseId: string,
  intent: ChangeIntent,
  conflict: { rejectedWording: string; correction?: string } | null,
): IntentReconcileResult {
  const patches: string[] = [];
  const next = { ...intent };
  let updated = false;

  if (conflict?.rejectedWording?.trim()) {
    const wording = conflict.rejectedWording.trim();
    const correction = conflict.correction?.trim();
    const note = `Research overrides intent wording "${wording}"${correction ? ` — ${correction}` : ""} — implement per RESEARCH.md, not the original phrasing`;
    if (!next.mustNot.some((m) => m.includes(wording))) {
      next.mustNot = [
        ...next.mustNot,
        `Do not use ${wording} — research flags it as unsafe for this phase`,
      ];
      patches.push(`Flagged research-rejected wording "${wording}" in mustNot`);
      updated = true;
    }
    const existing = (next as { researchNote?: string }).researchNote ?? "";
    if (!existing.includes(wording)) {
      (next as { researchNote?: string }).researchNote = existing
        ? `${existing} ${note}`
        : note;
      updated = true;
    }
  }

  if (updated) {
    writeChangeIntent(projectRoot, phaseId, next);
  }

  return { updated, patches, intent: next };
}

export type HandoffFollowUpSuggestion = {
  phaseId: string;
  nextStep: string;
  /** Ready-to-paste start_change description snippet when actionable. */
  startChangeBrief?: string;
};

function isActionableNextStep(step: string): boolean {
  const s = step.trim();
  if (!s || /^review operator requirements/i.test(s)) return false;
  if (/^start the next change/i.test(s)) return false;
  return s.length > 12;
}

function briefFromNextStep(step: string, knowledge: string[]): string | undefined {
  if (!isActionableNextStep(step)) return undefined;
  const lines = [
    `Title: ${step.slice(0, 120)}`,
    "",
    `Goal: ${step}`,
  ];
  const externals = knowledge.find((k) => /--external:[^\s]+/.test(k));
  if (externals) {
    lines.push("", "Constraints from prior phase:", `- ${externals.slice(0, 300)}`);
  }
  lines.push(
    "",
    "Success criteria:",
    "- Change is implemented and builds",
    "- Automated Checks pass",
  );
  return lines.join("\n");
}

/** Latest complete phase handoffs → suggested follow-up work (for operator-suggestions API). */
export function collectHandoffFollowUpSuggestions(
  projectRoot: string,
  limit = 3,
): HandoffFollowUpSuggestion[] {
  const phasesDir = join(projectRoot, ".slopcontrol", "phases");
  if (!existsSync(phasesDir)) return [];

  let names: string[] = [];
  try {
    names = readdirSync(phasesDir)
      .filter((n) => !n.startsWith("."))
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const out: HandoffFollowUpSuggestion[] = [];
  for (const phaseId of names) {
    if (out.length >= limit) break;
    const handoff = readLatestHandoffForPhase(projectRoot, phaseId);
    if (!handoff || handoff.outcome !== "complete") continue;
    for (const step of handoff.nextSteps) {
      if (!isActionableNextStep(step)) continue;
      out.push({
        phaseId,
        nextStep: step,
        startChangeBrief: briefFromNextStep(step, handoff.knowledge),
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Estate constraint notes for operator-suggestions: surfaced from the
 * research conflict section via structural markdown extraction (generic),
 * not hardcoded package knowledge. Returns null when research names no
 * constraint section.
 */
export function detectResearchConstraintNote(research: string): string | null {
  const conflict = extractSection(research, /conflict/i);
  if (!conflict?.trim()) return null;
  const line = conflict.split("\n").filter(Boolean).slice(0, 2).join(" ");
  return line ? `Research constraint: ${line.slice(0, 400)}` : null;
}
