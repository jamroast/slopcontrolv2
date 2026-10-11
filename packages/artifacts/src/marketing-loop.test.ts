import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acceptMarketingLoop,
  compileMarketingPack,
  createMarketingLoopMeta,
  formatMarketingJudgeRetryBlock,
  listMarketingVersions,
  marketingClaimTrackIssues,
  marketingDocumentSuspiciousShrink,
  seedMarketingAcceptance,
  validateMarketingDocument,
  writeMarketingLoopMeta,
  writeMarketingLoopVersion,
} from "./marketing-loop.js";

function sampleDoc(opts?: { dropTrack?: boolean; forbiddenInLanding?: boolean }): string {
  const landing = opts?.forbiddenInLanding
    ? "We are the only standards-based auth host."
    : "A single page that shows the hosted login and the claim that is already true.";
  const tracks = opts?.dropTrack
    ? "- track: design-1 | design | Landing composition | claims: c1 | depends:"
    : [
        "- track: design-1 | design | Landing composition | claims: c1 | depends:",
        "- track: gap-1 | product | Ship the missing proof | claims: c2 | depends:",
        "- track: ban-1 | landing | Do not say the forbidden line | claims: c3 | depends: design-1",
      ].join("\n");
  return `# Marketing — launch

## Audience

Operators who need hosted login for their own app.

## Competitors

Competitor A leads with a product screenshot and a single proof point. Source: https://example.com

## Positioning

Hosted login that the operator can see working on the first screen.

## Claims

- claim: c1 | proven | The hosted login form is already in the product
- claim: c2 | gap | Enterprise SSO is self-serve | change: add a self-serve SSO setup flow
- claim: c3 | forbidden | We are the only standards-based auth host.

## Landing narrative

${landing}

## Tracks

${tracks}

## Risks and open questions

Competitor pages may change. Re-fetch before accept.

## Handoff notes

Design first, then the SSO gap, then the landing implementation.
`;
}

describe("marketing loop artifacts", () => {
  it("validates required sections and parses claims and tracks", () => {
    const doc = sampleDoc();
    assert.equal(validateMarketingDocument(doc).ok, true);
    const pack = compileMarketingPack(doc, 1);
    assert.equal(pack.claims.length, 3);
    assert.equal(pack.claims[1]?.change, "add a self-serve SSO setup flow");
    assert.equal(pack.tracks.length, 3);
    assert.deepEqual(marketingClaimTrackIssues(pack), []);
  });

  it("rejects a gap claim with no track", () => {
    const pack = compileMarketingPack(sampleDoc({ dropTrack: true }), 1);
    const issues = marketingClaimTrackIssues(pack);
    assert.ok(issues.some((issue) => issue.includes("c2") && issue.includes("no track")));
  });

  it("rejects a landing narrative that repeats a forbidden claim", () => {
    const pack = compileMarketingPack(sampleDoc({ forbiddenInLanding: true }), 1);
    const issues = marketingClaimTrackIssues(pack);
    assert.ok(issues.some((issue) => issue.includes("forbidden claim c3")));
  });

  it("flags a surgical shrink the way plans do", () => {
    const prior = `${"# line\n".repeat(40)}tail`;
    const incoming = "# line\nshort";
    assert.equal(
      marketingDocumentSuspiciousShrink({ incoming, prior }).shrunk,
      true,
    );
    assert.equal(
      marketingDocumentSuspiciousShrink({
        incoming: prior.replace("tail", "tail edited"),
        prior,
      }).shrunk,
      false,
    );
  });

  it("refuses accept when the judge has not passed", () => {
    const root = mkdtempSync(join(tmpdir(), "mkt-"));
    try {
      const meta = createMarketingLoopMeta({
        projectId: "p1",
        brief: "Take the landing to market",
      });
      writeMarketingLoopMeta(root, { ...meta, currentVersion: 1 });
      writeMarketingLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: 1,
        doc: sampleDoc(),
        usedScaffold: false,
        verdict: {
          ok: false,
          gaps: ["Competitor source missing"],
          suggestedFixes: ["Fetch the competitor landing"],
          evidenceFaults: ["Competitor source missing"],
          draftFaults: [],
        },
      });
      seedMarketingAcceptance({ projectRoot: root, loopId: meta.id, version: 1 });
      assert.throws(() =>
        acceptMarketingLoop(root, meta.id, 1, { acceptAllFeatures: true }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a judge-clean doc and writes the pack", () => {
    const root = mkdtempSync(join(tmpdir(), "mkt-"));
    try {
      const meta = createMarketingLoopMeta({
        projectId: "p1",
        brief: "Take the landing to market",
      });
      writeMarketingLoopMeta(root, { ...meta, currentVersion: 1 });
      writeMarketingLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: 1,
        doc: sampleDoc(),
        verdict: {
          ok: true,
          gaps: [],
          suggestedFixes: [],
          evidenceFaults: [],
          draftFaults: [],
        },
      });
      const accepted = acceptMarketingLoop(root, meta.id, 1, {
        acceptAllFeatures: true,
      });
      assert.equal(accepted.status, "accepted");
      assert.equal(accepted.acceptedVersion, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists versions with tip, parentage, and verdict metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "mkt-"));
    try {
      const meta = createMarketingLoopMeta({
        projectId: "p1",
        brief: "Take the landing to market",
      });
      writeMarketingLoopMeta(root, {
        ...meta,
        currentVersion: 2,
        acceptedVersion: 1,
      });
      writeMarketingLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: 1,
        doc: sampleDoc(),
        parentVersion: null,
      });
      writeMarketingLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: 2,
        doc: sampleDoc(),
        parentVersion: 1,
        usedScaffold: true,
      });
      const summary = listMarketingVersions(root, meta.id);
      assert.equal(summary.tip, 2);
      assert.equal(summary.acceptedVersion, 1);
      assert.deepEqual(
        summary.versions.map((v) => v.version),
        [1, 2],
      );
      assert.equal(summary.versions[0]?.parentVersion, null);
      assert.equal(summary.versions[1]?.parentVersion, 1);
      assert.equal(summary.versions[1]?.usedScaffold, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a scaffold even when the verdict says ok", () => {
    const root = mkdtempSync(join(tmpdir(), "mkt-"));
    try {
      const meta = createMarketingLoopMeta({
        projectId: "p1",
        brief: "Take the landing to market",
      });
      writeMarketingLoopMeta(root, { ...meta, currentVersion: 1 });
      writeMarketingLoopVersion({
        projectRoot: root,
        loopId: meta.id,
        version: 1,
        doc: sampleDoc(),
        usedScaffold: true,
        verdict: {
          ok: true,
          gaps: [],
          suggestedFixes: [],
          evidenceFaults: [],
          draftFaults: [],
        },
      });
      assert.throws(() =>
        acceptMarketingLoop(root, meta.id, 1, { acceptAllFeatures: true }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("puts gaps and suggested fixes in the retry block", () => {
    const block = formatMarketingJudgeRetryBlock({
      ok: false,
      gaps: ["No source for competitor A"],
      suggestedFixes: ["Cite the fetched URL"],
      evidenceFaults: ["No source for competitor A"],
      draftFaults: [],
    });
    assert.match(block, /No source for competitor A/);
    assert.match(block, /Cite the fetched URL/);
  });
});
