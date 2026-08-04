import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergePlanDocumentSections,
  planDocumentWorthMerging,
  validatePlanDocument,
  PLAN_REQUIRED_SECTIONS,
} from "./plan-loop.js";

const PRIOR = `# Plan — Kitchen Sink

## Goal

Add a playground.

## Constraints

- Stay local

## In scope

- playground/

## Out of scope

- Storybook

## Approach

1. Add vite app

## Likely areas

- playground/package.json

## Success criteria

- pnpm playground works

## Risks & open questions

- Tailwind 4 wiring

## Handoff notes

- Research vite alias
`;

const INCOMING_PARTIAL = `# Plan — Chat component

## Goal

Build a sophisticated reusable chat system for AI-driven data gathering.

## Constraints

- Learn from JamPress; do not re-invent blindly

## In scope

- Generic chat component with dynamic schema interrogation

## Out of scope

- Full CRM product

## Approach

1. Extract patterns from JamPress
2. Design schema contract
`;

describe("mergePlanDocumentSections", () => {
  it("fills missing trailing sections from prior and validates ok", () => {
    assert.equal(planDocumentWorthMerging(INCOMING_PARTIAL), true);
    const before = validatePlanDocument(INCOMING_PARTIAL);
    assert.equal(before.ok, false);
    assert.ok(before.missing.includes("Likely areas"));

    const { plan, filledFromPrior, filledStub } = mergePlanDocumentSections({
      incoming: INCOMING_PARTIAL,
      prior: PRIOR,
    });
    const after = validatePlanDocument(plan);
    assert.equal(after.ok, true);
    assert.ok(filledFromPrior.includes("Likely areas"));
    assert.ok(filledFromPrior.includes("Success criteria"));
    assert.match(plan, /Build a sophisticated reusable chat/);
    assert.ok(PLAN_REQUIRED_SECTIONS.every((t) => plan.includes(`## ${t}`)));
    // stubs only if prior also missing
    assert.ok(Array.isArray(filledStub));
  });

  it("stubs when neither incoming nor prior has a section", () => {
    const thin = `# Plan — X

## Goal

Do the thing now.

## Constraints

- Keep it small enough

## In scope

- one feature area

## Out of scope

- everything else

## Approach

1. Ship it carefully
`;
    const { plan, filledStub } = mergePlanDocumentSections({
      incoming: thin,
      prior: "",
    });
    assert.equal(validatePlanDocument(plan).ok, true);
    assert.ok(filledStub.includes("Likely areas"));
    assert.match(plan, /\(to research\)/);
  });
});
