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
      hint?: string;
      promotedPhaseId?: string;
      forkedFrom?: string;
    };
    const askId = parsed.askId || parsed.ask?.id || "";
    if (!ok) {
      return [
        askId ? `askId: ${askId}` : null,
        parsed.error ? `error: ${parsed.error}` : `error: ${body.slice(0, 500)}`,
        parsed.hint ? `hint: ${parsed.hint}` : null,
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
      name: "design_loop_start",
      description:
        "Start a chat-driven look-and-feel loop: generates self-contained mock HTML (no product edits). Returns loopId + html + transcript + conceptualModel (scope/theme). Optional scope narrows the conceptual model (e.g. component+chat.composer). If usedScaffold/timeout, call design_loop_retry. Iterate with design_loop_continue, freeze with design_loop_accept, then implement_design.",
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
        "Import theme/logos from another project into this loop (design share). Resolves fromProjectId/fromRootPath/fromName (brand aliases like 'jamroast' map to project folders). Copies logos into the loop and ranks the SHARED DESIGN block above LIVE SITE for palette/logos on continue.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          fromProjectId: { type: "string", description: "Registered source project id" },
          fromRootPath: { type: "string", description: "Absolute path to source project" },
          fromName: { type: "string", description: "Source project name or brand alias (e.g. 'jamroast')" },
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
        "Bind an accepted design-loop mock + ACCEPTANCE checklist to a phase: writes UI-SPEC, tokens.css, design/mock.html, design/ACCEPTANCE.json, DESIGN_COMPLETE. Creates a new phase and starts research when phaseId is omitted or the linked phase is complete. Product code still only changes in start_development.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          loopId: { type: "string" },
          phaseId: {
            type: "string",
            description:
              "Existing incomplete phase to bind. Omit (recommended) so a complete linked phase triggers a new phase + research.",
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
        "Freeze a plan-loop version + checklist as PLAN_PACK.json (requires ≥1 ticked feature and complete PLAN sections). Then call plan_loop_promote.",
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
        "Bind accepted PLAN.md + PLAN_PACK to a new phase and start research (default). Research receives the plan contract as authoritative operator intent. Product code still only changes in start_development.",
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
        "Project-scoped AI conversation (exploratory, read-only). Does not create a phase. Omitting askId continues the project's latest open ask (sticky resume). Pass askId to target a specific session. Pass newAsk=true to force a fresh conversation. Always reuse askId from the previous ask response. For several investigations use ask_sub_research. When the change is clear, call promote_ask. After promote, use fork_ask to keep chatting. For shell inspect/verify without develop, use agent. For look-and-feel mocks use design_loop_start.",
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
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              brief: args.brief,
              askId: args.askId,
              scope: args.scope,
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

    if (name === "plan_loop_continue") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const payload: Record<string, unknown> = { message: args.message };
        if (args.baseVersion !== undefined && args.baseVersion !== null) {
          payload.baseVersion = Number(args.baseVersion);
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/plan-loops/${encodeURIComponent(loopId)}/continue`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
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
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              brief: args.brief,
              phaseId: args.phaseId,
              askId: args.askId,
              scope: args.scope,
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

    if (name === "design_loop_continue") {
      return wrap(async () => {
        const projectId = String(args.projectId ?? "");
        const loopId = String(args.loopId ?? "");
        const payload: Record<string, unknown> = { message: args.message };
        if (args.baseVersion !== undefined && args.baseVersion !== null) {
          payload.baseVersion = Number(args.baseVersion);
        }
        const res = await fetch(
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/design-loops/${encodeURIComponent(loopId)}/continue`,
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
          `${SERVER_URL}/projects/${encodeURIComponent(projectId)}/asks`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: args.message,
              askId: args.askId,
              title: args.title,
              newAsk: args.newAsk === true || args.newAsk === "true",
            }),
          },
        );
        const body = await res.text();
        return {
          content: [{ type: "text", text: formatAskMcpEnvelope(body, res.ok) }],
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

    log.warn("mcp", `unknown tool ${name}`);
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}
