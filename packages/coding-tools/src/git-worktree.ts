import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface WorktreeResult {
  path: string;
  branch: string;
  /** Local (often gitignored) files copied from project root into the worktree */
  syncedFiles?: string[];
}

/** Default gitignored env/secrets to mirror into phase worktrees. */
export const DEFAULT_WORKTREE_SYNC_PATHS = [
  ".env",
  ".env.local",
  ".env.docker",
  ".env.test",
  ".env.development.local",
  ".env.test.local",
  ".env.production.local",
] as const;

/**
 * Copy local env/secret files from the project root into a phase worktree.
 * Git worktrees do not include gitignored files; tests and CLIs often need them.
 *
 * If the worktree already has a file whose contents differ from root, leave it
 * alone so mid-phase agent edits (e.g. fixing a `:cloud` comment) are not wiped
 * on each develop iteration. Missing files are still created from root.
 */
export function syncLocalFilesToWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
  relativePaths?: string[];
}): string[] {
  const paths = opts.relativePaths?.length
    ? opts.relativePaths
    : [...DEFAULT_WORKTREE_SYNC_PATHS];
  const synced: string[] = [];

  for (const rel of paths) {
    if (!rel || rel.includes("..") || rel.startsWith("/") || rel.includes("\0")) {
      continue;
    }
    const src = join(opts.projectRoot, rel);
    const dest = join(opts.worktreePath, rel);
    if (!existsSync(src)) continue;
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    if (existsSync(dest)) {
      try {
        if (!statSync(dest).isFile()) continue;
        const srcBody = readFileSync(src);
        const destBody = readFileSync(dest);
        if (!srcBody.equals(destBody)) {
          // Preserve intentional worktree override
          continue;
        }
      } catch {
        continue;
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    synced.push(rel);
  }

  return synced;
}

/**
 * Copy canonical phase docs from the project into the worktree so coding agents
 * can read `.slopcontrol/phases/<phaseId>/PHASE.md` (and RESEARCH.md).
 * Writes a short pointer at worktree-root `PHASE.md` (never the full plan) so
 * coding agents that open root are redirected without polluting next-phase harvest.
 *
 * When `preserveWorktreeEdits` is true (develop loop re-sync), do not overwrite a
 * worktree PHASE.md that already differs from the project canonical copy — the
 * coding agent may have fixed Automated Checks there.
 */
export function syncPhaseArtifactsToWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
  phaseId: string;
  /** When true, keep divergent worktree PHASE.md (agent edits). Default false. */
  preserveWorktreeEdits?: boolean;
}): string[] {
  const synced: string[] = [];
  const phaseId = opts.phaseId?.trim();
  if (!phaseId || phaseId.includes("..") || phaseId.includes("/") || phaseId.includes("\0")) {
    return synced;
  }

  for (const name of ["PHASE.md", "RESEARCH.md", "UI-SPEC.md"] as const) {
    const rel = join(".slopcontrol", "phases", phaseId, name);
    const src = join(opts.projectRoot, rel);
    if (!existsSync(src)) continue;
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    const dest = join(opts.worktreePath, rel);
    if (
      opts.preserveWorktreeEdits &&
      name === "PHASE.md" &&
      existsSync(dest)
    ) {
      try {
        const srcBody = readFileSync(src);
        const destBody = readFileSync(dest);
        if (!srcBody.equals(destBody)) {
          // Preserve intentional worktree PHASE edits (e.g. fixed Automated Checks)
          continue;
        }
      } catch {
        /* fall through to copy */
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    synced.push(rel.replace(/\\/g, "/"));
  }

  // Design artifacts (tokens.css, STATUS.md, generated logos/SVGs)
  const designRel = join(".slopcontrol", "phases", phaseId, "design");
  const designSrc = join(opts.projectRoot, designRel);
  if (existsSync(designSrc)) {
    try {
      if (statSync(designSrc).isDirectory()) {
        syncDesignDirRecursive({
          srcDir: designSrc,
          destDir: join(opts.worktreePath, designRel),
          relPrefix: designRel.replace(/\\/g, "/"),
          synced,
        });
      }
    } catch {
      /* ignore */
    }
  }

  const canonicalPhase = join(
    opts.projectRoot,
    ".slopcontrol",
    "phases",
    phaseId,
    "PHASE.md",
  );
  if (existsSync(canonicalPhase)) {
    try {
      if (statSync(canonicalPhase).isFile()) {
        // Pointer only — never copy the full prior/current phase plan to
        // worktree-root PHASE.md (that pollutes harvest for the next phase).
        const rootPhase = join(opts.worktreePath, "PHASE.md");
        const pointer = [
          `# Phase ${phaseId}`,
          "",
          `See \`.slopcontrol/phases/${phaseId}/PHASE.md\` for the canonical phase plan.`,
          "Do not treat this root PHASE.md as the phase document.",
          "",
        ].join("\n");
        writeFileSync(rootPhase, pointer, "utf-8");
        synced.push("PHASE.md");
      }
    } catch {
      // ignore
    }
  }

  return synced;
}

function syncDesignDirRecursive(opts: {
  srcDir: string;
  destDir: string;
  relPrefix: string;
  synced: string[];
}): void {
  mkdirSync(opts.destDir, { recursive: true });
  let entries: string[];
  try {
    entries = readdirSync(opts.srcDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "." || name === ".." || name.includes("\0")) continue;
    const src = join(opts.srcDir, name);
    const dest = join(opts.destDir, name);
    const rel = `${opts.relPrefix}/${name}`.replace(/\\/g, "/");
    try {
      const st = statSync(src);
      if (st.isDirectory()) {
        syncDesignDirRecursive({
          srcDir: src,
          destDir: dest,
          relPrefix: rel,
          synced: opts.synced,
        });
      } else if (st.isFile()) {
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(src, dest);
        opts.synced.push(rel);
      }
    } catch {
      /* skip */
    }
  }
}

/** True when worktree env would regress root paid-tier Ollama config to free. */
export function isPaidToFreeEnvRegression(
  rootBody: string,
  worktreeBody: string,
): boolean {
  const rootPaid = /^OLLAMA_TIER\s*=\s*paid\b/im.test(rootBody);
  const wtFree = /^OLLAMA_TIER\s*=\s*free\b/im.test(worktreeBody);
  return rootPaid && wtFree;
}

function readEnvAssignment(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim();
}

function upsertEnvAssignmentLocal(
  body: string,
  key: string,
  value: string,
): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(body)) return body.replace(re, line);
  const trimmed = body.replace(/\s*$/, "");
  return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

function stripEnvAssignmentLocal(body: string, key: string): string {
  return body
    .replace(new RegExp(`^${key}=.*\\r?\\n?`, "gm"), "")
    .replace(/\n{3,}/g, "\n\n");
}

const WORKTREE_DB_PORT_MIN = 5500;
const WORKTREE_DB_PORT_MAX = 5599;
const DEFAULT_CANONICAL_DB_PORT = 5433;

function isWorktreeIsolationPort(port: number): boolean {
  return (
    Number.isFinite(port) &&
    port >= WORKTREE_DB_PORT_MIN &&
    port <= WORKTREE_DB_PORT_MAX
  );
}

function loadCanonicalDbPortFromSnapshot(
  projectRoot: string,
): number | undefined {
  const path = join(projectRoot, ".slopcontrol", "canonical-runtime-env.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { dbPort?: number };
    if (
      typeof raw.dbPort === "number" &&
      Number.isFinite(raw.dbPort) &&
      raw.dbPort > 0 &&
      !isWorktreeIsolationPort(raw.dbPort)
    ) {
      return raw.dbPort;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * Strip worktree compose isolation keys before pushing env files to project root.
 * Never trusts an isolation-range DB_PORT from live root (may already be poisoned).
 */
export function sanitizeWorktreeEnvForRootSync(
  worktreeBody: string,
  rootBody: string | null,
  opts?: { canonicalDbPort?: number },
): string {
  let next = stripEnvAssignmentLocal(worktreeBody, "COMPOSE_PROJECT_NAME");
  const rootPort = rootBody ? readEnvAssignment(rootBody, "DB_PORT") : undefined;
  const rootPortNum = rootPort !== undefined ? Number(rootPort) : NaN;

  let canonical =
    opts?.canonicalDbPort !== undefined &&
    Number.isFinite(opts.canonicalDbPort) &&
    !isWorktreeIsolationPort(opts.canonicalDbPort)
      ? opts.canonicalDbPort
      : undefined;

  if (
    canonical === undefined &&
    Number.isFinite(rootPortNum) &&
    rootPortNum > 0 &&
    !isWorktreeIsolationPort(rootPortNum)
  ) {
    canonical = rootPortNum;
  }

  if (canonical !== undefined) {
    next = upsertEnvAssignmentLocal(next, "DB_PORT", String(canonical));
    for (const key of [
      "DATABASE_URL",
      "LOCAL_DB_URL",
      "POSTGRES_URL",
      "DB_URL",
    ]) {
      const cur = readEnvAssignment(next, key);
      if (!cur) continue;
      const rewritten = cur.replace(
        /(postgres(?:ql)?:\/\/[^/\s"']+?):(\d+)\b/i,
        `$1:${canonical}`,
      );
      if (rewritten !== cur) {
        next = upsertEnvAssignmentLocal(next, key, rewritten);
      }
    }
  } else {
    next = stripEnvAssignmentLocal(next, "DB_PORT");
    for (const key of [
      "DATABASE_URL",
      "LOCAL_DB_URL",
      "POSTGRES_URL",
      "DB_URL",
    ]) {
      const cur = readEnvAssignment(next, key);
      if (!cur) continue;
      const rewritten = cur.replace(
        /(postgres(?:ql)?:\/\/[^/\s"']+?):(\d+)\b/i,
        `$1:${DEFAULT_CANONICAL_DB_PORT}`,
      );
      if (rewritten !== cur) {
        next = upsertEnvAssignmentLocal(next, key, rewritten);
      }
    }
  }
  return next;
}

/**
 * Copy worktree env/secret overrides back onto the project root.
 * Gitignored files are not included in merge; root verify needs these updates
 * (e.g. agent fixed a `:cloud` comment in worktree `.env.docker`).
 *
 * Only copies when the worktree file exists and differs from root (or root is missing).
 * Does not touch `.env.slopcontrol` — callers should pass `worktreeSyncPaths` / defaults only.
 * Refuses to push `OLLAMA_TIER=free` over a root that has `OLLAMA_TIER=paid`.
 * Strips worktree `COMPOSE_PROJECT_NAME` / isolated `DB_PORT` so root ports stay product-owned.
 */
export function syncLocalFilesFromWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
  relativePaths?: string[];
}): string[] {
  const paths = opts.relativePaths?.length
    ? opts.relativePaths
    : [...DEFAULT_WORKTREE_SYNC_PATHS];
  const synced: string[] = [];

  for (const rel of paths) {
    if (!rel || rel.includes("..") || rel.startsWith("/") || rel.includes("\0")) {
      continue;
    }
    // Never treat SlopControl overlay as a product runtime file to push
    if (rel === ".env.slopcontrol" || rel.endsWith("/.env.slopcontrol")) {
      continue;
    }
    const src = join(opts.worktreePath, rel);
    const dest = join(opts.projectRoot, rel);
    if (!existsSync(src)) continue;
    try {
      if (!statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    let srcBody: Buffer;
    try {
      srcBody = readFileSync(src);
    } catch {
      continue;
    }
    let srcText = srcBody.toString("utf-8");
    let destText: string | null = null;
    if (existsSync(dest)) {
      try {
        if (!statSync(dest).isFile()) continue;
        destText = readFileSync(dest, "utf-8");
      } catch {
        continue;
      }
    }
    if (
      rel === ".env" ||
      rel === ".env.local" ||
      rel.endsWith("/.env") ||
      rel.endsWith("/.env.local")
    ) {
      srcText = sanitizeWorktreeEnvForRootSync(srcText, destText, {
        canonicalDbPort: loadCanonicalDbPortFromSnapshot(opts.projectRoot),
      });
      srcBody = Buffer.from(srcText, "utf-8");
    }
    if (destText !== null) {
      if (srcBody.equals(Buffer.from(destText, "utf-8"))) {
        continue;
      }
      if (isPaidToFreeEnvRegression(destText, srcText)) {
        // Keep root paid-tier config; do not let coding agent push free-tier regression
        continue;
      }
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, srcBody);
    synced.push(rel);
  }

  return synced;
}

const IGNORED_ARTIFACT_NOISE =
  /(?:^|\/)(?:node_modules|\.next|dist|build|coverage|\.turbo|\.git|out|\.cache|tmp)(?:\/|$)/i;
const IGNORED_ARTIFACT_ENV = /(?:^|\/)\.env(?:\.|$)/;
const IGNORED_ARTIFACT_RUNS = /(?:^|\/)\.slopcontrol\/runs(?:\/|$)/;
const IGNORED_ARTIFACT_EXT = /\.(?:tsbuildinfo|log|map)$/i;
const MAX_IGNORED_ARTIFACT_SYNC = 400;

function normalizeRelPath(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isIgnoredArtifactNoise(rel: string): boolean {
  const n = normalizeRelPath(rel);
  if (!n || n.includes("..") || n.startsWith("/") || n.includes("\0")) return true;
  if (IGNORED_ARTIFACT_NOISE.test(n)) return true;
  if (IGNORED_ARTIFACT_ENV.test(n)) return true;
  if (IGNORED_ARTIFACT_RUNS.test(n)) return true;
  if (IGNORED_ARTIFACT_EXT.test(n)) return true;
  return false;
}

function listFilesUnder(absDir: string, relPrefix: string): string[] {
  const out: string[] = [];
  if (!existsSync(absDir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(absDir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === "." || name === ".." || name.includes("\0")) continue;
    const childAbs = join(absDir, name);
    const childRel = relPrefix ? `${relPrefix}/${name}` : name;
    try {
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        if (IGNORED_ARTIFACT_NOISE.test(normalizeRelPath(childRel) + "/")) continue;
        out.push(...listFilesUnder(childAbs, normalizeRelPath(childRel)));
      } else if (st.isFile()) {
        out.push(normalizeRelPath(childRel));
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * After merging a phase branch, gitignored worktree outputs (e.g. `drizzle/`)
 * never land on the project root. Copy untracked/ignored source-like files from
 * the worktree into the root, and mirror-delete stale ignored siblings under
 * touched top-level dirs so root matches the worktree for those artifacts.
 */
export function syncIgnoredArtifactsFromWorktree(opts: {
  projectRoot: string;
  worktreePath: string;
}): { copied: string[]; deleted: string[] } {
  const copied: string[] = [];
  const deleted: string[] = [];

  if (!isGitRepo(opts.worktreePath) || !isGitRepo(opts.projectRoot)) {
    return { copied, deleted };
  }

  const listed = runGitAllowFail(opts.worktreePath, [
    "ls-files",
    "-o",
    "-i",
    "--exclude-standard",
  ]);
  if (!listed.ok || !listed.stdout.trim()) {
    return { copied, deleted };
  }

  const candidates = listed.stdout
    .split("\n")
    .map((l) => normalizeRelPath(l.trim()))
    .filter((l) => l && !isIgnoredArtifactNoise(l))
    .slice(0, MAX_IGNORED_ARTIFACT_SYNC);

  const touchedTops = new Set<string>();

  for (const rel of candidates) {
    const src = join(opts.worktreePath, rel);
    const dest = join(opts.projectRoot, rel);
    try {
      if (!existsSync(src) || !statSync(src).isFile()) continue;
    } catch {
      continue;
    }
    try {
      if (existsSync(dest)) {
        const a = readFileSync(src);
        const b = readFileSync(dest);
        if (a.equals(b)) {
          const top = rel.split("/")[0];
          if (top) touchedTops.add(top);
          continue;
        }
      }
    } catch {
      /* fall through to copy */
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    copied.push(rel);
    const top = rel.split("/")[0];
    if (top) touchedTops.add(top);
  }

  for (const top of touchedTops) {
    if (!top || top.includes("..") || isIgnoredArtifactNoise(top)) continue;
    // Only mirror-delete when the top-level path is gitignored on the root
    const ignoredTop = runGitAllowFail(opts.projectRoot, [
      "check-ignore",
      "-q",
      top,
    ]);
    if (!ignoredTop.ok) continue;

    const rootFiles = listFilesUnder(join(opts.projectRoot, top), top);
    for (const rel of rootFiles) {
      if (isIgnoredArtifactNoise(rel)) continue;
      const wtAbs = join(opts.worktreePath, rel);
      if (existsSync(wtAbs)) continue;
      // Never delete tracked files
      const tracked = runGitAllowFail(opts.projectRoot, [
        "ls-files",
        "--error-unmatch",
        "--",
        rel,
      ]);
      if (tracked.ok) continue;
      try {
        unlinkSync(join(opts.projectRoot, rel));
        deleted.push(rel);
      } catch {
        try {
          rmSync(join(opts.projectRoot, rel), { force: true });
          deleted.push(rel);
        } catch {
          /* skip */
        }
      }
    }
  }

  return { copied, deleted };
}

export interface PhaseWorktreeInfo {
  phaseId: string;
  path: string;
  branch: string;
  exists: boolean;
  headCommit: string | null;
  dirty: boolean;
  uncommittedFiles: string[];
}

export type ConflictStrategy = "ours" | "theirs" | "phase" | "auto";

export interface ConflictFileInfo {
  path: string;
  /** Git index stages present (1=base, 2=ours, 3=theirs) */
  stages: number[];
}

export interface ResolveConflictsResult {
  ok: boolean;
  strategy: ConflictStrategy;
  resolved: string[];
  remaining: string[];
  mergeContinued: boolean;
  message: string;
}

export interface MergePhaseWorktreeResult {
  ok: boolean;
  phaseId: string;
  branch: string;
  worktreePath: string;
  targetBranch: string;
  committedInWorktree: boolean;
  commitMessage: string | null;
  mergeCommit: string | null;
  removedWorktree: boolean;
  /** True when project-root dirty files were stashed before merge */
  stashedRoot: boolean;
  /** True when the pre-merge stash was restored after merge */
  stashRestored: boolean;
  /** Stash ref left behind if restore failed (e.g. stash@{0}) */
  stashRef: string | null;
  /** Paths auto-resolved after stash-pop or merge conflicts */
  conflictsResolved?: string[];
  /** Untracked `.slopcontrol` paths removed before merge (phase branch wins) */
  clearedSlopcontrolPaths?: string[];
  /** Raw git merge stdout+stderr when merge failed */
  mergeOutput?: string;
  /**
   * When ok is false: overwrite = dirty/untracked would be overwritten;
   * conflict = real unmerged paths; other = everything else.
   */
  failureKind?: "overwrite" | "conflict" | "other";
  message: string;
  conflicts?: string[];
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runGitAllowFail(
  cwd: string,
  args: string[],
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: String(stdout).trim(), stderr: "" };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: String(err.stdout ?? "").trim(),
      stderr: String(err.stderr ?? err.message ?? "").trim(),
    };
  }
}

export function phaseBranchName(phaseId: string): string {
  return `slop/${phaseId}`;
}

export function phaseWorktreePath(opts: {
  projectId: string;
  phaseId: string;
  dataDir?: string;
}): string {
  const dataDir = opts.dataDir ?? join(homedir(), ".slopcontrol");
  return join(dataDir, "worktrees", opts.projectId, opts.phaseId);
}

/** Resolve to a stable absolute path for git-root comparisons. */
function resolveStablePath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Git toplevel for cwd, or null if not inside a work tree.
 */
export function getGitToplevel(cwd: string): string | null {
  const result = runGitAllowFail(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok || !result.stdout.trim()) return null;
  return result.stdout.trim();
}

/**
 * True when cwd is inside *some* git work tree (including a parent repo).
 * Prefer {@link isGitRepositoryRoot} for SlopControl project roots.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    runGit(projectRoot, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `dir` is the owned git repository root (toplevel === dir).
 * A nested folder under another repo (e.g. ~/Projects/my-app) is false.
 */
export function isGitRepositoryRoot(dir: string): boolean {
  const top = getGitToplevel(dir);
  if (!top) return false;
  return resolveStablePath(top) === resolveStablePath(dir);
}

function assertProjectGitRoot(projectRoot: string): void {
  if (isGitRepositoryRoot(projectRoot)) return;
  const foreign = getGitToplevel(projectRoot);
  throw new Error(
    foreign
      ? `Project root is nested under foreign git toplevel ${foreign}. SlopControl requires a dedicated .git in ${projectRoot} (run ensureGitInitialized / open_project again).`
      : `Project root is not a git repository: ${projectRoot}`,
  );
}

/**
 * Ensure the project root is a *dedicated* git repo with at least one commit
 * (needed for worktrees). If the folder only sits inside a parent repo,
 * initialize a nested `.git` here so merges never attach to the parent.
 */
export function ensureGitInitialized(projectRoot: string): void {
  if (!existsSync(projectRoot)) {
    mkdirSync(projectRoot, { recursive: true });
  }

  if (!isGitRepositoryRoot(projectRoot)) {
    // Not owned: either no git at all, or nested under a foreign parent.
    // Nested `git init` creates a project-owned repo even when a parent exists.
    if (!existsSync(join(projectRoot, ".git"))) {
      runGit(projectRoot, ["init"]);
    }
  }

  assertProjectGitRoot(projectRoot);

  try {
    runGit(projectRoot, ["rev-parse", "HEAD"]);
    return;
  } catch {
    // no commits yet
  }

  // Minimal first commit so worktree add has a start point — pathspec `.`
  // keeps the add scoped to this repo (never a foreign parent).
  try {
    runGit(projectRoot, ["add", "-A", "--", "."]);
  } catch {
    // nothing to add
  }

  try {
    runGit(projectRoot, [
      "-c",
      "user.email=slopcontrol@local",
      "-c",
      "user.name=SlopControl",
      "commit",
      "--allow-empty",
      "-m",
      "chore: initial commit (slopcontrol greenfield)",
    ]);
  } catch {
    // already committed or hooks blocked — ignore if HEAD now exists
    try {
      runGit(projectRoot, ["rev-parse", "HEAD"]);
    } catch {
      throw new Error(
        `Could not create an initial git commit in ${projectRoot}`,
      );
    }
  }
}

/**
 * Create (or reuse) a checked-out git worktree for a phase under
 * ~/.slopcontrol/worktrees/<projectId>/<phaseId> on branch slop/<phaseId>.
 */
export function ensurePhaseWorktree(opts: {
  projectRoot: string;
  projectId: string;
  phaseId: string;
  dataDir?: string;
  /** Extra/override relative paths to sync from project root (env files, etc.) */
  syncPaths?: string[];
}): WorktreeResult {
  const dataDir = opts.dataDir ?? join(homedir(), ".slopcontrol");
  const worktreePath = join(
    dataDir,
    "worktrees",
    opts.projectId,
    opts.phaseId,
  );
  const branch = `slop/${opts.phaseId}`;

  // Greenfield / empty repos need an initial commit before worktree add.
  // Also creates a nested .git when the folder sits inside a foreign parent repo.
  ensureGitInitialized(opts.projectRoot);
  assertProjectGitRoot(opts.projectRoot);

  if (!isGitRepo(opts.projectRoot)) {
    throw new Error(
      `Project root is not a git repository: ${opts.projectRoot}. Worktrees require git.`,
    );
  }

  const finish = (): WorktreeResult => {
    const syncedFiles = syncLocalFilesToWorktree({
      projectRoot: opts.projectRoot,
      worktreePath,
      relativePaths: opts.syncPaths,
    });
    const phaseSynced = syncPhaseArtifactsToWorktree({
      projectRoot: opts.projectRoot,
      worktreePath,
      phaseId: opts.phaseId,
    });
    return {
      path: worktreePath,
      branch,
      syncedFiles: [...syncedFiles, ...phaseSynced],
    };
  };

  if (existsSync(join(worktreePath, ".git")) || existsSync(worktreePath)) {
    try {
      const head = runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (head !== branch) {
        runGit(worktreePath, ["checkout", "-B", branch]);
      }
      return finish();
    } catch {
      // fall through to recreate
    }
  }

  mkdirSync(join(worktreePath, ".."), { recursive: true });
  const startPoint = runGit(opts.projectRoot, ["rev-parse", "HEAD"]);

  runGit(opts.projectRoot, [
    "worktree",
    "add",
    "-B",
    branch,
    worktreePath,
    startPoint,
  ]);

  // Guarantee a named branch checkout (not detached)
  runGit(worktreePath, ["checkout", "-B", branch]);

  return finish();
}

function listUncommitted(cwd: string): string[] {
  const status = runGitAllowFail(cwd, ["status", "--porcelain"]);
  if (!status.ok || !status.stdout.trim()) return [];
  return status.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^\S+\s+/, ""));
}

/** Normalize a porcelain path for comparisons and stash pathspecs. */
function normalizeStatusPath(p: string): string {
  let s = p.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
  if (s.startsWith("./")) s = s.slice(2);
  return s;
}

function isSlopcontrolPath(p: string): boolean {
  const n = normalizeStatusPath(p);
  return n === ".slopcontrol" || n.startsWith(".slopcontrol/");
}

/**
 * Split dirty paths so `.slopcontrol/**` is never stashed before merge/checkout.
 * Untracked orchestration artifacts do not block git merge, and stashing them
 * causes "already exists" pop failures when the orchestrator rewrites them.
 */
function partitionDirtyPaths(paths: string[]): {
  operatorDirty: string[];
  slopcontrolDirty: string[];
} {
  const operatorDirty: string[] = [];
  const slopcontrolDirty: string[] = [];
  for (const p of paths) {
    const n = normalizeStatusPath(p);
    if (!n) continue;
    if (isSlopcontrolPath(n)) slopcontrolDirty.push(n);
    else operatorDirty.push(n);
  }
  return { operatorDirty, slopcontrolDirty };
}

/**
 * Stash only operator/product dirty paths (never `.slopcontrol/**`).
 * Returns stashRef when a stash entry was created.
 */
function stashOperatorDirty(
  projectRoot: string,
  message: string,
  operatorDirty: string[],
): { ok: boolean; stashRef: string | null; stderr: string } {
  if (operatorDirty.length === 0) {
    return { ok: true, stashRef: null, stderr: "" };
  }
  const stash = runGitAllowFail(projectRoot, [
    "stash",
    "push",
    "--include-untracked",
    "-m",
    message,
    "--",
    ...operatorDirty,
  ]);
  if (!stash.ok) {
    return {
      ok: false,
      stashRef: null,
      stderr: stash.stderr || stash.stdout,
    };
  }
  const list = runGitAllowFail(projectRoot, ["stash", "list", "-1"]);
  const stashRef =
    list.ok && list.stdout ? list.stdout.split(":")[0]!.trim() : "stash@{0}";
  return { ok: true, stashRef, stderr: "" };
}

/** True when git refused merge because local dirty/untracked paths would be overwritten. */
export function isOverwriteMergeFailure(output: string): boolean {
  return /would be overwritten by merge|Please move or remove them before you merge|Please commit your changes or stash them before you merge/i.test(
    output,
  );
}

/**
 * Clear `.slopcontrol` paths that block merging a phase branch into the project
 * root: stash tracked mods (no --include-untracked), remove untracked paths that
 * already exist on the phase branch (phase commit is source of truth).
 */
function clearSlopcontrolMergeBlockers(
  projectRoot: string,
  phaseBranch: string,
  phaseId: string,
): {
  clearedUntracked: string[];
  stashedTracked: boolean;
  stashRef: string | null;
} {
  const clearedUntracked: string[] = [];

  const tree = runGitAllowFail(projectRoot, [
    "ls-tree",
    "-r",
    "--name-only",
    phaseBranch,
    "--",
    ".slopcontrol",
  ]);
  const phasePaths = tree.ok
    ? tree.stdout
        .split("\n")
        .map((l) => normalizeStatusPath(l))
        .filter(Boolean)
    : [];

  for (const rel of phasePaths) {
    const abs = join(projectRoot, rel);
    if (!existsSync(abs)) continue;
    const st = runGitAllowFail(projectRoot, [
      "status",
      "--porcelain",
      "--",
      rel,
    ]);
    if (!st.ok || !st.stdout.trim()) continue;
    const line = st.stdout.trim().split("\n")[0] ?? "";
    if (!line.startsWith("??")) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      clearedUntracked.push(rel);
    } catch {
      // best-effort; merge retry may still fail and surface paths
    }
  }

  // Tracked modifications under .slopcontrol (BLUEPRINT/ROADMAP/etc.)
  const trackedDiff = runGitAllowFail(projectRoot, [
    "diff",
    "--name-only",
    "HEAD",
    "--",
    ".slopcontrol",
  ]);
  const trackedCached = runGitAllowFail(projectRoot, [
    "diff",
    "--name-only",
    "--cached",
    "--",
    ".slopcontrol",
  ]);
  const hasTrackedSlop =
    (trackedDiff.ok && trackedDiff.stdout.trim().length > 0) ||
    (trackedCached.ok && trackedCached.stdout.trim().length > 0);

  if (!hasTrackedSlop) {
    return { clearedUntracked, stashedTracked: false, stashRef: null };
  }

  const stash = runGitAllowFail(projectRoot, [
    "stash",
    "push",
    "-m",
    `slopcontrol: pre-merge tracked .slopcontrol for ${phaseId}`,
    "--",
    ".slopcontrol",
  ]);
  if (!stash.ok) {
    return { clearedUntracked, stashedTracked: false, stashRef: null };
  }
  const list = runGitAllowFail(projectRoot, ["stash", "list", "-1"]);
  const stashRef =
    list.ok && list.stdout ? list.stdout.split(":")[0]!.trim() : "stash@{0}";
  return { clearedUntracked, stashedTracked: true, stashRef };
}

/**
 * Restore a pre-merge/checkout stash. On conflicted tracked paths, prefer
 * post-merge / phase content. On "already exists" untracked failures with no
 * conflict markers, drop the redundant stash entry.
 */
function restoreStashAfterGitOp(opts: {
  projectRoot: string;
  phaseId?: string;
}): {
  stashRestored: boolean;
  stashRef: string | null;
  droppedRedundant: boolean;
  conflictsResolved: string[];
} {
  const pop = runGitAllowFail(opts.projectRoot, ["stash", "pop"]);
  if (pop.ok) {
    return {
      stashRestored: true,
      stashRef: null,
      droppedRedundant: false,
      conflictsResolved: [],
    };
  }

  const conflictPaths = listConflictedPaths(opts.projectRoot);
  if (conflictPaths.length > 0) {
    const resolved = resolveConflicts({
      projectRoot: opts.projectRoot,
      strategy: "auto",
      phaseId: opts.phaseId,
      continueMerge: false,
    });
    if (resolved.ok) {
      const drop = runGitAllowFail(opts.projectRoot, ["stash", "drop"]);
      return {
        stashRestored: true,
        stashRef: drop.ok ? null : "stash@{0}",
        droppedRedundant: false,
        conflictsResolved: resolved.resolved,
      };
    }
    return {
      stashRestored: false,
      stashRef: "stash@{0}",
      droppedRedundant: false,
      conflictsResolved: resolved.resolved,
    };
  }

  // Typical: untracked files already present after orchestrator rewrote them.
  const drop = runGitAllowFail(opts.projectRoot, ["stash", "drop"]);
  if (drop.ok) {
    return {
      stashRestored: true,
      stashRef: null,
      droppedRedundant: true,
      conflictsResolved: [],
    };
  }
  return {
    stashRestored: false,
    stashRef: "stash@{0}",
    droppedRedundant: false,
    conflictsResolved: [],
  };
}

/**
 * Files changed in a worktree vs its upstream merge-base (plus uncommitted).
 * Used for plan-progress when OpenCode session status is empty after timeouts.
 */
export function listWorktreeChangedFiles(worktreePath: string): string[] {
  if (!existsSync(worktreePath)) return [];
  const paths = new Set<string>(listUncommitted(worktreePath));

  const staged = runGitAllowFail(worktreePath, ["diff", "--name-only", "--cached"]);
  if (staged.ok) {
    for (const p of staged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      paths.add(p);
    }
  }

  const unstaged = runGitAllowFail(worktreePath, ["diff", "--name-only"]);
  if (unstaged.ok) {
    for (const p of unstaged.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
      paths.add(p);
    }
  }

  // Commits on this branch not in main/master (when those refs exist)
  for (const base of ["main", "master"]) {
    const baseOk = runGitAllowFail(worktreePath, ["rev-parse", "--verify", base]);
    if (!baseOk.ok) continue;
    const mergeBase = runGitAllowFail(worktreePath, ["merge-base", base, "HEAD"]);
    if (!mergeBase.ok || !mergeBase.stdout.trim()) continue;
    const vsBase = runGitAllowFail(worktreePath, [
      "diff",
      "--name-only",
      `${mergeBase.stdout.trim()}...HEAD`,
    ]);
    if (vsBase.ok) {
      for (const p of vsBase.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        paths.add(p);
      }
    }
    break;
  }

  return [...paths].filter(Boolean);
}

/**
 * List phase worktrees under ~/.slopcontrol/worktrees/<projectId>/.
 * Optionally include known phaseIds that do not have a worktree yet.
 */
export function listPhaseWorktrees(opts: {
  projectId: string;
  dataDir?: string;
  phaseIds?: string[];
}): PhaseWorktreeInfo[] {
  const dataDir = opts.dataDir ?? join(homedir(), ".slopcontrol");
  const root = join(dataDir, "worktrees", opts.projectId);
  const discovered = new Set<string>(opts.phaseIds ?? []);

  if (existsSync(root)) {
    try {
      for (const name of readdirSync(root)) {
        const full = join(root, name);
        try {
          if (statSync(full).isDirectory()) discovered.add(name);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  const phaseIds = [...discovered].sort();
  return phaseIds.map((phaseId) => {
    const path = phaseWorktreePath({
      projectId: opts.projectId,
      phaseId,
      dataDir,
    });
    const branch = phaseBranchName(phaseId);
    const exists =
      existsSync(path) &&
      (existsSync(join(path, ".git")) || existsSync(path));

    if (!exists) {
      return {
        phaseId,
        path,
        branch,
        exists: false,
        headCommit: null,
        dirty: false,
        uncommittedFiles: [],
      };
    }

    const head = runGitAllowFail(path, ["rev-parse", "HEAD"]);
    const uncommittedFiles = listUncommitted(path);
    return {
      phaseId,
      path,
      branch,
      exists: true,
      headCommit: head.ok ? head.stdout : null,
      dirty: uncommittedFiles.length > 0,
      uncommittedFiles,
    };
  });
}

/** True when a merge (or similar) is in progress and needs a concluding commit. */
export function hasMergeInProgress(projectRoot: string): boolean {
  const mergeHead = runGitAllowFail(projectRoot, [
    "rev-parse",
    "-q",
    "--verify",
    "MERGE_HEAD",
  ]);
  return mergeHead.ok && Boolean(mergeHead.stdout);
}

export function listConflictedPaths(projectRoot: string): string[] {
  const conflicts = runGitAllowFail(projectRoot, [
    "diff",
    "--name-only",
    "--diff-filter=U",
  ]);
  if (!conflicts.ok) return [];
  return conflicts.stdout.split("\n").filter(Boolean);
}

export function listConflicts(projectRoot: string): ConflictFileInfo[] {
  const paths = listConflictedPaths(projectRoot);
  if (paths.length === 0) return [];

  const unmerged = runGitAllowFail(projectRoot, ["ls-files", "-u"]);
  const stagesByPath = new Map<string, Set<number>>();
  if (unmerged.ok) {
    for (const line of unmerged.stdout.split("\n").filter(Boolean)) {
      // <mode> <object> <stage>\t<path>
      const tab = line.indexOf("\t");
      const meta = tab >= 0 ? line.slice(0, tab) : line;
      const path = tab >= 0 ? line.slice(tab + 1) : "";
      const parts = meta.split(/\s+/);
      if (parts.length < 3 || !path) continue;
      const stage = Number(parts[2]);
      if (!stagesByPath.has(path)) stagesByPath.set(path, new Set());
      if (Number.isFinite(stage)) stagesByPath.get(path)!.add(stage);
    }
  }

  return paths.map((path) => ({
    path,
    stages: [...(stagesByPath.get(path) ?? [])].sort((a, b) => a - b),
  }));
}

function pathExistsOnRef(
  projectRoot: string,
  ref: string,
  filePath: string,
): boolean {
  const probe = runGitAllowFail(projectRoot, [
    "cat-file",
    "-e",
    `${ref}:${filePath}`,
  ]);
  return probe.ok;
}

function checkoutSide(
  projectRoot: string,
  side: "ours" | "theirs",
  filePath: string,
): boolean {
  const co = runGitAllowFail(projectRoot, [
    "checkout",
    `--${side}`,
    "--",
    filePath,
  ]);
  if (!co.ok) return false;
  const add = runGitAllowFail(projectRoot, ["add", "--", filePath]);
  return add.ok;
}

function takeBlobFromRef(
  projectRoot: string,
  ref: string,
  filePath: string,
): boolean {
  const show = runGitAllowFail(projectRoot, ["show", `${ref}:${filePath}`]);
  if (!show.ok) return false;
  const abs = join(projectRoot, filePath);
  mkdirSync(dirname(abs), { recursive: true });
  // git show stdout is already trimmed by runGitAllowFail — preserve trailing newline
  // by re-fetching with a raw exec for content fidelity when needed.
  try {
    const raw = execFileSync("git", ["show", `${ref}:${filePath}`], {
      cwd: projectRoot,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    writeFileSync(abs, raw);
  } catch {
    writeFileSync(abs, show.stdout.endsWith("\n") ? show.stdout : `${show.stdout}\n`);
  }
  const add = runGitAllowFail(projectRoot, ["add", "--", filePath]);
  return add.ok;
}

/**
 * Resolve unmerged paths in the project root.
 *
 * Strategies:
 * - `ours` / `theirs` — git checkout --ours/--theirs
 * - `phase` — take blob from `slop/<phaseId>` when present, else ours
 * - `auto` (default):
 *   - during an in-progress merge → prefer phase / theirs (incoming phase work)
 *   - after stash-pop conflicts (no MERGE_HEAD) → prefer phase blob if the file
 *     exists on the phase branch, otherwise ours ("Updated upstream")
 */
export function resolveConflicts(opts: {
  projectRoot: string;
  strategy?: ConflictStrategy;
  phaseId?: string;
  /** Limit resolution to these paths (default: all unmerged) */
  paths?: string[];
  /** When a merge is in progress and all conflicts clear, create the merge commit */
  continueMerge?: boolean;
}): ResolveConflictsResult {
  if (!isGitRepo(opts.projectRoot)) {
    throw new Error(`Project root is not a git repository: ${opts.projectRoot}`);
  }

  const strategy = opts.strategy ?? "auto";
  const phaseBranch = opts.phaseId ? phaseBranchName(opts.phaseId) : null;
  const inMerge = hasMergeInProgress(opts.projectRoot);
  const targets = opts.paths?.length
    ? opts.paths
    : listConflictedPaths(opts.projectRoot);

  if (targets.length === 0) {
    return {
      ok: true,
      strategy,
      resolved: [],
      remaining: [],
      mergeContinued: false,
      message: "No conflicted files.",
    };
  }

  const resolved: string[] = [];
  for (const filePath of targets) {
    let ok = false;

    if (strategy === "ours") {
      ok = checkoutSide(opts.projectRoot, "ours", filePath);
    } else if (strategy === "theirs") {
      ok = checkoutSide(opts.projectRoot, "theirs", filePath);
    } else if (strategy === "phase") {
      if (phaseBranch && pathExistsOnRef(opts.projectRoot, phaseBranch, filePath)) {
        ok = takeBlobFromRef(opts.projectRoot, phaseBranch, filePath);
      } else {
        ok = checkoutSide(opts.projectRoot, inMerge ? "theirs" : "ours", filePath);
      }
    } else {
      // auto
      if (inMerge) {
        if (phaseBranch && pathExistsOnRef(opts.projectRoot, phaseBranch, filePath)) {
          ok = takeBlobFromRef(opts.projectRoot, phaseBranch, filePath);
        } else {
          ok = checkoutSide(opts.projectRoot, "theirs", filePath);
        }
      } else if (
        phaseBranch &&
        pathExistsOnRef(opts.projectRoot, phaseBranch, filePath)
      ) {
        ok = takeBlobFromRef(opts.projectRoot, phaseBranch, filePath);
      } else {
        // Stash-pop: "Updated upstream" is ours (post-merge phase result)
        ok = checkoutSide(opts.projectRoot, "ours", filePath);
      }
    }

    if (ok) resolved.push(filePath);
  }

  const remaining = listConflictedPaths(opts.projectRoot);
  let mergeContinued = false;
  const shouldContinue = opts.continueMerge !== false && inMerge;

  if (shouldContinue && remaining.length === 0 && hasMergeInProgress(opts.projectRoot)) {
    const commit = runGitAllowFail(opts.projectRoot, [
      "-c",
      "user.email=slopcontrol@local",
      "-c",
      "user.name=SlopControl",
      "commit",
      "--no-edit",
    ]);
    mergeContinued = commit.ok;
  }

  const ok = remaining.length === 0;
  return {
    ok,
    strategy,
    resolved,
    remaining,
    mergeContinued,
    message: ok
      ? `Resolved ${resolved.length} conflict(s) with strategy=${strategy}${
          mergeContinued ? " and completed the merge commit" : ""
        }.`
      : `Resolved ${resolved.length} conflict(s); ${remaining.length} remain: ${remaining.join(", ")}`,
  };
}

/**
 * Commit any dirty files in the phase worktree, then merge `slop/<phaseId>`
 * into the project root's target branch (default: current branch).
 *
 * Operator/product dirty files are stashed (including untracked) before merge.
 * `.slopcontrol/**` is handled separately: tracked mods are stashed without
 * `--include-untracked`; untracked paths that exist on the phase branch are
 * removed so git does not refuse the merge ("would be overwritten").
 * Real content conflicts use prefer_phase; stash-pop conflicts prefer phase /
 * post-merge content; redundant untracked stashes are dropped.
 */
export function mergePhaseWorktree(opts: {
  projectRoot: string;
  projectId: string;
  phaseId: string;
  dataDir?: string;
  /** Defaults to current branch at projectRoot */
  targetBranch?: string;
  commitMessage?: string;
  /** Remove the worktree directory after a successful merge */
  removeWorktree?: boolean;
  /**
   * When true (default), stash dirty project-root files before merge and
   * restore after. When false, refuse if the project root is dirty.
   */
  stashDirty?: boolean;
  /**
   * How to handle git merge conflicts with the phase branch.
   * - `prefer_phase` (default): take phase / theirs, continue merge
   * - `abort`: abort the merge and restore stash (previous behavior)
   */
  conflictStrategy?: "prefer_phase" | "abort";
}): MergePhaseWorktreeResult {
  const dataDir = opts.dataDir ?? join(homedir(), ".slopcontrol");
  const stashDirty = opts.stashDirty !== false;
  const conflictStrategy = opts.conflictStrategy ?? "prefer_phase";
  const worktreePath = phaseWorktreePath({
    projectId: opts.projectId,
    phaseId: opts.phaseId,
    dataDir,
  });
  const branch = phaseBranchName(opts.phaseId);
  let conflictsResolved: string[] = [];

  if (!isGitRepo(opts.projectRoot)) {
    throw new Error(`Project root is not a git repository: ${opts.projectRoot}`);
  }
  assertProjectGitRoot(opts.projectRoot);
  if (!existsSync(worktreePath)) {
    throw new Error(
      `No worktree for phase ${opts.phaseId} at ${worktreePath}. Run development first.`,
    );
  }

  // Ensure worktree is on the expected branch
  const headBranch = runGitAllowFail(worktreePath, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (headBranch.ok && headBranch.stdout !== branch) {
    runGit(worktreePath, ["checkout", "-B", branch]);
  }

  let committedInWorktree = false;
  const commitMessage =
    opts.commitMessage?.trim() ||
    `slopcontrol: merge phase ${opts.phaseId}`;

  const dirty = listUncommitted(worktreePath);
  if (dirty.length > 0) {
    runGit(worktreePath, ["add", "-A"]);
    runGit(worktreePath, [
      "-c",
      "user.email=slopcontrol@local",
      "-c",
      "user.name=SlopControl",
      "commit",
      "-m",
      commitMessage,
    ]);
    committedInWorktree = true;
  }

  const current = runGit(opts.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const targetBranch = opts.targetBranch?.trim() || current;

  if (targetBranch === branch) {
    throw new Error(
      `Cannot merge ${branch} into itself. Check out main (or another branch) in ${opts.projectRoot} first.`,
    );
  }

  const rootResolved = runGit(opts.projectRoot, ["rev-parse", "--show-toplevel"]);
  const wtResolved = runGit(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (rootResolved === wtResolved) {
    throw new Error(
      "Refusing to merge: projectRoot resolves to the same worktree path. Use the main project directory.",
    );
  }
  if (resolveStablePath(rootResolved) !== resolveStablePath(opts.projectRoot)) {
    throw new Error(
      `Refusing to merge: projectRoot ${opts.projectRoot} is not the git toplevel (${rootResolved}).`,
    );
  }

  // Idempotent: phase already on target — skip stash/merge (avoids re-stash loops).
  const alreadyMerged = runGitAllowFail(opts.projectRoot, [
    "merge-base",
    "--is-ancestor",
    branch,
    targetBranch,
  ]);
  if (alreadyMerged.ok) {
    const targetTip = runGit(opts.projectRoot, ["rev-parse", targetBranch]);
    let removedWorktree = false;
    if (opts.removeWorktree) {
      const rm = runGitAllowFail(opts.projectRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      removedWorktree = rm.ok;
    }
    return {
      ok: true,
      phaseId: opts.phaseId,
      branch,
      worktreePath,
      targetBranch,
      committedInWorktree,
      commitMessage: committedInWorktree ? commitMessage : null,
      mergeCommit: targetTip,
      removedWorktree,
      stashedRoot: false,
      stashRestored: true,
      stashRef: null,
      message: [
        committedInWorktree
          ? `Committed worktree changes; ${branch} already present on ${targetBranch} (${targetTip.slice(0, 8)}).`
          : `Phase branch ${branch} already merged into ${targetBranch} (${targetTip.slice(0, 8)}).`,
        removedWorktree ? "Removed phase worktree." : null,
      ]
        .filter(Boolean)
        .join(" "),
    };
  }

  let stashedRoot = false;
  let stashRestored = false;
  let stashRef: string | null = null;
  let droppedRedundantStash = false;
  let stashedSlopcontrol = false;
  let slopStashRestored = true;
  let slopStashRef: string | null = null;
  let clearedSlopcontrolPaths: string[] = [];
  let clearanceRan = false;

  const restoreAllStashes = (): void => {
    // LIFO: tracked .slopcontrol stash is newer than operator stash
    if (stashedSlopcontrol) {
      const restored = restoreStashAfterGitOp({
        projectRoot: opts.projectRoot,
        phaseId: opts.phaseId,
      });
      slopStashRestored = restored.stashRestored;
      slopStashRef = restored.stashRef;
      conflictsResolved = [...conflictsResolved, ...restored.conflictsResolved];
    }
    if (stashedRoot) {
      const restored = restoreStashAfterGitOp({
        projectRoot: opts.projectRoot,
        phaseId: opts.phaseId,
      });
      stashRestored = restored.stashRestored;
      stashRef = restored.stashRef;
      droppedRedundantStash = restored.droppedRedundant;
      conflictsResolved = [...conflictsResolved, ...restored.conflictsResolved];
    }
  };

  const runClearance = (): void => {
    const cleared = clearSlopcontrolMergeBlockers(
      opts.projectRoot,
      branch,
      opts.phaseId,
    );
    clearanceRan = true;
    if (cleared.clearedUntracked.length > 0) {
      clearedSlopcontrolPaths = [
        ...clearedSlopcontrolPaths,
        ...cleared.clearedUntracked,
      ];
    }
    if (cleared.stashedTracked) {
      stashedSlopcontrol = true;
      slopStashRef = cleared.stashRef;
      slopStashRestored = false;
    }
  };

  const rootDirty = listUncommitted(opts.projectRoot);
  const { operatorDirty } = partitionDirtyPaths(rootDirty);
  if (operatorDirty.length > 0) {
    if (!stashDirty) {
      throw new Error(
        `Project root has uncommitted changes; commit/stash them or pass stashDirty=true:\n${operatorDirty.slice(0, 20).join("\n")}`,
      );
    }
    const stashMsg = `slopcontrol: pre-merge stash for ${opts.phaseId}`;
    const stash = stashOperatorDirty(opts.projectRoot, stashMsg, operatorDirty);
    if (!stash.ok) {
      throw new Error(
        `Failed to stash project-root changes before merge: ${stash.stderr}`,
      );
    }
    stashedRoot = true;
    stashRef = stash.stashRef;
  }

  if (current !== targetBranch) {
    const co = runGitAllowFail(opts.projectRoot, ["checkout", targetBranch]);
    if (!co.ok) {
      if (stashedRoot) {
        runGitAllowFail(opts.projectRoot, ["stash", "pop"]);
      }
      throw new Error(
        `Could not checkout target branch ${targetBranch}: ${co.stderr || co.stdout}`,
      );
    }
  }

  // Clear .slopcontrol overwrite blockers before the first merge attempt
  runClearance();

  const mergeArgs = [
    "merge",
    "--no-ff",
    "-m",
    `Merge phase ${opts.phaseId} (${branch}) into ${targetBranch}`,
    branch,
  ];

  let merge = runGitAllowFail(opts.projectRoot, mergeArgs);
  let mergeOutput = [merge.stdout, merge.stderr].filter(Boolean).join("\n");

  // One retry: if still blocked by overwrite after clearance, clear again and retry
  if (!merge.ok && isOverwriteMergeFailure(mergeOutput)) {
    runGitAllowFail(opts.projectRoot, ["merge", "--abort"]);
    runClearance();
    merge = runGitAllowFail(opts.projectRoot, mergeArgs);
    mergeOutput = [merge.stdout, merge.stderr].filter(Boolean).join("\n");
  }

  if (!merge.ok) {
    const conflictPaths = listConflictedPaths(opts.projectRoot);
    const overwrite = isOverwriteMergeFailure(mergeOutput);
    const failureKind: "overwrite" | "conflict" | "other" =
      conflictPaths.length > 0 ? "conflict" : overwrite ? "overwrite" : "other";

    if (conflictStrategy === "prefer_phase" && conflictPaths.length > 0) {
      const resolved = resolveConflicts({
        projectRoot: opts.projectRoot,
        strategy: "phase",
        phaseId: opts.phaseId,
        continueMerge: true,
      });
      conflictsResolved = resolved.resolved;
      if (!resolved.ok || !resolved.mergeContinued) {
        runGitAllowFail(opts.projectRoot, ["merge", "--abort"]);
        restoreAllStashes();
        return {
          ok: false,
          phaseId: opts.phaseId,
          branch,
          worktreePath,
          targetBranch,
          committedInWorktree,
          commitMessage: committedInWorktree ? commitMessage : null,
          mergeCommit: null,
          removedWorktree: false,
          stashedRoot: stashedRoot || stashedSlopcontrol,
          stashRestored: stashRestored && slopStashRestored,
          stashRef: !stashRestored
            ? stashRef
            : !slopStashRestored
              ? slopStashRef
              : null,
          conflictsResolved,
          clearedSlopcontrolPaths: clearedSlopcontrolPaths.length
            ? clearedSlopcontrolPaths
            : undefined,
          mergeOutput,
          failureKind: "conflict",
          message: [
            `Merge conflict merging ${branch} into ${targetBranch}; auto-resolve incomplete.`,
            resolved.message,
            conflictPaths.length
              ? `Conflicted paths: ${conflictPaths.join(", ")}.`
              : null,
            (stashedRoot || stashedSlopcontrol) &&
            !(stashRestored && slopStashRestored)
              ? `Pre-merge stash kept — run: git stash pop or resolve_conflicts`
              : null,
          ]
            .filter(Boolean)
            .join(" "),
          conflicts: resolved.remaining.length
            ? resolved.remaining
            : conflictPaths,
        };
      }
      // fall through — merge completed via conflict resolution
    } else {
      runGitAllowFail(opts.projectRoot, ["merge", "--abort"]);
      restoreAllStashes();
      const blockedHint = overwrite
        ? [
            `Merge blocked by dirty/untracked paths that would be overwritten merging ${branch} into ${targetBranch}.`,
            clearedSlopcontrolPaths.length
              ? `Cleared untracked .slopcontrol paths before retry: ${clearedSlopcontrolPaths.slice(0, 12).join(", ")}${clearedSlopcontrolPaths.length > 12 ? "…" : ""}.`
              : clearanceRan
                ? "Pre-merge .slopcontrol clearance ran but merge still refused."
                : null,
            mergeOutput.trim().slice(0, 1200),
          ]
        : [
            conflictPaths.length > 0
              ? `Merge conflict merging ${branch} into ${targetBranch}. Merge aborted.`
              : `Merge failed merging ${branch} into ${targetBranch}. Merge aborted.`,
            conflictPaths.length
              ? `Conflicted paths: ${conflictPaths.join(", ")}.`
              : null,
            mergeOutput.trim().slice(0, 1200),
            "Use resolve_conflicts (strategy=phase|auto) after a manual merge if needed.",
          ];
      return {
        ok: false,
        phaseId: opts.phaseId,
        branch,
        worktreePath,
        targetBranch,
        committedInWorktree,
        commitMessage: committedInWorktree ? commitMessage : null,
        mergeCommit: null,
        removedWorktree: false,
        stashedRoot: stashedRoot || stashedSlopcontrol,
        stashRestored: stashRestored && slopStashRestored,
        stashRef: !stashRestored
          ? stashRef
          : !slopStashRestored
            ? slopStashRef
            : null,
        conflictsResolved: conflictsResolved.length
          ? conflictsResolved
          : undefined,
        clearedSlopcontrolPaths: clearedSlopcontrolPaths.length
          ? clearedSlopcontrolPaths
          : undefined,
        mergeOutput,
        failureKind,
        message: [
          ...blockedHint,
          (stashedRoot || stashedSlopcontrol) &&
          !(stashRestored && slopStashRestored)
            ? `Pre-merge stash kept — run: git stash pop`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        conflicts: conflictPaths.length ? conflictPaths : undefined,
      };
    }
  }

  const mergeCommit = runGit(opts.projectRoot, ["rev-parse", "HEAD"]);
  let removedWorktree = false;
  if (opts.removeWorktree) {
    const rm = runGitAllowFail(opts.projectRoot, [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    removedWorktree = rm.ok;
  }

  // Restore stashes LIFO (slopcontrol tracked, then operator)
  if (stashedSlopcontrol) {
    const restored = restoreStashAfterGitOp({
      projectRoot: opts.projectRoot,
      phaseId: opts.phaseId,
    });
    slopStashRestored = restored.stashRestored;
    slopStashRef = restored.stashRef;
    if (restored.droppedRedundant) droppedRedundantStash = true;
    conflictsResolved = [...conflictsResolved, ...restored.conflictsResolved];
  }
  if (stashedRoot) {
    const restored = restoreStashAfterGitOp({
      projectRoot: opts.projectRoot,
      phaseId: opts.phaseId,
    });
    stashRestored = restored.stashRestored;
    stashRef = restored.stashRef;
    if (restored.droppedRedundant) droppedRedundantStash = true;
    conflictsResolved = [...conflictsResolved, ...restored.conflictsResolved];
  } else if (stashedSlopcontrol) {
    // Operator stash was not used; surface slop stash restore as stashRestored
    stashRestored = slopStashRestored;
    stashRef = slopStashRef;
    stashedRoot = true;
  }

  const anyStashed = stashedRoot || stashedSlopcontrol;
  const allRestored =
    (!stashedRoot || stashRestored) &&
    (!stashedSlopcontrol || slopStashRestored);

  const parts = [
    committedInWorktree
      ? `Committed worktree changes and merged ${branch} into ${targetBranch} (${mergeCommit.slice(0, 8)}).`
      : `Merged ${branch} into ${targetBranch} (${mergeCommit.slice(0, 8)}).`,
    clearedSlopcontrolPaths.length
      ? `Cleared untracked .slopcontrol merge blockers: ${clearedSlopcontrolPaths.slice(0, 8).join(", ")}${clearedSlopcontrolPaths.length > 8 ? "…" : ""}.`
      : null,
    conflictsResolved.length
      ? `Auto-resolved conflicts: ${conflictsResolved.join(", ")}.`
      : null,
    anyStashed && allRestored && droppedRedundantStash
      ? "Dropped redundant pre-merge stash (working tree already has those paths)."
      : null,
    anyStashed && allRestored && !droppedRedundantStash
      ? "Restored stashed project-root changes."
      : null,
    anyStashed && !allRestored
      ? `Pre-merge stash kept at ${stashRef ?? slopStashRef} (restore with: git stash pop or resolve_conflicts). Merge itself succeeded.`
      : null,
    removedWorktree ? `Removed phase worktree.` : null,
  ].filter(Boolean);

  return {
    ok: true,
    phaseId: opts.phaseId,
    branch,
    worktreePath,
    targetBranch,
    committedInWorktree,
    commitMessage: committedInWorktree ? commitMessage : null,
    mergeCommit,
    removedWorktree,
    stashedRoot: anyStashed,
    stashRestored: allRestored,
    stashRef: allRestored ? null : (stashRef ?? slopStashRef),
    conflictsResolved: conflictsResolved.length ? conflictsResolved : undefined,
    clearedSlopcontrolPaths: clearedSlopcontrolPaths.length
      ? clearedSlopcontrolPaths
      : undefined,
    message: parts.join(" "),
  };
}

export interface ProjectGitStatus {
  rootPath: string;
  currentBranch: string;
  headCommit: string | null;
  dirty: boolean;
  uncommittedFiles: string[];
  branches: string[];
  /** Local branches that look like phase worktrees (slop/*) */
  phaseBranches: string[];
}

/**
 * Report which branch is checked out in the project folder and list locals.
 */
export function getProjectGitStatus(projectRoot: string): ProjectGitStatus {
  if (!isGitRepo(projectRoot)) {
    throw new Error(`Project root is not a git repository: ${projectRoot}`);
  }
  const currentBranch = runGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = runGitAllowFail(projectRoot, ["rev-parse", "HEAD"]);
  const uncommittedFiles = listUncommitted(projectRoot);
  const branchList = runGitAllowFail(projectRoot, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/",
  ]);
  const branches = branchList.ok
    ? branchList.stdout.split("\n").map((b) => b.trim()).filter(Boolean)
    : [];
  return {
    rootPath: projectRoot,
    currentBranch,
    headCommit: head.ok ? head.stdout : null,
    dirty: uncommittedFiles.length > 0,
    uncommittedFiles,
    branches,
    phaseBranches: branches.filter((b) => b.startsWith("slop/")),
  };
}

export interface CheckoutProjectBranchResult {
  ok: boolean;
  previousBranch: string;
  branch: string;
  created: boolean;
  stashed: boolean;
  stashRestored: boolean;
  stashRef: string | null;
  message: string;
}

/**
 * Check out a branch in the project folder (not a phase worktree).
 * Optionally create the branch and stash dirty files first.
 */
export function checkoutProjectBranch(opts: {
  projectRoot: string;
  branch: string;
  /** Create branch from HEAD if it does not exist */
  create?: boolean;
  /** Stash dirty files before checkout (default true) */
  stashDirty?: boolean;
}): CheckoutProjectBranchResult {
  if (!isGitRepo(opts.projectRoot)) {
    throw new Error(`Project root is not a git repository: ${opts.projectRoot}`);
  }
  const branch = opts.branch.trim();
  if (!branch || branch.includes("..") || /[\s~^:?*\[\]]/.test(branch)) {
    throw new Error(`Invalid branch name: ${opts.branch}`);
  }

  const previousBranch = runGit(opts.projectRoot, [
    "rev-parse",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (previousBranch === branch) {
    return {
      ok: true,
      previousBranch,
      branch,
      created: false,
      stashed: false,
      stashRestored: false,
      stashRef: null,
      message: `Already on ${branch}.`,
    };
  }

  const stashDirty = opts.stashDirty !== false;
  let stashed = false;
  let stashRestored = false;
  let stashRef: string | null = null;
  let droppedRedundantStash = false;

  const dirty = listUncommitted(opts.projectRoot);
  const { operatorDirty } = partitionDirtyPaths(dirty);
  if (operatorDirty.length > 0) {
    if (!stashDirty) {
      throw new Error(
        `Project root has uncommitted changes; commit/stash them or pass stashDirty=true:\n${operatorDirty.slice(0, 20).join("\n")}`,
      );
    }
    const stash = stashOperatorDirty(
      opts.projectRoot,
      `slopcontrol: pre-checkout stash for ${branch}`,
      operatorDirty,
    );
    if (!stash.ok) {
      throw new Error(`Failed to stash before checkout: ${stash.stderr}`);
    }
    stashed = true;
    stashRef = stash.stashRef;
  }

  const exists = runGitAllowFail(opts.projectRoot, [
    "show-ref",
    "--verify",
    "--quiet",
    `refs/heads/${branch}`,
  ]);
  let created = false;
  let co: { ok: boolean; stdout: string; stderr: string };
  if (exists.ok) {
    co = runGitAllowFail(opts.projectRoot, ["checkout", branch]);
  } else if (opts.create) {
    co = runGitAllowFail(opts.projectRoot, ["checkout", "-b", branch]);
    created = co.ok;
  } else {
    if (stashed) {
      runGitAllowFail(opts.projectRoot, ["stash", "pop"]);
    }
    throw new Error(
      `Branch ${branch} does not exist. Pass create=true to create it from HEAD.`,
    );
  }

  if (!co.ok) {
    if (stashed) {
      const restored = restoreStashAfterGitOp({ projectRoot: opts.projectRoot });
      stashRestored = restored.stashRestored;
      stashRef = restored.stashRef;
    }
    throw new Error(
      `Could not checkout ${branch}: ${co.stderr || co.stdout}`,
    );
  }

  if (stashed) {
    const restored = restoreStashAfterGitOp({ projectRoot: opts.projectRoot });
    stashRestored = restored.stashRestored;
    stashRef = restored.stashRef;
    droppedRedundantStash = restored.droppedRedundant;
  }

  return {
    ok: true,
    previousBranch,
    branch,
    created,
    stashed,
    stashRestored,
    stashRef: stashRestored ? null : stashRef,
    message: [
      created
        ? `Created and checked out ${branch} (was ${previousBranch}).`
        : `Checked out ${branch} (was ${previousBranch}).`,
      stashed && stashRestored && droppedRedundantStash
        ? "Dropped redundant pre-checkout stash (working tree already has those paths)."
        : null,
      stashed && stashRestored && !droppedRedundantStash
        ? "Restored stashed changes."
        : null,
      stashed && !stashRestored
        ? `Pre-checkout stash kept at ${stashRef} — run: git stash pop`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}

export interface RemovePhaseWorktreeResult {
  ok: boolean;
  phaseId: string;
  branch: string;
  worktreePath: string;
  removedWorktree: boolean;
  deletedBranch: boolean;
  message: string;
}

/**
 * Remove a phase worktree directory (and optionally its local branch).
 * Safe when the worktree was already removed; still attempts branch delete.
 */
export function removePhaseWorktree(opts: {
  projectRoot: string;
  projectId: string;
  phaseId: string;
  dataDir?: string;
  /** Delete local branch slop/<phaseId> after removing the worktree */
  deleteBranch?: boolean;
}): RemovePhaseWorktreeResult {
  if (!isGitRepo(opts.projectRoot)) {
    throw new Error(`Project root is not a git repository: ${opts.projectRoot}`);
  }
  const dataDir = opts.dataDir ?? join(homedir(), ".slopcontrol");
  const worktreePath = phaseWorktreePath({
    projectId: opts.projectId,
    phaseId: opts.phaseId,
    dataDir,
  });
  const branch = phaseBranchName(opts.phaseId);

  let removedWorktree = false;
  if (existsSync(worktreePath)) {
    const rm = runGitAllowFail(opts.projectRoot, [
      "worktree",
      "remove",
      "--force",
      worktreePath,
    ]);
    removedWorktree = rm.ok;
    if (!rm.ok) {
      // Fallback: prune + force-remove directory via git worktree prune
      runGitAllowFail(opts.projectRoot, ["worktree", "prune"]);
      const rm2 = runGitAllowFail(opts.projectRoot, [
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      removedWorktree = rm2.ok;
      if (!rm2.ok && existsSync(worktreePath)) {
        throw new Error(
          `Failed to remove worktree at ${worktreePath}: ${rm2.stderr || rm.stderr || rm.stdout}`,
        );
      }
      // Directory may already be gone after prune of broken registration
      if (!existsSync(worktreePath)) removedWorktree = true;
    }
  } else {
    runGitAllowFail(opts.projectRoot, ["worktree", "prune"]);
  }

  let deletedBranch = false;
  if (opts.deleteBranch) {
    const current = runGit(opts.projectRoot, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    if (current === branch) {
      throw new Error(
        `Cannot delete branch ${branch} while it is checked out in the project folder. Checkout main (or another branch) first.`,
      );
    }
    const del = runGitAllowFail(opts.projectRoot, ["branch", "-D", branch]);
    deletedBranch = del.ok;
  }

  return {
    ok: true,
    phaseId: opts.phaseId,
    branch,
    worktreePath,
    removedWorktree: removedWorktree || !existsSync(worktreePath),
    deletedBranch,
    message: [
      removedWorktree || !existsSync(worktreePath)
        ? `Removed worktree for ${opts.phaseId}.`
        : `No worktree directory at ${worktreePath}.`,
      deletedBranch ? `Deleted branch ${branch}.` : null,
      opts.deleteBranch && !deletedBranch
        ? `Branch ${branch} was not deleted (missing or in use).`
        : null,
    ]
      .filter(Boolean)
      .join(" "),
  };
}
