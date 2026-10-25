import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { LlmEndpoint } from "@slopcontrol/types";
import {
  PHASE_DOC_QUALITY_SYSTEM_PROMPT,
  judgePhaseDocQualityViaLlm,
  parsePhaseDocQualityVerdictPayload,
  renderPhaseDocQualitySystemPrompt,
} from "./phase-doc-quality-llm.js";

const endpoint: LlmEndpoint = {
  id: "test",
  label: "test",
  baseUrl: "http://example.test/v1",
  apiType: "openai-chat",
  modelId: "test-model",
  capabilities: { chat: true, vision: false, imageGen: false },
};

describe("phase-doc-quality-llm", () => {
  it("system prompt attributes faults to research vs draft", () => {
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /researchFaults/);
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /draftFaults/);
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /NO interaction block.*fill\/submit/i,
    );
  });

  it("system prompt names the executing fill+submit envelope it shares with the intent judge", () => {
    // Phase-30: the quality judge forbade live-server runs while the intent
    // judge demanded an executing fill+submit proof and recommended the
    // banned `webServer` harness — the draft ping-ponged until budget. Both
    // prompts must name the same lawful overlap (component/handler-level
    // execution, no live server) and accept the operator-run e2e handoff.
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /EXECUTING check/);
    assert.match(PHASE_DOC_QUALITY_SYSTEM_PROMPT, /jsdom/);
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /Static greps alone are NOT an executing fill\+submit proof/,
    );
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /operator-run e2e handoff PLUS the executing component\/handler-level proof satisfies the gate/,
    );
  });

  it("system prompt routes check-mechanics critiques to draftFaults", () => {
    // Phase-197 loop: check-design critiques were attributed to
    // researchFaults, forcing full re-research legs that cannot fix how a
    // check is written.
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /researchFaults is ONLY for evidence missing from RESEARCH\.md itself/,
    );
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /HOW a check is written.*is a draftFault/s,
    );
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /A re-research cannot fix check mechanics/,
    );
  });

  it("system prompt treats deterministically verified grep tokens as grounded", () => {
    // Grounding-loop fix: disk-real tokens the drafter verified must not be
    // failed for absence from the (possibly clipped) RESEARCH excerpt — that
    // false researchFault forced a full re-research leg per token.
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /Verified grep tokens.*confirmed verbatim on disk.*do NOT fail them as unverified/s,
    );
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /neither RESEARCH quoted nor the deterministic verification blocks/,
    );
    // Research-mandated new-content tokens: RESEARCH-quoted literals the
    // phase creates — absence on disk is expected, never fail them or demand
    // an already-existing token (the phase-202 jamauth loop).
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /Research-mandated new-content tokens.*absence on disk is expected.*do NOT fail them as unverified/s,
    );
    assert.match(
      PHASE_DOC_QUALITY_SYSTEM_PROMPT,
      /Research-mandated new-content tokens.*confirmed/s,
    );
    const rendered = renderPhaseDocQualitySystemPrompt({
      checkRulesBlock: "## Automated Checks rules\n- rule",
    });
    assert.match(
      rendered,
      /Verified grep tokens.*confirmed verbatim on disk.*do NOT fail them as unverified/s,
    );
    assert.match(
      rendered,
      /Research-mandated new-content tokens.*absence on disk is expected/s,
    );
  });

  it("parses fault attribution lists", () => {
    const verdict = parsePhaseDocQualityVerdictPayload({
      ok: false,
      gaps: ["Missing /sign-in route in File Changes"],
      suggestedFixes: ["Add src/routes/sign-in.tsx"],
      researchFaults: [],
      draftFaults: ["Missing /sign-in route in File Changes"],
    });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.draftFaults, [
      "Missing /sign-in route in File Changes",
    ]);
    assert.deepEqual(verdict.researchFaults, []);
  });

  it("fails closed on unreadable payload", () => {
    const verdict = parsePhaseDocQualityVerdictPayload({});
    assert.equal(verdict.ok, false);
    assert.match(verdict.gaps[0] ?? "", /could not be verified/i);
  });


  it("passes verified check targets to the judge so existing files are grounded", async () => {
    let userContent = "";
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role: string; content: string }>;
        };
        userContent = body.messages?.find((m) => m.role === "user")?.content ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true,"gaps":[]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    try {
      const verdict = await judgePhaseDocQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
        phaseDocExcerpt: "phase doc",
        checkTargetsBlock:
          "## Automated Check targets (verified by SlopControl against the repo)\n- exists: tests/a.test.ts\n- MISSING: scripts/nope.mjs",
        verifiedGrepTokensBlock:
          "## Verified grep tokens (confirmed verbatim on disk by SlopControl)\n- `isReadyMessage(event.data)` — src/island.tsx",
        researchMandatedTokensBlock:
          "## Research-mandated new-content tokens (quoted in RESEARCH.md; absent on disk because the phase creates them)\n- `pgTable('auth_events'` — src/lib/db/schema.ts",
      });
      assert.equal(verdict.ok, true);
      assert.match(userContent, /Automated Check targets \(verified/);
      assert.match(userContent, /- exists: tests\/a\.test\.ts/);
      assert.match(userContent, /- MISSING: scripts\/nope\.mjs/);
      assert.match(userContent, /## Verified grep tokens/);
      assert.match(userContent, /isReadyMessage\(event\.data\)/);
      assert.match(userContent, /## Research-mandated new-content tokens/);
      assert.match(userContent, /pgTable\('auth_events'/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("accepts a verdict that omits the fault lists", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":false,"gaps":["missing checks"]}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const verdict = await judgePhaseDocQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
        phaseDocExcerpt: "phase doc",
      });
      assert.equal(verdict.ok, false);
      assert.deepEqual(verdict.gaps, ["missing checks"]);
      assert.deepEqual(verdict.researchFaults, []);
      assert.deepEqual(verdict.draftFaults, []);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("sends prior gaps with convergence rules on re-judgement", async () => {
    let userContent = "";
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role: string; content: string }>;
        };
        userContent = body.messages?.find((m) => m.role === "user")?.content ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true,"gaps":[]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    try {
      const verdict = await judgePhaseDocQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
        phaseDocExcerpt: "phase doc",
        priorGaps: ["The Verdict: line format is undeclared in the spec"],
      });
      assert.equal(verdict.ok, true);
      // The judge is told what it already rejected and given a higher bar
      // for fresh issues — an unbounded issue stream prevents convergence.
      assert.match(userContent, /already rejected an earlier draft/);
      assert.match(userContent, /1\. The Verdict: line format is undeclared/);
      assert.match(userContent, /objectively fatal/);
      assert.match(userContent, /hypothetical or hostile implementations/);
      // Ungrounded-token audits must be exhaustive per pass — drip-feeding
      // one token per round was the phase-29 loop shape.
      assert.match(userContent, /audit EVERY grep token/);
      assert.match(userContent, /never drip-feed them one per round/);
    } finally {
      fetchMock.mock.restore();
    }
  });

  it("omits the convergence block on a first judgement (no prior gaps)", async () => {
    let userContent = "";
    const fetchMock = mock.method(
      globalThis,
      "fetch",
      async (_url: unknown, init?: { body?: string }) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ role: string; content: string }>;
        };
        userContent = body.messages?.find((m) => m.role === "user")?.content ?? "";
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"ok":true,"gaps":[]}' } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    try {
      await judgePhaseDocQualityViaLlm({
        endpoint,
        intentBlock: "intent",
        phaseDescription: "phase",
        researchExcerpt: "research",
        phaseDocExcerpt: "phase doc",
      });
      assert.doesNotMatch(userContent, /already rejected an earlier draft/);
    } finally {
      fetchMock.mock.restore();
    }
  });
});
