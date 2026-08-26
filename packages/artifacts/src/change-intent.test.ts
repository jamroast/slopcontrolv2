import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allocateWorktreeDbPort,
  applyWorktreeComposeIsolation,
  changeIntentIsBrandTheming,
  clipBlueprintForPrompt,
  clipBlueprintForAskAlign,
  ensureChangeIntent,
  extractChangeIntent,
  extractLiveDecisions,
  finalizeChangeIntent,
  formatChangeIntentPromptBlock,
  ChangeIntentLlmOutputSchema,
  interactionProofKind,
  isClickNavigateAsk,
  needsInteractionContract,
  garbageCollectSupersededMountBds,
  isChangeIntentWeak,
  isWorktreeIsolationPort,
  loadCanonicalRuntimeEnv,
  phaseDocAlignsWithChangeIntent,
  phaseDocAlignsWithChangeIntentAsync,
  intentAlignmentExcerptFromPhaseDoc,
  consolidateText,
  reconcileBlueprintDecisions,
  researchEngagementQuality,
  researchEngagementQualityAsync,
  restoreCanonicalRuntimeEnv,
  sanitizeComposeProjectName,
  sanitizeWorktreeEnvForRootSync,
  scrubIsolationKeysFromEnvRecord,
  snapshotCanonicalRuntimeEnv,
  tearDownAllProjectWorktreeCompose,
  verifyDatabaseArtifacts,
} from "./index.js";

describe("worktree compose isolation", () => {
  it("allocates stable DB ports in 5500–5599", () => {
    const a = allocateWorktreeDbPort("08-want-me-to-promote");
    const b = allocateWorktreeDbPort("08-want-me-to-promote");
    assert.equal(a, b);
    assert.ok(a >= 5500 && a <= 5599);
  });

  it("writes COMPOSE_PROJECT_NAME and DB_PORT into worktree .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-iso-"));
    try {
      writeFileSync(
        join(dir, ".env"),
        "DB_PORT=5433\nDATABASE_URL=postgresql://app:app@localhost:5433/jamlite\n",
      );
      const r = applyWorktreeComposeIsolation({
        worktreePath: dir,
        phaseId: "08-want-me-to-promote-ask-this-into-a-full",
      });
      const body = readFileSync(join(dir, ".env"), "utf-8");
      assert.match(body, new RegExp(`DB_PORT=${r.dbPort}`));
      assert.match(body, new RegExp(`COMPOSE_PROJECT_NAME=${r.projectName}`));
      assert.match(body, new RegExp(`:${r.dbPort}/jamlite`));
      assert.ok(sanitizeComposeProjectName("08-Foo").startsWith("slopwt-"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tearDownAllProjectWorktreeCompose walks worktree dirs", () => {
    const data = mkdtempSync(join(tmpdir(), "slop-data-"));
    try {
      const wt = join(data, "worktrees", "proj-1", "phase-a");
      mkdirSync(wt, { recursive: true });
      writeFileSync(
        join(wt, "docker-compose.yml"),
        "services:\n  noop:\n    image: alpine:3.19\n",
      );
      const r = tearDownAllProjectWorktreeCompose({
        dataDir: data,
        projectId: "proj-1",
      });
      assert.equal(r.attempted, true);
    } finally {
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("canonical runtime env heal", () => {
  it("snapshot rejects isolation-range DB_PORT and restores 5433", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-canon-"));
    try {
      writeFileSync(
        join(root, "docker-compose.yml"),
        "services:\n  db:\n    ports:\n      - '${DB_PORT:-5433}:5432'\n",
      );
      writeFileSync(join(root, ".env"), "DB_PORT=5580\n");
      writeFileSync(
        join(root, ".env.local"),
        "DATABASE_URL=postgres://app:app@localhost:5580/jamlite\n",
      );
      const snap = snapshotCanonicalRuntimeEnv(root);
      assert.equal(snap.dbPort, 5433);
      assert.ok(!isWorktreeIsolationPort(snap.dbPort));
      assert.ok(loadCanonicalRuntimeEnv(root));

      const healed = restoreCanonicalRuntimeEnv(root);
      assert.ok(healed.restored.includes(".env"));
      assert.match(readFileSync(join(root, ".env"), "utf-8"), /DB_PORT=5433/);
      assert.match(
        readFileSync(join(root, ".env.local"), "utf-8"),
        /localhost:5433\/jamlite/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sanitizeWorktreeEnvForRootSync ignores poisoned live root 5580", () => {
    const out = sanitizeWorktreeEnvForRootSync(
      "COMPOSE_PROJECT_NAME=slopwt-x\nDB_PORT=5580\nDATABASE_URL=postgres://a:a@localhost:5580/db\nOTHER=1\n",
      "DB_PORT=5580\nDATABASE_URL=postgres://a:a@localhost:5580/db\n",
      { canonicalDbPort: 5433 },
    );
    assert.doesNotMatch(out, /COMPOSE_PROJECT_NAME/);
    assert.match(out, /DB_PORT=5433/);
    assert.match(out, /localhost:5433\/db/);
    assert.match(out, /OTHER=1/);
  });

  it("scrubIsolationKeysFromEnvRecord drops 55xx DB_PORT", () => {
    const scrubbed = scrubIsolationKeysFromEnvRecord({
      DB_PORT: "5580",
      COMPOSE_PROJECT_NAME: "slopwt-08",
      KEEP: "1",
      DATABASE_URL: "postgres://a:a@localhost:5580/db",
    });
    assert.equal(scrubbed.KEEP, "1");
    assert.equal(scrubbed.DB_PORT, undefined);
    assert.equal(scrubbed.COMPOSE_PROJECT_NAME, undefined);
    assert.equal(scrubbed.DATABASE_URL, undefined);
  });
});

describe("verifyDatabaseArtifacts fallthrough", () => {
  it("accepts extension-only init-db.sql when drizzle has CREATE TABLE", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-db-"));
    try {
      writeFileSync(
        join(root, "init-db.sql"),
        "CREATE EXTENSION IF NOT EXISTS vector;\n",
      );
      mkdirSync(join(root, "drizzle"), { recursive: true });
      writeFileSync(
        join(root, "drizzle", "0000.sql"),
        "CREATE TABLE organizations (id uuid);\n",
      );
      const r = verifyDatabaseArtifacts(root);
      assert.equal(r.ok, true, r.output);
      assert.match(r.output, /drizzle\/0000/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("change intent", () => {
  it("extracts composer uiMount from move-to-chat-prompt language", () => {
    const intent = extractChangeIntent(
      "The forms look great in the bubble. Please move that form into the chat prompt / composer so I can fill it there.",
    );
    assert.equal(intent.uiMount, "composer");
    assert.ok(intent.mustNot.some((m) => /bubble/i.test(m)));
    const block = formatChangeIntentPromptBlock(intent);
    assert.match(block, /uiMount:\*\* composer/);
  });

  it("matches plural chat bubbles and engagement → inherits composer", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-intent-"));
    try {
      const phaseDir = join(dir, ".slopcontrol", "phases", "54-prior");
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(
        join(phaseDir, "INTENT.json"),
        JSON.stringify({
          title: "prior",
          goal: "prior",
          uiMount: "composer",
          refinementOf: [],
          supersedes: ["BD-IN-BUBBLE-FORMS"],
          mustNot: [],
          rawDescription: "composer",
        }),
      );
      const intent = extractChangeIntent(
        'The new dynamic form capability is creating forms in chat bubbles. But I am unable to input data into these forms or submit them. The reason given on the screen is "Superseded by a newer form"',
        { projectRoot: dir, phaseId: "55-new" },
      );
      assert.equal(intent.uiMount, "composer");
      assert.deepEqual(intent.refinementOf, ["54-prior"]);
      assert.ok(intent.interaction);
      assert.match(intent.interaction!.primaryAction, /submit/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a full operator goal instead of truncating mid-word at 400 chars", () => {
    const long =
      "I want a task that will add dynamic form capability to the chat process based on the data being gathered. " +
      "I want this to work for the workflow creation process first. Right now it is guiding through the process nicely. " +
      "But when it comes to say gathering a url for say the excel/csv skill, it just asks for the chat to be filled out. " +
      "When what should happen is the chat text area should be dynamically reformatted to display an appropriate form.";
    const intent = extractChangeIntent(
      `## Operator request\n\n${long}\n\n### Proposed approach\n\nIgnore this noise about bubble vs composer.`,
    );
    assert.ok(intent.goal.length > 400);
    assert.match(intent.goal, /reformatted to display an appropriate form/i);
    assert.doesNotMatch(intent.goal, /Proposed approach/);
  });

  it("rejects PHASE that supersedes composer when intent is composer", () => {
    const intent = extractChangeIntent(
      "Put the interactive form in the composer (chat prompt).",
    );
    const bad = `# Phase

## Scope
Restore in-bubble forms.

## Blueprint Deltas

- **BD-IN-BUBBLE-FORMS (supersedes the phase-49 composer-mount decision):** mounts inside the assistant speech bubble, not in the composer. The composer surface is always ChatInput.
`;
    const align = phaseDocAlignsWithChangeIntent(bad, intent);
    assert.equal(align.ok, false);
  });

  it("rejects chip-only engagement PHASE", () => {
    const intent = extractChangeIntent(
      'Unable to submit the form — stuck at "Superseded by a newer form". Fix so I can fill and submit.',
    );
    assert.equal(intent.uiMount, "composer");
    const bad = `# Phase

## Scope
Collapse superseded forms to summary chips in the transcript.

## Success Criteria
- getFormPartState classifies superseded correctly

## Automated Checks
\`\`\`bash
npm test -- tests/chat-messages-form.test.ts
\`\`\`

## Blueprint Deltas
- **BD-TRANSCRIPT-SUPERSEDED-CHIP:** superseded is a chip
`;
    const align = phaseDocAlignsWithChangeIntent(bad, intent);
    assert.equal(align.ok, false);
  });

  it("rejects engagement PHASE that only uses legacy tool-invocation fixtures", () => {
    const intent = extractChangeIntent(
      'Unable to submit the form — stuck at "Superseded by a newer form". Fix so I can fill and submit.',
    );
    const bad = `# Phase

## Scope
Fix composer form engagement with fillable inputs.

## Success Criteria
- composer-form has enabled input and submit

## Automated Checks
\`\`\`bash
npm test -- tests/active-form.test.ts
\`\`\`
Fixtures use type: "tool-invocation" with toolName set.

## Blueprint Deltas
- **BD-COMPOSER-FORM-ENGAGEMENT:** composer mount
`;
    const align = phaseDocAlignsWithChangeIntent(bad, intent);
    assert.equal(align.ok, false);
    assert.ok(align.issues.some((i) => /live|tool-<|parseToolResult/i.test(i)));
  });

  it("accepts page-mount engagement PHASE without AI SDK tool-part language", () => {
    // JamPress phase 87 class: Clerk sign-in page — mount=page engagement
    // must not be trapped by the composer-only live tool-part proof demand.
    const intent = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Fix JamPress login buttons",
        goal: "Make the sign-in page render the Clerk SignIn component so users can submit the login form.",
        uiMount: "page",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      { description: "Login buttons do not work on the sign-in page" },
    );
    assert.equal(intent.interaction?.mount, "page");
    const doc = `# Phase

## Scope
Add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY to the Compose .env so the sign-in page mounts Clerk <SignIn> with an enabled submit action.

## Success Criteria
- Sign-in page mounts the Clerk <SignIn> component (not the fallback)
- Primary action (submit form via OAuth button) is reachable and enabled

## Automated Checks
\`\`\`bash
grep -q '^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_' .env || exit 1
grep -q '<SignIn' src/app/sign-in/page.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-87-COMPOSE-DOTENV:** NEXT_PUBLIC_* vars live in Compose .env
`;
    const align = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.deepEqual(align.issues, []);
    assert.equal(align.ok, true);
  });

  it("still rejects composer-mount engagement without live tool-part proof", () => {
    const intent = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Fix composer form submit",
        goal: "Users must fill and submit skill params in the composer.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      { description: "Unable to submit form in composer" },
    );
    const doc = `# Phase

## Scope
Fix composer form engagement with fillable inputs and submit.

## Success Criteria
- composer-form has enabled input and submit

## Automated Checks
\`\`\`bash
npm test -- tests/active-form.test.ts
\`\`\`
Fixtures use type: "tool-invocation" with toolName set.

## Blueprint Deltas
- **BD-COMPOSER-FORM-ENGAGEMENT:** composer mount
`;
    const align = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(align.ok, false);
    assert.ok(align.issues.some((i) => /chat mount|tool-<|parseToolResult/i.test(i)));
  });

  it("accepts engagement PHASE with live static tool-part proof", () => {
    const intent = extractChangeIntent(
      'Unable to submit the form — stuck at "Superseded by a newer form". Fix so I can fill and submit.',
    );
    const good = `# Phase

## Scope
Fix parseToolResult to derive toolName from type: tool-<name> at the composer mount.

## Success Criteria
- extractActiveForm works for live static parts without toolName
- composer-form has enabled input and submit

## Automated Checks
\`\`\`bash
npm test -- tests/active-form.test.ts
\`\`\`
Live static shape: type tool-start-workflow-draft, no toolName; parseToolResult derives name.

## Blueprint Deltas
- **BD-COMPOSER-FORM-ENGAGEMENT:** composer mount
`;
    const align = phaseDocAlignsWithChangeIntent(good, intent);
    assert.equal(align.ok, true, align.issues.join("; "));
  });

  it("ensureChangeIntent refreshes weak n/a engagement INTENT on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-intent-refresh-"));
    try {
      const phaseId = "55-weak";
      const phaseDir = join(dir, ".slopcontrol", "phases", phaseId);
      mkdirSync(phaseDir, { recursive: true });
      writeFileSync(
        join(phaseDir, "INTENT.json"),
        JSON.stringify({
          title: "forms in chat bubbles",
          goal: "unable to input",
          uiMount: "n/a",
          refinementOf: [],
          supersedes: [],
          mustNot: [],
          rawDescription: "weak",
        }),
      );
      const desc =
        'The new dynamic form capability is creating forms in chat bubbles. But I am unable to input data into these forms or submit them. The reason given on the screen is "Superseded by a newer form"';
      const intent = ensureChangeIntent(dir, phaseId, desc);
      assert.equal(intent.uiMount, "composer");
      assert.ok(intent.interaction);
      assert.ok(intent.mustNot.length > 0);
      const stored = JSON.parse(
        readFileSync(join(phaseDir, "INTENT.json"), "utf-8"),
      );
      assert.equal(stored.uiMount, "composer");
      assert.ok(stored.interaction);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("researchEngagementQuality rejects overclaim without residual risks", () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer.",
    );
    const bad = `# Research

The codebase already implements ~90% of this request. Forms already work.

## Notes
Ship labels only.
`;
    const q = researchEngagementQuality(bad, intent);
    assert.equal(q.ok, false);
    const good = `# Research

Prior phases are complete but that is a hypothesis, not proof.
There is a blocking residual risk: parseToolResult never derives toolName from type: tool-<name>.

## Notes
Fix live static tool parts first.
`;
    assert.equal(researchEngagementQuality(good, intent).ok, true);
  });

  it("researchEngagementQualityAsync drops a false-positive overclaim via the judge", async () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer.",
    );
    // Deterministic regex flags "~90% already works" as overclaim, but the
    // research actually documents a residual risk in a vocabulary the regex
    // misses (no "residual"/"blocking"/"hypothesis"/"does not survive" keyword).
    const doc = `# Research

The codebase already implements ~90% of this request. Forms already work.

## Notes
The submit handler still needs to be wired to the backend before the form is usable.
`;
    const deterministic = researchEngagementQuality(doc, intent);
    assert.equal(deterministic.ok, false);

    const refined = await researchEngagementQualityAsync(doc, intent, {
      judgeFn: async () => ({
        genuineGap: false,
        reason: "Research names a still-to-wire submit handler, which is a residual risk.",
        existingProof: "The submit handler still needs to be wired to the backend.",
      }),
    });
    assert.deepEqual(refined.issues, []);
    assert.ok(refined.warnings.length >= 1);
    assert.match(refined.warnings[0] ?? "", /rejected by LLM judge/);
  });

  it("researchEngagementQualityAsync keeps a genuine overclaim and fails closed", async () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer.",
    );
    const doc = `# Research

The codebase already implements ~90% of this request. Forms already work.

## Notes
Ship labels only.
`;
    // Judge confirms the overclaim is genuine → issue kept.
    const confirmed = await researchEngagementQualityAsync(doc, intent, {
      judgeFn: async () => ({ genuineGap: true, reason: "no residual risk named" }),
    });
    assert.ok(confirmed.issues.some((i) => /overclaim/i.test(i)));
    assert.deepEqual(confirmed.warnings, []);

    // Judge throws → deterministic issue kept (fail closed).
    const failed = await researchEngagementQualityAsync(doc, intent, {
      judgeFn: async () => {
        throw new Error("judge down");
      },
    });
    assert.ok(failed.issues.some((i) => /overclaim/i.test(i)));
    assert.deepEqual(failed.warnings, []);
  });

  it("garbage-collects superseded mount BDs", () => {
    const bp = `# Blueprint

## Decisions

- **BD-COMPOSER-FORM-MODE:** forms in composer.
- **BD-IN-BUBBLE-FORMS (supersedes …):** forms in bubble.
`;
    const cleaned = garbageCollectSupersededMountBds(bp);
    assert.match(cleaned, /~~\*\*BD-COMPOSER-FORM-MODE\*\*~~/);
  });

  it("intent-aware GC never strikes composer when uiMount=composer", () => {
    const bp = `# Blueprint

## Decisions

- **BD-COMPOSER-FORM-MODE:** forms in composer.
- **BD-IN-BUBBLE-FORMS (supersedes …):** forms in bubble.
`;
    const intent = extractChangeIntent("Put forms in the composer.");
    const cleaned = garbageCollectSupersededMountBds(bp, intent);
    assert.match(cleaned, /\*\*BD-COMPOSER-FORM-MODE/);
    assert.doesNotMatch(cleaned, /~~\*\*BD-COMPOSER-FORM-MODE\*\*~~/);
    assert.match(cleaned, /~~\*\*BD-IN-BUBBLE-FORMS\*\*~~/);
  });

  it("reconcile builds Live decisions and dedupes", () => {
    const bp = `# Blueprint

## Decisions

- **BD-COMPOSER-FORM-MODE:** forms in composer.
- **BD-COMPOSER-FORM-MODE:** forms in composer again.
- **BD-IN-BUBBLE-FORMS:** forms in bubble.
- **BD-ACTIVE-CHIP-REOPEN:** reopen chip.
`;
    const intent = extractChangeIntent("Fix unable to submit in composer.");
    const { blueprint, report } = reconcileBlueprintDecisions(bp, intent);
    assert.match(blueprint, /## Live decisions/);
    assert.match(blueprint, /BD-COMPOSER-FORM-MODE/);
    assert.match(blueprint, /~~\*\*BD-IN-BUBBLE-FORMS\*\*~~/);
    assert.ok(report.some((r) => /dedupe|live decisions|mount conflict/i.test(r)));
  });

  it("phase-56 style populate/submit ask locks composer + strips promote meta title", () => {
    const desc = `## Operator request

I want a task to promote to research. I want dynamic forms to be implemented as part of the data gathering process for the workflow definition. These forms must be built based on the requirements of the flow, and presented to the user. So if a user is using the CSV/Excel skill then a form gathering the data for this skill must be present showing source url, filename and row number. Which is on the skill. The user must then be able to populate it as part of the data gathering process and submit it upon which it must be validated, it would be great if the dynamic forms validated themselves as data is input.`;
    const intent = extractChangeIntent(desc);
    assert.equal(intent.uiMount, "composer");
    assert.equal(intent.changeKind, "engagement");
    assert.ok(intent.interaction);
    assert.match(intent.interaction!.primaryAction, /submit/i);
    assert.ok(intent.mustNot.some((m) => /chip/i.test(m)));
    assert.doesNotMatch(intent.title, /^I want a task to promote/i);
    assert.match(intent.title, /dynamic forms/i);
    assert.doesNotMatch(intent.goal, /^I want a task to promote to research\./i);
  });

  it("phase-57 style chrome-hide ask: no fill/submit interaction, strips status title", () => {
    const desc = `## Operator request

What phases are complete?

The dynamic forms for the chat are working. As I go through the process the chat window is replaced with appropriate form to gather data. This is tabbed nicely. Thank you. There are some problems with the design though. If there is nothing to gather for example free format text is required from the user rather than data to be validated. This happens when discussing the workflow definition and not a skills data or a connections settings. Then a blank form is present rather than just the chat window. If I click on the tab to go to the chat, it appears. It would be better not to display the tabs at this point but only display the chat text area. So tabs appear when we are gathering data for a dynamic form, and disappear when there is nothing to gather. Please can you give me a task for promotion to research

### Ask conversation context

**assistant:** phase 27 was later superseded by 28–29, which removed the local Ollama container.
`;
    const intent = extractChangeIntent(desc);
    assert.equal(intent.uiMount, "composer");
    assert.equal(intent.changeKind, "chrome-hide");
    assert.equal(intent.interaction, undefined);
    assert.doesNotMatch(intent.title, /what phases are complete/i);
    assert.match(intent.title, /blank form|tabs|nothing to gather|chat text area/i);
    assert.doesNotMatch(intent.goal, /give me a task for promotion/i);
    assert.ok(intent.mustNot.some((m) => /bubble/i.test(m)));
    assert.ok(!intent.mustNot.some((m) => /chip.*fill\/submit/i.test(m)));
    assert.match(formatChangeIntentPromptBlock(intent), /\*\*changeKind:\*\* chrome-hide/);
  });

  it("finalizeChangeIntent: engagement gets interaction; chrome-hide/backend never", () => {
    const engagement = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Fix composer form submit",
        goal: "Users must fill and submit skill params in the composer.",
        uiMount: "composer",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      { description: "Unable to submit form in composer" },
    );
    assert.equal(engagement.changeKind, "engagement");
    assert.ok(engagement.interaction);

    const chrome = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Hide empty form tabs",
        goal: "Hide Form|Chat tabs when nothing to gather.",
        uiMount: "composer",
        changeKind: "chrome-hide",
        needsInteraction: true, // model mistake — finalize must ignore
      }),
      { description: "Hide blank form tabs" },
    );
    assert.equal(chrome.changeKind, "chrome-hide");
    assert.equal(chrome.interaction, undefined);

    const backend = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Fix DB pool",
        goal: "Tune connection pool for API.",
        uiMount: "n/a",
        changeKind: "backend",
        needsInteraction: true,
      }),
      { description: "Fix database pool" },
    );
    assert.equal(backend.changeKind, "backend");
    assert.equal(backend.interaction, undefined);
  });

  it("finalizeChangeIntent: other trusts LLM needsInteraction (no description regex veto)", () => {
    const themeDesc =
      "Audit the existing light/dark theme toggle on the landing page and fix ThemeToggle / data-theme wiring.";
    const theme = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Audit light/dark theme toggle on landing page",
        goal: "Verify ThemeToggle drives landing components via data-theme.",
        uiMount: "page",
        changeKind: "other",
        needsInteraction: false,
        themeWiringOnly: true,
        brandTheming: false,
      }),
      { description: themeDesc },
    );
    assert.equal(theme.changeKind, "other");
    assert.equal(theme.uiMount, "page");
    assert.equal(theme.themeWiringOnly, true);
    assert.equal(theme.interaction, undefined);

    const mistaken = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Audit light/dark theme toggle on landing page",
        goal: "Verify ThemeToggle drives landing components via data-theme.",
        uiMount: "page",
        changeKind: "other",
        needsInteraction: true,
      }),
      { description: themeDesc },
    );
    // Success path trusts structured needsInteraction — no regex veto.
    assert.ok(mistaken.interaction);
  });

  it("theme toggle heuristic extract is other without interaction", () => {
    const intent = extractChangeIntent(
      "Audit the existing light/dark theme toggle implementation and verify it drives the landing page Hero and FeaturesGrid.",
    );
    assert.equal(intent.changeKind, "other");
    assert.equal(intent.interaction, undefined);
  });

  it("isChangeIntentWeak refreshes other Intent with spurious interaction", () => {
    const desc =
      "Audit the existing light/dark theme toggle on the landing page.";
    const weak = isChangeIntentWeak(
      {
        title: "Audit theme toggle",
        goal: "Fix theme toggle on landing.",
        uiMount: "page",
        changeKind: "other",
        refinementOf: [],
        supersedes: [],
        mustNot: [
          "do not treat summary chips or classification-only changes as satisfying fill/submit",
        ],
        rawDescription: desc,
        interaction: {
          mount: "page",
          primaryAction: "submit form",
          proof: ["interactive control at locked mount"],
          forbiddenSubstitutes: ["summary-chip-only"],
        },
      },
      desc,
    );
    assert.equal(weak, true);

    const strong = isChangeIntentWeak(
      {
        title: "Audit theme toggle",
        goal: "Fix theme toggle on landing.",
        uiMount: "page",
        changeKind: "other",
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: desc,
      },
      desc,
    );
    assert.equal(strong, false);
  });

  it("theme PHASE aligns when Intent has no interaction contract", () => {
    const intent = extractChangeIntent(
      "Audit light/dark theme toggle on the landing page; ThemeToggle must set data-theme.",
    );
    assert.equal(intent.interaction, undefined);
    const phase = `# PHASE: 09-theme-toggle

## Scope
Wire ThemeToggle to html data-theme for landing components.

## Success Criteria
- ThemeToggle click switches data-theme between dark and light
- Landing Hero responds to theme tokens

## Automated Checks
\`\`\`bash
pnpm test
\`\`\`

\`\`\`bash
cd playground && pnpm build || exit 1
\`\`\`

## Blueprint Deltas
None.
`;
    const align = phaseDocAlignsWithChangeIntent(phase, intent);
    assert.equal(align.ok, true, align.issues.join("; "));
  });

  it("populate/submit without chrome-hide still gets interaction", () => {
    const intent = extractChangeIntent(
      "Please implement dynamic forms so the user can populate and submit skill params in the composer.",
    );
    assert.equal(intent.uiMount, "composer");
    assert.equal(intent.changeKind, "engagement");
    assert.ok(intent.interaction);
  });

  const phase88Ask =
    'Investigate why the sign-in button (UserPill showing "?") on the landing page does nothing when clicked. Add onClick={() => router.push("/sign-in")}.';

  it("phase-88 click-to-navigate ask is other with no form contract", () => {
    assert.equal(isClickNavigateAsk(phase88Ask), true);
    assert.equal(needsInteractionContract(phase88Ask), false);
    const intent = extractChangeIntent(phase88Ask);
    assert.equal(intent.changeKind, "other");
    assert.equal(intent.interaction, undefined);
    assert.equal(interactionProofKind(intent), "none");
  });

  it("finalize coerces LLM engagement on a click-to-navigate ask off the form contract", () => {
    const intent = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Wire landing UserPill to sign-in",
        goal: "Clicking UserPill should navigate to /sign-in.",
        uiMount: "page",
        changeKind: "engagement",
        needsInteraction: true,
      }),
      { description: phase88Ask },
    );
    assert.equal(intent.changeKind, "other");
    assert.equal(intent.interaction, undefined);
    assert.equal(intent.uiMount, "page");
  });

  it("inert button without form words does not invent a fill/submit contract", () => {
    const inertButton = "The landing Sign In control is inert and does nothing when clicked.";
    assert.equal(needsInteractionContract(inertButton), false);
    const intent = extractChangeIntent(inertButton);
    assert.equal(intent.interaction, undefined);
  });

  it("unable to submit the form still needs an interaction contract", () => {
    const formFail = "Unable to submit the form — stuck at superseded.";
    assert.equal(needsInteractionContract(formFail), true);
    const intent = extractChangeIntent(formFail);
    assert.equal(intent.changeKind, "engagement");
    assert.ok(intent.interaction);
    assert.match(intent.interaction!.primaryAction, /submit form/i);
  });

  it("click-to-navigate PHASE.md passes when Intent has no form contract", () => {
    const intent = extractChangeIntent(phase88Ask);
    const doc = `# Phase

## Scope
Wire landing UserPill loggedOut onClick to router.push("/sign-in").

## Success Criteria
- Clicking the landing UserPill navigates to /sign-in
- UserPill loggedOut has onClick

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
grep -q 'router.push("/sign-in")' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-88-USERPILL-SIGNIN:** landing UserPill navigates to /sign-in
`;
    const align = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.deepEqual(align.issues, []);
    assert.equal(align.ok, true);
  });

  it("form-engagement PHASE without fill+submit still fails align", () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer. Fix so I can fill and submit.",
    );
    assert.equal(interactionProofKind(intent), "form-submit");
    const doc = `# Phase

## Scope
Wire landing UserPill loggedOut onClick to router.push("/sign-in").

## Success Criteria
- Clicking the landing UserPill navigates to /sign-in

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
grep -q 'router.push("/sign-in")' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-88-USERPILL-SIGNIN:** landing UserPill navigates to /sign-in
`;
    const align = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(align.ok, false);
    assert.ok(
      align.issues.some((i) => /fill\+submit/i.test(i)),
      align.issues.join("; "),
    );
  });

  it("click-navigate interaction contract requires click proofs not fill+submit", () => {
    const intent = {
      ...extractChangeIntent(phase88Ask),
      interaction: {
        mount: "page" as const,
        primaryAction: "click / navigate",
        proof: ["onClick or Link at locked control"],
        forbiddenSubstitutes: ["fill+submit form proofs"],
      },
    };
    assert.equal(interactionProofKind(intent), "click-navigate");
    const good = `# Phase

## Scope
Wire UserPill onClick.

## Success Criteria
- Click navigates to /sign-in

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
grep -q 'router.push("/sign-in")' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- none
`;
    assert.equal(phaseDocAlignsWithChangeIntent(good, intent).ok, true);
    const bad = `# Phase

## Scope
Wire UserPill.

## Success Criteria
- Control is present

## Automated Checks
\`\`\`bash
npm test
\`\`\`

## Blueprint Deltas
- none
`;
    const align = phaseDocAlignsWithChangeIntent(bad, intent);
    assert.equal(align.ok, false);
    assert.ok(align.issues.some((i) => /click \/ onClick/i.test(i)));
    assert.ok(!align.issues.some((i) => /fill\+submit/i.test(i)));
  });

  it("async align drops a bubble-mount false positive via the LLM judge", async () => {
    const intent = extractChangeIntent(
      "The form in the assistant speech bubble is broken. Fix so I can fill and submit it.",
    );
    assert.equal(intent.uiMount, "bubble");
    assert.equal(interactionProofKind(intent), "form-submit");

    // A semantically-correct bubble-mount form that uses FormBubble /
    // sendFormAnswer / composerMode — the deterministic regex only knows
    // composer-form / data-testid=composer-form, so it flags a false positive.
    const doc = `# Phase

## Scope
Fix the FormBubble form in the assistant speech bubble.

## Success Criteria
- The FormBubble accepts typed forms and confirms the round-trip via sendFormAnswer.

## Automated Checks
\`\`\`bash
grep -q 'sendFormAnswer' src/FormBubble.tsx || exit 1
grep -q 'composerMode' src/FormBubble.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-IN-BUBBLE-FORMS:** forms own the assistant speech bubble
`;
    const deterministic = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(deterministic.ok, false);
    assert.ok(
      deterministic.issues.some((i) => /fill\+submit/i.test(i)),
      deterministic.issues.join("; "),
    );

    // Judge rejects the false positive → issue dropped to warnings.
    const refined = await phaseDocAlignsWithChangeIntentAsync(doc, intent, {
      judgeFn: async () => ({
        genuineGap: false,
        reason: "FormBubble + sendFormAnswer prove fill+submit at the bubble mount.",
        existingProof: "grep -q 'sendFormAnswer' src/FormBubble.tsx",
      }),
    });
    assert.deepEqual(refined.issues, []);
    assert.ok(refined.warnings.length >= 1);
    assert.match(refined.warnings[0] ?? "", /rejected by LLM judge/);
  });

  it("intentAlignmentExcerptFromPhaseDoc includes Scope and Blueprint Deltas", () => {
    const excerpt = intentAlignmentExcerptFromPhaseDoc(`# Phase

## Scope
FormBubble at /dashboard/chat page mount.

## Success Criteria
- Typed forms work

## Automated Checks
\`\`\`bash
grep -q FormBubble
\`\`\`

## Blueprint Deltas
- **BD-PAGE-FORM:** page mount only
`);
    assert.match(excerpt, /## Scope/);
    assert.match(excerpt, /dashboard\/chat/);
    assert.match(excerpt, /## Blueprint Deltas/);
    assert.match(excerpt, /BD-PAGE-FORM/);
  });

  it("consolidateText keeps head and tail, drops only the middle", () => {
    const text = "A".repeat(100) + "MIDDLE" + "Z".repeat(100);
    const out = consolidateText(text, 50);
    assert.ok(out.length <= 50);
    assert.match(out, /^A+/);
    assert.match(out, /Z+$/);
    assert.match(out, /truncated/);
    assert.ok(!out.includes("MIDDLE"));
  });

  it("consolidateText returns short text unchanged", () => {
    const text = "short text";
    assert.equal(consolidateText(text, 100), text);
  });

  it("intentAlignmentExcerptFromPhaseDoc preserves Blueprint Deltas on a long doc", () => {
    const longScope = "Scope detail. ".repeat(400);
    const longChecks = "grep -q token. ".repeat(400);
    const doc = `# Phase

## Scope
${longScope}

## Success Criteria
- Typed forms work

## Automated Checks
${longChecks}

## Blueprint Deltas
- **BD-PAGE-FORM:** page mount only
`;
    const excerpt = intentAlignmentExcerptFromPhaseDoc(doc);
    // Every section is represented, and the tail (Blueprint Deltas) survives.
    assert.match(excerpt, /## Scope/);
    assert.match(excerpt, /## Success Criteria/);
    assert.match(excerpt, /## Automated Checks/);
    assert.match(excerpt, /## Blueprint Deltas/);
    assert.match(excerpt, /BD-PAGE-FORM/);
    // Long sections are consolidated (head+tail), not silently head-truncated.
    assert.match(excerpt, /truncated/);
  });

  it("async align drops a page-mount false positive (phase-20 class)", async () => {
    const intent = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Add org-scoped write tools + typed-form CRUD",
        goal: "Port JamPress management chat write tools and typed forms.",
        uiMount: "page",
        changeKind: "engagement",
        needsInteraction: true,
        interaction: {
          mount: "page",
          primaryAction: "submit form",
          proof: ["interactive control at locked mount"],
          forbiddenSubstitutes: ["summary-chip-only"],
        },
        refinementOf: [],
        supersedes: [],
        mustNot: [],
      }),
      {
        description:
          "Add write tools and typed-form CRUD to jamauth management chat at /dashboard/chat.",
      },
    );
    assert.equal(intent.uiMount, "page");
    assert.equal(interactionProofKind(intent), "form-submit");

    const doc = `# Phase 20 — Write tools + typed-form CRUD

## Scope
FormBubble at \`/dashboard/chat\` page mount (\`ChatClient variant="full"\`).

## Success Criteria
- Destructive ops require review/confirm round-trip (structural).
- Forms survive reloads via the loop-2 storage contract.

## Automated Checks
\`\`\`bash
grep -q "FormBubble" web/src/components/chat/chat-client.tsx || exit 1
grep -q "sendFormAnswer" web/src/components/chat/chat-session-provider.tsx || exit 1
grep -q "composerMode" web/src/components/chat/chat-session-provider.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-20-8:** FormBubble UI at page mount
`;
    const deterministic = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(deterministic.ok, false);
    assert.ok(
      deterministic.issues.some((i) => /fill\+submit/i.test(i)),
      deterministic.issues.join("; "),
    );

    const refined = await phaseDocAlignsWithChangeIntentAsync(doc, intent, {
      judgeFn: async (input) => {
        assert.match(input.phaseDocExcerpt, /dashboard\/chat/);
        assert.match(input.phaseDocExcerpt, /BD-20-8/);
        return {
          genuineGap: false,
          reason:
            "FormBubble + sendFormAnswer at the page mount prove fill+submit without composer-form keywords.",
          existingProof: "grep -q 'sendFormAnswer' web/src/components/chat/chat-session-provider.tsx",
        };
      },
    });
    assert.deepEqual(refined.issues, []);
    assert.ok(refined.warnings.length >= 1);
  });

  it("async align keeps a mount-conflict gap when judge sees Scope/BD excerpt", async () => {
    const intent = extractChangeIntent(
      "The form in the composer is broken. Fix so I can fill and submit it.",
    );
    assert.equal(intent.uiMount, "composer");
    const doc = `# Phase

## Scope
Lock forms inside the assistant speech bubble (not in the composer).

## Success Criteria
- fill and submit at composer

## Automated Checks
\`\`\`bash
grep -q 'fill' src/form.tsx && grep -q 'submit' src/form.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-IN-BUBBLE-FORMS:** mounts inside the assistant bubble
`;
    const deterministic = phaseDocAlignsWithChangeIntent(doc, intent);
    assert.equal(deterministic.ok, false);
    assert.ok(
      deterministic.issues.some((i) => /uiMount=composer/i.test(i)),
      deterministic.issues.join("; "),
    );

    const refined = await phaseDocAlignsWithChangeIntentAsync(doc, intent, {
      judgeFn: async (input) => {
        assert.match(input.phaseDocExcerpt, /assistant speech bubble/i);
        return {
          genuineGap: true,
          reason: "Scope/BD lock forms in bubble while intent requires composer.",
          suggestedCheck:
            "grep -q 'composer-form' src/chat && grep -q 'submit' src/chat",
        };
      },
    });
    assert.ok(refined.issues.some((i) => /uiMount=composer/i.test(i)));
    assert.match(refined.issues[0] ?? "", /Suggested check \(LLM judge\)/);
    assert.deepEqual(refined.warnings, []);
  });

  it("async align keeps a genuine gap and fails closed on judge error", async () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer. Fix so I can fill and submit.",
    );
    const doc = `# Phase

## Scope
Wire landing UserPill loggedOut onClick to router.push("/sign-in").

## Success Criteria
- Clicking the landing UserPill navigates to /sign-in

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-88-USERPILL-SIGNIN:** landing UserPill navigates to /sign-in
`;
    // Judge confirms the gap is genuine → issue kept.
    const confirmed = await phaseDocAlignsWithChangeIntentAsync(doc, intent, {
      judgeFn: async () => ({ genuineGap: true, reason: "no fill+submit proof" }),
    });
    assert.ok(confirmed.issues.some((i) => /fill\+submit/i.test(i)));
    assert.deepEqual(confirmed.warnings, []);

    // Judge throws → deterministic issue kept (fail closed).
    const failed = await phaseDocAlignsWithChangeIntentAsync(doc, intent, {
      judgeFn: async () => {
        throw new Error("judge down");
      },
    });
    assert.ok(failed.issues.some((i) => /fill\+submit/i.test(i)));
    assert.deepEqual(failed.warnings, []);
  });

  it("async align without a judge returns the deterministic issues", async () => {
    const intent = extractChangeIntent(
      "Unable to submit the form in the composer. Fix so I can fill and submit.",
    );
    const doc = `# Phase

## Scope
Wire landing UserPill loggedOut onClick to router.push("/sign-in").

## Success Criteria
- Clicking the landing UserPill navigates to /sign-in

## Automated Checks
\`\`\`bash
grep -q 'onClick' src/components/layout/user-pill.tsx || exit 1
\`\`\`

## Blueprint Deltas
- **BD-88-USERPILL-SIGNIN:** landing UserPill navigates to /sign-in
`;
    const result = await phaseDocAlignsWithChangeIntentAsync(doc, intent);
    assert.ok(result.issues.some((i) => /fill\+submit/i.test(i)));
    assert.deepEqual(result.warnings, []);
  });

  it("extractLiveDecisions reads verified + claimed sections", () => {
    const bp = `# Blueprint

## Live decisions — verified

- BD-COMPOSER-FORM-MODE: composer

## Live decisions — claimed unverified

- BD-MCP1: mcp

## Product summary

Hello
`;
    const live = extractLiveDecisions(bp);
    assert.match(live, /verified/i);
    assert.match(live, /BD-COMPOSER-FORM-MODE/);
    assert.match(live, /BD-MCP1/);
    const clip = clipBlueprintForPrompt(bp, 2000);
    assert.match(clip, /verified/i);
    assert.match(clip, /BD-COMPOSER-FORM-MODE/);
  });

  it("clipBlueprintForAskAlign prefers Product summary over Live decisions", () => {
    const bp = `# Blueprint

## Live decisions — verified

- BD-88-LANDING-SIGNIN-CLICK (new)

## Product summary

JamPress is an AI-powered data workflow builder.

## Skills / tools / workflows

excel-reader, marketplace connectors, chat authoring.

## Modules and key paths

src/app/product/page.tsx
`;
    const clip = clipBlueprintForAskAlign(bp, 4_000);
    assert.match(clip, /## Product summary/);
    assert.match(clip, /workflow builder/);
    assert.match(clip, /## Skills \/ tools \/ workflows/);
    assert.match(clip, /## Modules and key paths/);
    assert.doesNotMatch(clip, /BD-88-LANDING-SIGNIN-CLICK/);
    assert.doesNotMatch(clip, /Live decisions/);
  });

  it("stock adoption ask classifies stockAdoption, not brandTheming (heuristic)", () => {
    const intent = extractChangeIntent(
      "I need you to please review the menu bar. We are not using the correct menubar theming. Strip it away and use the stock menubar theming from the jamroast-components project. Keep the current logo and create an icon pack for it with an alpha channel.",
    );
    assert.equal(intent.stockAdoption, true);
    assert.equal(intent.brandTheming, false);
    assert.equal(changeIntentIsBrandTheming(intent), false);
  });

  it("sibling bespoke theme port stays brandTheming (not stockAdoption)", () => {
    const intent = extractChangeIntent(
      "Apply the same layout and look and feel from the JamPress and JamRoast projects to this app. We also need a new icon based on a similar concept.",
    );
    assert.equal(intent.stockAdoption, false);
    assert.equal(intent.brandTheming, true);
    assert.equal(changeIntentIsBrandTheming(intent), true);
  });

  it("changeIntentIsBrandTheming honors structured stockAdoption over brandTheming", () => {
    assert.equal(
      changeIntentIsBrandTheming({
        title: "Adopt stock menubar",
        goal: "Use stock jamroast-components menubar theming",
        uiMount: "page",
        changeKind: "other",
        brandTheming: true,
        stockAdoption: true,
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: "use the stock menubar theming from jamroast-components",
      }),
      false,
    );
  });

  it("asset-swap ask classifies assetSwap, not brandTheming (heuristic)", () => {
    const intent = extractChangeIntent(
      "Please can you make sure the following log jamlight-circular-mark-v1.png is used rather than the alpha logo that is current on the site. It is the pinned one right now",
    );
    assert.equal(intent.assetSwap, true);
    assert.equal(intent.brandTheming, false);
    assert.equal(changeIntentIsBrandTheming(intent), false);
  });

  it("new-logo creation ask is NOT an asset swap", () => {
    const intent = extractChangeIntent(
      "I need you to design a new logo. Make it circular and symbolic, generate 7 different styles.",
    );
    assert.equal(intent.assetSwap, false);
    assert.equal(intent.brandTheming, true);
    assert.equal(changeIntentIsBrandTheming(intent), true);
  });

  it("changeIntentIsBrandTheming honors structured assetSwap over brandTheming", () => {
    assert.equal(
      changeIntentIsBrandTheming({
        title: "Swap menubar logo to pinned mark",
        goal: "Use jamlight-circular-mark-v1.png rather than the alpha variant",
        uiMount: "page",
        changeKind: "other",
        brandTheming: true,
        assetSwap: true,
        refinementOf: [],
        supersedes: [],
        mustNot: [],
        rawDescription: "use jamlight-circular-mark-v1.png rather than the alpha logo",
      }),
      false,
    );
  });

  it("isChangeIntentWeak flags brand-misclassified asset swap for refresh", () => {
    const existing = extractChangeIntent("Add a logo", {});
    const misclassified = {
      ...existing,
      brandTheming: true,
      assetSwap: undefined,
    };
    assert.equal(
      isChangeIntentWeak(
        misclassified,
        "Make sure jamlight-circular-mark-v1.png is used rather than the alpha logo currently on the site.",
      ),
      true,
    );
    const refreshed = { ...misclassified, brandTheming: false, assetSwap: true };
    assert.equal(
      isChangeIntentWeak(
        refreshed,
        "Make sure jamlight-circular-mark-v1.png is used rather than the alpha logo currently on the site.",
      ),
      false,
    );
  });

  it("isChangeIntentWeak flags brand-misclassified stock adoption for refresh", () => {
    const existing = extractChangeIntent("Add a logo", {});
    const misclassified = {
      ...existing,
      brandTheming: true,
      stockAdoption: undefined,
    };
    assert.equal(
      isChangeIntentWeak(
        misclassified,
        "Strip the custom menubar and use the stock menubar theming from the jamroast-components project.",
      ),
      true,
    );
    // Once refreshed to stockAdoption, no longer weak on that axis.
    const refreshed = { ...misclassified, brandTheming: false, stockAdoption: true };
    assert.equal(
      isChangeIntentWeak(
        refreshed,
        "Strip the custom menubar and use the stock menubar theming from the jamroast-components project.",
      ),
      false,
    );
  });
});
