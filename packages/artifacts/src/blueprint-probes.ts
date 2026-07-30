import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type MountProbe = "composer" | "bubble" | "none" | "both";

export type ProjectDecisionProbes = {
  mount: MountProbe;
  hasComposerFormTestId: boolean;
  hasComposerSurface: boolean;
  hasActionableBubbleForm: boolean;
  hasFormClassificationHelpers: boolean;
  evidence: string[];
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".slopcontrol",
  // Test trees are not product evidence — strings like actionable={true} in
  // assertions otherwise flip mount to "both".
  "tests",
  "test",
  "__tests__",
  "e2e",
  "cypress",
  "playwright",
  "__mocks__",
  "fixtures",
]);

const SOURCE_ROOT_CANDIDATES = ["src", "app", "apps", "packages"];

function isUnderSkippedDir(relPath: string): boolean {
  const parts = relPath.split(/[/\\]/).filter(Boolean);
  return parts.some((p) => SKIP_DIRS.has(p));
}

function walkSourceFiles(root: string, maxFiles = 400): string[] {
  const out: string[] = [];
  const preferredRoots = SOURCE_ROOT_CANDIDATES.map((d) => join(root, d)).filter(
    (p) => existsSync(p),
  );
  const stack =
    preferredRoots.length > 0 ? [...preferredRoots] : [root];

  while (stack.length > 0 && out.length < maxFiles) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".slopcontrol") continue;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      if (isUnderSkippedDir(rel)) continue;
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!/\.(tsx?|jsx?|vue|svelte)$/i.test(name)) continue;
      // Prefer product paths: deprioritize *.test.* / *.spec.* if any slip through
      if (/\.(test|spec)\./i.test(name)) continue;
      out.push(full);
    }
  }
  return out;
}

function readSafe(path: string, max = 200_000): string {
  try {
    return readFileSync(path, "utf-8").slice(0, max);
  } catch {
    return "";
  }
}

function pushEvidence(evidence: string[], line: string): void {
  if (evidence.length >= 20) return;
  if (evidence.includes(line)) return;
  evidence.push(line);
}

/**
 * Deterministic probes against a project tree so Live decisions can be
 * split into verified vs claimed-unverified.
 *
 * Mount axis:
 * - Composer: `data-testid="composer-form"` or ComposerSurface form mode
 * - Bubble: interactive FormBubble in the transcript (not inside composer-form)
 */
export function probeProjectForDecisions(
  projectRoot: string,
): ProjectDecisionProbes {
  const evidence: string[] = [];
  if (!existsSync(projectRoot)) {
    return {
      mount: "none",
      hasComposerFormTestId: false,
      hasComposerSurface: false,
      hasActionableBubbleForm: false,
      hasFormClassificationHelpers: false,
      evidence: ["project root missing"],
    };
  }

  const files = walkSourceFiles(projectRoot);
  let hasComposerFormTestId = false;
  let hasComposerSurface = false;
  let hasActionableBubbleForm = false;
  let hasFormClassificationHelpers = false;

  for (const file of files) {
    const body = readSafe(file);
    if (!body) continue;
    const rel = relative(projectRoot, file).split(sep).join("/");
    const inComposerFile =
      /composer-surface/i.test(rel) ||
      /data-testid\s*=\s*["']composer-form["']/.test(body);

    if (/data-testid\s*=\s*["']composer-form["']/.test(body)) {
      hasComposerFormTestId = true;
      pushEvidence(evidence, `${rel}: data-testid=composer-form`);
    }
    if (
      /\bComposerSurface\b/.test(body) ||
      /composerMode\s*===\s*["']form["']/.test(body)
    ) {
      hasComposerSurface = true;
      pushEvidence(evidence, `${rel}: ComposerSurface/form mode`);
    }

    // Transcript interactive bubble only — ignore FormBubble inside composer.
    if (!inComposerFile) {
      const actionableTrue =
        /<FormBubble\b[^>]*\bactionable=\{true\}/.test(body) ||
        /FormBubble\s*\([^)]*actionable\s*:\s*true/.test(body);
      // Boolean shorthand on JSX is also interactive, but only count it in
      // transcript-ish paths (chat-messages), not generic wrappers.
      const actionableShorthandInTranscript =
        /chat-messages|message-list|transcript/i.test(rel) &&
        /<FormBubble\b[^>]*\bactionable(?:\s|\/|>)/.test(body) &&
        !/<FormBubble\b[^>]*\bactionable=\{false\}/.test(body);

      if (actionableTrue || actionableShorthandInTranscript) {
        hasActionableBubbleForm = true;
        pushEvidence(evidence, `${rel}: FormBubble actionable (transcript)`);
      }
    }

    if (
      /\bgetFormPartState\b/.test(body) ||
      /\bextractActiveForm\b/.test(body)
    ) {
      hasFormClassificationHelpers = true;
    }
  }

  const composer = hasComposerFormTestId || hasComposerSurface;
  const bubble = hasActionableBubbleForm;
  let mount: MountProbe = "none";
  if (composer && bubble) mount = "both";
  else if (composer) mount = "composer";
  else if (bubble) mount = "bubble";

  return {
    mount,
    hasComposerFormTestId,
    hasComposerSurface,
    hasActionableBubbleForm,
    hasFormClassificationHelpers,
    evidence: evidence.slice(0, 20),
  };
}

/** Whether a BD id is mount-related. */
export function isMountBdId(id: string): boolean {
  return (
    id === "BD-IN-BUBBLE-FORMS" ||
    /^BD-COMPOSER-FORM-MODE/.test(id) ||
    id === "BD-COMPOSER-FORM-OVERRIDE" ||
    id === "BD-COMPOSER-FORM-ENGAGEMENT" ||
    id === "BD-COMPOSER-READY-REOPEN"
  );
}

/**
 * Classify a BD as verified by probes (mount axis) or leave claimed.
 * When mount is "both", mount BDs stay claimed (ambiguous evidence).
 */
export function bdVerifiedByProbes(
  id: string,
  probes: ProjectDecisionProbes,
): boolean {
  if (!isMountBdId(id)) {
    // Soft: classification helpers only verify engagement BDs when mount is known
    if (
      /^BD-(FORM-KEY|TRANSCRIPT|ACTIVE-FORM|ACTIVE-CHIP)/.test(id) &&
      probes.hasFormClassificationHelpers &&
      probes.mount !== "none" &&
      probes.mount !== "both"
    ) {
      return true;
    }
    return false;
  }
  if (probes.mount === "both" || probes.mount === "none") {
    return false;
  }
  if (/^BD-COMPOSER-FORM|^BD-COMPOSER-READY/.test(id)) {
    return probes.mount === "composer";
  }
  if (id === "BD-IN-BUBBLE-FORMS") {
    return probes.mount === "bubble";
  }
  return false;
}
