import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeProjectConfig } from "@slopcontrol/artifacts";
import { ProjectConfigSchema, type Project } from "@slopcontrol/types";
import {
  DEFAULT_CHECK_TIMEOUT_MS,
  resolveCheckTimeoutMs,
  runCommandWithTimeout,
  runSuccessChecks,
  type CommandRunner,
} from "./index.js";

describe("resolveCheckTimeoutMs", () => {
  it("gives a real workspace testCommand room to finish (no 60s kill)", () => {
    // The repo's own `npm test` runs ~65s: a 60s ceiling killed a passing
    // suite with exit 124, which the failure classifier misread as a missing
    // `timeout` host utility. Keep the default comfortably above that.
    assert.ok(
      DEFAULT_CHECK_TIMEOUT_MS >= 180_000,
      `default check budget too small: ${DEFAULT_CHECK_TIMEOUT_MS}ms`,
    );
    const saved = process.env.SLOPCONTROL_CHECK_MS;
    try {
      delete process.env.SLOPCONTROL_CHECK_MS;
      assert.equal(resolveCheckTimeoutMs(), DEFAULT_CHECK_TIMEOUT_MS);
      process.env.SLOPCONTROL_CHECK_MS = "12345";
      assert.equal(resolveCheckTimeoutMs(), 12_345);
      process.env.SLOPCONTROL_CHECK_MS = "0";
      assert.equal(resolveCheckTimeoutMs(), DEFAULT_CHECK_TIMEOUT_MS);
      process.env.SLOPCONTROL_CHECK_MS = "not-a-number";
      assert.equal(resolveCheckTimeoutMs(), DEFAULT_CHECK_TIMEOUT_MS);
    } finally {
      if (saved === undefined) delete process.env.SLOPCONTROL_CHECK_MS;
      else process.env.SLOPCONTROL_CHECK_MS = saved;
    }
  });
});

/** Read body of a temp check script invoked as `bash '/path/check.sh'`. */
function checkScriptBody(command: string): string | null {
  const m = /\b(?:bash|zsh|node)\s+'([^']+)'/.exec(command)
    ?? /\bnpx\s+--yes\s+tsx\s+'([^']+)'/.exec(command);
  if (!m?.[1]) return null;
  try {
    return readFileSync(m[1], "utf8");
  } catch {
    return null;
  }
}

function fakeProject(rootPath: string): Project {
  return {
    id: "proj-test",
    name: "test",
    rootPath,
    blueprintVersion: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeConfig(
  root: string,
  partial: Parameters<typeof ProjectConfigSchema.parse>[0],
): void {
  writeProjectConfig(root, ProjectConfigSchema.parse(partial));
}

function validPhaseDoc(checks = "npm test -- tests/docker.test.ts"): string {
  return `# Phase

## Scope

Fix it

## File Changes

- file.ts

## Success Criteria

Works

## Automated Checks

\`\`\`bash
${checks}
\`\`\`
`;
}

describe("runCommandWithTimeout", () => {
  it("kills hung commands and returns CHECK_TIMEOUT", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-check-timeout-"));
    try {
      const started = Date.now();
      const result = await runCommandWithTimeout(
        "sleep 30",
        root,
        process.env,
        200,
      );
      const elapsed = Date.now() - started;
      assert.notEqual(result.exitCode, 0);
      assert.match(result.output, /CHECK_TIMEOUT after 200ms/);
      assert.ok(elapsed < 5000, `expected quick kill, took ${elapsed}ms`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runSuccessChecks", () => {
  it("surfaces firstFailure and summary for the failing step", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-firstfail-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("npx tsc --noEmit || exit 1"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            if (command === "npm test") {
              return { output: "ok\n", exitCode: 0 };
            }
            const body = checkScriptBody(command);
            if (body?.includes("tsc")) {
              return {
                output: "error TS2304: Cannot find name 'Foo'.\n",
                exitCode: 2,
              };
            }
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, false);
      assert.ok(result.firstFailure);
      assert.equal(result.firstFailure?.name, "automatedCheck");
      assert.match(result.summary, /FAILING STEP/);
      assert.match(result.summary, /TS2304/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when testCommand exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-checks-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const phaseDoc = validPhaseDoc();

      const calls: string[] = [];
      const runner: CommandRunner = async (command) => {
        calls.push(command);
        if (command === "echo build-ok") {
          return { output: "build-ok\n", exitCode: 0 };
        }
        if (command === "npm test") {
          return { output: "FAIL tests\n", exitCode: 1 };
        }
        return { output: "ok\n", exitCode: 0 };
      };

      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        runner,
      });
      assert.equal(result.ok, false);
      assert.match(result.output, /testCommand/);
      assert.ok(calls.includes("npm test"));
      assert.ok(!calls.includes("npm test -- tests/docker.test.ts"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs automated checks after tests and fails on check error", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-auto-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const phaseDoc = validPhaseDoc();

      const runner: CommandRunner = async (command) => {
        if (command === "echo build-ok" || command === "npm test") {
          return { output: "ok\n", exitCode: 0 };
        }
        const body = checkScriptBody(command);
        if (body?.includes("docker.test.ts")) {
          return { output: "ENOENT regression failed\n", exitCode: 2 };
        }
        return { output: "", exitCode: 0 };
      };

      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        runner,
      });
      assert.equal(result.ok, false);
      assert.match(result.output, /automatedCheck/);
      assert.match(result.output, /ENOENT/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when PHASE.md lacks Automated Checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-phase-gate-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(join(root, "package.json"), "{}\n");
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
      });

      const result = await runSuccessChecks(
        fakeProject(root),
        "# Phase\n\n## Success Criteria\n\nManual only.\n",
        root,
        {
          runner: async () => ({ output: "ok\n", exitCode: 0 }),
        },
      );
      assert.equal(result.ok, false);
      assert.match(result.output, /Automated Checks/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify mode runs verifyPreflightCommand before testCommand", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-preflight-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo should-not-run",
        testCommand: "npm test",
        verifyPreflightCommand: "echo preflight-ok",
      });

      const phaseDoc = validPhaseDoc("echo auto-ok");
      const calls: string[] = [];
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        runner: async (command) => {
          calls.push(command);
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, true, result.output);
      assert.deepEqual(
        calls.filter((c) => !/^bash\s+'/.test(c)).slice(0, 2),
        ["echo preflight-ok", "npm test"],
      );
      assert.ok(calls.some((c) => /^bash\s+'/.test(c)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs npm deps before testCommand when node_modules is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-deps-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }),
      );
      writeFileSync(join(root, "package-lock.json"), "{}\n");
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const calls: string[] = [];
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            calls.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(
        calls.includes("npm ci --no-audit --no-fund"),
        `expected npm ci, got: ${calls.join(" | ")}`,
      );
      const ciIdx = calls.indexOf("npm ci --no-audit --no-fund");
      const testIdx = calls.indexOf("npm test");
      assert.ok(ciIdx >= 0 && testIdx > ciIdx);
      assert.ok(result.steps.some((s) => s.name === "deps-install"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("installs deps before build when node_modules is missing (build mode)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-deps-build-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "demo",
          packageManager: "pnpm@9.15.0",
          scripts: { build: "tsup" },
        }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeConfig(root, {
        buildCommand: "npm run build",
        testCommand: "npm test",
      });

      const calls: string[] = [];
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "build",
          runner: async (command) => {
            calls.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(
        calls.includes("CI=1 pnpm install --frozen-lockfile"),
        `expected pnpm install before build, got: ${calls.join(" | ")}`,
      );
      const installIdx = calls.indexOf("CI=1 pnpm install --frozen-lockfile");
      const buildIdx = calls.indexOf("npm run build");
      assert.ok(
        installIdx >= 0 && buildIdx > installIdx,
        `install must precede build: ${calls.join(" | ")}`,
      );
      assert.ok(result.steps.some((s) => s.name === "deps-install"));
      assert.ok(result.steps.some((s) => s.name === "build"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses pnpm install when pnpm-lock.yaml is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-deps-pnpm-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          name: "demo",
          packageManager: "pnpm@9.15.0",
          scripts: { test: "echo ok" },
        }),
      );
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const calls: string[] = [];
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            calls.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(
        calls.includes("CI=1 pnpm install --frozen-lockfile"),
        `expected pnpm install, got: ${calls.join(" | ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reinstalls when package.json is newer than stale node_modules", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-deps-stale-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const old = new Date("2020-01-01T00:00:00Z");
      utimesSync(join(root, "node_modules"), old, old);
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }),
      );
      writeFileSync(join(root, "package-lock.json"), "{}\n");
      // Ensure manifests are newer than node_modules
      const now = new Date();
      utimesSync(join(root, "package.json"), now, now);
      utimesSync(join(root, "package-lock.json"), now, now);
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const calls: string[] = [];
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            calls.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(
        calls.includes("npm ci --no-audit --no-fund"),
        `expected reinstall for stale nm, got: ${calls.join(" | ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("forceDepsInstall runs install even when node_modules looks fresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-deps-force-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ name: "demo", scripts: { test: "echo ok" } }),
      );
      writeFileSync(join(root, "package-lock.json"), "{}\n");
      mkdirSync(join(root, "node_modules"), { recursive: true });
      const now = new Date();
      utimesSync(join(root, "node_modules"), now, now);
      const old = new Date("2020-01-01T00:00:00Z");
      utimesSync(join(root, "package.json"), old, old);
      utimesSync(join(root, "package-lock.json"), old, old);
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const callsWithoutForce: string[] = [];
      await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            callsWithoutForce.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.ok(
        !callsWithoutForce.some((c) => c.includes("npm ci") || c.includes("npm install")),
        `fresh nm should skip install without force, got: ${callsWithoutForce.join(" | ")}`,
      );

      const callsForced: string[] = [];
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          forceDepsInstall: true,
          runner: async (command) => {
            callsForced.push(command);
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(
        callsForced.includes("npm ci --no-audit --no-fund"),
        `forceDepsInstall should install, got: ${callsForced.join(" | ")}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails verify when verifyPreflightCommand exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-preflight-fail-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build",
        testCommand: "npm test",
        verifyPreflightCommand: "echo deps-down",
      });

      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async (command) => {
            if (command === "echo deps-down") {
              return { output: "not ready\n", exitCode: 1 };
            }
            return { output: "ok\n", exitCode: 0 };
          },
        },
      );
      assert.equal(result.ok, false);
      assert.match(result.output, /verifyPreflightCommand FAILED/);
      assert.match(result.output, /infrastructure/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify mode skips build but still runs tests", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-verify-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo should-not-run",
        testCommand: "npm test",
      });

      const phaseDoc = validPhaseDoc("echo auto-ok");

      const calls: string[] = [];
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        runner: async (command) => {
          calls.push(command);
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, true, result.output);
      assert.ok(!calls.includes("echo should-not-run"));
      assert.ok(calls.includes("npm test"));
      assert.ok(calls.some((c) => /^bash\s+'/.test(c)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("failing multi-line check reports the full body, not just the first line", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-multiline-check-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build",
        testCommand: "echo tests-ok",
      });

      // First line passes and prints matches; the LAST line fails — the
      // phase-29 attribution bug labeled the cell by the first line only.
      const phaseDoc = validPhaseDoc(`grep -n "handleNewChat" file.ts | head -5
awk '/x/,/y/' file.ts | grep -q 'a.*b.*c' || exit 1`);
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        // Legacy doc written before the brittle-chain guard existed.
        skipPhaseDocValidation: true,
        runner: async (command) =>
          // Only the automated check (run via bash '...') fails.
          /^bash\s+'/.test(command)
            ? { output: "52: match\n", exitCode: 1 }
            : { output: "ok\n", exitCode: 0 },
      });
      assert.equal(result.ok, false);
      assert.ok(result.firstFailure, "expected a firstFailure step");
      assert.match(
        result.firstFailure!.command ?? "",
        /full check body/,
        "failing step should embed the full check body",
      );
      assert.match(result.firstFailure!.command ?? "", /awk '\/x\/,\/y\/'/);
      assert.match(
        result.firstFailure!.output,
        /failing line is the LAST command/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("confirmatory verify skips duplicate PHASE automated checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-confirmatory-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
      });
      const phaseDoc = validPhaseDoc("echo should-not-run");
      const calls: string[] = [];
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        confirmatory: true,
        skipPhaseDocValidation: true,
        runner: async (command) => {
          calls.push(command);
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, true, result.output);
      assert.deepEqual(calls, ["echo tests-ok"]);
      assert.match(result.output, /Confirmatory root verify/i);
      assert.doesNotMatch(result.output, /automatedCheck \(should-not-run\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("build mode runs build but skips testCommand and automated checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-build-gate-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "npm test",
      });

      const phaseDoc = validPhaseDoc();

      const calls: string[] = [];
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "build",
        runner: async (command) => {
          calls.push(command);
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, true, result.output);
      assert.deepEqual(calls, ["echo build-ok"]);
      assert.match(result.output, /deferred to project root/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify mode fails when Ollama Cloud models lack a tag", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ollama-gate-"));
    const prev = process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
    process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = "1";
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, ".env.docker"),
        "OLLAMA_BASE_URL=https://api.ollama.cloud/v1\nAI_CHAT_MODEL=glm-5.2\n",
      );
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
        llmSmokeMode: "live",
      });

      const phaseDoc = validPhaseDoc("echo auto-ok");

      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        runner: async () => ({ output: "ok\n", exitCode: 0 }),
      });
      assert.equal(result.ok, false, result.output);
      assert.match(result.output, /Ollama Cloud model IDs missing/);
    } finally {
      if (prev === undefined) delete process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
      else process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("verify mode skips cloud smoke by default (llmSmokeMode=off)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-smoke-off-"));
    // Host shells / pipeline env set SLOPCONTROL_LLM_PROFILE + OLLAMA_* overrides
    // deliberately (operator escape hatch). Isolate them so the config-declared
    // fixture profile is what this case actually exercises.
    const overlayKeys = [
      "SLOPCONTROL_LLM_PROFILE",
      "OLLAMA_BASE_URL",
      "OLLAMA_API_KEY",
      "AI_CHAT_MODEL",
      "AI_CODE_MODEL",
    ] as const;
    const savedEnv = new Map<string, string | undefined>();
    for (const key of overlayKeys) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeFileSync(
        join(root, ".env.docker"),
        "OLLAMA_BASE_URL=https://api.ollama.cloud/v1\nAI_CHAT_MODEL=glm-5.2\n",
      );
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
        llmTestProfile: "fixture",
        llmSmokeMode: "off",
      });
      const result = await runSuccessChecks(
        fakeProject(root),
        validPhaseDoc("echo auto-ok"),
        root,
        {
          mode: "verify",
          runner: async () => ({ output: "ok\n", exitCode: 0 }),
        },
      );
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /llmSmokeMode=off/);
      assert.match(result.output, /LLM test profile: fixture/);
    } finally {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when automated check prints FAIL with exit 0", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-soft-fail-"));
    const prev = process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
    process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = "1";
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build",
        testCommand: "echo tests-ok",
      });
      const phaseDoc = validPhaseDoc(
        'grep -q missing file || echo "FAIL: missing"',
      );
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        mode: "verify",
        runner: async (command) => {
          const body = checkScriptBody(command);
          if (body?.includes("FAIL")) {
            return { output: "FAIL: missing\n", exitCode: 0 };
          }
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, false);
      assert.match(result.output, /printed FAIL/i);
    } finally {
      if (prev === undefined) delete process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE;
      else process.env.SLOPCONTROL_SKIP_OLLAMA_SMOKE = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("empty automated-checks gate", () => {
  it("fails when File Changes declares code but no check cells exist (skip-validation path)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-empty-suite-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
      });

      const phaseDoc = `# Phase

## Scope

Add the auth-events audit table.

## File Changes

- src/lib/db/schema.ts — EDIT (add authEvents table)
- src/lib/admin/routes.ts — NEW

## Success Criteria

- The audit table exists.

## Automated Checks

No automated checks required (manual review only).
`;

      const calls: string[] = [];
      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        skipPhaseDocValidation: true,
        runner: async (command) => {
          calls.push(command);
          return { output: "ok\n", exitCode: 0 };
        },
      });
      assert.equal(result.ok, false);
      assert.ok(result.firstFailure);
      assert.equal(result.firstFailure?.name, "automatedCheck-empty-suite");
      assert.match(result.firstFailure?.output ?? "", /zero runnable cells/);
      assert.match(result.output, /EMPTY-SUITE REJECTED/);
      assert.ok(
        !calls.some((c) => checkScriptBody(c)),
        "no check cell should ever run for an empty suite",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not fire for doc-only phases (planning artifacts in File Changes)", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-doconly-"));
    try {
      mkdirSync(join(root, ".slopcontrol"), { recursive: true });
      writeConfig(root, {
        buildCommand: "echo build-ok",
        testCommand: "echo tests-ok",
      });

      const phaseDoc = `# Phase

## Scope

Doc-only research consolidation.

## File Changes

- .slopcontrol/phases/01-x/RESEARCH.md — EDIT

## Success Criteria

- Research consolidated.

## Automated Checks

No automated checks.
`;

      const result = await runSuccessChecks(fakeProject(root), phaseDoc, root, {
        skipPhaseDocValidation: true,
        runner: async () => ({ output: "ok\n", exitCode: 0 }),
      });
      assert.equal(result.ok, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
