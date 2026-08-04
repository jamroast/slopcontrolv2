import {
  DependencyIntentSchema,
  detectDependencyIntentFromText,
  type DependencyIntent,
} from "@slopcontrol/artifacts";
import type { LlmEndpoint } from "@slopcontrol/types";
import { chatJson } from "./json-chat.js";

export const DEPENDENCY_INTENT_SYSTEM_PROMPT = `You classify operator messages about reusing design elements, npm packages, or infrastructure from sibling SlopControl projects into structured JSON.

CRITICAL: Output ONLY a single JSON object. No prose, no markdown fences.

Return ONLY a JSON object with these fields:
- useElement: optional { id: string, fromProject?: string } — when the operator wants a shared design control (e.g. theme-toggle from jamroast)
- useNpmPackage: optional { name: string, version?: string, fromProject?: string } — scoped package like @jam/theme-toggle
- useProjectInfra: optional { projectName?: string, rootPath?: string } — reuse packages/elements from a named project (not npm link)
- forbidNpmLink: boolean — always true
- notes: string — 1 sentence; if they asked for npm link / pnpm link, say to use the private registry instead

Rules:
- "use theme-toggle from jamroast" → useElement={id:"theme-toggle", fromProject:"jamroast"} (or burntjam alias)
- "add @jam/theme-toggle" / "pnpm add @jam/…" → useNpmPackage
- "reuse packages from jamroast" / "use infra from X" → useProjectInfra
- Never set forbidNpmLink to false. Prefer registry installs over link/file: sibling hacks.
- Omit fields that do not apply. Empty intent: all optional fields omitted, forbidNpmLink true, notes "".
`;

export interface ClassifyDependencyIntentViaLlmOptions {
  endpoint: LlmEndpoint;
  modelId?: string;
  message: string;
  timeoutMs?: number;
}

/** True when the message likely mentions cross-project deps / linking. */
export function shouldClassifyDependencyIntent(text: string): boolean {
  const t = text ?? "";
  return (
    /@(jam|slopcontrol)\//i.test(t) ||
    /\b(use|from|package|element|jamroast|jam\s*roast|jamlight|jampress|burntjam|registry|pnpm\s+add|npm\s+add|npm\s+link|pnpm\s+link|shared\s+lib|infra(structure)?)\b/i.test(
      t,
    )
  );
}

/**
 * Classification-role JSON → DependencyIntent.
 * Callers should catch and fall back to detectDependencyIntentFromText.
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
    timeoutMs: opts.timeoutMs ?? 12_000,
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
  const fallback = detectDependencyIntentFromText(opts.message);
  return DependencyIntentSchema.parse({
    useElement: intent.useElement ?? fallback.useElement,
    useNpmPackage: intent.useNpmPackage ?? fallback.useNpmPackage,
    useProjectInfra: intent.useProjectInfra ?? fallback.useProjectInfra,
    forbidNpmLink: true,
    notes: intent.notes?.trim() || fallback.notes,
  });
}
