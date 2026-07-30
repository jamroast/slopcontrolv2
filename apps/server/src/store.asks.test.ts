import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatAskMcpEnvelope } from "./mcp-tools.js";
import { sanitizeAskTitle, SlopStore } from "./store.js";

describe("sanitizeAskTitle", () => {
  it("collapses newlines from pasted errors", () => {
    const t = sanitizeAskTitle(
      "Failing up\n\n ⨯ ./middleware.ts:1:1\nModule not found",
    );
    assert.ok(t);
    assert.doesNotMatch(t!, /\n/);
    assert.ok(t!.length <= 80);
  });
});

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
      assert.equal(cleared.asksArchived, 1);
      assert.equal(cleared.asksRemoved, 0);
      assert.equal(cleared.agentsRemoved, 0);
      const after = store.listAsks(project.id);
      assert.equal(after.length, 1);
      assert.equal(after[0]?.status, "archived");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sticky resume: latestOpenAsk returns newest open ask", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-store-sticky-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({
        name: "demo",
        rootPath: projectRoot,
      });
      const a = store.createAsk({
        projectId: project.id,
        firstMessage: {
          role: "user",
          content: "first",
          at: "2026-01-01T00:00:00.000Z",
        },
      });
      // Force older createdAt so tie-breaks can't hide the newer ask
      a.createdAt = "2026-01-01T00:00:00.000Z";
      a.updatedAt = "2026-01-01T00:00:00.000Z";
      store.updateAsk(a);

      const b = store.createAsk({
        projectId: project.id,
        firstMessage: {
          role: "user",
          content: "second topic",
          at: "2026-01-01T00:00:01.000Z",
        },
      });
      b.createdAt = "2026-01-01T00:00:01.000Z";
      store.updateAsk(b);

      assert.equal(store.latestOpenAsk(project.id)?.id, b.id);
      store.markAskPromoted(b.id, "phase-x");
      assert.equal(store.latestOpenAsk(project.id)?.id, a.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forkAsk clones transcript into a new open session", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-store-fork-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({
        name: "demo",
        rootPath: projectRoot,
      });
      const ask = store.createAsk({
        projectId: project.id,
        title: "Port conflict",
        firstMessage: {
          role: "user",
          content: "5432 conflict",
          at: new Date().toISOString(),
        },
      });
      store.appendAskMessage(ask.id, {
        role: "assistant",
        content: "Change DB_PORT",
        at: new Date().toISOString(),
      });
      store.markAskPromoted(ask.id, "07-phase");
      const forked = store.forkAsk(ask.id);
      assert.ok(forked);
      assert.notEqual(forked!.id, ask.id);
      assert.equal(forked!.status, "open");
      assert.equal(forked!.messages.length, 2);
      assert.match(forked!.title ?? "", /continued/i);
      assert.equal(store.getAsk(ask.id)?.status, "promoted");
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

describe("formatAskMcpEnvelope", () => {
  it("puts askId first on success", () => {
    const text = formatAskMcpEnvelope(
      JSON.stringify({
        ask: {
          id: "abc-123",
          status: "open",
          messages: [{}, {}],
        },
        reply: "Here is the answer.",
        askId: "abc-123",
      }),
      true,
    );
    assert.match(text, /^askId: abc-123\n/);
    assert.match(text, /messageCount: 2/);
    assert.match(text, /---\nHere is the answer\./);
  });

  it("surfaces fork hint on promoted 409", () => {
    const text = formatAskMcpEnvelope(
      JSON.stringify({
        error: "Ask already promoted",
        askId: "old-1",
        hint: "fork_ask",
        promotedPhaseId: "08-x",
      }),
      false,
    );
    assert.match(text, /askId: old-1/);
    assert.match(text, /hint: fork_ask/);
  });
});
