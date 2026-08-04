import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultPlanScope,
  summarizeBriefForGoal,
  scaffoldPlanDocument,
  failurePlanDocument,
  validatePlanDocument,
} from "./plan-loop.js";

const CHAT_BRIEF = `I need you to now please investigate the project JamPress, and JamRoast. The jampress project contains chat functionality, whats more important there is the dynamic ability to define a chat gathering concept as the chat proceeds. What I mean by that is that JamPress is a integration platform. A chat driven integration platform that needs to be as simple as possible. What we need from that is to be able to loop on various tasks until a point is reached, while integrating with a backend service. It would be great to externalise this chat service as the same functionality is required from all of the applications we are tackling and this might result in a desktop app that uses MCP to integrate with the backend. So what we need is the ability to chat gather data in a way that is very simple to do, which I think the JamPress app was beginning to get close to. Then in the jampress app we create a workflow or a connection or do a mixture of those things depending on how the user is interacting with the chat. But we need a means to tell the chat how to react, what is available what are the rules etc, and then the chat interacts with the app, it does stuff. The idea is not to red-develop this rather time consuming item, learn from what we have gone through in the JamPress application and apply this to a generic component with the vision of dealing with not only workflows, but CRM entity management, Invoice management, Timesheet management, Project Management. This means we need the system being consumed to define a schema of some form that we can then interrogate, and populate correctly. And that this schema change dinamically as well depending on configuration and action. First component a complex chat system for ai. Please research this, and present me with a plan`;

describe("defaultPlanScope investigate hygiene", () => {
  it("chat / first component brief → focus chat, not invoice", () => {
    const scope = defaultPlanScope(CHAT_BRIEF, "start");
    assert.equal(scope.focus, "chat");
    assert.notEqual(scope.focus, "invoice");
    assert.ok(scope.kind === "spike" || scope.kind === "feature");
  });

  it("not only workflows must not preserve brand/shell", () => {
    const scope = defaultPlanScope(
      "vision of dealing with not only workflows, but CRM entity management",
      "start",
    );
    assert.ok(!scope.preserve.includes("brand"));
    assert.ok(!scope.preserve.includes("shell"));
  });
});

describe("summarizeBriefForGoal / failurePlanDocument", () => {
  it("summarizeBriefForGoal bounds length", () => {
    const s = summarizeBriefForGoal(CHAT_BRIEF, 240);
    assert.ok(s.length <= 240);
    assert.ok(s.length > 20);
    assert.ok(!s.includes("Invoice management") || s.length <= 240);
  });

  it("scaffold on errorDetail does not invent invoice focus", () => {
    const poisoned = defaultPlanScope(CHAT_BRIEF, "start");
    // Even if scope were wrong historically, errorDetail resets focus
    const plan = scaffoldPlanDocument({
      brief: CHAT_BRIEF,
      scope: { ...poisoned, focus: "invoice" },
      errorDetail: "empty agent plan",
    });
    assert.match(plan, /focus: change/);
    assert.ok(!/^## In scope\n\n- invoice$/m.test(plan));
    const goalSection = plan.match(/## Goal\n\n([\s\S]*?)\n\n##/)?.[1] ?? "";
    assert.ok(goalSection.length < CHAT_BRIEF.length);
  });

  it("failurePlanDocument validates and asks for retry", () => {
    const plan = failurePlanDocument({
      brief: CHAT_BRIEF,
      errorDetail: "empty agent plan after repair",
    });
    assert.equal(validatePlanDocument(plan).ok, true);
    assert.match(plan, /plan_loop_retry/);
    assert.match(plan, /generation failed/i);
    assert.ok(!/Research current code for invoice/i.test(plan));
  });
});
