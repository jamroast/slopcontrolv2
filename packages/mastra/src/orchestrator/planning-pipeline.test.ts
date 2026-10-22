import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  faultLegFromPhaseQualityVerdict,
  isPlanningJudgeInfraIssue,
  isIntentEngagementContradiction,
  mergeFaultLegs,
  planningGateIssueFingerprint,
  priorDraftJudgeIssuesFromDiagnosis,
  priorQualityJudgeGapsFromDiagnosis,
  priorGapsAfterResolution,
  seedPriorQualityGaps,
  shouldContinuePlanningSelfHeal,
  shouldReclassifyIntentForPlanningSelfHeal,
  MAX_PLANNING_SELF_HEAL_ROUNDS,
  callPlanningJudgeWithInfraRetry,
  PlanningJudgeInfraError,
  isPlanningJudgeParseFailure,
  phaseQualityRetryPrompt,
  brokenOutputReason,
  runBoundedCriticLoop,
} from "./planning-pipeline.js";

describe("planning-pipeline", () => {
  it("detects judge infra issues", () => {
    assert.equal(
      isPlanningJudgeInfraIssue("LLM judge failed"),
      true,
    );
    assert.equal(
      isPlanningJudgeInfraIssue("Missing /sign-in route"),
      false,
    );
  });

  it("brokenOutputReason flags empty and chat-preamble output", () => {
    assert.equal(brokenOutputReason(null), "empty output");
    assert.equal(brokenOutputReason(""), "empty output");
    assert.equal(brokenOutputReason("   \n  "), "empty output");
    assert.equal(
      brokenOutputReason("Here's the PHASE.md for this phase:"),
      "no markdown document (chat preamble only)",
    );
    assert.equal(
      brokenOutputReason("Let me draft that for you."),
      "no markdown document (chat preamble only)",
    );
  });

  it("brokenOutputReason accepts a real markdown document", () => {
    assert.equal(
      brokenOutputReason("# Phase 36 — Account-scoped sessions\n\n## Scope\n\nBackend-only."),
      null,
    );
    // A chat preamble followed by a real document is still usable.
    assert.equal(
      brokenOutputReason(
        "Here's the draft:\n\n# Phase 36 — Account-scoped sessions\n\n## Scope\n\nBackend-only.",
      ),
      null,
    );
  });

  it("merges fault legs", () => {
    assert.equal(mergeFaultLegs("research", "draft"), "both");
    assert.equal(mergeFaultLegs("draft", "none"), "draft");
  });

  it("derives fault leg from phase quality verdict", () => {
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: false,
        researchFaults: ["Thin RESEARCH — no route named"],
        draftFaults: [],
      }),
      "research",
    );
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: false,
        researchFaults: [],
        draftFaults: ["PHASE omitted grep proofs"],
      }),
      "draft",
    );
    assert.equal(
      faultLegFromPhaseQualityVerdict({
        ok: true,
        researchFaults: [],
        draftFaults: [],
      }),
      "none",
    );
  });

  it("shouldContinuePlanningSelfHeal advances content faults only", () => {
    const max = MAX_PLANNING_SELF_HEAL_ROUNDS;
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: 0,
        maxRounds: max,
      }),
      true,
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        judgeInfraFailed: true,
        round: 0,
        maxRounds: max,
      }),
      false,
      "infra failure must not burn self-heal rounds",
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "none",
        round: 0,
        maxRounds: max,
      }),
      false,
    );
    assert.equal(
      shouldContinuePlanningSelfHeal({
        stage: "failed",
        faultLeg: "draft",
        round: max - 1,
        maxRounds: max,
      }),
      false,
      "last round must not continue",
    );
  });

  it("phaseQualityRetryPrompt instructs a `# Phase …` title (matches validatePhaseDocForDev)", () => {
    const prompt = phaseQualityRetryPrompt({
      canonicalPath: ".slopcontrol/phases/25-x/PHASE.md",
      intentBlock: "intent",
      description: "desc",
      research: "research",
      judgeFeedback: "feedback",
    });
    assert.match(prompt, /starting with `# Phase …`/);
    assert.doesNotMatch(prompt, /starting with # Title/);
  });

  it("phaseQualityRetryPrompt re-states the Automated Checks rules (vitest grep-quiet antipattern)", () => {
    const prompt = phaseQualityRetryPrompt({
      canonicalPath: ".slopcontrol/phases/25-x/PHASE.md",
      intentBlock: "intent",
      description: "desc",
      research: "research",
      judgeFeedback: "feedback",
    });
    assert.match(prompt, /Never pipe vitest\/jest to `grep -q`/);
    assert.match(prompt, /npx vitest run … \|\| exit 1/);
  });

  it("callPlanningJudgeWithInfraRetry surfaces the underlying cause on total failure", async () => {
    await assert.rejects(
      () =>
        callPlanningJudgeWithInfraRetry(
          async () => {
            throw new Error("JSON chat parse failed at position 1");
          },
          () => [],
          2,
        ),
      (err: unknown) => {
        assert.ok(err instanceof PlanningJudgeInfraError);
        assert.ok(
          (err as Error).message.includes("JSON chat parse failed at position 1"),
          `message must carry the cause, got: ${(err as Error).message}`,
        );
        return true;
      },
    );
  });

  it("callPlanningJudgeWithInfraRetry returns judgeInfraFailed on verdict-shaped infra issues", async () => {
    const { result, judgeInfraFailed } = await callPlanningJudgeWithInfraRetry(
      async () => ({ gaps: ["LLM judge failed"] }),
      (r: { gaps: string[] }) => r.gaps,
      2,
    );
    assert.equal(judgeInfraFailed, true);
    assert.deepEqual(result.gaps, ["LLM judge failed"]);
  });

  it("isPlanningJudgeParseFailure detects JSON parse and empty-content errors", () => {
    assert.equal(
      isPlanningJudgeParseFailure(
        new PlanningJudgeInfraError(new Error("JSON chat parse failed at position 4")),
      ),
      true,
    );
    assert.equal(
      isPlanningJudgeParseFailure(new Error("JSON chat returned empty content")),
      true,
    );
    assert.equal(
      isPlanningJudgeParseFailure(new Error("Missing /sign-in route")),
      false,
    );
  });

  it("callPlanningJudgeWithInfraRetry falls back after primary parse failures", async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const { result, judgeInfraFailed, usedFallback } =
      await callPlanningJudgeWithInfraRetry(
        async () => {
          primaryCalls += 1;
          throw new Error("JSON chat parse failed at position 4");
        },
        (r: { ok: boolean }) => (r.ok ? [] : ["LLM judge failed"]),
        1,
        {
          fallbackCall: async () => {
            fallbackCalls += 1;
            return { ok: true };
          },
        },
      );
    assert.equal(primaryCalls, 1);
    assert.equal(fallbackCalls, 1);
    assert.equal(usedFallback, true);
    assert.equal(judgeInfraFailed, false);
    assert.equal(result.ok, true);
  });

  it("callPlanningJudgeWithInfraRetry does not re-pay same-leg retries on timeout", async () => {
    // A timeout is a latency signal — the same endpoint's ladder already
    // burned its bounded retries, so the wrapper must fail over to the
    // fallback endpoint instead of tripling wall time on the dead one.
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const { result, judgeInfraFailed, usedFallback } =
      await callPlanningJudgeWithInfraRetry(
        async () => {
          primaryCalls += 1;
          throw new Error("JSON chat timed out after 300000ms (attempt 2/3)");
        },
        (r: { ok: boolean }) => (r.ok ? [] : ["LLM judge failed"]),
        3,
        {
          fallbackCall: async () => {
            fallbackCalls += 1;
            return { ok: true };
          },
        },
      );
    assert.equal(primaryCalls, 1, "no same-leg retry on timeout");
    assert.equal(fallbackCalls, 1, "fallback endpoint gets the failover");
    assert.equal(usedFallback, true);
    assert.equal(judgeInfraFailed, false);
    assert.equal(result.ok, true);
  });

  it("callPlanningJudgeWithInfraRetry still retries same-leg parse failures", async () => {
    // Contrast: parse/empty failures are cheap model tics worth re-trying.
    let primaryCalls = 0;
    await assert.rejects(
      () =>
        callPlanningJudgeWithInfraRetry(
          async () => {
            primaryCalls += 1;
            throw new Error("JSON chat parse failed at position 4");
          },
          () => [],
          3,
        ),
      PlanningJudgeInfraError,
    );
    assert.equal(primaryCalls, 3);
  });

  it("planningGateIssueFingerprint is stable for equivalent issue sets", () => {
    const a = planningGateIssueFingerprint([
      "No fill+submit proof at page mount",
      "Spec-only phase",
    ]);
    const b = planningGateIssueFingerprint([
      "  Spec-only phase  ",
      "No fill+submit proof at page mount",
    ]);
    assert.equal(a, b);
    assert.notEqual(a, "");
  });

  it("isIntentEngagementContradiction detects spec description vs fill+submit gate", () => {
    assert.equal(
      isIntentEngagementContradiction({
        gateIssues: ["No fill+submit proof at the page mount"],
        description: "Specify the foundation end-user authentication layer",
      }),
      true,
    );
    assert.equal(
      isIntentEngagementContradiction({
        gateIssues: ["Missing ## Scope section"],
        description: "Specify the auth layer",
      }),
      false,
    );
  });

  it("shouldReclassifyIntentForPlanningSelfHeal after repeated engagement faults", () => {
    const issues = ["No fill+submit proof at the page mount"];
    const fp = planningGateIssueFingerprint(issues);
    assert.equal(
      shouldReclassifyIntentForPlanningSelfHeal({
        gateIssues: issues,
        description: "Build the sign-up form",
        priorGateFingerprints: [fp],
        round: 1,
      }),
      true,
    );
    assert.equal(
      shouldReclassifyIntentForPlanningSelfHeal({
        gateIssues: issues,
        description: "Build the sign-up form",
        priorGateFingerprints: [],
        round: 0,
      }),
      false,
      "first round should not reclassify on repetition alone",
    );
  });
});

describe("priorDraftJudgeIssuesFromDiagnosis", () => {
  it("carries deduped draft-gate gaps from evidence", () => {
    const issues = priorDraftJudgeIssuesFromDiagnosis({
      title: "Draft rejected: phase quality judge",
      rootCause: "Check 3 greps token:read in routes.ts — unsatisfiable",
      evidence:
        "Check 3 greps token:read in routes.ts — unsatisfiable; Check 2 single-gate scan excludes the registry test; Check 3 greps token:read in routes.ts — unsatisfiable",
      tags: ["planning", "draft", "phase-quality"],
    });
    assert.deepEqual(issues, [
      "Check 3 greps token:read in routes.ts — unsatisfiable",
      "Check 2 single-gate scan excludes the registry test",
    ]);
  });

  it("falls back to rootCause when evidence is empty", () => {
    const issues = priorDraftJudgeIssuesFromDiagnosis({
      title: "Draft rejected: invalid PHASE.md (structural)",
      rootCause: "Automated Checks restarts infra with docker compose up",
      evidence: "",
      tags: ["planning", "draft", "draft-structural"],
    });
    assert.deepEqual(issues, [
      "Automated Checks restarts infra with docker compose up",
    ]);
  });

  it("ignores develop/verify diagnoses (not actionable for a draft)", () => {
    assert.deepEqual(
      priorDraftJudgeIssuesFromDiagnosis({
        title: "Verify failed",
        rootCause: "testCommand exited 1",
        evidence: "testCommand exited 1",
        tags: ["verify", "product"],
      }),
      [],
    );
  });

  it("returns [] without a diagnosis", () => {
    assert.deepEqual(priorDraftJudgeIssuesFromDiagnosis(null), []);
  });
});

describe("quality-judge convergence memory", () => {
  const qualityDiagnosis = {
    title: "Draft rejected: phase quality judge",
    tags: ["planning", "draft", "phase-quality"],
    issues: ["Check 2 greps a string the doc does not contain", "Verdict line undeclared"],
    updatedAt: "2026-10-20T10:00:00.000Z",
  };

  it("seeds only quality-judge gaps, never structural shell findings", () => {
    assert.deepEqual(priorQualityJudgeGapsFromDiagnosis(qualityDiagnosis), [
      "Check 2 greps a string the doc does not contain",
      "Verdict line undeclared",
    ]);

    const structural = {
      title: "Draft rejected: invalid PHASE.md (structural)",
      tags: ["planning", "draft", "draft-structural"],
      issues: ["Brittle Automated Check requires multiple tokens on ONE line"],
    };
    assert.deepEqual(priorQualityJudgeGapsFromDiagnosis(structural), []);

    // The draft-prompt helper still carries structural gaps for re-drafting.
    assert.deepEqual(priorDraftJudgeIssuesFromDiagnosis(structural), [
      "Brittle Automated Check requires multiple tokens on ONE line",
    ]);
  });

  it("never seeds from judge-infra diagnoses (transport messages, not content gaps)", () => {
    const infra = {
      title: "Draft rejected: phase quality judge infra",
      tags: ["planning", "draft", "phase-quality-infra"],
      issues: [
        "PHASE quality could not be verified (JSON chat timed out after 300000ms)",
      ],
      updatedAt: "2026-10-20T10:00:00.000Z",
    };
    assert.deepEqual(priorQualityJudgeGapsFromDiagnosis(infra), []);
    // Legacy infra diagnosis without tags — the title branch must not leak it.
    const legacyInfra = {
      title: "Draft rejected: phase quality judge infra",
      issues: ["PHASE quality could not be verified (LLM judge failed)"],
    };
    assert.deepEqual(priorQualityJudgeGapsFromDiagnosis(legacyInfra), []);
    // …while a legacy QUALITY diagnosis (no tags) still seeds via its title.
    const legacyQuality = {
      title: "Draft rejected: phase quality judge",
      issues: ["Verdict line undeclared"],
    };
    assert.deepEqual(priorQualityJudgeGapsFromDiagnosis(legacyQuality), [
      "Verdict line undeclared",
    ]);
  });

  it("filters infra-shaped messages even when the diagnosis is tagged phase-quality", () => {
    // The "no LLM judge bound" failure keeps kind/tag phase-quality and a title
    // without "infra", so the tag/title gate alone would seed its transport text.
    assert.deepEqual(
      priorQualityJudgeGapsFromDiagnosis({
        title: "Draft rejected: phase quality judge",
        tags: ["planning", "draft", "phase-quality"],
        issues: [
          "PHASE quality could not be verified (no LLM judge bound)",
          "Verdict line undeclared",
        ],
      }),
      ["Verdict line undeclared"],
    );
    assert.deepEqual(
      priorQualityJudgeGapsFromDiagnosis({
        title: "Draft rejected: phase quality judge",
        tags: ["planning", "draft", "phase-quality"],
        issues: ["PHASE quality could not be verified (JSON chat timed out after 300000ms)"],
      }),
      [],
    );
  });

  it("drops seeds when RESEARCH.md was regenerated after the verdict", () => {
    const diagnosedAt = Date.parse(qualityDiagnosis.updatedAt);
    // Research older than the verdict → still relevant.
    assert.equal(
      seedPriorQualityGaps({
        diagnosis: qualityDiagnosis,
        researchMtimeMs: diagnosedAt - 60_000,
      }).length,
      2,
    );
    // Research regenerated after the verdict → gaps may be obsolete.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: qualityDiagnosis,
        researchMtimeMs: diagnosedAt + 60_000,
      }),
      [],
    );
    // Non-quality diagnosis → never seeded.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: { ...qualityDiagnosis, tags: ["planning", "draft"], title: "Draft rejected: PHASE structure" },
        researchMtimeMs: diagnosedAt - 1,
      }),
      [],
    );
  });

  it("keeps draft-attributed gaps and drops research ones when RESEARCH regenerated", () => {
    const diagnosedAt = Date.parse(qualityDiagnosis.updatedAt);
    const ledgerDiagnosis = {
      ...qualityDiagnosis,
      openIssues: ["draft: bare npm test", "research: stale file claim"],
      researchIssues: ["research: stale file claim"],
      draftIssues: ["draft: bare npm test"],
    };
    // Research regenerated after the verdict → drop research gaps, keep draft.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: ledgerDiagnosis,
        researchMtimeMs: diagnosedAt + 60_000,
      }),
      ["draft: bare npm test"],
    );
    // Research older than the verdict → keep everything.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: ledgerDiagnosis,
        researchMtimeMs: diagnosedAt - 60_000,
      }),
      ["draft: bare npm test", "research: stale file claim"],
    );
    // Legacy diagnosis without the split → old fail-safe (drop all on regen).
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: qualityDiagnosis,
        researchMtimeMs: diagnosedAt + 60_000,
      }),
      [],
    );
  });

  it("dropping resolved gaps is whitespace/case tolerant but otherwise verbatim", () => {
    const prior = ["Check 2 greps `runs the /auth`", "Verdict line undeclared"];
    assert.deepEqual(
      priorGapsAfterResolution(prior, ["  check 2 greps   `runs the /auth` "]),
      ["Verdict line undeclared"],
    );
    assert.deepEqual(priorGapsAfterResolution(prior, []), prior);
    assert.deepEqual(priorGapsAfterResolution(prior, ["some other gap"]), prior);
  });

  it("keys research staleness on content hash, not mtime", () => {
    const diagnosedWithHash = {
      ...qualityDiagnosis,
      researchHash: "hash-v1",
      researchIssues: ["research: stale file claim"],
      draftIssues: ["draft: bare npm test"],
      openIssues: ["draft: bare npm test", "research: stale file claim"],
    };
    // Same content (hash matches) → research gap kept even when mtime is newer.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: diagnosedWithHash,
        researchHash: "hash-v1",
        researchMtimeMs: Date.parse(qualityDiagnosis.updatedAt) + 999_999,
      }),
      ["draft: bare npm test", "research: stale file claim"],
    );
    // Changed content (hash differs) → research gap dropped, draft gap kept.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: diagnosedWithHash,
        researchHash: "hash-v2",
      }),
      ["draft: bare npm test"],
    );
    // Legacy diagnosis (no stored hash): mtime fallback still applies.
    assert.deepEqual(
      seedPriorQualityGaps({
        diagnosis: qualityDiagnosis,
        researchHash: "hash-v2",
        researchMtimeMs: Date.parse(qualityDiagnosis.updatedAt) + 60_000,
      }),
      [],
    );
  });
});

describe("runBoundedCriticLoop", () => {
  type V = { ok: boolean; gaps: string[]; resolvedGaps?: string[] };
  const verdict = (ok: boolean, gaps: string[], resolvedGaps: string[] = []): V => ({
    ok,
    gaps,
    resolvedGaps,
  });

  it("passes on the first ok verdict with the seeded ledger intact", async () => {
    const seen: string[][] = [];
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: ["seed gap"],
      maxLegRetries: 2,
      judge: async (priorGaps) => {
        seen.push([...priorGaps]);
        return { result: verdict(true, []), judgeInfraFailed: false };
      },
      repair: async () => {
        throw new Error("repair must not run");
      },
    });
    assert.equal(outcome.kind, "passed");
    assert.deepEqual(seen, [["seed gap"]]);
  });

  it("accumulates gaps across judgements and feeds them back to the judge", async () => {
    const seen: string[][] = [];
    const verdicts = [
      verdict(false, ["gap A"]),
      verdict(false, ["gap B"]),
      verdict(true, []),
    ];
    let repairs = 0;
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 3,
      judge: async (priorGaps) => {
        seen.push([...priorGaps]);
        return { result: verdicts.shift()!, judgeInfraFailed: false };
      },
      repair: async () => {
        repairs++;
      },
    });
    assert.equal(outcome.kind, "passed");
    assert.equal(repairs, 2);
    // Second judgement sees gap A; third sees A+B (accumulated, not replaced).
    assert.deepEqual(seen, [[], ["gap A"], ["gap A", "gap B"]]);
  });

  it("subtracts verified-resolved gaps from the ledger", async () => {
    const seen: string[][] = [];
    const resolvedLogged: string[][] = [];
    const verdicts = [
      verdict(false, ["gap A", "gap B"]),
      // Judge verifies A fixed, keeps B, then passes.
      verdict(false, ["gap B"], ["gap A"]),
      verdict(true, []),
    ];
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 3,
      judge: async (priorGaps) => {
        seen.push([...priorGaps]);
        return { result: verdicts.shift()!, judgeInfraFailed: false };
      },
      onResolvedGaps: (g) => resolvedLogged.push(g),
      repair: async () => {},
    });
    assert.equal(outcome.kind, "passed");
    assert.deepEqual(seen[2], ["gap B"]);
    assert.deepEqual(resolvedLogged, [["gap A"]]);
  });

  it("drops infra-phrased gaps from the accumulated ledger via the filter", async () => {
    const seen: string[][] = [];
    const verdicts = [
      verdict(false, [
        "PHASE quality could not be verified (JSON chat timed out)",
        "real content gap",
      ]),
      verdict(true, []),
    ];
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 1,
      filterAccumulatedGaps: (gaps) =>
        gaps.filter((g) => !isPlanningJudgeInfraIssue(g)),
      judge: async (priorGaps) => {
        seen.push([...priorGaps]);
        return { result: verdicts.shift()!, judgeInfraFailed: false };
      },
      repair: async () => {},
    });
    assert.equal(outcome.kind, "passed");
    assert.deepEqual(seen[1], ["real content gap"]);
  });

  it("escalates via shouldEscalate without burning a repair leg", async () => {
    let repairs = 0;
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 2,
      judge: async () => ({
        result: verdict(false, ["research is thin"]),
        judgeInfraFailed: false,
      }),
      shouldEscalate: () => "research",
      repair: async () => {
        repairs++;
      },
    });
    assert.equal(outcome.kind, "escalated");
    if (outcome.kind === "escalated") {
      assert.equal(outcome.reason, "research");
      assert.deepEqual(outcome.priorGaps, ["research is thin"]);
    }
    assert.equal(repairs, 0);
  });

  it("escalates with max-leg-retries after exhausting repairs", async () => {
    let repairs = 0;
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 2,
      judge: async () => ({
        result: verdict(false, ["still broken"]),
        judgeInfraFailed: false,
      }),
      repair: async () => {
        repairs++;
      },
    });
    assert.equal(repairs, 2);
    assert.equal(outcome.kind, "escalated");
    if (outcome.kind === "escalated") {
      assert.equal(outcome.reason, "max-leg-retries");
      assert.equal(outcome.legRetries, 2);
    }
  });

  it("classifies judge throws as judge-error and repair throws as repair-error", async () => {
    const judgeError = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 2,
      judge: async () => {
        throw new Error("endpoint down");
      },
      repair: async () => {},
    });
    assert.equal(judgeError.kind, "judge-error");

    const repairError = await runBoundedCriticLoop<V>({
      initialPriorGaps: [],
      maxLegRetries: 2,
      judge: async () => ({
        result: verdict(false, ["gap"]),
        judgeInfraFailed: false,
      }),
      repair: async () => {
        throw new Error("agent crashed");
      },
    });
    assert.equal(repairError.kind, "repair-error");
    if (repairError.kind === "repair-error") {
      assert.equal(repairError.legRetries, 1);
    }
  });

  it("classifies degraded judge verdicts as infra-failed", async () => {
    const outcome = await runBoundedCriticLoop<V>({
      initialPriorGaps: ["seed"],
      maxLegRetries: 2,
      judge: async () => ({
        result: verdict(false, ["LLM judge failed (timeout)"]),
        judgeInfraFailed: true,
      }),
      repair: async () => {},
    });
    assert.equal(outcome.kind, "infra-failed");
    if (outcome.kind === "infra-failed") {
      assert.deepEqual(outcome.gaps, ["LLM judge failed (timeout)"]);
    }
  });
});
