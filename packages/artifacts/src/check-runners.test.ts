import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  extractCheckCells,
  createDefaultCheckRegistry,
  parseFenceInfo,
  normalizeCheckLanguage,
  validatePhaseDocForDev,
} from "./index.js";

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
});
