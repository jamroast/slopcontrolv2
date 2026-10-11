/**
 * Marketing-loop: versioned MARKETING.md that coordinates a launch.
 * Artifacts under `.slopcontrol/marketing-loops/<id>/`.
 * Structural parsing only — claim status is decided by the LLM quality judge.
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

const SLOP_DIR = ".slopcontrol";

export type MarketingLoopStatus = "open" | "accepted" | "promoted";

export type MarketingClaimStatus = "proven" | "gap" | "forbidden";

export type MarketingTrackKind = "design" | "product" | "landing";

export type MarketingClaim = {
  id: string;
  status: MarketingClaimStatus;
  statement: string;
  /** Required when status is gap: the product change that would make it true. */
  change?: string;
};

export type MarketingTrack = {
  id: string;
  kind: MarketingTrackKind;
  brief: string;
  claimIds: string[];
  dependsOn: string[];
};

export type MarketingQualityVerdict = {
  ok: boolean;
  gaps: string[];
  suggestedFixes: string[];
  evidenceFaults: string[];
  draftFaults: string[];
  judgeInfraFailed?: boolean;
};

export type MarketingLoopMeta = {
  id: string;
  projectId: string;
  brief: string;
  status: MarketingLoopStatus;
  currentVersion: number;
  acceptedVersion?: number;
  designLoopId?: string;
  phaseIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export type MarketingLoopVersionMeta = {
  version: number;
  parentVersion: number | null;
  status: "active" | "invalid";
  usedScaffold: boolean;
  error?: string;
  updatedAt: string;
};

export type MarketingLoopAcceptanceFeature = {
  id: string;
  label: string;
  accepted: boolean;
};

export type MarketingLoopAcceptance = {
  version: number;
  features: MarketingLoopAcceptanceFeature[];
  acceptedAt?: string;
  updatedAt?: string;
};

export type MarketingPack = {
  version: number;
  audience: string;
  competitors: string;
  positioning: string;
  claims: MarketingClaim[];
  landingNarrative: string;
  tracks: MarketingTrack[];
  risks: string;
  handoff: string;
};

export type MarketingReleaseManifest = {
  loopId: string;
  version: number;
  designLoopId?: string;
  designBrief: string;
  phaseIds: string[];
  pendingLanding: {
    brief: string;
    dependsOnTrackIds: string[];
    dependsOnPhaseIds: string[];
  } | null;
  promotedAt: string;
};

export const MARKETING_REQUIRED_SECTIONS = [
  "Audience",
  "Competitors",
  "Positioning",
  "Claims",
  "Landing narrative",
  "Tracks",
  "Risks and open questions",
  "Handoff notes",
] as const;

export const MARKETING_LOOP_FALLBACK_FEATURES: MarketingLoopAcceptanceFeature[] = [
  { id: "audience", label: "Audience locked", accepted: false },
  { id: "competitors", label: "Competitors sourced", accepted: false },
  { id: "positioning", label: "Positioning accepted", accepted: false },
  { id: "claims", label: "Claims honest", accepted: false },
  { id: "landing", label: "Landing narrative accepted", accepted: false },
  { id: "tracks", label: "Tracks cover every gap", accepted: false },
];

export const MARKETING_SCAFFOLD_ACCEPT_ERROR =
  "Cannot accept a scaffold or failure MARKETING.md — call marketing_loop_continue or marketing_loop_retry";

export function marketingLoopsRoot(projectRoot: string): string {
  return join(projectRoot, SLOP_DIR, "marketing-loops");
}

export function marketingLoopDir(projectRoot: string, loopId: string): string {
  return join(marketingLoopsRoot(projectRoot), loopId);
}

export function marketingLoopVersionDir(
  projectRoot: string,
  loopId: string,
  version: number,
): string {
  return join(marketingLoopDir(projectRoot, loopId), `v${version}`);
}

export function createMarketingLoopMeta(opts: {
  projectId: string;
  brief: string;
}): MarketingLoopMeta {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    projectId: opts.projectId,
    brief: opts.brief.trim(),
    status: "open",
    currentVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function writeMarketingLoopMeta(
  projectRoot: string,
  meta: MarketingLoopMeta,
): void {
  const dir = marketingLoopDir(projectRoot, meta.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "META.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

export function readMarketingLoopMeta(
  projectRoot: string,
  loopId: string,
): MarketingLoopMeta | null {
  const path = join(marketingLoopDir(projectRoot, loopId), "META.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingLoopMeta;
  } catch {
    return null;
  }
}

export function listMarketingLoops(projectRoot: string): MarketingLoopMeta[] {
  const root = marketingLoopsRoot(projectRoot);
  if (!existsSync(root)) return [];
  const out: MarketingLoopMeta[] = [];
  for (const name of readdirSync(root)) {
    const meta = readMarketingLoopMeta(projectRoot, name);
    if (meta) out.push(meta);
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function extractMarketingSection(doc: string, title: string): string | null {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `m` makes `$` match every line end, which would keep only the first line
  // (or nothing, when a blank line follows the heading). End-of-string only.
  const re = new RegExp(
    `^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$(?!\\n))`,
    "im",
  );
  const m = doc.match(re);
  if (!m?.[1]) return null;
  return m[1].replace(/\nMARKETING_COMPLETE\s*$/i, "").trim();
}

export type MarketingSectionValidation = {
  ok: boolean;
  missing: string[];
  empty: string[];
};

export function validateMarketingDocument(doc: string): MarketingSectionValidation {
  const missing: string[] = [];
  const empty: string[] = [];
  for (const title of MARKETING_REQUIRED_SECTIONS) {
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^##\\s+${escaped}\\s*$`, "im");
    if (!re.test(doc)) {
      missing.push(title);
      continue;
    }
    const body = extractMarketingSection(doc, title);
    if (!body || body.replace(/[-*]\s*\(none\)/gi, "").trim().length < 3) {
      empty.push(title);
    }
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty };
}

const SECTION_STUB = "- (to research)";

export function mergeMarketingDocumentSections(opts: {
  incoming: string;
  prior?: string | null;
  title?: string;
}): { doc: string; filledFromPrior: string[]; filledStub: string[] } {
  const incoming = (opts.incoming ?? "").trim();
  const prior = (opts.prior ?? "").trim();
  const filledFromPrior: string[] = [];
  const filledStub: string[] = [];
  const titleLine =
    incoming.match(/^#\s+.+$/m)?.[0] ||
    prior.match(/^#\s+.+$/m)?.[0] ||
    `# Marketing — ${opts.title?.trim().slice(0, 80) || "release"}`;
  const bodies: Record<string, string> = {};
  for (const title of MARKETING_REQUIRED_SECTIONS) {
    const fromIncoming = extractMarketingSection(incoming, title);
    const incomingOk =
      fromIncoming &&
      fromIncoming.replace(/[-*]\s*\(none\)/gi, "").trim().length >= 3;
    if (incomingOk) {
      bodies[title] = fromIncoming!.trim();
      continue;
    }
    const fromPrior = extractMarketingSection(prior, title);
    const priorOk =
      fromPrior &&
      fromPrior.replace(/[-*]\s*\(none\)/gi, "").trim().length >= 3;
    if (priorOk) {
      bodies[title] = fromPrior!.trim();
      filledFromPrior.push(title);
      continue;
    }
    bodies[title] = SECTION_STUB;
    filledStub.push(title);
  }
  const doc = [
    titleLine,
    "",
    ...MARKETING_REQUIRED_SECTIONS.flatMap((title) => [
      `## ${title}`,
      "",
      bodies[title] ?? SECTION_STUB,
      "",
    ]),
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { doc: `${doc}\n`, filledFromPrior, filledStub };
}

export function marketingDocumentWorthMerging(doc: string): boolean {
  const p = (doc ?? "").trim();
  if (!p || !/^#\s+/m.test(p)) return false;
  return /##\s*Claims/i.test(p) || /##\s*Audience/i.test(p);
}

export function extractMarketingDocument(text: string): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:markdown|md)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]?.trim() && /##\s*Claims/i.test(fenced[1])) {
    return fenced[1].trim();
  }
  const start = trimmed.search(/^#\s+/m);
  if (start >= 0) {
    const body = trimmed.slice(start).replace(/\nMARKETING_COMPLETE\s*$/i, "").trim();
    if (/##\s*Claims/i.test(body)) return body;
  }
  if (/##\s*Claims/i.test(trimmed) && /##\s*Audience/i.test(trimmed)) {
    return trimmed.replace(/\nMARKETING_COMPLETE\s*$/i, "").trim();
  }
  return null;
}

/** Surgical continues must not gut the doc. Same 60% line-and-byte bar as plans. */
export function marketingDocumentSuspiciousShrink(opts: {
  incoming: string;
  prior?: string | null;
}): { shrunk: boolean; lineRatio: number; byteRatio: number } {
  const prior = (opts.prior ?? "").trim();
  const incoming = (opts.incoming ?? "").trim();
  if (!prior || !incoming) return { shrunk: false, lineRatio: 1, byteRatio: 1 };
  const priorLines = prior.split("\n").length;
  const incomingLines = incoming.split("\n").length;
  const lineRatio = incomingLines / priorLines;
  const byteRatio = incoming.length / prior.length;
  if (priorLines < 30) return { shrunk: false, lineRatio, byteRatio };
  return { shrunk: lineRatio < 0.6 && byteRatio < 0.6, lineRatio, byteRatio };
}

const CLAIM_LINE =
  /^-\s*claim:\s*([A-Za-z0-9_-]+)\s*\|\s*(proven|gap|forbidden)\s*\|\s*([^|\n]+?)(?:\s*\|\s*change:\s*([^\n]+))?[ \t]*$/gim;

const TRACK_LINE =
  /^-\s*track:\s*([A-Za-z0-9_-]+)\s*\|\s*(design|product|landing)\s*\|\s*([^|\n]+?)\s*\|\s*claims:\s*([^|\n]*)\|\s*depends:[ \t]*([^\n]*)$/gim;

export function parseMarketingClaims(section: string): MarketingClaim[] {
  const claims: MarketingClaim[] = [];
  for (const match of section.matchAll(CLAIM_LINE)) {
    const id = match[1];
    const status = match[2] as MarketingClaimStatus | undefined;
    const statement = match[3]?.trim();
    if (!id || !status || !statement) continue;
    const change = match[4]?.trim();
    claims.push({
      id,
      status,
      statement,
      change: change || undefined,
    });
  }
  return claims;
}

export function parseMarketingTracks(section: string): MarketingTrack[] {
  const tracks: MarketingTrack[] = [];
  for (const match of section.matchAll(TRACK_LINE)) {
    const id = match[1];
    const kind = match[2] as MarketingTrackKind | undefined;
    const brief = match[3]?.trim();
    if (!id || !kind || !brief) continue;
    tracks.push({
      id,
      kind,
      brief,
      claimIds: (match[4] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      dependsOn: (match[5] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
  }
  return tracks;
}

export function compileMarketingPack(doc: string, version: number): MarketingPack {
  const claims = parseMarketingClaims(extractMarketingSection(doc, "Claims") ?? "");
  const tracks = parseMarketingTracks(extractMarketingSection(doc, "Tracks") ?? "");
  return {
    version,
    audience: extractMarketingSection(doc, "Audience") ?? "",
    competitors: extractMarketingSection(doc, "Competitors") ?? "",
    positioning: extractMarketingSection(doc, "Positioning") ?? "",
    claims,
    landingNarrative: extractMarketingSection(doc, "Landing narrative") ?? "",
    tracks,
    risks: extractMarketingSection(doc, "Risks and open questions") ?? "",
    handoff: extractMarketingSection(doc, "Handoff notes") ?? "",
  };
}

/**
 * Deterministic accept checks on an already-judged pack.
 * The judge decides proven vs gap; this only checks the track graph.
 */
export function marketingClaimTrackIssues(pack: MarketingPack): string[] {
  const issues: string[] = [];
  const trackByClaim = new Map<string, string[]>();
  for (const track of pack.tracks) {
    for (const id of track.claimIds) {
      const list = trackByClaim.get(id) ?? [];
      list.push(track.id);
      trackByClaim.set(id, list);
    }
  }
  for (const claim of pack.claims) {
    if (claim.status === "proven") continue;
    const covered = trackByClaim.get(claim.id) ?? [];
    if (covered.length === 0) {
      issues.push(`Claim ${claim.id} is ${claim.status} and has no track`);
    }
    if (claim.status === "gap" && !claim.change?.trim()) {
      issues.push(`Claim ${claim.id} is gap and has no product change`);
    }
    if (claim.status === "forbidden") {
      const statement = claim.statement.trim();
      if (statement && pack.landingNarrative.includes(statement)) {
        issues.push(`Landing narrative asserts forbidden claim ${claim.id}`);
      }
    }
  }
  const ids = new Set(pack.tracks.map((t) => t.id));
  for (const track of pack.tracks) {
    for (const dep of track.dependsOn) {
      if (!ids.has(dep)) {
        issues.push(`Track ${track.id} depends on missing track ${dep}`);
      }
    }
  }
  return issues;
}

export function readMarketingDoc(
  projectRoot: string,
  loopId: string,
  version: number,
): string | null {
  const path = join(
    marketingLoopVersionDir(projectRoot, loopId, version),
    "MARKETING.md",
  );
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf-8");
}

export function readMarketingVerdict(
  projectRoot: string,
  loopId: string,
  version: number,
): MarketingQualityVerdict | null {
  const path = join(
    marketingLoopVersionDir(projectRoot, loopId, version),
    "VERDICT.json",
  );
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingQualityVerdict;
  } catch {
    return null;
  }
}

export function readMarketingVersionMeta(
  projectRoot: string,
  loopId: string,
  version: number,
): MarketingLoopVersionMeta | null {
  const path = join(
    marketingLoopVersionDir(projectRoot, loopId, version),
    "META.json",
  );
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingLoopVersionMeta;
  } catch {
    return null;
  }
}

export type MarketingVersionSummary = {
  version: number;
  parentVersion: number | null;
  status: "active" | "invalid";
  usedScaffold: boolean;
};

export function listMarketingVersions(
  projectRoot: string,
  loopId: string,
): { tip: number; acceptedVersion?: number; versions: MarketingVersionSummary[] } {
  const meta = readMarketingLoopMeta(projectRoot, loopId);
  const tip = meta?.currentVersion ?? 0;
  const versions: MarketingVersionSummary[] = [];
  for (let v = 1; v <= Math.max(tip, 0); v++) {
    const vm = readMarketingVersionMeta(projectRoot, loopId, v);
    if (!vm) continue;
    versions.push({
      version: v,
      parentVersion: vm.parentVersion ?? (v <= 1 ? null : v - 1),
      status: vm.status,
      usedScaffold: vm.usedScaffold,
    });
  }
  return { tip, acceptedVersion: meta?.acceptedVersion, versions };
}

export function writeMarketingLoopVersion(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  doc: string;
  notes?: string;
  findings?: string;
  request?: string;
  verdict?: MarketingQualityVerdict | null;
  usedScaffold?: boolean;
  error?: string;
  parentVersion?: number | null;
}): void {
  const dir = marketingLoopVersionDir(opts.projectRoot, opts.loopId, opts.version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "MARKETING.md"), `${opts.doc.trim()}\n`, "utf-8");
  writeFileSync(
    join(dir, "NOTES.md"),
    `# Marketing loop v${opts.version}\n\n${(opts.notes ?? "").trim() || "(no notes)"}\n`,
    "utf-8",
  );
  if (opts.findings !== undefined) {
    writeFileSync(join(dir, "FINDINGS.md"), `${opts.findings.trim()}\n`, "utf-8");
  }
  if (opts.request !== undefined) {
    writeFileSync(join(dir, "REQUEST.md"), `${opts.request.trim()}\n`, "utf-8");
  }
  if (opts.verdict) {
    writeFileSync(
      join(dir, "VERDICT.json"),
      `${JSON.stringify(opts.verdict, null, 2)}\n`,
      "utf-8",
    );
  }
  const meta: MarketingLoopVersionMeta = {
    version: opts.version,
    parentVersion:
      opts.parentVersion === undefined
        ? opts.version > 1
          ? opts.version - 1
          : null
        : opts.parentVersion,
    status: "active",
    usedScaffold: Boolean(opts.usedScaffold),
    error: opts.error,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(dir, "META.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

export function seedMarketingAcceptance(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
}): MarketingLoopAcceptance {
  const acceptance: MarketingLoopAcceptance = {
    version: opts.version,
    features: MARKETING_LOOP_FALLBACK_FEATURES.map((f) => ({ ...f })),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(marketingLoopDir(opts.projectRoot, opts.loopId), "ACCEPTANCE.json"),
    `${JSON.stringify(acceptance, null, 2)}\n`,
    "utf-8",
  );
  return acceptance;
}

export function readMarketingAcceptance(
  projectRoot: string,
  loopId: string,
): MarketingLoopAcceptance | null {
  const path = join(marketingLoopDir(projectRoot, loopId), "ACCEPTANCE.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingLoopAcceptance;
  } catch {
    return null;
  }
}

export function clearMarketingAcceptanceLocks(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
}): void {
  const current = readMarketingAcceptance(opts.projectRoot, opts.loopId);
  const next: MarketingLoopAcceptance = {
    version: opts.version,
    features: (current?.features ?? MARKETING_LOOP_FALLBACK_FEATURES).map((f) => ({
      ...f,
      accepted: false,
    })),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(marketingLoopDir(opts.projectRoot, opts.loopId), "ACCEPTANCE.json"),
    `${JSON.stringify(next, null, 2)}\n`,
    "utf-8",
  );
}

export function writeMarketingPack(
  projectRoot: string,
  loopId: string,
  pack: MarketingPack,
): void {
  writeFileSync(
    join(marketingLoopDir(projectRoot, loopId), "MARKETING_PACK.json"),
    `${JSON.stringify(pack, null, 2)}\n`,
    "utf-8",
  );
}

export function readMarketingPack(
  projectRoot: string,
  loopId: string,
): MarketingPack | null {
  const path = join(marketingLoopDir(projectRoot, loopId), "MARKETING_PACK.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingPack;
  } catch {
    return null;
  }
}

export function writeMarketingRelease(
  projectRoot: string,
  loopId: string,
  manifest: MarketingReleaseManifest,
): void {
  writeFileSync(
    join(marketingLoopDir(projectRoot, loopId), "RELEASE.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );
}

export function readMarketingRelease(
  projectRoot: string,
  loopId: string,
): MarketingReleaseManifest | null {
  const path = join(marketingLoopDir(projectRoot, loopId), "RELEASE.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as MarketingReleaseManifest;
  } catch {
    return null;
  }
}

export function failureMarketingDocument(opts: {
  brief: string;
  errorDetail: string;
}): string {
  const stub = `- (failure: ${opts.errorDetail.slice(0, 180)})`;
  return [
    `# Marketing — ${opts.brief.trim().slice(0, 80) || "release"}`,
    "",
    ...MARKETING_REQUIRED_SECTIONS.flatMap((title) => [`## ${title}`, "", stub, ""]),
  ].join("\n");
}

export function assertMarketingVersionAcceptable(
  projectRoot: string,
  loopId: string,
  version: number,
): void {
  const meta = readMarketingVersionMeta(projectRoot, loopId, version);
  if (meta?.usedScaffold) {
    throw new Error(MARKETING_SCAFFOLD_ACCEPT_ERROR);
  }
  const doc = readMarketingDoc(projectRoot, loopId, version);
  if (!doc?.trim()) throw new Error(`MARKETING.md missing for v${version}`);
  const validation = validateMarketingDocument(doc);
  if (!validation.ok) {
    throw new Error(
      `Cannot accept incomplete marketing doc — missing: [${validation.missing.join(", ")}] empty: [${validation.empty.join(", ")}]`,
    );
  }
  const verdict = readMarketingVerdict(projectRoot, loopId, version);
  if (!verdict?.ok || verdict.judgeInfraFailed) {
    throw new Error(
      "Cannot accept MARKETING.md — the quality judge has not passed this version",
    );
  }
  const pack = compileMarketingPack(doc, version);
  const issues = marketingClaimTrackIssues(pack);
  if (issues.length) {
    throw new Error(`Cannot accept MARKETING.md — ${issues.join("; ")}`);
  }
}

export function acceptMarketingLoop(
  projectRoot: string,
  loopId: string,
  version?: number,
  featureTicks?: {
    features?: MarketingLoopAcceptanceFeature[];
    acceptedFeatureIds?: string[];
    acceptAllFeatures?: boolean;
  },
): MarketingLoopMeta {
  const meta = readMarketingLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Marketing loop not found: ${loopId}`);
  if (meta.status === "promoted") {
    throw new Error(
      `Marketing loop already promoted: ${loopId}. Call marketing_loop_continue to reopen, then accept again.`,
    );
  }
  const v = version ?? meta.currentVersion;
  assertMarketingVersionAcceptable(projectRoot, loopId, v);
  let acceptance =
    readMarketingAcceptance(projectRoot, loopId) ??
    seedMarketingAcceptance({ projectRoot, loopId, version: v });
  let features = acceptance.features.map((f) => ({ ...f }));
  if (featureTicks?.features?.length) {
    const byId = new Map(featureTicks.features.map((f) => [f.id, f.accepted]));
    features = features.map((f) =>
      byId.has(f.id) ? { ...f, accepted: Boolean(byId.get(f.id)) } : f,
    );
  }
  if (featureTicks?.acceptedFeatureIds?.length) {
    const ids = new Set(featureTicks.acceptedFeatureIds);
    features = features.map((f) => (ids.has(f.id) ? { ...f, accepted: true } : f));
  }
  if (!features.some((f) => f.accepted)) {
    if (featureTicks?.acceptAllFeatures) {
      features = features.map((f) => ({ ...f, accepted: true }));
    } else {
      throw new Error(
        "Accept requires at least one ticked feature (audience, claims, tracks, …)",
      );
    }
  }
  const now = new Date().toISOString();
  acceptance = { version: v, features, acceptedAt: now, updatedAt: now };
  writeFileSync(
    join(marketingLoopDir(projectRoot, loopId), "ACCEPTANCE.json"),
    `${JSON.stringify(acceptance, null, 2)}\n`,
    "utf-8",
  );
  const doc = readMarketingDoc(projectRoot, loopId, v) ?? "";
  writeMarketingPack(projectRoot, loopId, compileMarketingPack(doc, v));
  const next: MarketingLoopMeta = {
    ...meta,
    status: "accepted",
    acceptedVersion: v,
    updatedAt: now,
  };
  writeMarketingLoopMeta(projectRoot, next);
  return next;
}

export function reopenMarketingLoop(
  projectRoot: string,
  loopId: string,
): MarketingLoopMeta {
  const meta = readMarketingLoopMeta(projectRoot, loopId);
  if (!meta) throw new Error(`Marketing loop not found: ${loopId}`);
  if (meta.status === "open") return meta;
  const next: MarketingLoopMeta = {
    ...meta,
    status: "open",
    updatedAt: new Date().toISOString(),
  };
  writeMarketingLoopMeta(projectRoot, next);
  return next;
}

export function summarizeMarketingLoopProgress(meta: MarketingLoopMeta): {
  nextStep: string;
  blockers: string[];
} {
  if (meta.currentVersion < 1) {
    return {
      nextStep: "marketing_loop_start or marketing_loop_continue",
      blockers: ["No marketing version yet"],
    };
  }
  if (meta.status === "open") {
    return {
      nextStep:
        "marketing_loop_continue to revise, or marketing_loop_accept when the judge has passed",
      blockers: [],
    };
  }
  if (meta.status === "accepted") {
    return {
      nextStep: "marketing_loop_promote to open the design loop and product-gap phases",
      blockers: [],
    };
  }
  return {
    nextStep:
      "Design loop and product-gap phases are recorded on the release. Continue those tracks; the landing phase waits on design accept.",
    blockers: [],
  };
}

export function designBriefFromPack(pack: MarketingPack): string {
  const designTracks = pack.tracks.filter((t) => t.kind === "design");
  return [
    "Design the landing page for this marketing release.",
    "",
    "Positioning:",
    pack.positioning,
    "",
    "Landing narrative:",
    pack.landingNarrative,
    "",
    "Competitors:",
    pack.competitors,
    "",
    "Claims (do not draw a forbidden claim; do not draw a gap as if it already shipped):",
    ...pack.claims.map((c) => `- ${c.id} (${c.status}): ${c.statement}`),
    "",
    designTracks.length
      ? `Design track: ${designTracks.map((t) => t.brief).join(" ")}`
      : "Design track: one landing composition covering the narrative sections.",
  ].join("\n");
}

export function productPhaseDescription(
  pack: MarketingPack,
  track: MarketingTrack,
): string {
  const claims = pack.claims.filter((c) => track.claimIds.includes(c.id));
  return [
    `Title: ${track.brief.slice(0, 80)}`,
    "",
    "Goal: Make this marketing claim true in the product before the landing may say it.",
    "",
    track.brief,
    "",
    ...claims.map(
      (c) => `- ${c.id}: ${c.statement}${c.change ? ` Change: ${c.change}` : ""}`,
    ),
  ].join("\n");
}

/** Retry block injected into the next draft. Includes gaps and suggested fixes. */
export function formatMarketingJudgeRetryBlock(verdict: MarketingQualityVerdict): string {
  if (!verdict.gaps.length && !verdict.suggestedFixes.length) return "";
  const gaps = verdict.gaps.map((g) => `- ${g}`).join("\n");
  const fixes = verdict.suggestedFixes.length
    ? `\nSuggested fixes:\n${verdict.suggestedFixes.map((s) => `- ${s}`).join("\n")}`
    : "";
  return `Prior MARKETING.md was rejected by the quality judge — address every gap below in the rewritten draft:\n${gaps}${fixes}`;
}

export const MARKETING_CLAIM_LINE_RULES = `Claims lines (one per claim, exact shape):
- claim: <id> | proven | <statement>
- claim: <id> | gap | <statement> | change: <product change that makes it true>
- claim: <id> | forbidden | <statement>

Tracks lines (one per track, exact shape):
- track: <id> | design | <brief> | claims: <id,id> | depends:
- track: <id> | product | <brief> | claims: <id> | depends:
- track: <id> | landing | <brief> | claims: <id,id> | depends: <track-id,track-id>

Every gap and forbidden claim id must appear in some track's claims list.
The landing narrative must not repeat a forbidden claim's statement.
A proven claim needs evidence in Competitors or Findings, not confidence.`;
