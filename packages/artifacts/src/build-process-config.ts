/**
 * Build-process configurator — deterministic half.
 *
 * Collects the evidence bundle the LLM sees, applies the LLM's proposed
 * changes under hard guardrails (root confinement, path allowlist, command
 * allowlist), and records `.slopcontrol/BUILD_PROCESS.json` evidence.
 * The LLM (llm/build-process-config-llm.ts) decides WHAT; this module owns
 * IF/HOW anything touches disk.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  BuildProcessConfigResultSchema,
  BuildToolchainSpecSchema,
  type BuildProcessConfigChange,
  type BuildProcessConfigResult,
  type BuildToolchainSpec,
} from "@slopcontrol/types";
import { defaultToolchainSpec, detectBuildToolchain } from "./build-toolchain.js";
import {
  goldenDockerfileDepsSection,
  goldenProjectNpmrc,
  renderCiWorkflowYaml,
} from "./ci-workflows.js";
import {
  NPM_PRIVATE_SCOPES,
  resolveProjectRegistryScopes,
} from "./npm-registry.js";

/** Files/dirs sampled into the evidence bundle (content truncated). */
const EVIDENCE_FILES = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  ".npmrc",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  ".nvmrc",
  ".tool-versions",
] as const;

const EVIDENCE_DIRS = ["Dockerfile.d", ".devcontainer"] as const;

const MAX_FILE_CHARS = 6_000;
const MAX_WORKFLOW_CHARS = 4_000;
const MAX_WORKFLOWS = 6;
const MAX_TREE_ENTRIES = 80;

/** Paths the configurator may write (project-relative). */
const WRITE_ALLOWLIST: RegExp[] = [
  /^package\.json$/,
  /^\.npmrc$/,
  /^Dockerfile(\..*)?$/,
  /^docker-compose(\..*)?\.ya?ml$/,
  /^\.github\/workflows\/[^/\\]+\.ya?ml$/,
  /^pyproject\.toml$/,
  /^Cargo\.toml$/,
  /^Makefile$/,
  /^\.nvmrc$/,
  /^\.tool-versions$/,
];

/** Static binaries always allowed for run_command. */
const RUN_COMMAND_BASE_ALLOWLIST = new Set(["corepack", "node"]);

export const BuildProcessEvidenceSchema = z.object({
  toolchain: BuildToolchainSpecSchema.optional(),
  gaps: z.array(z.string()).default([]),
  notes: z.string().default(""),
  confidence: z.enum(["low", "medium", "high"]).optional(),
  origin: z.enum(["llm", "manual"]),
  lastAuditAt: z.string().optional(),
  lastConfigureAt: z.string().optional(),
  /**
   * Import-time onboarding status. absent/"pending" = never onboarded;
   * surfaced by GET /projects/:id/build-process so Hermes can flag projects
   * whose build process is not SlopControl-compatible.
   */
  onboarding: z
    .enum(["pending", "running", "applied", "audit-only", "failed"])
    .optional(),
  lastOnboardAt: z.string().optional(),
  applied: z
    .array(
      z.object({
        op: z.string(),
        path: z.string().optional(),
        rationale: z.string().default(""),
        applied: z.boolean(),
        detail: z.string().default(""),
      }),
    )
    .default([]),
});
export type BuildProcessEvidence = z.infer<typeof BuildProcessEvidenceSchema>;

export function buildProcessEvidencePath(projectRoot: string): string {
  return join(projectRoot, ".slopcontrol", "BUILD_PROCESS.json");
}

export function readBuildProcessEvidence(
  projectRoot: string,
): BuildProcessEvidence | null {
  const path = buildProcessEvidencePath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    return BuildProcessEvidenceSchema.parse(
      JSON.parse(readFileSync(path, "utf-8")),
    );
  } catch {
    return null;
  }
}

export function writeBuildProcessEvidence(
  projectRoot: string,
  evidence: BuildProcessEvidence,
): void {
  mkdirSync(join(projectRoot, ".slopcontrol"), { recursive: true });
  writeFileSync(
    buildProcessEvidencePath(projectRoot),
    `${JSON.stringify(BuildProcessEvidenceSchema.parse(evidence), null, 2)}\n`,
    "utf-8",
  );
}

function readCapped(path: string, maxChars: number): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const body = readFileSync(path, "utf-8");
    return body.length > maxChars ? `${body.slice(0, maxChars)}\n…(truncated)` : body;
  } catch {
    return null;
  }
}

/**
 * Deterministic evidence bundle for the LLM: toolchain hint, shallow tree,
 * manifest/docker/workflow contents, current resolved toolchain, checklist.
 */
export function collectBuildProcessEvidence(opts: {
  projectRoot: string;
  configuredToolchain?: BuildToolchainSpec | null;
}): string {
  const root = opts.projectRoot;
  const parts: string[] = [];

  const hint = detectBuildToolchain(root);
  parts.push(
    `Toolchain hint (deterministic): kind=${hint.kind} hasDefaultSpec=${hint.hasDefaultSpec}`,
    `Evidence files present: ${hint.matched.join(", ") || "(none)"}`,
    "",
  );

  if (opts.configuredToolchain) {
    parts.push(
      "Currently resolved toolchain (.slopcontrol/config.json):",
      JSON.stringify(opts.configuredToolchain, null, 2),
      "",
    );
  } else {
    parts.push("Currently resolved toolchain: (none persisted)", "");
  }

  try {
    const entries = readdirSync(root)
      .filter((e) => e !== "node_modules" && e !== ".git")
      .slice(0, MAX_TREE_ENTRIES);
    parts.push(`Top-level tree (${entries.length} entries):`);
    for (const e of entries) {
      try {
        parts.push(`  ${e}${statSync(join(root, e)).isDirectory() ? "/" : ""}`);
      } catch {
        parts.push(`  ${e}`);
      }
    }
    parts.push("");
  } catch {
    /* root unreadable */
  }

  for (const rel of EVIDENCE_FILES) {
    const body = readCapped(join(root, rel), MAX_FILE_CHARS);
    if (body !== null) {
      parts.push(`--- ${rel} ---`, body, "");
    }
  }
  for (const dir of EVIDENCE_DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) continue;
    try {
      for (const f of readdirSync(abs).slice(0, 4)) {
        const body = readCapped(join(abs, f), MAX_FILE_CHARS);
        if (body !== null) parts.push(`--- ${dir}/${f} ---`, body, "");
      }
    } catch {
      /* skip */
    }
  }

  const wfDir = join(root, ".github", "workflows");
  if (existsSync(wfDir)) {
    try {
      const wfs = readdirSync(wfDir)
        .filter((f) => /\.ya?ml$/.test(f))
        .slice(0, MAX_WORKFLOWS);
      for (const f of wfs) {
        const body = readCapped(join(wfDir, f), MAX_WORKFLOW_CHARS);
        if (body !== null) parts.push(`--- .github/workflows/${f} ---`, body, "");
      }
    } catch {
      /* skip */
    }
  }

  const prior = readBuildProcessEvidence(root);
  if (prior?.gaps.length) {
    parts.push("Prior recorded gaps:", ...prior.gaps.map((g) => `  - ${g}`), "");
  }

  // Few-shot reference: the deterministic CI template for the detected kind.
  const referenceSpec = opts.configuredToolchain ?? defaultToolchainSpec(hint.kind);
  if (referenceSpec) {
    const ciRef = renderCiWorkflowYaml(referenceSpec);
    if (ciRef) {
      parts.push(
        `Reference ci.yml for kind=${referenceSpec.kind} (adapt, don't copy blindly):`,
        ciRef,
      );
    }
    // Golden registry patterns for node projects: reviewed idioms the LLM
    // must follow (pnpm ignores env refs in committed .npmrc; containers
    // generate .npmrc from build ARGs). Prevents improvised misconfigurations.
    if (referenceSpec.kind.startsWith("node-")) {
      // Golden registry patterns for node projects: reviewed idioms the LLM
      // must follow (pnpm ignores env refs in committed .npmrc; containers
      // generate .npmrc from build ARGs). Scopes come from the project's
      // config / .npmrc discovery, not a hardcoded list.
      const projectScopes = resolveProjectRegistryScopes({
        projectRoot: root,
      });
      parts.push(
        "Golden committed .npmrc for node projects (literal loopback — adapt scopes to this project):",
        goldenProjectNpmrc(projectScopes),
        "Golden Dockerfile dependency stage for node consumers (ARG-driven, generated .npmrc, frozen install — adapt to the project's stage layout):",
        goldenDockerfileDepsSection(projectScopes),
        "",
      );
    }
  }

  return parts.join("\n");
}

export type AppliedChange = {
  change: BuildProcessConfigChange;
  applied: boolean;
  detail: string;
};

function assertPathAllowed(projectRoot: string, rel: string): string {
  if (rel.includes("\0")) throw new Error("nul byte in path");
  const abs = resolve(projectRoot, rel);
  if (abs !== projectRoot && !abs.startsWith(`${resolve(projectRoot)}${sep}`)) {
    throw new Error(`path escapes project root: ${rel}`);
  }
  const normalized = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!WRITE_ALLOWLIST.some((re) => re.test(normalized))) {
    throw new Error(`path not in build-process write allowlist: ${rel}`);
  }
  return abs;
}

/** Binaries the resolved toolchain itself uses (plus static base set). */
export function allowedRunCommandBins(spec: BuildToolchainSpec): Set<string> {
  const bins = new Set(RUN_COMMAND_BASE_ALLOWLIST);
  for (const cmd of [
    spec.buildCmd,
    spec.installCmd,
    spec.frozenInstallCmd,
    spec.bumpVersionCmd,
    spec.publishCmd,
    spec.consumeUpdateCmd,
  ]) {
    const bin = cmd?.[0]?.trim();
    if (bin) bins.add(bin);
  }
  return bins;
}

function setDotPath(target: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split(".").filter((k) => k.length > 0);
  if (!keys.length) throw new Error(`empty dot-path in edit_json`);
  let cur: Record<string, unknown> = target;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (next === undefined || next === null) {
      cur[key] = {};
    } else if (typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`edit_json path traverses non-object at "${key}"`);
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
}

function applyWriteFile(projectRoot: string, change: Extract<BuildProcessConfigChange, { op: "write_file" }>): string {
  const abs = assertPathAllowed(projectRoot, change.path);
  assertNoDuplicateYamlKeys(change.content, change.path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, change.content, "utf-8");
  return `wrote ${change.path} (${change.content.length} chars)`;
}

/**
 * Conservative YAML guard for write/replace ops on *.yml/*.yaml targets:
 * rejects duplicate mapping keys at the same indent within the same parent
 * scope (the classic replace_section failure: block header duplicated in the
 * replacement content). Not a full YAML parse — just the corruption class we
 * have actually seen. Throws before anything touches disk.
 */
export function assertNoDuplicateYamlKeys(content: string, path: string): void {
  if (!/\.ya?ml$/.test(path)) return;
  // Each frame holds the mapping keys seen under one parent. Root frame at
  // indent -1. Comments are ignored. List items each open their own scope
  // (repeated keys ACROSS list items, e.g. GH Actions `uses:`/`with:`, are
  // legal YAML and must not be flagged).
  const stack: Array<{ indent: number; keys: Set<string> }> = [
    { indent: -1, keys: new Set() },
  ];
  for (const raw of content.split("\n")) {
    if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
    const listM = /^(\s*)-\s+(.*)$/.exec(raw);
    if (listM) {
      const dashIndent = listM[1]!.length;
      const inner = listM[2]!;
      while (stack.length > 1 && dashIndent <= stack[stack.length - 1]!.indent) {
        stack.pop();
      }
      if (inner.startsWith("\"") || inner.startsWith("'")) {
        stack.push({ indent: dashIndent, keys: new Set() });
        continue;
      }
      const km = /^([A-Za-z0-9_.$-]+):(\s|$)/.exec(inner);
      stack.push({ indent: dashIndent, keys: new Set(km ? [km[1]!] : []) });
      continue;
    }
    const m = /^(\s*)([A-Za-z0-9_.$-]+):(\s|$)/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = m[2]!;
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]!;
    if (parent.keys.has(key)) {
      throw new Error(
        `refusing to write ${path}: duplicate YAML key "${key}" at indent ${indent}`,
      );
    }
    parent.keys.add(key);
    stack.push({ indent, keys: new Set() });
  }
}

function applyEditJson(projectRoot: string, change: Extract<BuildProcessConfigChange, { op: "edit_json" }>): string {
  const abs = assertPathAllowed(projectRoot, change.path);
  if (!change.path.endsWith(".json")) {
    throw new Error(`edit_json only supports .json files: ${change.path}`);
  }
  const doc = existsSync(abs)
    ? (JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>)
    : {};
  for (const [dotPath, value] of Object.entries(change.set)) {
    setDotPath(doc, dotPath, value);
  }
  writeFileSync(abs, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
  return `edited ${change.path} (${Object.keys(change.set).length} keys)`;
}

function applyReplaceSection(
  projectRoot: string,
  change: Extract<BuildProcessConfigChange, { op: "replace_section" }>,
): string {
  const abs = assertPathAllowed(projectRoot, change.path);
  const block = `${change.markerStart}\n${change.content.trimEnd()}\n${change.markerEnd}\n`;
  const prior = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
  const next = replaceSectionLineAnchored(prior, change, block);
  assertNoDuplicateYamlKeys(next, change.path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, next, "utf-8");
  return `section replaced in ${change.path}`;
}

/**
 * Markers are WHOLE LINES (trimmed compare). Substring regex matching let a
 * markerEnd match a line prefix — e.g. `RUN --mount=…` inside
 * `RUN --mount=… \` — leaving a dangling ` \` that silently corrupts
 * Dockerfiles. Multi-line markers (rare) fall back to the substring regex.
 */
function replaceSectionLineAnchored(
  prior: string,
  change: Extract<BuildProcessConfigChange, { op: "replace_section" }>,
  block: string,
): string {
  const start = change.markerStart.trim();
  const end = change.markerEnd.trim();
  if (start.includes("\n") || end.includes("\n")) {
    const esc = (s: string): string =>
      s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(
      `${esc(change.markerStart)}[\\s\\S]*?${esc(change.markerEnd)}\\n?`,
      "m",
    );
    return re.test(prior)
      ? prior.replace(re, block)
      : appendBlock(prior, block);
  }
  const lines = prior.split("\n");
  const i = lines.findIndex((l) => l.trim() === start);
  if (i === -1) return appendBlock(prior, block);
  const j = lines.findIndex((l, idx) => idx > i && l.trim() === end);
  if (j === -1) return appendBlock(prior, block);
  const blockLines = block.trimEnd().split("\n");
  return [...lines.slice(0, i), ...blockLines, ...lines.slice(j + 1)].join(
    "\n",
  );
}

function appendBlock(prior: string, block: string): string {
  return prior.trimEnd() ? `${prior.trimEnd()}\n\n${block}` : block;
}

/**
 * Validate + apply file changes. `run_command` entries are NOT executed
 * here — they are returned as `pendingCommands` for the caller (which owns
 * process execution + logging) after bin-allowlist validation.
 */
export function applyBuildProcessChanges(opts: {
  projectRoot: string;
  changes: BuildProcessConfigChange[];
  toolchain: BuildToolchainSpec;
}): { results: AppliedChange[]; pendingCommands: string[][] } {
  const allowedBins = allowedRunCommandBins(opts.toolchain);
  const results: AppliedChange[] = [];
  const pendingCommands: string[][] = [];

  for (const change of opts.changes) {
    try {
      switch (change.op) {
        case "write_file":
          results.push({ change, applied: true, detail: applyWriteFile(opts.projectRoot, change) });
          break;
        case "edit_json":
          results.push({ change, applied: true, detail: applyEditJson(opts.projectRoot, change) });
          break;
        case "replace_section":
          results.push({ change, applied: true, detail: applyReplaceSection(opts.projectRoot, change) });
          break;
        case "run_command": {
          const bin = change.command[0] ?? "";
          if (!allowedBins.has(bin)) {
            results.push({
              change,
              applied: false,
              detail: `run_command bin not allowed: ${bin}`,
            });
            break;
          }
          pendingCommands.push(change.command);
          results.push({ change, applied: true, detail: `queued command: ${change.command.join(" ")}` });
          break;
        }
      }
    } catch (err) {
      results.push({
        change,
        applied: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { results, pendingCommands };
}

/** Parse + validate an LLM result; low confidence forces audit-only. */
export function parseBuildProcessConfigResult(
  raw: unknown,
): BuildProcessConfigResult {
  return BuildProcessConfigResultSchema.parse(raw);
}
