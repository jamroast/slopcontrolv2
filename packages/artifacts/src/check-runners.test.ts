import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  extractCheckCells,
  createDefaultCheckRegistry,
  parseFenceInfo,
  normalizeCheckLanguage,
  validatePhaseDocForDev,
  stripRedundantCwdCd,
  hasEchoExitCodeCaptureAntipattern,
  hasAbsoluteCdInCheck,
  hasGnuTimeoutInCheck,
  hasLongLivedServerInCheck,
  hasBackgroundWaitHangAntipattern,
  hasBrittleSameLineGrepChain,
  hasVitestGrepQuietAntipattern,
  unwrapGrepQuietPipe,
  stripRedundantTestServicesBringUp,
  SLOPCONTROL_TEST_SERVICES_READY_ENV,
} from "./index.js";

function phaseWithCheck(body: string): string {
  return `# Phase demo

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
${body}
\`\`\`
`;
}

describe("check cells", () => {
  it("extractCheckCells keeps assign+if fence as one cell", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`bash
CHAT_MODEL=$(grep -E '^AI_CHAT_MODEL=' .env.docker | cut -d= -f2-)
CODE_MODEL=$(grep -E '^AI_CODE_MODEL=' .env.docker | cut -d= -f2-)
if [ "$CHAT_MODEL" = "$CODE_MODEL" ]; then
  echo "FAIL: AI_CHAT_MODEL=$CHAT_MODEL == AI_CODE_MODEL=$CODE_MODEL (RC-DEADLOCK)"
  exit 1
fi
echo "PASS: distinct models"
\`\`\`
`;
    const cells = extractCheckCells(doc);
    assert.equal(cells.length, 1);
    assert.equal(cells[0]!.language, "bash");
    assert.match(cells[0]!.body, /CHAT_MODEL=/);
    assert.match(cells[0]!.body, /RC-DEADLOCK/);
    assert.equal(validatePhaseDocForDev(doc).ok, true);
  });

  it("parseFenceInfo reads language and cmd meta", () => {
    assert.deepEqual(parseFenceInfo("python cmd=python3"), {
      language: "python",
      meta: { cmd: "python3" },
    });
    assert.equal(normalizeCheckLanguage("ts"), "typescript");
    assert.equal(normalizeCheckLanguage("shell"), "bash");
  });

  it("rejects unknown language without cmd=", () => {
    const doc = `# Phase

## Scope
x

## File Changes
- a.ts

## Success Criteria
ok

## Automated Checks

\`\`\`ruby
puts "hi"
\`\`\`
`;
    const gate = validatePhaseDocForDev(doc);
    assert.equal(gate.ok, false);
    assert.ok(gate.issues.some((i) => /no runner registered|cmd=/i.test(i)));
  });

  it("runs multi-line shell cell once against .env.docker", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-cell-run-"));
    try {
      writeFileSync(
        join(root, ".env.docker"),
        "AI_CHAT_MODEL=glm-5.2\nAI_CODE_MODEL=qwen2.5-coder\n",
      );
      const cell = extractCheckCells(`# P

## Scope
x

## File Changes
- a

## Success Criteria
ok

## Automated Checks

\`\`\`bash
CHAT_MODEL=$(grep -E '^AI_CHAT_MODEL=' .env.docker | cut -d= -f2-)
CODE_MODEL=$(grep -E '^AI_CODE_MODEL=' .env.docker | cut -d= -f2-)
if [ "$CHAT_MODEL" = "$CODE_MODEL" ]; then
  echo "FAIL: AI_CHAT_MODEL=$CHAT_MODEL == AI_CODE_MODEL=$CODE_MODEL (RC-DEADLOCK)"
  exit 1
fi
echo "PASS: distinct models"
\`\`\`
`)[0]!;

      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const runner = async (command: string, cwd: string) => {
        try {
          const { stdout, stderr } = await execAsync(command, { cwd });
          return { output: stdout + stderr, exitCode: 0 };
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; code?: number };
          return {
            output: (err.stdout ?? "") + (err.stderr ?? ""),
            exitCode: err.code ?? 1,
          };
        }
      };

      const registry = createDefaultCheckRegistry(runner);
      const result = await registry.run(cell, { cwd: root, env: process.env });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /PASS: distinct models/);
      assert.ok(!/RC-DEADLOCK/.test(result.output));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs typescript cell via tsx", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-ts-cell-"));
    try {
      const cell = {
        language: "typescript",
        body: 'console.log("hello-from-ts");\n',
        source: "fence" as const,
      };
      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const runner = async (command: string, cwd: string) => {
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd,
            maxBuffer: 5 * 1024 * 1024,
          });
          return { output: stdout + stderr, exitCode: 0 };
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; code?: number };
          return {
            output: (err.stdout ?? "") + (err.stderr ?? ""),
            exitCode: err.code ?? 1,
          };
        }
      };
      const registry = createDefaultCheckRegistry(runner);
      const result = await registry.run(cell, { cwd: root, env: process.env });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /hello-from-ts/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("meta cmd= runs custom interpreter", async () => {
    const root = mkdtempSync(join(tmpdir(), "slop-meta-cell-"));
    try {
      const cells = extractCheckCells(`# P

## Scope
x

## File Changes
- a

## Success Criteria
ok

## Automated Checks

\`\`\`python cmd=python3
print("meta-ok")
\`\`\`
`);
      assert.equal(cells.length, 1);
      assert.equal(cells[0]!.meta?.cmd, "python3");

      const { exec } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(exec);
      const runner = async (command: string, cwd: string) => {
        try {
          const { stdout, stderr } = await execAsync(command, { cwd });
          return { output: stdout + stderr, exitCode: 0 };
        } catch (error) {
          const err = error as { stdout?: string; stderr?: string; code?: number };
          return {
            output: (err.stdout ?? "") + (err.stderr ?? ""),
            exitCode: err.code ?? 1,
          };
        }
      };
      const registry = createDefaultCheckRegistry(runner);
      const result = await registry.run(cells[0]!, {
        cwd: root,
        env: process.env,
      });
      assert.equal(result.exitCode, 0, result.output);
      assert.match(result.output, /meta-ok/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects echo VAR=$? exit-code capture antipattern", () => {
    assert.equal(
      hasEchoExitCodeCaptureAntipattern('echo "BUILD_EXIT=$?"'),
      true,
    );
    const gate = validatePhaseDocForDev(
      phaseWithCheck(`pnpm build
echo "BUILD_EXIT=$?"
test "$BUILD_EXIT" -eq 0 || exit 1`),
    );
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /echo "VAR=\$\?"|does not assign/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("rejects absolute cd in Automated Checks", () => {
    assert.equal(
      hasAbsoluteCdInCheck(
        "cd /Users/brett/Projects/demo && pnpm build || exit 1",
      ),
      true,
    );
    const gate = validatePhaseDocForDev(
      phaseWithCheck(
        "cd /Users/brettchaldecott/Projects/jamroast-components && pnpm build || exit 1",
      ),
    );
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /absolute `cd|verify cwd/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("stripRedundantCwdCd removes cd to verify cwd", () => {
    const cwd = "/Users/brett/Projects/demo";
    const out = stripRedundantCwdCd(
      `cd ${cwd} && pnpm build || exit 1`,
      cwd,
    );
    assert.match(out, /pnpm build/);
    assert.doesNotMatch(out, /cd \/Users/);
  });

  it("rejects GNU timeout in Automated Checks", () => {
    assert.equal(
      hasGnuTimeoutInCheck(
        "cd playground && pnpm install --silent && timeout 8 pnpm dev 2>&1 | tee /tmp/vite-startup.log",
      ),
      true,
    );
    const gate = validatePhaseDocForDev(
      phaseWithCheck(
        "cd playground && timeout 8 pnpm dev 2>&1 | tee /tmp/vite-startup.log",
      ),
    );
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /timeout|gtimeout|macOS/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("rejects long-lived server starts in Automated Checks", () => {
    assert.equal(hasLongLivedServerInCheck("pnpm dev"), true);
    assert.equal(hasLongLivedServerInCheck("npm run start"), true);
    assert.equal(hasLongLivedServerInCheck("vite"), true);
    assert.equal(hasLongLivedServerInCheck("vite build"), false);
    assert.equal(
      hasLongLivedServerInCheck("docker compose up -d"),
      true,
    );
    assert.equal(
      hasLongLivedServerInCheck(
        "docker compose up --abort-on-container-exit",
      ),
      false,
    );
    // Finite compose probe: detached up + guaranteed EXIT-trap teardown.
    assert.equal(
      hasLongLivedServerInCheck(`set -euo pipefail
trap 'docker compose down' EXIT
docker compose up -d app 2>&1 | tail -3
sleep 8
docker compose exec -T app wget -qO- http://localhost:3000/sign-in | grep -q 'Clerk' || exit 1`),
      false,
    );
    // Detached up with a trap that does NOT tear compose down → still banned.
    assert.equal(
      hasLongLivedServerInCheck(`trap 'echo done' EXIT
docker compose up -d app
sleep 8`),
      true,
    );
    // Bare foreground up → always banned.
    assert.equal(hasLongLivedServerInCheck("docker compose up app"), true);
    const gate = validatePhaseDocForDev(
      phaseWithCheck("cd playground && pnpm dev 2>&1 &"),
    );
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /long-lived server|finite/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("rejects background & + wait hang antipattern", () => {
    const hang = `cd playground && pnpm install --silent 2>&1 && pnpm dev 2>&1 &
VITE_PID=$!
sleep 8
kill $VITE_PID 2>/dev/null
wait $VITE_PID 2>/dev/null`;
    assert.equal(hasBackgroundWaitHangAntipattern(hang), true);
    const gate = validatePhaseDocForDev(phaseWithCheck(hang));
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /wait|background|long-lived/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("flags brittle same-line grep chains (phase-29 regression)", () => {
    // The exact brittle line from JamLight phase 29 Check 2.
    const brittle = `awk '/handleNewChat *= *useCallback/,/^  \\},/' src/components/chat/chat-session-provider.tsx | grep -q 'fetch.*\\/api\\/conversations.*method.*POST' || exit 1`;
    assert.equal(hasBrittleSameLineGrepChain(brittle), true);
    const gate = validatePhaseDocForDev(phaseWithCheck(brittle));
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /one line|tokens independently/i.test(i)),
      gate.issues.join("; "),
    );

    // Per-token checks and single-join patterns are fine.
    assert.equal(
      hasBrittleSameLineGrepChain(
        'grep -q \'fetch("/api/conversations"\' f.ts && grep -q \'method: "POST"\' f.ts',
      ),
      false,
    );
    assert.equal(
      hasBrittleSameLineGrepChain("grep -q 'handleNewChat' f.ts"),
      false,
    );
    assert.equal(
      hasBrittleSameLineGrepChain("grep -qE 'className=\".*\"' f.ts"),
      false,
    );
  });

  it("rejects vitest piped to grep -q", () => {
    const brittle = `npx vitest run tests/a.test.ts 2>&1 | grep -qE "Tests +[0-9]+ passed" || exit 1`;
    assert.equal(hasVitestGrepQuietAntipattern(brittle), true);
    const gate = validatePhaseDocForDev(phaseWithCheck(brittle));
    assert.equal(gate.ok, false);
    assert.ok(
      gate.issues.some((i) => /grep -q|vitest/i.test(i)),
      gate.issues.join("; "),
    );
  });

  it("unwrapGrepQuietPipe strips grep -q tail", () => {
    const cmd = `npx vitest run foo.test.ts 2>&1 | grep -qE "Tests +[0-9]+ passed" || exit 1`;
    assert.equal(
      unwrapGrepQuietPipe(cmd),
      "npx vitest run foo.test.ts 2>&1 || exit 1",
    );
    assert.equal(unwrapGrepQuietPipe("pnpm build || exit 1"), null);
  });

  it("diagnostic rerun on grep -q pipe failure", async () => {
    const calls: string[] = [];
    const runner = async (cmd: string) => {
      calls.push(cmd);
      const file =
        cmd.startsWith("bash '") && cmd.endsWith("'")
          ? cmd.slice(6, -1).replace(/'\\''/g, "'")
          : "";
      const body = file ? readFileSync(file, "utf8") : "";
      if (/\bgrep\b/.test(body)) {
        return { exitCode: 1, output: "" };
      }
      return { exitCode: 0, output: "Tests 3 passed" };
    };
    const registry = createDefaultCheckRegistry(runner);
    const result = await registry.run(
      {
        language: "bash",
        body: 'npx vitest run foo.test.ts 2>&1 | grep -qE "Tests +[0-9]+ passed" || exit 1',
        source: "fence",
      },
      { cwd: "/tmp", env: process.env },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Diagnostic rerun/);
    assert.match(result.output, /Tests 3 passed/);
    assert.match(result.output, /treating check as pass/i);
    assert.ok(calls.length >= 2);
  });

  it("stripRedundantTestServicesBringUp removes docker up and trap when services ready", () => {
    const raw =
      "docker compose up -d postgres && trap 'docker compose down' EXIT; pg_isready -h localhost -p 5430 || exit 1";
    const stripped = stripRedundantTestServicesBringUp(raw, {
      [SLOPCONTROL_TEST_SERVICES_READY_ENV]: "1",
    });
    assert.doesNotMatch(stripped, /docker compose up/i);
    assert.doesNotMatch(stripped, /trap/i);
    assert.match(stripped, /pg_isready/);
  });

  it("stripRedundantTestServicesBringUp is a no-op without ready env", () => {
    const raw = "docker compose up -d postgres && pg_isready";
    assert.equal(stripRedundantTestServicesBringUp(raw, {}), raw);
  });

  it("runs migrate/vitest when test-services env strips legacy docker bring-up", async () => {
    const calls: string[] = [];
    const runner = async (cmd: string) => {
      calls.push(cmd);
      const file =
        cmd.startsWith("bash '") && cmd.endsWith("'")
          ? cmd.slice(6, -1).replace(/'\\''/g, "'")
          : "";
      const body = file ? readFileSync(file, "utf8") : "";
      assert.doesNotMatch(body, /docker compose up/i);
      assert.match(body, /vitest run/);
      return { exitCode: 0, output: "ok" };
    };
    const registry = createDefaultCheckRegistry(runner);
    const result = await registry.run(
      {
        language: "bash",
        body: "docker compose up -d db && trap 'docker compose down' EXIT; npx vitest run tests/a.test.ts || exit 1",
        source: "fence",
      },
      {
        cwd: "/tmp",
        env: { [SLOPCONTROL_TEST_SERVICES_READY_ENV]: "1" },
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(calls.length, 1);
  });
});
