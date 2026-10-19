/**
 * Pure prompt-window helpers for planning agents and judges.
 *
 * Extracted from the orchestrator so the drafter/judge excerpt parity and the
 * head+tail behaviour can be tested without constructing a full orchestrator.
 */

import { PLANNING_JUDGE_EXCERPT_CHARS } from "@slopcontrol/llm";

/**
 * Excerpt budget shared by planning judges and the drafter/revise prompts they
 * score. Judges cannot read_file past a clip — a shorter inner consolidate
 * caused false-negative "section missing" verdicts (observed 2026-09-23:
 * Automated Checks began past a 16k clip). Drafter prompts use the same budget
 * so a judge cannot demand a tail the drafter never saw.
 */
export const JUDGE_DOC_EXCERPT_MAX_CHARS = PLANNING_JUDGE_EXCERPT_CHARS;

/**
 * Research budget for the SLIM draft retry (provider 400 "prompt too long").
 * The slim prompt exists to shrink the request; research is the dominant term,
 * so it must shrink too — head+tail keeps the criteria sections at both ends.
 */
export const SLIM_RESEARCH_CLIP_CHARS = 24_000;

/**
 * Cap a document in a prompt. The truncation marker names the real on-disk
 * path so the agent can read more.
 *
 * `balance` keeps the head AND the tail inside `maxChars` (marker counted).
 * Use it for RESEARCH.md / PHASE.md that a judge also scores: a head-only slice
 * hides the sections (File Changes, Automated Checks, Risks, Blueprint Deltas)
 * the judge reads from the tail.
 */
export function clipPromptSection(
  label: string,
  text: string,
  maxChars: number,
  fullPath?: string,
  balance = false,
): string {
  const body = (text ?? "").trim();
  if (!body) return `(${label}: none)`;
  if (body.length <= maxChars) return body;
  const where = fullPath ?? `.slopcontrol/${label}`;
  const marker = `\n\n…[truncated ${label}: ${body.length} chars total; read_file \`${where}\` if you need more]\n\n`;
  if (!balance || marker.length >= maxChars) {
    return `${body.slice(0, maxChars)}${marker}`;
  }
  const budget = maxChars - marker.length;
  const headChars = Math.ceil(budget / 2);
  const tailChars = budget - headChars;
  return `${body.slice(0, headChars)}${marker}${body.slice(body.length - tailChars)}`;
}

/** Same window the planning judges score: head+tail, never a shorter head-only cut. */
export function clipSharedDoc(
  label: string,
  text: string,
  fullPath?: string,
): string {
  return clipPromptSection(
    label,
    text,
    JUDGE_DOC_EXCERPT_MAX_CHARS,
    fullPath,
    true,
  );
}

/**
 * RESEARCH.md window for a draft prompt. The slim retry (provider 400) uses
 * the smaller head+tail budget; every other draft uses the judge's window.
 */
export function clipDraftResearch(
  text: string,
  fullPath: string,
  slim = false,
): string {
  return slim
    ? clipPromptSection(
        "RESEARCH.md",
        text,
        SLIM_RESEARCH_CLIP_CHARS,
        fullPath,
        true,
      )
    : clipSharedDoc("RESEARCH.md", text, fullPath);
}
