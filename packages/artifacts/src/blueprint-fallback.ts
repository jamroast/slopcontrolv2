import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectInventory } from "./project-inventory.js";

function bulletList(items: string[], empty = "- N/A (not in repo)"): string {
  if (!items.length) return empty;
  return items.map((i) => `- \`${i}\``).join("\n");
}

function readSnippet(root: string, rel: string, max = 1800): string | null {
  const full = join(root, rel);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf-8").slice(0, max);
  } catch {
    return null;
  }
}

/**
 * Deterministic structured BLUEPRINT when the LLM returns a thin/diagram-only draft.
 * Grounded entirely in buildProjectInventory (+ optional operator notes / LLM draft).
 */
export function synthesizeBlueprintFromInventory(input: {
  inventory: ProjectInventory;
  operatorNotes?: string;
  llmDraft?: string;
}): string {
  const { inventory, operatorNotes, llmDraft } = input;
  const draft = (llmDraft ?? "").trim();
  const architectureExtra =
    draft.length > 80
      ? `\n\n### Agent draft (unstructured; verify against inventory)\n\n\`\`\`\n${draft.slice(0, 6000)}\n\`\`\``
      : "";

  const productIntent = operatorNotes?.trim()
    ? `\n\n### Product intent (operator)\n\n${operatorNotes.trim()}`
    : "";

  const pkg = inventory.packageSummary ?? "N/A (not in repo)";

  return `# Blueprint

## Product summary

Codebase at \`${inventory.rootPath}\`.
Top-level entries: ${inventory.topLevel.slice(0, 40).join(", ") || "(empty)"}.
This document was completed from a deterministic inventory because the agent draft failed the section contract.
${productIntent}

## Architecture

Runtime surface inferred from App Router pages and API routes.

**Pages**
${bulletList(inventory.pages)}

**API routes (live surface)**
${bulletList(inventory.apiRoutes)}

**Must-read entrypoints**
${bulletList(inventory.mustReadPresent)}
${architectureExtra}

## Tech stack

From \`package.json\`:

\`\`\`
${pkg}
\`\`\`

Treat dependencies as *declared*; mark unused/scaffolded packages under Known gaps after verifying imports.

## Modules and key paths

${bulletList(
    [
      ...inventory.mustReadPresent.filter((p) => p.startsWith("src/")),
      ...inventory.pages.slice(0, 20),
      ...inventory.apiRoutes,
    ].filter((v, i, a) => a.indexOf(v) === i),
  )}

Additional tree paths captured: ${inventory.treePaths.length} (see inventory during reverse-engineer).

## Data model

SQL / schema artifacts found:

${bulletList([...inventory.sqlFiles, ...inventory.mustReadPresent.filter((p) => /schema|drizzle/i.test(p))])}

${(() => {
  const schema =
    readSnippet(inventory.rootPath, "src/lib/db/schema.ts") ??
    readSnippet(inventory.rootPath, "docker/init-db.sql");
  if (!schema) return "Open schema/SQL files listed above for tables and enums.";
  return `### Schema / SQL excerpt\n\n\`\`\`\n${schema}\n\`\`\``;
})()}

## Infra and deploy

Docker / compose / SQL:

${bulletList(inventory.dockerFiles.length ? inventory.dockerFiles : inventory.mustReadPresent.filter((p) => /docker|compose|Dockerfile/i.test(p)))}

Env / deploy configs present:

${bulletList(
    inventory.mustReadPresent.filter((p) =>
      /(\.env|vercel\.json|Dockerfile|compose)/i.test(p),
    ),
  )}

${(() => {
  const compose =
    readSnippet(inventory.rootPath, "docker-compose.yml") ??
    readSnippet(inventory.rootPath, "docker-compose.yaml");
  const envEx = readSnippet(inventory.rootPath, ".env.example", 1200);
  const parts: string[] = [];
  if (compose) parts.push(`### docker-compose.yml excerpt\n\n\`\`\`yaml\n${compose}\n\`\`\``);
  if (envEx) parts.push(`### .env.example excerpt\n\n\`\`\`\n${envEx}\n\`\`\``);
  return parts.join("\n\n") || "Read compose/Dockerfile for host ports and services.";
})()}

## Skills / tools / workflows

Likely skill/workflow entrypoints:

${bulletList(
    inventory.mustReadPresent.filter((p) =>
      /(skill|chat-tools|mastra|workflow|runner)/i.test(p),
    ),
  )}

API surfaces related to skills/runs:

${bulletList(
    inventory.apiRoutes.filter((p) =>
      /(skill|run|chat|webhook|cron)/i.test(p),
    ),
  )}

Separate **wired** chat/workflow tools from catalog-only or unused libs in follow-up phases.

## Auth and tenancy

Auth-related files/deps signals:

${bulletList(
    [
      ...inventory.mustReadPresent.filter((p) => /clerk|auth|middleware/i.test(p)),
      ...inventory.treePaths.filter(
        (p) =>
          !p.endsWith("/") &&
          /(clerk|middleware|auth)/i.test(p) &&
          !p.includes("node_modules"),
      ).slice(0, 20),
    ].filter((v, i, a) => a.indexOf(v) === i),
  )}

If Clerk (or similar) appears only as a dependency/wrapper without middleware, document it as present-but-not-enforced.

## Tests and quality gates

${bulletList(
    inventory.treePaths
      .filter(
        (p) =>
          !p.endsWith("/") &&
          (/\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(p) ||
            /vitest|jest|playwright/i.test(p)),
      )
      .slice(0, 40),
  )}

Scripts from package.json (see Tech stack) define quality gates (\`test\`, \`typecheck\`, \`lint\`, \`build\`).

## Known gaps / risks / unused scaffolding

- Agent draft failed structured contract; this blueprint was filled from inventory — deepen via a later open/validate pass.
- Verify declared dependencies that have no imports (e.g. job queues, blob stores, MCP helpers).
- Confirm auth enforcement on API routes.
- Confirm DB init (Docker SQL vs drizzle migrate) matches runtime \`DATABASE_URL\`.

## Proposed Roadmap

| Phase | Title | Status | Depends on |
|-------|-------|--------|------------|
| 01-blueprint-deepen | Deepen BLUEPRINT from must-read files (schema, docker, mastra, chat-tools) | planned | |
| 02-infra-verify | Verify Docker/compose/DB init and document ports/env | planned | 01-blueprint-deepen |
| 03-hot-path-audit | Audit live chat/skills/workflows vs scaffolded code | planned | 01-blueprint-deepen |
| 04-auth-tenancy | Decide and implement auth/tenancy for APIs | planned | 03-hot-path-audit |
`;
}
