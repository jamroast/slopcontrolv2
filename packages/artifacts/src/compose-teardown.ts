import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const COMPOSE_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
] as const;

const URL_ENV_KEYS = [
  "DATABASE_URL",
  "LOCAL_DB_URL",
  "POSTGRES_URL",
  "DB_URL",
] as const;

/** Worktree isolation band — never treat these as product-owned ports. */
export const WORKTREE_DB_PORT_MIN = 5500;
export const WORKTREE_DB_PORT_MAX = 5599;

/** Default product host DB port when compose/env do not declare one. */
export const DEFAULT_CANONICAL_DB_PORT = 5433;

export const CANONICAL_RUNTIME_ENV_REL =
  ".slopcontrol/canonical-runtime-env.json";

const RUNTIME_ENV_KEYS = [
  "DB_PORT",
  "COMPOSE_PROJECT_NAME",
  "SLOPCONTROL_NPM_REGISTRY_URL",
  "SLOPCONTROL_NPM_REGISTRY_DOCKER_URL",
  "SLOPCONTROL_NPM_REGISTRY_AUTH_HOST",
  "SLOPCONTROL_NPM_REGISTRY_DOCKER_AUTH_HOST",
  "SLOPCONTROL_NPM_REGISTRY_TOKEN",
  ...URL_ENV_KEYS,
] as const;

export type ComposeTeardownResult = {
  attempted: boolean;
  ok: boolean;
  output: string;
};

export type CanonicalRuntimeEnv = {
  dbPort: number;
  publishedPorts: number[];
  /** Key/value snapshots for product env files (isolation keys excluded). */
  files: Record<string, Record<string, string>>;
  capturedAt: string;
};

export function isWorktreeIsolationPort(port: number): boolean {
  return (
    Number.isFinite(port) &&
    port >= WORKTREE_DB_PORT_MIN &&
    port <= WORKTREE_DB_PORT_MAX
  );
}

export function sanitizeComposeProjectName(phaseId: string): string {
  const raw = phaseId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `slopwt-${raw || "phase"}`;
}

/** Stable host port in 5500–5599 for a phase worktree (avoids 5432/5433/5434). */
export function allocateWorktreeDbPort(phaseId: string): number {
  const hash = createHash("sha1").update(phaseId).digest();
  return 5500 + (hash[0]! % 100);
}

function upsertEnvAssignment(body: string, key: string, value: string): string {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(body)) return body.replace(re, line);
  const trimmed = body.replace(/\s*$/, "");
  return trimmed ? `${trimmed}\n${line}\n` : `${line}\n`;
}

function stripEnvAssignment(body: string, key: string): string {
  return body
    .replace(new RegExp(`^${key}=.*\\r?\\n?`, "gm"), "")
    .replace(/\n{3,}/g, "\n\n");
}

function readEnvKey(body: string, key: string): string | undefined {
  const m = body.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m?.[1]?.trim();
}

function rewriteUrlPort(url: string, newPort: number): string {
  return url.replace(
    /(postgres(?:ql)?:\/\/[^/\s"']+?):(\d+)\b/i,
    `$1:${newPort}`,
  );
}

function patchUrlKeysInEnv(body: string, newPort: number): string {
  let next = body;
  for (const key of URL_ENV_KEYS) {
    const cur = readEnvKey(next, key);
    if (!cur) continue;
    const rewritten = rewriteUrlPort(cur, newPort);
    if (rewritten !== cur) {
      next = upsertEnvAssignment(next, key, rewritten);
    }
  }
  return next;
}

/**
 * Parse host ports published by compose files (`"5433:5432"`, `'5433:5432'`,
 * `${DB_PORT:-5433}:5432`).
 */
export function parseComposePublishedHostPorts(projectRoot: string): number[] {
  const ports = new Set<number>();
  for (const name of COMPOSE_FILES) {
    const path = join(projectRoot, name);
    if (!existsSync(path)) continue;
    let body = "";
    try {
      body = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    // "HOST:CONTAINER" or 'HOST:CONTAINER'
    for (const m of body.matchAll(/['"](\d{2,5}):\d{2,5}['"]/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && !isWorktreeIsolationPort(n)) {
        ports.add(n);
      }
    }
    // ${VAR:-DEFAULT}:container
    for (const m of body.matchAll(/\$\{[A-Z0-9_]+:-(\d{2,5})\}:\d{2,5}/g)) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0 && !isWorktreeIsolationPort(n)) {
        ports.add(n);
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * Derive product-owned DB host port: non-isolation `.env` DB_PORT → compose
 * published ports → DEFAULT_CANONICAL_DB_PORT.
 */
export function deriveCanonicalDbPort(projectRoot: string): number {
  const envPath = join(projectRoot, ".env");
  if (existsSync(envPath)) {
    try {
      const body = readFileSync(envPath, "utf-8");
      const raw = readEnvKey(body, "DB_PORT");
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0 && !isWorktreeIsolationPort(n)) {
        return n;
      }
    } catch {
      /* fall through */
    }
  }
  const published = parseComposePublishedHostPorts(projectRoot);
  if (published.length > 0) {
    // Prefer common postgres host ports, else first published
    for (const prefer of [5433, 5434, 5432]) {
      if (published.includes(prefer)) return prefer;
    }
    return published[0]!;
  }
  return DEFAULT_CANONICAL_DB_PORT;
}

function captureEnvFileKeys(
  projectRoot: string,
  rel: string,
  canonicalDbPort: number,
): Record<string, string> | null {
  const path = join(projectRoot, rel);
  if (!existsSync(path)) return null;
  let body = "";
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  for (const key of RUNTIME_ENV_KEYS) {
    if (key === "COMPOSE_PROJECT_NAME") continue;
    const val = readEnvKey(body, key);
    if (val === undefined) continue;
    if (key === "DB_PORT") {
      const n = Number(val);
      out[key] = String(
        Number.isFinite(n) && !isWorktreeIsolationPort(n)
          ? n
          : canonicalDbPort,
      );
      continue;
    }
    if ((URL_ENV_KEYS as readonly string[]).includes(key)) {
      out[key] = rewriteUrlPort(val, canonicalDbPort);
      continue;
    }
    out[key] = val;
  }
  // Always record canonical DB_PORT when any URL key or DB_PORT was present,
  // or when the file exists and looks like a DB env file.
  if (Object.keys(out).length > 0 || /DB_PORT|DATABASE_URL/i.test(body)) {
    out.DB_PORT = String(canonicalDbPort);
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function canonicalRuntimeEnvPath(projectRoot: string): string {
  return join(projectRoot, CANONICAL_RUNTIME_ENV_REL);
}

/**
 * Snapshot product-owned runtime ports/env before worktree isolation mutates
 * worktree `.env`. Heals isolation-range values already on root.
 */
export function snapshotCanonicalRuntimeEnv(
  projectRoot: string,
): CanonicalRuntimeEnv {
  const dbPort = deriveCanonicalDbPort(projectRoot);
  const published = new Set(parseComposePublishedHostPorts(projectRoot));
  published.add(dbPort);

  const files: Record<string, Record<string, string>> = {};
  for (const rel of [".env", ".env.local"] as const) {
    const keys = captureEnvFileKeys(projectRoot, rel, dbPort);
    if (keys) files[rel] = keys;
  }

  const snap: CanonicalRuntimeEnv = {
    dbPort,
    publishedPorts: [...published].sort((a, b) => a - b),
    files,
    capturedAt: new Date().toISOString(),
  };

  const path = canonicalRuntimeEnvPath(projectRoot);
  mkdirSync(join(projectRoot, ".slopcontrol"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`, "utf-8");
  return snap;
}

export function loadCanonicalRuntimeEnv(
  projectRoot: string,
): CanonicalRuntimeEnv | null {
  const path = canonicalRuntimeEnvPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as CanonicalRuntimeEnv;
    if (!raw || typeof raw.dbPort !== "number") return null;
    if (isWorktreeIsolationPort(raw.dbPort)) {
      // Corrupt snapshot — re-derive
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * Rewrite root `.env` / `.env.local` back to the canonical snapshot so
 * post-merge root verify never sees worktree isolation ports.
 */
export function restoreCanonicalRuntimeEnv(projectRoot: string): {
  restored: string[];
  dbPort: number;
  created: boolean;
} {
  let snap = loadCanonicalRuntimeEnv(projectRoot);
  let created = false;
  if (!snap) {
    snap = snapshotCanonicalRuntimeEnv(projectRoot);
    created = true;
  }

  const restored: string[] = [];
  for (const rel of Object.keys(snap.files)) {
    const keys = snap.files[rel];
    if (!keys || Object.keys(keys).length === 0) continue;
    const path = join(projectRoot, rel);
    let body = existsSync(path) ? readFileSync(path, "utf-8") : "";
    body = stripEnvAssignment(body, "COMPOSE_PROJECT_NAME");
    for (const [key, value] of Object.entries(keys)) {
      body = upsertEnvAssignment(body, key, value);
    }
    // Heal any leftover isolation-band URL ports even if key set was sparse
    body = patchUrlKeysInEnv(body, snap.dbPort);
    const dbRaw = readEnvKey(body, "DB_PORT");
    if (dbRaw !== undefined) {
      const n = Number(dbRaw);
      if (!Number.isFinite(n) || isWorktreeIsolationPort(n)) {
        body = upsertEnvAssignment(body, "DB_PORT", String(snap.dbPort));
      }
    }
    writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
    restored.push(rel);
  }

  // If snapshot had no files but root `.env` is poisoned, heal it anyway
  if (restored.length === 0) {
    const envPath = join(projectRoot, ".env");
    if (existsSync(envPath)) {
      let body = readFileSync(envPath, "utf-8");
      const raw = readEnvKey(body, "DB_PORT");
      const n = raw ? Number(raw) : NaN;
      if (
        (Number.isFinite(n) && isWorktreeIsolationPort(n)) ||
        readEnvKey(body, "COMPOSE_PROJECT_NAME")?.startsWith("slopwt-")
      ) {
        body = stripEnvAssignment(body, "COMPOSE_PROJECT_NAME");
        body = upsertEnvAssignment(body, "DB_PORT", String(snap.dbPort));
        body = patchUrlKeysInEnv(body, snap.dbPort);
        writeFileSync(envPath, body.endsWith("\n") ? body : `${body}\n`);
        restored.push(".env");
      }
    }
    const localPath = join(projectRoot, ".env.local");
    if (existsSync(localPath)) {
      let body = readFileSync(localPath, "utf-8");
      let changed = false;
      for (const key of URL_ENV_KEYS) {
        const cur = readEnvKey(body, key);
        if (!cur) continue;
        const m = cur.match(/:(\d{2,5})\b/);
        const port = m ? Number(m[1]) : NaN;
        if (Number.isFinite(port) && isWorktreeIsolationPort(port)) {
          body = upsertEnvAssignment(
            body,
            key,
            rewriteUrlPort(cur, snap.dbPort),
          );
          changed = true;
        }
      }
      const dbRaw = readEnvKey(body, "DB_PORT");
      const dbN = dbRaw ? Number(dbRaw) : NaN;
      if (Number.isFinite(dbN) && isWorktreeIsolationPort(dbN)) {
        body = upsertEnvAssignment(body, "DB_PORT", String(snap.dbPort));
        changed = true;
      }
      if (changed) {
        writeFileSync(
          localPath,
          body.endsWith("\n") ? body : `${body}\n`,
        );
        restored.push(".env.local");
      }
    }
  }

  return { restored, dbPort: snap.dbPort, created };
}

/**
 * Isolate worktree compose from project-root ports by writing a unique
 * COMPOSE_PROJECT_NAME + DB_PORT into the worktree `.env` (compose auto-loads it).
 */
export function applyWorktreeComposeIsolation(opts: {
  worktreePath: string;
  phaseId: string;
}): { dbPort: number; projectName: string; files: string[] } {
  const projectName = sanitizeComposeProjectName(opts.phaseId);
  const dbPort = allocateWorktreeDbPort(opts.phaseId);
  const files: string[] = [];

  const envPath = join(opts.worktreePath, ".env");
  let envBody = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
  envBody = upsertEnvAssignment(envBody, "COMPOSE_PROJECT_NAME", projectName);
  envBody = upsertEnvAssignment(envBody, "DB_PORT", String(dbPort));
  envBody = patchUrlKeysInEnv(envBody, dbPort);
  mkdirSync(opts.worktreePath, { recursive: true });
  writeFileSync(envPath, envBody.endsWith("\n") ? envBody : `${envBody}\n`);
  files.push(".env");

  const localPath = join(opts.worktreePath, ".env.local");
  if (existsSync(localPath)) {
    let localBody = readFileSync(localPath, "utf-8");
    localBody = upsertEnvAssignment(localBody, "DB_PORT", String(dbPort));
    localBody = patchUrlKeysInEnv(localBody, dbPort);
    writeFileSync(
      localPath,
      localBody.endsWith("\n") ? localBody : `${localBody}\n`,
    );
    files.push(".env.local");
  }

  return { dbPort, projectName, files };
}

/**
 * Before copying worktree env onto root, strip isolation keys and restore
 * canonical DB_PORT / URL ports. Never trusts an isolation-range value from
 * live root (which may already be poisoned).
 */
export function sanitizeWorktreeEnvForRootSync(
  worktreeBody: string,
  rootBody: string | null,
  opts?: { canonicalDbPort?: number },
): string {
  let next = stripEnvAssignment(worktreeBody, "COMPOSE_PROJECT_NAME");

  const rootPortRaw = rootBody ? readEnvKey(rootBody, "DB_PORT") : undefined;
  const rootPortNum = rootPortRaw ? Number(rootPortRaw) : NaN;
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
    next = upsertEnvAssignment(next, "DB_PORT", String(canonical));
    next = patchUrlKeysInEnv(next, canonical);
  } else {
    // Drop worktree-only / poisoned DB_PORT so root compose default applies
    next = stripEnvAssignment(next, "DB_PORT");
    // If worktree URLs still point at isolation ports, rewrite to default
    next = patchUrlKeysInEnv(next, DEFAULT_CANONICAL_DB_PORT);
  }
  return next;
}

/**
 * Stop compose services in a directory (e.g. phase worktree) so published
 * host ports are freed before project-root verify brings up the same stack.
 * Does not remove volumes (`down` without `-v`).
 */
export function tearDownComposeInDir(cwd: string): ComposeTeardownResult {
  const hasCompose = COMPOSE_FILES.some((f) => existsSync(join(cwd, f)));
  if (!hasCompose) {
    return { attempted: false, ok: true, output: "" };
  }

  const result = spawnSync(
    "docker",
    ["compose", "down", "--remove-orphans"],
    {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      env: process.env,
    },
  );

  const output = [result.stdout ?? "", result.stderr ?? ""]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (result.error) {
    return {
      attempted: true,
      ok: false,
      output: `docker compose down failed to start: ${result.error.message}${output ? `\n${output}` : ""}`,
    };
  }

  const code = result.status ?? 1;
  return {
    attempted: true,
    ok: code === 0,
    output:
      output ||
      (code === 0
        ? "docker compose down (no output)"
        : `docker compose down exited ${code}`),
  };
}

export function projectWorktreesDir(dataDir: string, projectId: string): string {
  return join(dataDir, "worktrees", projectId);
}

/**
 * Tear down compose in every phase worktree for a project.
 */
export function tearDownAllProjectWorktreeCompose(opts: {
  dataDir: string;
  projectId: string;
}): ComposeTeardownResult {
  const root = projectWorktreesDir(opts.dataDir, opts.projectId);
  if (!existsSync(root)) {
    return { attempted: false, ok: true, output: "" };
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return { attempted: false, ok: true, output: "" };
  }

  const lines: string[] = [];
  let attempted = false;
  let ok = true;
  for (const name of entries) {
    const dir = join(root, name);
    const r = tearDownComposeInDir(dir);
    if (!r.attempted) continue;
    attempted = true;
    if (!r.ok) ok = false;
    lines.push(`[${name}] ${r.output || (r.ok ? "ok" : "failed")}`);
  }
  return {
    attempted,
    ok,
    output: lines.join("\n"),
  };
}

/** Isolation ports allocated for each phase worktree dir name. */
export function collectWorktreeIsolationPorts(
  dataDir: string,
  projectId: string,
): number[] {
  const root = projectWorktreesDir(dataDir, projectId);
  if (!existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const ports = new Set<number>();
  for (const name of entries) {
    ports.add(allocateWorktreeDbPort(name));
    const envPath = join(root, name, ".env");
    if (!existsSync(envPath)) continue;
    try {
      const raw = readEnvKey(readFileSync(envPath, "utf-8"), "DB_PORT");
      const n = raw ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) ports.add(n);
    } catch {
      /* ignore */
    }
  }
  return [...ports];
}

/**
 * Stop containers whose compose working_dir lives under this project's
 * worktrees tree (covers pre-`slopwt-` leftover project names).
 */
export function stopComposeContainersUnderWorktrees(opts: {
  dataDir: string;
  projectId: string;
}): ComposeTeardownResult {
  const wtRoot = projectWorktreesDir(opts.dataDir, opts.projectId);
  const ps = spawnSync(
    "docker",
    [
      "ps",
      "--format",
      "{{.ID}}\t{{.Label \"com.docker.compose.project.working_dir\"}}\t{{.Names}}",
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  if (ps.error || (ps.status ?? 1) !== 0) {
    return {
      attempted: true,
      ok: false,
      output: `docker ps failed: ${ps.error?.message ?? ps.stderr ?? "exit"}`,
    };
  }
  const ids: string[] = [];
  const names: string[] = [];
  const prefix = wtRoot.endsWith("/") ? wtRoot : `${wtRoot}/`;
  for (const line of (ps.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [id, workingDir, name] = line.split("\t");
    if (!id) continue;
    const wd = (workingDir ?? "").trim();
    if (!wd) continue;
    if (wd === wtRoot || wd.startsWith(prefix)) {
      ids.push(id.trim());
      if (name) names.push(name.trim());
    }
  }
  if (ids.length === 0) {
    return {
      attempted: true,
      ok: true,
      output: `No compose containers under ${wtRoot}`,
    };
  }
  const stop = spawnSync("docker", ["stop", ...ids], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  return {
    attempted: true,
    ok: (stop.status ?? 1) === 0,
    output: [
      `Stopped ${ids.length} worktree compose container(s): ${names.join(", ") || ids.join(", ")}`,
      stop.stdout ?? "",
      stop.stderr ?? "",
    ]
      .filter(Boolean)
      .join("\n")
      .trim(),
  };
}

/** Read canonical DB port — never returns isolation-band values. */
export function resolvePublishedDbPort(projectRoot: string): number {
  const snap = loadCanonicalRuntimeEnv(projectRoot);
  if (snap && !isWorktreeIsolationPort(snap.dbPort)) return snap.dbPort;
  return deriveCanonicalDbPort(projectRoot);
}

export function freeHostPorts(ports: number[]): ComposeTeardownResult {
  const unique = [...new Set(ports.filter((p) => Number.isFinite(p) && p > 0))];
  if (unique.length === 0) {
    return { attempted: false, ok: true, output: "" };
  }
  const ps = spawnSync(
    "docker",
    ["ps", "--format", "{{.ID}}\t{{.Ports}}\t{{.Names}}"],
    { encoding: "utf-8", timeout: 30_000 },
  );
  if (ps.error || (ps.status ?? 1) !== 0) {
    return {
      attempted: true,
      ok: false,
      output: `docker ps failed: ${ps.error?.message ?? ps.stderr ?? "exit"}`,
    };
  }
  const ids: string[] = [];
  const names: string[] = [];
  const matchedPorts = new Set<number>();
  for (const line of (ps.stdout ?? "").split("\n")) {
    if (!line.trim()) continue;
    const [id, portsCol, name] = line.split("\t");
    if (!id) continue;
    for (const port of unique) {
      if ((portsCol ?? "").includes(`:${port}->`)) {
        ids.push(id.trim());
        if (name) names.push(name.trim());
        matchedPorts.add(port);
        break;
      }
    }
  }
  if (ids.length === 0) {
    return {
      attempted: true,
      ok: true,
      output: `No containers publishing host ports ${unique.join(", ")}`,
    };
  }
  const stop = spawnSync("docker", ["stop", ...ids], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  const output = [
    `Stopped ${ids.length} container(s) on :${[...matchedPorts].join(",:")}: ${names.join(", ") || ids.join(", ")}`,
    stop.stdout ?? "",
    stop.stderr ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    attempted: true,
    ok: (stop.status ?? 1) === 0,
    output,
  };
}

/** Parse one `docker ps --format` row (id, ports, name, working_dir, project). */
type DockerPsRow = {
  id: string;
  portsCol: string;
  name?: string;
  workingDir?: string;
  composeProject?: string;
};

/** Worktree ownership: working_dir under the worktrees tree, or slopwt-* compose project. */
export function dockerRowIsWorktreeOwned(
  row: Pick<DockerPsRow, "workingDir" | "composeProject">,
  worktreesRoot: string,
): boolean {
  const wtRoot = worktreesRoot.endsWith("/")
    ? worktreesRoot
    : `${worktreesRoot}/`;
  const wd = row.workingDir?.trim() ?? "";
  const cp = row.composeProject?.trim() ?? "";
  return (wd !== "" && wd.startsWith(wtRoot)) || (cp !== "" && cp.startsWith("slopwt-"));
}

/** Parse the tab-separated docker ps format used by the scoped frees. */
export function parseDockerPsRow(line: string): DockerPsRow | null {
  if (!line.trim()) return null;
  const [id, portsCol, name, workingDir, composeProject] = line.split("\t");
  if (!id) return null;
  return {
    id: id.trim(),
    portsCol: portsCol ?? "",
    name: name?.trim() || undefined,
    workingDir,
    composeProject,
  };
}

/**
 * Stop containers publishing the given host ports, restricted to containers
 * owned by this project's worktrees (working_dir under the worktrees tree,
 * or compose project name starting with slopwt-). Operator stacks on the
 * project root are never stopped.
 */
export function freeHostPortsScopedToWorktrees(opts: {
  ports: number[];
  worktreesRoot: string;
}): ComposeTeardownResult {
  const unique = [
    ...new Set(opts.ports.filter((p) => Number.isFinite(p) && p > 0)),
  ];
  if (unique.length === 0) {
    return { attempted: false, ok: true, output: "" };
  }
  const ps = spawnSync(
    "docker",
    [
      "ps",
      "--format",
      '{{.ID}}\t{{.Ports}}\t{{.Names}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project"}}',
    ],
    { encoding: "utf-8", timeout: 30_000 },
  );
  if (ps.error || (ps.status ?? 1) !== 0) {
    return {
      attempted: true,
      ok: false,
      output: `docker ps failed: ${ps.error?.message ?? ps.stderr ?? "exit"}`,
    };
  }
  const ids: string[] = [];
  const names: string[] = [];
  const matchedPorts = new Set<number>();
  for (const line of (ps.stdout ?? "").split("\n")) {
    const row = parseDockerPsRow(line);
    if (!row) continue;
    if (!dockerRowIsWorktreeOwned(row, opts.worktreesRoot)) continue;
    for (const port of unique) {
      if (row.portsCol.includes(`:${port}->`)) {
        ids.push(row.id);
        if (row.name) names.push(row.name);
        matchedPorts.add(port);
        break;
      }
    }
  }
  if (ids.length === 0) {
    return {
      attempted: true,
      ok: true,
      output: `No worktree-owned containers publishing host ports ${unique.join(", ")}`,
    };
  }
  const stop = spawnSync("docker", ["stop", ...ids], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  const output = [
    `Stopped ${ids.length} worktree container(s) on :${[...matchedPorts].join(",:")}: ${names.join(", ") || ids.join(", ")}`,
    stop.stdout ?? "",
    stop.stderr ?? "",
  ]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    attempted: true,
    ok: (stop.status ?? 1) === 0,
    output,
  };
}

/** Port-based stop is safe only for the SlopControl isolation band — those
 * ports are allocated by us, never by an operator stack. */
function splitPortsForTeardown(
  ports: number[],
): { isolation: number[]; canonical: number[] } {
  const isolation: number[] = [];
  const canonical: number[] = [];
  for (const p of ports) {
    (isWorktreeIsolationPort(p) ? isolation : canonical).push(p);
  }
  return { isolation, canonical };
}

/**
 * Stop containers publishing canonical product ports and worktree isolation
 * ports — scoped: isolation-band ports are port-matched (they're ours by
 * construction), canonical ports only stop worktree-owned containers (the
 * operator's stack at the project root is never killed mid-verify).
 * Does not trust a poisoned live root `.env` for the port list.
 */
export function freePublishedHostPorts(
  projectRoot: string,
  opts?: {
    dataDir?: string;
    projectId?: string;
    extraPorts?: number[];
  },
): ComposeTeardownResult {
  const ports = new Set<number>();
  ports.add(resolvePublishedDbPort(projectRoot));
  for (const p of parseComposePublishedHostPorts(projectRoot)) ports.add(p);
  const snap = loadCanonicalRuntimeEnv(projectRoot);
  if (snap) {
    for (const p of snap.publishedPorts) ports.add(p);
  }
  if (opts?.dataDir && opts?.projectId) {
    for (const p of collectWorktreeIsolationPorts(
      opts.dataDir,
      opts.projectId,
    )) {
      ports.add(p);
    }
  }
  for (const p of opts?.extraPorts ?? []) ports.add(p);

  const { isolation, canonical } = splitPortsForTeardown([...ports]);
  const out: ComposeTeardownResult[] = [];
  // Isolation band: port match alone is safe (SlopControl-allocated).
  if (isolation.length > 0) {
    out.push(freeHostPorts(isolation));
  }
  // Canonical ports: only worktree-owned containers may be stopped.
  if (canonical.length > 0 && opts?.dataDir && opts?.projectId) {
    out.push(
      freeHostPortsScopedToWorktrees({
        ports: canonical,
        worktreesRoot: projectWorktreesDir(opts.dataDir, opts.projectId),
      }),
    );
  }
  if (out.length === 0) {
    return { attempted: false, ok: true, output: "" };
  }
  return {
    attempted: out.some((r) => r.attempted),
    ok: out.every((r) => r.ok),
    output: out.map((r) => r.output).filter(Boolean).join("\n"),
  };
}

/**
 * Drop isolation-range DB_PORT / slopwt COMPOSE_PROJECT_NAME from a process
 * env map so root verify subprocesses cannot inherit worktree pollution.
 */
export function scrubIsolationKeysFromProcessEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  const db = next.DB_PORT;
  if (db !== undefined) {
    const n = Number(db);
    if (Number.isFinite(n) && isWorktreeIsolationPort(n)) {
      delete next.DB_PORT;
    }
  }
  const cpn = next.COMPOSE_PROJECT_NAME;
  if (typeof cpn === "string" && cpn.startsWith("slopwt-")) {
    delete next.COMPOSE_PROJECT_NAME;
  }
  for (const key of URL_ENV_KEYS) {
    const val = next[key];
    if (typeof val !== "string") continue;
    const m = val.match(/:(\d{2,5})\b/);
    const port = m ? Number(m[1]) : NaN;
    if (Number.isFinite(port) && isWorktreeIsolationPort(port)) {
      delete next[key];
    }
  }
  return next;
}

/** Same scrub for plain string maps (verify overlays). */
export function scrubIsolationKeysFromEnvRecord(
  env: Record<string, string>,
): Record<string, string> {
  const scrubbed = scrubIsolationKeysFromProcessEnv(env);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubbed)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
