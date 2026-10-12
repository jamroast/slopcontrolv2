import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  collectProjectCapabilities,
  dropMustNotEntries,
  dropMustNotLinesFromPhaseDoc,
  mustNotCandidatesFromPhaseDoc,
} from "./project-capabilities.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("project capabilities", () => {
  it("collects route literals and doc files, and drops only exact prohibitions", () => {
    const root = mkdtempSync(join(tmpdir(), "slop-caps-"));
    roots.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(
      join(root, "src", "index.ts"),
      "app.get('/feed.txt', () => 'ok')\napp.post('/items', () => 'ok')\n",
    );
    writeFileSync(join(root, "docs", "feed.txt"), "hello\n");

    const caps = collectProjectCapabilities(root);
    assert.ok(caps.routes.includes("/feed.txt"));
    assert.ok(caps.routes.includes("/items"));
    assert.ok(caps.files.includes("docs/feed.txt"));

    const phase = [
      "# Phase",
      "## Out of scope",
      "- Do not link /feed.txt",
      "- Do not redesign the shell",
      "",
    ].join("\n");
    assert.deepEqual(mustNotCandidatesFromPhaseDoc(phase), [
      "Do not link /feed.txt",
      "Do not redesign the shell",
    ]);
    const next = dropMustNotLinesFromPhaseDoc(phase, ["Do not link /feed.txt"]);
    assert.match(next, /Do not redesign the shell/);
    assert.doesNotMatch(next, /feed\.txt/);
    assert.deepEqual(
      dropMustNotEntries(
        ["Do not link /feed.txt", "Do not redesign the shell"],
        ["Do not link /feed.txt"],
      ),
      ["Do not redesign the shell"],
    );
  });
});
