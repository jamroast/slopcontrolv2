/**
 * Required ## sections for reverse-engineered / open BLUEPRINT.md documents.
 * Every section must have a non-empty body (or explicit N/A).
 */
export const REQUIRED_BLUEPRINT_SECTIONS = [
  "Product summary",
  "Architecture",
  "Tech stack",
  "Modules and key paths",
  "Data model",
  "Infra and deploy",
  "Skills / tools / workflows",
  "Auth and tenancy",
  "Tests and quality gates",
  "Known gaps / risks / unused scaffolding",
  "Proposed Roadmap",
] as const;

export type RequiredBlueprintSection =
  (typeof REQUIRED_BLUEPRINT_SECTIONS)[number];

export interface BlueprintValidationResult {
  ok: boolean;
  missingHeadings: string[];
  emptySections: string[];
  hasBlueprintHeading: boolean;
  issues: string[];
}

function normalizeHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const SECTION_ALIASES: Record<string, string[]> = {
  "product summary": ["product summary", "summary", "product intent"],
  architecture: ["architecture", "system architecture", "runtime architecture"],
  "tech stack": ["tech stack", "technology stack", "stack"],
  "modules and key paths": [
    "modules and key paths",
    "modules",
    "key modules",
    "key paths",
  ],
  "data model": ["data model", "schema", "database"],
  "infra and deploy": [
    "infra and deploy",
    "infrastructure",
    "infra",
    "deploy",
    "docker",
  ],
  "skills / tools / workflows": [
    "skills / tools / workflows",
    "skills tools workflows",
    "skills",
    "tools and workflows",
    "workflows",
  ],
  "auth and tenancy": ["auth and tenancy", "auth", "authentication", "tenancy"],
  "tests and quality gates": [
    "tests and quality gates",
    "tests",
    "quality gates",
  ],
  "known gaps / risks / unused scaffolding": [
    "known gaps / risks / unused scaffolding",
    "known gaps",
    "known issues",
    "risks",
    "unused scaffolding",
    "gaps",
  ],
  "proposed roadmap": ["proposed roadmap", "roadmap"],
};

function aliasesFor(required: string): string[] {
  const key = normalizeHeading(required);
  return SECTION_ALIASES[key] ?? [key];
}

function parseH2Sections(
  markdown: string,
): Array<{ title: string; body: string }> {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections: Array<{ title: string; body: string }> = [];
  let currentTitle: string | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (currentTitle == null) return;
    sections.push({ title: currentTitle, body: bodyLines.join("\n").trim() });
    currentTitle = null;
    bodyLines = [];
  };

  for (const line of lines) {
    const match = line.match(/^##\s+(.+?)\s*$/);
    if (match) {
      flush();
      currentTitle = match[1]!.trim();
      continue;
    }
    if (currentTitle != null) bodyLines.push(line);
  }
  flush();
  return sections;
}

function bodyLooksEmpty(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  // Explicit N/A is allowed
  if (/^n\/a\b/i.test(trimmed)) return false;
  // Diagram-only or placeholder lines
  if (/^TODO\b/i.test(trimmed) && trimmed.length < 40) return true;
  // Require some substance: at least ~40 chars or a table/list/code block
  if (trimmed.length >= 40) return false;
  if (/^\|/.test(trimmed) || /^[-*`]/.test(trimmed) || /```/.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Validate that a blueprint document has the required structure and non-empty sections.
 */
export function validateBlueprintDocument(
  markdown: string,
): BlueprintValidationResult {
  const text = markdown.replace(/\r\n/g, "\n").trim();
  const hasBlueprintHeading = /^#\s+Blueprint\b/im.test(text);
  const sections = parseH2Sections(text);
  const byNorm = new Map(
    sections.map((s) => [normalizeHeading(s.title), s] as const),
  );

  const missingHeadings: string[] = [];
  const emptySections: string[] = [];

  for (const required of REQUIRED_BLUEPRINT_SECTIONS) {
    const aliases = aliasesFor(required);
    let found: { title: string; body: string } | undefined;
    for (const alias of aliases) {
      const hit = byNorm.get(normalizeHeading(alias));
      if (hit) {
        found = hit;
        break;
      }
    }
    // Also fuzzy: any section whose normalized title includes the alias
    if (!found) {
      for (const [norm, sec] of byNorm) {
        if (aliases.some((a) => norm.includes(normalizeHeading(a)))) {
          found = sec;
          break;
        }
      }
    }

    if (!found) {
      missingHeadings.push(required);
      continue;
    }
    if (bodyLooksEmpty(found.body)) {
      emptySections.push(required);
    }
  }

  const issues: string[] = [];
  if (!hasBlueprintHeading) {
    issues.push('Missing top-level "# Blueprint" heading');
  }
  if (missingHeadings.length) {
    issues.push(`Missing sections: ${missingHeadings.join(", ")}`);
  }
  if (emptySections.length) {
    issues.push(`Empty/thin sections: ${emptySections.join(", ")}`);
  }

  // Reject diagram-only documents (no ## headings at all)
  if (sections.length === 0) {
    issues.push("No ## sections found — document is not structured");
  }

  return {
    ok: issues.length === 0,
    missingHeadings,
    emptySections,
    hasBlueprintHeading,
    issues,
  };
}

/** Prompt fragment listing required sections for the blueprint agent. */
export function blueprintContractPromptBlock(): string {
  const list = REQUIRED_BLUEPRINT_SECTIONS.map((s) => `- ## ${s}`).join("\n");
  return `Required BLUEPRINT structure (every ## section MUST have a non-empty body, or explicitly "N/A (not in repo)"):
${list}

Rules:
- Start with "# Blueprint"
- Diagrams are allowed INSIDE Architecture, never as the entire document
- Separate live/wired hot path from scaffolded/unused code
- Include ## Proposed Roadmap as a markdown table with Phase | Title | Status | Depends on (01-slug ids)
- End with BLUEPRINT_COMPLETE on its own line`;
}
