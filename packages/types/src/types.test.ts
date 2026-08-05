import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LlmEndpointSchema,
  RunActionSchema,
  formatDurationMs,
  log,
  phaseDependenciesSatisfied,
  recordStageTransition,
  unmetPhaseDependencies,
  type Run,
} from "./index.js";

describe("@slopcontrol/types", () => {
  it("exports a logger", () => {
    assert.equal(typeof log.info, "function");
    log.info("test", "logger smoke", { ok: true });
  });

  it("validates llm endpoint config", () => {
    const parsed = LlmEndpointSchema.parse({
      id: "vercel-glm",
      baseUrl: "https://ai-gateway.vercel.ai/v1",
      apiType: "openai-chat",
      modelId: "zai/glm-5.2",
    });

    assert.equal(parsed.id, "vercel-glm");
  });

  it("validates run actions", () => {
    const parsed = RunActionSchema.parse({
      action: "start_research",
      projectId: "proj-1",
      description: "Add auth middleware",
    });

    assert.equal(parsed.action, "start_research");

    const open = RunActionSchema.parse({
      action: "open_project",
      rootPath: "/tmp/proj",
      forceRefresh: true,
    });
    assert.equal(open.action, "open_project");

    const reinit = RunActionSchema.parse({
      action: "reinit_project",
      rootPath: "/tmp/basic-web-agent",
      notes: "Reset to phase zero",
    });
    assert.equal(reinit.action, "reinit_project");

    const design = RunActionSchema.parse({
      action: "start_design",
      runId: "run-1",
      force: true,
    });
    assert.equal(design.action, "start_design");
    assert.equal(design.force, true);

    const develop = RunActionSchema.parse({
      action: "start_development",
      runId: "run-1",
      autoDesign: true,
    });
    assert.equal(develop.action, "start_development");
    assert.equal(develop.autoDesign, true);

    const retryVerify = RunActionSchema.parse({
      action: "retry_verify",
      runId: "run-1",
    });
    assert.equal(retryVerify.action, "retry_verify");

    const preview = RunActionSchema.parse({
      action: "preview_change_intent",
      projectId: "proj-1",
      description: 'Unable to submit — stuck at "Superseded by a newer form"',
      checkPhaseDoc: true,
      phaseId: "55-phase",
    });
    assert.equal(preview.action, "preview_change_intent");

    const reconcile = RunActionSchema.parse({
      action: "reconcile_blueprint",
      projectId: "proj-1",
      dryRun: true,
    });
    assert.equal(reconcile.action, "reconcile_blueprint");

    const audit = RunActionSchema.parse({
      action: "audit_ui_gates",
      projectId: "proj-1",
      phaseId: "55-phase",
    });
    assert.equal(audit.action, "audit_ui_gates");
  });

  it("validates AskSession schema", async () => {
    const { AskSessionSchema } = await import("./index.js");
    const now = new Date().toISOString();
    const ask = AskSessionSchema.parse({
      id: "ask-1",
      projectId: "proj-1",
      status: "open",
      messages: [{ role: "user", content: "Hi", at: now }],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(ask.messages[0]?.role, "user");
  });

  it("validates AskMessage meta for sub-research and topic cap", async () => {
    const {
      AskMessageSchema,
      AgentSessionSchema,
      ASK_SUB_RESEARCH_MAX_TOPICS,
    } = await import("./index.js");
    assert.equal(ASK_SUB_RESEARCH_MAX_TOPICS, 4);
    const now = new Date().toISOString();
    const msg = AskMessageSchema.parse({
      role: "assistant",
      content: "## Sub-research: Auth\n\nFindings…",
      at: now,
      meta: { kind: "sub_research", topic: "Auth" },
    });
    assert.equal(msg.meta?.kind, "sub_research");
    assert.equal(msg.meta?.topic, "Auth");
    const agent = AgentSessionSchema.parse({
      id: "agent-1",
      projectId: "proj-1",
      status: "open",
      messages: [{ role: "user", content: "git status?", at: now }],
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(agent.status, "open");
    assert.equal(agent.messages.length, 1);
  });

  it("parses endpoint capabilities and openai-images", () => {
    const parsed = LlmEndpointSchema.parse({
      id: "img",
      baseUrl: "http://localhost:11434/v1",
      apiType: "openai-images",
      modelId: "x/z-image-turbo",
      capabilities: { chat: false, vision: false, imageGen: true },
    });
    assert.equal(parsed.apiType, "openai-images");
    assert.equal(parsed.capabilities?.imageGen, true);
  });

  it("checks unmet phase dependencies", () => {
    const phases = [
      {
        id: "01-a",
        projectId: "p",
        description: "a",
        status: "complete" as const,
        dependsOn: [],
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
      },
      {
        id: "02-b",
        projectId: "p",
        description: "b",
        status: "accepted" as const,
        dependsOn: ["01-a", "99-missing"],
        createdAt: "2026-07-17T10:00:00.000Z",
        updatedAt: "2026-07-17T10:00:00.000Z",
      },
    ];
    const unmet = unmetPhaseDependencies(phases[1]!, phases);
    assert.deepEqual(unmet, [{ id: "99-missing", status: "missing" }]);
    assert.equal(phaseDependenciesSatisfied(phases[1]!, phases), false);
    assert.equal(
      phaseDependenciesSatisfied(
        { id: "02-b", dependsOn: ["01-a"] },
        phases,
      ),
      true,
    );
  });

  it("records stage timing transitions", () => {
    const t0 = new Date("2026-07-17T10:00:00.000Z");
    const t1 = new Date("2026-07-17T10:00:05.000Z");
    const t2 = new Date("2026-07-17T10:01:05.000Z");

    const run: Run = {
      id: "r1",
      phaseId: "01-a",
      projectId: "p1",
      stage: "idle",
      iterationCount: 0,
      createdAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
      stageTimings: [{ stage: "idle", startedAt: t0.toISOString() }],
    };

    recordStageTransition(run, "researching", t0);
    assert.equal(run.stage, "researching");
    assert.equal(run.startedAt, t0.toISOString());
    assert.equal(run.stageTimings?.length, 2);

    recordStageTransition(run, "drafting", t1);
    const research = run.stageTimings?.find((s) => s.stage === "researching");
    assert.equal(research?.durationMs, 5000);

    recordStageTransition(run, "complete", t2);
    assert.equal(run.finishedAt, t2.toISOString());
    assert.equal(run.totalDurationMs, 65_000);
    assert.equal(formatDurationMs(65_000), "1m 5s");
  });

  it("clears finishedAt when leaving a terminal stage", () => {
    const t0 = new Date("2026-07-17T10:00:00.000Z");
    const tFail = new Date("2026-07-17T10:00:10.000Z");
    const tRetry = new Date("2026-07-17T10:00:20.000Z");

    const run: Run = {
      id: "r2",
      phaseId: "01-a",
      projectId: "p1",
      stage: "idle",
      iterationCount: 0,
      createdAt: t0.toISOString(),
      updatedAt: t0.toISOString(),
      stageTimings: [{ stage: "idle", startedAt: t0.toISOString() }],
    };

    recordStageTransition(run, "designing", t0);
    recordStageTransition(run, "failed", tFail);
    assert.equal(run.finishedAt, tFail.toISOString());
    assert.ok((run.totalDurationMs ?? 0) >= 0);

    recordStageTransition(run, "designing", tRetry);
    assert.equal(run.finishedAt, undefined);
    assert.equal(run.totalDurationMs, undefined);
    assert.equal(run.stage, "designing");
  });
});
