/**
 * LLM build-process configurator.
 *
 * Given a deterministic evidence bundle about a project (manifests,
 * lockfiles, Dockerfile, workflows, toolchain hints) and the SlopControl
 * capability checklist (publish → registry → consume → docker → CI), the
 * LLM resolves the project's BuildToolchain (commands for ANY ecosystem:
 * npm/pnpm/rust/python/...) and proposes structured, allowlisted changes.
 *
 * Deterministic code collects evidence and applies changes under guardrails
 * (artifacts/build-process-config.ts); this module only decides WHAT.
 */

import {
  BuildProcessConfigResultSchema,
  type BuildProcessConfigResult,
  type LlmEndpoint,
} from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const BUILD_PROCESS_CONFIG_SYSTEM_PROMPT = `You configure a project's BUILD PROCESS so it supports the SlopControl cycle. You work for any ecosystem (npm, pnpm, yarn, bun, rust/cargo, python/uv/pip, go, ...).

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

SlopControl capability checklist the build process must support:
1. BUILD — a deterministic build command producing publishable output.
2. PUBLISH — component-library projects publish to a private registry; the version must bump per publish (registries reject republishing an existing version).
3. CONSUME — consumer projects install the library via their package manager so the lockfile refreshes natively.
4. DOCKER — container builds reach the registry via build ARGs / env (never hard-coded localhost; containers use host.docker.internal).
5. CI — the same commands must run from CI with registry URL/token supplied via env/secrets.
6. ENV SYNC — when the project ships an env-manager (e.g. a "manage" script with an "env sync" subcommand), wire it as envSyncCmd so SlopControl can refresh gitignored runtime env files (.env.local/.env.docker) from templates after phases change them.

Return ONLY a JSON object with these fields:
- toolchain: {
    kind: string (e.g. "node-pnpm", "node-npm", "rust-cargo", "python-uv"),
    buildCmd?: string[] (argv array, no shell),
    installCmd?: string[],
    frozenInstallCmd?: string[] (lockfile-frozen install for CI/Docker),
    bumpVersionCmd?: string[] with literal "{bump}" placeholder (patch|minor|major),
    publishCmd?: string[] with literal "{registryUrl}" placeholder,
    consumeUpdateCmd?: string[] with literal "{dep}" placeholder (name@^version),
    envSyncCmd?: string[] (project-native env sync, e.g. ["pnpm","run","manage","--","env","sync"] — merge semantics, must preserve existing values),
    lockfiles: string[],
    registryEnvKeys: string[] (e.g. ["SLOPCONTROL_NPM_REGISTRY_URL","SLOPCONTROL_NPM_REGISTRY_DOCKER_URL","SLOPCONTROL_NPM_REGISTRY_TOKEN"])
  }
- gaps: string[] — capabilities from the checklist the project currently lacks
- changes: array of changes to close the gaps. Each is ONE of:
    { "op": "write_file", "path": string, "content": string, "rationale": string }
    { "op": "edit_json", "path": string, "set": { "dot.path.key": value }, "rationale": string }
    { "op": "replace_section", "path": string, "markerStart": string, "markerEnd": string, "content": string, "rationale": string }
    { "op": "run_command", "command": string[], "rationale": string }
- notes: string — 1-3 sentences for the operator
- confidence: "low" | "medium" | "high"

replace_section semantics: content is the text BETWEEN the markers. NEVER repeat the markerStart/markerEnd lines (or any parent key line like 'args:') inside content — the applier re-adds the markers, and duplicated YAML keys are rejected.

Rules:
- Prefer the project's OWN existing toolchain (lockfile evidence wins). Do not switch package managers unless a lockfile is missing or mixed.
- Commands are argv arrays (no shell strings, no pipes, no && chains).
- Only propose files a build-process config may touch (package.json, .npmrc, Dockerfile*, docker-compose*.yml, .github/workflows/*.yml, pyproject.toml, Cargo.toml, Makefile, .nvmrc, .tool-versions). NEVER propose source code, secrets, or lockfile edits.
- run_command only for toolchain binaries (the ones in your toolchain commands, plus corepack/node). Nothing destructive.
- Registry coordinates come from env vars / build ARGs, never hard-coded localhost in committed files.
- Fewer, higher-confidence changes beat many speculative ones. When unsure, lower confidence and explain in notes.

Registry env contract (EXACT — do not reinterpret):
- SLOPCONTROL_NPM_REGISTRY_URL: full URL WITH protocol and trailing slash (e.g. http://127.0.0.1:4873/). Use for 'pnpm publish --registry "$SLOPCONTROL_NPM_REGISTRY_URL"'.
- SLOPCONTROL_NPM_REGISTRY_DOCKER_URL: same, but http://host.docker.internal:PORT/ for containers.
- SLOPCONTROL_NPM_REGISTRY_AUTH_HOST: host:port WITHOUT protocol (e.g. 127.0.0.1:4873). For .npmrc nerf-dart auth lines only.
- SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST: host.docker.internal:PORT variant for container builds.
- SLOPCONTROL_NPM_REGISTRY_TOKEN: the auth token value.
- In CI, pass the same names via secrets; never invent alternate variable names.

CRITICAL pnpm/npm .npmrc constraint: pnpm does NOT expand environment variables in registry/proxy/auth lines of a PROJECT-level .npmrc (committed files are untrusted; env expansion there is ignored with a warning). Therefore:
- Committed project .npmrc: use the LITERAL loopback registry, e.g. '@acme:registry=http://127.0.0.1:4873/' (a loopback URL is not a secret). No '\${...}' env references in registry/auth lines.
- Dockerfile: generate the container .npmrc from build ARGs at build time, e.g. RUN printf '@acme:registry=%s\n//%s/:_authToken=%s\n' "$SLOPCONTROL_NPM_REGISTRY_DOCKER_URL" "$SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST" "$SLOPCONTROL_NPM_REGISTRY_TOKEN" > .npmrc (omit the auth line when the registry allows anonymous publish).
- CI: generate .npmrc the same way in a workflow step from secrets before install/publish.
- The local SlopControl registry grants $all access+publish on its private scopes, so auth lines are OPTIONAL locally; keep the token contract for when the registry is hardened or remote.
`;

export interface ConfigureBuildProcessViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  /** Deterministic evidence bundle (artifacts collectBuildProcessEvidence). */
  evidence: string;
  timeoutMs?: number;
}

/**
 * Classification-role JSON → BuildProcessConfigResult.
 * Callers treat low confidence / parse failure as audit-only (no apply).
 */
export async function configureBuildProcessViaLlm(
  opts: ConfigureBuildProcessViaLlmOptions,
): Promise<BuildProcessConfigResult> {
  const res = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: BUILD_PROCESS_CONFIG_SYSTEM_PROMPT,
    user: [
      "Project evidence bundle:",
      opts.evidence.slice(0, 24_000),
      "",
      "Resolve the toolchain and propose the minimal changes to support the full SlopControl capability checklist.",
      "",
      'REMINDER: your entire reply is exactly one JSON object ({"toolchain":..., "gaps":[...], "changes":[...], "notes":"...", "confidence":...}). Do not reason out loud first; put analysis inside "notes".',
    ].join("\n"),
    timeoutMs: opts.timeoutMs ?? 240_000,
    // Reasoning models (glm-5.2:cloud) spend ~9k tokens on hidden
    // chain-of-thought before the JSON answer; small budgets truncate
    // mid-object with finish_reason=length. Give it real headroom.
    maxTokens: 32768,
  });
  return BuildProcessConfigResultSchema.parse(res.parsed);
}
