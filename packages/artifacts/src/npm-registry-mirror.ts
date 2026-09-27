/**
 * Upstream mirror for the local private npm registry — republishes packages
 * to a hosted registry (GitHub Packages by default) so off-machine builds
 * (Vercel, cloud CI) can resolve private scopes. The local Verdaccio listens
 * on loopback only; without a mirror, any build outside this machine fails
 * with ECONNREFUSED on 127.0.0.1:4873.
 *
 * Config: `<dataDir>/npm-registry-mirror.json`
 *   {
 *     "enabled": true,
 *     "registryUrl": "https://npm.pkg.github.com/",
 *     "owner": "jamroast",
 *     "token": "${GITHUB_PACKAGES_TOKEN}",
 *     "scopes": ["@jamroast"]
 *   }
 *
 * The token supports ${ENV_VAR} placeholders resolved from process.env (the
 * daemon loads the monorepo root .env / ~/.slopcontrol/.env at startup), so
 * the secret never sits in the config file.
 *
 * GitHub Packages constraint: the npm scope MUST match the owner — a package
 * named @other/foo cannot publish under owner "jamroast". Such packages are
 * skipped with an explicit reason (rename the package under @owner, or point
 * its scope at the matching GitHub org).
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runToolchainCommand } from "./build-toolchain.js";

export const NPM_REGISTRY_MIRROR_FILENAME = "npm-registry-mirror.json";
export const DEFAULT_MIRROR_REGISTRY_URL = "https://npm.pkg.github.com/";

export const NpmRegistryMirrorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Upstream registry URL (default: GitHub Packages npm endpoint). */
  registryUrl: z.string().min(1).default(DEFAULT_MIRROR_REGISTRY_URL),
  /** GitHub owner (user/org). npm scopes must match this to publish. */
  owner: z.string().min(1),
  /** Token with write:packages — ${ENV_VAR} placeholders resolved at load. */
  token: z.string().min(1),
  /** Scopes to mirror (default [@owner]). */
  scopes: z.array(z.string().min(1)).optional(),
});
export type NpmRegistryMirrorConfig = z.infer<typeof NpmRegistryMirrorConfigSchema>;

export type ResolvedNpmRegistryMirror =
  | { status: "off" }
  | { status: "invalid"; reason: string }
  | {
      status: "ready";
      config: {
        registryUrl: string;
        owner: string;
        token: string;
        scopes: string[];
      };
    };

export function npmRegistryMirrorPath(dataDir: string): string {
  return join(dataDir, NPM_REGISTRY_MIRROR_FILENAME);
}

/** Resolve ${VAR} placeholders from env; returns unresolved var names. */
function substituteEnv(
  value: string,
  env: NodeJS.ProcessEnv,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Z0-9_]+)\}/gi, (whole, name: string) => {
    const v = env[name];
    if (v === undefined || v === "") {
      missing.push(name);
      return whole;
    }
    return v;
  });
  return { value: out, missing };
}

/**
 * Load + resolve the mirror config. Missing file or enabled:false → off.
 * Present but broken (bad JSON, schema violation, unresolved token env) →
 * invalid with an operator-facing reason. Never throws.
 */
export function resolveNpmRegistryMirror(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedNpmRegistryMirror {
  const path = npmRegistryMirrorPath(dataDir);
  if (!existsSync(path)) return { status: "off" };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return {
      status: "invalid",
      reason: `${NPM_REGISTRY_MIRROR_FILENAME}: bad JSON — ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = NpmRegistryMirrorConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "invalid",
      reason: `${NPM_REGISTRY_MIRROR_FILENAME}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    };
  }
  if (!parsed.data.enabled) return { status: "off" };
  const token = substituteEnv(parsed.data.token, env);
  if (token.missing.length > 0) {
    return {
      status: "invalid",
      reason:
        `${NPM_REGISTRY_MIRROR_FILENAME}: token references unset env var(s) ` +
        `${token.missing.join(", ")} — set them in ~/.slopcontrol/.env and restart the server`,
    };
  }
  const owner = parsed.data.owner.trim();
  const scopes = (
    parsed.data.scopes?.length ? parsed.data.scopes : [`@${owner}`]
  ).map((s) => s.trim().toLowerCase());
  const registryUrl = parsed.data.registryUrl.trim();
  return {
    status: "ready",
    config: {
      registryUrl: registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`,
      owner,
      token: token.value,
      scopes,
    },
  };
}

export type MirrorPublishResult = {
  mirrored: boolean;
  /** True when the upstream already has name@version (409) — treated as ok. */
  alreadyMirrored?: boolean;
  name: string;
  version: string;
  registryUrl?: string;
  reason?: string;
  stdout?: string;
};

const MIRROR_REPUBLISH_RE =
  /409|EPUBLISHCONFLICT|cannot publish over|previously published|already exists/i;

function readPkgNameVersion(packageDir: string): { name: string; version: string } {
  const pkg = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf-8"),
  ) as { name?: string; version?: string };
  if (!pkg.name) throw new Error(`package.json missing name in ${packageDir}`);
  return { name: pkg.name, version: pkg.version ?? "0.0.0" };
}

/**
 * Mirror-publish an already-built package directory to the upstream registry.
 * Best-effort: never throws for publish failures — the local publish already
 * succeeded, so problems surface in the result for the operator to act on.
 *
 * Auth mechanics: npm config precedence puts a package-dir .npmrc ABOVE
 * --userconfig, and the local .npmrc maps our scopes to 127.0.0.1:4873 — so
 * the scope→upstream mapping goes through env (npm_config_<scope>:registry
 * beats project .npmrc), while the token travels in a temp --userconfig file
 * (host-scoped auth line, mode 0600, deleted afterwards).
 */
export async function mirrorPackageToUpstream(opts: {
  packageDir: string;
  mirror: { registryUrl: string; owner: string; token: string; scopes: string[] };
  runner?: typeof runToolchainCommand;
  timeoutMs?: number;
}): Promise<MirrorPublishResult> {
  const runner = opts.runner ?? runToolchainCommand;
  const { name, version } = readPkgNameVersion(opts.packageDir);
  const scope = name.match(/^(@[\w.-]+)\//)?.[1]?.toLowerCase();
  const registryUrl = opts.mirror.registryUrl;
  if (!scope || !opts.mirror.scopes.includes(scope)) {
    return {
      mirrored: false,
      name,
      version,
      registryUrl,
      reason: `scope ${scope ?? "(unscoped)"} is not in mirror scopes [${opts.mirror.scopes.join(", ")}] — not mirrored`,
    };
  }
  const ownerScope = `@${opts.mirror.owner.toLowerCase()}`;
  if (scope !== ownerScope) {
    return {
      mirrored: false,
      name,
      version,
      registryUrl,
      reason:
        `GitHub Packages requires the npm scope to match the owner: ${scope} ` +
        `cannot publish under owner "${opts.mirror.owner}". Rename the package ` +
        `to ${ownerScope}/${name.split("/")[1]} (and update consumers), or ` +
        `remove this scope from the mirror config.`,
    };
  }

  let host: string;
  try {
    host = new URL(registryUrl).host;
  } catch {
    return {
      mirrored: false,
      name,
      version,
      registryUrl,
      reason: `mirror registryUrl is not a valid URL: ${registryUrl}`,
    };
  }

  const tmp = mkdtempSync(join(tmpdir(), "sc-npm-mirror-"));
  const userconfig = join(tmp, ".npmrc");
  writeFileSync(userconfig, `//${host}/:_authToken=${opts.mirror.token}\n`, {
    mode: 0o600,
  });
  try {
    const r = await runner({
      cmd: ["npm", "publish", "--registry", registryUrl, "--userconfig", userconfig],
      cwd: opts.packageDir,
      env: {
        npm_config_registry: registryUrl,
        // Scoped mapping via env beats the package-dir .npmrc loopback lines.
        [`npm_config_${scope}:registry`]: registryUrl,
        npm_config_always_auth: "true",
      },
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
      redactSecrets: [opts.mirror.token],
    });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      if (MIRROR_REPUBLISH_RE.test(out)) {
        return {
          mirrored: true,
          alreadyMirrored: true,
          name,
          version,
          registryUrl,
          reason: `${name}@${version} already on upstream (409) — treated as mirrored`,
        };
      }
      return {
        mirrored: false,
        name,
        version,
        registryUrl,
        reason: `mirror publish failed (${r.code}): ${out.trim().slice(0, 600)}`,
      };
    }
    return {
      mirrored: true,
      name,
      version,
      registryUrl,
      stdout: r.stdout.trim().slice(0, 1_000),
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolve the mirror config and (when ready) mirror-publish. Returns null
 * when mirroring is off; an unmirrored result (with reason) when the config
 * is invalid. Shared by all publish flows after a successful local publish.
 */
export async function mirrorAfterLocalPublish(opts: {
  dataDir: string;
  packageDir: string;
  runner?: typeof runToolchainCommand;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MirrorPublishResult | null> {
  const resolved = resolveNpmRegistryMirror(opts.dataDir, opts.env);
  if (resolved.status === "off") return null;
  if (resolved.status === "invalid") {
    let name = "(unknown)";
    let version = "0.0.0";
    try {
      ({ name, version } = readPkgNameVersion(opts.packageDir));
    } catch {
      /* keep placeholders */
    }
    return {
      mirrored: false,
      name,
      version,
      reason: `mirror not configured correctly — ${resolved.reason}`,
    };
  }
  return mirrorPackageToUpstream({
    packageDir: opts.packageDir,
    mirror: resolved.config,
    runner: opts.runner,
    timeoutMs: opts.timeoutMs,
  });
}
