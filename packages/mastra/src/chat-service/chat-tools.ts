import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ChatToolDispatch, ChatToolResult } from "./types.js";

/**
 * Curated chat-tool surface over the SlopControl tool dispatch.
 *
 * Three tiers:
 * - FREE: read-only / conversational — the agent may call autonomously.
 * - GATED: mutating lifecycle actions — the wrapper parks the call as a
 *   pending action and returns `pending_confirmation`; it only executes
 *   after the operator confirms via REST/MCP confirm.
 * - Everything else (delete_project, remove_worktree, resolve_conflicts,
 *   the raw `slopcontrol` passthrough, …) is not exposed to the agent.
 */

export const CHAT_FREE_TOOLS: ReadonlySet<string> = new Set([
  // status / inspection
  "get_health",
  "get_run",
  "get_run_steps",
  "get_phase_status",
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
  "start_development",
  "retry_development",
  "retry_verify",
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
  "project_library_consume",
  "project_build_process_configure",
  "project_set_coding_tool",
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

function previewArgs(args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return json.length <= 400 ? json : `${json.slice(0, 400)}…`;
}

function resultText(result: ChatToolResult): string {
  return result.content.map((c) => c.text).join("\n");
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
}) {
  const { dispatch, projectId } = opts;
  const tools: Record<string, ReturnType<typeof createTool>> = {};

  const withPinnedProject = (args: Record<string, unknown>) =>
    projectId ? { ...args, projectId } : args;

  for (const name of CHAT_FREE_TOOLS) {
    tools[name] = createTool({
      id: name,
      description: `SlopControl ${name} (read-only).`,
      inputSchema: z.record(z.string(), z.unknown()),
      execute: async (input) => {
        const args = withPinnedProject(
          (input ?? {}) as Record<string, unknown>,
        );
        // reconcile_blueprint is only free as a dry-run preview.
        if (name === "reconcile_blueprint") args.dryRun = true;
        const result = await dispatch(name, args);
        return { ok: !result.isError, result: resultText(result) };
      },
    });
  }

  for (const name of CHAT_GATED_TOOLS) {
    tools[name] = createTool({
      id: name,
      description: `SlopControl ${name} (mutating — requires operator confirmation).`,
      inputSchema: z.record(z.string(), z.unknown()),
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
            "This action is parked until the operator confirms it. " +
            "Tell the operator what will happen and ask them to confirm or deny.",
        };
      },
    });
  }

  return tools;
}
