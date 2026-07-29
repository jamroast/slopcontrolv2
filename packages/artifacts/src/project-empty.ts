import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const IGNORED_NAMES = new Set([
  ".git",
  ".slopcontrol",
  ".ds_store",
  ".idea",
  ".vscode",
  "node_modules",
  ".cursor",
  ".hg",
  ".svn",
]);

const MEANINGFUL_FILES = new Set([
  "package.json",
  "pnpm-workspace.yaml",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "gemfile",
  "composer.json",
  "makefile",
  "dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
]);

const MEANINGFUL_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|php|cs|cpp|c|h|vue|svelte|sql|proto)$/i;

/**
 * True when the project has no meaningful source yet (greenfield).
 * Ignores .git, .slopcontrol, IDE junk, and empty directories.
 */
export function isProjectEmpty(projectRoot: string): boolean {
  if (!existsSync(projectRoot)) return true;

  const stack = [projectRoot];
  let visited = 0;

  while (stack.length > 0 && visited < 5000) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      visited += 1;
      const name = entry.name;
      if (name.startsWith(".") && name !== ".env.example") {
        if (IGNORED_NAMES.has(name.toLowerCase())) continue;
        // allow .env.example as weak signal but not enough alone for "existing"
      }
      if (IGNORED_NAMES.has(name.toLowerCase())) continue;

      const full = join(dir, name);
      if (entry.isDirectory()) {
        // Common source roots immediately mean non-empty
        if (
          /^(src|app|apps|packages|lib|cmd|internal|pkg|server|client|web|backend|frontend)$/i.test(
            name,
          )
        ) {
          return false;
        }
        stack.push(full);
        continue;
      }

      if (!entry.isFile()) continue;

      if (MEANINGFUL_FILES.has(name.toLowerCase())) return false;
      if (MEANINGFUL_EXT.test(name)) return false;

      // README alone does not make a project "existing"
      if (/^readme(\.md|\.txt)?$/i.test(name)) continue;
      if (name === ".env.example" || name === ".gitignore") continue;
    }
  }

  return true;
}
