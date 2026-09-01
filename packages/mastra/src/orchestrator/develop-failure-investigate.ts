import type { LlmEndpoint } from "@slopcontrol/types";
import type { FailureDiagnosis } from "@slopcontrol/artifacts";
import {
  formatInvestigateDirtyTree,
  getCodingTool,
} from "@slopcontrol/coding-tools";

export const DEVELOP_PRODUCT_INVESTIGATE_SYSTEM = `You are SlopControl's develop-loop failure investigator.

A verify step failed with a product/test assertion. Your job is to read the codebase and run **read-only, targeted probes** so the implementer can fix the root cause on the next turn.

Rules:
- Working directory is the develop worktree SlopControl provides.
- You may read files and run **narrow** diagnostic commands (single test file, curl against localhost, grep, node -e one-liners).
- Do NOT edit, create, or delete source files. Do NOT commit. Do NOT print secrets or .env values.
- Do NOT re-run the full verify suite — at most one targeted test command if it helps explain the failure.
- Capture HTTP response bodies / error JSON when a test expects status 200 but got 4xx.
- End with markdown findings: **Root cause hypothesis**, **Evidence** (paths, command output excerpts), **Suggested fix** (which files/functions to change).`;

export type DevelopFailureInvestigateInput = {
  worktreePath: string;
  phaseId: string;
  diagnosis: FailureDiagnosis;
  /** Excerpt from verify output (failure + nearby context) */
  verifyExcerpt: string;
  /** Planned paths from PHASE.md not yet touched — steer investigation */
  missingPlannedPaths?: string[];
  endpoint: LlmEndpoint;
  modelId?: string;
  timeoutMs?: number;
};

export type DevelopFailureInvestigateResult = {
  findings: string;
  dirtyWarning: string | null;
};

export type DevelopProductInvestigateEligibility = {
  diagnosis: FailureDiagnosis;
  lastIterationHadFileChanges: boolean;
  lastIterationZeroPlanProgress: boolean;
  alreadyInvestigated: boolean;
};

/** Once per fingerprint when verify fails on a product bug with no useful coding progress. */
export function shouldRunDevelopProductInvestigation(
  input: DevelopProductInvestigateEligibility,
): boolean {
  if (input.alreadyInvestigated) return false;
  if (input.diagnosis.codingAgentShouldFix === false) return false;
  if (input.diagnosis.class !== "product") return false;
  if (
    input.lastIterationHadFileChanges &&
    !input.lastIterationZeroPlanProgress
  ) {
    return false;
  }
  return true;
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export function buildDevelopProductInvestigatePrompt(
  input: DevelopFailureInvestigateInput,
): string {
  const missing =
    input.missingPlannedPaths && input.missingPlannedPaths.length > 0
      ? `\nPlanned paths not yet edited this iteration:\n${input.missingPlannedPaths.map((p) => `- ${p}`).join("\n")}\n`
      : "";
  return [
    `Investigate this develop verify failure for phase \`${input.phaseId}\`.`,
    "",
    "Diagnosis (authoritative):",
    `- title: ${input.diagnosis.title}`,
    `- rootCause: ${input.diagnosis.rootCause}`,
    input.diagnosis.nextActions
      ? `- nextActions: ${input.diagnosis.nextActions}`
      : null,
    missing,
    "Verify excerpt:",
    clip(input.verifyExcerpt, 12_000),
    "",
    "Return markdown findings only (no file edits). Include concrete paths and, when relevant, the OAuth/DPoP/token error payload from the server.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Read-only Pi investigation after a product verify failure with no file changes. */
export async function runDevelopProductFailureInvestigation(
  input: DevelopFailureInvestigateInput,
): Promise<DevelopFailureInvestigateResult> {
  const tool = getCodingTool("pi");
  const timeoutMs =
    input.timeoutMs ??
    Number(process.env.SLOPCONTROL_DEVELOP_INVESTIGATE_MS ?? 180_000);
  const session = await tool.createSession({
    projectDir: input.worktreePath,
    endpoint: input.endpoint,
    modelId: input.modelId,
    mode: "investigate",
  });
  try {
    const prompt = buildDevelopProductInvestigatePrompt(input);
    const result = tool.runPromptWithSystem
      ? await tool.runPromptWithSystem(
          session,
          prompt,
          DEVELOP_PRODUCT_INVESTIGATE_SYSTEM,
          { timeoutMs },
        )
      : await tool.runPrompt(session, prompt, { timeoutMs });
    const changed = await tool.getChangedFiles(session);
    const dirtyWarning = formatInvestigateDirtyTree(changed);
    if (result.aborted && !result.output.trim()) {
      throw new Error(result.abortReason ?? "develop investigate aborted");
    }
    return {
      findings: result.output.trim() || "(investigator returned empty findings)",
      dirtyWarning,
    };
  } finally {
    await tool.abort(session).catch(() => undefined);
  }
}
