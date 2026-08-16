"use client";

import { useEffect, useState } from "react";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SLOPCONTROL_SERVER_URL ?? "http://localhost:3020";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(body || res.statusText);
  }

  return res.json() as Promise<T>;
}

type Project = { id: string; name: string; rootPath: string; blueprintVersion?: number };
type Run = { id: string; stage: string; phaseId: string; projectId: string };
type Phase = {
  id: string;
  description: string;
  status: string;
  worktreePath?: string;
  dependsOn?: string[];
};
type WorktreeInfo = {
  phaseId: string;
  path: string;
  branch: string;
  exists: boolean;
  dirty: boolean;
  headCommit: string | null;
};
type GitStatus = {
  currentBranch: string;
  dirty: boolean;
  branches: string[];
  phaseBranches: string[];
  headCommit: string | null;
};
type RunListItem = {
  id: string;
  stage: string;
  phase_id: string | null;
  idea: string;
  updated_at: string;
  total_duration?: string;
  total_duration_ms?: number | null;
  failure_summary?: string | null;
  stage_timings?: Array<{
    stage: string;
    duration: string;
    duration_ms: number | null;
  }>;
};

type RunDiagnosis = {
  audience?: string;
  class?: string;
  title?: string;
  rootCause?: string;
  evidence?: string;
  nextActions?: string;
  operatorActions?: string[];
  codingAgentShouldFix?: boolean;
  fingerprint?: string;
  failingStep?: {
    name?: string;
    command?: string;
    exitCode?: number;
    stepId?: string;
  };
};

type VerifyStep = {
  id: string;
  name: string;
  command?: string;
  exitCode: number;
  ok: boolean;
  outputExcerpt?: string;
};

type FunctionCurrentBinding = {
  modelId: string;
  endpointId: string;
  provider?: string;
  explicit: boolean;
  fallbackFrom?: string;
};

type FunctionMapping = {
  function: string;
  description: string;
  current: FunctionCurrentBinding | null;
};

type AvailableModel = {
  modelId: string;
  label: string;
  provider: string;
  providerName: string;
  endpointId: string;
  baseUrl: string;
  mapped: boolean;
};

type ProviderCatalog = {
  providerName: string;
  endpointId: string;
  label: string;
  provider: string;
  baseUrl: string;
  apiType: string;
  models: string[];
  source: "live" | "configured";
  error?: string;
  mappedModelIds: string[];
};

type FunctionMappingList = {
  functions: FunctionMapping[];
  models: AvailableModel[];
  providers: ProviderCatalog[];
};

type ChatConversation = {
  id: string;
  projectId: string | null;
  title?: string;
  status: "active" | "closed";
  modelOverride?: { endpointId: string; modelId: string };
  awaitedRun?: {
    runId: string;
    projectId: string;
    kind: string;
    startedAt: string;
  } | null;
  createdAt: string;
  lastActiveAt: string;
  closedAt?: string;
  messageCount?: number;
};

export function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [dependsOnInput, setDependsOnInput] = useState("");
  const [intent, setIntent] = useState("");
  const [phases, setPhases] = useState<Phase[]>([]);
  const [feedback, setFeedback] = useState("");
  const [currentRun, setCurrentRun] = useState<Run | null>(null);
  const [currentPhase, setCurrentPhase] = useState<Phase | null>(null);
  const [phaseDoc, setPhaseDoc] = useState("");
  const [projectRuns, setProjectRuns] = useState<RunListItem[]>([]);
  const [blueprintStatus, setBlueprintStatus] = useState<string | null>(null);
  const [log, setLog] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(false);
  const [diagnosis, setDiagnosis] = useState<RunDiagnosis | null>(null);
  const [verifySteps, setVerifySteps] = useState<VerifyStep[]>([]);
  const [verifyFirstFailureId, setVerifyFirstFailureId] = useState<
    string | null
  >(null);
  const [failureSummary, setFailureSummary] = useState<string | null>(null);
  const [stageTimings, setStageTimings] = useState<
    Array<{ stage: string; duration: string }>
  >([]);
  const [totalDuration, setTotalDuration] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [checkoutBranch, setCheckoutBranch] = useState("");

  // Models & providers (provider-aware MCP surface)
  const [functionMappings, setFunctionMappings] = useState<FunctionMappingList | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [bindFunction, setBindFunction] = useState("");
  const [bindModelId, setBindModelId] = useState("");
  const [bindProvider, setBindProvider] = useState("");
  const [bindResult, setBindResult] = useState<string | null>(null);

  // Chats
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [chatsError, setChatsError] = useState<string | null>(null);
  const [chatTitle, setChatTitle] = useState("");
  const [chatStatusFilter, setChatStatusFilter] = useState<"active" | "closed" | "">("");

  const stages = [
    "idle",
    "researching",
    "drafting",
    "in_review",
    "accepted",
    "designing",
    "design_complete",
    "developing",
    "complete",
    "blocked",
    "failed",
    "interrupted",
  ];

  async function refreshProjects() {
    const data = await api<{ projects: Project[] }>("/projects");
    setProjects(data.projects);
  }

  async function refreshProjectRuns(projectId: string) {
    if (!projectId) {
      setProjectRuns([]);
      setPhases([]);
      setGitStatus(null);
      setWorktrees([]);
      return;
    }
    const [runsData, phasesData, gitData, wtData] = await Promise.all([
      api<{ runs: RunListItem[] }>(`/projects/${projectId}/runs`),
      api<{ phases: Phase[] }>(`/projects/${projectId}/phases`),
      api<GitStatus & { projectId: string }>(`/projects/${projectId}/git`).catch(
        () => null,
      ),
      api<{ worktrees: WorktreeInfo[] }>(
        `/projects/${projectId}/worktrees`,
      ).catch(() => ({ worktrees: [] as WorktreeInfo[] })),
    ]);
    setProjectRuns(runsData.runs);
    setPhases(phasesData.phases);
    setGitStatus(gitData);
    setWorktrees(wtData.worktrees);
    if (gitData?.currentBranch) {
      setCheckoutBranch(gitData.currentBranch);
    }
  }

  async function refreshFunctionMappings() {
    try {
      const data = await api<FunctionMappingList>("/chats/function-mappings");
      setFunctionMappings(data);
      setModelsError(null);
    } catch (err) {
      setModelsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function refreshConversations() {
    try {
      const qs = chatStatusFilter ? `?status=${chatStatusFilter}` : "";
      const data = await api<{ conversations: ChatConversation[] }>(
        `/chats${qs}`,
      );
      setConversations(data.conversations);
      setChatsError(null);
    } catch (err) {
      setChatsError(err instanceof Error ? err.message : String(err));
    }
  }

  async function doBindFunction() {
    if (!bindFunction || !bindModelId) return;
    setBusy(true);
    setError(null);
    setBindResult(null);
    try {
      const data = await api<{
        ok: boolean;
        function: string;
        modelId: string;
        endpointId: string;
        provider?: string;
        createdEndpoint: boolean;
      }>("/chats/function-mappings", {
        method: "POST",
        body: JSON.stringify({
          function: bindFunction,
          modelId: bindModelId,
          ...(bindProvider ? { provider: bindProvider } : {}),
        }),
      });
      setBindResult(
        `${data.function} → ${data.modelId} (${data.provider ?? data.endpointId}${
          data.createdEndpoint ? ", new endpoint" : ""
        })`,
      );
      await refreshFunctionMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCreateChat() {
    setBusy(true);
    setError(null);
    try {
      await api<{ conversation: ChatConversation }>("/chats", {
        method: "POST",
        body: JSON.stringify({ title: chatTitle || undefined }),
      });
      setChatTitle("");
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCloseChat(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api(`/chats/${id}/close`, { method: "POST" });
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doDeleteChat(id: string) {
    if (!window.confirm("Delete this conversation?")) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/chats/${id}`, { method: "DELETE" });
      await refreshConversations();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshProjects().catch((err: Error) => setError(err.message));
    void refreshFunctionMappings();
    void refreshConversations();
  }, []);

  useEffect(() => {
    void refreshProjectRuns(selectedProjectId).catch(() => undefined);
    setCurrentRun(null);
    setCurrentPhase(null);
    setPhaseDoc("");
    setLog("");
    setDiagnosis(null);
    setVerifySteps([]);
    setVerifyFirstFailureId(null);
    setFailureSummary(null);
    setBlueprintStatus(null);
  }, [selectedProjectId]);

  async function loadRunDetails(runId: string) {
    try {
      const data = await api<{
        stage?: string;
        diagnosis?: RunDiagnosis | null;
        failure_summary?: string | null;
        operator_suggestions?: { actions?: string[] } | null;
        stage_timings?: Array<{ stage: string; duration: string }>;
        total_duration?: string;
        verify_steps?: VerifyStep[] | null;
        verify_first_failure?: { id?: string } | null;
      }>(`/runs/${runId}`);
      if (data.stage) {
        setCurrentRun((prev) =>
          prev ? { ...prev, stage: data.stage as string } : prev,
        );
      }
      setDiagnosis(data.diagnosis ?? null);
      setVerifySteps(data.verify_steps ?? []);
      setVerifyFirstFailureId(data.verify_first_failure?.id ?? null);
      setFailureSummary(data.failure_summary ?? null);
      if (data.total_duration) setTotalDuration(data.total_duration);
      if (data.stage_timings) {
        setStageTimings(
          data.stage_timings.map((t) => ({
            stage: t.stage,
            duration: t.duration,
          })),
        );
      }
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    if (!currentRun) return;

    const source = new EventSource(`${SERVER_URL}/runs/${currentRun.id}/stream`);
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          line?: string;
          stage?: string;
          active?: boolean;
          total_duration?: string;
          stage_timings?: Array<{ stage: string; duration: string }>;
        };
        if (payload.line) {
          setLog((prev) => `${prev}${payload.line}\n`);
        }
        if (payload.stage) {
          setCurrentRun((prev) =>
            prev ? { ...prev, stage: payload.stage as string } : prev,
          );
        }
        if (typeof payload.active === "boolean") {
          setActive(payload.active);
        }
        if (payload.total_duration) {
          setTotalDuration(payload.total_duration);
        }
        if (payload.stage_timings) {
          setStageTimings(
            payload.stage_timings.map((t) => ({
              stage: t.stage,
              duration: t.duration,
            })),
          );
        }
      } catch {
        setLog((prev) => `${prev}${event.data}\n`);
      }
    };

    return () => source.close();
  }, [currentRun?.id]);

  useEffect(() => {
    if (!currentRun) return;
    const terminal = [
      "complete",
      "blocked",
      "failed",
      "interrupted",
      "accepted",
      "design_complete",
      "in_review",
    ];
    if (!terminal.includes(currentRun.stage) || active) return;

    if (
      (currentRun.stage === "in_review" ||
        currentRun.stage === "accepted" ||
        currentRun.stage === "design_complete") &&
      currentPhase
    ) {
      void api<{ phase: Phase; phaseDoc: string }>(
        `/projects/${currentRun.projectId}/phases/${currentPhase.id}/doc`,
      )
        .then((data) => {
          setCurrentPhase(data.phase);
          setPhaseDoc(data.phaseDoc);
        })
        .catch(() => undefined);
    }

    if (currentRun.stage === "failed" || currentRun.stage === "blocked") {
      void loadRunDetails(currentRun.id);
    }

    void refreshProjectRuns(currentRun.projectId).catch(() => undefined);
  }, [currentRun?.stage, currentRun?.id, active, currentPhase?.id]);

  async function openProject(forceRefresh = false) {
    if (!rootPath && !selectedProjectId) return;
    setBusy(true);
    setError(null);
    try {
      const path =
        rootPath ||
        projects.find((p) => p.id === selectedProjectId)?.rootPath ||
        "";
      const data = await api<{
        project: Project;
        blueprintStatus: string;
        mode?: string;
        archivePath?: string | null;
        message?: string;
        suggestedNextChange?: string;
        duration?: string;
      }>("/projects/open", {
        method: "POST",
        body: JSON.stringify({
          rootPath: path,
          name: projectName || undefined,
          intent: intent || undefined,
          forceRefresh,
        }),
      });
      await refreshProjects();
      setSelectedProjectId(data.project.id);
      if (data.blueprintStatus === "needs_intent") {
        setBlueprintStatus(
          `needs_intent — ${data.message ?? "Enter what you want to build (intent), then Open again."}`,
        );
      } else {
        setBlueprintStatus(
          `${data.mode ?? "existing"} / ${data.blueprintStatus}${
            data.duration ? ` in ${data.duration}` : ""
          }${data.archivePath ? ` (archived ${data.archivePath})` : ""}${
            data.suggestedNextChange ? ` · next: ${data.suggestedNextChange}` : ""
          }`,
        );
        setProjectName("");
        setRootPath("");
        if (data.suggestedNextChange) {
          setDescription(data.suggestedNextChange);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function reinitProject() {
    if (!rootPath && !selectedProjectId) return;
    const confirmed = window.confirm(
      "Reinit will archive BLUEPRINT/ROADMAP/phases/runs and reverse-engineer a new BLUEPRINT from source (phase zero). Continue?",
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      const path =
        rootPath ||
        projects.find((p) => p.id === selectedProjectId)?.rootPath ||
        "";
      const data = await api<{
        project: Project;
        blueprintStatus: string;
        message?: string;
        suggestedNextChange?: string;
        duration?: string;
        archivePath?: string | null;
        cleared?: { phasesRemoved: number; runsRemoved: number };
      }>("/projects/reinit", {
        method: "POST",
        body: JSON.stringify({
          projectId: selectedProjectId || undefined,
          rootPath: path || undefined,
          notes: intent || undefined,
        }),
      });
      await refreshProjects();
      await refreshProjectRuns(data.project.id);
      setSelectedProjectId(data.project.id);
      setCurrentRun(null);
      setCurrentPhase(null);
      setPhases([]);
      setPhaseDoc("");
      setActive(false);
      setLog("");
      setStageTimings([]);
      setTotalDuration(null);
      setBlueprintStatus(
        `reinit / ${data.blueprintStatus}${
          data.duration ? ` in ${data.duration}` : ""
        }${data.archivePath ? ` (archived ${data.archivePath})` : ""}${
          data.cleared
            ? ` · cleared ${data.cleared.phasesRemoved} phases, ${data.cleared.runsRemoved} runs`
            : ""
        }${data.suggestedNextChange ? ` · next: ${data.suggestedNextChange}` : ""}`,
      );
      if (data.suggestedNextChange) {
        setDescription(data.suggestedNextChange);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startResearch() {
    if (!selectedProjectId || !description) return;
    setBusy(true);
    setError(null);
    setLog("");
    setPhaseDoc("");
    try {
      const dependsOn = dependsOnInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const data = await api<{ run: Run; phase: Phase; stage: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          action: "start_research",
          projectId: selectedProjectId,
          description,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
        }),
      });
      setCurrentRun(data.run);
      setCurrentPhase(data.phase);
      setActive(true);
      await refreshProjectRuns(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitReview(decision: "approve" | "request_changes") {
    if (!currentRun) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ run: Run; stage: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          action: "submit_review",
          runId: currentRun.id,
          decision,
          feedback,
        }),
      });
      setCurrentRun(data.run);
      if (decision === "request_changes") setActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startDevelopment() {
    if (!currentRun) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ run: Run; stage: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          action: "start_development",
          runId: currentRun.id,
        }),
      });
      setCurrentRun(data.run);
      setActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startDesign() {
    if (!currentRun) return;
    setBusy(true);
    setError(null);
    try {
      const data = await api<{ run: Run; stage: string }>("/runs", {
        method: "POST",
        body: JSON.stringify({
          action: "start_design",
          runId: currentRun.id,
        }),
      });
      setCurrentRun(data.run);
      setActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doCheckoutBranch() {
    if (!selectedProjectId || !checkoutBranch.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${selectedProjectId}/git/checkout`, {
        method: "POST",
        body: JSON.stringify({ branch: checkoutBranch.trim() }),
      });
      await refreshProjectRuns(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doMergePhase(phaseId: string) {
    if (!selectedProjectId) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/projects/${selectedProjectId}/phases/${phaseId}/merge`, {
        method: "POST",
        body: JSON.stringify({
          targetBranch: gitStatus?.currentBranch || undefined,
          removeWorktree: true,
        }),
      });
      await refreshProjectRuns(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doRemoveWorktree(phaseId: string, deleteBranch: boolean) {
    if (!selectedProjectId) return;
    setBusy(true);
    setError(null);
    try {
      const qs = deleteBranch ? "?deleteBranch=true" : "";
      await api(
        `/projects/${selectedProjectId}/worktrees/${encodeURIComponent(phaseId)}${qs}`,
        { method: "DELETE" },
      );
      await refreshProjectRuns(selectedProjectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canReview =
    currentRun?.stage === "in_review" && !active && !busy;
  const canDevelop =
    (currentRun?.stage === "accepted" ||
      currentRun?.stage === "design_complete") &&
    !active &&
    !busy;
  const canDesign =
    (currentRun?.stage === "accepted" ||
      currentRun?.stage === "design_complete") &&
    !active &&
    !busy;

  return (
    <>
      <section className="card">
        <h2>Open Project</h2>
        <p>
          First access reverse-engineers a living BLUEPRINT.md (archives stale
          copies). Prefer Open over Register-only.
        </p>
        <div className="row">
          <input
            placeholder="Project name (optional)"
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
          />
          <input
            placeholder="/absolute/path/to/project"
            value={rootPath}
            onChange={(e) => setRootPath(e.target.value)}
          />
        </div>
        <textarea
          rows={3}
          placeholder="Intent for empty/new projects: what are we building? (required when the folder is empty)"
          value={intent}
          onChange={(e) => setIntent(e.target.value)}
        />
        <div className="row">
          <button
            disabled={busy || (!rootPath && !selectedProjectId)}
            onClick={() => openProject(false)}
          >
            Open Project
          </button>
          <button
            className="secondary"
            disabled={busy || (!rootPath && !selectedProjectId)}
            onClick={() => openProject(true)}
          >
            Force Refresh Blueprint
          </button>
          <button
            className="secondary"
            disabled={busy || (!rootPath && !selectedProjectId)}
            onClick={() => void reinitProject()}
          >
            Reinit (phase zero)
          </button>
        </div>
        {blueprintStatus && <p>Blueprint: {blueprintStatus}</p>}
      </section>

      <section className="card">
        <h2>Project</h2>
        <select
          value={selectedProjectId}
          onChange={(e) => setSelectedProjectId(e.target.value)}
        >
          <option value="">Select project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name} — {project.rootPath}
            </option>
          ))}
        </select>
        {selectedProjectId && (
          <>
            <h3>Runs (this project only)</h3>
            {projectRuns.length === 0 ? (
              <p>No runs yet.</p>
            ) : (
              <ul>
                {projectRuns.map((run) => (
                  <li key={run.id}>
                    <button
                      className="secondary"
                      type="button"
                      onClick={() => {
                        setCurrentRun({
                          id: run.id,
                          stage: run.stage,
                          phaseId: run.phase_id ?? "",
                          projectId: selectedProjectId,
                        });
                        setCurrentPhase(
                          run.phase_id
                            ? {
                                id: run.phase_id,
                                description: run.idea,
                                status: run.stage,
                              }
                            : null,
                        );
                        setLog("");
                        setDiagnosis(null);
                        setFailureSummary(run.failure_summary ?? null);
                        void loadRunDetails(run.id);
                      }}
                    >
                      {run.phase_id ?? run.id.slice(0, 8)} — {run.stage}
                      {run.total_duration && run.total_duration !== "—"
                        ? ` (${run.total_duration})`
                        : ""}
                      {run.failure_summary
                        ? ` — ${run.failure_summary.slice(0, 80)}`
                        : ""}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {selectedProjectId && (
        <section className="card">
          <h2>Git & Worktrees</h2>
          <p>
            Development auto-merges into the project folder on success and
            removes the phase worktree. Use this panel to switch the checked-out
            branch or clean up leftovers.
          </p>
          {gitStatus ? (
            <p>
              Project folder on <code>{gitStatus.currentBranch}</code>
              {gitStatus.headCommit
                ? ` @ ${gitStatus.headCommit.slice(0, 8)}`
                : ""}
              {gitStatus.dirty ? " (dirty)" : ""}
            </p>
          ) : (
            <p>Git status unavailable (is the project a git repo?).</p>
          )}
          <div className="row">
            <select
              value={checkoutBranch}
              onChange={(e) => setCheckoutBranch(e.target.value)}
              disabled={!gitStatus || busy}
            >
              {(gitStatus?.branches ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <button
              className="secondary"
              disabled={
                busy ||
                !gitStatus ||
                !checkoutBranch ||
                checkoutBranch === gitStatus.currentBranch
              }
              onClick={() => void doCheckoutBranch()}
            >
              Checkout branch
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void refreshProjectRuns(selectedProjectId).catch((err: Error) =>
                  setError(err.message),
                )
              }
            >
              Refresh
            </button>
          </div>
          <h3>Phase worktrees</h3>
          {worktrees.filter((w) => w.exists).length === 0 ? (
            <p>No active worktrees.</p>
          ) : (
            <ul>
              {worktrees
                .filter((w) => w.exists)
                .map((wt) => (
                  <li key={wt.phaseId} style={{ marginBottom: "0.75rem" }}>
                    <code>{wt.phaseId}</code> — {wt.branch}
                    {wt.dirty ? " (dirty)" : ""}
                    <br />
                    <small>{wt.path}</small>
                    <div className="row" style={{ marginTop: "0.35rem" }}>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void doMergePhase(wt.phaseId)}
                      >
                        Merge into project
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void doRemoveWorktree(wt.phaseId, false)}
                      >
                        Delete worktree
                      </button>
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void doRemoveWorktree(wt.phaseId, true)}
                      >
                        Delete worktree + branch
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        <h2>Start Change</h2>
        {phases.length > 0 && (
          <p>
            Existing phases:{" "}
            {phases.map((p) => (
              <code key={p.id} style={{ marginRight: 8 }}>
                {p.id}({p.status})
                {p.dependsOn && p.dependsOn.length > 0
                  ? `←${p.dependsOn.join("+")}`
                  : ""}
              </code>
            ))}
          </p>
        )}
        <textarea
          rows={4}
          placeholder="Describe the change (creates next ordered phase 01-slug…)…"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <input
          placeholder="Optional depends on (comma-separated phase ids, e.g. 01-scaffold,02-auth)"
          value={dependsOnInput}
          onChange={(e) => setDependsOnInput(e.target.value)}
        />
        <div className="row">
          <button
            disabled={busy || active || !selectedProjectId || !description}
            onClick={startResearch}
          >
            Start Research
          </button>
        </div>
      </section>

      {currentRun && (
        <section className="card">
          <h2>
            Run {currentRun.id.slice(0, 8)}{" "}
            {active ? <small>(running…)</small> : null}
          </h2>
          <div className="stages">
            {stages.map((stage) => (
              <span
                key={stage}
                className={`stage ${currentRun.stage === stage ? "active" : ""}`}
              >
                {stage}
              </span>
            ))}
          </div>
          {(totalDuration || stageTimings.length > 0) && (
            <p>
              Timing
              {totalDuration ? `: total ${totalDuration}` : ""}
              {stageTimings.length > 0 ? (
                <>
                  {" "}
                  —{" "}
                  {stageTimings
                    .map((t) => `${t.stage} ${t.duration}`)
                    .join(" · ")}
                </>
              ) : null}
            </p>
          )}
          {(diagnosis || failureSummary) && (
            <div className="diagnosis">
              <h3>Failure diagnosis</h3>
              {diagnosis ? (
                <>
                  <p>
                    <strong>{diagnosis.title ?? "Failure"}</strong>
                    {diagnosis.class ? (
                      <>
                        {" "}
                        <code>{diagnosis.class}</code>
                      </>
                    ) : null}
                    {diagnosis.audience ? (
                      <> · audience={diagnosis.audience}</>
                    ) : null}
                  </p>
                  {diagnosis.rootCause ? <p>{diagnosis.rootCause}</p> : null}
                  {diagnosis.nextActions ? (
                    <p>
                      <em>Next:</em> {diagnosis.nextActions}
                    </p>
                  ) : null}
                  {diagnosis.operatorActions &&
                  diagnosis.operatorActions.length > 0 ? (
                    <ol>
                      {diagnosis.operatorActions.map((a) => (
                        <li key={a.slice(0, 80)}>{a}</li>
                      ))}
                    </ol>
                  ) : null}
                  {diagnosis.evidence ? (
                    <pre className="diagnosis-evidence">
                      {diagnosis.evidence.slice(0, 1200)}
                    </pre>
                  ) : null}
                </>
              ) : (
                <p>{failureSummary}</p>
              )}
              {verifySteps.length > 0 ? (
                <div className="verify-steps">
                  <h4>Verify steps</h4>
                  <ol>
                    {verifySteps.map((s) => {
                      const highlight =
                        s.id === verifyFirstFailureId ||
                        (!s.ok &&
                          s.id ===
                            (diagnosis?.failingStep?.stepId ??
                              verifyFirstFailureId));
                      return (
                        <li
                          key={s.id}
                          style={
                            highlight
                              ? { fontWeight: 600, color: "var(--danger, #b33)" }
                              : undefined
                          }
                        >
                          <code>{s.id}</code> {s.name}
                          {s.command ? (
                            <>
                              {" "}
                              — <code>{s.command.slice(0, 80)}</code>
                            </>
                          ) : null}{" "}
                          (exit {s.exitCode}
                          {s.ok ? "" : ", fail"})
                        </li>
                      );
                    })}
                  </ol>
                </div>
              ) : null}
            </div>
          )}
          {verifySteps.length > 0 && !(diagnosis || failureSummary) ? (
            <div className="diagnosis">
              <h3>Verify steps</h3>
              <ol>
                {verifySteps.map((s) => (
                  <li key={s.id}>
                    <code>{s.id}</code> {s.name} (exit {s.exitCode}
                    {s.ok ? "" : ", fail"})
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {currentPhase && (
            <p>
              Phase <code>{currentPhase.id}</code>: {currentPhase.description}
              {currentPhase.dependsOn && currentPhase.dependsOn.length > 0 ? (
                <>
                  <br />
                  Depends on: <code>{currentPhase.dependsOn.join(", ")}</code>
                </>
              ) : null}
              {currentPhase.worktreePath ? (
                <>
                  <br />
                  Worktree: <code>{currentPhase.worktreePath}</code>
                </>
              ) : null}
            </p>
          )}
          {phaseDoc && (
            <>
              <h3>PHASE.md</h3>
              <div className="log">{phaseDoc}</div>
            </>
          )}
          <textarea
            rows={3}
            placeholder="Review feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={!canReview}
          />
          <div className="row">
            <button
              className="secondary"
              disabled={!canReview}
              onClick={() => submitReview("request_changes")}
            >
              Request Changes
            </button>
            <button disabled={!canReview} onClick={() => submitReview("approve")}>
              Approve Phase
            </button>
            <button disabled={!canDesign} onClick={startDesign}>
              Start Design
            </button>
            <button disabled={!canDevelop} onClick={startDevelopment}>
              Start Development
            </button>
          </div>
          <div className="log">{log || "Waiting for logs..."}</div>
        </section>
      )}

      <section className="card">
        <h2>Models & Providers</h2>
        <p>
          Platform functions (agent roles) and the provider-aware model catalog.
          Bind a function to a model by <code>provider</code> (providers.json key)
          + <code>modelId</code>.
        </p>
        <div className="row">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void refreshFunctionMappings()}
          >
            Refresh models
          </button>
        </div>
        {modelsError && <p className="error">{modelsError}</p>}
        {functionMappings ? (
          <>
            <h3>Function mappings</h3>
            <table className="models-table">
              <thead>
                <tr>
                  <th>Function</th>
                  <th>Model</th>
                  <th>Provider</th>
                  <th>Endpoint</th>
                </tr>
              </thead>
              <tbody>
                {functionMappings.functions.map((fn) => (
                  <tr key={fn.function}>
                    <td>
                      <code>{fn.function}</code>
                      {!fn.current?.explicit ? (
                        <small className="muted"> (fallback)</small>
                      ) : null}
                    </td>
                    <td>{fn.current?.modelId ?? "—"}</td>
                    <td>{fn.current?.provider ?? "—"}</td>
                    <td>
                      <code>{fn.current?.endpointId ?? "—"}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h3>Bind function</h3>
            <div className="row">
              <select
                value={bindFunction}
                onChange={(e) => setBindFunction(e.target.value)}
              >
                <option value="">Select function…</option>
                {functionMappings.functions.map((fn) => (
                  <option key={fn.function} value={fn.function}>
                    {fn.function}
                  </option>
                ))}
              </select>
              <select
                value={bindModelId}
                onChange={(e) => setBindModelId(e.target.value)}
              >
                <option value="">Select model…</option>
                {functionMappings.models.map((m) => (
                  <option key={`${m.providerName}:${m.modelId}`} value={m.modelId}>
                    {m.modelId} ({m.provider})
                  </option>
                ))}
              </select>
              <select
                value={bindProvider}
                onChange={(e) => setBindProvider(e.target.value)}
              >
                <option value="">Auto provider</option>
                {functionMappings.providers.map((p) => (
                  <option key={p.providerName} value={p.providerName}>
                    {p.providerName}
                  </option>
                ))}
              </select>
              <button
                disabled={busy || !bindFunction || !bindModelId}
                onClick={() => void doBindFunction()}
              >
                Bind
              </button>
            </div>
            {bindResult && <p>Bound: {bindResult}</p>}

            <h3>Providers</h3>
            {functionMappings.providers.map((p) => (
              <div key={p.providerName} className="provider-block">
                <p>
                  <strong>{p.label}</strong>{" "}
                  <code>{p.providerName}</code> · {p.apiType} ·{" "}
                  <code>{p.baseUrl}</code>
                  {p.source === "live" ? (
                    <small className="muted"> (live)</small>
                  ) : (
                    <small className="muted"> (configured)</small>
                  )}
                  {p.error ? (
                    <small className="error"> — {p.error}</small>
                  ) : null}
                </p>
                <p className="model-chips">
                  {p.models.map((m) => {
                    const mapped = p.mappedModelIds.includes(m);
                    return (
                      <span
                        key={m}
                        className={`model-chip${mapped ? " mapped" : ""}`}
                        title={mapped ? "mapped to an endpoint" : "available"}
                      >
                        {m}
                      </span>
                    );
                  })}
                </p>
              </div>
            ))}
          </>
        ) : (
          <p>Loading models…</p>
        )}
      </section>

      <section className="card">
        <h2>Chats</h2>
        <p>
          Operator chat conversations (global scope). Model overrides and
          awaited runs are shown per conversation.
        </p>
        <div className="row">
          <input
            placeholder="New chat title (optional)"
            value={chatTitle}
            onChange={(e) => setChatTitle(e.target.value)}
          />
          <button disabled={busy} onClick={() => void doCreateChat()}>
            New chat
          </button>
          <select
            value={chatStatusFilter}
            onChange={(e) => {
              setChatStatusFilter(
                e.target.value as "active" | "closed" | "",
              );
            }}
          >
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="closed">Closed</option>
          </select>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => void refreshConversations()}
          >
            Refresh
          </button>
        </div>
        {chatsError && <p className="error">{chatsError}</p>}
        {conversations.length === 0 ? (
          <p>No conversations.</p>
        ) : (
          <ul>
            {conversations.map((c) => (
              <li key={c.id} style={{ marginBottom: "0.75rem" }}>
                <strong>{c.title ?? c.id.slice(0, 8)}</strong>{" "}
                <code>{c.id.slice(0, 8)}</code> · {c.status}
                {c.messageCount != null ? ` · ${c.messageCount} msgs` : ""}
                {c.modelOverride ? (
                  <>
                    {" "}
                    · model{" "}
                    <code>
                      {c.modelOverride.modelId}@{c.modelOverride.endpointId}
                    </code>
                  </>
                ) : null}
                {c.awaitedRun ? (
                  <>
                    {" "}
                    · awaiting{" "}
                    <code>
                      {c.awaitedRun.kind}:{c.awaitedRun.runId.slice(0, 8)}
                    </code>
                  </>
                ) : null}
                <div className="row" style={{ marginTop: "0.35rem" }}>
                  {c.status === "active" ? (
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => void doCloseChat(c.id)}
                    >
                      Close
                    </button>
                  ) : null}
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void doDeleteChat(c.id)}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="error">{error}</p>}
    </>
  );
}
