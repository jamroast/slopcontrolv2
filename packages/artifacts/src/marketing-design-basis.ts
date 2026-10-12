/**
 * Existing visual system for a marketing release: pinned/canonical logos
 * and landing elements published by packages this project already depends on.
 * Structural lookup only — no intent classification.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import {
  buildCrossProjectCatalog,
  LANDING_CHROME_ELEMENT_IDS,
  type ListProjectsFn,
} from "./cross-project-catalog.js";
import {
  getDesignLoopElements,
  importDesignElementIntoLoop,
  listProjectElements,
  resolveDesignElement,
} from "./design-element.js";
import { readDesignLoopMeta, writeDesignLoopMeta } from "./design-loop.js";
import {
  getDesignLoopSelections,
  pinDesignLoopLogoAsset,
} from "./design-loop-selections.js";
import {
  importProjectBrandAssetsIntoLoop,
  importProjectPriorDesignIntoLoop,
  pickProjectBrandAssets,
  pickProjectPriorDesign,
  readProjectBrandAssetsImport,
  readProjectPriorDesignImport,
} from "./design-share.js";
import { buildLiveSiteInventory } from "./live-site-inventory.js";

const CANONICAL_LOGO_RE =
  /^(logo|logo-light|logo-dark|logo-mark|wordmark)\.[a-z0-9]+$/i;

export type MarketingDesignLogo = {
  name: string;
  path: string;
  pinned: boolean;
};

export type MarketingDesignElement = {
  id: string;
  version: number;
  fromProject: string;
  packageName?: string;
  /** True when the element is published by this project, not a dependency. */
  local: boolean;
};

export type MarketingDesignBasis = {
  logos: MarketingDesignLogo[];
  elements: MarketingDesignElement[];
  hasTokens: boolean;
  tokenSource?: string;
};

function readDependencyNames(projectRoot: string): Set<string> {
  const path = join(projectRoot, "package.json");
  if (!existsSync(path)) return new Set();
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const names = new Set<string>();
    for (const bag of [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
    ]) {
      if (!bag) continue;
      for (const name of Object.keys(bag)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

function pushLogo(
  logos: MarketingDesignLogo[],
  seen: Set<string>,
  name: string,
  path: string,
  pinned: boolean,
): void {
  if (!name || seen.has(name)) return;
  if (!pinned && !CANONICAL_LOGO_RE.test(name)) return;
  seen.add(name);
  logos.push({ name, path, pinned });
}

export function collectMarketingDesignBasis(opts: {
  projectRoot: string;
  dataDir?: string;
  listProjects?: ListProjectsFn;
  excludeLoopId?: string;
}): MarketingDesignBasis {
  const logos: MarketingDesignLogo[] = [];
  const seenLogos = new Set<string>();
  const brand = pickProjectBrandAssets(opts.projectRoot, {
    excludeLoopId: opts.excludeLoopId,
  });
  if (brand?.logoAsset) {
    pushLogo(
      logos,
      seenLogos,
      brand.logoAsset,
      `.slopcontrol/design-loops/${brand.sourceLoopId}/assets/${brand.logoAsset}`,
      true,
    );
  }
  const prior = pickProjectPriorDesign(opts.projectRoot, {
    excludeLoopId: opts.excludeLoopId,
  });
  // A pinned mark is the project logo. Do not also advertise canonical
  // filenames from a later screen that never selected a mark.
  if (!logos.some((logo) => logo.pinned)) {
    for (const abs of prior?.logoFiles ?? []) {
      const name = basename(abs);
      pushLogo(logos, seenLogos, name, relative(opts.projectRoot, abs), false);
    }
    const live = buildLiveSiteInventory(opts.projectRoot);
    for (const rel of live.logoPaths) {
      pushLogo(logos, seenLogos, basename(rel), rel, false);
    }
  }

  const deps = readDependencyNames(opts.projectRoot);
  const catalog = buildCrossProjectCatalog({
    targetRoot: opts.projectRoot,
    dataDir: opts.dataDir,
    listProjects: opts.listProjects,
  });
  const target = opts.projectRoot.replace(/\/$/, "");
  const elements = new Map<string, MarketingDesignElement>();
  const consider = (
    rootPath: string,
    fromProject: string,
    packageName: string | undefined,
    local: boolean,
  ) => {
    for (const entry of listProjectElements(rootPath)) {
      if (!LANDING_CHROME_ELEMENT_IDS.has(entry.id)) continue;
      if (entry.status === "draft") continue;
      if (local && elements.has(entry.id)) continue;
      const prev = elements.get(entry.id);
      if (prev && prev.version >= entry.latestVersion) continue;
      elements.set(entry.id, {
        id: entry.id,
        version: entry.latestVersion,
        fromProject,
        packageName,
        local,
      });
    }
  };
  for (const project of catalog.projects) {
    const root = project.rootPath.replace(/\/$/, "");
    if (root === target) continue;
    if (!project.packageName || !deps.has(project.packageName)) continue;
    consider(root, project.name, project.packageName, false);
  }
  for (const entry of catalog.elements) {
    if (!entry.npmPackage || !deps.has(entry.npmPackage)) continue;
    if (!LANDING_CHROME_ELEMENT_IDS.has(entry.id)) continue;
    if (entry.origin === "local" || entry.status === "draft") continue;
    if (elements.has(entry.id)) continue;
    elements.set(entry.id, {
      id: entry.id,
      version: entry.latestVersion,
      fromProject: entry.projectName || entry.origin,
      packageName: entry.npmPackage,
      local: false,
    });
  }
  const localProject = catalog.projects.find(
    (project) => project.rootPath.replace(/\/$/, "") === target,
  );
  consider(target, localProject?.name || "this project", localProject?.packageName, true);

  const tokenSource = prior?.tokensCss?.trim()
    ? prior.kind === "loop"
      ? `design loop ${prior.loopId ?? ""}`.trim()
      : `phase ${prior.phaseId ?? ""}`.trim()
    : undefined;

  return {
    logos,
    elements: [...elements.values()].sort((a, b) => a.id.localeCompare(b.id)),
    hasTokens: Boolean(tokenSource),
    tokenSource,
  };
}

export function formatMarketingDesignBasisBlock(basis: MarketingDesignBasis): string {
  const has = basis.logos.length > 0 || basis.elements.length > 0 || basis.hasTokens;
  if (!has) {
    return [
      "## EXISTING DESIGN BASIS",
      "",
      "No pinned logo and no published landing elements from packages this project depends on.",
    ].join("\n");
  }
  const lines = [
    "## EXISTING DESIGN BASIS",
    "",
    "CRITICAL: Extend these artifacts. Do not invent a new logo, lettermark, menubar, theme control, or sign-in.",
    "",
  ];
  if (basis.logos.length) {
    lines.push("### Logo files");
    for (const logo of basis.logos) {
      lines.push(
        `- \`${logo.name}\`${logo.pinned ? " (pinned)" : ""} at \`${logo.path}\``,
      );
    }
    lines.push("");
  }
  if (basis.elements.length) {
    lines.push(
      "### Shared elements (published by packages this project already depends on)",
    );
    for (const el of basis.elements) {
      lines.push(
        `- ${el.id}@${el.version} from ${el.fromProject}${
          el.packageName ? ` (${el.packageName})` : ""
        }`,
      );
    }
    lines.push("");
  }
  if (basis.hasTokens && basis.tokenSource) {
    lines.push(`Theme tokens already exist (${basis.tokenSource}). Reuse that palette.`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Copy the existing logo and landing elements into a marketing design loop
 * and mark it so generate composes from them instead of redrawing a dashboard.
 */
export function seedMarketingDesignLoop(opts: {
  projectRoot: string;
  loopId: string;
  projectId: string;
  dataDir?: string;
  listProjects?: ListProjectsFn;
}): { basis: MarketingDesignBasis; importedElementIds: string[] } {
  const basis = collectMarketingDesignBasis({
    projectRoot: opts.projectRoot,
    dataDir: opts.dataDir,
    listProjects: opts.listProjects,
    excludeLoopId: opts.loopId,
  });
  if (!readProjectBrandAssetsImport(opts.projectRoot, opts.loopId)) {
    const brand = pickProjectBrandAssets(opts.projectRoot, {
      excludeLoopId: opts.loopId,
    });
    if (brand) {
      importProjectBrandAssetsIntoLoop({
        projectRoot: opts.projectRoot,
        loopId: opts.loopId,
        brand,
      });
    }
  }
  if (!readProjectPriorDesignImport(opts.projectRoot, opts.loopId)) {
    const prior = pickProjectPriorDesign(opts.projectRoot, {
      excludeLoopId: opts.loopId,
    });
    if (prior) {
      importProjectPriorDesignIntoLoop({
        projectRoot: opts.projectRoot,
        loopId: opts.loopId,
        prior,
        excludeFacets: ["layout"],
      });
    }
  }
  const importedElementIds: string[] = [];
  const already = new Set(
    getDesignLoopElements(readDesignLoopMeta(opts.projectRoot, opts.loopId)).map((el) => el.id),
  );
  for (const el of basis.elements) {
    if (already.has(el.id)) continue;
    const bundle = resolveDesignElement({
      elementId: el.id,
      version: el.version,
      origin: el.local ? undefined : `project:${el.fromProject}`,
      targetRoot: opts.projectRoot,
      dataDir: opts.dataDir,
      listProjects: opts.listProjects,
    });
    if (!bundle) continue;
    importDesignElementIntoLoop({
      targetRoot: opts.projectRoot,
      loopId: opts.loopId,
      bundle,
      origin: "project",
      sourceName: el.fromProject,
      dataDir: opts.dataDir,
      consumerProjectId: opts.projectId,
      listProjects: opts.listProjects,
    });
    importedElementIds.push(el.id);
    already.add(el.id);
  }
  const meta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  const pinned = meta
    ? getDesignLoopSelections(meta).find((sel) => sel.slot === "logo")
    : undefined;
  if (!pinned?.asset) {
    const preferred =
      basis.logos.find((logo) => logo.pinned)?.name ??
      basis.logos.find((logo) => logo.name === "logo.svg")?.name ??
      basis.logos[0]?.name;
    if (
      preferred &&
      existsSync(
        join(
          opts.projectRoot,
          ".slopcontrol",
          "design-loops",
          opts.loopId,
          "assets",
          preferred,
        ),
      )
    ) {
      pinDesignLoopLogoAsset({
        projectRoot: opts.projectRoot,
        loopId: opts.loopId,
        asset: preferred,
        label: preferred,
      });
    }
  }
  const latest = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (latest) {
    writeDesignLoopMeta(opts.projectRoot, {
      ...latest,
      composeFromLibrary: true,
      updatedAt: new Date().toISOString(),
    });
  }
  return { basis, importedElementIds };
}
