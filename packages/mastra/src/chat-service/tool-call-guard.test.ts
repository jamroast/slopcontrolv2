import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createToolCallGuard } from "./tool-call-guard.js";
import { formatRunNotificationBrief } from "./run-settled-notification.js";

describe("formatRunNotificationBrief", () => {
  it("strips bracket wrapper from system notifications", () => {
    const brief = formatRunNotificationBrief(
      "[Run run-1 reached complete. Development finished successfully.]",
    );
    assert.equal(brief, "Run run-1 reached complete. Development finished successfully.");
  });

  it("summarises a live-turn settled note without the fenced doc dump", () => {
    const note = [
      "[live turn marketing_loop_continue settled]",
      "loopId: loop-1",
      "status: open",
      "version: 2",
      "verdict: ok=true gaps=0",
      "nextStep: marketing_loop_continue to revise, or marketing_loop_accept when the judge has passed",
      "---",
      "```markdown",
      "# MARKETING.md — jamauth (v2)",
      "",
      "## Audience",
      "...full document body that must not be echoed...",
      "```",
    ].join("\n");
    const brief = formatRunNotificationBrief(note);
    assert.equal(
      brief,
      "marketing_loop_continue complete — status: open; version: 2; verdict: ok=true gaps=0; nextStep: marketing_loop_continue to revise, or marketing_loop_accept when the judge has passed",
    );
    assert.ok(!brief.includes("```"), "brief must not contain the doc fence");
    assert.ok(!brief.includes("## Audience"), "brief must not echo doc body");
  });

  it("summarises a live-turn FAILED note as a failure brief", () => {
    const brief = formatRunNotificationBrief(
      "[live turn design_loop_continue FAILED]\nERROR:\nLLM timed out after 240000ms",
    );
    assert.equal(brief, "design_loop_continue failed: LLM timed out after 240000ms");
  });

  it("strips the operator-confirm prefix, keeping the started message", () => {
    const brief = formatRunNotificationBrief(
      "[operator CONFIRMED marketing_loop_continue] Marketing loop turn started. You'll be notified when MARKETING.md is ready — do not poll marketing_loop_get.",
    );
    assert.equal(
      brief,
      "Marketing loop turn started. You'll be notified when MARKETING.md is ready — do not poll marketing_loop_get.",
    );
  });

  it("passes through non-bracketed text unchanged", () => {
    assert.equal(formatRunNotificationBrief("plain note"), "plain note");
  });

  it("summarises live-turn settled notes with an empty payload as a bare complete", () => {
    assert.equal(
      formatRunNotificationBrief("[live turn plan_loop_continue settled]"),
      "plan_loop_continue complete.",
    );
    assert.equal(
      formatRunNotificationBrief("[live turn plan_loop_continue settled]\n"),
      "plan_loop_continue complete.",
    );
  });
});

describe("createToolCallGuard", () => {
  it("blocks a third identical read-only tool call in one turn", () => {
    const guard = createToolCallGuard();
    const args = { runId: "r1" };
    assert.equal(guard.check("get_run", args), null);
    assert.equal(guard.check("get_run", args), null);
    assert.match(
      guard.check("get_run", args) ?? "",
      /disabled for this turn/,
    );
  });

  it("does not guard mutating or conversational tools", () => {
    const guard = createToolCallGuard();
    const args = { message: "hi" };
    assert.equal(guard.check("ask", args), null);
    assert.equal(guard.check("ask", args), null);
    assert.equal(guard.check("ask", args), null);
  });
});
