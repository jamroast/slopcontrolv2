import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  allocateWorktreeDbPort,
  applyWorktreeComposeIsolation,
  clipBlueprintForPrompt,
  ensureChangeIntent,
  extractChangeIntent,
  extractLiveDecisions,
  finalizeChangeIntent,
  formatChangeIntentPromptBlock,
  ChangeIntentLlmOutputSchema,
  garbageCollectSupersededMountBds,
  isChangeIntentWeak,
  isWorktreeIsolationPort,
  loadCanonicalRuntimeEnv,
  phaseDocAlignsWithChangeIntent,
  reconcileBlueprintDecisions,
  researchEngagementQuality,
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

  it("finalizeChangeIntent: other + needsInteraction true without form cues gets no interaction", () => {
    const themeDesc =
      "Audit the existing light/dark theme toggle on the landing page and fix ThemeToggle / data-theme wiring.";
    const theme = finalizeChangeIntent(
      ChangeIntentLlmOutputSchema.parse({
        title: "Audit light/dark theme toggle on landing page",
        goal: "Verify ThemeToggle drives landing components via data-theme.",
        uiMount: "page",
        changeKind: "other",
        needsInteraction: true, // model mistake — clickable toggle ≠ fill/submit
      }),
      { description: themeDesc },
    );
    assert.equal(theme.changeKind, "other");
    assert.equal(theme.uiMount, "page");
    assert.equal(theme.interaction, undefined);
    assert.ok(!theme.mustNot.some((m) => /fill\/submit/i.test(m)));
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
});
