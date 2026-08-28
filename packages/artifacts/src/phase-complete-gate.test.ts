import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  evaluateApiRoutingCompleteGate,
  countAppendixTimeoutHits,
  phasePromisesApiRouting,
  changedFilesAddressApiRouting,
  classifyVerifyFailure,
  ensurePlatformLearnings,
  loadLearningsPromptBlock,
  readLearningIndex,
} from "./index.js";

describe("api-routing complete gate", () => {
  it("counts appendix timeout hits", () => {
    const appendix = `# Appendix

## Iteration 1 — probe/timeout abort (no file changes)

turn_timeout

## Iteration 2 — probe/timeout abort

turn_timeout

## Iteration 3 — probe/timeout abort

turn_timeout
`;
    assert.ok(countAppendixTimeoutHits(appendix) >= 2);
  });

  it("counts timeouts only after latest Develop pass started marker", () => {
    const appendix = `# Appendix
## Iteration 1 — probe/timeout abort
turn_timeout
## Iteration 2 — probe/timeout abort
turn_timeout
## Iteration 3 — probe/timeout abort
turn_timeout
## Develop pass started

## Iteration 1 — probe/timeout abort
turn_timeout
`;
    assert.equal(countAppendixTimeoutHits(appendix), 1);
  });

  it("detects API-routing PHASE promises", () => {
    assert.equal(
      phasePromisesApiRouting(
        "Rework resolveModelId for OpenAI-compatible OLLAMA_BASE_URL",
      ),
      true,
    );
    assert.equal(phasePromisesApiRouting("Add a button to the UI"), false);
    assert.equal(
      phasePromisesApiRouting(
        "Repoint OLLAMA_BASE_URL to the LAN box IP; remove jamjar-ollama",
      ),
      false,
    );
  });

  it("skips gate when PHASE marks routing files No change", () => {
    const phaseDoc = `
# Phase
| File | Action |
| \`src/lib/model-resolver.ts\` | **No change** |
| \`src/lib/embeddings.ts\` | **No change** |
Set OLLAMA_BASE_URL and openai-compatible host on the box.
`;
    assert.equal(phasePromisesApiRouting(phaseDoc), false);
  });

  it("recognizes routing vs catalogue files", () => {
    assert.equal(
      changedFilesAddressApiRouting(["src/lib/model-resolver.ts"]),
      true,
    );
    assert.equal(
      changedFilesAddressApiRouting(["docker-compose.yml", "scripts/docker.ts"]),
      true,
    );
    assert.equal(
      changedFilesAddressApiRouting([
        "src/lib/model-catalogue.ts",
        "scripts/env.ts",
        "tests/model-catalogue.test.ts",
      ]),
      false,
    );
  });

  it("blocks complete on timeout streak + thin catalogue merge", () => {
    const gate = evaluateApiRoutingCompleteGate({
      appendix: `
## Develop pass started
## Iteration 1 — probe/timeout abort
turn_timeout
## Iteration 2 — probe/timeout abort
turn_timeout
## Iteration 3 — probe/timeout abort
turn_timeout
`,
      phaseDoc:
        "Rework resolveModelId so OpenAI-compatible api.ollama.cloud/v1 keeps :cloud suffix",
      researchDoc: "OLLAMA_BASE_URL=https://api.ollama.cloud/v1",
      changedFiles: [
        "src/lib/model-catalogue.ts",
        "scripts/env.ts",
        "tests/model-catalogue.test.ts",
      ],
    });
    assert.equal(gate.allowComplete, false);
    assert.match(gate.reason ?? "", /api-routing complete gate/i);
  });

  it("allows complete when docker/env files address the phase", () => {
    const gate = evaluateApiRoutingCompleteGate({
      appendix: `
## Develop pass started
## Iteration 1 — probe/timeout abort
turn_timeout
## Iteration 2 — probe/timeout abort
turn_timeout
`,
      phaseDoc: "Fix resolveModelId and OpenAI-compatible OLLAMA_BASE_URL",
      changedFiles: ["scripts/docker.ts", "tests/docker.test.ts"],
      envTouchedPaths: [".env.docker"],
    });
    assert.equal(gate.allowComplete, true);
  });

  it("allows complete when routing file was changed", () => {
    const gate = evaluateApiRoutingCompleteGate({
      appendix: `
## Iteration 1 — probe/timeout abort
turn_timeout
## Iteration 2 — probe/timeout abort
turn_timeout
`,
      phaseDoc: "Fix resolveModelId and OLLAMA_BASE_URL",
      changedFiles: ["src/lib/model-resolver.ts", "src/lib/model-catalogue.ts"],
    });
    assert.equal(gate.allowComplete, true);
  });

  it("allows complete when PHASE is not API-routing", () => {
    const gate = evaluateApiRoutingCompleteGate({
      appendix: "turn_timeout\nturn_timeout\nturn_timeout",
      phaseDoc: "Add workflow save button",
      changedFiles: ["src/components/save.tsx"],
    });
    assert.equal(gate.allowComplete, true);
  });
});

describe("stream hang classification", () => {
  it("classifies Stream started without Stream ended as process", () => {
    const c = classifyVerifyFailure(
      "[chat] Initializing streamText { toolCount: 12 }\n[chat] Stream started\n",
      { stepName: "automatedCheck" },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.match(c.learning?.lesson ?? "", /ollama\.com\/v1|stream/i);
  });

  it("classifies api-routing-complete-gate output as process", () => {
    const c = classifyVerifyFailure(
      "API-routing complete gate: catalogue/docs/tests-only merges when PHASE promised OpenAI/Ollama API routing.",
      { stepName: "api-routing-complete-gate" },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
  });
});

describe("platform learnings seed", () => {
  it("ensurePlatformLearnings seeds ollama host lesson", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-learn-"));
    try {
      ensurePlatformLearnings(root);
      ensurePlatformLearnings(root); // upsert
      const { learnings } = readLearningIndex(root);
      assert.ok(
        learnings.some((L) =>
          /Ollama OpenAI-compat hosts/i.test(L.title),
        ),
      );
      assert.ok(
        learnings.some((L) =>
          /Compose \$\{VAR:-\} overrides env_file/i.test(L.title),
        ),
      );
      assert.ok(
        learnings.some((L) =>
          /Placeholder hosts stay in \*\.example/i.test(L.title),
        ),
      );
      assert.ok(
        learnings.some((L) =>
          /Vite alias first-match|grep ≠ resolve/i.test(L.title),
        ),
      );
      const block = loadLearningsPromptBlock(root, {
        phaseDescription: "ollama openai chat stream hang",
        failureText: "Stream started toolCount",
      });
      assert.match(block, /ollama\.com\/v1/);
      const viteBlock = loadLearningsPromptBlock(root, {
        phaseDescription: "playground Can't resolve styles vite alias",
        failureText: "Can't resolve '@jamroast/components/styles'",
      });
      assert.match(viteBlock, /first matching|vite build|resolveId/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("duplicate infra bring-up classification", () => {
  it("classifies container name conflict as duplicate-infra, not long-lived", () => {
    const c = classifyVerifyFailure(
      [
        `Error response from daemon: Conflict. The container name "/jamauth-postgres" is already in use by container "e60fdc2".`,
        "CHECK_TIMEOUT after 60000ms",
      ].join("\n"),
      { stepName: "automatedCheck", exitCode: 124 },
    );
    assert.equal(c.class, "process");
    assert.equal(c.codingAgentShouldFix, true);
    assert.ok(c.tags.includes("duplicate-infra"));
    assert.ok(!c.tags.includes("check-timeout"), "must not mislabel as long-lived");
    assert.match(c.summary, /[Dd]uplicate infra/);
    assert.match(c.learning?.lesson ?? "", /test-services already started/i);
  });
});
