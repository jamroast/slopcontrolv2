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

export const DependencyIntentSchema = z.object({
  useElement: z
    .object({
      id: z.string(),
      fromProject: z.string().optional(),
    })
    .optional(),
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

  // Sibling dirs under parent (even if not in store)
  const parent = join(opts.targetRoot, "..");
  for (const alias of [
    "burntjam",
    "basic-web-agent",
    "light-weight-crm-and-invoicing",
  ]) {
    const root = join(parent, alias);
    if (existsSync(root)) {
      consider({ name: alias, rootPath: root });
    }
  }

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
    /\bfrom\s+(jamroast|jam\s*roast|jamlight|jam\s*light|jampress|burntjam|registry|[\w.-]+)/i,
  );
  const fromProject = fromMatch?.[1]
    ? resolveShareAlias(fromMatch[1].replace(/\s+/g, " ").trim())
    : undefined;

  const elementMatch =
    t.match(
      /\b(?:use|import|pin|adopt|pull)\b.{0,40}\b(theme-toggle|[\w-]+-toggle|[\w-]+-control|[\w-]+-element)\b/i,
    ) || t.match(/\belement[:\s]+([\w-]+)\b/i);
  const useElement = elementMatch?.[1]
    ? { id: elementMatch[1].toLowerCase(), fromProject }
    : /\b(theme\s*toggle|day\s*\/\s*night\s*button)\b/i.test(t)
      ? { id: "theme-toggle", fromProject }
      : undefined;

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
    /\b(reuse|use|borrow|pull)\b.{0,50}\b(infra|infrastructure|packages?|shared\s+lib|components?)\b.{0,40}\bfrom\b/i.test(
      t,
    ) ||
    (Boolean(fromProject) &&
      /\b(infra|infrastructure|packages?|shared)\b/i.test(t));
  const useProjectInfra =
    infra && fromProject
      ? { projectName: fromProject }
      : fromProject && !useElement && !useNpmPackage
        ? { projectName: fromProject }
        : undefined;

  const mentionsLink = /\bnpm\s+link\b|\bpnpm\s+link\b|\byarn\s+link\b|\blink:/i.test(
    t,
  );

  return DependencyIntentSchema.parse({
    useElement,
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
  const has =
    intent.useElement ||
    intent.useNpmPackage ||
    intent.useProjectInfra ||
    intent.notes;
  if (!has) return "";
  const lines = [
    "## DEPENDENCY INTENT (authoritative — follow this; never npm link)",
    "",
    "CRITICAL: Do NOT recommend `npm link`, `pnpm link`, `yarn link`, or `file:`/`link:` installs into a sibling project's node_modules. Prefer SlopControl private registry (`npm_registry_ensure_rc` then `pnpm add @jam/…`).",
  ];
  if (intent.useElement) {
    lines.push(
      `- Use design element \`${intent.useElement.id}\`${
        intent.useElement.fromProject
          ? ` from project/alias \`${intent.useElement.fromProject}\``
          : ""
      } (MCP: design_element_import / list_design_elements).`,
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
  if (!intent.useElement && !intent.useNpmPackage && !intent.useProjectInfra) {
    return "";
  }
  const lines = [
    "When writing ## Task brief, include dependency bullets when relevant:",
  ];
  if (intent.useElement) {
    lines.push(
      `- Element: ${intent.useElement.id}${intent.useElement.fromProject ? ` (from ${intent.useElement.fromProject})` : ""}`,
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

  if (intent.useElement) {
    const hit = opts.catalog.elements.find(
      (e) => e.id === intent.useElement!.id,
    );
    recommended.push({
      action: "import_element",
      detail: hit
        ? `design_element_import elementId=${hit.id} (latest v${hit.latestVersion} via ${hit.origin})`
        : `design_element_import elementId=${intent.useElement.id} (resolve from sibling/registry)`,
      elementId: intent.useElement.id,
      from: intent.useElement.fromProject,
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
    !intent.useElement &&
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
