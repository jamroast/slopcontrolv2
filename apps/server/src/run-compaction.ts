import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readDiagnosis,
  readRunMemory,
  readVerifyStepsReport,
  runDir,
} from "@slopcontrol/artifacts";
import type { Run } from "@slopcontrol/types";
import type { SlopStore } from "./store.js";

const execFileAsync = promisify(execFile);

/** Stages eligible for compaction (terminal, no longer actionable in place). */
const COMPACTABLE_STAGES = new Set(["complete", "failed", "interrupted"]);

export interface RunCompactionConfig {
  /** Compact when a project's terminal runs exceed this count. */
  maxRuns: number;
  /** Always keep at least this many recent terminal runs uncompacted. */
  keepLatest: number;
  /** Never compact runs younger than this. */
  minAgeDays: number;
}

export const DEFAULT_RUN_COMPACTION: RunCompactionConfig = {
  maxRuns: 50,
  keepLatest: 20,
  minAgeDays: 7,
};

export interface CompactionPlan {
  /** Terminal runs considered for compaction (after all exclusions). */
  eligibleCount: number;
  /** Runs selected to merge (oldest-first). Empty when under threshold. */
  mergeSet: Run[];
  reason?: string;
}

/**
 * Pure planner: pick the oldest terminal runs to flatten. Never selects the
 * latest run per phase (phase-level diagnosis/handoff fallbacks scan run
 * dirs), never active runs, never already-archived rows, never runs younger
 * than minAgeDays. Only returns a merge set when the terminal count exceeds
 * maxRuns; the set leaves at least keepLatest terminal runs behind.
 */
export function planCompaction(opts: {
  runs: Run[];
  activeRunIds: ReadonlySet<string>;
  now?: Date;
  config?: Partial<RunCompactionConfig>;
}): CompactionPlan {
  const cfg = { ...DEFAULT_RUN_COMPACTION, ...opts.config };
  const now = opts.now ?? new Date();
  const minAgeMs = cfg.minAgeDays * 24 * 60 * 60 * 1_000;

  const candidates = opts.runs.filter(
    (run) =>
      COMPACTABLE_STAGES.has(run.stage) &&
      !run.archived &&
      !opts.activeRunIds.has(run.id),
  );

  // Latest run per phase is protected.
  const latestByPhase = new Map<string, Run>();
  for (const run of opts.runs) {
    if (run.archived) continue;
    const cur = latestByPhase.get(run.phaseId);
    if (!cur || run.createdAt > cur.createdAt) latestByPhase.set(run.phaseId, run);
  }

  const eligible = candidates
    .filter((run) => latestByPhase.get(run.phaseId)?.id !== run.id)
    .filter((run) => now.getTime() - Date.parse(run.createdAt) >= minAgeMs)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (candidates.length <= cfg.maxRuns) {
    return {
      eligibleCount: eligible.length,
      mergeSet: [],
      reason: `terminal run count ${candidates.length} <= maxRuns ${cfg.maxRuns}`,
    };
  }
  const mergeCount = Math.min(
    eligible.length,
    Math.max(0, candidates.length - cfg.keepLatest),
  );
  const mergeSet = eligible.slice(0, mergeCount);
  if (mergeSet.length < 2) {
    return {
      eligibleCount: eligible.length,
      mergeSet: [],
      reason: "nothing safe to merge after latest-per-phase/age exclusions",
    };
  }
  return { eligibleCount: eligible.length, mergeSet };
}

export interface RunDigest {
  runId: string;
  phaseId: string;
  stage: string;
  createdAt: string;
  finishedAt: string | null;
  totalDurationMs: number | null;
  iterationCount: number;
  diagnosis: { title: string; fingerprint?: string } | null;
  verifySteps: { total: number; failed: number; ok: boolean } | null;
  memoryIterations: number;
  lastNextActions: string | null;
  logTail: string[];
  dirBytes: number;
}

export interface CompactionArchiveManifest {
  archiveRunId: string;
  projectId: string;
  compactedAt: string;
  mergedRunIds: string[];
  digests: RunDigest[];
  unifiedChanges: { stat: string; fromRef: string; toRef: string } | null;
  rawArchive: string;
}

export type ExecFn = (
  cmd: string,
  args: string[],
  cwd: string,
) => Promise<{ code: number; stdout: string; stderr: string }>;

const defaultExec: ExecFn = async (cmd, args, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? String(err),
    };
  }
};

function dirSizeBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) total += dirSizeBytes(p);
      else if (entry.isFile()) total += statSync(p).size;
    }
  } catch {
    /* best effort */
  }
  return total;
}

function digestRun(projectRoot: string, run: Run): RunDigest {
  const diagnosis = readDiagnosis(projectRoot, run.id);
  const verify = readVerifyStepsReport(projectRoot, run.id);
  const memory = readRunMemory(projectRoot, run.id);
  const dir = runDir(projectRoot, run.id);
  let logTail: string[] = [];
  const logPath = join(dir, "log.txt");
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf-8").split("\n");
    logTail = lines.slice(-40);
  }
  const steps = verify?.steps ?? [];
  return {
    runId: run.id,
    phaseId: run.phaseId,
    stage: run.stage,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt ?? null,
    totalDurationMs: run.totalDurationMs ?? null,
    iterationCount: run.iterationCount,
    diagnosis: diagnosis
      ? { title: diagnosis.title, fingerprint: diagnosis.fingerprint }
      : null,
    verifySteps: verify
      ? {
          total: steps.length,
          failed: steps.filter((s) => s.exitCode !== 0).length,
          ok: verify.ok,
        }
      : null,
    memoryIterations: memory.length,
    lastNextActions: memory[memory.length - 1]?.nextActionsSummary ?? null,
    logTail,
    dirBytes: existsSync(dir) ? dirSizeBytes(dir) : 0,
  };
}

/**
 * Unified view of what changed across the merged runs: diff --stat between
 * the parent of the oldest merged phase's merge commit and the newest merged
 * phase's merge commit. Null when the merge commits can't be resolved.
 */
async function unifiedChanges(
  exec: ExecFn,
  projectRoot: string,
  phaseIds: string[],
): Promise<CompactionArchiveManifest["unifiedChanges"]> {
  const mergeCommits: { phaseId: string; sha: string }[] = [];
  for (const phaseId of [...new Set(phaseIds)]) {
    const res = await exec(
      "git",
      ["log", "--format=%H", "-n", "1", "--grep", `merge phase ${phaseId}`, "-i"],
      projectRoot,
    );
    const sha = res.stdout.trim().split("\n")[0]?.trim();
    if (res.code === 0 && sha) mergeCommits.push({ phaseId, sha });
  }
  if (mergeCommits.length === 0) return null;
  const toRef = mergeCommits[mergeCommits.length - 1]!.sha;
  const fromRef = `${mergeCommits[0]!.sha}^`;
  const diff = await exec(
    "git",
    ["diff", "--stat", fromRef, toRef],
    projectRoot,
  );
  if (diff.code !== 0) return null;
  return { stat: diff.stdout.trim(), fromRef, toRef };
}

export interface CompactionResult {
  ok: boolean;
  archiveRunId: string;
  archiveDir: string;
  manifest: CompactionArchiveManifest;
  deletedRunDirs: string[];
}

export type ProjectCompactionResponse =
  | { status: 409; error: string }
  | { status: 200; body: Record<string, unknown> };

/**
 * Endpoint-level decision for POST /projects/:id/runs/compact: busy guard,
 * plan, dryRun preview, or execution. Kept route-agnostic for tests.
 */
export async function compactProjectRuns(opts: {
  projectId: string;
  projectRoot: string;
  store: SlopStore;
  activeRunIds: ReadonlySet<string>;
  dryRun?: boolean;
  config?: Partial<RunCompactionConfig>;
  exec?: ExecFn;
}): Promise<ProjectCompactionResponse> {
  const busy = opts.store
    .listRuns(opts.projectId)
    .some((run) => opts.activeRunIds.has(run.id));
  if (busy) {
    return {
      status: 409,
      error: "Project has an active run — compaction skipped until it finishes",
    };
  }
  const plan = planCompaction({
    runs: opts.store.listRuns(opts.projectId),
    activeRunIds: opts.activeRunIds,
    config: opts.config ?? {},
  });
  if (plan.mergeSet.length < 2) {
    return {
      status: 200,
      body: {
        ok: true,
        compacted: false,
        reason: plan.reason ?? "nothing to compact",
        eligibleCount: plan.eligibleCount,
      },
    };
  }
  if (opts.dryRun) {
    return {
      status: 200,
      body: {
        ok: true,
        dryRun: true,
        eligibleCount: plan.eligibleCount,
        mergeSet: plan.mergeSet.map((run) => ({
          id: run.id,
          phaseId: run.phaseId,
          stage: run.stage,
          createdAt: run.createdAt,
        })),
      },
    };
  }
  const result = await compactRuns({
    projectId: opts.projectId,
    projectRoot: opts.projectRoot,
    store: opts.store,
    runs: plan.mergeSet,
    exec: opts.exec,
  });
  return {
    status: 200,
    body: {
      ok: true,
      compacted: true,
      archiveRunId: result.archiveRunId,
      mergedRunIds: result.manifest.mergedRunIds,
      unifiedChanges: result.manifest.unifiedChanges,
      deletedRunDirs: result.deletedRunDirs.length,
    },
  };
}

/**
 * Flatten the given runs into one synthetic archive run. Order is
 * crash-safe: tar.gz + manifest are written before the store swap, and the
 * original run dirs are deleted only after both succeed.
 */
export async function compactRuns(opts: {
  projectId: string;
  projectRoot: string;
  store: SlopStore;
  runs: Run[];
  exec?: ExecFn;
  now?: Date;
}): Promise<CompactionResult> {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..*$/, "")
    .replace("T", "-");
  const archiveRunId = `archive-${stamp}`;
  const archiveDir = join(
    opts.projectRoot,
    ".slopcontrol",
    "archive",
    `runs-compact-${stamp}`,
  );
  mkdirSync(archiveDir, { recursive: true });

  const sorted = [...opts.runs].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const digests = sorted.map((run) => digestRun(opts.projectRoot, run));
  const unified = await unifiedChanges(
    exec,
    opts.projectRoot,
    sorted.map((r) => r.phaseId),
  );

  // 1. Pack the raw run dirs (full fidelity, compressed).
  const runsRoot = join(opts.projectRoot, ".slopcontrol", "runs");
  const rawName = "raw.tar.gz";
  const tar = await exec(
    "tar",
    ["-czf", join(archiveDir, rawName), ...sorted.map((r) => r.id)],
    runsRoot,
  );
  if (tar.code !== 0) {
    throw new Error(`tar of run dirs failed (${tar.code}): ${tar.stderr.slice(0, 300)}`);
  }

  // 2. Manifest last within the archive.
  const manifest: CompactionArchiveManifest = {
    archiveRunId,
    projectId: opts.projectId,
    compactedAt: now.toISOString(),
    mergedRunIds: sorted.map((r) => r.id),
    digests,
    unifiedChanges: unified,
    rawArchive: rawName,
  };
  writeFileSync(
    join(archiveDir, "ARCHIVE.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  // 3. Store swap: synthetic archive row + tombstones, one save().
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const archiveRun: Run = {
    id: archiveRunId,
    phaseId: last.phaseId,
    projectId: opts.projectId,
    stage: "complete",
    iterationCount: sorted.reduce((n, r) => n + r.iterationCount, 0),
    createdAt: first.createdAt,
    updatedAt: now.toISOString(),
    startedAt: first.startedAt ?? first.createdAt,
    finishedAt: last.finishedAt ?? last.updatedAt,
    stageTimings: [],
    archived: true,
    mergedRunIds: manifest.mergedRunIds,
    archiveTitle: `Archive: ${sorted.length} runs (${first.createdAt.slice(0, 10)} → ${last.createdAt.slice(0, 10)})`,
  };
  opts.store.replaceRunsWithArchive(
    manifest.mergedRunIds,
    archiveRun,
    now.toISOString(),
  );

  // 4. Delete originals only after archive + store write succeeded.
  const deleted: string[] = [];
  for (const run of sorted) {
    const dir = runDir(opts.projectRoot, run.id);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
      deleted.push(dir);
    }
  }

  return {
    ok: true,
    archiveRunId,
    archiveDir,
    manifest,
    deletedRunDirs: deleted,
  };
}
