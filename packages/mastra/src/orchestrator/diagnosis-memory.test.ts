import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Memory } from "@mastra/memory";
import type { PersistedDiagnosis } from "@slopcontrol/artifacts";
import {
  appendDiagnosisToMemory,
  diagnosesThreadId,
  formatDiagnosisHistoryLine,
  recallDiagnosisHistory,
} from "./diagnosis-memory.js";
import {
  appendProjectKnowledge,
  projectKnowledgeThreadId,
  recallProjectKnowledge,
} from "./project-knowledge.js";

function makeDiagnosis(overrides?: Partial<PersistedDiagnosis>): PersistedDiagnosis {
  return {
    audience: "coding",
    operatorActions: [],
    class: "process",
    confidence: "high",
    title: "Broken Automated Check shell",
    rootCause: "check cell split vars across fences",
    evidence: "exit 1",
    nextActions: "rewrite the check as one statement",
    fingerprint: "fp-abc123",
    codingAgentShouldFix: true,
    phaseId: "ph-1",
    runId: "run-1",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeMemory(opts?: {
  saved?: unknown[];
  recallMessages?: Array<{ role: string; content: unknown }>;
  throwOnSave?: boolean;
  throwOnRecall?: boolean;
}): Memory {
  return {
    saveMessages: async (input: { messages: unknown[] }) => {
      if (opts?.throwOnSave) throw new Error("save failed");
      opts?.saved?.push(...input.messages);
      return { messages: input.messages };
    },
    recall: async () => {
      if (opts?.throwOnRecall) throw new Error("recall failed");
      return { messages: opts?.recallMessages ?? [] };
    },
  } as unknown as Memory;
}

describe("diagnosis memory", () => {
  it("formatDiagnosisHistoryLine renders fingerprint, class, cause, resolution", () => {
    const line = formatDiagnosisHistoryLine(makeDiagnosis());
    assert.match(line, /\[fp-abc123\]/);
    assert.match(line, /process: Broken Automated Check shell/);
    assert.match(line, /rootCause: check cell split vars/);
    assert.match(line, /resolution: rewrite the check/);
  });

  it("appendDiagnosisToMemory writes to the per-project thread", async () => {
    const saved: Array<{
      threadId: string;
      resourceId: string;
      content: { parts: Array<{ text: string }> };
    }> = [];
    const memory = fakeMemory({ saved: saved as never[] });
    await appendDiagnosisToMemory({
      memory,
      projectId: "p1",
      diagnosis: makeDiagnosis(),
    });
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.threadId, diagnosesThreadId("p1"));
    assert.equal(saved[0]?.resourceId, "p1");
    assert.match(saved[0]?.content.parts[0]?.text ?? "", /fp-abc123/);
  });

  it("appendDiagnosisToMemory swallows save failures", async () => {
    const memory = fakeMemory({ throwOnSave: true });
    await appendDiagnosisToMemory({
      memory,
      projectId: "p1",
      diagnosis: makeDiagnosis(),
    });
    // no throw
  });

  it("recallDiagnosisHistory returns most recent first, limited", async () => {
    const memory = fakeMemory({
      recallMessages: [
        { role: "assistant", content: { parts: [{ type: "text", text: "oldest" }] } },
        { role: "assistant", content: { parts: [{ type: "text", text: "middle" }] } },
        { role: "assistant", content: { parts: [{ type: "text", text: "newest" }] } },
      ],
    });
    const history = await recallDiagnosisHistory({ memory, projectId: "p1" });
    assert.deepEqual(history, ["newest", "middle", "oldest"]);
  });

  it("recallDiagnosisHistory returns [] on recall failure", async () => {
    const memory = fakeMemory({ throwOnRecall: true });
    const history = await recallDiagnosisHistory({ memory, projectId: "p1" });
    assert.deepEqual(history, []);
  });

  it("recallDiagnosisHistory returns [] without memory", async () => {
    const history = await recallDiagnosisHistory({
      memory: undefined,
      projectId: "p1",
    });
    assert.deepEqual(history, []);
  });
});

describe("project knowledge memory", () => {
  it("appendProjectKnowledge writes each item to the knowledge thread", async () => {
    const saved: Array<{ threadId: string; content: { parts: Array<{ text: string }> } }> = [];
    const memory = fakeMemory({ saved: saved as never[] });
    await appendProjectKnowledge({
      memory,
      projectId: "p1",
      items: ["Menubar mounts ThemeToggle", "Operator requirement: wire env in staging"],
    });
    assert.equal(saved.length, 2);
    assert.equal(saved[0]?.threadId, projectKnowledgeThreadId("p1"));
    assert.match(saved[1]?.content.parts[0]?.text ?? "", /Operator requirement/);
  });

  it("appendProjectKnowledge skips empty item lists", async () => {
    const saved: unknown[] = [];
    const memory = fakeMemory({ saved });
    await appendProjectKnowledge({ memory, projectId: "p1", items: [] });
    assert.equal(saved.length, 0);
  });

  it("recallProjectKnowledge dedupes and returns most recent first", async () => {
    const memory = fakeMemory({
      recallMessages: [
        { role: "assistant", content: { parts: [{ type: "text", text: "alpha" }] } },
        { role: "assistant", content: { parts: [{ type: "text", text: "beta" }] } },
        { role: "assistant", content: { parts: [{ type: "text", text: "alpha" }] } },
      ],
    });
    const block = await recallProjectKnowledge({ memory, projectId: "p1" });
    assert.equal(block, "- alpha\n- beta");
  });

  it("recallProjectKnowledge returns empty string on failure or empty thread", async () => {
    assert.equal(
      await recallProjectKnowledge({
        memory: fakeMemory({ throwOnRecall: true }),
        projectId: "p1",
      }),
      "",
    );
    assert.equal(
      await recallProjectKnowledge({
        memory: fakeMemory({ recallMessages: [] }),
        projectId: "p1",
      }),
      "",
    );
    assert.equal(
      await recallProjectKnowledge({ memory: undefined, projectId: "p1" }),
      "",
    );
  });
});
