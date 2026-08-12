import {
  readProjectConfig,
  resolveProjectToolchain,
  runToolchainCommand,
} from "@slopcontrol/artifacts";

export type EnvSyncResult =
  | { ok: false; reason: "no-env-sync-cmd" }
  | {
      ok: boolean;
      command: string[];
      code: number;
      stdoutTail: string;
    };

export const NO_ENV_SYNC_HINT =
  "No envSyncCmd resolved for this project — add a `manage` script with an `env sync` subcommand, or persist toolchain.envSyncCmd via PUT /projects/:id/build-process/toolchain";

/**
 * Run the project-native env sync at the project root. The project owns
 * merge semantics; SlopControl only orchestrates the invocation.
 */
export async function runProjectEnvSync(opts: {
  projectRoot: string;
  runner?: typeof runToolchainCommand;
}): Promise<EnvSyncResult> {
  const config = readProjectConfig(opts.projectRoot);
  const { spec } = resolveProjectToolchain({
    projectRoot: opts.projectRoot,
    configured: config.toolchain ?? null,
  });
  if (!spec?.envSyncCmd) {
    return { ok: false, reason: "no-env-sync-cmd" };
  }
  const run = opts.runner ?? runToolchainCommand;
  const result = await run({
    cmd: spec.envSyncCmd,
    cwd: opts.projectRoot,
    timeoutMs: 120_000,
  });
  return {
    ok: result.code === 0,
    command: spec.envSyncCmd,
    code: result.code,
    stdoutTail: (result.stdout || result.stderr || "").slice(-2_000),
  };
}
