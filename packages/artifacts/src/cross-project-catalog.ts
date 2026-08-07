/**
 * Cross-project dependency catalog for ask / agent / plan / research.
 * Prefer private npm registry installs over npm link / file: sibling hacks.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  listProjectElements,
  listRegistryElements,
  type DesignElementIndexEntry,
} from "./design-element.js";
import {
  listNpmRegistryPackages,
  readNpmRegistryMeta,
  type NpmRegistryPackageInfo,
} from "./npm-registry.js";
import { resolveShareAlias } from "./design-share.js";

export const DependencyElementRefSchema = z.object({
  id: z.string().min(1),
  fromProject: z.string().optional(),
});
export type DependencyElementRef = z.infer<typeof DependencyElementRefSchema>;

export const DependencyIntentSchema = z.object({
  /** Legacy singular — prefer useElements. Kept as first item when normalizing. */
  useElement: DependencyElementRefSchema.optional(),
  /** One or more shared design elements to import. */
  useElements: z.array(DependencyElementRefSchema).default([]),
  /**
   * Import every published element from this sibling/registry project name.
   * Set when operator says "import the elements from &lt;project&gt;".
   */
  importAllElementsFrom: z.string().optional(),
  useNpmPackage: z
    .object({
      name: z.string(),
      version: z.string().optional(),
      fromProject: z.string().optional(),
    })
    .optional(),
  useProjectInfra: z
    .object({
      projectName: z.string().optional(),
      rootPath: z.string().optional(),
    })
    .optional(),
  /** Always true in formatted prompts — npm link is forbidden. */
  forbidNpmLink: z.boolean().default(true),
  notes: z.string().default(""),
});
export type DependencyIntent = z.infer<typeof DependencyIntentSchema>;

/** Known extractable chrome / control ids (list + import detection). */
export const KNOWN_DESIGN_ELEMENT_IDS = [
  "theme-toggle",
  "menubar",
  "sign-in",
  "user-pill",
  "view-switcher",
  "dashboard-sidebar",
  "dashboard-shell",
] as const;

/** Safe defaults when operator says “import the elements” on a landing mock. */
export const LANDING_CHROME_ELEMENT_IDS = new Set([
  "menubar",
  "theme-toggle",
  "sign-in",
  "user-pill",
  "view-switcher",
]);

export const DASHBOARD_ELEMENT_IDS = new Set([
  "dashboard-shell",
  "dashboard-sidebar",
]);

/** Merge useElement + useElements into a deduped list (useElement first). */
export function normalizeDependencyIntentElements(
  intent: DependencyIntent | null | undefined,
): DependencyElementRef[] {
  if (!intent) return [];
  const out: DependencyElementRef[] = [];
  const push = (ref: DependencyElementRef | undefined) => {
    const id = ref?.id?.trim().toLowerCase();
    if (!id) return;
    if (out.some((e) => e.id === id)) return;
    out.push({
      id,
      fromProject: ref?.fromProject?.trim() || undefined,
    });
  };
  push(intent.useElement);
  for (const e of intent.useElements ?? []) push(e);
  return out;
}

/**
 * Resolve which element ids to auto-import for a design-loop continue.
 * `importAllElementsFrom` expands via catalog — landing chrome by default;
 * dashboard-* only when the message names dashboard or lists those ids.
 */
export function listElementsToAutoImport(opts: {
  intent: DependencyIntent;
  catalog?: CrossProjectCatalog | null;
  /** Operator message — used to decide whether dashboard elements are wanted. */
  message?: string;
}): DependencyElementRef[] {
  const fromAll = opts.intent.importAllElementsFrom?.trim();
  const msg = opts.message ?? "";
  const wantsDashboard =
    /\bdashboard\b/i.test(msg) ||
    normalizeDependencyIntentElements(opts.intent).some((e) =>
      DASHBOARD_ELEMENT_IDS.has(e.id),
    );

  if (fromAll && opts.catalog) {
    const want = resolveShareAlias(fromAll).toLowerCase();
    const hits = opts.catalog.elements.filter((e) => {
      const pn = (e.projectName ?? "").toLowerCase();
      const origin = (e.origin ?? "").toLowerCase();
      return (
        pn === want ||
        pn === fromAll.toLowerCase() ||
        origin === `project:${want}` ||
        origin === `project:${fromAll.toLowerCase()}`
      );
    });
    const byId = new Map<string, DependencyElementRef>();
    for (const e of hits) {
      if (e.origin === "local") continue;
      // Bulk import: skip dashboard chrome unless explicitly requested.
      if (
        DASHBOARD_ELEMENT_IDS.has(e.id) &&
        !wantsDashboard
      ) {
        continue;
      }
      // Prefer known landing chrome; still allow other non-dashboard ids.
      if (
        !LANDING_CHROME_ELEMENT_IDS.has(e.id) &&
        !DASHBOARD_ELEMENT_IDS.has(e.id) &&
        !wantsDashboard
      ) {
        // keep unknown non-dashboard (e.g. future controls)
      }
      if (!byId.has(e.id)) {
        byId.set(e.id, {
          id: e.id,
          fromProject: e.projectName || fromAll,
        });
      }
    }
    if (byId.size) {
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
  }

  return normalizeDependencyIntentElements(opts.intent)
    .filter((e) => wantsDashboard || !DASHBOARD_ELEMENT_IDS.has(e.id))
    .map((e) => ({
      ...e,
      fromProject: e.fromProject || fromAll || undefined,
    }));
}

export type CatalogProjectSummary = {
  id?: string;
  name: string;
  rootPath: string;
  packageName?: string;
  jamDeps: string[];
  elementCount: number;
};

export type CrossProjectCatalog = {
  targetRoot: string;
  registryUrl?: string;
  elements: Array<DesignElementIndexEntry & { origin: string; projectName?: string }>;
  npmPackages: NpmRegistryPackageInfo[];
  projects: CatalogProjectSummary[];
};

export type ListProjectsFn = () => Array<{
  id: string;
  name: string;
  rootPath: string;
}>;

function readPackageJsonLight(root: string): {
  name?: string;
  jamDeps: string[];
} {
  const path = join(root, "package.json");
  if (!existsSync(path)) return { jamDeps: [] };
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const jamDeps: string[] = [];
    for (const bag of [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
    ]) {
      if (!bag) continue;
      for (const [k, v] of Object.entries(bag)) {
        if (k.startsWith("@jam/") || k.startsWith("@slopcontrol/")) {
          jamDeps.push(`${k}@${v}`);
        } else if (
          typeof v === "string" &&
          (v.startsWith("file:") || v.startsWith("link:") || v.startsWith("workspace:"))
        ) {
          jamDeps.push(`${k}@${v}`);
        }
      }
    }
    return { name: pkg.name, jamDeps: [...new Set(jamDeps)].slice(0, 40) };
  } catch {
    return { jamDeps: [] };
  }
}

export function buildCrossProjectCatalog(opts: {
  targetRoot: string;
  dataDir?: string;
  listProjects?: ListProjectsFn;
}): CrossProjectCatalog {
  const projects = opts.listProjects?.() ?? [];
  const elements: CrossProjectCatalog["elements"] = [];

  const pushElements = (
    entries: DesignElementIndexEntry[],
    origin: string,
    projectName?: string,
  ) => {
    for (const e of entries) {
      elements.push({ ...e, origin, projectName });
    }
  };

  pushElements(listProjectElements(opts.targetRoot), "local", "this-project");
  if (opts.dataDir) {
    pushElements(listRegistryElements(opts.dataDir), "registry", "registry");
  }

  const projectSummaries: CatalogProjectSummary[] = [];
  const seenRoots = new Set<string>();

  const consider = (p: {
    id?: string;
    name: string;
    rootPath: string;
  }) => {
    const root = p.rootPath.replace(/\/$/, "");
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    const light = readPackageJsonLight(root);
    const els = listProjectElements(root);
    if (root !== opts.targetRoot.replace(/\/$/, "")) {
      pushElements(els, `project:${p.name}`, p.name);
    }
    projectSummaries.push({
      id: p.id,
      name: p.name,
      rootPath: root,
      packageName: light.name,
      jamDeps: light.jamDeps,
      elementCount: els.length,
    });
  };

  consider({
    name: basename(opts.targetRoot.replace(/\/$/, "")) || "target",
    rootPath: opts.targetRoot,
  });
  for (const p of projects) consider(p);

  const npmPackages = opts.dataDir
    ? listNpmRegistryPackages(opts.dataDir)
    : [];
  const registryUrl = opts.dataDir
    ? readNpmRegistryMeta(opts.dataDir)?.url
    : undefined;

  // Dedupe elements by id@origin keeping highest version
  const byKey = new Map<string, CrossProjectCatalog["elements"][number]>();
  for (const e of elements) {
    const key = `${e.origin}::${e.id}`;
    const prior = byKey.get(key);
    if (!prior || e.latestVersion >= prior.latestVersion) byKey.set(key, e);
  }

  return {
    targetRoot: opts.targetRoot,
    registryUrl,
    elements: [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id)),
    npmPackages,
    projects: projectSummaries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Regex fallback for dependency / linking language. */
export function detectDependencyIntentFromText(text: string): DependencyIntent {
  const t = text ?? "";
  const fromMatch = t.match(
    /\bfrom\s+(?:the\s+)?(?:project\s+)?(registry|[\w.-]+)/i,
  );
  const fromProject = fromMatch?.[1]
    ? resolveShareAlias(fromMatch[1].replace(/\s+/g, " ").trim())
    : undefined;

  const bulkMatch = t.match(
    /\b(?:import|pull|use|adopt|pin)\b[\s\S]{0,100}?\b(?:the\s+)?(?:shared\s+)?(?:design\s+)?(?:elements|components)\b[\s\S]{0,60}?\bfrom\s+(?:the\s+)?(?:project\s+)?([\w.-]+)/i,
  );
  const importAllElementsFrom = bulkMatch?.[1]
    ? resolveShareAlias(bulkMatch[1].replace(/\s+/g, " ").trim())
    : undefined;

  const useElements: DependencyElementRef[] = [];
  const pushEl = (id: string) => {
    const slug = id.trim().toLowerCase();
    if (!slug || useElements.some((e) => e.id === slug)) return;
    useElements.push({
      id: slug,
      fromProject: fromProject || importAllElementsFrom,
    });
  };

  for (const id of KNOWN_DESIGN_ELEMENT_IDS) {
    if (new RegExp(`\\b${id.replace(/-/g, "[-\\s]?")}\\b`, "i").test(t)) {
      pushEl(id);
    }
  }
  // Generic *-toggle / *-control / *-element (excluding already known)
  for (const m of t.matchAll(
    /\b(?:use|import|pin|adopt|pull)\b.{0,60}\b([\w-]+(?:-toggle|-control|-element))\b/gi,
  )) {
    if (m[1]) pushEl(m[1]);
  }
  for (const m of t.matchAll(/\belement[:\s]+([\w-]+)\b/gi)) {
    if (m[1]) pushEl(m[1]);
  }
  if (
    !useElements.some((e) => e.id === "theme-toggle") &&
    /\b(theme\s*toggle|day\s*\/\s*night\s*button)\b/i.test(t)
  ) {
    pushEl("theme-toggle");
  }

  const useElement = useElements[0];

  const pkgMatch =
    t.match(/@(jam|slopcontrol)\/([\w.-]+)(?:@([\w.^~*-]+))?/i) ||
    t.match(
      /\b(?:pnpm|npm)\s+add\s+(@?(?:jam|slopcontrol)\/[\w.-]+(?:@[\w.^~*-]+)?)/i,
    );
  let useNpmPackage: DependencyIntent["useNpmPackage"];
  if (pkgMatch) {
    if (pkgMatch[2] && pkgMatch[1]) {
      useNpmPackage = {
        name: `@${pkgMatch[1].toLowerCase()}/${pkgMatch[2]}`,
        version: pkgMatch[3],
        fromProject,
      };
    } else if (pkgMatch[1]?.includes("/")) {
      const raw = pkgMatch[1];
      const [name, version] = raw.includes("@", 1)
        ? [raw.slice(0, raw.indexOf("@", 1)), raw.slice(raw.indexOf("@", 1) + 1)]
        : [raw, undefined];
      useNpmPackage = {
        name: name.startsWith("@") ? name : `@${name}`,
        version,
        fromProject,
      };
    }
  }

  const infra =
    /\b(reuse|use|borrow|pull)\b.{0,50}\b(infra|infrastructure|packages?|shared\s+lib)\b.{0,40}\bfrom\b/i.test(
      t,
    ) ||
    (Boolean(fromProject) &&
      /\b(infra|infrastructure|packages?|shared)\b/i.test(t) &&
      !importAllElementsFrom);
  const useProjectInfra =
    infra && fromProject
      ? { projectName: fromProject }
      : fromProject &&
          !useElement &&
          !useNpmPackage &&
          !importAllElementsFrom &&
          useElements.length === 0
        ? { projectName: fromProject }
        : importAllElementsFrom && !useNpmPackage
          ? { projectName: importAllElementsFrom }
          : undefined;

  const mentionsLink = /\bnpm\s+link\b|\bpnpm\s+link\b|\byarn\s+link\b|\blink:/i.test(
    t,
  );

  return DependencyIntentSchema.parse({
    useElement,
    useElements,
    importAllElementsFrom,
    useNpmPackage,
    useProjectInfra,
    forbidNpmLink: true,
    notes: mentionsLink
      ? "Operator mentioned link — refuse npm/pnpm link; use private registry instead."
      : "",
  });
}

export function formatDependencyIntentPromptBlock(
  intent: DependencyIntent | null | undefined,
): string {
  if (!intent) return "";
  const els = normalizeDependencyIntentElements(intent);
  const has =
    els.length > 0 ||
    intent.importAllElementsFrom ||
    intent.useNpmPackage ||
    intent.useProjectInfra ||
    intent.notes;
  if (!has) return "";
  const lines = [
    "## DEPENDENCY INTENT (authoritative — follow this; never npm link)",
    "",
    "CRITICAL: Do NOT recommend `npm link`, `pnpm link`, `yarn link`, or `file:`/`link:` installs into a sibling project's node_modules. Prefer SlopControl private registry (`npm_registry_ensure_rc` then `pnpm add @jam/…`).",
  ];
  if (intent.importAllElementsFrom) {
    lines.push(
      `- Import ALL published design elements from \`${intent.importAllElementsFrom}\` (orchestrator auto-imports; apply pinned SHARED ELEMENTS to the mock).`,
    );
  }
  for (const el of els) {
    lines.push(
      `- Use design element \`${el.id}\`${
        el.fromProject ? ` from project/alias \`${el.fromProject}\`` : ""
      } (auto-imported into the loop; embed in mock).`,
    );
  }
  if (intent.useNpmPackage) {
    const ver = intent.useNpmPackage.version
      ? `@${intent.useNpmPackage.version}`
      : "";
    lines.push(
      `- Install npm package \`${intent.useNpmPackage.name}${ver}\` from the private registry (ensure_rc → pnpm add).${
        intent.useNpmPackage.fromProject
          ? ` Source context: ${intent.useNpmPackage.fromProject}.`
          : ""
      }`,
    );
  }
  if (intent.useProjectInfra) {
    lines.push(
      `- Reuse infrastructure/packages from \`${intent.useProjectInfra.projectName ?? intent.useProjectInfra.rootPath}\` via published @jam/@slopcontrol packages or design elements — inspect that project in the catalog; do not copy node_modules or link.`,
    );
  }
  if (intent.notes.trim()) lines.push(`- Note: ${intent.notes.trim()}`);
  return lines.join("\n");
}

export function formatCrossProjectCatalogPromptBlock(
  catalog: CrossProjectCatalog | null | undefined,
  maxChars = 4_500,
): string {
  if (!catalog) return "";
  const lines: string[] = [
    "## CROSS-PROJECT DEPS (elements + private npm + registered projects)",
    "",
    "CRITICAL: Prefer registry installs (@jam/*, @slopcontrol/*) over inventing duplicates or npm link. UI controls → design elements (+ npmPackage when set).",
  ];
  if (catalog.registryUrl) {
    lines.push(`Private registry: ${catalog.registryUrl}`);
  }
  lines.push("");
  lines.push("### Design elements");
  if (!catalog.elements.length) {
    lines.push("- (none indexed — publish/extract elements or check siblings)");
  } else {
    for (const e of catalog.elements.slice(0, 40)) {
      const npm = e.npmPackage
        ? ` npm=${e.npmPackage}@${e.npmVersion ?? e.latestVersion}`
        : e.hasCode
          ? " [hasCode]"
          : "";
      lines.push(
        `- ${e.id}@${e.latestVersion} (${e.kind}) via ${e.origin}${e.projectName ? `/${e.projectName}` : ""}${npm}`,
      );
    }
  }
  lines.push("");
  lines.push("### Private npm packages");
  if (!catalog.npmPackages.length) {
    lines.push("- (none in registry storage — design_element_publish_npm or npm_registry_publish)");
  } else {
    for (const p of catalog.npmPackages.slice(0, 30)) {
      lines.push(`- ${p.name}@${p.latest ?? p.versions[p.versions.length - 1] ?? "?"}`);
    }
  }
  lines.push("");
  lines.push("### Registered / sibling projects");
  for (const p of catalog.projects.slice(0, 16)) {
    lines.push(
      `- ${p.name}${p.packageName ? ` (${p.packageName})` : ""} — elements:${p.elementCount} jamDeps:${p.jamDeps.slice(0, 6).join(", ") || "none"}`,
    );
  }
  const body = lines.join("\n");
  return body.length <= maxChars
    ? body
    : `${body.slice(0, maxChars)}\n…[truncated CROSS-PROJECT DEPS]`;
}

export function formatAskDependencyTaskBriefNudge(
  intent: DependencyIntent | null | undefined,
): string {
  if (!intent) return "";
  const els = normalizeDependencyIntentElements(intent);
  if (
    !els.length &&
    !intent.importAllElementsFrom &&
    !intent.useNpmPackage &&
    !intent.useProjectInfra
  ) {
    return "";
  }
  const lines = [
    "When writing ## Task brief, include dependency bullets when relevant:",
  ];
  if (intent.importAllElementsFrom) {
    lines.push(
      `- Import all elements from: ${intent.importAllElementsFrom}`,
    );
  }
  for (const el of els) {
    lines.push(
      `- Element: ${el.id}${el.fromProject ? ` (from ${el.fromProject})` : ""}`,
    );
  }
  if (intent.useNpmPackage) {
    lines.push(
      `- Package: ${intent.useNpmPackage.name}${intent.useNpmPackage.version ? `@${intent.useNpmPackage.version}` : ""} (private registry — not npm link)`,
    );
  }
  if (intent.useProjectInfra) {
    lines.push(
      `- From project: ${intent.useProjectInfra.projectName ?? intent.useProjectInfra.rootPath}`,
    );
  }
  return lines.join("\n");
}

export type ResolvedDependencyAction =
  | "import_element"
  | "pnpm_add"
  | "ensure_rc"
  | "inspect_project"
  | "none";

export function resolveDependencyRecommendation(opts: {
  text?: string;
  intent?: DependencyIntent;
  catalog: CrossProjectCatalog;
  elementId?: string;
  packageName?: string;
  fromName?: string;
}): {
  intent: DependencyIntent;
  recommended: Array<{
    action: ResolvedDependencyAction;
    detail: string;
    elementId?: string;
    packageName?: string;
    version?: string;
    from?: string;
  }>;
} {
  const intent =
    opts.intent ??
    detectDependencyIntentFromText(
      [
        opts.text ?? "",
        opts.elementId ? `use element ${opts.elementId}` : "",
        opts.packageName ? `pnpm add ${opts.packageName}` : "",
        opts.fromName ? `from ${opts.fromName}` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );

  const recommended: Array<{
    action: ResolvedDependencyAction;
    detail: string;
    elementId?: string;
    packageName?: string;
    version?: string;
    from?: string;
  }> = [];

  recommended.push({
    action: "ensure_rc",
    detail:
      "Call npm_registry_ensure_rc on the consumer project before any pnpm add of @jam/@slopcontrol packages.",
  });

  const toImport = listElementsToAutoImport({
    intent,
    catalog: opts.catalog,
  });
  for (const el of toImport) {
    const hit = opts.catalog.elements.find((e) => e.id === el.id);
    recommended.push({
      action: "import_element",
      detail: hit
        ? `design_element_import elementId=${hit.id} (latest v${hit.latestVersion} via ${hit.origin})`
        : `design_element_import elementId=${el.id} (resolve from sibling/registry)`,
      elementId: el.id,
      from: el.fromProject,
      packageName: hit?.npmPackage,
      version: hit?.npmVersion,
    });
    if (hit?.npmPackage) {
      recommended.push({
        action: "pnpm_add",
        detail: `pnpm add ${hit.npmPackage}@${hit.npmVersion ?? "latest"}`,
        packageName: hit.npmPackage,
        version: hit.npmVersion,
      });
    }
  }

  if (intent.useNpmPackage) {
    recommended.push({
      action: "pnpm_add",
      detail: `pnpm add ${intent.useNpmPackage.name}${intent.useNpmPackage.version ? `@${intent.useNpmPackage.version}` : ""}`,
      packageName: intent.useNpmPackage.name,
      version: intent.useNpmPackage.version,
      from: intent.useNpmPackage.fromProject,
    });
  }

  if (intent.useProjectInfra) {
    recommended.push({
      action: "inspect_project",
      detail: `Inspect catalog entry for ${intent.useProjectInfra.projectName} — reuse published packages/elements only (no npm link).`,
      from: intent.useProjectInfra.projectName,
    });
  }

  if (
    !toImport.length &&
    !intent.importAllElementsFrom &&
    !intent.useNpmPackage &&
    !intent.useProjectInfra
  ) {
    recommended.push({
      action: "none",
      detail: "No concrete element/package intent detected — use list_cross_project_deps.",
    });
  }

  return { intent, recommended };
}

/** Parse PLAN.md / notes for dependency lines into structured deps. */
export function parsePlanDependencyLines(text: string): Array<{
  kind: "element" | "npm" | "project";
  id: string;
  version?: string;
  from?: string;
}> {
  const out: Array<{
    kind: "element" | "npm" | "project";
    id: string;
    version?: string;
    from?: string;
  }> = [];
  const lines = (text ?? "").split("\n");
  for (const line of lines) {
    const from = line.match(/\bfrom\s+([\w.-]+)/i)?.[1];
    const npm = line.match(/@(jam|slopcontrol)\/([\w.-]+)(?:@([\w.^~*-]+))?/i);
    if (npm) {
      out.push({
        kind: "npm",
        id: `@${npm[1]}/${npm[2]}`,
        version: npm[3],
        from,
      });
      continue;
    }
    const el = line.match(
      /\belement[:\s]+([\w-]+)|deps?:\s*(theme-toggle|[\w-]+-toggle)/i,
    );
    if (el) {
      out.push({
        kind: "element",
        id: (el[1] || el[2] || "").toLowerCase(),
        from,
      });
      continue;
    }
    if (/\bfrom\s+project\s+([\w.-]+)/i.test(line) || /\bproject:\s*([\w.-]+)/i.test(line)) {
      const name =
        line.match(/\bfrom\s+project\s+([\w.-]+)/i)?.[1] ||
        line.match(/\bproject:\s*([\w.-]+)/i)?.[1];
      if (name) out.push({ kind: "project", id: name, from: name });
    }
  }
  // dedupe
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = `${d.kind}:${d.id}:${d.version ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return Boolean(d.id);
  });
}
