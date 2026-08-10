import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  askProgressFromStreamChunk,
  askProgressLine,
  clipAskProgress,
  decideNarrationSynthesis,
  formatAskWorkingStub,
  hasSubstantiveReplyMarkers,
  isAskNarrationOnlyReply,
  isLiveTurnInterruptedError,
  LiveTurnInterruptedError,
  summarizeToolArgs,
  summarizeToolResult,
  type NarrationJudgeFn,
} from "./ask-stream.js";

describe("ask-stream helpers", () => {
  it("summarizes tool args and results", () => {
    assert.match(
      summarizeToolArgs("grep_files", {
        path: "playground",
        pattern: "@source",
      }),
      /grep_files.*path=playground.*pattern=@source/,
    );
    assert.equal(
      summarizeToolResult("grep_files", { matches: [1, 2], count: 2 }),
      "grep_files → 2 match(es)",
    );
    assert.match(
      summarizeToolResult("read_file", { content: "a\nb\nc", lines: 3 }),
      /3 line/,
    );
  });

  it("maps stream chunks to progress events", () => {
    const call = askProgressFromStreamChunk({
      type: "tool-call",
      payload: {
        toolName: "read_file",
        args: { path: "src/menubar.tsx" },
      },
    });
    assert.equal(call[0]?.type, "tool_call");
    assert.match(String(call[0] && "summary" in call[0] ? call[0].summary : ""), /read_file/);

    const result = askProgressFromStreamChunk({
      type: "tool-result",
      payload: {
        toolName: "read_file",
        result: { content: "x", lines: 1 },
      },
    });
    assert.equal(result[0]?.type, "tool_result");

    const text = askProgressFromStreamChunk({
      type: "text-delta",
      payload: { text: "Hello" },
    });
    assert.deepEqual(text, [{ type: "text", text: "Hello" }]);
  });

  it("detects narration-only replies for synthesis", () => {
    assert.equal(isAskNarrationOnlyReply(""), true);
    assert.equal(
      isAskNarrationOnlyReply(
        "Let me investigate both issues.I'll start by exploring.Now let me check the styles:",
      ),
      true,
    );
    assert.equal(
      isAskNarrationOnlyReply(
        "## Root cause\n\nThemeToggle is mounted in `menubar.tsx` but playground CSS lacks `@source`.\n\n## Task brief\n- Title: Fix visibility\n- Goal: emit utilities",
      ),
      false,
    );
  });

  it("dangling fragment mentioning root cause is narration (JamLight regression)", () => {
    // The exact fragment that leaked through as a final answer: "root cause"
    // phrase with no length floor vetoed both the heuristic and the judge.
    const fragment =
      "Now I can see the root cause clearly. Let me verify one more thing — the `ai` package exports:";
    assert.equal(hasSubstantiveReplyMarkers(fragment), false);
    assert.equal(isAskNarrationOnlyReply(fragment), true);
  });

  it("length-gated markers still accept real analyses", () => {
    const longAnalysis = `## Root cause\n\n${"The chat route builds ModelMessage[] incorrectly. ".repeat(12)}\nFixed in src/app/api/chat/route.ts.`;
    assert.equal(hasSubstantiveReplyMarkers(longAnalysis), true);
    assert.equal(isAskNarrationOnlyReply(longAnalysis), false);
    // Short mention without narration intent or dangling colon is an answer.
    assert.equal(
      isAskNarrationOnlyReply("The root cause is X. Fixed in y.ts."),
      false,
    );
  });

  it("exports LiveTurnInterruptedError", () => {
    const err = new LiveTurnInterruptedError("Live turn interrupted", "partial");
    assert.equal(isLiveTurnInterruptedError(err), true);
    assert.equal(err.partialReply, "partial");
  });

  it("formats working stub and progress lines", () => {
    assert.equal(clipAskProgress("abc", 10), "abc");
    assert.match(clipAskProgress("a".repeat(200), 20), /…$/);
    const stub = formatAskWorkingStub([
      "grep_files @source",
      "read_file menubar.tsx",
    ]);
    assert.match(stub, /Working…/);
    assert.match(stub, /grep_files/);
    assert.equal(
      askProgressLine({
        type: "tool_call",
        tool: "x",
        summary: "read_file path=a",
      }),
      "read_file path=a",
    );
    assert.equal(askProgressLine({ type: "text", text: "hi" }), null);
  });
});

describe("decideNarrationSynthesis", () => {
  const narrationReply =
    "Let me investigate both issues.I'll start by exploring.Now let me check the styles:";

  it("synthesizes on heuristic alone when no judge is bound", async () => {
    const decision = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 3,
      synthesizeIfNarration: true,
    });
    assert.equal(decision.synthesize, true);
    assert.equal(decision.judgeOverrode, false);
  });

  it("fragment that names root cause mid-narration reaches the judge", async () => {
    const decision = await decideNarrationSynthesis({
      reply:
        "Now I can see the root cause clearly. Let me verify one more thing — the `ai` package exports:",
      toolCallCount: 22,
      synthesizeIfNarration: true,
      judgeFn: async () => ({ narrationOnly: true, reason: "dangling" }),
    });
    assert.equal(decision.synthesize, true);
    assert.equal(decision.heuristicFlagged, true);
  });

  it("judge deny path skips synthesis", async () => {
    const judgeFn: NarrationJudgeFn = async () => ({
      narrationOnly: false,
      reason: "Reply names the failing file and line.",
    });
    const decision = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 3,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, false);
    assert.equal(decision.judgeOverrode, true);
    assert.match(decision.judgeReason ?? "", /failing file/);
  });

  it("judge confirm keeps synthesis", async () => {
    const judgeFn: NarrationJudgeFn = async () => ({
      narrationOnly: true,
      reason: "Pure progress chatter, no findings.",
    });
    const decision = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 3,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, true);
    assert.equal(decision.judgeOverrode, false);
  });

  it("judge throw → synthesis proceeds (current behavior)", async () => {
    const judgeFn: NarrationJudgeFn = async () => {
      throw new Error("endpoint down");
    };
    const decision = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 3,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, true);
    assert.equal(decision.judgeOverrode, false);
  });

  it("never calls the judge when the heuristic does not flag narration", async () => {
    let judgeCalls = 0;
    const judgeFn: NarrationJudgeFn = async () => {
      judgeCalls += 1;
      return { narrationOnly: true, reason: "x" };
    };
    const substantive = `## Root cause\n\n${"ThemeToggle is mounted in menubar.tsx but playground CSS lacks @source coverage. ".repeat(8)}`;
    const decision = await decideNarrationSynthesis({
      reply: substantive,
      toolCallCount: 3,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, false);
    assert.equal(judgeCalls, 0);
  });

  it("never synthesizes without tool calls or when disabled", async () => {
    const noTools = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 0,
      synthesizeIfNarration: true,
      judgeFn: async () => ({ narrationOnly: true, reason: "x" }),
    });
    assert.equal(noTools.synthesize, false);

    const disabled = await decideNarrationSynthesis({
      reply: narrationReply,
      toolCallCount: 5,
      synthesizeIfNarration: false,
      judgeFn: async () => ({ narrationOnly: true, reason: "x" }),
    });
    assert.equal(disabled.synthesize, false);
  });

  // Regression: 2026-08-06 ask turn — a step-exhausted agent's concatenated
  // working monologue (1 367 chars, many "Let me check") blew the heuristic
  // length caps, so the raw stub was persisted as the final answer.
  const longMonologue = Array.from(
    { length: 6 },
    (_, i) =>
      `Investigation step ${i + 1} revealed more context about the installed package layout, its exported types, and how the lockfile resolves the dependency during a clean docker build. Let me check the next file to confirm what is actually resolved at runtime in this environment.`,
  ).join(" ");

  it("judge rescues a heuristic miss on long unfinished monologue", async () => {
    assert.equal(isAskNarrationOnlyReply(longMonologue), false);
    assert.equal(hasSubstantiveReplyMarkers(longMonologue), false);
    let judgeCalls = 0;
    const judgeFn: NarrationJudgeFn = async () => {
      judgeCalls += 1;
      return { narrationOnly: true, reason: "Unfinished investigation chatter." };
    };
    const decision = await decideNarrationSynthesis({
      reply: longMonologue,
      toolCallCount: 20,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(judgeCalls, 1);
    assert.equal(decision.synthesize, true);
    assert.equal(decision.heuristicFlagged, false);
    assert.equal(decision.judgeOverrode, false);
  });

  it("judge can confirm a long heuristic-miss reply as substantive", async () => {
    const judgeFn: NarrationJudgeFn = async () => ({
      narrationOnly: false,
      reason: "Contains real findings.",
    });
    const decision = await decideNarrationSynthesis({
      reply: longMonologue,
      toolCallCount: 20,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, false);
    assert.equal(decision.judgeOverrode, false);
  });

  it("heuristic miss without judge keeps prior no-synthesis behavior", async () => {
    const decision = await decideNarrationSynthesis({
      reply: longMonologue,
      toolCallCount: 20,
      synthesizeIfNarration: true,
    });
    assert.equal(decision.synthesize, false);
  });

  it("heuristic miss + judge error fails closed (no synthesis)", async () => {
    const judgeFn: NarrationJudgeFn = async () => {
      throw new Error("endpoint down");
    };
    const decision = await decideNarrationSynthesis({
      reply: longMonologue,
      toolCallCount: 20,
      synthesizeIfNarration: true,
      judgeFn,
    });
    assert.equal(decision.synthesize, false);
  });
});
