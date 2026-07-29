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
  stage_timings?: Array<{
    stage: string;
    duration: string;
    duration_ms: number | null;
  }>;
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
  const [stageTimings, setStageTimings] = useState<
    Array<{ stage: string; duration: string }>
  >([]);
  const [totalDuration, setTotalDuration] = useState<string | null>(null);
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [worktrees, setWorktrees] = useState<WorktreeInfo[]>([]);
  const [checkoutBranch, setCheckoutBranch] = useState("");

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

  useEffect(() => {
    refreshProjects().catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    void refreshProjectRuns(selectedProjectId).catch(() => undefined);
    setCurrentRun(null);
    setCurrentPhase(null);
    setPhaseDoc("");
    setLog("");
    setBlueprintStatus(null);
  }, [selectedProjectId]);

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
                      }}
                    >
                      {run.phase_id ?? run.id.slice(0, 8)} — {run.stage}
                      {run.total_duration && run.total_duration !== "—"
                        ? ` (${run.total_duration})`
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

      {error && <p className="error">{error}</p>}
    </>
  );
}
