import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, after } from "node:test";
import {
  acceptPlanLoop,
  bindAcceptedPlanLoopToPhase,
  createPlanLoopMeta,
  extractPlanDocument,
  scaffoldPlanDocument,
  seedPlanLoopAcceptance,
  validatePlanDocument,
  writePlanLoopMeta,
  writePlanLoopVersion,
} from "./plan-loop.js";
import {
  compilePlanPackFromAccept,
  formatPlanPackPromptBlock,
  formatPhaseBoundPlanPromptBlock,
  readPhasePlanPack,
  phaseDescriptionFromPlanPack,
} from "./plan-pack.js";
import { fallbackPlanContinueIntentFromText } from "./plan-continue-intent.js";

const GOOD_PLAN = `# Plan — composer submit

## Goal

Make the chat composer fill and submit reliably.

## Constraints

- Keep existing mount in chat-side-panel
- No brand redesign

## In scope

- Composer submit path
- Error surfacing

## Out of scope

- Marketing landing
- Theme toggle

## Approach

1. Trace submit handler
2. Fix toolName / fill path
3. Add regression check

## Likely areas

- src/components/chat/form-bubble.tsx
- src/components/chat/chat-side-panel.tsx

## Success criteria

- Fill + submit works at composer mount
- Automated check covers the path

## Risks & open questions

- Confirm AI SDK tool part shape in current deps

## Handoff notes

- Do not reinterpret Goal as a chip-only taxonomy change

PLAN_COMPLETE
`;

describe("plan-loop", () => {
  const roots: string[] = [];
  after(() => {
    for (const r of roots) {
      try {
        rmSync(r, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("validatePlanDocument accepts complete plan", () => {
    const v = validatePlanDocument(GOOD_PLAN);
    assert.equal(v.ok, true);
  });

  it("validatePlanDocument rejects missing sections", () => {
    const v = validatePlanDocument("# Plan\n\n## Goal\n\nOnly goal\n");
    assert.equal(v.ok, false);
    assert.ok(v.missing.includes("In scope"));
  });

  it("extractPlanDocument finds fenced markdown", () => {
    const raw = `Here is the plan:\n\`\`\`markdown\n${GOOD_PLAN}\n\`\`\`\nPLAN_COMPLETE`;
    const plan = extractPlanDocument(raw);
    assert.ok(plan);
    assert.match(plan!, /## Goal/);
  });

  it("accept writes PLAN_PACK; bind copies to phase", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-plan-"));
    roots.push(root);
    const meta = createPlanLoopMeta({
      projectId: "p1",
      brief: "Fix composer submit",
    });
    writePlanLoopMeta(root, meta);
    writePlanLoopVersion({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      plan: GOOD_PLAN,
      notes: "ok",
      request: meta.brief,
    });
    seedPlanLoopAcceptance({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
    });
    const accepted = acceptPlanLoop(root, meta.id, 1, {
      acceptedFeatureIds: ["goal", "scope", "success"],
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(
      existsSync(
        join(root, ".slopcontrol", "plan-loops", meta.id, "PLAN_PACK.json"),
      ),
      true,
    );
    const pack = compilePlanPackFromAccept({
      projectRoot: root,
      loopId: meta.id,
      version: 1,
      acceptance: {
        version: 1,
        features: [
          { id: "goal", label: "Goal", accepted: true },
          { id: "scope", label: "Scope", accepted: true },
          { id: "success", label: "Success", accepted: true },
        ],
      },
    });
    assert.match(pack.goal, /composer/i);
    assert.ok(pack.likelyAreas.some((a) => /form-bubble/i.test(a)));
    assert.match(formatPlanPackPromptBlock(pack), /PLAN CONTRACT/);
    assert.match(phaseDescriptionFromPlanPack(pack), /Success criteria/);

    mkdirSync(join(root, ".slopcontrol", "phases", "01-composer"), {
      recursive: true,
    });
    bindAcceptedPlanLoopToPhase({
      projectRoot: root,
      loopId: meta.id,
      phaseId: "01-composer",
    });
    assert.equal(
      existsSync(
        join(
          root,
          ".slopcontrol",
          "phases",
          "01-composer",
          "plan",
          "PLAN.md",
        ),
      ),
      true,
    );
    const phasePack = readPhasePlanPack(root, "01-composer");
    assert.ok(phasePack);
    assert.match(phasePack!.planPath, /phases\/01-composer\/plan\/PLAN\.md/);
    const planBody = readFileSync(
      join(root, ".slopcontrol", "phases", "01-composer", "plan", "PLAN.md"),
      "utf-8",
    );
    assert.match(planBody, /## Success criteria/);
    const bound = formatPhaseBoundPlanPromptBlock({
      projectRoot: root,
      phaseId: "01-composer",
    });
    assert.match(bound, /PLAN CONTRACT/);
    assert.match(bound, /form-bubble/);
  });

  it("scaffoldPlanDocument includes required sections", () => {
    const s = scaffoldPlanDocument({
      brief: "Spike auth",
      scope: {
        kind: "spike",
        focus: "auth",
        preserve: ["billing"],
        source: "start",
      },
    });
    assert.equal(validatePlanDocument(s).ok, true);
  });

  it("fallbackPlanContinueIntentFromText classifies narrow and full", () => {
    const narrow = fallbackPlanContinueIntentFromText(
      "Please narrow to only the composer",
    );
    assert.equal(narrow.scope, "narrow_scope");
    const full = fallbackPlanContinueIntentFromText(
      "Rewrite the whole plan from scratch",
    );
    assert.equal(full.scope, "full_revise");
  });
});
