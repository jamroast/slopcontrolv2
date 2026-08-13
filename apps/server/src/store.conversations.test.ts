import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SlopStore } from "./store.js";
import { planIdleConversationClose } from "./chat-conversation-watcher.js";

function withStore(fn: (store: SlopStore) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "slop-store-chat-"));
  try {
    fn(new SlopStore(join(dir, "store.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("SlopStore conversations", () => {
  it("creates project and global conversations and lists by scope", () => {
    withStore((store) => {
      const projectChat = store.createConversation({ projectId: "p1" });
      const globalChat = store.createConversation({ projectId: null });
      assert.equal(projectChat.status, "active");
      assert.equal(globalChat.projectId, null);

      assert.deepEqual(
        store.listConversations({ projectId: "p1" }).map((c) => c.id),
        [projectChat.id],
      );
      assert.deepEqual(
        store.listConversations({ projectId: null }).map((c) => c.id),
        [globalChat.id],
      );
      assert.equal(store.listConversations().length, 2);
    });
  });

  it("touch bumps lastActiveAt and auto-titles from first message with date", () => {
    withStore((store) => {
      const c = store.createConversation({ projectId: "p1" });
      const before = c.lastActiveAt;
      const touched = store.touchConversation(
        c.id,
        "How do I promote\nan ask?",
      );
      assert.ok(touched);
      assert.ok(touched.lastActiveAt >= before);
      // "Mar 5 — How do I promote an ask?"
      assert.match(touched.title!, /^[A-Z][a-z]{2} \d{1,2} — How do I promote an ask\?$/);
      // Title sticks — later touches don't overwrite
      const again = store.touchConversation(c.id, "different topic");
      assert.equal(again?.title, touched.title);
    });
  });

  it("close sets status + closedAt; delete removes the row", () => {
    withStore((store) => {
      const c = store.createConversation({ projectId: null });
      const closed = store.closeConversation(c.id);
      assert.equal(closed?.status, "closed");
      assert.ok(closed?.closedAt);
      assert.equal(
        store.listConversations({ status: "active" }).length,
        0,
      );
      assert.equal(store.deleteConversation(c.id), true);
      assert.equal(store.getConversation(c.id), undefined);
      assert.equal(store.deleteConversation(c.id), false);
    });
  });

  it("clearProjectWork removes project conversations but keeps global", () => {
    withStore((store) => {
      store.createConversation({ projectId: "p1" });
      store.createConversation({ projectId: null });
      const result = store.clearProjectWork("p1");
      assert.equal(result.conversationsRemoved, 1);
      assert.equal(store.listConversations().length, 1);
      assert.equal(store.listConversations()[0]!.projectId, null);
    });
  });

  it("persists conversations across store reload", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-store-chat-"));
    try {
      const path = join(dir, "store.json");
      const first = new SlopStore(path);
      const c = first.createConversation({
        projectId: "p1",
        modelOverride: { endpointId: "e1", modelId: "m1" },
      });
      const second = new SlopStore(path);
      const loaded = second.getConversation(c.id);
      assert.ok(loaded);
      assert.deepEqual(loaded.modelOverride, { endpointId: "e1", modelId: "m1" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planIdleConversationClose", () => {
  it("flags only conversations idle past maxIdleMs", () => {
    const now = new Date("2026-08-13T12:00:00Z");
    const plan = planIdleConversationClose(
      [
        { id: "fresh", lastActiveAt: "2026-08-13T11:59:00Z" },
        { id: "stale", lastActiveAt: "2026-08-12T12:00:00Z" },
        { id: "boundary", lastActiveAt: "2026-08-13T11:00:00Z" },
      ],
      60 * 60 * 1_000,
      now,
    );
    assert.deepEqual(plan.sort(), ["boundary", "stale"]);
  });
});
