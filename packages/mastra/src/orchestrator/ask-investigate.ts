import {
  buildScreenContentInventory,
  type ScreenContent,
} from "@slopcontrol/artifacts";

const PLANNING_DOCS_POINTER = `Planning docs: \`.slopcontrol/BLUEPRINT.md\` and \`.slopcontrol/ROADMAP.md\` exist — do not read them yet. Reconstruct the named page from source first.`;

export function parseAskInvestigateTool(
  value: unknown,
): "auto" | "mastra" | "pi" | undefined {
  if (value === "auto" || value === "mastra" || value === "pi") return value;
  return undefined;
}

/**
 * Explicit Ask param → LLM engine intent → project default → fast path.
 *
 * No regex/keyword heuristic anywhere in this decision. When nothing picked
 * an engine the answer is the cheap mastra path; the operator escalates by
 * expressing thorough intent (classified by the LLM) or setting the project
 * default to pi. If routing misjudges, refine the intent prompt — there is
 * no keyword list to patch.
 */
export function resolveAskInvestigateEngine(opts: {
  turnOverride?: "auto" | "mastra" | "pi" | null;
  intent?: "auto" | "mastra" | "pi" | null;
  projectPreference?: "auto" | "mastra" | "pi" | null;
}): "mastra" | "pi" {
  if (opts.turnOverride === "mastra" || opts.turnOverride === "pi") {
    return opts.turnOverride;
  }
  if (opts.intent === "mastra" || opts.intent === "pi") {
    return opts.intent;
  }
  if (
    opts.projectPreference === "mastra" ||
    opts.projectPreference === "pi"
  ) {
    return opts.projectPreference;
  }
  return "mastra";
}

/** Routes the operator named (`/product`), longest-first so /product beats /pro. */
export function namedRoutesFromMessage(message: string): string[] {
  const found = new Set<string>();
  for (const m of message.toLowerCase().matchAll(/(?:^|[\s"'`=(])(\/[a-z][\w-]*)/g)) {
    if (m[1]) found.add(m[1]);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

export function filterScreensForAsk(
  screens: ScreenContent[],
  message: string,
): ScreenContent[] {
  const routes = namedRoutesFromMessage(message);
  if (routes.length === 0) return screens.slice(0, 12);
  const matched = screens.filter((s) =>
    routes.some(
      (r) => s.route === r || s.route.startsWith(`${r}/`) || r === s.route,
    ),
  );
  return matched.length > 0 ? matched : screens.slice(0, 12);
}

export function formatScreenSeed(screens: ScreenContent[]): string {
  if (screens.length === 0) {
    return "(no deterministic screen inventory for the named routes)";
  }
  return screens
    .slice(0, 12)
    .map((s) => {
      const lines = [
        `### ${s.route} (${s.source})`,
        s.headings.length ? `Headings: ${s.headings.join(" | ")}` : null,
        s.copy.length ? `Copy: ${s.copy.slice(0, 8).join(" | ")}` : null,
        s.buttons.length ? `Buttons/CTAs: ${s.buttons.join(" | ")}` : null,
      ].filter(Boolean);
      return lines.join("\n");
    })
    .join("\n\n");
}

export function seedScreensForAsk(
  projectRoot: string,
  message: string,
): ScreenContent[] {
  try {
    const { screens } = buildScreenContentInventory(projectRoot);
    return filterScreensForAsk(screens, message);
  } catch {
    return [];
  }
}

export function buildPiInvestigatePrompt(opts: {
  operatorMessage: string;
  screenSeed: string;
}): string {
  return `Investigate this operator question by walking the project source. Do not fetch a running website.

Operator request:
${opts.operatorMessage.trim()}

Deterministic screen inventory (static JSX extract — what the named pages say):
${opts.screenSeed}

${PLANNING_DOCS_POINTER}

Walk the named route module and its imported section components until you can reconstruct what a user would see. Then verify comparison targets the operator named (marketplace, connectors, chat, etc.) against what is actually built. Cite paths. Return markdown findings only — no Task brief unless they asked for a change.`;
}

export const ASK_ALIGN_JUDGE_PREFIX = `You already have investigation findings (from a read-only codebase walker). Write the final operator-facing answer now.
Do NOT call tools. Do NOT say "Let me check". Do NOT reduce a product-gap / "does this page do the product justice?" question to a claim-vs-schema scorecard of existing bullets.
Answer the operator's actual question. Cite paths from the findings.
If this is an implementable fix, include ## Task brief with Title, Goal, Likely areas.

Use the BLUEPRINT product-definition clip below only to align after the walk — not as a substitute for what the page shows.
`;

export function buildAskAlignJudgePrompt(opts: {
  operatorMessage: string;
  findings: string;
  productClip: string;
  dirtyWarning?: string | null;
}): string {
  const dirty = opts.dirtyWarning?.trim()
    ? `\nWALKER WARNING:\n${opts.dirtyWarning.trim()}\n`
    : "";
  const clip = opts.productClip.trim()
    ? opts.productClip.trim()
    : "(no Product summary / skills / modules sections in BLUEPRINT.md)";
  return `${ASK_ALIGN_JUDGE_PREFIX}
${dirty}
Operator request:
${opts.operatorMessage.trim()}

Investigation findings:
${opts.findings.trim() || "(empty findings)"}

BLUEPRINT product definition (for alignment, after the walk):
${clip}`;
}

export function planningDocsPointerForPresence(): string {
  return `Planning docs: \`.slopcontrol/BLUEPRINT.md\` and \`.slopcontrol/ROADMAP.md\` — read_file them only if you need product definition. Do not treat BLUEPRINT Live decisions as a substitute for reading source.`;
}

export const DEVELOP_JUDGE_PREFIX = `You are reviewing a coding turn against the phase brief. Do NOT call tools. Do NOT write or rewrite code.
Return markdown only, exactly these three sections:
## Verdict
(one word on its own line: aligned, partial, or off-track)
## Gaps
(bullets of what the brief still needs, or "none")
## Next coding turn
(one short instruction for the implementer, or "continue")
`;

export interface DevelopJudgeVerdict {
  /** null when the judge reply did not follow the template — treat as no signal. */
  verdict: "aligned" | "partial" | "off-track" | null;
  gaps: string[];
  nextCodingTurn: string | null;
  raw: string;
}

/**
 * Deterministic section split of the judge's controlled output template.
 * This parses a format WE specified — it is not intent classification.
 */
export function parseDevelopJudgeVerdict(body: string): DevelopJudgeVerdict {
  const section = (name: string): string => {
    const m = body.match(
      new RegExp(`##\\s+${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i"),
    );
    return m?.[1]?.trim() ?? "";
  };
  const verdictLine = section("Verdict").split("\n")[0]?.toLowerCase() ?? "";
  const verdict = verdictLine.includes("off-track")
    ? ("off-track" as const)
    : verdictLine.includes("partial")
      ? ("partial" as const)
      : verdictLine.includes("aligned")
        ? ("aligned" as const)
        : null;
  const gapsRaw = section("Gaps");
  const gaps =
    !gapsRaw || /^none\b/i.test(gapsRaw)
      ? []
      : gapsRaw
          .split("\n")
          .map((l) => l.replace(/^[-*•]\s*/, "").trim())
          .filter(Boolean);
  const nextRaw = section("Next coding turn");
  const nextCodingTurn =
    !nextRaw || /^continue\.?$/i.test(nextRaw) ? null : nextRaw;
  return { verdict, gaps, nextCodingTurn, raw: body };
}

export function buildDevelopJudgePrompt(opts: {
  phaseTitle: string;
  brief: string;
  codingOutput: string;
  changedFiles: string[];
}): string {
  const brief = opts.brief.trim().slice(0, 3_000) || "(no brief)";
  const output = opts.codingOutput.trim().slice(0, 6_000) || "(empty coding output)";
  const files =
    opts.changedFiles.length > 0
      ? opts.changedFiles.slice(0, 40).join("\n")
      : "(no changed files listed)";
  return `${DEVELOP_JUDGE_PREFIX}

Phase: ${opts.phaseTitle.trim() || "(untitled)"}

Brief:
${brief}

Changed files:
${files}

Coding-turn output:
${output}`;
}

/**
 * Pre-merge judgement when worktree checks pass — runs BEFORE merge so
 * off-track deliveries never land on main.
 * The build-loop counterpart of the Ask judge's last word.
 * Same output template as the per-turn judge, so one parser serves both.
 */
export function buildDevelopCompletionJudgePrompt(opts: {
  phaseTitle: string;
  brief: string;
  changedFiles: string[];
  checksSummary: string;
}): string {
  const brief = opts.brief.trim().slice(0, 4_000) || "(no brief)";
  const files =
    opts.changedFiles.length > 0
      ? opts.changedFiles.slice(0, 60).map((f) => `- ${f}`).join("\n")
      : "(no changed files listed)";
  const checks = opts.checksSummary.trim().slice(0, 1_500) || "(passed)";
  return `${DEVELOP_JUDGE_PREFIX}

This is the PRE-MERGE judgement: worktree checks pass. The phase has NOT been merged yet.
Verdict rules:
- aligned: the changed files deliver the brief. Gaps: none.
- partial: the brief is mostly delivered; list only real remaining gaps.
- off-track: the brief is NOT delivered despite green checks — missing features, wrong surface, placeholder implementations. List the concrete gaps.
Reserve off-track for brief-level misses, not style nits. Green checks + a delivered brief = aligned.

Phase: ${opts.phaseTitle.trim() || "(untitled)"}

Brief:
${brief}

Changed files (whole phase):
${files}

Automated checks:
${checks}`;
}

/**
 * Steering card injected into the next coding prompt after a partial /
 * off-track judge verdict. Judge gaps outrank stale APPENDIX cards.
 */
export function buildJudgeSteeringCard(verdict: DevelopJudgeVerdict): string {
  const parts = [
    `CODING-TURN JUDGE STEERING (verdict: ${verdict.verdict ?? "unparsed"}):`,
  ];
  if (verdict.gaps.length > 0) {
    parts.push(
      `Gaps the brief still needs:\n${verdict.gaps.map((g) => `- ${g}`).join("\n")}`,
    );
  }
  if (verdict.nextCodingTurn) {
    parts.push(`Judge instruction: ${verdict.nextCodingTurn}`);
  }
  parts.push("Address these gaps directly — they outrank stale APPENDIX cards.");
  return parts.join("\n");
}

/**
 * Bounded judge authority: an off-track pre-merge verdict with concrete gaps
 * forces one more coding iteration WITHOUT merging — but only while the
 * extension budget and iteration budget both have room. Judge failure
 * (null verdict) fails open: automated checks remain the hard gate.
 */
export function shouldExtendDevelopmentForVerdict(opts: {
  verdict: DevelopJudgeVerdict | null;
  extensionCount: number;
  maxExtensions: number;
  iteration: number;
  maxIterations: number;
}): boolean {
  return (
    opts.verdict?.verdict === "off-track" &&
    opts.verdict.gaps.length > 0 &&
    opts.extensionCount < opts.maxExtensions &&
    opts.iteration < opts.maxIterations
  );
}

/** Coding prompt for a judge-forced extension iteration (checks were green). */
export function buildJudgeExtensionPrompt(): string {
  return `Automated checks pass but the pre-merge judge ruled the delivery OFF-TRACK against the phase brief — the phase was NOT merged.
Close ONLY the judge gaps in the steering note below — do not re-litigate prior diagnoses, do not rework delivered work, do not probe live APIs.
Run Automated Checks again, update \`## Operator handoff\` in APPENDIX, then print DEV_COMPLETE.`;
}
