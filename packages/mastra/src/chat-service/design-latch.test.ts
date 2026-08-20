import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ChatConversation } from "@slopcontrol/types";
import { ChatService, type ChatServiceDeps } from "./chat-service.js";
import type { ChatToolResult, ConversationStore } from "./types.js";
import type { Memory } from "@mastra/memory";

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
    touchConversation(id) {
      const c = rows.find((r) => r.id === id);
      if (c) c.lastActiveAt = new Date().toISOString();
      return c;
    },
    closeConversation(id) {
      const c = rows.find((r) => r.id === id);
      if (c) c.status = "closed";
      return c;
    },
    deleteConversation(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i >= 0) rows.splice(i, 1);
      return true;
    },
    setAwaitedRun() {},
    setAwaitedLiveTurn() {},
  };
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
      roles: { classification: { endpointId: "dead" } },
    }),
  );
  return path;
}

function makeService(opts?: {
  dispatch?: ChatServiceDeps["dispatch"];
  classifyDesignTurn?: ChatServiceDeps["classifyDesignTurn"];
}) {
  const dir = mkdtempSync(join(tmpdir(), "slop-design-svc-"));
  const store = makeStore();
  const service = new ChatService({
    store,
    getMemory: () =>
      ({ deleteThread: async () => undefined }) as unknown as Memory,
    dispatch:
      opts?.dispatch ??
      (async () => ({ content: [{ type: "text", text: "{}" }] })),
    classifyDesignTurn: opts?.classifyDesignTurn,
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
    turnTimeoutMs: 5_000,
    followUpWaitMs: 0,
  });
  return {
    service,
    store,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function writeDesignLoopMeta(
  projectRoot: string,
  loopId: string,
  opts?: { brief?: string; status?: string; currentVersion?: number },
): void {
  const dir = join(projectRoot, ".slopcontrol", "design-loops", loopId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "META.json"),
    JSON.stringify({
      id: loopId,
      projectId: "p1",
      brief: opts?.brief ?? "mock brief",
      status: opts?.status ?? "open",
      currentVersion: opts?.currentVersion ?? 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

describe("design loop latch", () => {
  it("latches loopId from design_loop_start dispatch and backfills get/continue", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { service, cleanup } = makeService({
      dispatch: async (name, args): Promise<ChatToolResult> => {
        dispatched.push({ name, args });
        if (name === "design_loop_start") {
          return {
            content: [
              {
                type: "text",
                text: 'loopId: dl-1\nstatus: open\n---\n{"version":1}',
              },
            ],
          };
        }
        return { content: [{ type: "text", text: "{}" }] };
      },
    });
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        rememberDesignFromDispatch: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
          r: ChatToolResult,
        ) => void;
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        resolveDesignLatch: (id: string, p?: string | null) => unknown;
      };
      svc.rememberDesignFromDispatch(
        conversation,
        "design_loop_start",
        { brief: "login page mock" },
        {
          content: [
            { type: "text", text: "loopId: dl-1\nstatus: open" },
            { type: "text", text: '{"version":1}' },
          ],
        },
      );
      const latch = svc.resolveDesignLatch(conversation.id, "p1") as {
        loopId: string;
        currentVersion?: number;
      };
      assert.equal(latch.loopId, "dl-1");
      assert.equal(latch.currentVersion, 1);

      const filled = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_get",
        {},
        "p1",
      );
      assert.equal(filled.loopId, "dl-1");

      // Explicit loopId wins over the latch.
      const explicit = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_get",
        { loopId: "other" },
        "p1",
      );
      assert.equal(explicit.loopId, "other");
    } finally {
      cleanup();
    }
  });

  it("accept clears the latch; discard keeps latch and updates version", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        rememberDesignFromDispatch: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
          r: ChatToolResult,
        ) => void;
        resolveDesignLatch: (id: string, p?: string | null) => unknown;
      };
      const result: ChatToolResult = {
        content: [{ type: "text", text: "loopId: dl-1\nstatus: open" }],
      };
      svc.rememberDesignFromDispatch(conversation, "design_loop_start", {}, result);
      assert.ok(svc.resolveDesignLatch(conversation.id, "p1"));
      svc.rememberDesignFromDispatch(
        conversation,
        "design_loop_discard",
        { loopId: "dl-1" },
        {
          content: [
            {
              type: "text",
              text: 'loopId: dl-1\nstatus: open\n---\n{"version":6}',
            },
          ],
        },
      );
      const afterDiscard = svc.resolveDesignLatch(conversation.id, "p1") as {
        loopId: string;
        currentVersion?: number;
      };
      assert.equal(afterDiscard.loopId, "dl-1");
      assert.equal(afterDiscard.currentVersion, 6);
      svc.rememberDesignFromDispatch(
        conversation,
        "design_loop_accept",
        { loopId: "dl-1" },
        { content: [{ type: "text", text: "loopId: dl-1\nstatus: accepted" }] },
      );
      assert.equal(svc.resolveDesignLatch(conversation.id, "p1"), undefined);
    } finally {
      cleanup();
    }
  });

  it("clears design latches in close and delete", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        designLatches: Map<string, unknown>;
      };
      svc.designLatches.set(conversation.id, { loopId: "dl-1" });
      service.closeConversation(conversation.id);
      assert.equal(svc.designLatches.has(conversation.id), false);

      const c2 = service.createConversation({ projectId: "p1" });
      svc.designLatches.set(c2.id, { loopId: "dl-2" });
      service.deleteConversation(c2.id);
      assert.equal(svc.designLatches.has(c2.id), false);
    } finally {
      cleanup();
    }
  });

  it("reroutes design_loop_get to continue on visual feedback", async () => {
    const { service, cleanup } = makeService({
      classifyDesignTurn: async () => ({
        action: "continue",
        notes: "visual feedback",
      }),
    });
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        designLatches: Map<string, unknown>;
        turnOperatorMessage: string;
        maybeRerouteDesignLoopTool: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
        ) => Promise<{ name: string; args: Record<string, unknown> } | null>;
      };
      svc.designLatches.set(conversation.id, {
        loopId: "dl-1",
        status: "open",
        currentVersion: 2,
      });
      svc.turnOperatorMessage = "make the header darker";
      const rerouted = await svc.maybeRerouteDesignLoopTool(
        conversation,
        "design_loop_get",
        {},
      );
      assert.ok(rerouted);
      assert.equal(rerouted.name, "design_loop_continue");
      assert.equal(rerouted.args.loopId, "dl-1");
      assert.equal(rerouted.args.message, "make the header darker");
    } finally {
      cleanup();
    }
  });

  it("reroutes design_loop_get to accept when the operator is satisfied", async () => {
    const { service, cleanup } = makeService({
      classifyDesignTurn: async () => ({ action: "accept", notes: "ship it" }),
    });
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        designLatches: Map<string, unknown>;
        turnOperatorMessage: string;
        maybeRerouteDesignLoopTool: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
        ) => Promise<{ name: string; args: Record<string, unknown> } | null>;
      };
      svc.designLatches.set(conversation.id, { loopId: "dl-1", status: "open" });
      svc.turnOperatorMessage = "looks great, use this one";
      const rerouted = await svc.maybeRerouteDesignLoopTool(
        conversation,
        "design_loop_get",
        {},
      );
      assert.ok(rerouted);
      assert.equal(rerouted.name, "design_loop_accept");
      assert.equal(rerouted.args.loopId, "dl-1");
    } finally {
      cleanup();
    }
  });

  it("does not reroute status/unrelated or without an open latch", async () => {
    const { service, cleanup } = makeService({
      classifyDesignTurn: async () => ({ action: "status", notes: "" }),
    });
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        designLatches: Map<string, unknown>;
        turnOperatorMessage: string;
        maybeRerouteDesignLoopTool: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
        ) => Promise<{ name: string; args: Record<string, unknown> } | null>;
      };
      // No latch at all.
      svc.turnOperatorMessage = "make it darker";
      assert.equal(
        await svc.maybeRerouteDesignLoopTool(conversation, "design_loop_get", {}),
        null,
      );
      // Latch but classifier says status.
      svc.designLatches.set(conversation.id, { loopId: "dl-1", status: "open" });
      assert.equal(
        await svc.maybeRerouteDesignLoopTool(conversation, "design_loop_get", {}),
        null,
      );
      // Non-get tools are never rerouted.
      assert.equal(
        await svc.maybeRerouteDesignLoopTool(
          conversation,
          "design_loop_continue",
          {},
        ),
        null,
      );
    } finally {
      cleanup();
    }
  });

  it("global chat confirm of design_loop_start without projectId fails explicitly", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { service, cleanup } = makeService({
      dispatch: async (name, args): Promise<ChatToolResult> => {
        dispatched.push({ name, args });
        return { content: [{ type: "text", text: "{}" }] };
      },
    });
    try {
      // Global chat: no pinned project.
      const conversation = service.createConversation({ projectId: null });
      const token = (
        service as unknown as {
          requestConfirmation: (
            c: ChatConversation,
            t: string,
            a: Record<string, unknown>,
          ) => { token: string };
        }
      ).requestConfirmation(conversation, "design_loop_start", {
        brief: "login page mock",
      }).token;

      const result = await service.confirm({
        conversationId: conversation.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, false);
      assert.match(result.reply ?? "", /requires projectId in global chat/);
      assert.equal(dispatched.length, 0);
    } finally {
      cleanup();
    }
  });

  it("global chat confirm of design_loop_start with projectId dispatches", async () => {
    const dispatched: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { service, cleanup } = makeService({
      dispatch: async (name, args): Promise<ChatToolResult> => {
        dispatched.push({ name, args });
        return { content: [{ type: "text", text: "loopId: dl-9\nstatus: open" }] };
      },
    });
    try {
      const conversation = service.createConversation({ projectId: null });
      const token = (
        service as unknown as {
          requestConfirmation: (
            c: ChatConversation,
            t: string,
            a: Record<string, unknown>,
          ) => { token: string };
        }
      ).requestConfirmation(conversation, "design_loop_start", {
        brief: "login page mock",
        projectId: "p1",
      }).token;

      const result = await service.confirm({
        conversationId: conversation.id,
        token,
        approve: true,
        skipSynthetic: true,
      });
      assert.equal(result.ok, true);
      // Async live turn: dispatch happens in the background.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(dispatched.length, 1);
      assert.equal(dispatched[0]!.name, "design_loop_start");
    } finally {
      cleanup();
    }
  });

  it("global chat discard fills loopId from latch when projectId is in args", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: null });
      const svc = service as unknown as {
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        designLatches: Map<string, { loopId: string; projectId?: string }>;
      };
      svc.designLatches.set(conversation.id, {
        loopId: "bca8e590-aaaa-bbbb-cccc-ddddeeeeffff",
        projectId: "p1",
      });
      const filled = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_discard",
        { projectId: "p1" },
        "p1",
      );
      assert.equal(filled.loopId, "bca8e590-aaaa-bbbb-cccc-ddddeeeeffff");
      assert.equal(filled.projectId, "p1");
    } finally {
      cleanup();
    }
  });

  it("abandon clears the latch", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: "p1" });
      const svc = service as unknown as {
        rememberDesignFromDispatch: (
          c: unknown,
          n: string,
          a: Record<string, unknown>,
          r: ChatToolResult,
        ) => void;
        resolveDesignLatch: (id: string, p?: string | null) => unknown;
      };
      svc.rememberDesignFromDispatch(
        conversation,
        "design_loop_start",
        {},
        { content: [{ type: "text", text: "loopId: dl-1\nstatus: open" }] },
      );
      assert.ok(svc.resolveDesignLatch(conversation.id, "p1"));
      svc.rememberDesignFromDispatch(
        conversation,
        "design_loop_abandon",
        { loopId: "dl-1", reason: "completely wrong" },
        { content: [{ type: "text", text: "loopId: dl-1\nstatus: abandoned" }] },
      );
      assert.equal(svc.resolveDesignLatch(conversation.id, "p1"), undefined);
    } finally {
      cleanup();
    }
  });

  it("global chat discard backfills version from latch currentVersion", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: null });
      const svc = service as unknown as {
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        designLatches: Map<
          string,
          { loopId: string; projectId?: string; currentVersion?: number }
        >;
      };
      svc.designLatches.set(conversation.id, {
        loopId: "c20498ef-1111-2222-3333-444455556666",
        projectId: "p1",
        currentVersion: 7,
      });
      const filled = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_discard",
        { projectId: "p1" },
        null,
      );
      assert.equal(filled.loopId, "c20498ef-1111-2222-3333-444455556666");
      assert.equal(filled.version, 7);
    } finally {
      cleanup();
    }
  });

  it("global chat fills from latch via args.projectId when conversation project is null", () => {
    const { service, cleanup } = makeService();
    try {
      const conversation = service.createConversation({ projectId: null });
      const svc = service as unknown as {
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        designLatches: Map<string, { loopId: string; projectId?: string }>;
      };
      svc.designLatches.set(conversation.id, {
        loopId: "dl-9",
        projectId: "p1",
      });
      // Global chat path: conversation.projectId is null, the agent passed
      // projectId only in the tool args (the jamroast-components failure).
      const filled = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_accept",
        { projectId: "p1" },
        null,
      );
      assert.equal(filled.loopId, "dl-9");
      assert.equal(filled.projectId, "p1");
    } finally {
      cleanup();
    }
  });

  it("explicit loopId + projectId seeds the latch for later omission", () => {
    const { service, dir, cleanup } = makeService();
    try {
      writeDesignLoopMeta(dir, "dl-seed", { brief: "seeded loop" });
      const conversation = service.createConversation({ projectId: null });
      const svc = service as unknown as {
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        resolveDesignLatch: (
          id: string,
          p?: string | null,
        ) => { loopId: string; projectId?: string } | undefined;
      };
      // First call passes both explicitly — no latch exists yet.
      const first = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_get",
        { loopId: "dl-seed", projectId: "p1" },
        null,
      );
      assert.equal(first.loopId, "dl-seed");
      const latch = svc.resolveDesignLatch(conversation.id, "p1");
      assert.equal(latch?.loopId, "dl-seed");
      assert.equal(latch?.projectId, "p1");
      // Second call can omit loopId — the seeded latch fills it.
      const second = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_get",
        { projectId: "p1" },
        null,
      );
      assert.equal(second.loopId, "dl-seed");
    } finally {
      cleanup();
    }
  });

  it("explicit different loopId switches the latch", () => {
    const { service, dir, cleanup } = makeService();
    try {
      writeDesignLoopMeta(dir, "dl-a", { brief: "loop a" });
      writeDesignLoopMeta(dir, "dl-b", { brief: "loop b" });
      const conversation = service.createConversation({ projectId: null });
      const svc = service as unknown as {
        fillLatchedToolArgs: (
          id: string,
          t: string,
          a: Record<string, unknown>,
          p?: string | null,
        ) => Record<string, unknown>;
        resolveDesignLatch: (
          id: string,
          p?: string | null,
        ) => { loopId: string } | undefined;
        designLatches: Map<string, { loopId: string; projectId?: string }>;
      };
      svc.designLatches.set(conversation.id, {
        loopId: "dl-a",
        projectId: "p1",
      });
      // Agent targets the other loop explicitly (multiple open loops).
      svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_get",
        { loopId: "dl-b", projectId: "p1" },
        null,
      );
      assert.equal(svc.resolveDesignLatch(conversation.id, "p1")?.loopId, "dl-b");
      // Subsequent omission now fills the switched loop.
      const filled = svc.fillLatchedToolArgs(
        conversation.id,
        "design_loop_continue",
        { projectId: "p1", message: "darker" },
        null,
      );
      assert.equal(filled.loopId, "dl-b");
    } finally {
      cleanup();
    }
  });
});
