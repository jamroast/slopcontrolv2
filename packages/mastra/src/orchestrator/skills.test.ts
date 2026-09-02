import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert";
import { formatSkillsIndex, listSkills, readSkill } from "./skills.js";

function tmpSkills(): string {
  const dir = join(tmpdir(), `slopcontrol-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SKILL = `# extract-design-element

Extract a shared design element from a design loop and verify it ships real source code.

## When to use
- The operator asks to extract a shared design element.

## Procedure
1. list_design_loops with projectId.
2. design_element_extract with explicit loopId + version + elementId.

## Pitfalls
- Do not rely on the chat's design-loop latch.

## Verification
- The result has hasCode: true.
`;

test("listSkills returns name + description for each markdown skill", () => {
  const dir = tmpSkills();
  try {
    writeFileSync(join(dir, "extract-design-element.md"), SKILL, "utf-8");
    writeFileSync(join(dir, "not-a-skill.txt"), "ignore me", "utf-8");
    const skills = listSkills(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.name, "extract-design-element");
    assert.match(skills[0]!.description, /Extract a shared design element/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSkills returns empty for a missing directory", () => {
  assert.deepEqual(listSkills("/nonexistent/skills-dir"), []);
});

test("readSkill returns the full body by name", () => {
  const dir = tmpSkills();
  try {
    writeFileSync(join(dir, "extract-design-element.md"), SKILL, "utf-8");
    const body = readSkill(dir, "extract-design-element");
    assert.ok(body);
    assert.match(body, /## Procedure/);
    assert.match(body, /hasCode: true/);
    assert.equal(readSkill(dir, "does-not-exist"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatSkillsIndex renders a compact index and is empty for no skills", () => {
  assert.equal(formatSkillsIndex([]), "");
  const index = formatSkillsIndex([
    { name: "extract-design-element", description: "Extract a design element." },
  ]);
  assert.match(index, /extract-design-element/);
  assert.match(index, /get_skill/);
});
