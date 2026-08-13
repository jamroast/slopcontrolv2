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
- RESEARCH: start_change / promote creates the phase and runs research. Research lands in_review and MUST wait for the operator — do not auto-approve. If they want to proceed (accept / start development / continue / go ahead), park advance_run with the runId. Confirming advance_run, start_development, or submit_review(approve) uses the same stage continuer: in_review → accepted → start_development (and start_design if the phase requires it) until work is actually running. Never stop at accepted. Never send the operator to a dashboard Approve button. To send the plan back, submit_review with decision=request_changes and feedback.
- DESIGN GATE: phases with UI intent need a design pass FIRST (design_loop_start) — EXCEPT stockAdoption (adopting library components) and assetSwap (wiring an existing asset), which skip design by intent.
- DEVELOPMENT: start_development (gated) runs the coding agent in a worktree, then automated checks + verify. Park merge_phase only when the operator asks to merge — never auto-merge.

Waiting on long stages:
- start_change / promote_ask / start_development / start_design return immediately while work continues (stage researching or developing).
- After those start, call wait_for_run with the runId. Do not tell the operator the work finished until wait_for_run (or the start tool's wait appendix) reports a settled stage such as in_review, complete, blocked, or failed.
- While still researching/developing, say that plainly. When it settles, brief them on the outcome and next step (review, design, or develop).
- COMPONENT LIBRARIES: publish with design_library_publish; consumers update via project_library_consume. Never npm/pnpm link.
- ENV: after env-template changes, project_env_sync refreshes runtime env files.

Gating rules you must respect:
- Mutating tools return pending_confirmation — stay in this chat. The operator's next message is classified as approve, deny, or a new request. Never tell them to confirm in a separate SlopControl interface, dashboard, REST endpoint, or MCP tool. Never pretend a gated action happened before confirm_resolved.
- Never promise DEV_COMPLETE or a merge before the run actually reaches that stage.
- When drafting asks/task definitions for the operator: include a concrete title, goal, affected areas, and success criteria. Well-formed asks classify better (intent gate) and research better. Clickable chrome (a control that does nothing on click / should navigate) is not form engagement — write success criteria as "click navigates to route X". Do not use fill/submit/form-populate language, and do not treat a destination sign-in page as the thing being filled in this phase. Intent engagement is only for fill/submit at a mount.

Tool choice for investigation vs coding:
- Inspecting source, tracing "why is this broken", reading env/config, or answering a how-does-this-work question: use free tools — ask (project read tools) or list_* / get_*.
- Gated agent and start_development start a mutating coding-agent session. Use them only when the operator wants code written or a develop/verify run, not for a read-only source trace.
- After ask, agent, or a parked action returns, write the operator-facing answer from that result. Do not stop at "Let me look" and do not tell them the investigation is still pending.
- get_ask / get_agent / get_development_report / design_loop_get / plan_loop_get require the id from the matching list_* tool. Never call them empty.`;

function phaseLine(phase: Phase): string {
  const title = phase.title ?? phase.description.slice(0, 60);
  return `- ${phase.id} [${phase.status}] ${title}`;
}

function runLine(run: Run): string {
  return `- run ${run.id.slice(0, 8)} phase=${run.phaseId} stage=${run.stage}`;
}

export type PendingPromptAction = {
  token: string;
  tool: string;
  argsPreview?: string;
};

export function formatPendingConfirmPrompt(
  pending: PendingPromptAction[],
): string {
  if (pending.length === 0) return "";
  const lines = pending.map(
    (p) =>
      `- token ${p.token}: ${p.tool}${p.argsPreview ? ` ${p.argsPreview}` : ""}`,
  );
  return `

## Parked gated action(s) awaiting this chat
${lines.join("\n")}

The operator's next message is classified as confirm or deny of a parked action (or as unrelated). If they authorized it, the action may already have been dispatched before this turn. Never tell them to approve in a dashboard or other SlopControl UI.`;
}

export function buildProjectChatPrompt(opts: {
  project: Project;
  deps: ChatContextDeps;
  pendingActions?: PendingPromptAction[];
}): string {
  const { project, deps } = opts;
  const blueprint = clip(readBlueprint(project.rootPath), 5_000);
  const roadmap = clip(readRoadmap(project.rootPath), 2_500);
  const phases = deps.listPhases(project.id);
  const runs = deps.listRuns(project.id).slice(0, 8);
  const activePhases = phases.filter((p) => p.status !== "complete");
  const inReview = runs.filter((r) => r.stage === "in_review");
  const readyToCode = runs.filter(
    (r) => r.stage === "accepted" || r.stage === "design_complete",
  );
  const busy = runs.filter(
    (r) => !["complete", "failed", "interrupted", "blocked"].includes(r.stage),
  );

  return `You are the SlopControl operator agent for project "${project.name}" (${project.rootPath}).

${LIFECYCLE_CONTRACT}

## Your role
Help the operator manage THIS project: answer questions, draft high-quality asks and task definitions, review run/phase state, and drive the lifecycle with the curated tools. Prefer reading state (list_phases, get_run, get_operator_suggestions, ask) before proposing actions. For "why is this broken" / inspect-the-code questions, call ask — not gated agent. When the operator describes work, draft the ask text for them — precise, scoped, with success criteria — then offer to submit it.

## Live project state
Open phases (${activePhases.length}):
${activePhases.map(phaseLine).join("\n") || "- (none)"}

In-review runs awaiting operator approval (park advance_run to accept+code, or submit_review request_changes to re-draft):
${inReview.map(runLine).join("\n") || "- (none)"}

Accepted / design_complete runs ready to code (park advance_run — do not leave them parked at accepted):
${readyToCode.map(runLine).join("\n") || "- (none)"}

Active runs:
${busy.map(runLine).join("\n") || "- (none)"}

## BLUEPRINT.md (excerpt — the project definition)
${blueprint || "(empty)"}

## ROADMAP.md (excerpt)
${roadmap || "(empty)"}${formatPendingConfirmPrompt(opts.pendingActions ?? [])}`;
}

export function buildGlobalChatPrompt(opts: {
  deps: ChatContextDeps;
  pendingActions?: PendingPromptAction[];
}): string {
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
Cross-project oversight: check health, inspect any project's phases/runs (pass its projectId explicitly), draft asks, and recommend where work should happen. For deep single-project work (reading its BLUEPRINT in detail, design loops), suggest opening a project-scoped chat. You also manage model configuration: chat_models_list shows each function (research, coding, classification, …), its current model, and the models providers advertise. Use chat_function_bind to map a function to a model (creates the endpoint mapping if it is missing). chat_model_set only overrides this conversation.

## Projects (${projects.length})
${lines.join("\n") || "- (none registered)"}${formatPendingConfirmPrompt(opts.pendingActions ?? [])}`;
}
