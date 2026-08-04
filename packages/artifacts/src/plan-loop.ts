/**
 * Plan-loop: chat-driven versioned PLAN.md (parallel to design-loop).
 * Artifacts under `.slopcontrol/plan-loops/<id>/`.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const requirePlanPack = createRequire(import.meta.url);
const SLOP_DIR = ".slopcontrol";

export type PlanLoopStatus = "open" | "accepted" | "promoted";

export type PlanLoopLastError = {
  version: number;
  reason: string;
  at: string;
};

export type PlanScopeKind =
  | "feature"
  | "bugfix"
  | "refactor"
  | "integration"
  | "spike";

export type PlanScope = {
  kind: PlanScopeKind;
  focus: string;
  preserve: string[];
  source: "start" | "continue" | "accept" | "manual";
};

export type PlanLoopMeta = {
  id: string;
  projectId: string;
  brief: string;
  status: PlanLoopStatus;
  phaseId?: string;
  askId?: string;
  currentVersion: number;
  acceptedVersion?: number;
  lastError?: PlanLoopLastError;
  scope?: PlanScope;
  createdAt: string;
  updatedAt: string;
};

export type PlanLoopVersionStatus = "active" | "invalid";

export type PlanLoopVersionMeta = {
  version: number;
  parentVersion: number | null;
  status: PlanLoopVersionStatus;
  invalidReason?: string;
  invalidatedAt?: string;
  usedScaffold: boolean;
  error?: string;
  updatedAt: string;
};

export type PlanLoopAcceptanceFeature = {
  id: string;
  label: string;
  accepted: boolean;
};

export type PlanLoopAcceptance = {
  version: number;
  features: PlanLoopAcceptanceFeature[];
  acceptedAt?: string;
  updatedAt?: string;
};

export const PLAN_REQUIRED_SECTIONS = [
  "Goal",
  "Constraints",
  "In scope",
  "Out of scope",
  "Approach",
  "Likely areas",
  "Success criteria",
  "Risks & open questions",
  "Handoff notes",
] as const;

export const PLAN_LOOP_FALLBACK_FEATURES: PlanLoopAcceptanceFeature[] = [
  { id: "goal", label: "Goal & constraints locked", accepted: false },
  { id: "scope", label: "In/out of scope locked", accepted: false },
  { id: "approach", label: "Approach accepted", accepted: false },
  { id: "areas", label: "Likely areas good enough to research", accepted: false },
  { id: "success", label: "Success criteria clear", accepted: false },
  { id: "risks", label: "Open questions acknowledged", accepted: false },
];

export function planLoopsRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR, "plan-loops");
}

export function planLoopDir(projectRoot: string, loopId: string): string {
  return join(planLoopsRoot(projectRoot), loopId);
}

export function planLoopVersionDir(
  projectRoot: string,
  loopId: string,
  version: number,
): string {
  return join(planLoopDir(projectRoot, loopId), `v${version}`);
}

export function ensurePlanLoopDir(projectRoot: string, loopId: string): string {
  mkdirSync(join(projectRoot, SLOP_DIR), { recursive: true });
  const dir = planLoopDir(projectRoot, loopId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function planLoopMetaPath(projectRoot: string, loopId: string): string {
  return join(planLoopDir(projectRoot, loopId), "META.json");
}

export function planLoopTranscriptPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(planLoopDir(projectRoot, loopId), "TRANSCRIPT.md");
}

export function planLoopAcceptancePath(
  projectRoot: string,
  loopId: string,
): string {
  return join(planLoopDir(projectRoot, loopId), "ACCEPTANCE.json");
}

/** Short Goal / title text from a long operator brief (never paste the dump). */
export function summarizeBriefForGoal(brief: string, maxChars = 240): string {
  const t = (brief ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "(Define goal)";
  const sentence = t.match(/^(.{12,}?[.!?])(?:\s|$)/)?.[1]?.trim();
  const base = sentence && sentence.length <= maxChars ? sentence : t;
  if (base.length <= maxChars) return base;
  return `${base.slice(0, maxChars - 1).trim()}…`;
}

export function defaultPlanScope(
  brief: string,
  source: PlanScope["source"] = "start",
): PlanScope {
  // Ignore "not only …" so vision lists do not trigger narrow preserve.
  const t = (brief ?? "").replace(/\bnot\s+only\b/gi, " ");
  let kind: PlanScopeKind = "feature";
  if (/\b(bug|fix|regress|broken)\b/i.test(t)) kind = "bugfix";
  else if (/\b(refactor|cleanup|debt)\b/i.test(t)) kind = "refactor";
  else if (/\b(spike|explore|prototype|poc|investigate|research\s+this)\b/i.test(t))
    kind = "spike";
  else if (/\b(integrat|wire|connect|api)\b/i.test(t)) kind = "integration";

  let focus = "change";
  // Prefer primary product cues over incidental vision nouns (invoice/crm/…).
  if (/\bfirst\s+component\b/i.test(t) || /\bchat\b/i.test(t)) {
    focus = "chat";
  } else if (/\btheme(-toggle)?\b/i.test(t)) {
    focus = "theme";
  } else {
    const focusOn = t.match(/\bfocus\s+on\b.{0,40}\b([a-z0-9._/-]{3,40})\b/i);
    if (focusOn?.[1]) {
      focus = focusOn[1].toLowerCase();
    } else {
      const only = t.match(
        /\b(?:only|just)\b.{0,40}\b([a-z0-9._/-]{3,40})\b/i,
      );
      if (only?.[1] && !/^(workflows?|management|projects?)$/i.test(only[1])) {
        focus = only[1].toLowerCase();
      } else {
        const region = t.match(
          /\b(chat\.?composer|composer|theme|menubar|dashboard|auth)\b/i,
        );
        if (region?.[1]) focus = region[1].toLowerCase().replace(/\s+/g, ".");
      }
    }
  }

  const preserve: string[] = [];
  // Genuine narrowing only — not "not only" (already stripped) and not investigate dumps.
  if (
    /\b(narrow|shrink)\b/i.test(t) ||
    (/\b(?:only|just)\b.{0,40}\b(this|that|the)\b/i.test(t) &&
      !/\binvestigate|research\s+this|first\s+component|present.+plan/i.test(
        brief ?? "",
      ))
  ) {
    preserve.push("unrelated modules", "brand", "shell");
  }

  return { kind, focus, preserve, source };
}

export function createPlanLoopMeta(opts: {
  projectId: string;
  brief: string;
  phaseId?: string;
  askId?: string;
  scope?: PlanScope;
}): PlanLoopMeta {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId: opts.projectId,
    brief: opts.brief.trim(),
    status: "open",
    phaseId: opts.phaseId,
    askId: opts.askId,
    currentVersion: 0,
    scope: opts.scope ?? defaultPlanScope(opts.brief, "start"),
    createdAt: now,
    updatedAt: now,
  };
}

export function writePlanLoopMeta(
  projectRoot: string,
  meta: PlanLoopMeta,
): void {
  ensurePlanLoopDir(projectRoot, meta.id);
  writeFileSync(
    planLoopMetaPath(projectRoot, meta.id),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf-8",
  );
}

export function readPlanLoopMeta(
  projectRoot: string,
  loopId: string,
): PlanLoopMeta | null {
  const path = planLoopMetaPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PlanLoopMeta;
  } catch {
    return null;
  }
}

export function listPlanLoops(projectRoot: string): PlanLoopMeta[] {
  const root = planLoopsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out: PlanLoopMeta[] = [];
  for (const name of readdirSync(root)) {
    if (name.startsWith(".")) continue;
    const meta = readPlanLoopMeta(projectRoot, name);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function appendPlanLoopTranscript(
  projectRoot: string,
  loopId: string,
  role: "user" | "assistant",
  content: string,
): void {
  ensurePlanLoopDir(projectRoot, loopId);
  const path = planLoopTranscriptPath(projectRoot, loopId);
  const at = new Date().toISOString();
  const label = role === "user" ? "User" : "Assistant";
  const block = `### ${label} (${at})\n\n${content.trim()}\n\n`;
  if (!existsSync(path)) {
    writeFileSync(
      path,
      `# Plan loop — ${loopId}\n\n## Transcript\n\n${block}`,
      "utf-8",
    );
    return;
  }
  writeFileSync(path, readFileSync(path, "utf-8") + block, "utf-8");
}

export function readPlanLoopTranscript(
  projectRoot: string,
  loopId: string,
): string {
  const path = planLoopTranscriptPath(projectRoot, loopId);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf-8");
}

export function writePlanLoopVersion(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  plan: string;
  notes?: string;
  request?: string;
  usedScaffold?: boolean;
  error?: string;
  parentVersion?: number | null;
  clearInvalid?: boolean;
}): {
  planPath: string;
  notesPath: string;
  requestPath: string;
  metaPath: string;
} {
  const dir = planLoopVersionDir(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  mkdirSync(dir, { recursive: true });
  const planPath = join(dir, "PLAN.md");
  const notesPath = join(dir, "NOTES.md");
  const requestPath = join(dir, "REQUEST.md");
  const metaPath = join(dir, "META.json");
  writeFileSync(planPath, `${opts.plan.trim()}\n`, "utf-8");
  writeFileSync(
    notesPath,
    `# Plan loop v${opts.version}\n\n${(opts.notes ?? "").trim() || "(no notes)"}\n`,
    "utf-8",
  );
  if (opts.request !== undefined) {
    writeFileSync(requestPath, `${opts.request.trim()}\n`, "utf-8");
  }
  const prior = readPlanLoopVersionMeta(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  const parentVersion =
    opts.parentVersion !== undefined
      ? opts.parentVersion
      : prior?.parentVersion !== undefined
        ? prior.parentVersion
        : opts.version <= 1
          ? null
          : opts.version - 1;
  const clearInvalid = opts.clearInvalid !== false;
  const versionMeta: PlanLoopVersionMeta = {
    version: opts.version,
    parentVersion,
    status: clearInvalid ? "active" : (prior?.status ?? "active"),
    usedScaffold: Boolean(opts.usedScaffold),
    error: opts.error,
    updatedAt: new Date().toISOString(),
  };
  if (!clearInvalid && prior?.status === "invalid") {
    if (prior.invalidReason) versionMeta.invalidReason = prior.invalidReason;
    if (prior.invalidatedAt) versionMeta.invalidatedAt = prior.invalidatedAt;
  }
  writeFileSync(metaPath, `${JSON.stringify(versionMeta, null, 2)}\n`, "utf-8");
  return { planPath, notesPath, requestPath, metaPath };
}

export function readPlanLoopPlanMd(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    planLoopVersionDir(projectRoot, loopId, version),
    "PLAN.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readPlanLoopNotes(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    planLoopVersionDir(projectRoot, loopId, version),
    "NOTES.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readPlanLoopRequest(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    planLoopVersionDir(projectRoot, loopId, version),
    "REQUEST.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readPlanLoopVersionMeta(
  projectRoot: string,
  loopId: string,
  version: number,
): PlanLoopVersionMeta | null {
  const path = join(
    planLoopVersionDir(projectRoot, loopId, version),
    "META.json",
  );
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PlanLoopVersionMeta;
  } catch {
    return null;
  }
}

export function planLoopVersionExists(
  projectRoot: string,
  loopId: string,
  version: number,
): boolean {
  return existsSync(
    join(planLoopVersionDir(projectRoot, loopId, version), "PLAN.md"),
  );
}

export function allocateNextPlanLoopVersion(
  projectRoot: string,
  loopId: string,
): number {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  let next = (meta?.currentVersion ?? 0) + 1;
  while (planLoopVersionExists(projectRoot, loopId, next)) next += 1;
  return next;
}

export function resolvePlanLoopTip(
  projectRoot: string,
  loopId: string,
): number {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  return meta?.currentVersion && meta.currentVersion > 0
    ? meta.currentVersion
    : 0;
}

export function setPlanLoopLastError(
  projectRoot: string,
  loopId: string,
  error: PlanLoopLastError | null,
): PlanLoopMeta | null {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  if (!meta) return null;
  const next: PlanLoopMeta = {
    ...meta,
    lastError: error ?? undefined,
    updatedAt: new Date().toISOString(),
  };
  if (!error) delete next.lastError;
  writePlanLoopMeta(projectRoot, next);
  return next;
}

/** Extract PLAN.md from agent output (fenced or raw heading). */
export function extractPlanDocument(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim() && /##\s*Goal/i.test(fenced[1])) {
    return fenced[1].trim();
  }
  const start = trimmed.search(/^#\s+/m);
  if (start >= 0) {
    let body = trimmed.slice(start);
    body = body.replace(/\nPLAN_COMPLETE\s*$/i, "").trim();
    if (/##\s*Goal/i.test(body)) return body;
  }
  // Whole text if it looks like a plan
  if (/##\s*Goal/i.test(trimmed) && /##\s*In scope/i.test(trimmed)) {
    return trimmed.replace(/\nPLAN_COMPLETE\s*$/i, "").trim();
  }
  return null;
}

export type PlanSectionValidation = {
  ok: boolean;
  missing: string[];
  empty: string[];
};

/** Validate required H2 sections exist and are non-empty. */
export function validatePlanDocument(plan: string): PlanSectionValidation {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const title of PLAN_REQUIRED_SECTIONS) {
    const re = new RegExp(
      `^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
      "im",
    );
    if (!re.test(plan)) {
      missing.push(title);
      continue;
    }
    const body = extractPlanSection(plan, title);
    if (!body || body.replace(/[-*]\s*\(none\)/gi, "").trim().length < 3) {
      empty.push(title);
    }
  }
  return {
    ok: missing.length === 0 && empty.length === 0,
    missing,
    empty,
  };
}

const PLAN_SECTION_STUB = "- (to research)";

/**
 * Fill missing/empty required H2 sections from prior plan or stubs.
 * Prefer incoming content; never discard a substantively new Goal/In scope.
 */
export function mergePlanDocumentSections(opts: {
  incoming: string;
  prior?: string | null;
  title?: string;
}): { plan: string; filledFromPrior: string[]; filledStub: string[] } {
  const incoming = (opts.incoming ?? "").trim();
  const prior = (opts.prior ?? "").trim();
  const filledFromPrior: string[] = [];
  const filledStub: string[] = [];

  const titleLine =
    incoming.match(/^#\s+.+$/m)?.[0] ||
    prior.match(/^#\s+.+$/m)?.[0] ||
    `# Plan — ${opts.title?.trim().slice(0, 80) || "change"}`;

  const bodies: Record<string, string> = {};
  for (const title of PLAN_REQUIRED_SECTIONS) {
    const fromIncoming = extractPlanSection(incoming, title);
    const incomingOk =
      fromIncoming &&
      fromIncoming.replace(/[-*]\s*\(none\)/gi, "").trim().length >= 3;
    if (incomingOk) {
      bodies[title] = fromIncoming!.trim();
      continue;
    }
    const fromPrior = extractPlanSection(prior, title);
    const priorOk =
      fromPrior &&
      fromPrior.replace(/[-*]\s*\(none\)/gi, "").trim().length >= 3;
    if (priorOk) {
      bodies[title] = fromPrior!.trim();
      filledFromPrior.push(title);
      continue;
    }
    bodies[title] = PLAN_SECTION_STUB;
    filledStub.push(title);
  }

  const plan = [
    titleLine,
    "",
    ...PLAN_REQUIRED_SECTIONS.flatMap((title) => [
      `## ${title}`,
      "",
      bodies[title] ?? PLAN_SECTION_STUB,
      "",
    ]),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { plan: `${plan}\n`, filledFromPrior, filledStub };
}

/** True when extracted plan is worth merging (not empty noise). */
export function planDocumentWorthMerging(plan: string): boolean {
  const p = (plan ?? "").trim();
  if (!p || !/^#\s+/m.test(p)) return false;
  return (
    /##\s*Goal/i.test(p) ||
    /##\s*In scope/i.test(p) ||
    /##\s*Approach/i.test(p)
  );
}

export function extractPlanSection(
  plan: string,
  title: string,
): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Next H2 or end of string (JS has no \Z). Strip trailing PLAN_COMPLETE.
  const re = new RegExp(
    `^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`,
    "im",
  );
  const m = plan.match(re);
  if (!m?.[1]) return null;
  return m[1]
    .replace(/\nPLAN_COMPLETE\s*$/i, "")
    .replace(/^PLAN_COMPLETE\s*$/im, "")
    .trim();
}

export function extractPlanBulletLines(section: string | null): string[] {
  if (!section?.trim()) return [];
  const out: string[] = [];
  for (const line of section.split(/\n+/)) {
    const m = line.match(/^\s*[-*]\s+(.+)/);
    if (m?.[1]) out.push(m[1].trim());
  }
  return out.slice(0, 40);
}

export function scaffoldPlanDocument(opts: {
  brief: string;
  scope?: PlanScope | null;
  errorDetail?: string;
}): string {
  // On generation failure, avoid poisoned focus (e.g. incidental "invoice").
  const focus = opts.errorDetail
    ? "change"
    : (opts.scope?.focus ?? "change");
  const kind = opts.errorDetail
    ? "feature"
    : (opts.scope?.kind ?? "feature");
  const goal = summarizeBriefForGoal(opts.brief);
  const title = goal.slice(0, 80) || focus;
  const note = opts.errorDetail
    ? `\n\n_Scaffold — generation failed: ${opts.errorDetail.slice(0, 200)}_`
    : "";
  const preserve =
    opts.errorDetail || !opts.scope?.preserve?.length
      ? ["Unrelated product areas"]
      : opts.scope.preserve;
  return `# Plan — ${title}

## Goal

${goal}${note}

## Constraints

- Prefer existing project patterns and \`.slopcontrol\` contracts
- Do not expand past focus: ${focus} (${kind})

## In scope

- ${focus}

## Out of scope

${preserve.map((p) => `- ${p}`).join("\n")}

## Approach

1. Research current code for ${focus}
2. Implement the smallest change that meets success criteria
3. Verify with automated checks

## Likely areas

- (research to confirm)

## Success criteria

- Operator goal for ${focus} is met and verified

## Risks & open questions

- Confirm exact file mounts and edge cases in research

## Handoff notes

- Researcher must not reinterpret Goal or Out of scope

PLAN_COMPLETE
`;
}

/**
 * Explicit failure tip when the agent returns empty on start (no prior plan).
 * Does not invent invoice/crm-scoped implementation steps.
 */
export function failurePlanDocument(opts: {
  brief: string;
  errorDetail?: string;
}): string {
  const goal = summarizeBriefForGoal(opts.brief);
  const detail = (opts.errorDetail ?? "empty agent plan").slice(0, 200);
  return `# Plan — ${goal.slice(0, 80)}

## Goal

${goal}

_Generation failed: ${detail}. Call \`plan_loop_retry\` (or continue with a shorter brief)._

## Constraints

- Prefer existing project patterns and \`.slopcontrol\` contracts
- Do not invent architecture without sibling/code evidence

## In scope

- (undefined until a successful generate — retry required)

## Out of scope

- Speculative implementation without investigation

## Approach

1. Retry plan generation (\`plan_loop_retry\`)
2. Ensure planning LLM is up; shorten the brief if needed
3. When SIBLING INVESTIGATION is present, the agent must read those paths before planning

## Likely areas

- (generation failed — retry)

## Success criteria

- A non-scaffold PLAN.md with concrete Likely areas citing real paths

## Risks & open questions

- Prior turn returned no extractable PLAN.md (${detail})

## Handoff notes

- Do not promote this failure document; retry until usedScaffold is false

PLAN_COMPLETE
`;
}

/** True when PLAN.md is a generation failure / scaffold stub (must not accept or promote). */
export function isPlanLoopFailureOrScaffoldDocument(plan: string): boolean {
  const text = plan ?? "";
  return (
    /_Generation failed:/i.test(text) ||
    /_Scaffold —/i.test(text) ||
    /empty agent plan after repair/i.test(text) ||
    /\(undefined until a successful generate/i.test(text) ||
    /Do not promote this failure document/i.test(text) ||
    /\(generation failed — retry\)/i.test(text) ||
    /retry until usedScaffold is false/i.test(text)
  );
}

export const PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR =
  "usedScaffold / failure plan — call plan_loop_retry";

/**
 * Reject accept/promote when version META.usedScaffold or PLAN.md is a failure stub.
 */
export function assertPlanLoopVersionAcceptable(
  projectRoot: string,
  loopId: string,
  version: number,
): void {
  const vm = readPlanLoopVersionMeta(projectRoot, loopId, version);
  if (vm?.usedScaffold) {
    throw new Error(PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR);
  }
  const plan = readPlanLoopPlanMd(projectRoot, loopId, version);
  if (!plan?.trim()) {
    throw new Error(`PLAN.md missing for v${version}`);
  }
  if (isPlanLoopFailureOrScaffoldDocument(plan)) {
    throw new Error(PLAN_LOOP_SCAFFOLD_ACCEPT_ERROR);
  }
}

export function readPlanLoopAcceptance(
  projectRoot: string,
  loopId: string,
): PlanLoopAcceptance | null {
  const path = planLoopAcceptancePath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as PlanLoopAcceptance;
    if (!raw || !Array.isArray(raw.features)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function writePlanLoopAcceptance(
  projectRoot: string,
  loopId: string,
  acceptance: PlanLoopAcceptance,
): void {
  ensurePlanLoopDir(projectRoot, loopId);
  writeFileSync(
    planLoopAcceptancePath(projectRoot, loopId),
    `${JSON.stringify(
      { ...acceptance, updatedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

/**
 * Clear all acceptance ticks (keep feature ids/labels) — used when continue
 * intent is expand_scope / full_revise so prior kitchen-sink locks do not fight.
 */
export function clearPlanLoopAcceptanceLocks(opts: {
  projectRoot: string;
  loopId: string;
  version?: number;
}): PlanLoopAcceptance {
  const prior = readPlanLoopAcceptance(opts.projectRoot, opts.loopId);
  const meta = readPlanLoopMeta(opts.projectRoot, opts.loopId);
  const version =
    opts.version ?? prior?.version ?? meta?.currentVersion ?? 1;
  const baseFeatures =
    prior?.features?.length
      ? prior.features
      : PLAN_LOOP_FALLBACK_FEATURES.map((f) => ({ ...f }));
  const acceptance: PlanLoopAcceptance = {
    version,
    features: baseFeatures.map((f) => ({ ...f, accepted: false })),
    acceptedAt: undefined,
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopAcceptance(opts.projectRoot, opts.loopId, acceptance);
  return acceptance;
}

export function seedPlanLoopAcceptance(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
}): PlanLoopAcceptance {
  const prior = readPlanLoopAcceptance(opts.projectRoot, opts.loopId);
  const priorMap = new Map((prior?.features ?? []).map((f) => [f.id, f.accepted]));
  const features = PLAN_LOOP_FALLBACK_FEATURES.map((f) => ({
    ...f,
    accepted: priorMap.has(f.id) ? Boolean(priorMap.get(f.id)) : false,
  }));
  for (const f of prior?.features ?? []) {
    if (features.some((x) => x.id === f.id)) continue;
    features.push({ ...f });
  }
  const acceptance: PlanLoopAcceptance = {
    version: opts.version,
    features,
    acceptedAt: prior?.acceptedAt,
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopAcceptance(opts.projectRoot, opts.loopId, acceptance);
  return acceptance;
}

export function applyPlanAcceptanceTicks(opts: {
  features: PlanLoopAcceptanceFeature[];
  nextFeatures?: PlanLoopAcceptanceFeature[];
  acceptedFeatureIds?: string[];
}): PlanLoopAcceptanceFeature[] {
  if (opts.nextFeatures && opts.nextFeatures.length > 0) {
    return opts.nextFeatures.map((f) => ({
      id: String(f.id).trim(),
      label: String(f.label ?? f.id).trim() || String(f.id),
      accepted: Boolean(f.accepted),
    }));
  }
  const accepted = new Set(
    (opts.acceptedFeatureIds ?? []).map((id) => String(id).trim()).filter(Boolean),
  );
  if (accepted.size === 0) {
    return opts.features.map((f) => ({ ...f }));
  }
  return opts.features.map((f) => ({
    ...f,
    accepted: accepted.has(f.id),
  }));
}

export function countAcceptedPlanFeatures(
  features: PlanLoopAcceptanceFeature[],
): number {
  return features.filter((f) => f.accepted).length;
}

export function formatPlanAcceptancePromptBlock(
  acceptance: PlanLoopAcceptance | null | undefined,
): string {
  if (!acceptance?.features?.length) return "";
  const lines = ["Plan acceptance checklist:"];
  for (const f of acceptance.features) {
    lines.push(`- [${f.accepted ? "x" : " "}] **${f.id}**: ${f.label}`);
  }
  return lines.join("\n");
}

export function reopenPlanLoopForIterate(
  projectRoot: string,
  loopId: string,
): PlanLoopMeta {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Plan loop not found: ${loopId}`);
  if (meta.status === "open") return meta;
  const next: PlanLoopMeta = {
    ...meta,
    status: "open",
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopMeta(projectRoot, next);
  return next;
}

export function acceptPlanLoop(
  projectRoot: string,
  loopId: string,
  version?: number,
  featureTicks?: {
    features?: PlanLoopAcceptanceFeature[];
    acceptedFeatureIds?: string[];
  },
): PlanLoopMeta {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Plan loop not found: ${loopId}`);
  if (meta.status === "promoted") {
    throw new Error(
      `Plan loop already promoted: ${loopId}. Call plan_loop_continue to reopen and iterate, then accept again.`,
    );
  }
  const v = version ?? meta.currentVersion;
  if (!planLoopVersionExists(projectRoot, loopId, v)) {
    throw new Error(`Plan version v${v} missing for loop ${loopId}`);
  }
  assertPlanLoopVersionAcceptable(projectRoot, loopId, v);
  const plan = readPlanLoopPlanMd(projectRoot, loopId, v);
  if (!plan?.trim()) throw new Error(`PLAN.md missing for v${v}`);
  const validation = validatePlanDocument(plan);
  if (!validation.ok) {
    throw new Error(
      `Cannot accept incomplete plan — missing: [${validation.missing.join(", ")}] empty: [${validation.empty.join(", ")}]`,
    );
  }

  let acceptance =
    readPlanLoopAcceptance(projectRoot, loopId) ??
    seedPlanLoopAcceptance({ projectRoot, loopId, version: v });

  const features = applyPlanAcceptanceTicks({
    features: acceptance.features,
    nextFeatures: featureTicks?.features,
    acceptedFeatureIds: featureTicks?.acceptedFeatureIds,
  });
  if (countAcceptedPlanFeatures(features) < 1) {
    throw new Error(
      "Accept requires at least one ticked feature (goal, scope, success, …)",
    );
  }
  const now = new Date().toISOString();
  acceptance = {
    version: v,
    features,
    acceptedAt: now,
    updatedAt: now,
  };
  writePlanLoopAcceptance(projectRoot, loopId, acceptance);

  const next: PlanLoopMeta = {
    ...meta,
    status: "accepted",
    acceptedVersion: v,
    scope: meta.scope
      ? { ...meta.scope, source: "accept" }
      : defaultPlanScope(meta.brief, "accept"),
    updatedAt: now,
  };
  writePlanLoopMeta(projectRoot, next);

  try {
    const { compileAndWritePlanPackOnAccept } = requirePlanPack(
      "./plan-pack.js",
    ) as typeof import("./plan-pack.js");
    compileAndWritePlanPackOnAccept({
      projectRoot,
      loopId,
      version: v,
      acceptance,
    });
  } catch {
    /* accept succeeds even if pack compile fails */
  }
  return next;
}

/**
 * Copy accepted plan into phase plan/, mark loop promoted.
 */
export function bindAcceptedPlanLoopToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): {
  meta: PlanLoopMeta;
  version: number;
  planPath: string;
} {
  const meta = readPlanLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Plan loop not found: ${opts.loopId}`);
  if (meta.status !== "accepted" && meta.status !== "promoted") {
    throw new Error(
      `Plan loop must be accepted before promote (status=${meta.status})`,
    );
  }
  const version = meta.acceptedVersion ?? meta.currentVersion;
  assertPlanLoopVersionAcceptable(opts.projectRoot, opts.loopId, version);
  const plan = readPlanLoopPlanMd(opts.projectRoot, opts.loopId, version);
  if (!plan?.trim()) {
    throw new Error(`Accepted plan missing for loop ${opts.loopId} v${version}`);
  }
  const acceptance = readPlanLoopAcceptance(opts.projectRoot, opts.loopId);
  if (
    !acceptance?.features?.length ||
    countAcceptedPlanFeatures(acceptance.features) < 1
  ) {
    throw new Error(
      `Plan loop ${opts.loopId} has no accepted features — call plan_loop_accept with ticks`,
    );
  }

  const planDir = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "plan",
  );
  mkdirSync(planDir, { recursive: true });
  const planPath = join(planDir, "PLAN.md");
  writeFileSync(planPath, `${plan.trim()}\n`, "utf-8");
  writeFileSync(
    join(planDir, "ACCEPTANCE.json"),
    `${JSON.stringify(acceptance, null, 2)}\n`,
    "utf-8",
  );

  try {
    const { copyPlanPackToPhase, compileAndWritePlanPackOnAccept } =
      requirePlanPack("./plan-pack.js") as typeof import("./plan-pack.js");
    if (
      !existsSync(join(planLoopDir(opts.projectRoot, opts.loopId), "PLAN_PACK.json"))
    ) {
      compileAndWritePlanPackOnAccept({
        projectRoot: opts.projectRoot,
        loopId: opts.loopId,
        version,
        acceptance,
      });
    }
    copyPlanPackToPhase({
      projectRoot: opts.projectRoot,
      loopId: opts.loopId,
      phaseId: opts.phaseId,
    });
  } catch {
    /* bind still succeeds */
  }

  const next: PlanLoopMeta = {
    ...meta,
    status: "promoted",
    phaseId: opts.phaseId,
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopMeta(opts.projectRoot, next);

  return { meta: next, version, planPath };
}

export function formatPlanLoopReviseBlock(opts: {
  previousPlan: string;
  maxChars?: number;
}): string {
  const max = opts.maxChars ?? 12_000;
  const plan = opts.previousPlan.trim();
  const clipped =
    plan.length <= max
      ? plan
      : `${plan.slice(0, max)}\n\n…[truncated prior PLAN.md]`;
  return [
    "Previous plan (revise this — do not start from scratch unless asked):",
    "",
    "```markdown",
    clipped,
    "```",
  ].join("\n");
}

export function resolvePlanLoopGenerateFallback(opts: {
  brief: string;
  previousPlan?: string | null;
  errorDetail?: string;
  scope?: PlanScope | null;
}): { plan: string; notes: string; usedScaffold: boolean } {
  if (opts.previousPlan?.trim()) {
    return {
      plan: opts.previousPlan.trim(),
      notes: `Agent returned empty plan; prior kept. Call plan_loop_retry. (${opts.errorDetail ?? "unknown"})`,
      usedScaffold: true,
    };
  }
  return {
    plan: failurePlanDocument({
      brief: opts.brief,
      errorDetail: opts.errorDetail ?? "generate failed",
    }),
    notes: `Failure plan — ${opts.errorDetail ?? "generate failed"}. Call plan_loop_retry.`,
    usedScaffold: true,
  };
}

export type PlanLoopVersionTreeNode = {
  version: number;
  parentVersion: number | null;
  status: PlanLoopVersionStatus;
  usedScaffold: boolean;
};

export function buildPlanLoopVersionTree(
  projectRoot: string,
  loopId: string,
): { tip: number; versions: PlanLoopVersionTreeNode[] } {
  const meta = readPlanLoopMeta(projectRoot, loopId);
  const tip = meta?.currentVersion ?? 0;
  const versions: PlanLoopVersionTreeNode[] = [];
  for (let v = 1; v <= Math.max(tip, 0) + 5; v++) {
    if (!planLoopVersionExists(projectRoot, loopId, v)) {
      if (v > tip) break;
      continue;
    }
    const vm = readPlanLoopVersionMeta(projectRoot, loopId, v);
    versions.push({
      version: v,
      parentVersion: vm?.parentVersion ?? (v <= 1 ? null : v - 1),
      status: vm?.status ?? "active",
      usedScaffold: Boolean(vm?.usedScaffold),
    });
  }
  return { tip, versions };
}

export function invalidatePlanLoopVersion(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  reason?: string;
}): PlanLoopMeta {
  const meta = readPlanLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Plan loop not found: ${opts.loopId}`);
  const vm = readPlanLoopVersionMeta(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  const parent = vm?.parentVersion ?? null;
  const nextMeta: PlanLoopVersionMeta = {
    version: opts.version,
    parentVersion: parent,
    status: "invalid",
    invalidReason: opts.reason ?? "discarded",
    invalidatedAt: new Date().toISOString(),
    usedScaffold: Boolean(vm?.usedScaffold),
    error: vm?.error,
    updatedAt: new Date().toISOString(),
  };
  const dir = planLoopVersionDir(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "META.json"),
    `${JSON.stringify(nextMeta, null, 2)}\n`,
    "utf-8",
  );
  let tip = meta.currentVersion;
  if (tip === opts.version && parent != null && parent >= 1) {
    tip = parent;
  } else if (tip === opts.version) {
    tip = Math.max(0, opts.version - 1);
  }
  const next: PlanLoopMeta = {
    ...meta,
    currentVersion: tip,
    updatedAt: new Date().toISOString(),
  };
  writePlanLoopMeta(opts.projectRoot, next);
  return next;
}

export function assertActivePlanLoopBase(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
}): void {
  if (!planLoopVersionExists(opts.projectRoot, opts.loopId, opts.version)) {
    throw new Error(`Plan version v${opts.version} does not exist`);
  }
  const vm = readPlanLoopVersionMeta(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  if (vm?.status === "invalid") {
    throw new Error(
      `Cannot base continue on invalid v${opts.version} — pick an active version`,
    );
  }
}

export type PlanConceptualModelSummary = {
  kind: PlanScopeKind;
  focus: string;
  preserve: string[];
  inScope: string[];
};

export function summarizePlanConceptualModel(opts: {
  meta: PlanLoopMeta | null | undefined;
  inScope?: string[];
}): PlanConceptualModelSummary {
  const scope =
    opts.meta?.scope ?? defaultPlanScope(opts.meta?.brief ?? "", "start");
  return {
    kind: scope.kind,
    focus: scope.focus,
    preserve: scope.preserve,
    inScope: opts.inScope ?? [],
  };
}

/** Phase-relative plan dir helper for research hooks. */
export function phasePlanDir(projectRoot: string, phaseId: string): string {
  return join(projectRoot, SLOP_DIR, "phases", phaseId, "plan");
}

export function readPhasePlanMd(
  projectRoot: string,
  phaseId: string,
): string | null {
  const path = join(phasePlanDir(projectRoot, phaseId), "PLAN.md");
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}
