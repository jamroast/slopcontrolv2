import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildLibraryPublishFailureDiagnosis,
  phaseTouchedEnvTemplates,
  buildEnvSyncFailureDiagnosis,
  summarizeLibraryPublishResponse,
} from "./index.js";

describe("summarizeLibraryPublishResponse", () => {
  it("success with consumers counts updates", () => {
    const out = summarizeLibraryPublishResponse(200, {
      name: "@jamroast/components",
      version: "0.0.1",
      propagation: [{ ok: true }, { ok: false }],
    });
    assert.equal(out.ok, true);
    assert.match(out.summary, /@jamroast\/components@0\.0\.1 published/);
    assert.match(out.summary, /1\/2 consumers updated/);
  });

  it("success without consumers says so", () => {
    const out = summarizeLibraryPublishResponse(200, {
      name: "@jamroast/components",
      version: "0.0.1",
    });
    assert.equal(out.ok, true);
    assert.match(out.summary, /no registered consumers/);
  });

  it("HTTP failure surfaces the server error (phase must stay complete)", () => {
    const out = summarizeLibraryPublishResponse(400, {
      error: "version bump failed (1): boom",
    });
    assert.equal(out.ok, false);
    assert.match(out.summary, /version bump failed/);
  });

  it("HTTP failure without body error falls back to status", () => {
    const out = summarizeLibraryPublishResponse(500, {});
    assert.equal(out.ok, false);
    assert.match(out.summary, /HTTP 500/);
  });
});

describe("buildLibraryPublishFailureDiagnosis", () => {
  it("produces an operator-facing advisory that does not block the phase", () => {
    const d = buildLibraryPublishFailureDiagnosis({
      summary: "version bump failed (1): npm error Git working directory not clean",
      phaseId: "15-x",
      runId: "run-1",
    });
    assert.equal(d.audience, "operator");
    assert.equal(d.codingAgentShouldFix, false);
    assert.equal(d.fingerprint, "component-library-publish-failed");
    assert.equal(d.phaseId, "15-x");
    assert.equal(d.runId, "run-1");
    assert.match(d.title, /phase complete/i);
    assert.match(d.rootCause, /working directory not clean/);
    assert.ok(
      d.operatorActions.some((a) => /design_library_publish/.test(a)),
      "operator action points at the re-run path",
    );
  });

  it("truncates long summaries", () => {
    const d = buildLibraryPublishFailureDiagnosis({
      summary: "x".repeat(5_000),
      phaseId: "p",
      runId: "r",
    });
    assert.ok(d.rootCause.length <= 1_000);
    assert.ok(d.operatorActions[0]!.length <= 400);
  });
});

describe("phaseTouchedEnvTemplates", () => {
  it("matches env template basenames", () => {
    assert.equal(
      phaseTouchedEnvTemplates([
        "apps/web/.env.example",
        "src/index.ts",
      ]),
      true,
    );
    assert.equal(phaseTouchedEnvTemplates([".env.docker.example"]), true);
    assert.equal(phaseTouchedEnvTemplates([".env.test.example"]), true);
  });

  it("ignores runtime env files and non-env changes", () => {
    assert.equal(
      phaseTouchedEnvTemplates([".env.local", ".env.docker", "src/app.ts"]),
      false,
    );
    assert.equal(phaseTouchedEnvTemplates([]), false);
  });
});

describe("buildEnvSyncFailureDiagnosis", () => {
  it("produces an operator-facing advisory pointing at project_env_sync", () => {
    const d = buildEnvSyncFailureDiagnosis({
      summary: "env sync exited 1: boom",
      phaseId: "7-x",
      runId: "run-9",
    });
    assert.equal(d.audience, "operator");
    assert.equal(d.codingAgentShouldFix, false);
    assert.equal(d.fingerprint, "project-env-sync-failed");
    assert.match(d.title, /phase complete/i);
    assert.ok(
      d.operatorActions.some((a) => /project_env_sync/.test(a)),
      "operator action points at the re-run path",
    );
  });
});
