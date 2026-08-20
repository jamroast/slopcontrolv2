import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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

  it("accept and discard clear the latch", () => {
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
});
