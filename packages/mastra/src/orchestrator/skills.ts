import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Operator-authored procedural skills for the chat agent.
 *
 * A skill is a markdown file under the skills directory:
 *
 *   # <name>
 *
 *   <one-line description>
 *
 *   ## When to use
 *   ...
 *   ## Procedure
 *   ...
 *   ## Pitfalls
 *   ...
 *   ## Verification
 *   ...
 *
 * The chat prompt gets a compact index (name + description) so the agent knows
 * what skills exist without bloating context; the full body is fetched on
 * demand via the get_skill tool.
 */

export interface SkillSummary {
  name: string;
  description: string;
}

function slugifyName(raw: string): string {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "skill"
  );
}

/** Parse a skill markdown file into name + description + body. */
function parseSkill(text: string): {
  name: string;
  description: string;
  body: string;
} | null {
  const lines = text.split(/\r?\n/);
  let name = "";
  let i = 0;
  // First `# ` heading is the name.
  for (; i < lines.length; i++) {
    const m = lines[i]!.match(/^#\s+(.+?)\s*$/);
    if (m) {
      name = slugifyName(m[1]!);
      i += 1;
      break;
    }
  }
  if (!name) return null;
  // Skip blank lines, then the first non-empty paragraph is the description.
  let description = "";
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    if (line.startsWith("## ")) break;
    description = line;
    i += 1;
    break;
  }
  const body = lines.slice(i).join("\n").trim();
  return { name, description, body };
}

/** List all skills (name + description) under the skills directory. */
export function listSkills(skillsDir: string): SkillSummary[] {
  if (!skillsDir || !existsSync(skillsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return [];
  }
  const out: SkillSummary[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".md")) continue;
    try {
      const parsed = parseSkill(readFileSync(join(skillsDir, entry), "utf-8"));
      if (parsed) out.push({ name: parsed.name, description: parsed.description });
    } catch {
      /* skip unreadable skill */
    }
  }
  return out;
}

/** Read a skill's full body by name (slug). Returns null when not found. */
export function readSkill(skillsDir: string, name: string): string | null {
  if (!skillsDir || !existsSync(skillsDir)) return null;
  const target = slugifyName(name);
  let entries: string[];
  try {
    entries = readdirSync(skillsDir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    try {
      const text = readFileSync(join(skillsDir, entry), "utf-8");
      const parsed = parseSkill(text);
      if (parsed && parsed.name === target) {
        return `# ${parsed.name}\n\n${parsed.description}\n\n${parsed.body}`.trim();
      }
    } catch {
      /* skip unreadable skill */
    }
  }
  return null;
}

/** Format the compact skills index for the chat prompt. */
export function formatSkillsIndex(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (s) => `- ${s.name}: ${s.description || "(no description)"}`,
  );
  return `## Skills (procedural how-tos — call get_skill for the full procedure)
${lines.join("\n")}`;
}
