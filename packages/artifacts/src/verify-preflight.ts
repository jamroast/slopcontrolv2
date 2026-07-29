export type PreflightCommandRunner = (
  command: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
) => Promise<{ output: string; exitCode: number }>;

export type PreflightResult = {
  ok: boolean;
  skipped: boolean;
  command?: string;
  output: string;
};

/**
 * Run an optional project-configured preflight before root tests.
 *
 * Generic by design: whatever `verifyPreflightCommand` the project sets
 * (compose health, cache ping, custom smoke, etc.). SlopControl does not
 * hardcode a particular database or service — Postgres is only one example
 * of a runtime dependency that may be down.
 *
 * When unset, preflight is skipped — infra failures still surface via test
 * output and the failure classifier (ECONNREFUSED, unreachable hosts, …).
 */
export async function runVerifyPreflight(
  cwd: string,
  command: string | undefined,
  runner: PreflightCommandRunner,
): Promise<PreflightResult> {
  const trimmed = command?.trim();
  if (!trimmed) {
    return {
      ok: true,
      skipped: true,
      output: "verifyPreflightCommand unset — skipped.",
    };
  }

  const result = await runner(trimmed, cwd);
  const ok = result.exitCode === 0;
  return {
    ok,
    skipped: false,
    command: trimmed,
    output: ok
      ? `verifyPreflightCommand OK (${trimmed}):\n${result.output.slice(-1500)}`
      : [
          `verifyPreflightCommand FAILED (${trimmed}) — runtime dependency not ready.`,
          "This is infrastructure, not an application bug. Bring services up (or fix the preflight), then retry.",
          "Do not burn coding iterations inventing app scripts to paper over missing local services.",
          result.output.slice(-2000),
        ].join("\n"),
  };
}
