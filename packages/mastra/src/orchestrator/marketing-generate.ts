/**
 * Marketing-loop generate: investigate, judge findings, draft, then a bounded
 * quality-judge retry that carries gaps and suggested fixes into the next draft.
 */

import {
  MARKETING_CLAIM_LINE_RULES,
  MARKETING_REQUIRED_SECTIONS,
  extractMarketingDocument,
  failureMarketingDocument,
  formatMarketingJudgeRetryBlock,
  marketingDocumentSuspiciousShrink,
  marketingDocumentWorthMerging,
  mergeMarketingDocumentSections,
  validateMarketingDocument,
  type MarketingQualityVerdict,
} from "@slopcontrol/artifacts";
import type {
  MarketingContinueIntent,
  MarketingStartIntent,
} from "@slopcontrol/llm";
import { planningGateIssueFingerprint } from "./planning-pipeline.js";

const MAX_DRAFT_RETRIES = 2;

export type MarketingGenerateInput = {
  loopId: string;
  brief: string;
  message?: string;
  previousDoc?: string;
  previousVerdict?: MarketingQualityVerdict | null;
  version: number;
  projectRoot: string;
  onProgress?: (event: { type: "status"; summary: string }) => void;
};

export type MarketingGenerateResult = {
  doc: string;
  notes: string;
  findings: string;
  usedScaffold: boolean;
  reply: string;
  verdict: MarketingQualityVerdict;
};

export type MarketingGenerateDeps = {
  classifyStart: (brief: string) => Promise<MarketingStartIntent>;
  classifyContinue: (message: string, brief: string) => Promise<MarketingContinueIntent>;
  runTurn: (opts: {
    role: "investigate" | "judge" | "draft";
    prompt: string;
    sessionId: string;
    maxSteps: number;
    timeoutMs: number;
  }) => Promise<string>;
  judgeQuality: (
    doc: string,
    findings: string,
  ) => Promise<{ verdict: MarketingQualityVerdict; judgeInfraFailed: boolean }>;
};

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…(clipped)`;
}

const SECTION_LIST = MARKETING_REQUIRED_SECTIONS.join(", ");

export function buildMarketingDraftPrompt(opts: {
  loopId: string;
  version: number;
  brief: string;
  message?: string;
  findings: string;
  previousDoc?: string;
  retryBlock?: string;
  scopeNote?: string;
}): string {
  const prior = opts.previousDoc?.trim()
    ? `Previous MARKETING.md (revise this — do not start from scratch unless the scope is full_revise):\n\n\`\`\`markdown\n${clip(opts.previousDoc, 64_000)}\n\`\`\``
    : "";
  return `Marketing loop ${opts.loopId} — produce version v${opts.version} MARKETING.md.

${opts.scopeNote ?? ""}
Brief:
${clip(opts.brief, 3_000)}

${opts.message?.trim() ? `Operator feedback:\n${clip(opts.message, 3_000)}\n` : ""}
${opts.findings.trim() ? `INVESTIGATION FINDINGS (authoritative — do not invent competitor facts beyond these):\n${clip(opts.findings, 8_000)}\n` : ""}
${opts.retryBlock ? `${opts.retryBlock}\n` : ""}
${prior}

Required H2 sections: ${SECTION_LIST}.
${MARKETING_CLAIM_LINE_RULES}

Return a short rationale then the full document in a markdown fence. End with MARKETING_COMPLETE.`;
}

export function finalizeMarketingDraft(opts: {
  raw: string;
  brief: string;
  previousDoc?: string;
  continueScope?: MarketingContinueIntent["scope"];
}): { doc: string; notes: string; usedScaffold: boolean } {
  const previous = opts.previousDoc?.trim() ?? "";
  if (opts.continueScope === "clarify_only" && previous) {
    const notes = opts.raw
      .replace(/```[\s\S]*?```/g, "")
      .replace(/MARKETING_COMPLETE/gi, "")
      .trim()
      .slice(0, 1_500);
    return {
      doc: previous,
      notes: notes || "Clarify-only continue; prior marketing doc preserved.",
      usedScaffold: false,
    };
  }
  let doc = extractMarketingDocument(opts.raw) ?? "";
  if (!doc.trim() && previous) {
    return {
      doc: previous,
      notes: "Agent returned an empty marketing doc; prior kept.",
      usedScaffold: true,
    };
  }
  if (!doc.trim()) {
    return {
      doc: failureMarketingDocument({
        brief: opts.brief,
        errorDetail: "empty agent marketing doc",
      }),
      notes: "Failure doc — empty agent output. Call marketing_loop_continue.",
      usedScaffold: true,
    };
  }
  let validation = validateMarketingDocument(doc);
  let mergeNote = "";
  if (!validation.ok && marketingDocumentWorthMerging(doc)) {
    const merged = mergeMarketingDocumentSections({
      incoming: doc,
      prior: previous,
      title: opts.brief,
    });
    const mergedValidation = validateMarketingDocument(merged.doc);
    if (mergedValidation.ok) {
      doc = merged.doc;
      validation = mergedValidation;
      mergeNote = merged.filledFromPrior.length
        ? `Merged missing sections from prior: ${merged.filledFromPrior.join(", ")}.`
        : "";
    }
  }
  if (!validation.ok && previous && validateMarketingDocument(previous).ok) {
    return {
      doc: previous,
      notes: `Rejected incomplete marketing doc (missing: ${validation.missing.join(", ") || "—"}; empty: ${validation.empty.join(", ") || "—"}); kept prior.`,
      usedScaffold: true,
    };
  }
  if (!validation.ok) {
    return {
      doc: failureMarketingDocument({
        brief: opts.brief,
        errorDetail: `incomplete: missing ${validation.missing.join(",")}`,
      }),
      notes: "Scaffold — incomplete marketing sections.",
      usedScaffold: true,
    };
  }
  const surgical =
    opts.continueScope === "sections" || opts.continueScope === "clarify_only";
  if (surgical && previous) {
    const shrink = marketingDocumentSuspiciousShrink({ incoming: doc, prior: previous });
    if (shrink.shrunk) {
      return {
        doc: previous,
        notes:
          `Rejected shrunken marketing doc (${Math.round(shrink.lineRatio * 100)}% of prior lines) ` +
          `on a ${opts.continueScope} continue; kept prior.`,
        usedScaffold: true,
      };
    }
  }
  return { doc, notes: mergeNote, usedScaffold: false };
}

const UNBOUND_VERDICT: MarketingQualityVerdict = {
  ok: false,
  gaps: ["MARKETING quality judge unbound"],
  suggestedFixes: ["Bind the judge role, then marketing_loop_continue"],
  evidenceFaults: [],
  draftFaults: ["MARKETING quality judge unbound"],
  judgeInfraFailed: true,
};

export async function runMarketingLoopGenerate(
  input: MarketingGenerateInput,
  deps: MarketingGenerateDeps,
): Promise<MarketingGenerateResult> {
  const isContinue = input.version > 1 || Boolean(input.previousDoc?.trim());
  let continueScope: MarketingContinueIntent["scope"] | undefined;
  let needsResearch = true;
  if (isContinue) {
    const intent = await deps.classifyContinue(
      input.message?.trim() || input.brief,
      input.brief,
    );
    continueScope = intent.scope;
    needsResearch =
      intent.scope === "full_revise" || intent.scope === "expand_scope";
  } else {
    const intent = await deps.classifyStart(input.brief);
    needsResearch = intent.needsCompetitiveResearch;
    continueScope = "full_revise";
  }

  let findings = "";
  if (continueScope !== "clarify_only" && needsResearch) {
    input.onProgress?.({ type: "status", summary: "marketing investigating" });
    const investigated = await deps.runTurn({
      role: "investigate",
      sessionId: `marketing-${input.loopId}-v${input.version}-investigate`,
      maxSteps: 12,
      timeoutMs: 240_000,
      prompt: `Investigate a marketing release. Do not write MARKETING.md.

Project root: ${input.projectRoot}
Brief:
${clip(input.brief, 3_000)}
${input.message?.trim() ? `\nOperator feedback:\n${clip(input.message, 2_000)}` : ""}

1. Find the current landing page in the repo and quote what it actually says.
2. Use web_search and fetch_url for competitor landings named by the operator, or the closest public competitors if none are named. Cite each URL.
3. List what those landings do that this one does not.

Return findings only. End with FINDINGS_COMPLETE.`,
    });
    input.onProgress?.({ type: "status", summary: "marketing judging findings" });
    const judged = await deps.runTurn({
      role: "judge",
      sessionId: `marketing-judge-${input.loopId}-v${input.version}`,
      maxSteps: 4,
      timeoutMs: 120_000,
      prompt: `Turn these investigation notes into a competitive brief for a marketing doc. Do not invent sources that are not in the notes. If a competitor page was not actually fetched, say so.

Operator brief:
${clip(input.brief, 2_000)}

Notes:
${clip(investigated, 12_000)}`,
    });
    findings = judged.trim() || investigated.trim();
  }

  const draftOnce = async (retryBlock?: string) => {
    input.onProgress?.({ type: "status", summary: "marketing drafting" });
    const raw = await deps.runTurn({
      role: "draft",
      sessionId: `marketing-${input.loopId}-v${input.version}-draft`,
      maxSteps: 8,
      timeoutMs: 240_000,
      prompt: buildMarketingDraftPrompt({
        loopId: input.loopId,
        version: input.version,
        brief: input.brief,
        message: input.message,
        findings,
        previousDoc: input.previousDoc,
        retryBlock,
        scopeNote: continueScope
          ? `Continue scope: ${continueScope}. sections and clarify_only must not drop existing claims or tracks.`
          : "",
      }),
    });
    return finalizeMarketingDraft({
      raw,
      brief: input.brief,
      previousDoc: input.previousDoc,
      continueScope,
    });
  };

  let drafted = await draftOnce();
  if (drafted.usedScaffold || continueScope === "clarify_only") {
    const verdict = input.previousVerdict ?? {
      ...UNBOUND_VERDICT,
      ok: false,
      gaps: [drafted.notes || "Draft did not pass structural gates"],
      judgeInfraFailed: false,
      draftFaults: [drafted.notes || "structural"],
      evidenceFaults: [],
      suggestedFixes: [],
    };
    return {
      ...drafted,
      findings,
      reply: drafted.notes,
      verdict: continueScope === "clarify_only" && input.previousVerdict
        ? input.previousVerdict
        : { ...verdict, ok: false, judgeInfraFailed: verdict.judgeInfraFailed },
    };
  }

  let judged = await deps.judgeQuality(drafted.doc, findings);
  let verdict: MarketingQualityVerdict = {
    ...judged.verdict,
    judgeInfraFailed: judged.judgeInfraFailed,
  };
  if (verdict.judgeInfraFailed || verdict.ok) {
    return { ...drafted, findings, reply: drafted.notes, verdict };
  }

  let evidenceRetried = false;
  if (verdict.evidenceFaults.length > 0) {
    evidenceRetried = true;
    input.onProgress?.({ type: "status", summary: "marketing re-investigating" });
    const again = await deps.runTurn({
      role: "investigate",
      sessionId: `marketing-${input.loopId}-v${input.version}-investigate-retry`,
      maxSteps: 10,
      timeoutMs: 240_000,
      prompt: `Re-investigate. The marketing judge rejected the evidence. Fix these gaps and return findings only:\n${verdict.evidenceFaults.map((g) => `- ${g}`).join("\n")}\n\nProject root: ${input.projectRoot}\nPrior findings:\n${clip(findings, 6_000)}`,
    });
    findings = `${findings}\n\n${again}`.trim();
    drafted = await draftOnce(formatMarketingJudgeRetryBlock(verdict));
    if (!drafted.usedScaffold) {
      judged = await deps.judgeQuality(drafted.doc, findings);
      verdict = { ...judged.verdict, judgeInfraFailed: judged.judgeInfraFailed };
    }
  }

  let fingerprint = planningGateIssueFingerprint(verdict.gaps);
  for (
    let attempt = 0;
    attempt < MAX_DRAFT_RETRIES &&
    !verdict.ok &&
    !verdict.judgeInfraFailed &&
    !drafted.usedScaffold;
    attempt++
  ) {
    const retryBlock = formatMarketingJudgeRetryBlock(verdict);
    drafted = await draftOnce(retryBlock);
    if (drafted.usedScaffold) break;
    judged = await deps.judgeQuality(drafted.doc, findings);
    verdict = { ...judged.verdict, judgeInfraFailed: judged.judgeInfraFailed };
    const nextFp = planningGateIssueFingerprint(verdict.gaps);
    if (nextFp && nextFp === fingerprint) break;
    fingerprint = nextFp;
    if (evidenceRetried && verdict.evidenceFaults.length && !verdict.draftFaults.length) {
      break;
    }
  }

  return {
    ...drafted,
    findings,
    reply: drafted.notes || (verdict.ok ? "Marketing doc updated." : verdict.gaps.join("; ")),
    verdict,
  };
}
