import type { IterationMemoryEntry } from "@slopcontrol/types";

/** Soft char budget so curated prompts stay under typical Ollama context (~524k tokens). */
export const SUPERVISOR_PROMPT_SOFT_BUDGET = 80_000;

const PRIOR_NEXT_ACTIONS_CAP = 1_500;
const CHECK_SIGNAL_CAP = 2_000;
const PHASE_EXCERPT_CAP = 4_000;
const LEARNINGS_HARD_CAP = 6_000;

export function resolveAgentMemoryOption(
  resourceId: string,
  threadId: string,
  memory?: false | { resource: string; thread: string },
): { resource: string; thread: string } | undefined {
  if (memory === false) return undefined;
  if (memory && typeof memory === "object") return memory;
  return { resource: resourceId, thread: threadId };
}

export function isPromptTooLongError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /prompt is too long|context length|maximum context|too many tokens|context window/i.test(
    msg,
  );
}

export function extractNextActionsSummary(
  output: string,
  maxChars = PRIOR_NEXT_ACTIONS_CAP,
): string {
  const text = (output ?? "").replace(/\r\n/g, "\n").trim();
  if (!text) return "";
  const section = text.match(
    /##\s*Next actions\b[\s\S]*?(?=\n##\s|\nDEV_BLOCKED\b|$)/i,
  );
  const body = (section?.[0] ?? text).trim();
  return body.slice(0, maxChars);
}

export function priorNextActionsFromMemory(
  entries: IterationMemoryEntry[],
  lastN = 3,
): string[] {
  return entries
    .map((e) => e.nextActionsSummary?.trim())
    .filter((s): s is string => Boolean(s))
    .slice(-lastN)
    .map((s) => s.slice(0, PRIOR_NEXT_ACTIONS_CAP));
}

export type SupervisorEnrichPromptInput = {
  iteration: number;
  diagnosisStreak: number;
  maxDiagnosisStreak: number;
  noProgressCount: number;
  maxNoProgress: number;
  infraStrikeCount: number;
  planCoverageSummary: string;
  diagnosisCard: string;
  phaseExcerpt: string;
  worktreePath: string;
  runId: string;
  phaseId: string;
  /** Distilled failing-step evidence (checks.summary), never full log dumps. */
  checkSignal: string;
  learningsBlock?: string;
  priorNextActions?: string[];
  softBudget?: number;
};

export type SupervisorEnrichPromptResult = {
  prompt: string;
  clipped: boolean;
  charCount: number;
};

function clip(text: string, max: number): string {
  const t = (text ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…[clipped]`;
}

/**
 * Build a curated supervisor enrich prompt: diagnosis + capped check signal +
 * prior next-actions + PHASE + learnings. Never includes Mastra tool/OM blobs.
 */
export function buildSupervisorEnrichPrompt(
  input: SupervisorEnrichPromptInput,
): SupervisorEnrichPromptResult {
  const budget = input.softBudget ?? SUPERVISOR_PROMPT_SOFT_BUDGET;
  let prior = (input.priorNextActions ?? []).map((s) =>
    clip(s, PRIOR_NEXT_ACTIONS_CAP),
  );
  let learnings = clip(input.learningsBlock ?? "", LEARNINGS_HARD_CAP);
  let phaseExcerpt = clip(input.phaseExcerpt, PHASE_EXCERPT_CAP);
  let checkSignal = clip(input.checkSignal, CHECK_SIGNAL_CAP);
  let clipped = false;

  const assemble = (): string => {
    const priorBlock =
      prior.length > 0
        ? [
            "Prior supervisor next-actions (most recent last):",
            ...prior.map((p, i) => `--- prior ${i + 1} ---\n${p}`),
            "",
          ].join("\n")
        : "";

    const checksDir = `.slopcontrol/runs/${input.runId}/checks/`;

    return `Enrich this Failure diagnosis (do not re-litigate full logs).
Use only the diagnosis card and excerpts below — do not ask for full logs.
Iteration ${input.iteration}. Diagnosis streak: ${input.diagnosisStreak}/${input.maxDiagnosisStreak}.
No-progress: ${input.noProgressCount}/${input.maxNoProgress}. Infra strikes: ${input.infraStrikeCount}/2.
Plan coverage: ${input.planCoverageSummary}

${input.diagnosisCard}

Failing-step check signal (distilled; full dumps on disk under ${checksDir}):
${checkSignal || "(none)"}

${priorBlock}PHASE excerpt:
${phaseExcerpt}

Worktree: ${input.worktreePath}
Checks dir (for coding agent): ${checksDir}
Phase doc: .slopcontrol/phases/${input.phaseId}/PHASE.md
${learnings ? `\n${learnings}` : ""}

Respond with:
## Next actions
(concise instructions for the coding tool addressing the failing step — or operator actions if infra.
Point the coding agent at ${checksDir} / the named failing command when more detail is needed.)

If unrecoverable, include DEV_BLOCKED on its own line.
Do not invent bring-up scripts for infra. Fix broken Automated Checks in PHASE.md when class=process/shell — edit \`.slopcontrol/phases/${input.phaseId}/PHASE.md\` before product files.`;
  };

  let prompt = assemble();
  if (prompt.length > budget) {
    clipped = true;
    // Drop oldest prior next-actions first, then shrink learnings / phase / check.
    while (prior.length > 0 && prompt.length > budget) {
      prior = prior.slice(1);
      prompt = assemble();
    }
    if (prompt.length > budget) {
      learnings = clip(learnings, Math.min(2_000, Math.floor(budget * 0.05)));
      phaseExcerpt = clip(phaseExcerpt, 2_000);
      checkSignal = clip(checkSignal, 1_200);
      prompt = assemble();
    }
    if (prompt.length > budget) {
      prompt = `${prompt.slice(0, budget)}\n…[supervisor prompt clipped to budget]`;
    }
  }

  return { prompt, clipped, charCount: prompt.length };
}
