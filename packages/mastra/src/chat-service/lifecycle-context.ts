import { readBlueprint, readRoadmap } from "@slopcontrol/artifacts";
import type { Phase, Project, Run } from "@slopcontrol/types";
import type { ChatContextDeps } from "./types.js";

function clip(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n…(clipped)`;
}

const LIFECYCLE_CONTRACT = `## The SlopControl lifecycle (authoritative)

Work flows through phases. Each phase: draft (PHASE.md) → research (RESEARCH.md) → operator review (in_review) → [design pass when required] → development (git worktree) → verify → merge → complete.

- ASK: exploratory Q&A. Shape the operator's idea into a crisp task brief, then promote_ask (gated) to create a phase.
- PLAN LOOP: multi-turn planning for bigger work (plan_loop_start/continue/accept), then plan_loop_promote creates phases.
- RESEARCH: start_change / promote creates the phase and runs research. Research lands in_review — the operator approves via the review action before development.
- DESIGN GATE: phases with UI intent need a design pass FIRST (design_loop_start) — EXCEPT stockAdoption (adopting library components) and assetSwap (wiring an existing asset), which skip design by intent.
- DEVELOPMENT: start_development (gated) runs the coding agent in a worktree, then automated checks + verify, then merge_phase.
- COMPONENT LIBRARIES: publish with design_library_publish; consumers update via project_library_consume. Never npm/pnpm link.
- ENV: after env-template changes, project_env_sync refreshes runtime env files.

Gating rules you must respect:
- Mutating tools return pending_confirmation — the operator confirms or denies; never pretend a gated action happened before confirm_resolved.
- Never promise DEV_COMPLETE or a merge before the run actually reaches that stage.
- When drafting asks/task definitions for the operator: include a concrete title, goal, affected areas, and success criteria. Well-formed asks classify better (intent gate) and research better.`;

function phaseLine(phase: Phase): string {
  const title = phase.title ?? phase.description.slice(0, 60);
  return `- ${phase.id} [${phase.status}] ${title}`;
}

function runLine(run: Run): string {
  return `- run ${run.id.slice(0, 8)} phase=${run.phaseId} stage=${run.stage}`;
}

export function buildProjectChatPrompt(opts: {
  project: Project;
  deps: ChatContextDeps;
}): string {
  const { project, deps } = opts;
  const blueprint = clip(readBlueprint(project.rootPath), 5_000);
  const roadmap = clip(readRoadmap(project.rootPath), 2_500);
  const phases = deps.listPhases(project.id);
  const runs = deps.listRuns(project.id).slice(0, 8);
  const activePhases = phases.filter((p) => p.status !== "complete");
  const inReview = runs.filter((r) => r.stage === "in_review");
  const busy = runs.filter(
    (r) => !["complete", "failed", "interrupted", "blocked"].includes(r.stage),
  );

  return `You are the SlopControl operator agent for project "${project.name}" (${project.rootPath}).

${LIFECYCLE_CONTRACT}

## Your role
Help the operator manage THIS project: answer questions, draft high-quality asks and task definitions, review run/phase state, and drive the lifecycle with the curated tools. Prefer reading state (list_phases, get_run, get_operator_suggestions) before proposing actions. When the operator describes work, draft the ask text for them — precise, scoped, with success criteria — then offer to submit it.

## Live project state
Open phases (${activePhases.length}):
${activePhases.map(phaseLine).join("\n") || "- (none)"}

In-review runs awaiting operator approval:
${inReview.map(runLine).join("\n") || "- (none)"}

Active runs:
${busy.map(runLine).join("\n") || "- (none)"}

## BLUEPRINT.md (excerpt — the project definition)
${blueprint || "(empty)"}

## ROADMAP.md (excerpt)
${roadmap || "(empty)"}`;
}

export function buildGlobalChatPrompt(opts: { deps: ChatContextDeps }): string {
  const { deps } = opts;
  const projects = deps.listProjects();
  const lines = projects.map((project) => {
    const phases = deps.listPhases(project.id);
    const active = phases.filter((p) => p.status !== "complete").length;
    const runs = deps.listRuns(project.id);
    const busy = runs.filter(
      (r) =>
        !["complete", "failed", "interrupted", "blocked"].includes(r.stage),
    ).length;
    const review = runs.filter((r) => r.stage === "in_review").length;
    return `- ${project.name} (projectId: ${project.id}) ${project.rootPath} — ${active} open phases, ${busy} active runs, ${review} awaiting review`;
  });

  return `You are the SlopControl global operator agent. You manage the whole SlopControl platform across projects.

${LIFECYCLE_CONTRACT}

## Your role (global scope)
Cross-project oversight: check health, inspect any project's phases/runs (pass its projectId explicitly), draft asks, and recommend where work should happen. For deep single-project work (reading its BLUEPRINT in detail, design loops), suggest opening a project-scoped chat. You also manage model configuration: chat_models_list to show providers/models, chat_model_set for this conversation, chat_endpoint_model_update to change an endpoint's default model.

## Projects (${projects.length})
${lines.join("\n") || "- (none registered)"}`;
}
