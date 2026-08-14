import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ScreenContent } from "@slopcontrol/artifacts";
import {
  buildAskAlignJudgePrompt,
  buildDevelopCompletionJudgePrompt,
  buildDevelopJudgePrompt,
  buildPiInvestigatePrompt,
  filterScreensForAsk,
  formatScreenSeed,
  namedRoutesFromMessage,
  parseAskInvestigateTool,
  parseDevelopJudgeVerdict,
  resolveAskInvestigateEngine,
} from "./ask-investigate.js";

function screen(route: string, source = "src/app/page.tsx"): ScreenContent {
  return {
    route,
    source,
    headings: ["Hello"],
    buttons: [],
    tableColumns: [],
    formFields: [],
    copy: ["body copy"],
  };
}

describe("namedRoutesFromMessage / filterScreensForAsk", () => {
  it("matches /product and nested product screens, not a different route", () => {
    assert.deepEqual(namedRoutesFromMessage("look at /product please"), [
      "/product",
    ]);
    const screens = [
      screen("/product", "src/app/product/page.tsx"),
      screen("/product/skills", "src/app/product/skills/page.tsx"),
      screen("/about", "src/app/about/page.tsx"),
    ];
    const filtered = filterScreensForAsk(
      screens,
      "review the /product route",
    );
    assert.deepEqual(
      filtered.map((s) => s.route),
      ["/product", "/product/skills"],
    );
  });
});

describe("Pi investigate + Ask judge prompts", () => {
  it("tells Pi not to fetch a live site and not to use Live decisions", () => {
    const prompt = buildPiInvestigatePrompt({
      operatorMessage: "does /product match the marketplace?",
      screenSeed: formatScreenSeed([
        screen("/product", "src/app/product/page.tsx"),
      ]),
    });
    assert.match(prompt, /do not fetch a running website/i);
    assert.match(prompt, /\/product/);
    assert.match(prompt, /src\/app\/product\/page\.tsx/);
    assert.match(prompt, /do not read them yet/i);
  });

  it("judge prompt answers the operator question, not a schema scorecard", () => {
    const prompt = buildAskAlignJudgePrompt({
      operatorMessage: "does /product do the product justice?",
      findings: "Page headline is The JamPress product. Marketplace is not mentioned.",
      productClip: "## Product summary\n\nWorkflow builder with marketplace.",
      dirtyWarning: "Investigation walker modified files (must not happen): x.ts",
    });
    assert.match(prompt, /Do NOT call tools/);
    assert.match(prompt, /claim-vs-schema scorecard/);
    assert.match(prompt, /does \/product do the product justice/);
    assert.match(prompt, /Marketplace is not mentioned/);
    assert.match(prompt, /## Product summary/);
    assert.match(prompt, /WALKER WARNING/);
  });
});

describe("resolveAskInvestigateEngine", () => {
  it("honors an explicit turn override over intent and project default", () => {
    assert.equal(
      resolveAskInvestigateEngine({
        turnOverride: "mastra",
        intent: "pi",
        projectPreference: "pi",
      }),
      "mastra",
    );
    assert.equal(
      resolveAskInvestigateEngine({
        turnOverride: "pi",
        intent: "mastra",
      }),
      "pi",
    );
  });

  it("honors LLM engine intent over the project default", () => {
    assert.equal(
      resolveAskInvestigateEngine({
        intent: "mastra",
        projectPreference: "pi",
      }),
      "mastra",
    );
    assert.equal(
      resolveAskInvestigateEngine({
        intent: "pi",
        projectPreference: "auto",
      }),
      "pi",
    );
    assert.equal(parseAskInvestigateTool("pi"), "pi");
    assert.equal(parseAskInvestigateTool("nope"), undefined);
  });

  it("uses the project default when intent is auto", () => {
    assert.equal(
      resolveAskInvestigateEngine({
        intent: "auto",
        projectPreference: "pi",
      }),
      "pi",
    );
    assert.equal(
      resolveAskInvestigateEngine({
        intent: "auto",
        projectPreference: "mastra",
      }),
      "mastra",
    );
  });

  it("never guesses thoroughness — all-auto stays on the fast mastra path", () => {
    // A long, thorough-sounding review ask with no expressed intent must NOT
    // be escalated by a keyword heuristic. Refine the LLM intent prompt
    // instead; there is no regex list to patch.
    assert.equal(
      resolveAskInvestigateEngine({
        intent: "auto",
        projectPreference: "auto",
      }),
      "mastra",
    );
    assert.equal(resolveAskInvestigateEngine({}), "mastra");
  });
});

describe("develop judge prompt", () => {
  it("asks for verdict / gaps / next turn without writing code", () => {
    const prompt = buildDevelopJudgePrompt({
      phaseTitle: "Product copy",
      brief: "Align /product integrations with the connector registry.",
      codingOutput: "Updated integrations page headline.",
      changedFiles: ["src/app/product/integrations/page.tsx"],
    });
    assert.match(prompt, /Do NOT write or rewrite code/);
    assert.match(prompt, /## Verdict/);
    assert.match(prompt, /connector registry/);
    assert.match(prompt, /integrations\/page\.tsx/);
  });
});

describe("parseDevelopJudgeVerdict", () => {
  it("parses the controlled template: verdict, gaps, next turn", () => {
    const parsed = parseDevelopJudgeVerdict(
      [
        "## Verdict",
        "partial",
        "",
        "## Gaps",
        "- marketplace section still missing",
        "- no link from /product to /docs",
        "",
        "## Next coding turn",
        "Add the marketplace section to /product and link the docs.",
      ].join("\n"),
    );
    assert.equal(parsed.verdict, "partial");
    assert.deepEqual(parsed.gaps, [
      "marketplace section still missing",
      "no link from /product to /docs",
    ]);
    assert.equal(
      parsed.nextCodingTurn,
      "Add the marketplace section to /product and link the docs.",
    );
  });

  it("reads aligned with no gaps and continue as a clean pass", () => {
    const parsed = parseDevelopJudgeVerdict(
      "## Verdict\naligned\n\n## Gaps\nnone\n\n## Next coding turn\ncontinue",
    );
    assert.equal(parsed.verdict, "aligned");
    assert.deepEqual(parsed.gaps, []);
    assert.equal(parsed.nextCodingTurn, null);
  });

  it("reads off-track case-insensitively and tolerates extra prose after the token", () => {
    const parsed = parseDevelopJudgeVerdict(
      "## Verdict\nOff-track\n\n## Gaps\n- brief asked for a settings page; none exists\n",
    );
    assert.equal(parsed.verdict, "off-track");
    assert.equal(parsed.gaps.length, 1);
  });

  it("returns null verdict for a reply that ignores the template", () => {
    const parsed = parseDevelopJudgeVerdict(
      "I reviewed the code and it mostly looks fine, nice work.",
    );
    assert.equal(parsed.verdict, null);
    assert.deepEqual(parsed.gaps, []);
    assert.equal(parsed.nextCodingTurn, null);
  });
});

describe("develop pre-merge judge prompt", () => {
  it("frames the pre-merge judgement with brief, files, and checks", () => {
    const prompt = buildDevelopCompletionJudgePrompt({
      phaseTitle: "Product copy",
      brief: "Align /product with the connector registry.",
      changedFiles: ["src/app/product/page.tsx", "src/app/product/integrations/page.tsx"],
      checksSummary: "build ok, 42 tests pass",
    });
    assert.match(prompt, /PRE-MERGE judgement/);
    assert.match(prompt, /## Verdict/);
    assert.match(prompt, /off-track: the brief is NOT delivered/);
    assert.match(prompt, /connector registry/);
    assert.match(prompt, /src\/app\/product\/page\.tsx/);
    assert.match(prompt, /42 tests pass/);
  });
});
