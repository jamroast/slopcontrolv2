/**
 * PLAN_PACK.json — durable operator plan contract compiled on plan-loop accept.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractPlanBulletLines,
  extractPlanSection,
  planLoopDir,
  readPlanLoopAcceptance,
  readPlanLoopMeta,
  readPlanLoopPlanMd,
  type PlanLoopAcceptance,
  type PlanLoopMeta,
  type PlanScope,
} from "./plan-loop.js";

const SLOP_DIR = ".slopcontrol";

export type PlanPack = {
  name: string;
  version: number;
  loopId: string;
  projectId: string;
  sourcePlanVersion: number;
  kind: string;
  focus: string;
  goal: string;
  inScope: string[];
  mustNot: string[];
  likelyAreas: string[];
  successCriteria: string[];
  openQuestions: string[];
  planPath: string;
  createdAt: string;
  updatedAt: string;
};

export function planLoopPackPath(
  projectRoot: string,
  loopId: string,
): string {
  return join(planLoopDir(projectRoot, loopId), "PLAN_PACK.json");
}

export function phasePlanPackPath(
  projectRoot: string,
  phaseId: string,
): string {
  return join(
    projectRoot,
    SLOP_DIR,
    "phases",
    phaseId,
    "plan",
    "PLAN_PACK.json",
  );
}

export function compilePlanPackFromAccept(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  acceptance: PlanLoopAcceptance;
  meta?: PlanLoopMeta | null;
  plan?: string;
}): PlanPack {
  const meta =
    opts.meta ?? readPlanLoopMeta(opts.projectRoot, opts.loopId);
  if (!meta) throw new Error(`Plan loop not found: ${opts.loopId}`);
  const plan =
    opts.plan?.trim() ||
    readPlanLoopPlanMd(opts.projectRoot, opts.loopId, opts.version) ||
    "";
  if (!plan.trim()) {
    throw new Error(
      `Cannot compile plan pack — PLAN.md missing for ${opts.loopId} v${opts.version}`,
    );
  }

  const scope: PlanScope = meta.scope ?? {
    kind: "feature",
    focus: "change",
    preserve: [],
    source: "accept",
  };
  const goal =
    extractPlanSection(plan, "Goal")?.replace(/\s+/g, " ").trim().slice(0, 500) ||
    meta.brief;
  const inScopeBullets = extractPlanBulletLines(
    extractPlanSection(plan, "In scope"),
  );
  const outScopeBullets = extractPlanBulletLines(
    extractPlanSection(plan, "Out of scope"),
  );
  const likelyAreas = extractPlanBulletLines(
    extractPlanSection(plan, "Likely areas"),
  );
  const successCriteria = extractPlanBulletLines(
    extractPlanSection(plan, "Success criteria"),
  );
  const openQuestions = extractPlanBulletLines(
    extractPlanSection(plan, "Risks & open questions"),
  );

  const acceptedIds = opts.acceptance.features
    .filter((f) => f.accepted)
    .map((f) => f.id);

  const mustNot = [
    ...outScopeBullets.map((b) => `OUT OF SCOPE — ${b}`),
    ...opts.acceptance.features
      .filter((f) => !f.accepted)
      .map((f) => `UNTICKED — do not treat as locked: ${f.id}: ${f.label}`),
    ...scope.preserve.map(
      (p) => `PRESERVE — do not expand into ${p} unless operator asks`,
    ),
  ].slice(0, 30);

  const now = new Date().toISOString();
  const name =
    meta.brief.trim().slice(0, 80) ||
    `plan-loop-${opts.loopId.slice(0, 8)}`;

  return {
    name,
    version: 1,
    loopId: opts.loopId,
    projectId: meta.projectId,
    sourcePlanVersion: opts.version,
    kind: scope.kind,
    focus: scope.focus,
    goal,
    inScope: acceptedIds.length
      ? [...acceptedIds, ...inScopeBullets.slice(0, 12)]
      : inScopeBullets.slice(0, 16),
    mustNot,
    likelyAreas,
    successCriteria,
    openQuestions,
    planPath: `.slopcontrol/plan-loops/${opts.loopId}/v${opts.version}/PLAN.md`,
    createdAt: now,
    updatedAt: now,
  };
}

export function writePlanLoopPack(
  projectRoot: string,
  loopId: string,
  pack: PlanPack,
): string {
  mkdirSync(planLoopDir(projectRoot, loopId), { recursive: true });
  const path = planLoopPackPath(projectRoot, loopId);
  const prior = readPlanLoopPack(projectRoot, loopId);
  const next: PlanPack = {
    ...pack,
    version: (prior?.version ?? 0) + 1,
    createdAt: prior?.createdAt ?? pack.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  return path;
}

export function readPlanLoopPack(
  projectRoot: string,
  loopId: string,
): PlanPack | null {
  const path = planLoopPackPath(projectRoot, loopId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PlanPack;
  } catch {
    return null;
  }
}

export function readPhasePlanPack(
  projectRoot: string,
  phaseId: string,
): PlanPack | null {
  const path = phasePlanPackPath(projectRoot, phaseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PlanPack;
  } catch {
    return null;
  }
}

export function copyPlanPackToPhase(opts: {
  projectRoot: string;
  loopId: string;
  phaseId: string;
}): PlanPack | null {
  const pack = readPlanLoopPack(opts.projectRoot, opts.loopId);
  if (!pack) return null;
  const planDir = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "plan",
  );
  mkdirSync(planDir, { recursive: true });
  const phasePack: PlanPack = {
    ...pack,
    planPath: `.slopcontrol/phases/${opts.phaseId}/plan/PLAN.md`,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(
    phasePlanPackPath(opts.projectRoot, opts.phaseId),
    `${JSON.stringify(phasePack, null, 2)}\n`,
    "utf-8",
  );
  return phasePack;
}

export function formatPlanPackPromptBlock(
  pack: PlanPack | null | undefined,
): string {
  if (!pack) return "";
  const lines: string[] = [
    "PLAN CONTRACT (authoritative operator plan — research must address every In scope + Success criteria; do not expand Out of scope):",
    `- name: ${pack.name}`,
    `- pack version: ${pack.version} (from plan-loop ${pack.loopId} plan v${pack.sourcePlanVersion})`,
    `- kind/focus: ${pack.kind} / ${pack.focus}`,
    `- plan: \`${pack.planPath}\``,
    "",
    "### Goal",
    pack.goal || "(none)",
    "",
  ];
  if (pack.inScope.length) {
    lines.push("### inScope");
    for (const s of pack.inScope) lines.push(`- ${s}`);
    lines.push("");
  }
  if (pack.mustNot.length) {
    lines.push("### mustNot");
    for (const m of pack.mustNot) lines.push(`- ${m}`);
    lines.push("");
  }
  if (pack.likelyAreas.length) {
    lines.push("### likelyAreas");
    for (const a of pack.likelyAreas) lines.push(`- ${a}`);
    lines.push("");
  }
  if (pack.successCriteria.length) {
    lines.push("### successCriteria");
    for (const s of pack.successCriteria) lines.push(`- ${s}`);
    lines.push("");
  }
  if (pack.openQuestions.length) {
    lines.push("### openQuestions (research must resolve with code evidence)");
    for (const q of pack.openQuestions) lines.push(`- ${q}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatPhaseBoundPlanPromptBlock(opts: {
  projectRoot: string;
  phaseId: string;
  maxPlanChars?: number;
}): string {
  const pack = readPhasePlanPack(opts.projectRoot, opts.phaseId);
  const planPath = join(
    opts.projectRoot,
    SLOP_DIR,
    "phases",
    opts.phaseId,
    "plan",
    "PLAN.md",
  );
  if (!pack && !existsSync(planPath)) return "";
  const parts: string[] = [];
  if (pack) parts.push(formatPlanPackPromptBlock(pack));
  if (existsSync(planPath)) {
    const max = opts.maxPlanChars ?? 10_000;
    let plan = readFileSync(planPath, "utf-8");
    if (plan.length > max) {
      plan = `${plan.slice(0, max)}\n\n…[truncated; read \`.slopcontrol/phases/${opts.phaseId}/plan/PLAN.md\`]`;
    }
    parts.push("");
    parts.push("### Full PLAN.md");
    parts.push("```markdown");
    parts.push(plan.trim());
    parts.push("```");
  }
  return parts.join("\n");
}

export function compileAndWritePlanPackOnAccept(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  acceptance?: PlanLoopAcceptance | null;
}): PlanPack {
  const acceptance =
    opts.acceptance ?? readPlanLoopAcceptance(opts.projectRoot, opts.loopId);
  if (!acceptance?.features?.length) {
    throw new Error("Cannot compile plan pack without acceptance features");
  }
  const pack = compilePlanPackFromAccept({
    projectRoot: opts.projectRoot,
    loopId: opts.loopId,
    version: opts.version,
    acceptance,
  });
  writePlanLoopPack(opts.projectRoot, opts.loopId, pack);
  return readPlanLoopPack(opts.projectRoot, opts.loopId) ?? pack;
}

/** Short phase description for store/roadmap from pack. */
export function phaseDescriptionFromPlanPack(pack: PlanPack): string {
  const lines = [
    pack.goal.slice(0, 400),
    "",
    `Focus: ${pack.focus} (${pack.kind})`,
  ];
  if (pack.successCriteria.length) {
    lines.push("", "Success criteria:");
    for (const s of pack.successCriteria.slice(0, 6)) {
      lines.push(`- ${s}`);
    }
  }
  return lines.join("\n").slice(0, 4_000);
}
