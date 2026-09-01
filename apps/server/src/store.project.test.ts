import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SlopStore, phaseTitleFromDescription } from "./store.js";

describe("phaseTitleFromDescription", () => {
  it("skips the Operator request wrapper and strips markdown/newlines", () => {
    const desc =
      "## Operator request\n\n\n\nMake the dashboard menubar full width\n\nmore detail here";
    assert.equal(
      phaseTitleFromDescription(desc),
      "Make the dashboard menubar full width",
    );
  });

  it("handles headings and collapses whitespace", () => {
    assert.equal(
      phaseTitleFromDescription("### Fix the\n\nbuild   failure"),
      "Fix the",
    );
    assert.equal(phaseTitleFromDescription(""), "");
  });

  it("createPhase stores the sanitized title", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-phase-title-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({ name: "p", rootPath: projectRoot });
      const phase = store.createPhase({
        projectId: project.id,
        description: "## Operator request\n\nWiden the dashboard menubar",
        rootPath: projectRoot,
      });
      assert.equal(phase.title, "Widen the dashboard menubar");
      assert.ok(!phase.title.includes("\n"));
      assert.ok(!phase.title.includes("##"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createPhase renumbers a stale Phase N title and strips it from slug/title", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-phase-renum-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({ name: "p", rootPath: projectRoot });
      const phase = store.createPhase({
        projectId: project.id,
        description: "Phase 36 — Account-scoped session list/revoke",
        rootPath: projectRoot,
      });
      assert.equal(
        phase.description,
        "Phase 01 — Account-scoped session list/revoke",
      );
      assert.equal(phase.title, "Account-scoped session list/revoke");
      assert.equal(phase.slug, "account-scoped-session-list-revoke");
      assert.ok(!phase.id.includes("phase-36"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SlopStore project rename", () => {
  it("updateProject renames display name; id and rootPath unchanged", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-rename-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const project = store.createProject({
        name: "light-weight-crm-and-invoicing",
        rootPath: projectRoot,
      });
      const id = project.id;

      project.name = "JamLight CRM";
      project.updatedAt = new Date().toISOString();
      store.updateProject(project);

      const reloaded = new SlopStore(join(dir, "store.json"));
      const after = reloaded.getProject(id);
      assert.equal(after?.name, "JamLight CRM");
      assert.equal(after?.id, id);
      assert.equal(after?.rootPath, projectRoot);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createProject with same rootPath refreshes display name (rename via open)", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-rename-open-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const first = store.createProject({
        name: "old-name",
        rootPath: projectRoot,
      });
      const second = store.createProject({
        name: "new-name",
        rootPath: projectRoot,
      });
      assert.equal(second.id, first.id);
      assert.equal(second.name, "new-name");

      const reloaded = new SlopStore(join(dir, "store.json"));
      assert.equal(reloaded.getProject(first.id)?.name, "new-name");
      assert.equal(reloaded.listProjects().length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createProject with same rootPath and same name is a no-op", () => {
    const dir = mkdtempSync(join(tmpdir(), "slop-rename-noop-"));
    try {
      const store = new SlopStore(join(dir, "store.json"));
      const projectRoot = join(dir, "proj");
      mkdirSync(projectRoot, { recursive: true });
      const first = store.createProject({ name: "same", rootPath: projectRoot });
      const second = store.createProject({ name: "same", rootPath: projectRoot });
      assert.equal(second.id, first.id);
      assert.equal(second.name, "same");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
