import { exec } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";
import { promisify } from "node:util";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { fetchUrlContent, webSearchExa } from "./web-tools.js";

const execAsync = promisify(exec);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".vercel",
  ".cache",
  "out",
]);

function resolvePath(projectDir: string, path: string): string {
  return path.startsWith("/") ? path : join(projectDir, path);
}

function walkFiles(
  root: string,
  dir: string,
  out: string[],
  maxFiles: number,
): void {
  if (out.length >= maxFiles) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= maxFiles) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    const rel = relative(root, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      walkFiles(root, full, out, maxFiles);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

export function createProjectTools(projectDir: string) {
  const readFile = createTool({
    id: "read_file",
    description: "Read a file relative to the project root",
    inputSchema: z.object({ path: z.string() }),
    execute: async ({ path }) => {
      try {
        const content = readFileSync(resolvePath(projectDir, path), "utf-8");
        return { content, lines: content.split("\n").length };
      } catch (error) {
        return {
          content: `Error: ${error instanceof Error ? error.message : String(error)}`,
          lines: 0,
        };
      }
    },
  });

  const writeFile = createTool({
    id: "write_file",
    description: "Write a file relative to the project root",
    inputSchema: z.object({ path: z.string(), content: z.string() }),
    execute: async ({ path, content }) => {
      const fullPath = resolvePath(projectDir, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
      return { success: true, path: fullPath, bytes: content.length };
    },
  });

  const listFiles = createTool({
    id: "list_files",
    description:
      "List files in a directory relative to the project root. Recursive by default — use to inventory docker/, src/, etc.",
    inputSchema: z.object({
      path: z.string().default("."),
      recursive: z.boolean().default(true),
    }),
    execute: async ({ path, recursive }) => {
      const dir = resolvePath(projectDir, path);
      const files: string[] = [];

      const walk = (current: string, prefix: string) => {
        for (const entry of readdirSync(current)) {
          if (SKIP_DIRS.has(entry)) continue;
          const full = join(current, entry);
          const rel = prefix ? `${prefix}/${entry}` : entry;
          if (statSync(full).isDirectory()) {
            if (recursive) walk(full, rel);
            else files.push(`${rel}/`);
          } else {
            files.push(rel);
          }
        }
      };

      walk(dir, path === "." ? "" : path);
      return { files, count: files.length };
    },
  });

  const grepFiles = createTool({
    id: "grep_files",
    description:
      "Search file contents under the project root for a regex/string (skips node_modules/.git/.next). Returns matching paths and snippets.",
    inputSchema: z.object({
      pattern: z.string().describe("JavaScript RegExp source (case-insensitive)"),
      path: z
        .string()
        .default(".")
        .describe("Subdirectory to search, relative to project root"),
      maxMatches: z.number().int().positive().max(80).default(40),
    }),
    execute: async ({ pattern, path, maxMatches }) => {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, "i");
      } catch (error) {
        return {
          matches: [],
          error: `Invalid pattern: ${error instanceof Error ? error.message : String(error)}`,
        };
      }

      const searchRoot = resolvePath(projectDir, path);
      const files: string[] = [];
      walkFiles(searchRoot, searchRoot, files, 2000);

      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const relFromSearch of files) {
        if (matches.length >= maxMatches) break;
        const full = join(searchRoot, relFromSearch);
        const rel = relative(projectDir, full).replace(/\\/g, "/");
        // Skip binaries / huge files
        if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|pdf|zip|gz|tgz)$/i.test(rel)) {
          continue;
        }
        let content: string;
        try {
          const st = statSync(full);
          if (st.size > 512_000) continue;
          content = readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxMatches) break;
          const line = lines[i] ?? "";
          if (regex.test(line)) {
            matches.push({
              path: rel,
              line: i + 1,
              text: line.slice(0, 240),
            });
          }
        }
      }

      return { matches, count: matches.length };
    },
  });

  const runCommand = createTool({
    id: "run_command",
    description: "Run a shell command in the project directory",
    inputSchema: z.object({ command: z.string() }),
    execute: async ({ command }) => {
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: projectDir,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { output: stdout + stderr, exitCode: 0 };
      } catch (error) {
        const err = error as { stdout?: string; stderr?: string; code?: number };
        return {
          output: (err.stdout ?? "") + (err.stderr ?? ""),
          exitCode: err.code ?? 1,
        };
      }
    },
  });

  const fetchUrl = createTool({
    id: "fetch_url",
    description:
      "Fetch a public https:// URL and return truncated text (HTML stripped). Use for vendor docs, GitHub raw, API references. No Authorization headers; blocked for localhost/private IPs.",
    inputSchema: z.object({
      url: z.string().url().describe("https URL to fetch"),
    }),
    execute: async ({ url }) => fetchUrlContent(url),
  });

  const webSearch = createTool({
    id: "web_search",
    description:
      "Search the public web via Exa (requires EXA_API_KEY). Use for current vendor docs, model catalogs, API differences. Prefer repo tools first; cite returned URLs in RESEARCH.md.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Search query"),
      numResults: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ query, numResults }) =>
      webSearchExa(query, { numResults }),
  });

  return {
    readFile,
    writeFile,
    listFiles,
    grepFiles,
    runCommand,
    fetchUrl,
    webSearch,
  };
}
