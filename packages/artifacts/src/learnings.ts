import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LearningIndexSchema,
  LearningRecordSchema,
  type LearningKind,
  type LearningRecord,
  type LearningSeverity,
} from "@slopcontrol/types";

const SLOP_DIR = ".slopcontrol";

function slopRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR);
}

export function learningsDir(projectRoot: string): string {
  return join(slopRoot(projectRoot), "learnings");
}

export function learningsIndexPath(projectRoot: string): string {
  return join(learningsDir(projectRoot), "index.json");
}

export function learningsMarkdownPath(projectRoot: string): string {
  return join(slopRoot(projectRoot), "LEARNINGS.md");
}

export type LearningCandidate = {
  kind: LearningKind;
  tags: string[];
  title: string;
  lesson: string;
  evidence?: string;
  severity?: LearningSeverity;
  sourcePhaseId?: string;
  sourceRunId?: string;
};

function ensureLearningsDir(projectRoot: string): void {
  mkdirSync(join(slopRoot(projectRoot), "phases"), { recursive: true });
  mkdirSync(learningsDir(projectRoot), { recursive: true });
}

export function readLearningIndex(projectRoot: string): {
  version: 1;
  learnings: LearningRecord[];
} {
  const path = learningsIndexPath(projectRoot);
  if (!existsSync(path)) {
    return { version: 1, learnings: [] };
  }
  try {
    return LearningIndexSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { version: 1, learnings: [] };
  }
}

function writeLearningIndex(
  projectRoot: string,
  index: { version: 1; learnings: LearningRecord[] },
): void {
  ensureLearningsDir(projectRoot);
  writeFileSync(
    learningsIndexPath(projectRoot),
    JSON.stringify(index, null, 2),
    "utf-8",
  );
  writeLearningsMarkdown(projectRoot, index.learnings);
}

function writeLearningsMarkdown(
  projectRoot: string,
  learnings: LearningRecord[],
): void {
  const sorted = [...learnings].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
  const lines = [
    "# Project learnings",
    "",
    "Durable lessons from prior phases. Injected into research, planning, and development.",
    "",
  ];
  if (sorted.length === 0) {
    lines.push("_No learnings recorded yet._", "");
  } else {
    for (const L of sorted) {
      const block: Array<string | null> = [
        `## ${L.title}`,
        "",
        `- **id:** \`${L.id}\``,
        `- **kind:** ${L.kind} · **severity:** ${L.severity} · **hits:** ${L.hitCount}`,
        `- **tags:** ${L.tags.map((t) => `\`${t}\``).join(", ") || "(none)"}`,
        L.sourcePhaseId ? `- **source phase:** \`${L.sourcePhaseId}\`` : null,
        `- **last seen:** ${L.lastSeenAt}`,
        "",
        L.lesson,
        "",
      ];
      lines.push(...block.filter((l): l is string => l !== null));
    }
  }
  writeFileSync(
    learningsMarkdownPath(projectRoot),
    lines.join("\n"),
    "utf-8",
  );
}

function normalizeTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const raw of tags) {
    const t = raw
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (t) out.add(t);
  }
  return [...out].sort();
}

function tagOverlap(a: string[], b: string[]): number {
  const setB = new Set(b);
  return a.filter((t) => setB.has(t)).length;
}

function learningFingerprint(
  kind: LearningKind,
  tags: string[],
  title: string,
): string {
  return `${kind}|${normalizeTags(tags).slice(0, 6).join(",")}|${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)}`;
}

/**
 * Upsert a durable learning. Matching kind + strong tag/title overlap bumps hitCount.
 */
export function promoteLearning(
  projectRoot: string,
  candidate: LearningCandidate,
): LearningRecord {
  ensureLearningsDir(projectRoot);
  const now = new Date().toISOString();
  const tags = normalizeTags(candidate.tags);
  const index = readLearningIndex(projectRoot);

  const fp = learningFingerprint(candidate.kind, tags, candidate.title);
  const existing = index.learnings.find(
    (L) =>
      learningFingerprint(L.kind, L.tags, L.title) === fp ||
      (L.kind === candidate.kind &&
        tagOverlap(L.tags, tags) >= 2 &&
        L.title === candidate.title),
  );

  if (existing) {
    existing.lastSeenAt = now;
    existing.hitCount += 1;
    existing.tags = normalizeTags([...existing.tags, ...tags]);
    if (candidate.evidence) {
      existing.evidence = candidate.evidence.slice(0, 800);
    }
    if (candidate.sourcePhaseId) existing.sourcePhaseId = candidate.sourcePhaseId;
    if (candidate.sourceRunId) existing.sourceRunId = candidate.sourceRunId;
    if (candidate.severity === "blocker") existing.severity = "blocker";
    existing.lesson = candidate.lesson.trim() || existing.lesson;
    writeLearningIndex(projectRoot, index);
    if (existing.severity === "blocker") {
      appendBlueprintLesson(projectRoot, existing);
    }
    return existing;
  }

  const id = `learn-${now.slice(0, 10).replace(/-/g, "")}-${candidate.kind}-${slugTag(candidate.title)}`;
  const record = LearningRecordSchema.parse({
    id,
    kind: candidate.kind,
    tags,
    title: candidate.title.trim(),
    lesson: candidate.lesson.trim(),
    evidence: candidate.evidence?.slice(0, 800),
    sourcePhaseId: candidate.sourcePhaseId,
    sourceRunId: candidate.sourceRunId,
    severity: candidate.severity ?? "warning",
    createdAt: now,
    lastSeenAt: now,
    hitCount: 1,
  });
  index.learnings.push(record);
  writeLearningIndex(projectRoot, index);
  if (record.severity === "blocker") {
    appendBlueprintLesson(projectRoot, record);
  }
  return record;
}

function slugTag(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "note"
  );
}

/**
 * Score and select learnings relevant to the current phase / failure context.
 */
export function selectLearningsForContext(
  projectRoot: string,
  opts: {
    phaseDescription?: string;
    phaseDoc?: string;
    failureText?: string;
    limit?: number;
  },
): LearningRecord[] {
  const { learnings } = readLearningIndex(projectRoot);
  if (learnings.length === 0) return [];

  const hay = [
    opts.phaseDescription ?? "",
    opts.phaseDoc ?? "",
    opts.failureText ?? "",
  ]
    .join("\n")
    .toLowerCase();

  const tokens = new Set(
    hay
      .split(/[^a-z0-9._-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2),
  );

  const scored = learnings.map((L) => {
    let score = 0;
    if (L.severity === "blocker") score += 10;
    if (L.severity === "warning") score += 3;
    score += Math.min(5, L.hitCount);
    for (const tag of L.tags) {
      if (tokens.has(tag) || hay.includes(tag)) score += 4;
    }
    for (const word of L.title.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && tokens.has(word)) score += 1;
    }
    return { L, score };
  });

  scored.sort(
    (a, b) => b.score - a.score || b.L.lastSeenAt.localeCompare(a.L.lastSeenAt),
  );

  const limit = opts.limit ?? 12;
  const blockers = scored
    .filter((s) => s.L.severity === "blocker")
    .map((s) => s.L);
  const rest = scored
    .filter((s) => s.L.severity !== "blocker" && s.score > 0)
    .map((s) => s.L);

  const out: LearningRecord[] = [];
  const seen = new Set<string>();
  for (const L of [...blockers, ...rest]) {
    if (seen.has(L.id)) continue;
    seen.add(L.id);
    out.push(L);
    if (out.length >= limit) break;
  }
  return out;
}

/** Markdown block for agent prompts. */
export function formatLearningsForPrompt(learnings: LearningRecord[]): string {
  if (learnings.length === 0) return "";
  const parts: string[] = [
    "## Prior learnings (project)",
    "",
    "Constraints from prior phases — obey these; do not re-discover by burning iterations:",
    "",
  ];
  for (const L of learnings) {
    parts.push(`### ${L.title} (\`${L.kind}\` / ${L.severity})`, "", L.lesson, "");
    if (L.tags.length) {
      parts.push(`_tags: ${L.tags.join(", ")}_`, "");
    }
  }
  return parts.join("\n").trim() + "\n";
}

/**
 * Append a short pointer under BLUEPRINT ## Lessons Learned for blocker learnings.
 */
export function appendBlueprintLesson(
  projectRoot: string,
  learning: LearningRecord,
): void {
  const bpPath = join(slopRoot(projectRoot), "BLUEPRINT.md");
  if (!existsSync(bpPath)) return;
  let bp = readFileSync(bpPath, "utf-8");
  const marker = `<!-- learning:${learning.id} -->`;
  if (bp.includes(marker)) return;

  const entry = [
    "",
    `### ${learning.title} ${marker}`,
    "",
    learning.lesson,
    "",
    learning.sourcePhaseId
      ? `_From phase \`${learning.sourcePhaseId}\` (${learning.kind})._`
      : `_Kind: ${learning.kind}._`,
    "",
  ].join("\n");

  if (/^##\s+Lessons Learned\s*$/im.test(bp)) {
    bp = bp.replace(/^(##\s+Lessons Learned\s*)$/im, `$1\n${entry}`);
  } else {
    bp = `${bp.trimEnd()}\n\n## Lessons Learned\n${entry}`;
  }
  writeFileSync(bpPath, bp.endsWith("\n") ? bp : `${bp}\n`, "utf-8");
}

/** Format learnings for prompt injection given phase context. */
export function loadLearningsPromptBlock(
  projectRoot: string,
  opts: {
    phaseDescription?: string;
    phaseDoc?: string;
    failureText?: string;
    limit?: number;
  },
): string {
  ensurePlatformLearnings(projectRoot);
  return formatLearningsForPrompt(selectLearningsForContext(projectRoot, opts));
}

/**
 * Seed durable platform learnings once per project (upsert via promoteLearning).
 * Keeps Ollama OpenAI-compat host/naming rules and compose env_file pitfalls
 * in agent context.
 */
export function ensurePlatformLearnings(projectRoot: string): void {
  promoteLearning(projectRoot, {
    kind: "process",
    severity: "blocker",
    tags: [
      "ollama",
      "openai-compatible",
      "ollama.com",
      "api.ollama.cloud",
      "chat-stream",
      "automated-checks",
    ],
    title: "Ollama OpenAI-compat hosts use different model ID rules",
    lesson: [
      "`https://ollama.com/v1` (OpenAI-compatible) with a paid key typically uses **bare** model IDs (e.g. `glm-5.2`).",
      "`https://api.ollama.cloud/v1` often expects **`:cloud`-suffixed** IDs — do not assume the same naming as ollama.com/v1.",
      "Never reverse a working `OLLAMA_BASE_URL` to `api.ollama.cloud` (or force `:cloud` on paid) without operator-explicit intent",
      "and PHASE Automated Checks that structurally grep the chosen URL/model assignments (no live curls).",
      "`npm test` / model-catalogue-only diffs do **not** prove chat streaming works.",
      "Chat hanging after `[chat] Stream started` with tools enabled often means OpenAI-compat stream+tools fragility or wrong host/ID pairing — fix routing/PHASE, do not switch to free-tier.",
    ].join(" "),
  });

  promoteLearning(projectRoot, {
    kind: "process",
    severity: "blocker",
    tags: [
      "ollama",
      "docker-compose",
      "env_file",
      "OLLAMA_API_KEY",
      "401",
      "unauthorized",
    ],
    title: "Compose ${VAR:-} overrides env_file and can empty OLLAMA_API_KEY",
    lesson: [
      "Docker Compose `environment: VAR: ${VAR:-}` expands from the **host shell / Compose `.env`**, not from `env_file`.",
      "An empty host shell value **overrides** `env_file` and injects an empty string into the container.",
      "Symptom: app container has `OLLAMA_API_KEY` from `.env.docker`, but embedded `ollama` returns **401 Unauthorized** on `:cloud` / OpenAI-compat chat and embed.",
      "Fix: remove host-shell interpolation for that key on `ollama` / `ollama-init`; source `OLLAMA_API_KEY` from `env_file` (same as the app service), then recreate the container.",
      "Do not “fix” by flipping `OLLAMA_TIER=free` in `.env.docker` or rewriting runtime models to pass tests.",
    ].join(" "),
  });

  promoteLearning(projectRoot, {
    kind: "process",
    severity: "blocker",
    tags: [
      "env",
      "placeholder",
      "your-box-ip",
      "ollama",
      "docker",
      "dead-container",
    ],
    title: "Placeholder hosts stay in *.example; purge ollama: fixtures when removing the container",
    lesson: [
      "`.env.example` / `.env.docker.example` may use placeholders like `your-box-ip`.",
      "Runtime `.env.docker` / `.env.local` must use a real host (LAN IP or localhost) — never copy placeholders into gitignored runtime env.",
      "Automated Checks that grep placeholders belong on `*.example` files only.",
      "When PHASE removes embedded `jamjar-ollama`, also purge test fixtures asserting `http://ollama:11434`, `11435:11434`, `ollama-init`, or compose `OLLAMA_TIER: free`.",
      "Never print `OLLAMA_API_KEY` values into APPENDIX or diagnosis evidence.",
    ].join(" "),
  });

  promoteLearning(projectRoot, {
    kind: "process",
    severity: "blocker",
    tags: [
      "vite",
      "alias",
      "automated-checks",
      "tailwind",
      "module-resolve",
      "claim-vs-proof",
    ],
    title: "Vite alias first-match wins; grep ≠ resolve proof",
    lesson: [
      "Vite `resolve.alias` applies the **first matching prefix** — put longer/more-specific entries (e.g. `@pkg/styles`) before shorter prefixes (`@pkg`).",
      "Grep that an alias line exists does **not** prove CSS `@import` / Tailwind resolve works (`@tailwindcss/vite` uses its own resolve path).",
      "When Success Criteria claim no `Can't resolve` / clean Vite CSS load, Automated Checks must include a **finite** proof: `vite build` in the app/playground cwd, or a short Node `resolveId` / `createServer`+close one-shot — never long-lived `pnpm dev`.",
      "Same claim-vs-proof pattern applies elsewhere (chat stream / Ollama routing, engagement fill+submit, DDL migrate, menubar ThemeToggle) — greps for `export function ThemeToggle` alone are insufficient; prove `<ThemeToggle` in shell menubar and `<Menubar` in playground App.",
      "**Mounted ≠ visible:** Tailwind only emits utilities from scanned sources. A ThemeToggle can be in the DOM with missing `text-text-secondary` / `h-9` if playground CSS never `@source`s package `../src`. Prove style emission via `@source` covering the component tree, or `vite build` + grep built `dist/assets/*.css` for those utilities, or a non-utility `var(--text-secondary)` color/size fallback. Import-order-only (`@import \"tailwindcss\"` first) is not a visibility proof.",
    ].join(" "),
  });
}
