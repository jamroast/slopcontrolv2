import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAskResumeDecision,
  askLatchAppliesToProject,
  ASK_ID_DEPENDENT_TOOLS,
  askTitleFromOperatorMessage,
  composeAskDispatchMessage,
  decideAskResume,
  extractAnchors,
  parseAskIdFromDispatch,
  type AskResumeLatch,
} from "./ask-routing.js";

const dockerLatch: AskResumeLatch = {
  askId: "ask-docker",
  title: "The command npm run manage -- up is failing to build",
  lastUserLine: "Please identify what needs to be done to fix this docker build",
  status: "open",
};

describe("decideAskResume", () => {
  it("honors explicit askId over the latch", () => {
    const d = decideAskResume({
      operatorMessage: "look at /product",
      args: { askId: "ask-other" },
      latch: dockerLatch,
    });
    assert.deepEqual(d, {
      kind: "continue",
      askId: "ask-other",
      reason: "explicit askId",
    });
  });

  it("honors explicit newAsk", () => {
    const d = decideAskResume({
      operatorMessage: "why?",
      args: { newAsk: true },
      latch: dockerLatch,
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.equal(d.reason, "explicit newAsk");
  });

  it("starts new when there is no latch", () => {
    const d = decideAskResume({
      operatorMessage: "why is the sign-in button a no-op?",
      args: {},
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.equal(d.reason, "no latch");
  });

  it("starts new when the latch is promoted", () => {
    const d = decideAskResume({
      operatorMessage: "go deeper on the same docker issue",
      args: {},
      latch: { ...dockerLatch, status: "promoted" },
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.match(d.reason, /not open/);
  });

  it("continues a short follow-up on the same investigation", () => {
    const d = decideAskResume({
      operatorMessage: "what about the registry?",
      args: {},
      latch: dockerLatch,
    });
    assert.equal(d.kind, "continue");
    if (d.kind === "continue") assert.equal(d.askId, "ask-docker");
  });

  it("starts new when the operator names a different route", () => {
    const d = decideAskResume({
      operatorMessage:
        "great thanks for fixing that. Could you review the /product route",
      args: {},
      latch: dockerLatch,
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.match(d.reason, /\/product/);
  });

  it("starts new on a product-page review vs a docker latch (low overlap)", () => {
    const d = decideAskResume({
      operatorMessage:
        "Could you review the scope of jampress and see if the product page does it justice now with all of the development",
      args: {},
      latch: dockerLatch,
    });
    assert.equal(d.kind, "new");
  });

  it("starts new on topic-shift cues even without a new route", () => {
    const d = decideAskResume({
      operatorMessage: "now look at multi-tenancy instead",
      args: {},
      latch: dockerLatch,
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.equal(d.reason, "topic-shift cue");
  });

  it("continues when overlap with the latch title is high", () => {
    const d = decideAskResume({
      operatorMessage:
        "The docker build is still failing during npm run manage -- up — same manage CLI error",
      args: {},
      latch: dockerLatch,
    });
    assert.equal(d.kind, "continue");
  });

  it("starts new when latch projectId differs from target project", () => {
    const d = decideAskResume({
      operatorMessage: "double check env vars for verifier flip",
      args: {},
      latch: {
        ...dockerLatch,
        projectId: "fb671505-1517-41bd-86b4-55304d770647",
      },
      projectId: "8301239a-b4c7-42a1-b575-0cc6b190640f",
    });
    assert.equal(d.kind, "new");
    if (d.kind === "new") assert.equal(d.reason, "cross-project");
  });
});

describe("ask routing helpers", () => {
  it("askLatchAppliesToProject matches same project and rejects cross-project", () => {
    const latch: AskResumeLatch = {
      askId: "ask-1",
      projectId: "p-components",
      status: "open",
    };
    assert.equal(askLatchAppliesToProject(latch, "p-components"), true);
    assert.equal(askLatchAppliesToProject(latch, "p-jamroast"), false);
    assert.equal(askLatchAppliesToProject(latch, undefined), true);
    assert.equal(askLatchAppliesToProject(null, "p-jamroast"), false);
  });

  it("extracts routes and source paths", () => {
    const a = extractAnchors("see src/app/product/page.tsx and /product/skills");
    assert.ok(a.has("/product"));
    assert.ok(a.has("src/app/product/page.tsx"));
  });

  it("titles a new ask from the first operator line", () => {
    assert.equal(
      askTitleFromOperatorMessage("Review /product\n\nPlease read everything"),
      "Review /product",
    );
  });

  it("applyAskResumeDecision never omits both askId and newAsk", () => {
    const cont = applyAskResumeDecision(
      { kind: "continue", askId: "a1", reason: "x" },
      { message: "hi" },
    );
    assert.equal(cont.askId, "a1");
    assert.equal(cont.newAsk, undefined);

    const fresh = applyAskResumeDecision(
      { kind: "new", title: "T", reason: "x" },
      { message: "hi", askId: "stale" },
    );
    assert.equal(fresh.newAsk, true);
    assert.equal(fresh.askId, undefined);
    assert.equal(fresh.title, "T");
  });

  it("parses askId from MCP envelope or JSON", () => {
    assert.equal(
      parseAskIdFromDispatch("askId: abc-123\nstatus: open\n---\nhello"),
      "abc-123",
    );
    assert.equal(
      parseAskIdFromDispatch(JSON.stringify({ askId: "z9", reply: "ok" })),
      "z9",
    );
  });

  it("lists askId-dependent tools that must not use latestOpenAsk", () => {
    assert.ok(ASK_ID_DEPENDENT_TOOLS.has("promote_ask"));
    assert.ok(ASK_ID_DEPENDENT_TOOLS.has("get_ask"));
    assert.ok(ASK_ID_DEPENDENT_TOOLS.has("fork_ask"));
    assert.ok(ASK_ID_DEPENDENT_TOOLS.has("ask_sub_research"));
    assert.equal(ASK_ID_DEPENDENT_TOOLS.has("design_loop_start"), false);
  });
});

describe("composeAskDispatchMessage", () => {
  it("passes through when chat already used the operator words", () => {
    const msg = "why is sign-in broken?";
    assert.equal(
      composeAskDispatchMessage({ operatorMessage: msg, chatMessage: msg }),
      msg,
    );
  });

  it("keeps the operator request when chat rewrote a file checklist", () => {
    const out = composeAskDispatchMessage({
      operatorMessage:
        "investigate the contents of the /product route. Do we need to update it for marketplace and chat?",
      chatMessage:
        "Read src/app/product/page.tsx and score each claim against schema.ts",
    });
    assert.match(out, /^Operator request:/);
    assert.match(out, /\/product route/);
    assert.match(out, /do not replace the operator request/i);
    assert.match(out, /schema\.ts/);
  });

  it("attaches the prior operator question on a short redo", () => {
    const out = composeAskDispatchMessage({
      operatorMessage: "Please can you redo that research",
      chatMessage: "Read every product page and audit claims",
      priorOperatorQuestion:
        "investigate the contents of the /product route vs marketplace and chat",
    });
    assert.match(out, /Please can you redo that research/);
    assert.match(out, /Prior operator question this refers to/);
    assert.match(out, /\/product route vs marketplace/);
    assert.match(out, /Chat investigation notes/);
  });
});
