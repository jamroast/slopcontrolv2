import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { writeChangeIntent, extractChangeIntent } from "./change-intent.js";
import {
  collectHandoffFollowUpSuggestions,
  detectResearchConstraintNote,
  extractResearchConclusion,
  reconcileChangeIntentFromResearch,
} from "./research-intent-reconcile.js";
import { writeDevelopmentHandoff } from "./development-handoff.js";
import { ensureSlopcontrolDir } from "./index.js";

const RESEARCH = `# RESEARCH — server entry

## Summary

Repoint esbuild entry to src/dev.ts for a long-running server.

## ⚠️ Critical conflict: \`--packages=external\` vs targeted externals

The Change Intent says "keeping \`--packages=external\`". **Do not use \`--packages=external\` — it externalizes workspace deps that cannot resolve extensionless ESM imports.**

### Recommendation

Keep targeted externals instead:

\`\`\`
esbuild src/dev.ts --external:oidc-provider --external:pg
\`\`\`
`;

describe("research-intent-reconcile", () => {
  it("extractResearchConclusion returns summary and recommendation", () => {
    const c = extractResearchConclusion(RESEARCH);
    assert.match(c, /src\/dev\.ts/i);
    assert.match(c, /Recommendation:/i);
  });

  it("reconcileChangeIntentFromResearch annotates intent, never rewrites operator wording", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-reconcile-"));
    try {
      ensureSlopcontrolDir(root);
      const phaseId = "11-test";
      mkdirSync(join(root, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      const intent = extractChangeIntent(
        "Repoint the server entry, keeping --packages=external",
      );
      writeChangeIntent(root, phaseId, intent);

      const result = reconcileChangeIntentFromResearch(
        root,
        phaseId,
        intent,
        {
          rejectedWording: "--packages=external",
          correction: "use targeted externals per research",
        },
      );
      assert.equal(result.updated, true);
      // Operator wording untouched.
      assert.equal(result.intent.goal, intent.goal);
      assert.equal(result.intent.rawDescription, intent.rawDescription);
      // Correction lands in mustNot + researchNote.
      assert.ok(
        result.intent.mustNot.some((m) => m.includes("--packages=external")),
      );
      assert.match(
        (result.intent as { researchNote?: string }).researchNote ?? "",
        /--packages=external/,
      );
      // Persisted.
      const reread = JSON.parse(
        readFileSync(
          join(root, ".slopcontrol", "phases", phaseId, "INTENT.json"),
          "utf-8",
        ),
      ) as { mustNot: string[]; researchNote?: string };
      assert.ok(reread.mustNot.some((m) => m.includes("--packages=external")));
      assert.match(reread.researchNote ?? "", /--packages=external/);

      // Idempotent.
      const again = reconcileChangeIntentFromResearch(
        root,
        phaseId,
        result.intent,
        {
          rejectedWording: "--packages=external",
          correction: "use targeted externals per research",
        },
      );
      assert.equal(again.updated, false);
      // Null conflict → no-op.
      const noop = reconcileChangeIntentFromResearch(root, phaseId, intent, null);
      assert.equal(noop.updated, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detectResearchConstraintNote surfaces conflict language generically", () => {
    const note = detectResearchConstraintNote(RESEARCH);
    assert.ok(note);
    assert.match(note!, /Research constraint:/i);
    assert.match(note!, /packages=external/i);
    assert.equal(detectResearchConstraintNote("# RESEARCH\n\nAll good."), null);
  });

  it("collectHandoffFollowUpSuggestions reads complete phase nextSteps", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-followup-"));
    try {
      ensureSlopcontrolDir(root);
      const phaseId = "10-test";
      mkdirSync(join(root, ".slopcontrol", "phases", phaseId), {
        recursive: true,
      });
      writeDevelopmentHandoff(root, {
        phaseId,
        runId: "run-1",
        handoff: {
          outcome: "complete",
          phaseId,
          runId: "run-1",
          updatedAt: new Date().toISOString(),
          summary: "bundle fixed",
          requirements: [],
          knowledge: [
            "Keep targeted externals: --external:oidc-provider --external:pg",
          ],
          operatorRequirements: [],
          nextSteps: [
            "Review operator requirements",
            "Fix container exit-0 restart loop via src/dev.ts entry",
          ],
          merge: { autoMerged: true, worktreePresent: false },
          checksSummary: "",
          source: "orchestrator",
        },
      });
      const suggestions = collectHandoffFollowUpSuggestions(root, 3);
      assert.equal(suggestions.length, 1);
      assert.match(suggestions[0]!.nextStep, /exit-0 restart loop/);
      assert.match(suggestions[0]!.startChangeBrief ?? "", /Title:/);
      assert.match(
        suggestions[0]!.startChangeBrief ?? "",
        /--external:oidc-provider/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});