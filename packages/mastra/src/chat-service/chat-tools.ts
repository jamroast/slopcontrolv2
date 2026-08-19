import { createTool } from "@mastra/core/tools";
import { isBusyRunStage } from "@slopcontrol/types";
import { z } from "zod";
import type { ChatToolDispatch, ChatToolResult } from "./types.js";

/**
 * Curated chat-tool surface over the SlopControl tool dispatch.
 *
 * Three tiers:
 * - FREE: read-only / conversational — the agent may call autonomously.
 * - GATED: mutating lifecycle actions — the wrapper parks the call as a
 *   pending action and returns `pending_confirmation`; it only executes
 *   after the operator confirms in this chat (LLM-classified next message)
 *   or via REST/MCP confirm.
 * - Everything else (delete_project, remove_worktree, resolve_conflicts,
 *   the raw `slopcontrol` passthrough, …) is not exposed to the agent.
 */

export const CHAT_FREE_TOOLS: ReadonlySet<string> = new Set([
  // status / inspection
  "get_health",
  "get_run",
  "get_run_steps",
  "get_phase_status",
  "wait_for_run",
  "get_operator_suggestions",
  "get_development_report",
  "list_runs",
  "list_phases",
  "list_worktrees",
  "get_git_status",
  "list_asks",
  "get_ask",
  "list_agents",
  "get_agent",
  "list_design_loops",
  "design_loop_get",
  "design_loop_versions",
  "design_loop_concepts",
  "design_loop_site_inventory",
  "list_plan_loops",
  "plan_loop_get",
  "plan_loop_versions",
  "list_design_elements",
  "list_cross_project_deps",
  "resolve_dependency",
  "design_element_get",
  "list_extractable_design_elements",
  "npm_registry_status",
  "npm_registry_list",
  "project_build_process_state",
  "project_build_process_audit",
  "search_design_images",
  "preview_change_intent",
  "audit_ui_gates",
  // dry-run only — the wrapper forces dryRun=true
  "reconcile_blueprint",
  // conversational
  "ask",
  "ask_sub_research",
]);

export const CHAT_GATED_TOOLS: ReadonlySet<string> = new Set([
  // lifecycle
  "start_change",
  "promote_ask",
  "fork_ask",
  "start_design",
  "submit_review",
  "advance_run",
  "start_development",
  "retry_development",
  "retry_verify",
  "retry_root_verify",
  "retry_draft",
  "rerun_research",
  "stop_session",
  "agent",
  "merge_phase",
  "checkout_branch",
  "implement_design",
  "relaunch_design_research",
  // design loops
  "design_loop_start",
  "design_loop_continue",
  "design_loop_import_design",
  "design_loop_acceptance",
  "design_loop_retry",
  "design_loop_accept",
  "design_loop_pin",
  "design_loop_unpin",
  "design_loop_discard",
  "review_design_loop",
  "generate_design_image",
  "import_design_image",
  // plan loops
  "plan_loop_start",
  "plan_loop_continue",
  "plan_loop_acceptance",
  "plan_loop_accept",
  "plan_loop_promote",
  "plan_loop_retry",
  "plan_loop_discard",
  // registry / libraries / build process
  "npm_registry_start",
  "npm_registry_stop",
  "npm_registry_ensure_rc",
  "npm_registry_publish",
  "design_element_publish",
  "design_element_publish_npm",
  "design_element_extract",
  "design_element_import",
  "design_library_publish",
  "project_workspace_package_publish",
  "cross_project_wire_package",
  "project_library_consume",
  "project_build_process_configure",
  "project_set_coding_tool",
  "project_set_ask_investigate_tool",
  "project_env_sync",
  "project_runs_compact",
  // project admin (non-destructive)
  "open_project",
  "reinit_project",
  "rename_project",
]);

export type ChatToolTier = "free" | "gated" | "excluded";

export function chatToolTier(name: string): ChatToolTier {
  if (CHAT_FREE_TOOLS.has(name)) return "free";
  if (CHAT_GATED_TOOLS.has(name)) return "gated";
  return "excluded";
}

export function listChatToolNames(): { free: string[]; gated: string[] } {
  return {
    free: [...CHAT_FREE_TOOLS].sort(),
    gated: [...CHAT_GATED_TOOLS].sort(),
  };
}

const optionalProject = z.string().min(1).optional();

/** Structured input schemas so the model fills required ids instead of guessing. */
export const CHAT_TOOL_INPUT_SCHEMA: Record<string, z.ZodType> = {
  get_run: z.object({
    runId: z.string().min(1),
    projectId: optionalProject,
  }),
  wait_for_run: z.object({
    runId: z.string().min(1),
    projectId: optionalProject,
  }),
  get_run_steps: z.object({
    runId: z.string().min(1),
    projectId: optionalProject,
  }),
  get_phase_status: z.object({
    phaseId: z.string().min(1),
    projectId: optionalProject,
  }),
  get_development_report: z.object({
    runId: z.string().min(1).optional(),
    phaseId: z.string().min(1).optional(),
    projectId: optionalProject,
  }),
  get_ask: z.object({
    askId: z.string().min(1).optional(),
    projectId: optionalProject,
  }),
  get_agent: z.object({
    agentId: z.string().min(1),
    projectId: optionalProject,
  }),
  design_loop_get: z.object({
    loopId: z.string().min(1),
    projectId: optionalProject,
  }),
  plan_loop_get: z.object({
    loopId: z.string().min(1).optional(),
    projectId: optionalProject,
  }),
  ask: z.object({
    message: z.string().min(1),
    askId: z.string().min(1).optional(),
    title: z.string().optional(),
    newAsk: z.boolean().optional(),
    investigateTool: z.enum(["auto", "mastra", "pi"]).optional(),
    projectId: optionalProject,
  }),
  project_set_ask_investigate_tool: z.object({
    tool: z.enum(["auto", "mastra", "pi"]),
    projectId: optionalProject,
  }),
  agent: z.object({
    message: z.string().min(1),
    agentId: z.string().min(1).optional(),
    title: z.string().optional(),
    projectId: optionalProject,
  }),
  ask_sub_research: z.object({
    askId: z.string().min(1).optional(),
    topics: z.array(z.string().min(1)).min(1),
    projectId: optionalProject,
  }),
  promote_ask: z.object({
    askId: z.string().min(1).optional(),
    description: z.string().optional(),
    dependsOn: z.array(z.string()).optional(),
    projectId: optionalProject,
  }),
  fork_ask: z.object({
    askId: z.string().min(1).optional(),
    title: z.string().optional(),
    projectId: optionalProject,
  }),
  design_loop_continue: z
    .object({
      loopId: z.string().min(1),
      message: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  plan_loop_continue: z
    .object({
      loopId: z.string().min(1),
      message: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  plan_loop_start: z.object({
    brief: z.string().min(1),
    askId: z.string().min(1).optional(),
    investigateTool: z.enum(["auto", "mastra", "pi"]).optional(),
    projectId: optionalProject,
  }),
  plan_loop_acceptance: z.object({
    loopId: z.string().min(1).optional(),
    acceptedFeatureIds: z.array(z.string().min(1)).optional(),
    features: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().optional(),
          accepted: z.boolean(),
        }),
      )
      .optional(),
    projectId: optionalProject,
  }),
  plan_loop_accept: z.object({
    loopId: z.string().min(1).optional(),
    version: z.number().int().positive().optional(),
    acceptedFeatureIds: z.array(z.string().min(1)).optional(),
    projectId: optionalProject,
  }),
  plan_loop_promote: z.object({
    loopId: z.string().min(1).optional(),
    startResearch: z.boolean().optional(),
    dependsOn: z.array(z.string()).optional(),
    projectId: optionalProject,
  }),
  design_loop_start: z.object({
    brief: z.string().min(1),
    askId: z.string().min(1).optional(),
    phaseId: z.string().min(1).optional(),
    projectId: optionalProject,
  }),
  start_change: z.object({
    description: z.string().min(1),
    dependsOn: z.array(z.string()).optional(),
    projectId: optionalProject,
  }),
  start_development: z
    .object({
      runId: z.string().min(1),
      autoDesign: z.boolean().optional(),
      projectId: optionalProject,
    })
    .passthrough(),
  submit_review: z
    .object({
      runId: z.string().min(1),
      decision: z.enum(["approve", "request_changes"]),
      feedback: z.string().optional(),
      projectId: optionalProject,
    })
    .passthrough(),
  advance_run: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  retry_development: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  retry_verify: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  retry_root_verify: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  retry_draft: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  rerun_research: z
    .object({
      runId: z.string().min(1),
      projectId: optionalProject,
    })
    .passthrough(),
  stop_session: z.object({
    kind: z.enum(["ask", "agent", "design_loop", "plan_loop"]),
    id: z.string().min(1),
    projectId: optionalProject,
  }),
  list_runs: z.object({ projectId: optionalProject }).passthrough(),
  list_phases: z.object({ projectId: optionalProject }).passthrough(),
  design_library_publish: z.object({
    projectId: optionalProject,
    bump: z.enum(["patch", "minor", "major"]).optional(),
    propagate: z.boolean().optional(),
  }),
  project_workspace_package_publish: z.object({
    projectId: optionalProject,
    packagePath: z.string().min(1),
    bump: z.enum(["patch", "minor", "major"]).optional(),
    propagate: z.boolean().optional(),
    consumerProjectIds: z.array(z.string().min(1)).optional(),
  }),
  cross_project_wire_package: z.object({
    publisherProjectId: z.string().min(1),
    packagePath: z.string().min(1),
    consumerProjectIds: z.array(z.string().min(1)).min(1),
    bump: z.enum(["patch", "minor", "major"]).optional(),
    propagate: z.boolean().optional(),
  }),
  project_library_consume: z.object({
    projectId: optionalProject,
    packageName: z.string().min(1),
    version: z.string().optional(),
    allowNew: z.boolean().optional(),
  }),
  npm_registry_publish: z.object({
    packageDir: z.string().min(1).optional(),
    projectId: optionalProject,
    packagePath: z.string().min(1).optional(),
    tag: z.string().optional(),
  }),
};

const CHAT_TOOL_DESCRIPTION: Record<string, string> = {
  get_run:
    "Get one run by runId (from list_runs). Requires runId — do not call this without a specific run id.",
  wait_for_run:
    "Poll a run until it leaves researching/drafting/designing/developing (or times out). Requires runId from list_runs or a just-started lifecycle tool. Use this instead of repeatedly calling get_run. When it returns a settled stage, brief the operator — do not invent progress.",
  get_run_steps:
    "Structured verify steps for one run. Requires runId.",
  get_phase_status:
    "Status and diagnosis for one phase. Requires phaseId.",
  list_runs:
    "List runs for the project (id, stage, phase). Call this before get_run.",
  list_phases:
    "List phases for the project (id, status, title).",
  get_operator_suggestions:
    "Operator next-actions for the current project state.",
  get_development_report:
    "Development report for a run. Prefer list_runs first, then pass runId.",
  get_ask:
    "One ask session. Pass askId, or omit to use this chat's latched ask. Returns latest messages, not the full history dump.",
  get_agent:
    "One agent session. Requires agentId from list_agents. Returns latest messages, not the full history dump.",
  design_loop_get:
    "One design loop. Requires loopId from list_design_loops. Use notes; do not paste HTML into the operator reply.",
  plan_loop_get:
    "One plan loop. Pass loopId, or omit to use this chat's latched plan loop (from plan_loop_start/continue). Returns nextStep and blockers. Read-only status check — when the operator wants to revise the plan, call plan_loop_continue (not plan_loop_get). Do not poll while a plan_loop live turn is active — wait for live_settled.",
  plan_loop_start:
    "Start a multi-turn plan loop (structured PLAN.md). Requires brief — pass the operator's planning words in brief. Optional investigateTool: auto|mastra|pi. Thorough vs quick intent is LLM-classified. You'll be notified via live_settled when the turn completes — do not poll plan_loop_get.",
  plan_loop_continue:
    "Revise a plan loop from operator feedback. Pass loopId (or omit latched) and message. Notification-driven — do not poll plan_loop_get while running.",
  plan_loop_acceptance:
    "Save acceptance checklist ticks (goal, scope, approach, areas, success, risks) before freezing the plan. Pass loopId (or omit latched) and acceptedFeatureIds or features[]. Does not accept the plan by itself.",
  plan_loop_accept:
    "Freeze the plan loop as accepted (requires a complete PLAN.md). Pass loopId (or omit latched). On operator confirm with no ticks, all checklist features are auto-ticked. Then call plan_loop_promote — not start_development directly.",
  plan_loop_promote:
    "Bind accepted plan to a new phase and start research (returns runId). Pass loopId (or omit latched). After research reaches in_review, use advance_run with that runId — plan_loop_promote does not start development.",
  design_loop_start:
    "Start a look-and-feel design loop (mock HTML). Requires brief — pass the operator's words in brief. Notification-driven when live turn active.",
  start_change:
    "Start research for a new phase. Requires description — pass the operator's full task definition (title, goal, affected areas, success criteria). Do not call with only projectId. Optional dependsOn for phase ordering.",
  ask: "Investigate the project (read source, explain why something is broken). Pass the operator's words through in message — do not replace a page/route/product-gap question with a source-claim checklist. Optional investigateTool: mastra (faster) | pi (thorough) | auto. Thorough vs quick intent in the operator message is classified by the LLM, never keyword-matched; with no expressed intent the fast mastra path runs. Prefer this over gated agent for read-only traces. Requires message. You may pass askId or newAsk; the chat service will choose continue vs a new ask so this never resumes some other open ask on the project.",
  project_set_ask_investigate_tool:
    "Set the project's default Ask walker: auto, mastra (fast), or pi (thorough). Requires tool. Bind the judge model with chat_function_bind function=judge.",
  agent:
    "Start a mutating coding-agent session. Do not use this to read source or explain a bug — use ask. Requires message.",
  start_development:
    "Start coding in a worktree. Requires runId. Confirming this (or advance_run) keeps walking the run until coding/design is actually running — including accepting in_review first. Stay in this chat; do not send the operator to the dashboard. Use submit_review request_changes to send the plan back.",
  advance_run:
    "Preferred proceed tool. Requires runId. Confirming it walks the current gate until work is running: in_review → approve review → start_development (or start_design if required). Use this when the operator says go ahead / accept / start development / continue. Never auto-merges. Stay in this chat.",
  submit_review:
    "Approve or request changes on an in_review research/draft. Requires runId and decision (approve | request_changes). Confirming approve then keeps advancing until work is running (same continuer as advance_run). Prefer advance_run when they want to proceed. Stay in this chat — do not send the operator to a dashboard Approve button.",
  retry_draft:
    "Re-run PHASE.md draft only when RESEARCH.md is solid. Requires runId. Use when research succeeded but draft failed — not rerun_research.",
  rerun_research:
    "Re-run research for a failed planning run. Skips research agent when RESEARCH.md is already solid. Requires runId.",
  promote_ask:
    "Promote an ask into a phase. Pass askId, or omit to promote this chat's latched ask.",
  design_library_publish:
    "Publish a component-library PROJECT ROOT (componentLibrary:true, e.g. jamroast-components): build → bump → publish → propagate to consumers. Requires projectId.",
  project_workspace_package_publish:
    "Publish a NESTED package inside an app project (e.g. JamRoast packages/service-token). install → build → bump → npm publish → wire consumers. Pass projectId + packagePath. NOT for jamroast-components root.",
  cross_project_wire_package:
    "Master-chat cross-project wire: publish nested package from publisherProjectId/packagePath and pnpm-add on consumerProjectIds. Preferred one-shot after list_cross_project_deps.",
  project_library_consume:
    "Install/update a registry package on one consumer via its toolchain (pnpm add). Pass allowNew:true for first-time deps. Run npm_registry_ensure_rc first when scopes are missing.",
  npm_registry_publish:
    "Raw npm publish only (no build). Pass packageDir OR projectId+packagePath. Prefer project_workspace_package_publish for nested packages.",
  stop_session:
    "Interrupt a live ask/agent/design_loop/plan_loop turn. Requires kind and id.",
};

function toolInputSchema(name: string): z.ZodType {
  return (
    CHAT_TOOL_INPUT_SCHEMA[name] ??
    z.object({ projectId: optionalProject }).passthrough()
  );
}

function toolDescription(name: string, gated: boolean): string {
  const extra = CHAT_TOOL_DESCRIPTION[name];
  const gate = gated
    ? " Mutating — requires operator confirmation before it executes."
    : " Read-only.";
  return extra ? `${extra}${gate}` : `SlopControl ${name}.${gate}`;
}

function previewArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length <= 400 ? json : `${json.slice(0, 400)}…`;
}

/**
 * Hard cap on tool-result text fed back into the agent loop. Lifecycle
 * payloads (development reports, run lists with stage timings) can run to
 * tens of KB each; untruncated they accumulate across steps and blow the
 * model's context — and they persist into the Memory thread, poisoning
 * every later turn of the conversation.
 */
export const CHAT_TOOL_RESULT_MAX_CHARS = 4_000;
/** Ask judge replies are long; a 4k clip made chat loop "continue the unclipped results". */
export const CHAT_ASK_TOOL_RESULT_MAX_CHARS = 16_000;

function clipChatToolText(
  text: string,
  max: number = CHAT_TOOL_RESULT_MAX_CHARS,
): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(truncated ${text.length - max} chars — narrow the query or ask for a specific item)`;
}

/**
 * Ask/agent MCP payloads put the operator-facing `reply` after a session dump.
 * Truncating the raw JSON from the front drops the answer. Prefer `reply`.
 */
export function extractDispatchedReply(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const envelope = splitMcpEnvelope(trimmed);
  if (envelope?.body) return envelope.body;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.reply === "string" && parsed.reply.trim()) {
      return parsed.reply.trim();
    }
    if (typeof parsed.notes === "string" && parsed.notes.trim()) {
      return parsed.notes.trim();
    }
  } catch {
    /* not JSON */
  }
  return raw;
}

function splitMcpEnvelope(
  raw: string,
): { header: string; body: string } | null {
  const dashed = raw.indexOf("\n---\n");
  if (dashed < 0) return null;
  const header = raw.slice(0, dashed);
  if (!/^(askId|agentId|loopId):/m.test(header)) return null;
  return { header, body: raw.slice(dashed + 5).trim() };
}

function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(clipped)`;
}

function messageText(row: unknown): string {
  if (!row || typeof row !== "object") return "";
  const m = row as { role?: unknown; content?: unknown };
  const role = typeof m.role === "string" ? m.role : "unknown";
  const content =
    typeof m.content === "string"
      ? m.content
      : m.content != null
        ? JSON.stringify(m.content)
        : "";
  const clipped = clipText(content.trim(), 1_500);
  if (!clipped) return "";
  return `${role}:\n${clipped}`;
}

function compactSession(
  session: Record<string, unknown>,
  kind: string,
): string {
  const id = typeof session.id === "string" ? session.id : "";
  const status = typeof session.status === "string" ? session.status : "";
  const title = typeof session.title === "string" ? session.title : "";
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const latest = messages.slice(-2).map(messageText).filter(Boolean);
  return [
    `${kind} ${id}`.trim(),
    status ? `status: ${status}` : null,
    title ? `title: ${title}` : null,
    messages.length ? `messageCount: ${messages.length}` : null,
    latest.length ? `latest:\n${latest.join("\n\n")}` : "(no messages)",
  ]
    .filter(Boolean)
    .join("\n");
}

function compactHandoff(report: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const key of ["outcome", "phaseId", "runId"] as const) {
    if (typeof report[key] === "string") lines.push(`${key}: ${report[key]}`);
  }
  if (typeof report.summary === "string" && report.summary.trim()) {
    lines.push("", report.summary.trim());
  }
  const reqs = Array.isArray(report.operatorRequirements)
    ? report.operatorRequirements.filter((x): x is string => typeof x === "string")
    : [];
  if (reqs.length) {
    lines.push("", "Operator requirements:");
    for (const r of reqs.slice(0, 12)) lines.push(`- ${r}`);
  }
  const next = Array.isArray(report.nextSteps)
    ? report.nextSteps.filter((x): x is string => typeof x === "string")
    : [];
  if (next.length) {
    lines.push("", "Next steps:");
    for (const r of next.slice(0, 12)) lines.push(`- ${r}`);
  }
  const merge =
    report.merge && typeof report.merge === "object" && !Array.isArray(report.merge)
      ? (report.merge as Record<string, unknown>)
      : null;
  if (merge) {
    lines.push("", "Merge:");
    if (typeof merge.autoMerged === "boolean") {
      lines.push(`- autoMerged: ${merge.autoMerged}`);
    }
    if (typeof merge.worktreePresent === "boolean") {
      lines.push(`- worktreePresent: ${merge.worktreePresent}`);
    }
    if (typeof merge.branch === "string" && merge.branch.trim()) {
      lines.push(`- branch: ${merge.branch}`);
    }
  }
  if (typeof report.checksSummary === "string" && report.checksSummary.trim()) {
    lines.push("", clipText(report.checksSummary.trim(), 800));
  }
  return lines.join("\n").trim();
}

function compactList(items: unknown, label: string): string | null {
  if (!Array.isArray(items)) return null;
  const rows = items.slice(0, 40).map((item) => {
    if (!item || typeof item !== "object") return String(item);
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : "";
    const status = typeof o.status === "string" ? o.status : "";
    const title =
      typeof o.title === "string"
        ? o.title
        : typeof o.name === "string"
          ? o.name
          : "";
    const extra =
      typeof o.stage === "string"
        ? o.stage
        : typeof o.messageCount === "number"
          ? `${o.messageCount} msgs`
          : "";
    return `- ${id} ${status} ${title} ${extra}`.replace(/\s+/g, " ").trim();
  });
  return `${label} (${items.length}):\n${rows.join("\n")}`;
}

/**
 * Drop session dumps / HTML / nested reports so a 4k clip cannot hide the
 * operator-facing answer (same class of bug as agent `{ reply }` last).
 */
export function compactChatToolPayload(raw: string, _toolName?: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const max =
    _toolName === "ask"
      ? CHAT_ASK_TOOL_RESULT_MAX_CHARS
      : CHAT_TOOL_RESULT_MAX_CHARS;

  const envelope = splitMcpEnvelope(trimmed);
  if (envelope) {
    const header = envelope.header.trim();
    const body = envelope.body;
    if (!body) return header;
    const notesHit = /^notes:\s*(.+)$/m.exec(header);
    const notesLen = notesHit?.[1]?.length ?? 0;
    const bodyBudget =
      notesLen >= 200
        ? Math.min(1_200, max)
        : max - header.length - 16;
    return `${header}\n---\n${clipText(body, Math.max(400, bodyBudget))}`;
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const shaped = shapeJsonForChat(parsed);
    if (shaped) return shaped;
  } catch {
    /* not JSON */
  }

  return extractDispatchedReply(raw);
}

function shapeJsonForChat(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  // Lifecycle responses carry {run|runId, stage}. The session shaping below
  // (ask/agent/…) would drop that envelope, so keep it extractable for the
  // chat service's await/follow-up machinery — the trailing JSON is read by
  // extractBusyRunFromLifecycleResult, so nothing before it may contain "{".
  const runObj =
    obj.run && typeof obj.run === "object" && !Array.isArray(obj.run)
      ? (obj.run as Record<string, unknown>)
      : null;
  const runId =
    (typeof runObj?.id === "string" && runObj.id) ||
    (typeof obj.runId === "string" && obj.runId) ||
    "";
  const runStage =
    (typeof runObj?.stage === "string" && runObj.stage) ||
    (typeof obj.stage === "string" && obj.stage) ||
    "";
  if (runId && runStage && isBusyRunStage(runStage)) {
    const askId =
      obj.ask && typeof obj.ask === "object"
        ? String((obj.ask as { id?: unknown }).id ?? "")
        : "";
    const phaseId =
      obj.phase && typeof obj.phase === "object"
        ? String((obj.phase as { id?: unknown }).id ?? "")
        : "";
    const refs = [
      askId ? `ask ${askId}` : null,
      phaseId ? `phase ${phaseId}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    return `${refs ? `${refs} — ` : ""}run ${runId} is ${runStage}\n${JSON.stringify({ run: { id: runId, stage: runStage }, stage: runStage })}`;
  }

  if (typeof obj.reply === "string" && obj.reply.trim()) {
    const id =
      (typeof obj.askId === "string" && obj.askId) ||
      (typeof obj.agentId === "string" && obj.agentId) ||
      (typeof obj.loopId === "string" && obj.loopId) ||
      "";
    return id ? `${id}\n\n${obj.reply.trim()}` : obj.reply.trim();
  }

  if (obj.ask && typeof obj.ask === "object" && !Array.isArray(obj.ask)) {
    return compactSession(obj.ask as Record<string, unknown>, "ask");
  }
  if (obj.agent && typeof obj.agent === "object" && !Array.isArray(obj.agent)) {
    return compactSession(obj.agent as Record<string, unknown>, "agent");
  }
  if (Array.isArray(obj.messages) && typeof obj.id === "string") {
    return compactSession(obj, "session");
  }

  if (obj.report && typeof obj.report === "object" && !Array.isArray(obj.report)) {
    const handoff = compactHandoff(obj.report as Record<string, unknown>);
    if (handoff) {
      const msg =
        typeof obj.message === "string" && obj.message.trim()
          ? obj.message.trim()
          : "";
      return [msg, handoff].filter(Boolean).join("\n\n");
    }
  }
  if (typeof obj.message === "string" && obj.report === null) {
    return obj.message;
  }

  if (
    typeof obj.message === "string" &&
    typeof obj.runId === "string" &&
    typeof obj.settled === "boolean"
  ) {
    return obj.message;
  }

  if (typeof obj.notes === "string" && obj.notes.trim()) {
    const loopId =
      typeof obj.loopId === "string"
        ? obj.loopId
        : obj.loop && typeof obj.loop === "object"
          ? String((obj.loop as { id?: string }).id ?? "")
          : "";
    const plan =
      typeof obj.plan === "string" && obj.plan.trim() ? obj.plan.trim() : "";
    return [
      loopId ? `loopId: ${loopId}` : null,
      obj.notes.trim(),
      plan ? `---\n${clipText(plan, 2_500)}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  for (const [key, label] of [
    ["asks", "asks"],
    ["agents", "agents"],
    ["loops", "loops"],
    ["phases", "phases"],
    ["runs", "runs"],
  ] as const) {
    const listed = compactList(obj[key], label);
    if (listed) return listed;
  }

  return null;
}

function startChangeDescriptionMissing(raw: string): boolean {
  return (
    /fieldErrors.*description/i.test(raw) ||
    /description is required/i.test(raw) ||
    /expected string, received undefined/i.test(raw)
  );
}

/** Plain operator text for common MCP/HTTP validation failures. */
export function humanizeChatToolError(raw: string, toolName?: string): string {
  const trimmed = raw.trim();
  if (toolName === "start_change" && startChangeDescriptionMissing(trimmed)) {
    const detail = trimmed.length <= 200 ? trimmed : `${trimmed.slice(0, 200)}…`;
    return (
      "start_change failed: no task description was sent. The chat should include your full brief, or the agent must pass it in description." +
      (detail ? `\n(${detail})` : "")
    );
  }
  return trimmed;
}

/** Tool result text the chat operator model actually sees. */
export function formatChatDispatchResult(
  result: ChatToolResult,
  toolName?: string,
): string {
  const raw = result.content.map((c) => c.text).join("\n");
  const body = compactChatToolPayload(raw, toolName);
  const errorBody = result.isError ? humanizeChatToolError(body, toolName) : body;
  const prefixed = result.isError ? `ERROR:\n${errorBody}` : errorBody;
  const max =
    toolName === "ask"
      ? CHAT_ASK_TOOL_RESULT_MAX_CHARS
      : CHAT_TOOL_RESULT_MAX_CHARS;
  return clipChatToolText(prefixed, max);
}

/**
 * Build the Mastra tool set for one conversation. Project-scope
 * conversations get projectId pinned (agent cannot cross projects);
 * global-scope conversations pass projectId through explicitly.
 */
export function buildChatTools(opts: {
  dispatch: ChatToolDispatch;
  conversationId: string;
  /** Pinned project for project-scope chats; null for global scope. */
  projectId: string | null;
  requestConfirmation: (tool: string, args: Record<string, unknown>) => {
    token: string;
  };
  /**
   * Raw-result tap for free tools (they self-execute inside the agent loop,
   * so the service never post-processes them). Used to back wait_for_run's
   * "I'll let you know" with a real follow-up watcher.
   */
  onFreeToolResult?: (
    name: string,
    args: Record<string, unknown>,
    rawText: string,
    isError: boolean,
  ) => void;
}) {
  const { dispatch, projectId } = opts;
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  const withPinnedProject = (args: Record<string, unknown>) =>
    projectId ? { ...args, projectId } : args;

  for (const name of CHAT_FREE_TOOLS) {
    tools[name] = createTool({
      id: name,
      description: toolDescription(name, false),
      inputSchema: toolInputSchema(name),
      execute: async (input) => {
        const args = withPinnedProject(
          (input ?? {}) as Record<string, unknown>,
        );
        // reconcile_blueprint is only free as a dry-run preview.
        if (name === "reconcile_blueprint") args.dryRun = true;
        const result = await dispatch(name, args);
        const rawText = result.content.map((c) => c.text).join("\n");
        try {
          opts.onFreeToolResult?.(name, args, rawText, Boolean(result.isError));
        } catch {
          /* observer must not break the tool */
        }
        return formatChatDispatchResult(result, name);
      },
    });
  }

  for (const name of CHAT_GATED_TOOLS) {
    tools[name] = createTool({
      id: name,
      description: toolDescription(name, true),
      inputSchema: toolInputSchema(name),
      execute: async (input) => {
        const args = withPinnedProject(
          (input ?? {}) as Record<string, unknown>,
        );
        const { token } = opts.requestConfirmation(name, args);
        return {
          status: "pending_confirmation",
          token,
          tool: name,
          argsPreview: previewArgs(args),
          message:
            "This action is parked until the operator confirms it in this chat. " +
            "Tell them what will happen and wait for their next message. " +
            "Do not send them to a dashboard, REST, or MCP confirm.",
        };
      },
    });
  }

  return tools;
}
