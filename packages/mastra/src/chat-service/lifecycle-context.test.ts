import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGlobalChatPrompt,
  buildProjectChatPrompt,
  formatPendingConfirmPrompt,
} from "./lifecycle-context.js";
import type { ChatContextDeps } from "./types.js";
import type { Project } from "@slopcontrol/types";

const emptyDeps: ChatContextDeps = {
  listProjects: () => [],
  listPhases: () => [],
  listRuns: () => [],
  getProject: () => undefined,
};

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

const project: Project = {
  id: "p1",
  name: "demo",
  rootPath: "/tmp/does-not-need-to-exist",
  blueprintVersion: 0,
  createdAt: "",
  updatedAt: "",
};

describe("chat lifecycle prompt", () => {
  it("prefers ask for investigation and never sends the operator to a dashboard confirm", () => {
    const prompt = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(prompt.includes("use free tools — ask"));
    assert.ok(prompt.includes("list_* / get_*"));
    assert.ok(prompt.includes("call ask — not gated agent"));
    assert.ok(prompt.includes("wait_for_run"));
    assert.ok(prompt.includes("Do not tell the operator the work finished until wait_for_run"));
    assert.ok(prompt.includes("write the operator-facing answer from that result"));
    assert.ok(prompt.includes("get_ask / get_agent"));
    assert.ok(prompt.includes("Chat-owned asks"));
    assert.ok(prompt.includes("do not replace a page/route review"));
    assert.ok(prompt.includes("Never tell them to confirm in a separate SlopControl interface"));
    assert.ok(prompt.includes("submit_review"));
    assert.ok(prompt.includes("park advance_run"));
    assert.ok(prompt.includes("Never stop at accepted"));
    assert.ok(prompt.includes("autoMergeOnComplete"));
    assert.ok(prompt.includes("do NOT ask the operator to choose main vs development branch"));
    assert.ok(!prompt.includes("never auto-merge"));
    assert.ok(!prompt.includes("approve in the SlopControl interface"));
    assert.ok(!prompt.includes("please do"));
    assert.ok(prompt.includes("click navigates to route X"));
    assert.ok(prompt.includes("Intent engagement is only for fill/submit"));
    assert.ok(prompt.includes("Ask walker"));
    assert.ok(prompt.includes("classified by the classification model"));
    assert.ok(prompt.includes("chat_function_bind"));
  });

  it("injects parked actions and forbids a separate UI confirm", () => {
    const pending = formatPendingConfirmPrompt([
      { token: "tok-1", tool: "agent", argsPreview: '{"prompt":"read landing"}' },
    ]);
    assert.ok(pending.includes("agent"));
    assert.ok(pending.includes("tok-1"));
    assert.ok(pending.includes("Never tell them to approve in a dashboard"));

    const prompt = buildGlobalChatPrompt({
      deps: emptyDeps,
      pendingActions: [{ token: "tok-1", tool: "agent" }],
    });
    assert.ok(prompt.includes("Parked gated action"));
    assert.ok(prompt.includes("agent"));
    assert.ok(prompt.includes("chat_function_bind"));
    assert.ok(prompt.includes("Cross-project orchestration"));
    assert.ok(prompt.includes("cross_project_wire_package"));
    assert.ok(prompt.includes("project_workspace_package_publish"));
    assert.ok(prompt.includes("Proceedable runs"));
    assert.ok(!prompt.includes("chat_endpoint_model_update"));
    assert.ok(prompt.includes("web_search"));
    assert.ok(prompt.includes("archive_decision"));
  });
});

describe("project knowledge in chat prompt", () => {
  it("includes the knowledge block when provided", () => {
    const prompt = buildProjectChatPrompt({
      project,
      deps: emptyDeps,
      projectKnowledge: "- Menubar mounts ThemeToggle\n- Tests need Docker up",
    });
    assert.ok(prompt.includes("## Project knowledge (accumulated)"));
    assert.ok(prompt.includes("- Menubar mounts ThemeToggle"));
    // Knowledge lands before the BLUEPRINT excerpt
    assert.ok(
      prompt.indexOf("## Project knowledge") <
        prompt.indexOf("## BLUEPRINT.md"),
    );
  });

  it("omits the knowledge block when empty or whitespace", () => {
    const empty = buildProjectChatPrompt({
      project,
      deps: emptyDeps,
      projectKnowledge: "",
    });
    assert.ok(!empty.includes("## Project knowledge"));
    const blank = buildProjectChatPrompt({
      project,
      deps: emptyDeps,
      projectKnowledge: "   ",
    });
    assert.ok(!blank.includes("## Project knowledge"));
    const missing = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(!missing.includes("## Project knowledge"));
  });

  it("includes internet research guidance in project chat prompt", () => {
    const prompt = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(prompt.includes("web_search"));
    assert.ok(prompt.includes("fetch_url"));
    assert.ok(!prompt.includes("archive_decision"));
  });

  it("builds the publish-path playbook from the registered projects, not hardcoded names", () => {
    const lib = mkdtempSync(join(tmpdir(), "slop-lc-lib-"));
    const app = mkdtempSync(join(tmpdir(), "slop-lc-app-"));
    roots.push(lib, app);
    mkdirSync(join(lib, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(lib, ".slopcontrol", "config.json"),
      JSON.stringify({ componentLibrary: true }),
    );
    mkdirSync(join(app, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(app, ".slopcontrol", "config.json"),
      JSON.stringify({ componentLibrary: false }),
    );
    const libProject: Project = {
      id: "lib",
      name: "acme-components",
      rootPath: lib,
      blueprintVersion: 0,
      createdAt: "",
      updatedAt: "",
    };
    const appProject: Project = {
      id: "app",
      name: "acme-app",
      rootPath: app,
      blueprintVersion: 0,
      createdAt: "",
      updatedAt: "",
    };
    const prompt = buildGlobalChatPrompt({
      deps: {
        listProjects: () => [libProject, appProject],
        listPhases: () => [],
        listRuns: () => [],
        getProject: () => undefined,
      },
    });
    // Rows come from config: base library vs own library vs consume-only app.
    assert.match(prompt, /acme-components \| BASE component library → design_library_publish/);
    assert.match(prompt, /acme-app \| app \(consume only\) → project_workspace_package_publish/);
    assert.match(prompt, /Component-library ownership rule/);
    // The flow example names the actual registered projects.
    assert.match(prompt, /cross_project_wire_package publisher=acme-components/);
    assert.match(prompt, /consumers=\[acme-app\]/);
    // No Jam-estate names leak.
    assert.doesNotMatch(prompt, /JamRoast|JamPress|jamroast-components|@jam\/service-token|burntjam/);
  });
});

describe("component library ownership + cross-project knowledge", () => {
  it("surfaces ownership in the project prompt for an own-library project", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-lc-own-"));
    roots.push(root);
    mkdirSync(join(root, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(root, ".slopcontrol", "config.json"),
      JSON.stringify({
        componentLibrary: false,
        elementLibraryPackagePath: "packages/acme-components",
        publishScope: "@acme",
      }),
    );
    const ownProject: Project = {
      id: "own",
      name: "acme-app",
      rootPath: root,
      blueprintVersion: 0,
      createdAt: "",
      updatedAt: "",
    };
    const prompt = buildProjectChatPrompt({
      project: ownProject,
      deps: emptyDeps,
    });
    assert.ok(prompt.includes("## Component library ownership"));
    assert.ok(prompt.includes("packages/acme-components"));
    assert.ok(prompt.includes("promote an element to the base only when a second project reuses it"));
  });

  it("classifies an own-library project in the global publish table", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-lc-own2-"));
    roots.push(root);
    mkdirSync(join(root, ".slopcontrol"), { recursive: true });
    writeFileSync(
      join(root, ".slopcontrol", "config.json"),
      JSON.stringify({
        componentLibrary: false,
        elementLibraryPackagePath: "packages/acme-components",
      }),
    );
    const ownProject: Project = {
      id: "own2",
      name: "acme-app",
      rootPath: root,
      blueprintVersion: 0,
      createdAt: "",
      updatedAt: "",
    };
    const prompt = buildGlobalChatPrompt({
      deps: {
        listProjects: () => [ownProject],
        listPhases: () => [],
        listRuns: () => [],
        getProject: () => undefined,
      },
    });
    assert.match(prompt, /acme-app \| own library packages\/acme-components \(extends base\)/);
  });

  it("surfaces the global knowledge block in the project prompt when provided", () => {
    const prompt = buildProjectChatPrompt({
      project,
      deps: emptyDeps,
      globalKnowledge: "- Base library stays generic",
    });
    assert.ok(prompt.includes("## Global knowledge (durable cross-project decisions)"));
    assert.ok(prompt.includes("Base library stays generic"));
    assert.ok(
      prompt.indexOf("## Global knowledge") <
        prompt.indexOf("## BLUEPRINT.md"),
    );
  });

  it("omits the global knowledge block when empty", () => {
    const prompt = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(!prompt.includes("## Global knowledge"));
  });

  it("includes investigate-before-mutate guidance for design elements", () => {
    const prompt = buildProjectChatPrompt({ project, deps: emptyDeps });
    assert.ok(prompt.includes("read the consumer's actual composition and the project's own library"));
    assert.ok(prompt.includes("compose that component instead of extracting/evolving"));
    assert.ok(prompt.includes("carry its :root custom properties"));
    assert.ok(prompt.includes("never reference var(--x) in code without defining --x"));
  });
});
