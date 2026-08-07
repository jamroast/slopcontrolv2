import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ELEMENT_HONOR_SYSTEM_PROMPT,
  ElementHonorResultSchema,
  buildElementHonorSnippets,
} from "./element-honor-llm.js";

describe("element-honor-llm", () => {
  it("system prompt distinguishes BEM children from competing controls", () => {
    assert.match(ELEMENT_HONOR_SYSTEM_PROMPT, /JSON/);
    assert.match(ELEMENT_HONOR_SYSTEM_PROMPT, /theme-toggle__sun/);
    assert.match(ELEMENT_HONOR_SYSTEM_PROMPT, /competingThemeControl/);
    assert.match(ELEMENT_HONOR_SYSTEM_PROMPT, /NOT competing/i);
  });

  it("parses honor schema fixtures", () => {
    const honor = ElementHonorResultSchema.parse({
      honorsPinnedElements: true,
      competingThemeControl: false,
      missingMenubar: false,
      missingThemeToggle: false,
      notes: "Menubar and single theme toggle honored.",
      confidence: "high",
    });
    assert.equal(honor.honorsPinnedElements, true);
    assert.equal(honor.competingThemeControl, false);

    const competing = ElementHonorResultSchema.parse({
      honorsPinnedElements: false,
      competingThemeControl: true,
      missingMenubar: false,
      missingThemeToggle: false,
      notes: "Second day/night button outside menubar.",
      confidence: "high",
    });
    assert.equal(competing.competingThemeControl, true);
  });

  it("buildElementHonorSnippets extracts header and toggle", () => {
    const html = `
      <html><body>
      <header class="menubar">
        <button class="theme-toggle"><svg class="theme-toggle__sun"></svg></button>
      </header>
      <main>x</main>
      </body></html>
    `;
    const snip = buildElementHonorSnippets(html);
    assert.match(snip, /menubar/);
    assert.match(snip, /theme-toggle/);
  });
});
