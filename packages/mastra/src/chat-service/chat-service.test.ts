import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChatConversation } from "@slopcontrol/types";
import {
  ChatService,
  chatToolTier,
  buildChatTools,
  CHAT_FREE_TOOLS,
  CHAT_GATED_TOOLS,
  type ChatEvent,
  type ConversationStore,
  type ChatToolResult,
} from "./index.js";

function makeStore(): ConversationStore & { rows: ChatConversation[] } {
  const rows: ChatConversation[] = [];
  return {
    rows,
    listConversations(opts) {
      return rows
        .filter((c) => {
          if (opts?.projectId === null) return c.projectId === null;
          if (opts?.projectId !== undefined) return c.projectId === opts.projectId;
          return true;
        })
        .filter((c) => (opts?.status ? c.status === opts.status : true));
    },
    getConversation: (id) => rows.find((c) => c.id === id),
    createConversation(input) {
      const now = new Date().toISOString();
      const c: ChatConversation = {
        id: `conv-${rows.length + 1}`,
        projectId: input.projectId,
        title: input.title,
        status: "active",
        modelOverride: input.modelOverride,
        createdAt: now,
        lastActiveAt: now,
      };
      rows.push(c);
      return c;
    },
    updateConversation(c) {
      const i = rows.findIndex((r) => r.id === c.id);
      if (i >= 0) rows[i] = c;
    },
    touchConversation(id, hint) {
      const c = rows.find((r) => r.id === id);
      if (!c) return undefined;
      c.lastActiveAt = new Date().toISOString();
      if (!c.title && hint) c.title = hint.slice(0, 80);
      return c;
    },
    closeConversation(id) {
      const c = rows.find((r) => r.id === id);
      if (!c) return undefined;
      c.status = "closed";
      c.closedAt = new Date().toISOString();
      return c;
    },
    deleteConversation(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  };
}

/** endpoints.json pointing at a dead port so synthetic turns fail fast. */
function makeEndpointsPath(dir: string): string {
  const path = join(dir, "endpoints.json");
  writeFileSync(
    path,
    JSON.stringify({
      endpoints: [
        {
          id: "dead",
          baseUrl: "http://127.0.0.1:9/v1",
          apiType: "openai-chat",
          modelId: "dead-model",
        },
      ],
      roles: {
        research: { endpointId: "dead" },
        planning: { endpointId: "dead" },
        supervisor: { endpointId: "dead" },
        coding: { endpointId: "dead" },
      },
    }),
  );
  return path;
}

function makeService(opts?: {
  store?: ReturnType<typeof makeStore>;
  dispatch?: (name: string, args: Record<string, unknown>) => Promise<ChatToolResult>;
  confirmTimeoutMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), "slop-chat-svc-"));
  const store = opts?.store ?? makeStore();
  const events: ChatEvent[] = [];
  const service = new ChatService({
    store,
    getMemory: () => {
      throw new Error("no memory in tests");
    },
    dispatch:
      opts?.dispatch ??
      (async () => ({ content: [{ type: "text", text: "{}" }] })),
    context: {
      listProjects: () => [],
      listPhases: () => [],
      listRuns: () => [],
      getProject: (id) =>
        id === "p1"
          ? {
              id: "p1",
              name: "demo",
              rootPath: dir,
              blueprintVersion: 0,
              createdAt: "",
              updatedAt: "",
            }
          : undefined,
    },
    endpointsPath: makeEndpointsPath(dir),
    confirmTimeoutMs: opts?.confirmTimeoutMs,
    turnTimeoutMs: 5_000,
  });
  const unsubscribe = service.subscribe((e) => events.push(e));
  return {
    service,
    store,
    events,
    cleanup: () => {
      unsubscribe();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("chat tool allowlist", () => {
  it("classifies free, gated, and excluded tools", () => {
    assert.equal(chatToolTier("list_phases"), "free");
    assert.equal(chatToolTier("ask"), "free");
    assert.equal(chatToolTier("promote_ask"), "gated");
    assert.equal(chatToolTier("start_development"), "gated");
    assert.equal(chatToolTier("delete_project"), "excluded");
    assert.equal(chatToolTier("remove_worktree"), "excluded");
    assert.equal(chatToolTier("slopcontrol"), "excluded");
    assert.equal(chatToolTier("nonexistent_tool"), "excluded");
  });

  it("builds tools for free + gated tiers only", () => {
    const tools = buildChatTools({
      dispatch: async () => ({ content: [{ type: "text", text: "ok" }] }),
      conversationId: "c1",
      projectId: "p1",
      requestConfirmation: () => ({ token: "t" }),
    });
    const names = Object.keys(tools);
    assert.equal(names.length, CHAT_FREE_TOOLS.size + CHAT_GATED_TOOLS.size);
    assert.ok(!names.includes("delete_project"));
  });

  it("pins projectId for project-scope conversations", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const tools = buildChatTools({
      dispatch: async (_name, args) => {
        seenArgs = args;
        return { content: [{ type: "text", text: "[]" }] };
      },
      conversationId: "c1",
      projectId: "p1",
      requestConfirmation: () => ({ token: "t" }),
    });
    await tools.list_phases!.execute!({ projectId: "evil-other-project" }, undefined as never);
    assert.equal(seenArgs?.projectId, "p1");
  });

  it("forces reconcile_blueprint dryRun in the free tier", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const tools = buildChatTools({
      dispatch: async (_name, args) => {
        seenArgs = args;
        return { content: [{ type: "text", text: "{}" }] };
      },
      conversationId: "c1",
      projectId: null,
      requestConfirmation: () => ({ token: "t" }),
    });
    await tools.reconcile_blueprint!.execute!({ projectId: "p1", dryRun: false }, undefined as never);
    assert.equal(seenArgs?.dryRun, true);
  });

  it("gated tools park as pending_confirmation instead of dispatching", async () => {
    let dispatched = false;
    const confirmations: { tool: string; args: Record<string, unknown> }[] = [];
    const tools = buildChatTools({
      dispatch: async () => {
        dispatched = true;
        return { content: [{ type: "text", text: "" }] };
      },
      conversationId: "c1",
      projectId: "p1",
      requestConfirmation: (tool, args) => {
        confirmations.push({ tool, args });
        return { token: "tok-1" };
      },
    });
    const result = (await tools.promote_ask!.execute!({ askId: "a1" }, undefined as never)) as {
      status: string;
      token: string;
    };
    assert.equal(result.status, "pending_confirmation");
    assert.equal(result.token, "tok-1");
    assert.equal(dispatched, false);
    assert.equal(confirmations[0]!.tool, "promote_ask");
    assert.equal(confirmations[0]!.args.projectId, "p1");
  });
});

describe("ChatService confirmation gate", () => {
  it("approve dispatches the parked action and emits confirm_resolved", async () => {
    const dispatched: { name: string; args: Record<string, unknown> }[] = [];
    const { service, events, cleanup } = makeService({
      dispatch: async (name, args) => {
        dispatched.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      // Park an action directly through the private gate entry point.
      const { token } = (
        service as unknown as {
          requestConfirmation: (
            c: ChatConversation,
            t: string,
            a: Record<string, unknown>,
          ) => { token: string };
        }
      ).requestConfirmation(conv, "promote_ask", { askId: "a1" });

      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
      });
      assert.equal(result.ok, true);
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]!.name, "promote_ask");
      assert.ok(
        events.some(
          (e) => e.type === "confirm_resolved" && e.approved === true,
        ),
      );
    } finally {
      cleanup();
    }
  });

  it("deny skips dispatch and emits confirm_resolved approved=false", async () => {
    let dispatched = false;
    const { service, events, cleanup } = makeService({
      dispatch: async () => {
        dispatched = true;
        return { content: [{ type: "text", text: "" }] };
      },
    });
    try {
      const conv = service.createConversation({ projectId: null });
      const { token } = (
        service as unknown as {
          requestConfirmation: (
            c: ChatConversation,
            t: string,
            a: Record<string, unknown>,
          ) => { token: string };
        }
      ).requestConfirmation(conv, "start_development", { phaseId: "01" });

      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: false,
      });
      assert.equal(result.ok, true);
      assert.equal(dispatched, false);
      assert.ok(
        events.some(
          (e) => e.type === "confirm_resolved" && e.approved === false,
        ),
      );
    } finally {
      cleanup();
    }
  });

  it("rejects unknown, cross-conversation, and expired tokens", async () => {
    const { service, cleanup } = makeService({ confirmTimeoutMs: 1 });
    try {
      const conv = service.createConversation({ projectId: null });
      const other = service.createConversation({ projectId: null });
      const { token } = (
        service as unknown as {
          requestConfirmation: (
            c: ChatConversation,
            t: string,
            a: Record<string, unknown>,
          ) => { token: string };
        }
      ).requestConfirmation(conv, "promote_ask", {});

      assert.equal(
        (await service.confirm({ conversationId: conv.id, token: "nope", approve: true })).ok,
        false,
      );
      // Cross-conversation token use is rejected (and consumes nothing).
      assert.equal(
        (await service.confirm({ conversationId: other.id, token, approve: true })).ok,
        false,
      );
      // Expiry
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(
        (await service.confirm({ conversationId: conv.id, token, approve: true })).ok,
        false,
      );
    } finally {
      cleanup();
    }
  });
});

describe("ChatService lifecycle", () => {
  it("closeIdleConversations closes stale actives and emits closed events", () => {
    const { service, store, events, cleanup } = makeService();
    try {
      const stale = service.createConversation({ projectId: "p1" });
      const fresh = service.createConversation({ projectId: null });
      const staleRow = store.getConversation(stale.id)!;
      staleRow.lastActiveAt = new Date(Date.now() - 48 * 3600_000).toISOString();
      store.updateConversation(staleRow);

      const closed = service.closeIdleConversations(24 * 3600_000);
      assert.deepEqual(closed, [stale.id]);
      assert.equal(store.getConversation(stale.id)?.status, "closed");
      assert.equal(store.getConversation(fresh.id)?.status, "active");
      assert.ok(events.some((e) => e.type === "closed" && e.conversationId === stale.id));
    } finally {
      cleanup();
    }
  });

  it("sendMessage rejects closed conversations", async () => {
    const { service, cleanup } = makeService();
    try {
      const conv = service.createConversation({ projectId: null });
      service.closeConversation(conv.id);
      await assert.rejects(async () => {
        for await (const _ of service.sendMessage(conv.id, "hi")) {
          /* unreachable */
        }
      }, /closed/);
    } finally {
      cleanup();
    }
  });

  it("setConversationModel persists the override", () => {
    const { service, store, cleanup } = makeService();
    try {
      const conv = service.createConversation({ projectId: null });
      service.setConversationModel(conv.id, {
        endpointId: "ollama-cloud",
        modelId: "glm-5.2:cloud",
      });
      assert.deepEqual(store.getConversation(conv.id)?.modelOverride, {
        endpointId: "ollama-cloud",
        modelId: "glm-5.2:cloud",
      });
    } finally {
      cleanup();
    }
  });
});
