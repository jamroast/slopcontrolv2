import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SlopStore } from "./store.js";

describe("SlopStore asks", () => {
  it("creates, appends, lists, and promotes asks", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-store-ask-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({
        name: "demo",
        rootPath: projectRoot,
      });
      const now = new Date().toISOString();
      const ask = store.createAsk({
        projectId: project.id,
        title: "Connectors",
        firstMessage: {
          role: "user",
          content: "How do I add Google connectors?",
          at: now,
        },
      });
      assert.equal(ask.status, "open");
      assert.equal(ask.messages.length, 1);

      const updated = store.appendAskMessage(ask.id, {
        role: "assistant",
        content: "## Task brief\n- Title: Google connectors\n",
        at: new Date().toISOString(),
      });
      assert.equal(updated?.messages.length, 2);

      const listed = store.listAsks(project.id);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, ask.id);

      const phase = store.createPhase({
        projectId: project.id,
        description: "Google connectors",
        rootPath: project.rootPath,
      });
      const promoted = store.markAskPromoted(ask.id, phase.id);
      assert.equal(promoted?.status, "promoted");
      assert.equal(promoted?.promotedPhaseId, phase.id);

      const cleared = store.clearProjectWork(project.id);
      assert.equal(cleared.asksRemoved, 1);
      assert.equal(cleared.agentsRemoved, 0);
      assert.equal(store.listAsks(project.id).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates, appends, lists agents and clears them with project work", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-store-agent-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({
        name: "demo",
        rootPath: projectRoot,
      });
      const now = new Date().toISOString();
      const agent = store.createAgent({
        projectId: project.id,
        title: "Diagnose tests",
        firstMessage: {
          role: "user",
          content: "Why are tests failing?",
          at: now,
        },
      });
      assert.equal(agent.status, "open");
      assert.equal(agent.messages.length, 1);

      const updated = store.appendAgentMessage(agent.id, {
        role: "assistant",
        content: "Checking git status…",
        at: new Date().toISOString(),
      });
      assert.equal(updated?.messages.length, 2);
      assert.equal(store.listAgents(project.id).length, 1);

      const cleared = store.clearProjectWork(project.id);
      assert.equal(cleared.agentsRemoved, 1);
      assert.equal(store.listAgents(project.id).length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
