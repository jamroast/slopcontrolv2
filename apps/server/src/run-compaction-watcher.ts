import { readProjectConfig } from "@slopcontrol/artifacts";
import { log } from "@slopcontrol/types";
import {
  compactRuns,
  planCompaction,
  type CompactionPlan,
  type RunCompactionConfig,
} from "./run-compaction.js";
import type { SlopStore } from "./store.js";

export interface RunCompactionWatcherDeps {
  store: SlopStore;
  /** True when a run is currently executing (never compact under it). */
  isRunActive: (runId: string) => boolean;
  /** Project IDs with an in-flight job — compaction skips the project. */
  projectBusy: (projectId: string) => boolean;
  exec?: import("./run-compaction.js").ExecFn;
}

export interface RunCompactionWatcherConfig {
  enabled: boolean;
  pollMs: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveRunCompactionWatcherConfig(): RunCompactionWatcherConfig {
  return {
    enabled: process.env.SLOPCONTROL_RUN_COMPACT_ENABLED !== "0",
    pollMs: envInt("SLOPCONTROL_RUN_COMPACT_INTERVAL_MS", 30 * 60 * 1_000),
  };
}

/**
 * Evaluate one project: returns the compaction plan when its terminal runs
 * exceed the configured threshold. Pure w.r.t. deps (no writes).
 */
export function evaluateProjectCompaction(
  deps: Pick<RunCompactionWatcherDeps, "store" | "isRunActive" | "projectBusy">,
  projectId: string,
  projectRoot: string,
  now: Date = new Date(),
): CompactionPlan | null {
  if (deps.projectBusy(projectId)) return null;
  const config = readProjectConfig(projectRoot);
  const knob: Partial<RunCompactionConfig> = config.runCompaction ?? {};
  const activeRunIds = new Set(
    deps.store
      .listRuns(projectId)
      .filter((run) => deps.isRunActive(run.id))
      .map((run) => run.id),
  );
  const plan = planCompaction({
    runs: deps.store.listRuns(projectId),
    activeRunIds,
    now,
    config: knob,
  });
  return plan.mergeSet.length >= 2 ? plan : null;
}

let watcherTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startRunCompactionWatcher(
  deps: RunCompactionWatcherDeps,
  cfg: RunCompactionWatcherConfig = resolveRunCompactionWatcherConfig(),
): void {
  if (!cfg.enabled) {
    log.info("run-compact", "disabled (SLOPCONTROL_RUN_COMPACT_ENABLED=0)");
    return;
  }
  if (watcherTimer) return;
  log.info("run-compact", "started", { pollMs: cfg.pollMs });
  watcherTimer = setInterval(() => {
    if (ticking) return; // never overlap ticks — tar/git can outlast pollMs
    ticking = true;
    void (async () => {
      for (const project of deps.store.listProjects()) {
        try {
          const plan = evaluateProjectCompaction(
            deps,
            project.id,
            project.rootPath,
          );
          if (!plan) continue;
          const result = await compactRuns({
            projectId: project.id,
            projectRoot: project.rootPath,
            store: deps.store,
            runs: plan.mergeSet,
            exec: deps.exec,
          });
          log.info("run-compact", "compacted", {
            projectId: project.id,
            archiveRunId: result.archiveRunId,
            merged: result.manifest.mergedRunIds.length,
            deletedDirs: result.deletedRunDirs.length,
          });
        } catch (err) {
          log.warn("run-compact", "compaction failed", {
            projectId: project.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })().finally(() => {
      ticking = false;
    });
  }, cfg.pollMs);
  // Don't keep process alive solely for watcher in tests
  if (typeof watcherTimer === "object" && "unref" in watcherTimer) {
    watcherTimer.unref();
  }
}

export function stopRunCompactionWatcher(): void {
  if (watcherTimer) {
    clearInterval(watcherTimer);
    watcherTimer = null;
  }
}
