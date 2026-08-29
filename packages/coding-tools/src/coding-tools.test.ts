import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  checkoutProjectBranch,
  ensureGitInitialized,
  ensurePhaseWorktree,
  getGitToplevel,
  getProjectGitStatus,
  isGitRepositoryRoot,
  isOverwriteMergeFailure,
  listConflictedPaths,
  listPhaseWorktrees,
  mergePhaseWorktree,
  removePhaseWorktree,
  resolveConflicts,
  syncLocalFilesFromWorktree,
  syncLocalFilesToWorktree,
  syncPhaseArtifactsToWorktree,
  syncIgnoredArtifactsFromWorktree,
} from "./git-worktree.js";
import { toOpenCodeModel } from "./opencode-adapter.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@local",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@local",
    },
  }).trim();
}

describe("@slopcontrol/coding-tools", () => {
  it("maps prefixed model ids to OpenCode provider/model", () => {
    const model = toOpenCodeModel(
      {
        id: "vercel-glm",
        baseUrl: "https://ai-gateway.vercel.ai/v1",
        apiType: "openai-chat",
        modelId: "zai/glm-5.2",
      },
      undefined,
    );

    assert.deepEqual(model, { providerID: "zai", modelID: "glm-5.2" });
  });

  it("maps ollama-cloud slash ids for OpenCode", () => {
    const model = toOpenCodeModel(
      {
        id: "oc-glm",
        baseUrl: "https://ollama.com/v1",
        apiType: "openai-chat",
        modelId: "ollama-cloud/glm-5.2",
      },
      undefined,
    );
    assert.deepEqual(model, {
      providerID: "ollama-cloud",
      modelID: "glm-5.2",
    });
  });

  it("maps glm-5.2:cloud on ollama.com to ollama-cloud/glm-5.2", () => {
    const model = toOpenCodeModel(
      {
        id: "ollama-cloud-glm",
        baseUrl: "https://ollama.com/v1",
        apiType: "openai-chat",
        modelId: "glm-5.2:cloud",
      },
      undefined,
    );
    assert.deepEqual(model, {
      providerID: "ollama-cloud",
      modelID: "glm-5.2",
    });
  });

  it("maps plain model ids using apiType", () => {
    const model = toOpenCodeModel(
      {
        id: "local-ollama",
        baseUrl: "http://localhost:11434/v1",
        apiType: "openai-chat",
        modelId: "llama3.2",
      },
      "qwen2.5-coder",
    );
    assert.deepEqual(model, { providerID: "ollama", modelID: "qwen2.5-coder" });
  });

  it("syncPhaseArtifactsToWorktree writes root PHASE.md pointer only", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-phase-sync-root-"));
    const worktreePath = mkdtempSync(join(tmpdir(), "slop-phase-sync-wt-"));
    try {
      const phaseId = "30-host-docker-internal";
      const fullPlan = `# Phase ${phaseId}

## Scope

Full prior-phase plan that must not land at worktree root.

## File Changes

- compose.yml

## Success Criteria

- Done

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      mkdirSync(join(projectRoot, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        fullPlan,
        "utf-8",
      );
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "RESEARCH.md"),
        "# Research\n\nNotes.\n",
        "utf-8",
      );
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "UI-SPEC.md"),
        "# UI-SPEC\n\n## Palette\n#111\n",
        "utf-8",
      );
      mkdirSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "design"),
        { recursive: true },
      );
      writeFileSync(
        join(
          projectRoot,
          ".slopcontrol",
          "phases",
          phaseId,
          "design",
          "tokens.css",
        ),
        ":root { --brand: #111; }\n",
        "utf-8",
      );
      writeFileSync(
        join(
          projectRoot,
          ".slopcontrol",
          "phases",
          phaseId,
          "design",
          "logo.svg",
        ),
        "<svg/>\n",
        "utf-8",
      );

      const synced = syncPhaseArtifactsToWorktree({
        projectRoot,
        worktreePath,
        phaseId,
      });

      assert.ok(
        synced.includes(`.slopcontrol/phases/${phaseId}/PHASE.md`),
      );
      assert.ok(synced.includes("PHASE.md"));
      assert.ok(
        synced.includes(`.slopcontrol/phases/${phaseId}/UI-SPEC.md`),
      );
      assert.ok(
        synced.includes(
          `.slopcontrol/phases/${phaseId}/design/tokens.css`,
        ),
      );
      assert.ok(
        synced.includes(`.slopcontrol/phases/${phaseId}/design/logo.svg`),
      );

      const canonical = readFileSync(
        join(worktreePath, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        "utf-8",
      );
      assert.match(canonical, /Full prior-phase plan/);

      const uiSpec = readFileSync(
        join(worktreePath, ".slopcontrol", "phases", phaseId, "UI-SPEC.md"),
        "utf-8",
      );
      assert.match(uiSpec, /UI-SPEC/);

      const tokens = readFileSync(
        join(
          worktreePath,
          ".slopcontrol",
          "phases",
          phaseId,
          "design",
          "tokens.css",
        ),
        "utf-8",
      );
      assert.match(tokens, /--brand/);

      const rootPhase = readFileSync(join(worktreePath, "PHASE.md"), "utf-8");
      assert.match(rootPhase, /See `\.slopcontrol\/phases\//);
      assert.doesNotMatch(rootPhase, /Full prior-phase plan/);
      assert.doesNotMatch(rootPhase, /## Scope/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("syncPhaseArtifactsToWorktree preserves divergent worktree PHASE when asked", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "slop-phase-preserve-root-"));
    const worktreePath = mkdtempSync(join(tmpdir(), "slop-phase-preserve-wt-"));
    try {
      const phaseId = "31-model-passthrough";
      const canonical = `# Phase ${phaseId}

## Scope

Broken checks with trailing backslash.

## File Changes

- a.ts

## Success Criteria

ok

## Automated Checks

\`\`\`bash
npm test && \\
\`\`\`

## Blueprint Deltas

None.
`;
      const fixed = `# Phase ${phaseId}

## Scope

Fixed checks.

## File Changes

- a.ts

## Success Criteria

ok

## Automated Checks

\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas

None.
`;
      mkdirSync(join(projectRoot, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(projectRoot, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        canonical,
        "utf-8",
      );
      mkdirSync(join(worktreePath, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(
        join(worktreePath, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        fixed,
        "utf-8",
      );

      syncPhaseArtifactsToWorktree({
        projectRoot,
        worktreePath,
        phaseId,
        preserveWorktreeEdits: true,
      });

      const kept = readFileSync(
        join(worktreePath, ".slopcontrol", "phases", phaseId, "PHASE.md"),
        "utf-8",
      );
      assert.match(kept, /Fixed checks/);
      assert.doesNotMatch(kept, /trailing backslash/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreePath, { recursive: true, force: true });
    }
  });

  it("lists and merges a phase worktree into the project root", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-1";
      const phaseId = "03-manage-scripts";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      assert.ok(existsSync(wt.path));

      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");
      writeFileSync(
        join(wt.path, "package.json"),
        JSON.stringify({ name: "demo", scripts: { manage: "tsx scripts/cli.ts" } }, null, 2),
      );

      const listed = listPhaseWorktrees({ projectId, dataDir, phaseIds: [phaseId] });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.dirty, true);
      assert.ok(listed[0]!.uncommittedFiles.some((f) => f.includes("scripts")));

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: manage cli",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.committedInWorktree, true);
      assert.ok(existsSync(join(root, "scripts", "cli.ts")));
      assert.match(readFileSync(join(root, "package.json"), "utf-8"), /manage/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("mergePhaseWorktree never commits a node_modules symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-nm-root-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-wt-nm-data-"));
    const real = mkdtempSync(join(tmpdir(), "slop-wt-nm-real-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      writeFileSync(join(root, ".gitignore"), "node_modules/\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-nm";
      const phaseId = "01-symlink";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });

      // Coding agent symlinks the main tree's node_modules into the worktree.
      mkdirSync(join(real, "node_modules"), { recursive: true });
      symlinkSync(join(real, "node_modules"), join(wt.path, "node_modules"));
      writeFileSync(join(wt.path, "app.ts"), "export const n = 1;\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: app",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.ok(existsSync(join(root, "app.ts")));

      // The symlink must not be tracked on main.
      const tracked = git(root, ["ls-files", "--", "node_modules"]);
      assert.equal(tracked, "", "node_modules symlink must not be committed");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it("ensurePhaseWorktree initializes empty non-git project roots", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-empty-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-empty-"));
    try {
      writeFileSync(join(root, "README.md"), "# greenfield\n");
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId: "proj-empty",
        phaseId: "01-scaffold",
        dataDir,
      });
      assert.ok(existsSync(wt.path));
      assert.ok(existsSync(join(root, ".git")));
      // HEAD must exist after ensureGitInitialized
      execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("ensureGitInitialized creates nested .git under a foreign parent repo", () => {
    const parent = mkdtempSync(join(tmpdir(), "slop-parent-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-nested-"));
    const project = join(parent, "my-app");
    try {
      git(parent, ["init"]);
      git(parent, ["checkout", "-b", "main"]);
      writeFileSync(join(parent, "ROOT.md"), "# parent\n");
      git(parent, ["add", "-A"]);
      git(parent, ["commit", "-m", "parent init"]);

      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, "README.md"), "# nested app\n");

      // Nested folder is "inside" parent but not an owned root
      assert.equal(isGitRepositoryRoot(project), false);
      assert.equal(
        realpathSync(getGitToplevel(project)!),
        realpathSync(parent),
      );

      ensureGitInitialized(project);
      git(project, ["branch", "-M", "main"]);
      assert.ok(existsSync(join(project, ".git")));
      assert.equal(isGitRepositoryRoot(project), true);
      assert.equal(
        realpathSync(getGitToplevel(project)!),
        realpathSync(project),
      );

      const projectId = "proj-nested";
      const phaseId = "01-first";
      const wt = ensurePhaseWorktree({
        projectRoot: project,
        projectId,
        phaseId,
        dataDir,
      });
      writeFileSync(join(wt.path, "app.ts"), "export const n = 1;\n");

      const merged = mergePhaseWorktree({
        projectRoot: project,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: app",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.ok(existsSync(join(project, "app.ts")));
      // Must not land files on the parent toplevel
      assert.equal(existsSync(join(parent, "app.ts")), false);
      assert.equal(
        realpathSync(getGitToplevel(project)!),
        realpathSync(project),
      );

      // Idempotent re-merge when already on target
      const again = mergePhaseWorktree({
        projectRoot: project,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        removeWorktree: false,
      });
      assert.equal(again.ok, true, again.message);
      assert.match(again.message, /already merged/i);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stashes dirty project-root files before merge by default", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-dirty-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-dirty-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-dirty";
      const phaseId = "03-manage";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");

      // Dirty operator files in project root
      writeFileSync(join(root, "BLUEPRINT.md"), "# local dirty\n");
      writeFileSync(join(root, "scratch.txt"), "untracked\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: manage cli",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.stashedRoot, true);
      assert.equal(merged.stashRestored, true);
      assert.ok(existsSync(join(root, "scripts", "cli.ts")));
      assert.equal(readFileSync(join(root, "BLUEPRINT.md"), "utf-8"), "# local dirty\n");
      assert.equal(readFileSync(join(root, "scratch.txt"), "utf-8"), "untracked\n");
      assert.equal(git(root, ["stash", "list"]).trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("merges when only untracked .slopcontrol dirt is present on root", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-slopdirt-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-slopdirt-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-slopdirt";
      const phaseId = "03-manage";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");

      // Untracked orchestration artifacts on root (not on phase branch)
      mkdirSync(join(root, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "# bp\n");
      writeFileSync(
        join(root, ".slopcontrol", "phases", phaseId, "status.json"),
        '{"status":"developing"}\n',
      );

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: manage cli",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(git(root, ["stash", "list"]).trim(), "");
      assert.equal(
        readFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "utf-8"),
        "# bp\n",
      );
      assert.ok(existsSync(join(root, "scripts", "cli.ts")));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stashes operator dirt but leaves .slopcontrol on the working tree", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-mixed-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-mixed-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-mixed";
      const phaseId = "03-manage";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");

      writeFileSync(join(root, "scratch.txt"), "operator\n");
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "# keep\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: manage cli",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.stashedRoot, true);
      assert.equal(merged.stashRestored, true);
      assert.equal(git(root, ["stash", "list"]).trim(), "");
      assert.equal(readFileSync(join(root, "scratch.txt"), "utf-8"), "operator\n");
      assert.equal(
        readFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "utf-8"),
        "# keep\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("detects overwrite-style merge failure messages", () => {
    assert.equal(
      isOverwriteMergeFailure(
        "error: The following untracked working tree files would be overwritten by merge:\n\t.slopcontrol/phases/x/PHASE.md",
      ),
      true,
    );
    assert.equal(
      isOverwriteMergeFailure(
        "Merge conflict merging slop/x into main; auto-resolve incomplete.",
      ),
      false,
    );
  });

  it("clears untracked .slopcontrol phase paths that exist on the phase branch", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-clear-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-clear-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-clear";
      const phaseId = "39-workflow";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");
      const phaseRel = `.slopcontrol/phases/${phaseId}`;
      mkdirSync(join(wt.path, phaseRel), { recursive: true });
      writeFileSync(join(wt.path, phaseRel, "PHASE.md"), "# phase from branch\n");
      writeFileSync(join(wt.path, phaseRel, "APPENDIX.md"), "# appendix\n");

      // Same paths untracked on root (orchestrator writes) — would block merge
      mkdirSync(join(root, phaseRel), { recursive: true });
      writeFileSync(join(root, phaseRel, "PHASE.md"), "# stale root\n");
      writeFileSync(join(root, phaseRel, "APPENDIX.md"), "# stale appendix\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: phase 39",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.ok(
        (merged.clearedSlopcontrolPaths ?? []).some((p) =>
          p.includes("PHASE.md"),
        ),
        `expected cleared paths, got ${JSON.stringify(merged.clearedSlopcontrolPaths)}`,
      );
      assert.equal(
        readFileSync(join(root, phaseRel, "PHASE.md"), "utf-8"),
        "# phase from branch\n",
      );
      assert.equal(git(root, ["stash", "list"]).trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("stashes tracked .slopcontrol dirt so merge can prefer phase BLUEPRINT", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-tracked-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-tracked-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# demo\n");
      writeFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "# base bp\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-tracked";
      const phaseId = "39-workflow";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");
      writeFileSync(
        join(wt.path, ".slopcontrol", "BLUEPRINT.md"),
        "# phase bp\n",
      );

      // Dirty tracked BLUEPRINT on root (would be overwritten by merge)
      writeFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "# dirty root bp\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: phase bp",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.ok(existsSync(join(root, "scripts", "cli.ts")));
      const bp = readFileSync(join(root, ".slopcontrol", "BLUEPRINT.md"), "utf-8");
      // Phase content after merge, or restored dirty root after stash pop —
      // either way merge must succeed without abort.
      assert.ok(
        bp.includes("phase bp") || bp.includes("dirty root bp"),
        `unexpected BLUEPRINT: ${bp}`,
      );
      assert.equal(git(root, ["stash", "list"]).trim(), "");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("drops redundant stash when untracked path already exists after merge", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-redund-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-redund-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-redund";
      const phaseId = "03-manage";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      // Phase commits scratch.txt; root has a dirty untracked copy that is stashed
      writeFileSync(join(wt.path, "scratch.txt"), "from phase\n");
      writeFileSync(join(root, "scratch.txt"), "dirty local\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: scratch",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.stashedRoot, true);
      assert.equal(merged.stashRestored, true);
      assert.match(merged.message, /Dropped redundant pre-merge stash/);
      assert.equal(git(root, ["stash", "list"]).trim(), "");
      assert.equal(readFileSync(join(root, "scratch.txt"), "utf-8"), "from phase\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("auto-resolves stash-pop conflicts preferring phase package.json", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-conflict-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-conflict-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", dependencies: { left: "1" } }, null, 2) + "\n",
      );
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-conflict";
      const phaseId = "03-manage";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });

      writeFileSync(
        join(wt.path, "package.json"),
        JSON.stringify(
          {
            name: "demo",
            dependencies: { left: "1" },
            scripts: { manage: "tsx scripts/cli.ts" },
            devDependencies: { commander: "^12.1.0" },
          },
          null,
          2,
        ) + "\n",
      );
      mkdirSync(join(wt.path, "scripts"), { recursive: true });
      writeFileSync(join(wt.path, "scripts", "cli.ts"), "export const x = 1;\n");

      // Dirty root package.json that will conflict on stash pop after merge
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", dependencies: { left: "1", dirty: "1" } }, null, 2) +
          "\n",
      );

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        commitMessage: "feat: manage cli",
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(listConflictedPaths(root).length, 0, "no leftover conflicts");
      const pkg = readFileSync(join(root, "package.json"), "utf-8");
      assert.match(pkg, /commander/);
      assert.match(pkg, /manage/);
      assert.doesNotMatch(pkg, /<<<<<<</);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("resolveConflicts prefers phase blob with strategy=phase", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-resolve-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-resolve-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "app.txt"), "base\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const phaseId = "04-fix";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId: "proj-resolve",
        phaseId,
        dataDir,
      });
      writeFileSync(join(wt.path, "app.txt"), "from-phase\n");
      git(wt.path, ["add", "-A"]);
      git(wt.path, ["commit", "-m", "phase change"]);

      writeFileSync(join(root, "app.txt"), "from-main\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "main change"]);

      try {
        execFileSync("git", ["merge", "--no-ff", "-m", "merge phase", `slop/${phaseId}`], {
          cwd: root,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        // expected conflict
      }

      assert.ok(listConflictedPaths(root).includes("app.txt"));
      const resolved = resolveConflicts({
        projectRoot: root,
        strategy: "phase",
        phaseId,
        continueMerge: true,
      });
      assert.equal(resolved.ok, true, resolved.message);
      assert.equal(readFileSync(join(root, "app.txt"), "utf-8"), "from-phase\n");
      assert.equal(listConflictedPaths(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("syncs gitignored env files from project root into the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-sync-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-env-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      writeFileSync(join(root, ".gitignore"), ".env*\n!.env.example\n");
      writeFileSync(join(root, ".env.example"), "EXAMPLE=1\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      writeFileSync(join(root, ".env.docker"), "DATABASE_URL=postgres://local/db\n");
      writeFileSync(join(root, ".env.local"), "DATABASE_URL=postgres://local/db\n");
      writeFileSync(
        join(root, ".env.test"),
        "OLLAMA_BASE_URL=http://127.0.0.1:11434/v1\n",
      );

      const phaseId = "05-cli";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId: "proj-env",
        phaseId,
        dataDir,
      });

      assert.ok(wt.syncedFiles?.includes(".env.docker"));
      assert.ok(wt.syncedFiles?.includes(".env.local"));
      assert.ok(wt.syncedFiles?.includes(".env.test"));
      assert.equal(
        readFileSync(join(wt.path, ".env.docker"), "utf-8"),
        "DATABASE_URL=postgres://local/db\n",
      );
      assert.match(readFileSync(join(wt.path, ".env.test"), "utf-8"), /11434/);

      // Re-sync preserves worktree overrides that differ from root
      writeFileSync(
        join(wt.path, ".env.docker"),
        "# free tier with cloud-suffix models\nDATABASE_URL=postgres://worktree/db\n",
      );
      writeFileSync(
        join(root, ".env.docker"),
        "# free tier with :cloud models\nDATABASE_URL=postgres://updated/db\n",
      );
      const preserved = syncLocalFilesToWorktree({
        projectRoot: root,
        worktreePath: wt.path,
      });
      assert.ok(!preserved.includes(".env.docker"));
      assert.match(
        readFileSync(join(wt.path, ".env.docker"), "utf-8"),
        /cloud-suffix/,
      );
      assert.doesNotMatch(
        readFileSync(join(wt.path, ".env.docker"), "utf-8"),
        /:cloud/,
      );

      // Identical content is re-copied (listed in synced)
      writeFileSync(
        join(wt.path, ".env.docker"),
        "# free tier with :cloud models\nDATABASE_URL=postgres://updated/db\n",
      );
      const synced = syncLocalFilesToWorktree({
        projectRoot: root,
        worktreePath: wt.path,
      });
      assert.ok(synced.includes(".env.docker"));
      assert.equal(
        readFileSync(join(wt.path, ".env.docker"), "utf-8"),
        "# free tier with :cloud models\nDATABASE_URL=postgres://updated/db\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves worktree .env.docker when root comment still has :cloud", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-preserve-"));
    const wt = mkdtempSync(join(tmpdir(), "slop-wt-preserve-"));
    try {
      writeFileSync(
        join(root, ".env.docker"),
        '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with :cloud models)\nOLLAMA_TIER=paid\n',
      );
      writeFileSync(
        join(wt, ".env.docker"),
        '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with cloud-suffix models)\nOLLAMA_TIER=paid\n',
      );
      const synced = syncLocalFilesToWorktree({
        projectRoot: root,
        worktreePath: wt,
        relativePaths: [".env.docker"],
      });
      assert.deepEqual(synced, []);
      assert.doesNotMatch(readFileSync(join(wt, ".env.docker"), "utf-8"), /:cloud/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("pushes worktree .env.docker to root when comment no longer has :cloud", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-push-"));
    const wt = mkdtempSync(join(tmpdir(), "slop-wt-push-"));
    try {
      writeFileSync(
        join(root, ".env.docker"),
        '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with :cloud models)\nOLLAMA_TIER=paid\n',
      );
      writeFileSync(
        join(wt, ".env.docker"),
        '# Ollama Cloud tier: "paid" (subscription) or "free" (free tier with cloud-suffix models)\nOLLAMA_TIER=paid\n',
      );
      const pushed = syncLocalFilesFromWorktree({
        projectRoot: root,
        worktreePath: wt,
        relativePaths: [".env.docker"],
      });
      assert.deepEqual(pushed, [".env.docker"]);
      assert.doesNotMatch(readFileSync(join(root, ".env.docker"), "utf-8"), /:cloud/);
      assert.match(
        readFileSync(join(root, ".env.docker"), "utf-8"),
        /cloud-suffix/,
      );

      // Identical → no re-push
      assert.deepEqual(
        syncLocalFilesFromWorktree({
          projectRoot: root,
          worktreePath: wt,
          relativePaths: [".env.docker"],
        }),
        [],
      );

      // Never push .env.slopcontrol even if listed
      writeFileSync(join(wt, ".env.slopcontrol"), "X=1\n");
      assert.deepEqual(
        syncLocalFilesFromWorktree({
          projectRoot: root,
          worktreePath: wt,
          relativePaths: [".env.slopcontrol"],
        }),
        [],
      );
      assert.equal(existsSync(join(root, ".env.slopcontrol")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("syncIgnoredArtifactsFromWorktree copies drizzle/ and removes stale siblings", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ign-root-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-ign-data-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, ".gitignore"), "drizzle/\nnode_modules/\n");
      writeFileSync(join(root, "README.md"), "# demo\n");
      mkdirSync(join(root, "drizzle"), { recursive: true });
      writeFileSync(
        join(root, "drizzle", "0000_thin_rage.sql"),
        "CREATE TABLE old();\n",
      );
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-ign";
      const phaseId = "01-drizzle";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });

      mkdirSync(join(wt.path, "drizzle"), { recursive: true });
      writeFileSync(
        join(wt.path, "drizzle", "0000_lazy_khan.sql"),
        "CREATE EXTENSION IF NOT EXISTS vector;\nCREATE TABLE organizations();\n",
      );
      // Stale file only on root (not in worktree)
      assert.ok(existsSync(join(root, "drizzle", "0000_thin_rage.sql")));

      const result = syncIgnoredArtifactsFromWorktree({
        projectRoot: root,
        worktreePath: wt.path,
      });

      assert.ok(
        result.copied.includes("drizzle/0000_lazy_khan.sql"),
        `copied=${JSON.stringify(result.copied)}`,
      );
      assert.ok(
        result.deleted.includes("drizzle/0000_thin_rage.sql"),
        `deleted=${JSON.stringify(result.deleted)}`,
      );
      assert.equal(existsSync(join(root, "drizzle", "0000_thin_rage.sql")), false);
      assert.match(
        readFileSync(join(root, "drizzle", "0000_lazy_khan.sql"), "utf-8"),
        /CREATE EXTENSION/,
      );
      // Env noise must not sync
      writeFileSync(join(wt.path, ".env.local"), "SECRET=1\n");
      const again = syncIgnoredArtifactsFromWorktree({
        projectRoot: root,
        worktreePath: wt.path,
      });
      assert.ok(!again.copied.some((p) => p.includes(".env")));
      assert.equal(existsSync(join(root, ".env.local")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("paid→free guard rewrites OLLAMA_TIER back but still syncs other keys", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-paid-"));
    const wt = mkdtempSync(join(tmpdir(), "slop-wt-free-"));
    try {
      writeFileSync(
        join(root, ".env.docker"),
        "OLLAMA_TIER=paid\nAI_CHAT_MODEL=glm-5.2\n",
      );
      writeFileSync(
        join(wt, ".env.docker"),
        "OLLAMA_TIER=free\nAI_CHAT_MODEL=glm-5.2\nNEW_KEY=hello\n",
      );
      const pushed = syncLocalFilesFromWorktree({
        projectRoot: root,
        worktreePath: wt,
        relativePaths: [".env.docker"],
      });
      assert.deepEqual(pushed, [".env.docker"]);
      const body = readFileSync(join(root, ".env.docker"), "utf-8");
      assert.match(body, /^OLLAMA_TIER=paid$/m);
      assert.doesNotMatch(body, /OLLAMA_TIER=free/);
      assert.match(body, /^NEW_KEY=hello$/m);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("does not push worktree COMPOSE_PROJECT_NAME / isolated DB_PORT onto root", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-root-"));
    const wt = mkdtempSync(join(tmpdir(), "slop-env-wt-"));
    try {
      writeFileSync(
        join(root, ".env"),
        "DB_PORT=5433\nDATABASE_URL=postgresql://app:app@localhost:5433/db\n",
      );
      writeFileSync(
        join(wt, ".env"),
        "COMPOSE_PROJECT_NAME=slopwt-08-foo\nDB_PORT=5542\nDATABASE_URL=postgresql://app:app@localhost:5542/db\nOTHER=1\n",
      );
      const pushed = syncLocalFilesFromWorktree({
        projectRoot: root,
        worktreePath: wt,
        relativePaths: [".env"],
      });
      assert.deepEqual(pushed, [".env"]);
      const body = readFileSync(join(root, ".env"), "utf-8");
      assert.doesNotMatch(body, /COMPOSE_PROJECT_NAME/);
      assert.match(body, /DB_PORT=5433/);
      assert.match(body, /:5433\/db/);
      assert.match(body, /OTHER=1/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("does not re-apply poisoned root DB_PORT=5580 when syncing from worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-env-poison-"));
    const wt = mkdtempSync(join(tmpdir(), "slop-env-wt2-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, ".slopcontrol", "canonical-runtime-env.json"),
        JSON.stringify({
          dbPort: 5433,
          publishedPorts: [5433],
          files: {},
          capturedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(
        join(root, ".env"),
        "DB_PORT=5580\nDATABASE_URL=postgresql://app:app@localhost:5580/db\n",
      );
      writeFileSync(
        join(wt, ".env"),
        "COMPOSE_PROJECT_NAME=slopwt-x\nDB_PORT=5580\nDATABASE_URL=postgresql://app:app@localhost:5580/db\nKEEP=yes\n",
      );
      syncLocalFilesFromWorktree({
        projectRoot: root,
        worktreePath: wt,
        relativePaths: [".env"],
      });
      const body = readFileSync(join(root, ".env"), "utf-8");
      assert.match(body, /DB_PORT=5433/);
      assert.match(body, /:5433\/db/);
      assert.match(body, /KEEP=yes/);
      assert.doesNotMatch(body, /5580/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(wt, { recursive: true, force: true });
    }
  });

  it("checks out a branch in the project folder", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-co-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);
      git(root, ["checkout", "-b", "feature"]);
      writeFileSync(join(root, "feat.txt"), "x\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "feat"]);

      const status = getProjectGitStatus(root);
      assert.equal(status.currentBranch, "feature");
      assert.ok(status.branches.includes("main"));

      const co = checkoutProjectBranch({
        projectRoot: root,
        branch: "main",
      });
      assert.equal(co.ok, true, co.message);
      assert.equal(co.branch, "main");
      assert.equal(co.previousBranch, "feature");
      assert.equal(getProjectGitStatus(root).currentBranch, "main");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a phase worktree and optionally deletes its branch", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-rm-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-rm-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-rm";
      const phaseId = "07-cleanup";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      writeFileSync(join(wt.path, "extra.txt"), "1\n");
      git(wt.path, ["add", "-A"]);
      git(wt.path, ["commit", "-m", "phase work"]);

      assert.ok(existsSync(wt.path));

      const removed = removePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        deleteBranch: true,
      });
      assert.equal(removed.ok, true, removed.message);
      assert.equal(removed.removedWorktree, true);
      assert.equal(removed.deletedBranch, true);
      assert.equal(existsSync(wt.path), false);

      const status = getProjectGitStatus(root);
      assert.equal(status.phaseBranches.includes(`slop/${phaseId}`), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("merge removes worktree when removeWorktree is true", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-wt-rm-"));
    const dataDir = mkdtempSync(join(tmpdir(), "slop-data-wt-rm-"));
    try {
      git(root, ["init"]);
      git(root, ["checkout", "-b", "main"]);
      writeFileSync(join(root, "README.md"), "# demo\n");
      git(root, ["add", "-A"]);
      git(root, ["commit", "-m", "init"]);

      const projectId = "proj-merge-rm";
      const phaseId = "08-done";
      const wt = ensurePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
      });
      writeFileSync(join(wt.path, "done.txt"), "ok\n");

      const merged = mergePhaseWorktree({
        projectRoot: root,
        projectId,
        phaseId,
        dataDir,
        targetBranch: "main",
        removeWorktree: true,
      });
      assert.equal(merged.ok, true, merged.message);
      assert.equal(merged.removedWorktree, true);
      assert.ok(existsSync(join(root, "done.txt")));
      assert.equal(existsSync(wt.path), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
