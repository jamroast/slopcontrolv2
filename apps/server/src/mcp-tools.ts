import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { formatDurationMs, log } from "@slopcontrol/types";

export type CreateSlopcontrolMcpServerOptions = {
  serverUrl?: string;
};

export function defaultSlopcontrolServerUrl(): string {
  return `http://127.0.0.1:${process.env.SLOPCONTROL_PORT ?? 3020}`;
}

export const SLOPCONTROL_MCP_TOOLS: Tool[] = [
    {
      name: "open_project",
      description:
        "Open/bootstrap a project. Empty trees need intent (what to build). Existing trees reverse-engineer or validate BLUEPRINT.md.",
      inputSchema: {
        type: "object",
        properties: {
          rootPath: { type: "string" },
          name: { type: "string" },
          intent: {
            type: "string",
            description: "Required for empty/greenfield projects: what to build",
          },
          forceRefresh: { type: "boolean" },
        },
        required: ["rootPath"],
      },
    },
    {
      name: "reinit_project",
      description:
        "Force reverse-engineer BLUEPRINT.md from source code, archive prior planning, and reset development to phase zero (next phase will be 01-…). Use for projects like basic-web-agent that need a clean blueprint rebuild.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          rootPath: {
            type: "string",
            description: "Absolute project path (used if projectId omitted)",
          },
          notes: {
            type: "string",
            description: "Optional notes to include while reverse-engineering",
          },
        },
      },
    },
    {
      name: "delete_project",
      description:
        "Unregister a project from SlopControl (removes store entry, phases, runs, and worktrees). Does not delete source files under rootPath. Set purgeArtifacts=true to also remove <root>/.slopcontrol.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          rootPath: {
            type: "string",
            description: "Absolute project path (used if projectId omitted)",
          },
          purgeArtifacts: {
            type: "boolean",
            description:
              "If true, delete only <rootPath>/.slopcontrol (never the whole source tree)",
          },
        },
      },
    },
    {
      name: "start_change",
      description:
        "Start research for a new ordered phase on an opened project (project-scoped). Optional dependsOn: phase ids that must be complete before development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          description: { type: "string" },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional phase ids this phase depends on",
          },
        },
        required: ["projectId", "description"],
      },
    },
    {
      name: "list_runs",
      description: "List runs for a single project (required projectId)",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_phases",
      description: "List phases for a single project",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_worktrees",
      description:
        "List phase git worktrees for a project (paths under ~/.slopcontrol/worktrees, dirty/uncommitted status). Use this to see where development work actually lives before merging.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_git_status",
      description:
        "Show which branch is checked out in the project folder, whether it is dirty, and list local branches (including slop/* phase branches).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "checkout_branch",
      description:
        "Check out a branch in the project folder (not a phase worktree). Optionally create the branch. Dirty files are stashed by default.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          branch: { type: "string", description: "Branch name, e.g. main" },
          create: {
            type: "boolean",
            description: "Create the branch from HEAD if missing (default false)",
          },
          stashDirty: {
            type: "boolean",
            description: "Stash dirty project-root files before checkout (default true)",
          },
        },
        required: ["projectId", "branch"],
      },
    },
    {
      name: "remove_worktree",
      description:
        "Delete an old phase worktree under ~/.slopcontrol/worktrees. Optionally also delete the local slop/<phaseId> branch.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: { type: "string" },
          deleteBranch: {
            type: "boolean",
            description: "Also delete local branch slop/<phaseId> (default false)",
          },
        },
        required: ["projectId", "phaseId"],
      },
    },
    {
      name: "merge_phase",
      description:
        "Commit any uncommitted work in a phase worktree (if dirty), then merge branch slop/<phaseId> into the project root (default: current branch, usually main). Dirty files in the project root are stashed automatically (stashDirty defaults true) and restored after merge. Merge and stash-pop conflicts are auto-resolved preferring phase / post-merge content (conflictStrategy defaults prefer_phase). Removes the phase worktree by default (removeWorktree defaults true).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: {
            type: "string",
            description: "Phase id, e.g. 03-i-want-a-set-of-scripts-to-manage-the-lo",
          },
          targetBranch: {
            type: "string",
            description: "Branch in the project root to merge into (default: current branch)",
          },
          commitMessage: {
            type: "string",
            description: "Commit message if the worktree has uncommitted changes",
          },
          removeWorktree: {
            type: "boolean",
            description: "Remove the worktree after a successful merge (default true)",
          },
          stashDirty: {
            type: "boolean",
            description:
              "Stash dirty project-root files before merge (default true). Set false to refuse when dirty.",
          },
          conflictStrategy: {
            type: "string",
            enum: ["prefer_phase", "abort"],
            description:
              "On merge conflicts: prefer_phase (default) takes phase content and continues; abort restores previous behavior.",
          },
        },
        required: ["projectId", "phaseId"],
      },
    },
    {
      name: "list_conflicts",
      description:
        "List unmerged/conflicted files in a project's git working tree (e.g. leftover stash-pop or merge conflicts).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "resolve_conflicts",
      description:
        "Resolve git conflicts in the project root. Strategies: auto (default — prefer phase / post-merge 'ours' for stash conflicts), phase (take slop/<phaseId> blob), ours, theirs. Use after a merge left conflict markers, or call list_conflicts first.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          strategy: {
            type: "string",
            enum: ["ours", "theirs", "phase", "auto"],
            description: "Resolution strategy (default auto)",
          },
          phaseId: {
            type: "string",
            description: "Phase id for strategy=phase or auto (slop/<phaseId> blob)",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Optional subset of conflicted paths to resolve",
          },
          continueMerge: {
            type: "boolean",
            description:
              "If a merge is in progress and all conflicts clear, create the merge commit (default true)",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_health",
      description: "Check SlopControl server health (includes Mastra LibSQL storage probe)",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_run",
      description:
        "Get a run by id (stage, phase, log tail metadata, diagnosis, operator_suggestions).",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "get_phase_status",
      description:
        "Phase status + design completeness (needed/complete/hasUiSpec) + latest failure diagnosis / operator suggestions + handoff summary for a project phase.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: { type: "string" },
        },
        required: ["projectId", "phaseId"],
      },
    },
    {
      name: "get_operator_suggestions",
      description:
        "Structured operator actions for the latest blocked/failed develop run (or a specific phase/run). Use this to tell the human how to fix env/keys/services — do not invent worktree-only product workarounds.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: { type: "string" },
          runId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_development_report",
      description:
        "Post-dev status report after develop completes, blocks, or is interrupted: requirements met/unmet, operator requirements, knowledge, next steps, merge state. Call after start_development finishes to brief the human. Prefer runId when known.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: { type: "string" },
          runId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "start_design",
      description:
        "Optional design stage for UI/brand phases: UI-SPEC/tokens + Ollama image gen + vision review (capability-routed). Ends in design_complete (not accepted). Skip for non-visual phases. Run after approve, before start_development (path B). Idempotent when design is already complete unless force=true.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          force: {
            type: "boolean",
            description:
              "When true, re-run design even if DESIGN_COMPLETE + UI-SPEC already exist.",
          },
        },
        required: ["runId"],
      },
    },
    {
      name: "start_development",
      description:
        "Starts coding from accepted (path A, no design) or design_complete (path B). For UI/brand phases still lacking design, run start_design first (or pass autoDesign: true). Returns design_required if design is needed and incomplete. After it finishes, call get_development_report for operator requirements and knowledge.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          autoDesign: {
            type: "boolean",
            description:
              "When true, run the design stage first if the phase needs it, then coding.",
          },
        },
        required: ["runId"],
      },
    },
    {
      name: "retry_development",
      description: "Retry development for a blocked/interrupted/failed run.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "ask",
      description:
        "Project-scoped AI conversation (exploratory, read-only). Does not create a phase. Pass askId to continue an existing session. For several investigations use ask_sub_research. When the change is clear, call promote_ask to start research → design → develop. For shell inspect/verify without develop, use agent. For a direct new phase without chat, use start_change.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          message: { type: "string", description: "Operator question or follow-up" },
          askId: {
            type: "string",
            description: "Existing ask session id (omit to start a new conversation)",
          },
          title: {
            type: "string",
            description: "Optional title for a new ask session",
          },
        },
        required: ["projectId", "message"],
      },
    },
    {
      name: "list_asks",
      description: "List ask conversations for a project (id, title, status, messageCount).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_ask",
      description: "Get a full ask session including transcript messages.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          askId: { type: "string" },
        },
        required: ["projectId", "askId"],
      },
    },
    {
      name: "promote_ask",
      description:
        "Turn an ask conversation into a phase and start research (same pipeline as start_change). Uses ## Task brief from the transcript when present, or an optional description override. After research completes, approve review then start_design / start_development as usual.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          askId: { type: "string" },
          description: {
            type: "string",
            description: "Optional override for the phase description / research seed",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional phase ids this new phase depends on",
          },
        },
        required: ["projectId", "askId"],
      },
    },
    {
      name: "ask_sub_research",
      description:
        "Spawn up to 4 ephemeral parallel investigations inside an open ask session. Findings are appended to the ask transcript (no phases / no RESEARCH.md). Use when the operator needs several codebase probes before promote_ask.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          askId: { type: "string" },
          topics: {
            type: "array",
            items: { type: "string" },
            description: "1–4 investigation topics",
          },
        },
        required: ["projectId", "askId", "topics"],
      },
    },
    {
      name: "agent",
      description:
        "Project-scoped agent chat that can run shell commands in the project root (inspect/verify/diagnose). Not development — no worktrees, design, or merge. Pass agentId to continue. For exploratory task shaping without shell, use ask; for implementation use start_change / start_development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          message: { type: "string", description: "Operator question or follow-up" },
          agentId: {
            type: "string",
            description: "Existing agent session id (omit to start a new conversation)",
          },
          title: {
            type: "string",
            description: "Optional title for a new agent session",
          },
        },
        required: ["projectId", "message"],
      },
    },
    {
      name: "list_agents",
      description: "List agent chat sessions for a project (id, title, status, messageCount).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_agent",
      description: "Get a full agent chat session including transcript messages.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          agentId: { type: "string" },
        },
        required: ["projectId", "agentId"],
      },
    },
  ];

export function createSlopcontrolMcpServer(
  opts?: CreateSlopcontrolMcpServerOptions,
): Server {
  const SERVER_URL = opts?.serverUrl ?? defaultSlopcontrolServerUrl();

  const server = new Server(
    {
      name: "slopcontrol",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SLOPCONTROL_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    log.info("mcp", `tool ${name}`, {
      projectId: typeof args.projectId === "string" ? args.projectId : undefined,
      rootPath: typeof args.rootPath === "string" ? args.rootPath : undefined,
    });

    const wrap = async (
      work: () => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>,
    ) => {
      try {
        const result = await work();
        log.info("mcp", `tool ${name} done`, {
          ok: !result.isError,
          durationMs: Date.now() - started,
          duration: formatDurationMs(Date.now() - started),
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("mcp", `tool ${name} failed`, {
          error: message,
          durationMs: Date.now() - started,
        });
        return {
          content: [{ type: "text" as const, text: message }],
          isError: true,
        };
      }
    };

    if (name === "get_health") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/health`);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
        };
      });
    }

    if (name === "get_run") {
      return wrap(async () => {
        const runId = String(args.runId ?? "");
        const res = await fetch(`${SERVER_URL}/runs/${encodeURIComponent(runId)}`);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_phase_status") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const phaseId = String(args.phaseId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}/status`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_operator_suggestions") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const qs = new URLSearchParams();
        if (typeof args.phaseId === "string" && args.phaseId) {
          qs.set("phaseId", args.phaseId);
        }
        if (typeof args.runId === "string" && args.runId) {
          qs.set("runId", args.runId);
        }
        const q = qs.toString();
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/operator-suggestions${q ? `?${q}` : ""}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_development_report") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const qs = new URLSearchParams();
        if (typeof args.phaseId === "string" && args.phaseId) {
          qs.set("phaseId", args.phaseId);
        }
        if (typeof args.runId === "string" && args.runId) {
          qs.set("runId", args.runId);
        }
        const q = qs.toString();
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/development-report${q ? `?${q}` : ""}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "start_design") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start_design",
            runId: args.runId,
            force: args.force === true ? true : undefined,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "start_development") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start_development",
            runId: args.runId,
            autoDesign: args.autoDesign === true,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "retry_development") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "retry_development",
            runId: args.runId,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "open_project") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/projects/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            rootPath: args.rootPath,
            name: args.name,
            intent: args.intent,
            forceRefresh: args.forceRefresh,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "reinit_project") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/projects/reinit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectId: args.projectId,
            rootPath: args.rootPath,
            notes: args.notes,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "delete_project") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "").trim();
        const rootPath = String(args.rootPath ?? "").trim();
        const purgeArtifacts = Boolean(args.purgeArtifacts);
        if (!projectId && !rootPath) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "projectId or rootPath is required",
                }),
              },
            ],
            isError: true,
          };
        }
        const qs = new URLSearchParams();
        if (purgeArtifacts) qs.set("purgeArtifacts", "true");
        if (!projectId && rootPath) qs.set("rootPath", rootPath);
        const path = projectId
          ? `${SERVER_URL}/projects/${encodeURIComponent(projectId)}?${qs}`
          : `${SERVER_URL}/projects?${qs}`;
        const res = await fetch(path, { method: "DELETE" });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "start_change") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "start_research",
            projectId: args.projectId,
            description: args.description,
            dependsOn: args.dependsOn,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_runs") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/runs`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_phases") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/phases`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_worktrees") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/worktrees`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_git_status") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/git`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "checkout_branch") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/git/checkout`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              branch: args.branch,
              create: args.create,
              stashDirty: args.stashDirty,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "remove_worktree") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const phaseId = String(args.phaseId ?? "");
        const qs =
          args.deleteBranch === true || args.deleteBranch === "true"
            ? "?deleteBranch=true"
            : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(phaseId)}${qs}`,
          { method: "DELETE" },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "merge_phase") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const phaseId = String(args.phaseId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/phases/${encodeURIComponent(phaseId)}/merge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetBranch: args.targetBranch,
              commitMessage: args.commitMessage,
              removeWorktree:
                args.removeWorktree === undefined ? true : args.removeWorktree,
              stashDirty: args.stashDirty,
              conflictStrategy: args.conflictStrategy,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_conflicts") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/conflicts`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "resolve_conflicts") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/conflicts/resolve`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              strategy: args.strategy,
              phaseId: args.phaseId,
              paths: args.paths,
              continueMerge: args.continueMerge,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "ask") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: args.message,
              askId: args.askId,
              title: args.title,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_asks") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_ask") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const askId = String(args.askId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks/${encodeURIComponent(askId)}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "promote_ask") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const askId = String(args.askId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks/${encodeURIComponent(askId)}/promote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              description: args.description,
              dependsOn: args.dependsOn,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "ask_sub_research") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const askId = String(args.askId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks/${encodeURIComponent(askId)}/sub-research`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              topics: args.topics,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "agent") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/agents`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: args.message,
              agentId: args.agentId,
              title: args.title,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_agents") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/agents`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_agent") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const agentId = String(args.agentId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(agentId)}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    log.warn("mcp", `unknown tool ${name}`);
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}
