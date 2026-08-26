/**
 * Strip agent chain-of-thought / chat preamble and return the markdown document.
 * Prefers explicitly fenced ```markdown / ```md blocks only (bare ``` is ignored —
 * blueprints often contain code fences for package.json, YAML, SQL, diagrams).
 * Else prefers a document title heading (`# Phase`, `# RESEARCH`, …) outside fences.
 */

const DOC_TITLE_RE =
  /^#\s+(Phase\b|RESEARCH\b|Research\b|Blueprint\b|BLUEPRINT\b|Roadmap\b|UI-SPEC\b|UI Spec\b)/i;

/**
 * Find the start index of the first ATX heading that is outside a fenced code block.
 * When `preferDocTitle` is true, prefer `# Phase` / `# RESEARCH` / etc.
 */
function findAtxHeadingIndex(
  text: string,
  opts?: { preferDocTitle?: boolean },
): number {
  const lines = text.split("\n");
  let offset = 0;
  let inFence = false;
  let fenceMarker = "";
  let firstAny = -1;
  let preferred = -1;

  for (const line of lines) {
    const fenceOpen = /^(```|~~~)([^\n`]*)$/.exec(line);
    if (fenceOpen) {
      const marker = fenceOpen[1] ?? "```";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (line.startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = "";
      }
      offset += line.length + 1;
      continue;
    }

    if (!inFence && /^#\s+\S/.test(line)) {
      if (firstAny < 0) firstAny = offset;
      if (opts?.preferDocTitle !== false && DOC_TITLE_RE.test(line)) {
        preferred = offset;
        break;
      }
    }
    offset += line.length + 1;
  }

  if (preferred >= 0) return preferred;
  if (opts?.preferDocTitle === false) return firstAny;

  // No preferred title — still avoid in-fence headings (firstAny already outside).
  return firstAny;
}

/**
 * If the agent glued the title mid-line (`…rewrite it.# Phase 31-…`), promote it
 * to a real ATX heading so extraction can find it.
 * Do not touch real `##` / `###` headings.
 */
function promoteMidLineDocTitle(text: string): string {
  return text.replace(
    /(?<=\S)(?<!#)(#\s+(?:Phase|RESEARCH|Research|Blueprint|BLUEPRINT|Roadmap|UI-SPEC|UI Spec)\b[^\n]*)/gi,
    "\n$1",
  );
}

export function extractMarkdownDocument(raw: string): string {
  const text = promoteMidLineDocTitle(raw.replace(/\r\n/g, "\n")).trim();
  if (!text) return "";

  const fence = text.match(/```(?:markdown|md)\s*\n([\s\S]*?)```/i);
  if (fence?.[1]?.trim()) {
    return stripCompletionTokens(fence[1].trim());
  }

  const headingIdx = findAtxHeadingIndex(text, { preferDocTitle: true });
  if (headingIdx >= 0) {
    return stripCompletionTokens(text.slice(headingIdx).trim());
  }

  return stripCompletionTokens(text);
}

const COMPLETION_LINE =
  /^(RESEARCH_COMPLETE|PHASE_COMPLETE|BLUEPRINT_COMPLETE|DEV_COMPLETE|DEV_BLOCKED|DESIGN_COMPLETE|UI_SPEC_COMPLETE)\s*$/gm;

export function stripCompletionTokens(markdown: string): string {
  return markdown.replace(COMPLETION_LINE, "").trim();
}

/**
 * Extract a named ## Section body until the next ## heading.
 */
export function extractSection(
  markdown: string,
  sectionTitle: RegExp | string,
): string | null {
  const title =
    typeof sectionTitle === "string"
      ? new RegExp(
          `^##\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
          "im",
        )
      : sectionTitle;

  const lines = markdown.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (title.test(lines[i] ?? "")) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start, end).join("\n").trim();
  return body || null;
}

/**
 * Consolidate long text by keeping the head AND tail and dropping only the
 * middle, rather than naive head-truncation (which loses the tail — e.g. a
 * Blueprint Deltas section or a Risks section that a downstream judge needs).
 *
 * Splits the budget 50/50 between head and tail and inserts a marker showing
 * how much was dropped, so the reader knows the excerpt is not complete.
 */
export function consolidateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n…[truncated ${text.length - maxChars} chars]\n`;
  const budget = maxChars - marker.length;
  const headChars = Math.ceil(budget / 2);
  const tailChars = budget - headChars;
  return (
    text.slice(0, headChars) +
    marker +
    text.slice(text.length - tailChars)
  );
}
