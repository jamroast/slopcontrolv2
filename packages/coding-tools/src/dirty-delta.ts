import { execFile } from "node:child_process";

/**
 * Paths present in `current` that were absent from `baseline`.
 *
 * The dirty-tree review guard must measure *investigator-attributable*
 * change, not repo state: post-merge verify runs right after the merge
 * churned the tree, so a baseline-less `git status` blames the
 * investigator for the merge itself. A missing/failed baseline (null)
 * degrades to the old behaviour — everything in `current` counts.
 */
export function dirtyDelta(
  baseline: Iterable<string> | null | undefined,
  current: Iterable<string>,
): string[] {
  if (!baseline) {
    return [...current];
  }
  const before = new Set(baseline);
  const out: string[] = [];
  for (const path of current) {
    if (!before.has(path)) {
      out.push(path);
    }
  }
  return out;
}

/** Repo-wide `git status --porcelain` paths for `projectDir` ([] on error). */
export function gitStatusPaths(projectDir: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain=v1", "-uall"],
      { cwd: projectDir },
      (error, stdout) => {
        if (error) {
          resolve([]);
          return;
        }
        resolve(
          stdout
            .split("\n")
            .map((line) => line.slice(3).trim())
            .filter((line) => line.length > 0)
            .map((line) => {
              // Renames show as "old -> new"; keep the new path.
              const arrow = line.indexOf(" -> ");
              return arrow >= 0 ? line.slice(arrow + 4) : line;
            }),
        );
      },
    );
  });
}
