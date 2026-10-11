import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildMarketingDraftPrompt,
  finalizeMarketingDraft,
} from "./marketing-generate.js";

describe("marketing draft gates", () => {
  it("puts the previous judge gaps and suggested fixes in the draft prompt", () => {
    const prompt = buildMarketingDraftPrompt({
      loopId: "loop-1",
      version: 2,
      brief: "Take the landing to market",
      findings: "Competitor page fetched at https://example.com",
      retryBlock:
        "Prior MARKETING.md was rejected by the quality judge — address every gap below in the rewritten draft:\n- No source URL\nSuggested fixes:\n- Cite the fetched page",
    });
    assert.match(prompt, /No source URL/);
    assert.match(prompt, /Cite the fetched page/);
    assert.match(prompt, /claim: <id> \| gap/);
  });

  it("keeps the prior doc when a sections continue shrinks it", () => {
    const prior = ["# Marketing — launch", ...Array.from({ length: 40 }, (_, i) => `line ${i}`)].join("\n");
    const raw = "```markdown\n# Marketing\n\n## Audience\n\nshort\n```";
    const result = finalizeMarketingDraft({
      raw,
      brief: "launch",
      previousDoc: prior,
      continueScope: "sections",
    });
    assert.equal(result.usedScaffold, true);
    assert.equal(result.doc, prior);
  });
});
