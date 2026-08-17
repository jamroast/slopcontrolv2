import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { formatDurationMs, log } from "@slopcontrol/types";
import {
  advanceRun,
  formatAdvanceRunResult,
  stageFromDispatchText,
} from "@slopcontrol/mastra";

export type CreateSlopcontrolMcpServerOptions = {
  serverUrl?: string;
};

export function defaultSlopcontrolServerUrl(): string {
  return `http://127.0.0.1:${process.env.SLOPCONTROL_PORT ?? 3020}`;
}

/** Parse one SSE `data:` JSON payload line (ignores comments / empty). */
export function parseSseDataLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const raw = trimmed.slice(5).trim();
  if (!raw || raw === "[DONE]") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function askProgressLogLine(event: Record<string, unknown>): string | null {
  const type = String(event.type ?? "");
  if (type === "tool_call" || type === "tool_result") {
    return String(event.summary ?? event.tool ?? type);
  }
  if (type === "status") {
    const summary = String(event.summary ?? "");
    if (!summary || summary === "step") return null;
    return summary;
  }
  if (type === "error") {
    return `error: ${String(event.error ?? "ask failed")}`;
  }
  return null;
}

async function consumeLiveTurnSse(
  sendLog: ((logger: string, line: string) => Promise<void>) | undefined,
  logger: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{
  ok: boolean;
  done?: Record<string, unknown>;
  errorText?: string;
}> {
  return consumeAskSseStream(body, async (event) => {
    const line = askProgressLogLine(event);
    if (!line) return;
    if (!sendLog) return;
    try {
      await sendLog(logger, line);
    } catch {
      /* ignore */
    }
  });
}

/**
 * Consume ask SSE body; invoke onEvent for each progress payload.
 * Returns the terminal done/error event (or a synthetic error).
 */
export async function consumeAskSseStream(
  body: ReadableStream<Uint8Array> | null,
  onEvent: (event: Record<string, unknown>) => void | Promise<void>,
): Promise<{
  ok: boolean;
  done?: Record<string, unknown>;
  errorText?: string;
}> {
  if (!body) {
    return { ok: false, errorText: "empty SSE body" };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal: Record<string, unknown> | undefined;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    for (const line of parts) {
      const event = parseSseDataLine(line);
      if (!event) continue;
      await onEvent(event);
      const t = String(event.type ?? "");
      if (t === "done" || t === "error" || t === "interrupted") {
        terminal = event;
      }
    }
  }
  if (buffer.trim()) {
    const event = parseSseDataLine(buffer);
    if (event) {
      await onEvent(event);
      const t = String(event.type ?? "");
      if (t === "done" || t === "error" || t === "interrupted") terminal = event;
    }
  }

  if (!terminal) {
    return { ok: false, errorText: "ask stream ended without done event" };
  }
  if (String(terminal.type) === "error" || String(terminal.type) === "interrupted") {
    return {
      ok: false,
      done: terminal,
      errorText: String(
        terminal.error ??
          (terminal.type === "interrupted" ? "interrupted" : "ask failed"),
      ),
    };
  }
  return { ok: true, done: terminal };
}

/**
 * Put askId first in MCP text so clients reliably reuse it on the next turn.
 */
/**
 * Put loopId first so clients reuse it; include mock HTML for display.
 */
/**
 * Put loopId first for plan loops; include PLAN.md for display.
 */
export function formatPlanLoopMcpEnvelope(body: string, ok: boolean): string {
  try {
    const parsed = JSON.parse(body) as {
      loop?: { id?: string; status?: string; currentVersion?: number };
      loopId?: string;
      version?: number;
      plan?: string;
      notes?: string;
      transcript?: string;
      error?: string;
      hint?: string;
      next?: string;
      phaseId?: string;
      usedScaffold?: boolean;
      conceptualModel?: {
        kind?: string;
        focus?: string;
        inScope?: string[];
      };
    };
    const loopId = parsed.loopId || parsed.loop?.id || "";
    if (!ok) {
      return [
        loopId ? `loopId: ${loopId}` : null,
        parsed.error ? `error: ${parsed.error}` : `error: ${body.slice(0, 500)}`,
        parsed.hint ? `hint: ${parsed.hint}` : null,
        "---",
        body,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const cm = parsed.conceptualModel;
    const cmLine = cm
      ? `conceptualModel: kind=${cm.kind ?? "?"} focus=${cm.focus ?? "?"}`
      : null;
    const plan =
      typeof parsed.plan === "string" && parsed.plan.trim()
        ? parsed.plan
        : null;
    return [
      `loopId: ${loopId}`,
      `status: ${parsed.loop?.status ?? "open"}`,
      parsed.version !== undefined ? `version: ${parsed.version}` : null,
      parsed.phaseId ? `phaseId: ${parsed.phaseId}` : null,
      cmLine,
      parsed.usedScaffold ? "usedScaffold: true" : null,
      parsed.hint ? `hint: ${parsed.hint}` : null,
      parsed.next ? `next: ${parsed.next}` : null,
      parsed.notes ? `notes: ${parsed.notes}` : null,
      "---",
      plan ? `\`\`\`markdown\n${plan}\n\`\`\`` : body,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return body;
  }
}

export function formatDesignLoopMcpEnvelope(body: string, ok: boolean): string {
  try {
    const parsed = JSON.parse(body) as {
      loop?: { id?: string; status?: string; currentVersion?: number };
      loopId?: string;
      version?: number;
      html?: string;
      notes?: string;
      transcript?: string;
      error?: string;
      hint?: string;
      next?: string;
      phaseId?: string;
      usedScaffold?: boolean;
      selections?: unknown[];
      concepts?: unknown[];
      conceptualModel?: {
        kind?: string;
        focus?: string;
        preserve?: string[];
        theme?: { modes?: string[]; togglePresent?: boolean };
        inScope?: string[];
      };
    };
    const loopId = parsed.loopId || parsed.loop?.id || "";
    if (!ok) {
      return [
        loopId ? `loopId: ${loopId}` : null,
        parsed.error ? `error: ${parsed.error}` : `error: ${body.slice(0, 500)}`,
        parsed.hint ? `hint: ${parsed.hint}` : null,
        "---",
        body,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const status = parsed.loop?.status ?? "open";
    const version = parsed.version ?? parsed.loop?.currentVersion;
    const html =
      typeof parsed.html === "string" && parsed.html.trim()
        ? parsed.html
        : null;
    const transcript =
      typeof parsed.transcript === "string" && parsed.transcript.trim()
        ? parsed.transcript
        : null;
    const transcriptBlock = transcript
      ? transcript.length > 12_000
        ? `${transcript.slice(0, 12_000)}\n…(truncated; full TRANSCRIPT.md on disk)`
        : transcript
      : null;
    const cm = parsed.conceptualModel;
    const cmLine = cm
      ? `conceptualModel: kind=${cm.kind ?? "?"} focus=${cm.focus ?? "?"}${
          cm.theme?.modes?.length
            ? ` theme=${cm.theme.modes.join("/")}`
            : ""
        }${cm.inScope?.length ? ` inScope=${cm.inScope.join(",")}` : ""}`
      : null;
    return [
      `loopId: ${loopId}`,
      `status: ${status}`,
      version !== undefined ? `version: ${version}` : null,
      parsed.phaseId ? `phaseId: ${parsed.phaseId}` : null,
      cmLine,
      parsed.usedScaffold ? "usedScaffold: true" : null,
      parsed.usedScaffold ? "hint: design_loop_retry" : null,
      parsed.hint && !parsed.usedScaffold ? `hint: ${parsed.hint}` : null,
      parsed.next ? `next: ${parsed.next}` : null,
      parsed.notes ? `notes: ${parsed.notes}` : null,
      Array.isArray(parsed.selections)
        ? `selections: ${JSON.stringify(parsed.selections)}`
        : null,
      Array.isArray(parsed.concepts)
        ? `concepts: ${parsed.concepts.length}`
        : null,
      "---",
      transcriptBlock ? `transcript:\n${transcriptBlock}` : null,
      transcriptBlock && html ? "---" : null,
      html
        ? `\`\`\`html\n${html}\n\`\`\``
        : !transcriptBlock
          ? body
          : null,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return body;
  }
}

export function formatAskMcpEnvelope(body: string, ok: boolean): string {
  try {
    const parsed = JSON.parse(body) as {
      ask?: { id?: string; status?: string; messages?: unknown[] };
      askId?: string;
      reply?: string;
      error?: string;
      code?: string;
      hint?: string;
      promotedPhaseId?: string;
      forkedFrom?: string;
    };
    const askId = parsed.askId || parsed.ask?.id || "";
    if (!ok) {
      return [
        askId ? `askId: ${askId}` : null,
        parsed.code ? `code: ${parsed.code}` : null,
        parsed.error ? `error: ${parsed.error}` : `error: ${body.slice(0, 500)}`,
        parsed.hint ? `hint: ${parsed.hint}` : null,
        typeof parsed.reply === "string" && parsed.reply.trim()
          ? `reply:\n${parsed.reply.trim()}`
          : null,
        parsed.promotedPhaseId
          ? `promotedPhaseId: ${parsed.promotedPhaseId}`
          : null,
        "---",
        body,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const status = parsed.ask?.status ?? "open";
    const messageCount = Array.isArray(parsed.ask?.messages)
      ? parsed.ask.messages.length
      : undefined;
    const reply =
      typeof parsed.reply === "string"
        ? parsed.reply
        : body;
    return [
      `askId: ${askId}`,
      `status: ${status}`,
      messageCount !== undefined ? `messageCount: ${messageCount}` : null,
      parsed.forkedFrom ? `forkedFrom: ${parsed.forkedFrom}` : null,
      "---",
      reply,
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    return body;
  }
}

export function formatAgentMcpEnvelope(opts: {
  agent?: unknown;
  reply?: string;
  error?: string;
}): string {
  const agent = opts.agent as { id?: string; status?: string } | undefined;
  const agentId = typeof agent?.id === "string" ? agent.id : "";
  const status = typeof agent?.status === "string" ? agent.status : "";
  const reply = (opts.reply ?? "").trim();
  if (opts.error) {
    return [
      agentId ? `agentId: ${agentId}` : null,
      `error: ${opts.error}`,
      reply ? `reply:\n${reply}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    agentId ? `agentId: ${agentId}` : null,
    status ? `status: ${status}` : null,
    "---",
    reply,
  ]
    .filter(Boolean)
    .join("\n");
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
      name: "rename_project",
      description:
        "Rename a project's display name (updates name only; rootPath/id and nested design-loop/phase URLs unchanged).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          rootPath: {
            type: "string",
            description: "Absolute project path (used if projectId omitted)",
          },
          name: { type: "string", description: "New display name" },
        },
        required: ["name"],
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
        "Get a run by id (stage, phase, log tail metadata, diagnosis with failingStep.stepId, operator_suggestions, verify_steps / verify_first_failure when develop verify has run).",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "wait_for_run",
      description:
        "Poll a run until it leaves researching/drafting/designing/developing (or times out). Use after start_change / start_development / start_design instead of repeating get_run. Returns the settled stage (in_review, complete, blocked, failed, …) or timedOut still busy.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          timeoutMs: {
            type: "number",
            description: "How long to wait (default 90000, max 180000).",
          },
        },
        required: ["runId"],
      },
    },
    {
      name: "get_run_steps",
      description:
        "List structured develop verify steps for a run (id, name, command, exitCode, ok, outputExcerpt) plus firstFailure. Prefer this over scraping logs after a blocked/failed develop verify. Diagnose, then call retry_verify (full suite) or retry_development (coding+verify+merge).",
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
      name: "submit_review",
      description:
        "Approve or request changes on an in_review research/draft. decision=approve accepts PHASE.md so coding can start. decision=request_changes re-drafts with feedback. Chat should call this (gated) instead of sending the operator to the dashboard. Confirming start_development while still in_review also accepts the review, then starts coding.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
          decision: {
            type: "string",
            enum: ["approve", "request_changes"],
          },
          feedback: {
            type: "string",
            description: "Required context when requesting changes.",
          },
        },
        required: ["runId", "decision"],
      },
    },
    {
      name: "advance_run",
      description:
        "Walk a parked run until work is actually running. in_review → approve review → start_development (start_design if required). Use when the operator says go ahead / accept / start development / continue. Does not auto-merge. Stops at researching/drafting/designing/developing, complete, blocked, failed, or interrupted.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "start_design",
      description:
        "Optional design stage for UI/brand phases: UI-SPEC/tokens + Ollama image gen + vision review (capability-routed). Ends in design_complete (not accepted). Skip for non-visual phases. Run after approve, before start_development (path B). Idempotent when design is already complete unless force=true. If the run is still in_review, this accepts the review first.",
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
        "Starts coding from accepted (path A, no design) or design_complete (path B). If the run is still in_review, this accepts the research review first, then starts coding — the operator does not need a separate dashboard Approve. For UI/brand phases still lacking design, run start_design first (or pass autoDesign: true). Returns design_required if design is needed and incomplete. After it finishes, call get_development_report for operator requirements and knowledge. Use submit_review when they only want to approve or request changes without coding.",
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
      description:
        "Retry development for a blocked/interrupted/failed run (coding + verify + merge). For re-running Automated Checks only after a diagnose pass, use retry_verify instead.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "retry_verify",
      description:
        "Re-run the full develop verify suite in the phase worktree (no coding agent, no merge). Allowed when stage is blocked/failed/interrupted. Returns ok, firstFailure, stepsSummary, and steps. Use get_run_steps to inspect; use retry_development when coding or merge is needed.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "design_loop_start",
      description:
        "Start a chat-driven look-and-feel loop: generates self-contained mock HTML (no product edits). Returns loopId + html + transcript + conceptualModel (scope/theme). Optional scope narrows the conceptual model (e.g. component+chat.composer). Briefs that ask to pull current/existing theming or design concepts seed PRIOR_DESIGN from the latest accepted/implemented loop (or phase design) and ground v1 on that mock — prefer design_loop_continue when iterating the same dirty loop. If usedScaffold/timeout, call design_loop_retry. Iterate with design_loop_continue, freeze with design_loop_accept, then implement_design.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          brief: {
            type: "string",
            description: "Look-and-feel brief (e.g. match JamPress header / dark chrome)",
          },
          phaseId: {
            type: "string",
            description: "Optional phase to attach when implementing later",
          },
          askId: {
            type: "string",
            description: "Optional related ask session id",
          },
          scope: {
            type: "object",
            description:
              "Optional conceptual-model scope override: { kind: product|shell|screen|component|flow, focus: string, preserve?: string[] }",
            properties: {
              kind: {
                type: "string",
                enum: ["product", "shell", "screen", "component", "flow"],
              },
              focus: { type: "string" },
              preserve: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
        required: ["projectId", "brief"],
      },
    },
    {
      name: "design_loop_continue",
      description:
        "Revise a design-loop mock from operator feedback (new version). Works on open loops, and also reopens accepted/implemented loops so you can iterate (e.g. v2) without starting a new loop. Pass baseVersion to fork from a specific active version (default: tip). On usedScaffold/timeout, call design_loop_retry. Does not edit product code — accept + implement_design to re-bind.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          message: {
            type: "string",
            description: "Feedback for the next mock revision",
          },
          baseVersion: {
            type: "number",
            description:
              "Active version to revise from (default: tip / currentVersion). Use after discarding a bad tip to continue from its parent.",
          },
        },
        required: ["projectId", "loopId", "message"],
      },
    },
    {
      name: "design_loop_get",
      description:
        "Fetch a design loop meta, chat transcript (TRANSCRIPT.md), mock HTML, notes, ACCEPTANCE feature checklist, conceptualModel (kind/focus/theme), siteInventory summary (nav/routes/logos), and usedScaffold for a version. Pass includeHtml=false when you only need chat.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: {
            type: "number",
            description: "Optional version number (default: accepted or current)",
          },
          includeHtml: {
            type: "boolean",
            description: "Include mock HTML (default true). Set false for transcript-only.",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_site_inventory",
      description:
        "Read-only live site inventory for a design loop: nav labels/hrefs from header/nav source, CTAs, app routes, token files, logos, public assets. Optional refresh=true rebuilds SITE_INVENTORY.json from the project tree.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          refresh: {
            type: "boolean",
            description: "Rebuild inventory from project source (default false)",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_import_design",
      description:
        "Import theme/logos from another project into this loop (design share). Resolves fromProjectId/fromRootPath/fromName (registered project name or literal sibling folder). Copies logos into the loop and ranks the SHARED DESIGN block above LIVE SITE for palette/logos on continue.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          fromProjectId: { type: "string", description: "Registered source project id" },
          fromRootPath: { type: "string", description: "Absolute path to source project" },
          fromName: { type: "string", description: "Source registered project name or sibling folder basename" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_acceptance",
      description:
        "Save accept-time feature checklist ticks (before or after drafting ticks; does not freeze the loop). Pass features[] with {id,label,accepted} or acceptedFeatureIds[].",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          features: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                accepted: { type: "boolean" },
              },
            },
            description: "Full feature list with accepted flags",
          },
          acceptedFeatureIds: {
            type: "array",
            items: { type: "string" },
            description: "Ids to mark accepted (others become unchecked)",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_retry",
      description:
        "Regenerate a design-loop version in place (overwrite mock/NOTES) after timeout/scaffold failure. Uses stored REQUEST.md or optional message override. Does not bump version. Loop must be open.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: {
            type: "number",
            description: "Version to regenerate (default: currentVersion)",
          },
          message: {
            type: "string",
            description: "Optional prompt override instead of stored REQUEST.md",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_accept",
      description:
        "Freeze a design-loop version + feature checklist as the visual contract (requires ≥1 ticked feature). Then call implement_design. Pass features or acceptedFeatureIds. If status is implemented, call design_loop_continue first to reopen.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: {
            type: "number",
            description: "Version to accept (default: current)",
          },
          features: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string" },
                accepted: { type: "boolean" },
              },
            },
          },
          acceptedFeatureIds: {
            type: "array",
            items: { type: "string" },
            description: "Feature ids to accept (e.g. palette, logo, applied_shell)",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_concepts",
      description:
        "List design-loop concept catalog + current pinned selections (logo/palette/type/shell/…). Use before design_loop_pin to discover conceptId/asset names. Also returned on design_loop_get.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_pin",
      description:
        "Pin a concept/asset as authoritative for a slot (default logo). Continue/retry must keep pinned assets; icon packs prefer pinned / true RGBA. Pass conceptId (e.g. Concept C / concept-c) and/or asset filename (e.g. ember-monogram-alpha.png).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          slot: {
            type: "string",
            description: "Selection slot (default logo). Also: palette, type, shell, content.",
          },
          conceptId: {
            type: "string",
            description: "Concept id or label (e.g. concept-c, Concept C)",
          },
          asset: {
            type: "string",
            description: "Asset filename under the loop assets/ folder",
          },
          label: { type: "string" },
          excerpt: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_unpin",
      description:
        "Unpin a design-loop selection slot (default: clear all pins). Pass slot=logo to clear only the logo pin.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          slot: {
            type: "string",
            description: "Slot to unpin (omit to clear all selections)",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_versions",
      description:
        "List design-loop version tree: tip, acceptedVersion, versions[] (parentVersion, status active|invalid), and tree children. Use before discard or continue with baseVersion.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_loop_discard",
      description:
        "Soft-discard a bad design-loop version (marks invalid; keeps files). If it is the tip, rewinds currentVersion to parentVersion. Cannot discard the accepted version. Then continue with baseVersion=parent or tip.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: {
            type: "number",
            description: "Version number to discard (e.g. 8)",
          },
          reason: {
            type: "string",
            description: "Optional reason recorded on the version + transcript",
          },
        },
        required: ["projectId", "loopId", "version"],
      },
    },
    {
      name: "implement_design",
      description:
        "Bind an accepted design-loop mock + ACCEPTANCE checklist to a phase: writes UI-SPEC, tokens.css, design/mock.html, design/ACCEPTANCE.json, DESIGN_COMPLETE. Creates a new phase and starts research when phaseId is omitted — including after a prior implement on the same loop (even if the old phase is still incomplete). Pass phaseId only to force rebind onto an existing phase (no automatic new research unless that creates a new phase). Product code still only changes in start_development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          phaseId: {
            type: "string",
            description:
              "Force rebind onto this existing phase (skips opening a new phase). Omit (recommended) so each implement after accept gets a new phase + research.",
          },
          startResearch: {
            type: "boolean",
            description:
              "When creating a new phase, start research (default true). Set false to only bind design artifacts.",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional phase ids when creating a new phase",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "relaunch_design_research",
      description:
        "Recovery: create a new phase from an accepted/implemented design loop, rebind the current mock + DESIGN_PACK + UI-SPEC, and always start research. Use when implement_design only stamped design_complete without a research run (stale RESEARCH/PHASE). Pass loopId and/or phaseId (phaseId resolves via loop.meta.phaseId or design/STATUS.md). Product code still only changes after review → start_development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: {
            type: "string",
            description: "Design loop id (preferred when known)",
          },
          phaseId: {
            type: "string",
            description:
              "Stuck phase that was bound from implement_design — used to find the design loop when loopId is omitted",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
            description: "Optional phase ids for the new research phase",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "npm_registry_status",
      description:
        "Status of SlopControl's private Verdaccio npm registry (url, up, scopes, packages). Auto-starts with the server unless SLOPCONTROL_NPM_REGISTRY=0.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "npm_registry_start",
      description: "Start the private Verdaccio registry under ~/.slopcontrol/npm-registry.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "npm_registry_stop",
      description: "Stop the private Verdaccio registry process.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "npm_registry_ensure_rc",
      description:
        "Write scoped @jam / @slopcontrol registry lines + auth token into a project's .npmrc so pnpm/npm can install private packages.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "npm_registry_list",
      description: "List packages published to the private registry storage.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "npm_registry_publish",
      description:
        "npm publish a package directory to the local SlopControl registry (starts registry if needed).",
      inputSchema: {
        type: "object",
        properties: {
          packageDir: {
            type: "string",
            description: "Absolute path to a folder with package.json",
          },
          tag: { type: "string" },
        },
        required: ["packageDir"],
      },
    },
    {
      name: "design_element_publish_npm",
      description:
        "Scaffold @jam/<elementId> from a design element's src/ and publish it to the private npm registry. Prefer after design_element_extract/publish.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          elementId: { type: "string" },
          version: { type: "number" },
        },
        required: ["projectId", "elementId"],
      },
    },
    {
      name: "design_library_publish",
      description:
        "Publish a component-library project (e.g. jamroast-components) to the private registry via its OWN toolchain: build (when dist stale) → semver bump → publish (409 → bump+retry), then propagate name@^version to all registered consumers so their lockfiles refresh natively.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          bump: {
            type: "string",
            enum: ["patch", "minor", "major"],
            description: "Version bump (default patch)",
          },
          propagate: {
            type: "boolean",
            description: "Update registered consumers (default true)",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_build_process_state",      description:
        "Read a project's build-process state: resolved BuildToolchain (commands as data) + recorded BUILD_PROCESS.json evidence. No LLM call.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_build_process_audit",
      description:
        "LLM audit of a project's build process against the SlopControl capability checklist (build → publish → consume → docker → CI). Reports gaps + proposed changes; applies nothing.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_build_process_configure",
      description:
        "LLM configurator: resolve the project's BuildToolchain (npm/pnpm/rust/python/...) and apply guardrailed build-process changes, then persist the toolchain. Idempotent; low-confidence results are audit-only.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          runCommands: {
            type: "boolean",
            description: "Execute allowlisted toolchain commands (default true)",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_library_consume",
      description:
        "Update this project to a published library version from the local SlopControl registry via the project's own toolchain (e.g. pnpm add @jamroast/components@^x.y.z) and commit the bump. Version defaults to the registry's latest. Use for projects imported before publish-time propagation existed.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          packageName: { type: "string" },
          version: {
            type: "string",
            description: "Target version (default: registry latest)",
          },
        },
        required: ["projectId", "packageName"],
      },
    },
    {
      name: "project_set_coding_tool",
      description:
        "Switch the coding agent used for a project's development/design loops (opencode|pi). Takes effect on the next coding session.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          toolId: {
            type: "string",
            description: "Registered coding tool id (opencode|pi)",
          },
        },
        required: ["projectId", "toolId"],
      },
    },
    {
      name: "project_set_ask_investigate_tool",
      description:
        "Switch the Ask investigation walker for a project: auto (heuristic), mastra (faster Mastra tools), or pi (thorough read-only walk). Takes effect on the next ask. Bind the judge model separately with chat_function_bind function=judge.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          tool: {
            type: "string",
            enum: ["auto", "mastra", "pi"],
            description: "auto | mastra | pi",
          },
        },
        required: ["projectId", "tool"],
      },
    },
    {
      name: "project_env_sync",
      description:
        "Run the project-native env sync (toolchain envSyncCmd) at the project root: merges gitignored runtime env files (.env.local/.env.docker) from the project's templates, preserving existing values. Fails with a hint when the project has no envSyncCmd.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "project_runs_compact",
      description:
        "Flatten a project's old terminal runs into a single archive run: digests + unified change stats are kept, raw run dirs are tar.gz'd under .slopcontrol/archive, and the runs list collapses to one synthetic archive row. Never touches active runs or the latest run per phase. Pass dryRun=true to preview the merge set.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          dryRun: {
            type: "boolean",
            description: "Preview the merge set without writing (default false)",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_design_elements",
      description:
        "List shared design elements in the project library (.slopcontrol/elements) and the global registry (~/.slopcontrol/shared-elements). Use before design_element_import.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          includeRegistry: {
            type: "boolean",
            description: "Include global registry (default true)",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_cross_project_deps",
      description:
        "Unified catalog: design elements (local/registry/siblings), private npm packages (@jam/@slopcontrol), and registered project summaries. Prefer this before inventing shared UI or recommending npm link. After resolve, use design_element_import / npm_registry_ensure_rc / pnpm add.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          filterProjectId: {
            type: "string",
            description: "Optional filter by registered project id or name",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "resolve_dependency",
      description:
        "Resolve free-text or structured element/package/from-project into recommended actions (ensure_rc, import_element, pnpm_add). Never recommends npm link. Then call list_design_elements / design_element_import / npm_registry_* as needed.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          text: { type: "string" },
          elementId: { type: "string" },
          packageName: { type: "string" },
          fromName: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "design_element_get",
      description:
        "Resolve and fetch a shared design element (meta, SPEC, mock snippet, hasCode). origin: registry | project:<registered-name> | omit for resolve order.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          elementId: { type: "string" },
          version: { type: "number" },
          origin: { type: "string" },
        },
        required: ["projectId", "elementId"],
      },
    },
    {
      name: "design_element_publish",
      description:
        "Publish a design element into the project library (A/C). Set publishToRegistry=true to also write the global registry (B). Provide elementId + spec + mockHtml; optional srcFiles for TS/JS.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          elementId: { type: "string" },
          spec: { type: "string" },
          mockHtml: { type: "string" },
          label: { type: "string" },
          kind: {
            type: "string",
            description: "control | shell | pattern",
          },
          tokensCss: { type: "string" },
          srcFiles: {
            type: "object",
            description: "Map of relative path → source text under element src/",
          },
          mountHints: { type: "array", items: { type: "string" } },
          publishToRegistry: { type: "boolean" },
        },
        required: ["projectId", "elementId", "spec", "mockHtml"],
      },
    },
    {
      name: "list_extractable_design_elements",
      description:
        "List extractable shared-element candidates from a design-loop mock (data-element markers + known chrome: menubar, theme-toggle, user-pill, …). Use returned id/label with design_element_extract.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: {
            type: "number",
            description: "Mock version (default: current)",
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_element_extract",
      description:
        "Extract a shared element from a design-loop mock and publish to the project library. Prefer list_extractable_design_elements first, then pass the listed elementId (and optional label). Without elementId, defaults to theme-toggle when present. Optional publishToRegistry.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          elementId: {
            type: "string",
            description:
              "Id from list_extractable_design_elements (e.g. menubar, theme-toggle)",
          },
          version: { type: "number" },
          label: { type: "string" },
          kind: { type: "string" },
          publish: {
            type: "boolean",
            description: "Publish after extract (default true)",
          },
          publishToRegistry: { type: "boolean" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "design_element_import",
      description:
        "Import a resolved shared element into a design loop (pins META.elements + selection). Mock continues must embed it once. origin e.g. project:<registered-name> or registry.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          elementId: {
            type: "string",
            description: "Default theme-toggle",
          },
          version: { type: "number" },
          origin: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "list_design_loops",
      description: "List design-loop sessions for a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "plan_loop_start",
      description:
        "Start a chat-driven plan loop: generates structured PLAN.md (no product edits). Returns loopId + plan + conceptualModel. Iterate with plan_loop_continue, tick acceptance, plan_loop_accept, then plan_loop_promote → research.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          brief: { type: "string" },
          askId: {
            type: "string",
            description: "Optional related ask session id",
          },
          scope: {
            type: "object",
            description:
              "Optional { kind: feature|bugfix|refactor|integration|spike, focus: string, preserve?: string[] }",
          },
        },
        required: ["projectId", "brief"],
      },
    },
    {
      name: "plan_loop_continue",
      description:
        "Revise a plan-loop PLAN.md from operator feedback (new version). Reopens accepted/promoted loops. Optional baseVersion to fork from an active ancestor.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          message: { type: "string" },
          baseVersion: { type: "number" },
        },
        required: ["projectId", "loopId", "message"],
      },
    },
    {
      name: "plan_loop_get",
      description:
        "Fetch plan loop meta, transcript, PLAN.md, acceptance, planPack, conceptualModel. Pass includePlan=false for chat-only.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: { type: "number" },
          includePlan: { type: "boolean" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_acceptance",
      description:
        "Save plan acceptance checklist ticks without freezing the loop (goal, scope, approach, areas, success, risks).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          acceptedFeatureIds: {
            type: "array",
            items: { type: "string" },
          },
          features: { type: "array", items: { type: "object" } },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_accept",
      description:
        "Freeze a plan-loop version + checklist as PLAN_PACK.json (requires ≥1 ticked feature and complete PLAN sections). Rejects usedScaffold / failure-scaffold PLAN.md — call plan_loop_retry until usedScaffold is false. Then call plan_loop_promote.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: { type: "number" },
          acceptedFeatureIds: {
            type: "array",
            items: { type: "string" },
          },
          features: { type: "array", items: { type: "object" } },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_promote",
      description:
        "Bind accepted PLAN.md + PLAN_PACK to a new phase and start research (default). Rejects usedScaffold / failure-scaffold plans — call plan_loop_retry first. Research receives the plan contract as authoritative operator intent. Product code still only changes in start_development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          startResearch: {
            type: "boolean",
            description: "Start research after bind (default true)",
          },
          dependsOn: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_retry",
      description:
        "Regenerate the tip plan version in place after scaffold/timeout.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_versions",
      description: "List plan-loop version tree (tip, parentVersion, status).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "plan_loop_discard",
      description:
        "Soft-discard a bad plan version (marks invalid; rewinds tip to parent when discarding tip).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: { type: "number" },
          reason: { type: "string" },
        },
        required: ["projectId", "loopId", "version"],
      },
    },
    {
      name: "list_plan_loops",
      description: "List plan-loop sessions for a project.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "generate_design_image",
      description:
        "Generate a raster (logo/icon/hero) via roles.designImage (openai-images / Flux). Prefer attaching loopId for design-loop assets. Hard-fails if designImage is unbound.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          prompt: { type: "string" },
          loopId: { type: "string" },
          filename: { type: "string" },
          width: { type: "number" },
          height: { type: "number" },
        },
        required: ["projectId", "prompt"],
      },
    },
    {
      name: "search_design_images",
      description:
        "Search Openverse (open-licensed Wikimedia / Flickr CC / museums) for reference or stock images. Returns ids — use import_design_image to materialize into a design loop.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          query: { type: "string" },
          source: {
            type: "string",
            description: "Optional Openverse source filter (e.g. wikimedia)",
          },
          pageSize: { type: "number" },
        },
        required: ["projectId", "query"],
      },
    },
    {
      name: "import_design_image",
      description:
        "Import an Openverse image id into a design-loop assets folder (with attribution sidecar).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          openverseId: { type: "string" },
          filename: { type: "string" },
        },
        required: ["projectId", "loopId", "openverseId"],
      },
    },
    {
      name: "review_design_loop",
      description:
        "Screenshot the design-loop mock.html and critique look-and-feel via roles.designVision. Writes vN/REVIEW.md.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          version: { type: "number" },
        },
        required: ["projectId", "loopId"],
      },
    },
    {
      name: "ask",
      description:
        "Project-scoped AI conversation (exploratory, read-only). Does not create a phase. Omitting askId continues the project's latest open ask (sticky resume) for the Ask UI / MCP. Chat-service conversations never omit both askId and newAsk — they latch per chat and start a new ask on topic shift. Pass askId to target a specific session. Pass newAsk=true to force a fresh conversation. Always reuse askId from the previous ask response when continuing the same investigation. For several investigations use ask_sub_research. When the change is clear, call promote_ask. After promote, use fork_ask to keep chatting. For shell inspect/verify without develop, use agent. For look-and-feel mocks use design_loop_start. While a turn is running, call stop_session to interrupt.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          message: { type: "string", description: "Operator question or follow-up" },
          askId: {
            type: "string",
            description:
              "Existing ask session id. Prefer reusing the askId from the last ask response. If omitted, resumes the latest open ask for the project.",
          },
          newAsk: {
            type: "boolean",
            description:
              "If true, always start a new open ask (ignore sticky resume). Default false.",
          },
          title: {
            type: "string",
            description: "Optional title for a new ask session",
          },
          investigateTool: {
            type: "string",
            enum: ["auto", "mastra", "pi"],
            description:
              "Investigate walker for this turn: mastra (fast), pi (thorough), auto (project default + classified thorough/quick intent). Overrides the project askInvestigateTool for this call only.",
          },
        },
        required: ["projectId", "message"],
      },
    },
    {
      name: "list_asks",
      description:
        "List ask conversations for a project (id, title, status, messageCount). Prefer open asks for continue; promoted/archived are history — fork_ask to continue them.",
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
      name: "fork_ask",
      description:
        "Clone an ask (usually promoted or archived) into a new open session with the same transcript so chat can continue after promote_ask.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          askId: { type: "string", description: "Source ask to fork" },
          title: {
            type: "string",
            description: "Optional title for the forked open ask",
          },
        },
        required: ["projectId", "askId"],
      },
    },
    {
      name: "promote_ask",
      description:
        "Turn an ask conversation into a phase and start research (same pipeline as start_change). Uses ## Task brief from the transcript when present, or an optional description override. After research completes, approve review then start_design / start_development as usual. The original ask becomes promoted (read-only); use fork_ask to keep chatting.",
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
      name: "stop_session",
      description:
        "Interrupt an in-flight interactive turn (ask, agent, design_loop, or plan_loop). Use when the turn is looping, too slow, or the operator wants to redirect. Returns immediately; the streaming tool call ends with code interrupted.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          kind: {
            type: "string",
            enum: ["ask", "agent", "design_loop", "plan_loop"],
          },
          id: {
            type: "string",
            description: "askId / agentId / loopId for that kind",
          },
        },
        required: ["projectId", "kind", "id"],
      },
    },
    {
      name: "agent",
      description:
        "Project-scoped agent chat that can run shell commands in the project root (inspect/verify/diagnose). Not development — no worktrees, design, or merge. Pass agentId to continue. For exploratory task shaping without shell, use ask; for implementation use start_change / start_development. While running, call stop_session to interrupt.",
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
    {
      name: "preview_change_intent",
      description:
        "Dry-run Change Intent extraction (uiMount, engagement inheritance, interaction contract). Optionally align against a phase PHASE.md. Does not write files.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          description: {
            type: "string",
            description: "Operator request text to score",
          },
          phaseId: {
            type: "string",
            description: "Optional phase for refinementOf exclude + PHASE align",
          },
          checkPhaseDoc: {
            type: "boolean",
            description: "When true, run phaseDocAlignsWithChangeIntent on PHASE.md",
          },
        },
        required: ["projectId", "description"],
      },
    },
    {
      name: "reconcile_blueprint",
      description:
        "Reconcile BLUEPRINT.md (dedupe BDs, intent-aware mount GC, rebuild Live decisions). Defaults to dryRun=true (no write).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          phaseId: {
            type: "string",
            description: "Optional phase INTENT for mount preference",
          },
          dryRun: {
            type: "boolean",
            description: "Default true — set false to write BLUEPRINT.md",
          },
        },
        required: ["projectId"],
      },
    },
    {
      name: "audit_ui_gates",
      description:
        "Operator smoke for UI engagement gates: Intent preview, PHASE alignment, dry-run Blueprint reconcile, pass/fail checks. Does not write files.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          description: {
            type: "string",
            description: "Optional operator text (else uses phase description)",
          },
          phaseId: { type: "string" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "chat_start",
      description:
        "Start a chat-service conversation. Pass projectId for a project-scoped operator chat (lifecycle-aware, project tools pinned); omit for a global cross-project control chat. Returns the conversation id.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          title: { type: "string" },
          endpointId: {
            type: "string",
            description: "Optional model override endpoint",
          },
          modelId: {
            type: "string",
            description: "Optional model override model",
          },
        },
      },
    },
    {
      name: "chat_list",
      description:
        "List chat-service conversations. projectId filters to one project; global=true lists global-scope chats; omit both for all.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          global: { type: "boolean" },
          status: { type: "string", enum: ["active", "closed"] },
        },
      },
    },
    {
      name: "chat_get",
      description:
        "Get a chat conversation's metadata plus its operator-facing transcript (user/assistant text; tool internals omitted).",
      inputSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
    },
    {
      name: "chat_send",
      description:
        "Send a message to a chat-service conversation and stream the turn. Returns the agent reply plus a transcript of tool calls and confirmation requests.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          message: { type: "string" },
        },
        required: ["conversationId", "message"],
      },
    },
    {
      name: "chat_confirm",
      description:
        "Approve or deny a pending confirmation-gated action in a chat conversation (token comes from a confirm_request event / chat_send transcript).",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          token: { type: "string" },
          approve: { type: "boolean" },
        },
        required: ["conversationId", "token", "approve"],
      },
    },
    {
      name: "chat_close",
      description:
        "Close a chat conversation (keeps history; reopen anytime with chat_reopen). Chats idle past 7 days (SLOPCONTROL_CHAT_IDLE_CLOSE_MS) auto-close — except while their awaited run is still live and busy. A closed chat consumes no resources and can be woken months later.",
      inputSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
    },
    {
      name: "chat_reopen",
      description:
        "Re-open a closed chat conversation so the operator can continue the thread. History is preserved; use after auto-idle-close or manual chat_close.",
      inputSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
    },
    {
      name: "chat_delete",
      description: "Delete a chat conversation and its metadata.",
      inputSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
    },
    {
      name: "chat_get_awaited_run",
      description:
        "Get the run a chat conversation is currently awaiting (if any). Returns null when the conversation is not waiting on any run. Includes live stage and elapsed time for dashboard display.",
      inputSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
    },
    {
      name: "chat_list_awaited_runs",
      description:
        "List all active conversations that are currently awaiting a run, with live stage and elapsed time. Useful for a dashboard overview of in-flight work.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "chat_models_list",
      description:
        "List platform functions (research, planning, coding, classification, chat, ask, agent, judge, …) with the model currently bound to each, plus the models providers advertise. Use this before chat_function_bind. Do not treat endpoint ids like ollama-cloud-kimi as the thing to switch.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "chat_model_set",
      description:
        "Override the model for one chat conversation only. Pass endpointId + modelId from chat_models_list — endpointId may be a providers.json key (e.g. ollama-cloud) or a concrete endpoints.json id. Does not change platform function mappings — use chat_function_bind for that.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          endpointId: { type: "string" },
          modelId: { type: "string" },
        },
        required: ["conversationId", "endpointId", "modelId"],
      },
    },
    {
      name: "chat_function_bind",
      description:
        "Map a platform function (role) to a model on a provider. Pass provider (providers.json key from chat_models_list) and modelId. Creates or reuses an endpoint with that provider+model. endpointId is legacy — prefer provider.",
      inputSchema: {
        type: "object",
        properties: {
          function: {
            type: "string",
            description:
              "Function to bind: research, planning, supervisor, coding, design, designVision, designImage, classification, chat, ask, agent, judge.",
          },
          modelId: { type: "string" },
          provider: {
            type: "string",
            description:
              "providers.json key from chat_models_list (e.g. openrouter, ollama-cloud).",
          },
          endpointId: {
            type: "string",
            description:
              "Legacy provider handle; use provider instead when available.",
          },
        },
        required: ["function", "modelId"],
      },
    },
    {
      name: "chat_get_run_status",
      description:
        "Lightweight run status for dashboard polling. Returns stage, stageKind, and elapsed time without the full run detail or log tail. Use this for progress indicators; use get_run for full detail.",
      inputSchema: {
        type: "object",
        properties: {
          runId: { type: "string" },
        },
        required: ["runId"],
      },
    },
    {
      name: "provider_list",
      description:
        "List configured LLM providers from providers.json. Keys are redacted (shown as \"***\" or null). Use this before provider_set or chat_function_bind.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "provider_set",
      description:
        "Set or update a provider's configuration in providers.json. Pass apiKey (or null for local), plus optional defaultBaseUrl, headers, timeoutMs, defaultParams.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          apiKey: { type: "string", nullable: true },
          defaultBaseUrl: { type: "string" },
          headers: { type: "object", additionalProperties: { type: "string" } },
          timeoutMs: { type: "number" },
          defaultParams: {
            type: "object",
            properties: {
              temperature: { type: "number" },
              maxTokens: { type: "number" },
              topP: { type: "number" },
            },
          },
        },
        required: ["name"],
      },
    },
    {
      name: "provider_remove",
      description: "Remove a provider from providers.json.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "provider_test",
      description:
        "Test connectivity for a provider by listing its models. Returns the model catalog or an error. Uses the provider's configured baseUrl and apiKey.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
    },
  ];

export type DispatchSlopcontrolToolOptions = {
  serverUrl?: string;
  /** MCP `_meta.progressToken` from the incoming request, when present. */
  progressToken?: string | number;
  /** Progress-line sink (MCP logging when serving; omitted in-process). */
  sendLog?: (logger: string, line: string) => Promise<void>;
  /** MCP progress notification sink (only when progressToken is set). */
  sendProgress?: (
    progressToken: string | number,
    progress: number,
    message: string,
  ) => Promise<void>;
};

export type SlopcontrolToolResult = {
  content: { type: string; text: string }[];
  isError?: boolean;
};

/**
 * Single source of truth for every SlopControl tool: the MCP transport
 * (createSlopcontrolMcpServer) and in-process callers (the chat service)
 * both dispatch through here. Handlers call the REST API over loopback.
 */

/** 409 from start_development / start_design when the run is still in_review. */
export function isReviewRequiredConflict(status: number, body: string): boolean {
  if (status !== 409) return false;
  let error = body;
  let stage = "";
  let phaseStatus = "";
  try {
    const parsed = JSON.parse(body) as {
      error?: unknown;
      stage?: unknown;
      phaseStatus?: unknown;
    };
    if (typeof parsed.error === "string") error = parsed.error;
    if (typeof parsed.stage === "string") stage = parsed.stage;
    if (typeof parsed.phaseStatus === "string") phaseStatus = parsed.phaseStatus;
  } catch {
    /* raw body */
  }
  if (!/must be accepted or design_complete/i.test(error)) return false;
  return stage === "in_review" || phaseStatus === "in_review" || !stage;
}

/**
 * When coding/design is confirmed while research is still in_review, accept
 * the review then retry. Confirming start_development is accepting the plan.
 */
export async function retryAfterImpliedReviewApprove(opts: {
  firstStatus: number;
  firstBody: string;
  approve: () => Promise<{ status: number; body: string }>;
  retry: () => Promise<{ status: number; body: string }>;
}): Promise<{ status: number; body: string }> {
  if (!isReviewRequiredConflict(opts.firstStatus, opts.firstBody)) {
    return { status: opts.firstStatus, body: opts.firstBody };
  }
  const approved = await opts.approve();
  if (approved.status >= 400) return approved;
  return opts.retry();
}

export async function dispatchSlopcontrolTool(
  name: string,
  args: Record<string, unknown>,
  opts?: DispatchSlopcontrolToolOptions,
): Promise<SlopcontrolToolResult> {
  const SERVER_URL = opts?.serverUrl ?? defaultSlopcontrolServerUrl();
  const sendLog = opts?.sendLog;
  const sendProgress = opts?.sendProgress;
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

    if (name === "wait_for_run") {
      return wrap(async () => {
        const runId = String(args.runId ?? "");
        const timeoutMs =
          typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
        const res = await fetch(
          `${SERVER_URL}/runs/${encodeURIComponent(runId)}/wait`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ timeoutMs }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "get_run_steps") {
      return wrap(async () => {
        const runId = String(args.runId ?? "");
        const res = await fetch(
          `${SERVER_URL}/runs/${encodeURIComponent(runId)}/steps`,
        );
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

    const postRuns = async (payload: Record<string, unknown>) => {
      const res = await fetch(`${SERVER_URL}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.text() };
    };
    const asToolResult = (result: { status: number; body: string }) => ({
      content: [{ type: "text" as const, text: result.body }],
      isError: result.status >= 400,
    });
    const withImpliedReview = (
      runId: unknown,
      payload: Record<string, unknown>,
      first: { status: number; body: string },
    ) =>
      retryAfterImpliedReviewApprove({
        firstStatus: first.status,
        firstBody: first.body,
        approve: () =>
          postRuns({
            action: "submit_review",
            runId,
            decision: "approve",
          }),
        retry: () => postRuns(payload),
      });

    if (name === "submit_review") {
      return wrap(async () => {
        const decision = args.decision;
        if (decision !== "approve" && decision !== "request_changes") {
          return {
            content: [
              {
                type: "text" as const,
                text: "decision must be approve or request_changes",
              },
            ],
            isError: true,
          };
        }
        return asToolResult(
          await postRuns({
            action: "submit_review",
            runId: args.runId,
            decision,
            feedback:
              typeof args.feedback === "string" ? args.feedback : undefined,
          }),
        );
      });
    }

    if (name === "advance_run") {
      return wrap(async () => {
        const runId = String(args.runId ?? "").trim();
        if (!runId) {
          return {
            content: [{ type: "text" as const, text: "runId is required" }],
            isError: true,
          };
        }
        const projectId =
          typeof args.projectId === "string" ? args.projectId : undefined;
        const advanced = await advanceRun({
          runId,
          projectId,
          getStage: async () => {
            const res = await fetch(
              `${SERVER_URL}/runs/${encodeURIComponent(runId)}`,
            );
            if (!res.ok) return undefined;
            return stageFromDispatchText(await res.text());
          },
          dispatch: async (tool, toolArgs) => {
            if (tool === "advance_run") {
              return {
                text: "advance_run cannot nest",
                isError: true,
              };
            }
            const nested = await dispatchSlopcontrolTool(tool, toolArgs, opts);
            return {
              text: nested.content.map((c) => c.text).join("\n"),
              isError: Boolean(nested.isError),
            };
          },
        });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...advanced,
                message: formatAdvanceRunResult(advanced),
              }),
            },
          ],
          isError: advanced.kind === "error",
        };
      });
    }

    if (name === "start_design") {
      return wrap(async () => {
        const payload = {
          action: "start_design",
          runId: args.runId,
          force: args.force === true ? true : undefined,
        };
        const first = await postRuns(payload);
        return asToolResult(await withImpliedReview(args.runId, payload, first));
      });
    }

    if (name === "start_development") {
      return wrap(async () => {
        const payload = {
          action: "start_development",
          runId: args.runId,
          autoDesign: args.autoDesign === true,
        };
        const first = await postRuns(payload);
        return asToolResult(await withImpliedReview(args.runId, payload, first));
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

    if (name === "retry_verify") {
      return wrap(async () => {
        const runId = String(args.runId ?? "");
        const res = await fetch(
          `${SERVER_URL}/runs/${encodeURIComponent(runId)}/retry-verify`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
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

    if (name === "rename_project") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "").trim();
        const rootPath = String(args.rootPath ?? "").trim();
        const nextName = String(args.name ?? "").trim();
        if (!nextName) {
          return {
            content: [
              { type: "text", text: JSON.stringify({ error: "name is required" }) },
            ],
            isError: true,
          };
        }
        let id = projectId;
        if (!id && rootPath) {
          const list = await fetch(`${SERVER_URL}/projects`);
          if (list.ok) {
            const data = (await list.json()) as {
              projects?: Array<{ id: string; rootPath: string }>;
            };
            const normalized = rootPath.replace(/\/$/, "");
            id =
              data.projects?.find(
                (p) => p.rootPath.replace(/\/$/, "") === normalized,
              )?.id ?? "";
          }
        }
        if (!id) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "projectId or rootPath is required (project not found)",
                }),
              },
            ],
            isError: true,
          };
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: nextName }),
          },
        );
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

    if (name === "plan_loop_start") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const brief = String(args.brief ?? args.message ?? "").trim();
        if (!brief) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "brief is required",
                  hint: "Pass the operator's planning message as brief.",
                }),
              },
            ],
            isError: true,
          };
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              brief,
              askId: args.askId,
              scope: args.scope,
              investigateTool: args.investigateTool,
            }),
          },
        );
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [
              { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
            ],
            isError: !res.ok,
          };
        }
        const consumed = await consumeLiveTurnSse(sendLog, "plan_loop", res.body);
        if (!consumed.ok || !consumed.done) {
          return {
            content: [
              {
                type: "text",
                text: formatPlanLoopMcpEnvelope(
                  JSON.stringify({
                    error: consumed.errorText,
                    code: consumed.done?.code ?? consumed.done?.type,
                    notes: consumed.done?.notes ?? consumed.done?.reply,
                    loopId: consumed.done?.loopId,
                  }),
                  false,
                ),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatPlanLoopMcpEnvelope(
                JSON.stringify(consumed.done),
                true,
              ),
            },
          ],
          isError: false,
        };
      });
    }

    if (name === "plan_loop_continue") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const payload: Record<string, unknown> = { message: args.message };
        if (args.baseVersion !== undefined && args.baseVersion !== null) {
          payload.baseVersion = Number(args.baseVersion);
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/continue?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(payload),
          },
        );
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [
              { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
            ],
            isError: !res.ok,
          };
        }
        const consumed = await consumeLiveTurnSse(sendLog, "plan_loop", res.body);
        if (!consumed.ok || !consumed.done) {
          return {
            content: [
              {
                type: "text",
                text: formatPlanLoopMcpEnvelope(
                  JSON.stringify({
                    error: consumed.errorText,
                    code: consumed.done?.code ?? consumed.done?.type,
                    notes: consumed.done?.notes ?? consumed.done?.reply,
                    loopId: consumed.done?.loopId,
                  }),
                  false,
                ),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatPlanLoopMcpEnvelope(
                JSON.stringify(consumed.done),
                true,
              ),
            },
          ],
          isError: false,
        };
      });
    }

    if (name === "plan_loop_get") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const qs = new URLSearchParams();
        if (args.version !== undefined && args.version !== null) {
          qs.set("version", String(args.version));
        }
        if (args.includePlan === false) qs.set("includePlan", "false");
        const q = qs.toString() ? `?${qs}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}${q}`,
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "plan_loop_acceptance") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/acceptance`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              features: args.features,
              acceptedFeatureIds: args.acceptedFeatureIds,
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

    if (name === "plan_loop_accept") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/accept`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: args.version,
              features: args.features,
              acceptedFeatureIds: args.acceptedFeatureIds,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "plan_loop_promote") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/promote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              startResearch: args.startResearch,
              dependsOn: args.dependsOn,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "plan_loop_retry") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/retry`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatPlanLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "plan_loop_versions") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/versions`,
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "plan_loop_discard") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const version = Number(args.version);
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/versions/${encodeURIComponent(String(version))}/discard`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: args.reason }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "list_plan_loops") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops`,
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "design_loop_start") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              brief: args.brief,
              phaseId: args.phaseId,
              askId: args.askId,
              scope: args.scope,
            }),
          },
        );
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [
              { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
            ],
            isError: !res.ok,
          };
        }
        const consumed = await consumeLiveTurnSse(
          sendLog,
          "design_loop",
          res.body,
        );
        if (!consumed.ok || !consumed.done) {
          return {
            content: [
              {
                type: "text",
                text: formatDesignLoopMcpEnvelope(
                  JSON.stringify({
                    error: consumed.errorText,
                    code: consumed.done?.code ?? consumed.done?.type,
                    notes: consumed.done?.notes ?? consumed.done?.reply,
                    loopId: consumed.done?.loopId,
                  }),
                  false,
                ),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatDesignLoopMcpEnvelope(
                JSON.stringify(consumed.done),
                true,
              ),
            },
          ],
          isError: false,
        };
      });
    }

    if (name === "design_loop_continue") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const payload: Record<string, unknown> = { message: args.message };
        if (args.baseVersion !== undefined && args.baseVersion !== null) {
          payload.baseVersion = Number(args.baseVersion);
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/continue?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify(payload),
          },
        );
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [
              { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
            ],
            isError: !res.ok,
          };
        }
        const consumed = await consumeLiveTurnSse(
          sendLog,
          "design_loop",
          res.body,
        );
        if (!consumed.ok || !consumed.done) {
          return {
            content: [
              {
                type: "text",
                text: formatDesignLoopMcpEnvelope(
                  JSON.stringify({
                    error: consumed.errorText,
                    code: consumed.done?.code ?? consumed.done?.type,
                    notes: consumed.done?.notes ?? consumed.done?.reply,
                    loopId: consumed.done?.loopId,
                  }),
                  false,
                ),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: formatDesignLoopMcpEnvelope(
                JSON.stringify(consumed.done),
                true,
              ),
            },
          ],
          isError: false,
        };
      });
    }

    if (name === "design_loop_get") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const params = new URLSearchParams();
        if (args.version !== undefined && args.version !== null) {
          params.set("version", String(args.version));
        }
        if (args.includeHtml === false || args.includeHtml === "false") {
          params.set("includeHtml", "false");
        }
        const qs = params.toString() ? `?${params}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}${qs}`,
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_site_inventory") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const params = new URLSearchParams();
        if (args.refresh === true || args.refresh === "true") {
          params.set("refresh", "true");
        }
        const qs = params.toString() ? `?${params}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/site-inventory${qs}`,
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "npm_registry_status") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry`);
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "npm_registry_start") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "npm_registry_stop") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry/stop`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "npm_registry_ensure_rc") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry/ensure-rc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: args.projectId }),
        });
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "npm_registry_list") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry/packages`);
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "npm_registry_publish") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/npm-registry/publish`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            packageDir: args.packageDir,
            tag: args.tag,
          }),
        });
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "design_element_publish_npm") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const elementId = String(args.elementId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-elements/${encodeURIComponent(elementId)}/publish-npm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: args.version,
            }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "design_library_publish") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-library/publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              bump: args.bump,
              propagate: args.propagate !== false,
            }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_build_process_state") {      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/build-process`,
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_build_process_audit") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/build-process/audit`,
          { method: "POST", headers: { "Content-Type": "application/json" } },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_build_process_configure") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/build-process/configure`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runCommands: args.runCommands !== false,
            }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_library_consume") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-library/consume`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              packageName: args.packageName,
              ...(args.version ? { version: args.version } : {}),
            }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_set_coding_tool") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/coding-tool`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ toolId: args.toolId }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_set_ask_investigate_tool") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/ask-investigate-tool`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: args.tool }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_env_sync") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/env/sync`,
          { method: "POST" },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "project_runs_compact") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/runs/compact`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ dryRun: args.dryRun === true }),
          },
        );
        const body = await res.text();
        return { content: [{ type: "text", text: body }], isError: !res.ok };
      });
    }

    if (name === "list_design_elements") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const params = new URLSearchParams();
        if (args.includeRegistry === false || args.includeRegistry === "false") {
          params.set("includeRegistry", "false");
        }
        const qs = params.toString() ? `?${params}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-elements${qs}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_cross_project_deps") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const params = new URLSearchParams();
        if (typeof args.filterProjectId === "string" && args.filterProjectId) {
          params.set("projectId", args.filterProjectId);
        }
        const qs = params.toString() ? `?${params}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/cross-deps${qs}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "resolve_dependency") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/resolve-dependency`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              text: args.text,
              elementId: args.elementId,
              packageName: args.packageName,
              fromName: args.fromName,
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

    if (name === "design_element_get") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const elementId = String(args.elementId ?? "");
        const params = new URLSearchParams();
        if (typeof args.version === "number") {
          params.set("version", String(args.version));
        }
        if (typeof args.origin === "string" && args.origin) {
          params.set("origin", args.origin);
        }
        const qs = params.toString() ? `?${params}` : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-elements/${encodeURIComponent(elementId)}${qs}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_element_publish") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-elements/publish`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              elementId: args.elementId,
              spec: args.spec,
              mockHtml: args.mockHtml,
              label: args.label,
              kind: args.kind,
              tokensCss: args.tokensCss,
              srcFiles: args.srcFiles,
              mountHints: args.mountHints,
              publishToRegistry: args.publishToRegistry === true,
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

    if (name === "list_extractable_design_elements") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const q =
          typeof args.version === "number"
            ? `?version=${encodeURIComponent(String(args.version))}`
            : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/elements/extractable${q}`,
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_element_extract") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/elements/extract`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              elementId: args.elementId,
              version: args.version,
              label: args.label,
              kind: args.kind,
              publish: args.publish !== false,
              publishToRegistry: args.publishToRegistry === true,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_element_import") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/elements/import`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              elementId: args.elementId ?? "theme-toggle",
              version: args.version,
              origin: args.origin,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_import_design") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/import-design`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(typeof args.fromProjectId === "string" && args.fromProjectId
                ? { fromProjectId: args.fromProjectId }
                : {}),
              ...(typeof args.fromRootPath === "string" && args.fromRootPath
                ? { fromRootPath: args.fromRootPath }
                : {}),
              ...(typeof args.fromName === "string" && args.fromName
                ? { fromName: args.fromName }
                : {}),
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_retry") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/retry`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: args.version,
              message: args.message,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_acceptance") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/acceptance`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              features: args.features,
              acceptedFeatureIds: args.acceptedFeatureIds,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_accept") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/accept`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              version: args.version,
              features: args.features,
              acceptedFeatureIds: args.acceptedFeatureIds,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_concepts") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/concepts`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_pin") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        if (!args.conceptId && !args.asset) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  error: "conceptId and/or asset required",
                }),
              },
            ],
            isError: true,
          };
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/selections`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              slot: args.slot || "logo",
              conceptId: args.conceptId,
              asset: args.asset,
              label: args.label,
              excerpt: args.excerpt,
            }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_unpin") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const qs =
          typeof args.slot === "string" && args.slot.trim()
            ? `?slot=${encodeURIComponent(String(args.slot).trim())}`
            : "";
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/selections${qs}`,
          { method: "DELETE" },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_versions") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/versions`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "design_loop_discard") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const version = Number(args.version);
        if (!Number.isFinite(version) || version < 1) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "version (number) required" }),
              },
            ],
            isError: true,
          };
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/versions/${encodeURIComponent(String(version))}/discard`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ reason: args.reason }),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "implement_design") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const payload: Record<string, unknown> = {
          startResearch: args.startResearch,
          dependsOn: args.dependsOn,
        };
        if (args.phaseId) payload.phaseId = args.phaseId;
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/implement`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "relaunch_design_research") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId =
          typeof args.loopId === "string" ? args.loopId.trim() : "";
        const phaseId =
          typeof args.phaseId === "string" ? args.phaseId.trim() : "";
        const payload: Record<string, unknown> = {
          dependsOn: args.dependsOn,
        };
        if (loopId) payload.loopId = loopId;
        if (phaseId) payload.phaseId = phaseId;
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/relaunch-design-research`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        const body = await res.text();
        return {
          content: [
            { type: "text", text: formatDesignLoopMcpEnvelope(body, res.ok) },
          ],
          isError: !res.ok,
        };
      });
    }

    if (name === "list_design_loops") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "generate_design_image") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-images`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: args.prompt,
              loopId: args.loopId,
              filename: args.filename,
              width: args.width,
              height: args.height,
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

    if (name === "search_design_images") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-images/search`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: args.query,
              source: args.source,
              pageSize: args.pageSize,
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

    if (name === "import_design_image") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-images/import`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              loopId: args.loopId,
              openverseId: args.openverseId,
              filename: args.filename,
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

    if (name === "review_design_loop") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/review`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: args.version }),
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
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              message: args.message,
              askId: args.askId,
              title: args.title,
              newAsk: args.newAsk === true || args.newAsk === "true",
              ...(args.investigateTool
                ? { investigateTool: args.investigateTool }
                : {}),
            }),
          },
        );

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [
              { type: "text", text: formatAskMcpEnvelope(body, res.ok) },
            ],
            isError: !res.ok,
          };
        }

        const progressToken = opts?.progressToken;
        let progressN = 0;

        const consumed = await consumeAskSseStream(res.body, async (event) => {
          const line = askProgressLogLine(event);
          if (line) {
            try {
              await sendLog?.("ask", line);
            } catch {
              /* client may not support logging */
            }
            if (progressToken !== undefined) {
              progressN += 1;
              try {
                await sendProgress?.(progressToken, progressN, line);
              } catch {
                /* optional */
              }
            }
          }
        });

        if (!consumed.ok || !consumed.done) {
          const errPayload = {
            error: consumed.errorText ?? "ask stream failed",
            code:
              typeof consumed.done?.code === "string"
                ? consumed.done.code
                : undefined,
            reply:
              typeof consumed.done?.reply === "string"
                ? consumed.done.reply
                : undefined,
            askId:
              typeof consumed.done?.askId === "string"
                ? consumed.done.askId
                : undefined,
            ask: consumed.done?.ask,
            hint:
              typeof consumed.done?.hint === "string"
                ? consumed.done.hint
                : undefined,
          };
          return {
            content: [
              {
                type: "text",
                text: formatAskMcpEnvelope(
                  JSON.stringify(errPayload),
                  false,
                ),
              },
            ],
            isError: true,
          };
        }

        const done = consumed.done;
        const okPayload = {
          ask: done.ask,
          askId: done.askId,
          reply: done.reply,
        };
        return {
          content: [
            {
              type: "text",
              text: formatAskMcpEnvelope(JSON.stringify(okPayload), true),
            },
          ],
          isError: false,
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

    if (name === "fork_ask") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const askId = String(args.askId ?? "");
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks/${encodeURIComponent(askId)}/fork`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: args.title }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: formatAskMcpEnvelope(body, res.ok) }],
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

    if (name === "stop_session") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const kind = String(args.kind ?? "");
        const id = String(args.id ?? "");
        const pathByKind: Record<string, string> = {
          ask: `/projects/${encodeURIComponent(projectId)}/asks/${encodeURIComponent(id)}/stop`,
          agent: `/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(id)}/stop`,
          design_loop: `/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(id)}/stop`,
          plan_loop: `/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(id)}/stop`,
        };
        const path = pathByKind[kind];
        if (!path) {
          return {
            content: [
              {
                type: "text",
                text: `error: kind must be ask|agent|design_loop|plan_loop`,
              },
            ],
            isError: true,
          };
        }
        const res = await fetch(`${SERVER_URL}${path}`, { method: "POST" });
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
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/agents?stream=1`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({
              message: args.message,
              agentId: args.agentId,
              title: args.title,
            }),
          },
        );

        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [{ type: "text", text: body }],
            isError: !res.ok,
          };
        }

        const progressToken = opts?.progressToken;
        let progressN = 0;

        const consumed = await consumeAskSseStream(res.body, async (event) => {
          const line = askProgressLogLine(event);
          if (line) {
            try {
              await sendLog?.("agent", line);
            } catch {
              /* ignore */
            }
            if (progressToken !== undefined) {
              progressN += 1;
              try {
                await sendProgress?.(progressToken, progressN, line);
              } catch {
                /* ignore */
              }
            }
          }
        });

        if (!consumed.ok || !consumed.done) {
          const errPayload = {
            error: consumed.errorText ?? "agent stream failed",
            code:
              typeof consumed.done?.code === "string"
                ? consumed.done.code
                : String(consumed.done?.type ?? "") === "interrupted"
                  ? "interrupted"
                  : undefined,
            reply:
              typeof consumed.done?.reply === "string"
                ? consumed.done.reply
                : undefined,
            agent: consumed.done?.agent,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(errPayload) }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: formatAgentMcpEnvelope({
                agent: consumed.done.agent,
                reply:
                  typeof consumed.done.reply === "string"
                    ? consumed.done.reply
                    : "",
              }),
            },
          ],
          isError: false,
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

    if (
      name === "preview_change_intent" ||
      name === "reconcile_blueprint" ||
      name === "audit_ui_gates"
    ) {
      return wrap(async () => {
        const payload: Record<string, unknown> = {
          action: name,
          projectId: args.projectId,
        };
        if (typeof args.description === "string") {
          payload.description = args.description;
        }
        if (typeof args.phaseId === "string") {
          payload.phaseId = args.phaseId;
        }
        if (name === "preview_change_intent") {
          payload.checkPhaseDoc = Boolean(args.checkPhaseDoc);
        }
        if (name === "reconcile_blueprint") {
          payload.dryRun =
            args.dryRun === undefined ? true : Boolean(args.dryRun);
        }
        const res = await fetch(`${SERVER_URL}/runs`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_start") {
      return wrap(async () => {
        const projectId = args.projectId as string | undefined;
        const endpointId = args.endpointId as string | undefined;
        const modelId = args.modelId as string | undefined;
        const url = projectId
          ? `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/chats`
          : `${SERVER_URL}/chats`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: args.title,
            modelOverride:
              endpointId && modelId ? { endpointId, modelId } : undefined,
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_list") {
      return wrap(async () => {
        const projectId = args.projectId as string | undefined;
        const status = args.status as string | undefined;
        const qs = status ? `?status=${encodeURIComponent(status)}` : "";
        let url: string;
        if (projectId) {
          url = `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/chats${qs}`;
        } else if (args.global === true) {
          url = `${SERVER_URL}/chats${qs}`;
        } else {
          url = `${SERVER_URL}/chats?all=1${status ? `&status=${encodeURIComponent(status)}` : ""}`;
        }
        const res = await fetch(url);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_get") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/chats/${encodeURIComponent(args.conversationId as string)}`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_send") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/chats/${encodeURIComponent(args.conversationId as string)}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "text/event-stream",
            },
            body: JSON.stringify({ message: args.message }),
          },
        );
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          const body = await res.text();
          return {
            content: [{ type: "text", text: body }],
            isError: !res.ok,
          };
        }

        // Consume the chat SSE stream: accumulate reply text, log progress,
        // and surface confirm_request tokens so the operator can approve.
        let reply = "";
        let lastError: string | undefined;
        const transcript: string[] = [];
        const confirmations: Record<string, unknown>[] = [];
        const body = res.body;
        if (body) {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split("\n\n");
            buffer = frames.pop() ?? "";
            for (const frame of frames) {
              const dataLine = frame
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (!dataLine) continue;
              try {
                const event = JSON.parse(dataLine.slice(6)) as {
                  type?: string;
                  text?: string;
                  tool?: string;
                  summary?: string;
                  token?: string;
                  error?: string;
                };
                if (event.type === "delta" && event.text) {
                  reply += event.text;
                } else if (event.type === "tool_call") {
                  transcript.push(`→ ${event.tool}: ${event.summary ?? ""}`);
                  await sendLog?.("chat", `tool ${event.tool}: ${event.summary ?? ""}`);
                } else if (event.type === "confirm_request") {
                  transcript.push(
                    `⚠ confirmation required: ${event.tool} (token ${event.token})`,
                  );
                  confirmations.push({
                    token: event.token,
                    tool: event.tool,
                  });
                } else if (event.type === "done" && event.text) {
                  reply = event.text;
                } else if (event.type === "error") {
                  lastError = event.error ?? "unknown";
                  transcript.push(`error: ${lastError}`);
                }
              } catch {
                /* ignore malformed frames */
              }
            }
          }
        }

        if (!reply.trim() && lastError) {
          reply = `The chat turn failed before a reply was generated: ${lastError}`;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  reply,
                  transcript,
                  pendingConfirmations: confirmations,
                  hint:
                    confirmations.length > 0
                      ? "Approve or deny with chat_confirm (conversationId + token + approve)."
                      : undefined,
                },
                null,
                2,
              ),
            },
          ],
        };
      });
    }

    if (name === "chat_confirm") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/chats/${encodeURIComponent(args.conversationId as string)}/confirm`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: args.token, approve: args.approve }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_close" || name === "chat_reopen" || name === "chat_delete") {
      return wrap(async () => {
        const id = encodeURIComponent(args.conversationId as string);
        const res =
          name === "chat_close"
            ? await fetch(`${SERVER_URL}/chats/${id}/close`, { method: "POST" })
            : name === "chat_reopen"
              ? await fetch(`${SERVER_URL}/chats/${id}/reopen`, { method: "POST" })
              : await fetch(`${SERVER_URL}/chats/${id}`, { method: "DELETE" });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_get_awaited_run") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/chats/${encodeURIComponent(args.conversationId as string)}/awaited-runs`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_list_awaited_runs") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/chats/awaited-runs`);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_get_run_status") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/runs/${encodeURIComponent(args.runId as string)}/status`,
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_models_list") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/chats/function-mappings`);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "chat_model_set") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/chats/${encodeURIComponent(args.conversationId as string)}/model`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              endpointId: args.endpointId,
              modelId: args.modelId,
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

    if (name === "chat_function_bind") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/chats/function-mappings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            function: args.function,
            modelId: args.modelId,
            ...(typeof args.provider === "string"
              ? { provider: args.provider }
              : {}),
            ...(typeof args.endpointId === "string"
              ? { endpointId: args.endpointId }
              : {}),
          }),
        });
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "provider_list") {
      return wrap(async () => {
        const res = await fetch(`${SERVER_URL}/config/providers`);
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "provider_set") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/config/providers/${encodeURIComponent(args.name as string)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              apiKey: args.apiKey,
              defaultBaseUrl: args.defaultBaseUrl,
              headers: args.headers,
              timeoutMs: args.timeoutMs,
              defaultParams: args.defaultParams,
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

    if (name === "provider_remove") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/config/providers/${encodeURIComponent(args.name as string)}`,
          { method: "DELETE" },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: body }],
          isError: !res.ok,
        };
      });
    }

    if (name === "provider_test") {
      return wrap(async () => {
        const res = await fetch(
          `${SERVER_URL}/config/providers/${encodeURIComponent(args.name as string)}/test`,
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
}

export function createSlopcontrolMcpServer(
  opts?: CreateSlopcontrolMcpServerOptions,
): Server {
  const server = new Server(
    {
      name: "slopcontrol",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
        logging: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: SLOPCONTROL_MCP_TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const progressToken = (
      request.params as { _meta?: { progressToken?: string | number } }
    )._meta?.progressToken;
    return dispatchSlopcontrolTool(
      request.params.name,
      (request.params.arguments ?? {}) as Record<string, unknown>,
      {
        serverUrl: opts?.serverUrl,
        progressToken,
        sendLog: async (logger, line) => {
          try {
            await server.sendLoggingMessage({
              level: "info",
              logger,
              data: line,
            });
          } catch {
            /* client may not support logging */
          }
        },
        sendProgress: async (token, progress, message) => {
          try {
            await server.notification({
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress,
                total: undefined,
                message,
              },
            });
          } catch {
            /* optional */
          }
        },
      },
    );
  });

  return server;
}
