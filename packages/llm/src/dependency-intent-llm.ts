import {
  DependencyIntentSchema,
  normalizeDependencyIntentElements,
  type DependencyIntent,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const DEPENDENCY_INTENT_SYSTEM_PROMPT = `You classify operator messages about reusing design elements, npm packages, or infrastructure from sibling SlopControl projects into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY a JSON object with these fields:
- useElements: optional array of { id: string, fromProject?: string } — ALL named shared design elements (e.g. menubar, theme-toggle, sign-in, dashboard-shell, dashboard-sidebar, user-pill, view-switcher)
- useElement: optional { id: string, fromProject?: string } — legacy singular; if you set useElements, also set useElement to the first item
- importAllElementsFrom: optional string — sibling/registry project name when the operator wants ALL published elements from that project (e.g. "import the elements from the components project")
- useNpmPackage: optional { name: string, version?: string, fromProject?: string } — scoped package like @acme/theme-toggle
- useProjectInfra: optional { projectName?: string, rootPath?: string } — reuse packages/elements from a named project (not npm link)
- forbidNpmLink: boolean — always true
- notes: string — 1 sentence; if they asked for npm link / pnpm link, say to use the private registry instead

Rules:
- "use theme-toggle from MyBrand" → useElements=[{id:"theme-toggle", fromProject:"MyBrand"}], useElement=same
- Listed ids (menubar, theme-toggle, sign-in, …) → include EVERY listed id in useElements (do NOT collapse to theme-toggle only)
- "import the elements from the components project" / "import the design components from X" / "pull in the elements from X" → importAllElementsFrom="the components project" (or X as stated). Do NOT reduce this to theme-toggle-only.
- "add @acme/theme-toggle" / "pnpm add @…/…" → useNpmPackage
- "reuse packages from ProjectX" / "use infra from X" → useProjectInfra
- "using the components library" / "mock with X-components" without element language → useProjectInfra with projectName set
- "look and feel" / "match chrome" / "same menubar and theme toggle" from a named sibling → useElements for each named control (at least theme-toggle + menubar when both implied), importAllElementsFrom when they say elements/components plural, AND useProjectInfra with that projectName
- Never set forbidNpmLink to false. Prefer registry installs over link/file: sibling hacks.
- Omit fields that do not apply. Empty intent: all optional fields omitted, forbidNpmLink true, notes "".
`;

export interface ClassifyDependencyIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  timeoutMs?: number;
}

/**
 * @deprecated No longer used as a pre-gate — classification always runs when text is present.
 * Kept for tests that assert historical linking language cues.
 */
export function shouldClassifyDependencyIntent(text: string): boolean {
  const t = text ?? "";
  return (
    /@[\w.-]+\//.test(t) ||
    /\b(use|from|package|element|registry|pnpm\s+add|npm\s+add|npm\s+link|pnpm\s+link|shared\s+lib|infra(structure)?)\b/i.test(
      t,
    )
  );
}

/**
 * Classification-role JSON → DependencyIntent.
 * Success path: LLM JSON only (no regex merge). Callers catch → detectDependencyIntentFromText.
 */
export async function classifyDependencyIntentViaLlm(
  opts: ClassifyDependencyIntentViaLlmOptions,
): Promise<DependencyIntent> {
  const { parsed } = await chatJson({
    endpoint: opts.endpoint,
    modelId: opts.modelId,
    system: DEPENDENCY_INTENT_SYSTEM_PROMPT,
    user: [
      "Operator message (classify dependency / linking intent):",
      "",
      opts.message.slice(0, 4_000),
    ].join("\n"),
    timeoutMs: opts.timeoutMs ?? 90_000,
    temperature: 0,
  });

  const raw =
    typeof parsed === "object" && parsed != null
      ? (parsed as Record<string, unknown>)
      : {};

  const intent = DependencyIntentSchema.parse({
    ...raw,
    forbidNpmLink: true,
  });

  // Normalize: ensure useElements populated from useElement and vice versa.
  const els = normalizeDependencyIntentElements(intent);
  return DependencyIntentSchema.parse({
    ...intent,
    useElements: els,
    useElement: els[0] ?? intent.useElement,
    forbidNpmLink: true,
  });
}
