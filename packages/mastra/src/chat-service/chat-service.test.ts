import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChatConversation, Run } from "@slopcontrol/types";
import {
  ChatService,
  chatToolTier,
  buildChatTools,
  buildConfirmedTurnPrefix,
  extractDispatchedReply,
  formatChatDispatchResult,
  compactChatToolPayload,
  CHAT_FREE_TOOLS,
  CHAT_GATED_TOOLS,
  CHAT_TOOL_INPUT_SCHEMA,
  type ChatEvent,
  type ChatServiceDeps,
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
function park(
  service: ChatService,
  conversation: ChatConversation,
  tool: string,
  args: Record<string, unknown> = {},
): string {
  return (
    service as unknown as {
      requestConfirmation: (
        c: ChatConversation,
        t: string,
        a: Record<string, unknown>,
      ) => { token: string };
    }
  ).requestConfirmation(conversation, tool, args).token;
}

async function drainSend(
  service: ChatService,
  conversationId: string,
  text: string,
): Promise<{ error: unknown }> {
  try {
    for await (const _ of service.sendMessage(conversationId, text)) {
      /* drain */
    }
    return { error: null };
  } catch (error) {
    return { error };
  }
}

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
  classifyConfirm?: ChatServiceDeps["classifyConfirm"];
  confirmTimeoutMs?: number;
  listRuns?: ChatServiceDeps["context"]["listRuns"];
  waitTimeoutMs?: number;
  waitPollMs?: number;
  followUpWaitMs?: number;
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
    classifyConfirm: opts?.classifyConfirm,
    context: {
      listProjects: () => [],
      listPhases: () => [],
      listRuns: opts?.listRuns ?? (() => []),
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
    waitTimeoutMs: opts?.waitTimeoutMs,
    waitPollMs: opts?.waitPollMs,
    followUpWaitMs: opts?.followUpWaitMs ?? 0,
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
    assert.equal(chatToolTier("wait_for_run"), "free");
    assert.equal(chatToolTier("ask"), "free");
    assert.equal(chatToolTier("promote_ask"), "gated");
    assert.equal(chatToolTier("start_development"), "gated");
    assert.equal(chatToolTier("submit_review"), "gated");
    assert.equal(chatToolTier("advance_run"), "gated");
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
    assert.ok(
      String(tools.ask?.description ?? "").includes("Prefer this over gated agent"),
    );
    assert.ok(
      String(tools.agent?.description ?? "").includes(
        "Do not use this to read source",
      ),
    );
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

  it("truncates oversized tool results so context stays bounded", async () => {
    let seenArgs: Record<string, unknown> | undefined;
    const big = "x".repeat(20_000);
    const tools = buildChatTools({
      dispatch: async (_name, args) => {
        seenArgs = args;
        return { content: [{ type: "text", text: big }] };
      },
      conversationId: "c1",
      projectId: "p1",
      requestConfirmation: () => ({ token: "t" }),
    });
    const result = (await tools.list_runs!.execute!({}, undefined as never)) as string;
    assert.ok(seenArgs !== undefined);
    assert.ok(result.length < 5_000);
    assert.match(result, /truncated/);
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
      message?: string;
    };
    assert.equal(result.status, "pending_confirmation");
    assert.equal(result.token, "tok-1");
    assert.equal(dispatched, false);
    assert.equal(confirmations[0]!.tool, "promote_ask");
    assert.equal(confirmations[0]!.args.projectId, "p1");
    assert.ok(result.message?.includes("in this chat"));
    assert.ok(result.message?.includes("Do not send them to a dashboard"));
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
      const token = park(service, conv, "promote_ask", { askId: "a1" });

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

  it("confirming submit_review approve also starts development", async () => {
    const dispatched: { name: string; args: Record<string, unknown> }[] = [];
    const { service, events, cleanup } = makeService({
      dispatch: async (name, args) => {
        dispatched.push({ name, args });
        if (name === "submit_review") {
          return {
            content: [{ type: "text", text: '{"stage":"accepted"}' }],
          };
        }
        if (name === "start_development") {
          return {
            content: [
              {
                type: "text",
                text: '{"stage":"developing","accepted":true}',
              },
            ],
          };
        }
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "submit_review", {
        runId: "ff5fe7f5-0a69-4064-bdf4-6a32bafe0010",
        decision: "approve",
      });
      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, true);
      assert.deepEqual(
        dispatched.map((d) => d.name),
        ["submit_review", "start_development"],
      );
      assert.equal(
        dispatched[1]!.args.runId,
        "ff5fe7f5-0a69-4064-bdf4-6a32bafe0010",
      );
      assert.equal(dispatched[1]!.args.projectId, "p1");
      assert.match(String(result.reply), /developing/);
      assert.ok(events.some((e) => e.type === "tool_result" && e.tool === "start_development"));
    } finally {
      cleanup();
    }
  });

  it("does not start development after submit_review request_changes", async () => {
    const dispatched: string[] = [];
    const { service, cleanup } = makeService({
      dispatch: async (name) => {
        dispatched.push(name);
        return { content: [{ type: "text", text: '{"stage":"drafting"}' }] };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "submit_review", {
        runId: "run-1",
        decision: "request_changes",
        feedback: "wrong mount",
      });
      await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.deepEqual(dispatched, ["submit_review"]);
    } finally {
      cleanup();
    }
  });

  it("confirming start_development does not dispatch it twice", async () => {
    const dispatched: string[] = [];
    const { service, cleanup } = makeService({
      dispatch: async (name) => {
        dispatched.push(name);
        return {
          content: [{ type: "text", text: '{"stage":"developing"}' }],
        };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "start_development", {
        runId: "run-88",
      });
      await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.deepEqual(dispatched, ["start_development"]);
    } finally {
      cleanup();
    }
  });

  it("confirming advance_run from accepted starts development", async () => {
    const dispatched: string[] = [];
    const now = new Date().toISOString();
    const run: Run = {
      id: "run-88",
      phaseId: "ph-88",
      projectId: "p1",
      stage: "accepted",
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      stageTimings: [],
    };
    const { service, cleanup } = makeService({
      dispatch: async (name) => {
        dispatched.push(name);
        if (name === "start_development") {
          run.stage = "developing";
          return {
            content: [{ type: "text", text: '{"stage":"developing"}' }],
          };
        }
        return {
          content: [{ type: "text", text: '{"stage":"accepted"}' }],
        };
      },
      listRuns: () => [run],
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "advance_run", { runId: "run-88" });
      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, true);
      assert.ok(dispatched.includes("advance_run"));
      assert.ok(dispatched.includes("start_development"));
      assert.match(String(result.reply), /developing/);
    } finally {
      cleanup();
    }
  });

  it("recovers design_required by starting design after a proceed confirm", async () => {
    const dispatched: string[] = [];
    const { service, cleanup } = makeService({
      dispatch: async (name) => {
        dispatched.push(name);
        if (name === "start_development") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: "design_required" }),
              },
            ],
            isError: true,
          };
        }
        if (name === "start_design") {
          return {
            content: [{ type: "text", text: '{"stage":"designing"}' }],
          };
        }
        return { content: [{ type: "text", text: '{"stage":"accepted"}' }] };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "advance_run", { runId: "run-1" });
      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, true);
      assert.ok(dispatched.includes("start_development"));
      assert.ok(dispatched.includes("start_design"));
      assert.match(String(result.reply), /designing/);
    } finally {
      cleanup();
    }
  });

  it("proceed latch continues from design_complete after a wait timeout", async () => {
    const dispatched: string[] = [];
    const now = new Date().toISOString();
    const run: Run = {
      id: "run-design",
      phaseId: "ph-1",
      projectId: "p1",
      stage: "designing",
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      stageTimings: [],
    };
    const { service, cleanup } = makeService({
      dispatch: async (name) => {
        dispatched.push(name);
        if (name === "start_development") {
          run.stage = "developing";
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  run: { id: run.id, stage: "developing" },
                  stage: "developing",
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                run: { id: run.id, stage: "designing" },
                stage: "designing",
              }),
            },
          ],
        };
      },
      listRuns: () => [run],
      waitTimeoutMs: 40,
      waitPollMs: 10,
      followUpWaitMs: 400,
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "start_design", {
        runId: "run-design",
      });
      await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.ok(dispatched.includes("start_design"));
      assert.ok(!dispatched.includes("start_development"));
      run.stage = "design_complete";
      const deadline = Date.now() + 500;
      while (
        !dispatched.includes("start_development") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 15));
      }
      assert.ok(
        dispatched.includes("start_development"),
        `expected follow-up start_development, got ${dispatched.join(",")}`,
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
      const token = park(service, conv, "start_development", { phaseId: "01" });

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
      const token = park(service, conv, "promote_ask");

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

  it("approve returns the inner reply, not a truncated session dump", async () => {
    const dump = JSON.stringify({
      agent: { id: "ag-1", messages: [{ content: "x".repeat(8_000) }] },
      reply: "THE REAL FINDING: UserPill has no onClick",
    });
    const { service, cleanup } = makeService({
      dispatch: async () => ({ content: [{ type: "text", text: dump }] }),
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "agent", { message: "why" });
      const result = await service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, true);
      assert.match(String(result.reply), /UserPill has no onClick/);
      assert.ok(!String(result.reply).includes("x".repeat(100)));
    } finally {
      cleanup();
    }
  });

  it("waits for research to leave researching before returning the confirm result", async () => {
    const now = new Date().toISOString();
    const run: Run = {
      id: "run-wait",
      phaseId: "ph-1",
      projectId: "p1",
      stage: "researching",
      iterationCount: 0,
      createdAt: now,
      updatedAt: now,
      stageTimings: [],
    };
    const { service, events, cleanup } = makeService({
      dispatch: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              run,
              stage: "researching",
              accepted: true,
            }),
          },
        ],
      }),
      listRuns: () => [run],
      waitTimeoutMs: 400,
      waitPollMs: 20,
      followUpWaitMs: 0,
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "start_change", { description: "x" });
      const pending = service.confirm({
        conversationId: conv.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      await new Promise((r) => setTimeout(r, 50));
      run.stage = "in_review";
      const result = await pending;
      assert.equal(result.ok, true);
      assert.match(String(result.reply), /in_review/);
      assert.match(String(result.reply), /ready for operator review/);
      assert.ok(events.some((e) => e.type === "status" && e.summary?.includes("researching")));
    } finally {
      cleanup();
    }
  });
});

describe("ChatService in-chat LLM confirm intercept", () => {
  it("approve dispatches the parked action then the turn proceeds", async () => {
    const dispatched: { name: string; args: Record<string, unknown> }[] = [];
    const { service, events, cleanup } = makeService({
      dispatch: async (name, args) => {
        dispatched.push({ name, args });
        return { content: [{ type: "text", text: '{"ok":true}' }] };
      },
      classifyConfirm: async () => ({ decision: "approve" as const }),
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      park(service, conv, "agent", { prompt: "read landing" });

      const { error } = await drainSend(service, conv.id, "go ahead with that");
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]!.name, "agent");
      assert.ok(
        events.some((e) => e.type === "confirm_resolved" && e.approved === true),
      );
      assert.equal(service.listPendingForConversation(conv.id).length, 0);
      assert.ok(error, "turn proceeds after confirm (memory stub throws)");
      assert.match(String(error), /no memory/);
    } finally {
      cleanup();
    }
  });

  it("deny skips dispatch and clears the parked action", async () => {
    let dispatched = false;
    const { service, events, cleanup } = makeService({
      dispatch: async () => {
        dispatched = true;
        return { content: [{ type: "text", text: "" }] };
      },
      classifyConfirm: async () => ({ decision: "deny" as const }),
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      park(service, conv, "agent", { prompt: "read landing" });

      await drainSend(service, conv.id, "no, don't");
      assert.equal(dispatched, false);
      assert.ok(
        events.some((e) => e.type === "confirm_resolved" && e.approved === false),
      );
      assert.equal(service.listPendingForConversation(conv.id).length, 0);
    } finally {
      cleanup();
    }
  });

  it("unrelated leaves the parked action and does not dispatch", async () => {
    let dispatched = false;
    let seenMessage = "";
    const { service, events, cleanup } = makeService({
      dispatch: async () => {
        dispatched = true;
        return { content: [{ type: "text", text: "" }] };
      },
      classifyConfirm: async ({ message }) => {
        seenMessage = message;
        return { decision: "unrelated" as const };
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "agent", { prompt: "read landing" });

      await drainSend(service, conv.id, "meanwhile, how many phases are open?");
      assert.equal(seenMessage, "meanwhile, how many phases are open?");
      assert.equal(dispatched, false);
      assert.ok(!events.some((e) => e.type === "confirm_resolved"));
      assert.equal(service.getPendingAction(token)?.tool, "agent");
    } finally {
      cleanup();
    }
  });

  it("classifier throw is fail-closed unrelated (no dispatch, pending remains)", async () => {
    let dispatched = false;
    const { service, cleanup } = makeService({
      dispatch: async () => {
        dispatched = true;
        return { content: [{ type: "text", text: "" }] };
      },
      classifyConfirm: async () => {
        throw new Error("llm down");
      },
    });
    try {
      const conv = service.createConversation({ projectId: "p1" });
      const token = park(service, conv, "agent", { prompt: "read landing" });

      await drainSend(service, conv.id, "anything");
      assert.equal(dispatched, false);
      assert.equal(service.getPendingAction(token)?.tool, "agent");
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

  it("getMessages returns user/assistant text and drops tool internals", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-chat-svc-"));
    const store = makeStore();
    const service = new ChatService({
      store,
      getMemory: () =>
        ({
          recall: async () => ({
            messages: [
              {
                role: "user",
                createdAt: "2026-08-13T09:23:20.000Z",
                content: {
                  format: 2,
                  parts: [{ type: "text", text: "How is the current run going?" }],
                },
              },
              {
                role: "assistant",
                createdAt: "2026-08-13T09:23:30.000Z",
                content: {
                  format: 2,
                  parts: [
                    { type: "data-om-status", data: { windows: {} } },
                    { type: "tool-invocation", toolName: "list_runs" },
                    { type: "text", text: "No active runs." },
                  ],
                },
              },
              { role: "system", content: "ignore me" },
            ],
            total: 3,
            page: 0,
            perPage: false,
            hasMore: false,
          }),
          deleteThread: async () => {},
        }) as never,
      dispatch: async () => ({ content: [{ type: "text", text: "{}" }] }),
      context: {
        listProjects: () => [],
        listPhases: () => [],
        listRuns: () => [],
        getProject: () => undefined,
      },
      endpointsPath: makeEndpointsPath(dir),
    });
    try {
      const conv = service.createConversation({ projectId: null });
      const messages = await service.getMessages(conv.id);
      assert.deepEqual(messages, [
        {
          role: "user",
          content: "How is the current run going?",
          at: "2026-08-13T09:23:20.000Z",
        },
        {
          role: "assistant",
          content: "No active runs.",
          at: "2026-08-13T09:23:30.000Z",
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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

  it("publishes closed events with conversationId and projectId for aggregate streams", () => {
    const { service, events, cleanup } = makeService();
    try {
      const projectChat = service.createConversation({ projectId: "p1" });
      const globalChat = service.createConversation({ projectId: null });
      service.closeConversation(projectChat.id);
      service.closeConversation(globalChat.id);
      const projectClosed = events.filter(
        (e) => e.type === "closed" && e.conversationId === projectChat.id,
      );
      const globalClosed = events.filter(
        (e) => e.type === "closed" && e.conversationId === globalChat.id,
      );
      assert.equal(projectClosed.length, 1);
      assert.equal(projectClosed[0]!.projectId, "p1");
      assert.equal(globalClosed.length, 1);
      assert.equal(globalClosed[0]!.projectId, null);
    } finally {
      cleanup();
    }
  });

  it("listConversationsDetailed includes Memory messageCount", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-chat-svc-"));
    const store = makeStore();
    const service = new ChatService({
      store,
      getMemory: () =>
        ({
          recall: async () => ({
            messages: [
              { role: "user", createdAt: "2026-08-13T09:00:00.000Z", content: "hi" },
              { role: "assistant", createdAt: "2026-08-13T09:00:01.000Z", content: "hello" },
            ],
            total: 2,
            page: 0,
            perPage: false,
            hasMore: false,
          }),
          deleteThread: async () => {},
        }) as never,
      dispatch: async () => ({ content: [{ type: "text", text: "{}" }] }),
      context: {
        listProjects: () => [],
        listPhases: () => [],
        listRuns: () => [],
        getProject: () => undefined,
      },
      endpointsPath: makeEndpointsPath(dir),
    });
    try {
      const conv = service.createConversation({ projectId: null });
      const listed = await service.listConversationsDetailed({ projectId: null });
      assert.equal(listed.length, 1);
      assert.equal(listed[0]!.id, conv.id);
      assert.equal(listed[0]!.messageCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updateEndpointDefaultModel notifies onEndpointsChanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-chat-ep-"));
    let calls = 0;
    try {
      const store = makeStore();
      const svc = new ChatService({
        store,
        getMemory: () => {
          throw new Error("unused");
        },
        dispatch: async () => ({ content: [{ type: "text", text: "{}" }] }),
        context: {
          listProjects: () => [],
          listPhases: () => [],
          listRuns: () => [],
          getProject: () => undefined,
        },
        endpointsPath: makeEndpointsPath(dir),
        onEndpointsChanged: () => {
          calls += 1;
        },
      });
      svc.updateEndpointDefaultModel("dead", "other-model");
      assert.equal(calls, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bindFunctionMapping notifies onEndpointsChanged and creates a mapping", async () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-chat-bind-"));
    let calls = 0;
    try {
      const store = makeStore();
      const svc = new ChatService({
        store,
        getMemory: () => {
          throw new Error("unused");
        },
        dispatch: async () => ({ content: [{ type: "text", text: "{}" }] }),
        context: {
          listProjects: () => [],
          listPhases: () => [],
          listRuns: () => [],
          getProject: () => undefined,
        },
        endpointsPath: makeEndpointsPath(dir),
        onEndpointsChanged: () => {
          calls += 1;
        },
      });
      const result = await svc.bindFunctionMapping({
        function: "classification",
        modelId: "other-model",
        endpointId: "dead",
      });
      assert.equal(calls, 1);
      assert.equal(result.createdEndpoint, true);
      assert.equal(result.config.roles.classification?.modelId, "other-model");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("chat tool input schemas", () => {
  it("requires runId for get_run and get_run_steps", () => {
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_run!.parse({}));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_run!.parse({ runId: "" }));
    const parsed = CHAT_TOOL_INPUT_SCHEMA.get_run!.parse({ runId: "abc" }) as {
      runId: string;
    };
    assert.equal(parsed.runId, "abc");
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_run_steps!.parse({}));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_phase_status!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.get_phase_status!.parse({ phaseId: "01" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.wait_for_run!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.wait_for_run!.parse({ runId: "abc" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.advance_run!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.advance_run!.parse({ runId: "abc" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.submit_review!.parse({ runId: "abc" }));
    assert.ok(
      CHAT_TOOL_INPUT_SCHEMA.submit_review!.parse({
        runId: "abc",
        decision: "approve",
      }),
    );
  });

  it("requires ids for get_ask, get_agent, loop get, and live-turn tools", () => {
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_ask!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.get_ask!.parse({ askId: "a1" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.get_agent!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.get_agent!.parse({ agentId: "ag1" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.design_loop_get!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.plan_loop_get!.parse({ loopId: "l1" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.ask!.parse({}));
    assert.ok(CHAT_TOOL_INPUT_SCHEMA.ask!.parse({ message: "why is this broken?" }));
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.design_loop_continue!.parse({ loopId: "l1" }));
    assert.ok(
      CHAT_TOOL_INPUT_SCHEMA.design_loop_continue!.parse({
        loopId: "l1",
        message: "darker chrome",
      }),
    );
    assert.throws(() => CHAT_TOOL_INPUT_SCHEMA.stop_session!.parse({ kind: "ask" }));
    assert.ok(
      CHAT_TOOL_INPUT_SCHEMA.stop_session!.parse({
        kind: "ask",
        id: "a1",
      }),
    );
  });
});

describe("chat dispatch result shaping", () => {
  it("extracts reply from agent JSON so a session dump cannot hide the answer", () => {
    const raw = JSON.stringify({
      agent: { id: "ag-1", messages: [{ content: "noise".repeat(2_000) }] },
      reply: "UserPill has no onClick",
    });
    assert.equal(extractDispatchedReply(raw), "UserPill has no onClick");
    assert.match(
      formatChatDispatchResult({
        content: [{ type: "text", text: raw }],
      }),
      /UserPill has no onClick/,
    );
  });

  it("extracts reply from an ask envelope", () => {
    const raw = "askId: abc\nstatus: open\n---\nThe button is a no-op.";
    assert.equal(extractDispatchedReply(raw), "The button is a no-op.");
  });

  it("keeps the latest get_ask / get_agent messages, not the history dump", () => {
    const dump = JSON.stringify({
      ask: {
        id: "ask-1",
        status: "open",
        title: "old env sync",
        messages: [
          { role: "user", content: "noise ".repeat(2_000) },
          { role: "assistant", content: "ancient brief ".repeat(500) },
          { role: "user", content: "why does the ? do nothing" },
          { role: "assistant", content: "UserPill has no onClick" },
        ],
      },
    });
    const shaped = compactChatToolPayload(dump, "get_ask");
    assert.match(shaped, /UserPill has no onClick/);
    assert.ok(!shaped.includes("noise ".repeat(50)));
    assert.match(
      formatChatDispatchResult({ content: [{ type: "text", text: dump }] }, "get_ask"),
      /UserPill has no onClick/,
    );
  });

  it("surfaces development-report summary instead of a nested dump", () => {
    const dump = JSON.stringify({
      projectId: "p1",
      phaseId: "01",
      runId: "r1",
      report: {
        outcome: "blocked",
        phaseId: "01",
        runId: "r1",
        summary: "Clerk key never reached the image.",
        operatorRequirements: ["Pass NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY as a build arg"],
        nextSteps: ["Rebuild the app image"],
        checksSummary: "verify failed",
      },
    });
    const shaped = compactChatToolPayload(dump, "get_development_report");
    assert.match(shaped, /Clerk key never reached the image/);
    assert.match(shaped, /build arg/);
    assert.match(shaped, /Rebuild the app image/);
  });

  it("keeps design/plan loop notes when HTML/plan would blow the clip", () => {
    const envelope = [
      "loopId: loop-1",
      "status: open",
      "notes: Wire UserPill onClick to /sign-in",
      "---",
      "```html\n",
      "<html>".repeat(3_000),
      "\n```",
    ].join("\n");
    const shaped = compactChatToolPayload(envelope, "design_loop_get");
    assert.match(shaped, /loopId: loop-1/);
    assert.match(shaped, /Wire UserPill onClick/);
  });

  it("buildConfirmedTurnPrefix tells the operator turn to use the result", () => {
    const prefix = buildConfirmedTurnPrefix({
      tool: "agent",
      approve: true,
      resultText: "UserPill has no onClick",
    });
    assert.match(prefix, /approved and has finished/);
    assert.match(prefix, /UserPill has no onClick/);
    assert.match(prefix, /Do not call agent again/);
  });
});
