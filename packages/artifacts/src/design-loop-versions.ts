/**
 * Design-loop version tree: list, tip, invalidate, lineage.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendDesignLoopTranscript,
  designLoopDir,
  designLoopVersionDir,
  designLoopVersionExists,
  readDesignLoopMeta,
  readDesignLoopVersionMeta,
  writeDesignLoopMeta,
  type DesignLoopMeta,
  type DesignLoopVersionMeta,
  type DesignLoopVersionStatus,
} from "./design-loop.js";

export type DesignLoopVersionNode = DesignLoopVersionMeta & {
  /** True when META lacked parent/status and values were inferred. */
  backfilled?: boolean;
  isTip?: boolean;
  isAccepted?: boolean;
};

export type DesignLoopVersionTreeNode = DesignLoopVersionNode & {
  children: number[];
};

function normalizeVersionMeta(
  raw: Partial<DesignLoopVersionMeta> | null,
  version: number,
): DesignLoopVersionNode {
  const backfilled =
    !raw ||
    raw.parentVersion === undefined ||
    raw.status === undefined;
  const parentVersion =
    raw?.parentVersion !== undefined
      ? raw.parentVersion
      : version <= 1
        ? null
        : version - 1;
  const status: DesignLoopVersionStatus =
    raw?.status === "invalid" ? "invalid" : "active";
  return {
    version,
    parentVersion,
    status,
    invalidReason: raw?.invalidReason,
    invalidatedAt: raw?.invalidatedAt,
    usedScaffold: Boolean(raw?.usedScaffold),
    error: raw?.error,
    updatedAt: raw?.updatedAt ?? new Date(0).toISOString(),
    backfilled: backfilled || undefined,
  };
}

/** Scan vN folders and return normalized version metas (sorted ascending). */
export function listDesignLoopVersions(
  projectRoot: string,
  loopId: string,
): DesignLoopVersionNode[] {
  const root = designLoopDir(projectRoot, loopId);
  if (!existsSync(root)) return [];
  const versions: number[] = [];
  for (const name of readdirSync(root)) {
    const m = /^v(\d+)$/.exec(name);
    if (!m) continue;
    const v = Number(m[1]);
    if (!Number.isFinite(v) || v < 1) continue;
    if (!designLoopVersionExists(projectRoot, loopId, v)) continue;
    versions.push(v);
  }
  versions.sort((a, b) => a - b);
  const meta = readDesignLoopMeta(projectRoot, loopId);
  const tip = meta?.currentVersion;
  const accepted = meta?.acceptedVersion;
  return versions.map((v) => {
    const node = normalizeVersionMeta(
      readDesignLoopVersionMeta(projectRoot, loopId, v),
      v,
    );
    return {
      ...node,
      isTip: tip === v,
      isAccepted: accepted === v,
    };
  });
}

/** Highest version folder number (including invalid). */
export function maxDesignLoopVersionNumber(
  projectRoot: string,
  loopId: string,
): number {
  const list = listDesignLoopVersions(projectRoot, loopId);
  if (!list.length) return 0;
  return list[list.length - 1]!.version;
}

/** Next free version id (max folder + 1). */
export function allocateNextDesignLoopVersion(
  projectRoot: string,
  loopId: string,
): number {
  return maxDesignLoopVersionNumber(projectRoot, loopId) + 1;
}

/**
 * Tip for continues: loop META.currentVersion when that version exists and is
 * active; otherwise highest active version; else 0.
 */
export function resolveDesignLoopTip(
  projectRoot: string,
  loopId: string,
): number {
  const meta = readDesignLoopMeta(projectRoot, loopId);
  const list = listDesignLoopVersions(projectRoot, loopId);
  if (!list.length) return 0;
  if (meta?.currentVersion) {
    const cur = list.find((v) => v.version === meta.currentVersion);
    if (cur && cur.status === "active") return cur.version;
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.status === "active") return list[i]!.version;
  }
  return 0;
}

export function getDesignLoopVersionNode(
  projectRoot: string,
  loopId: string,
  version: number,
): DesignLoopVersionNode | null {
  if (!designLoopVersionExists(projectRoot, loopId, version)) return null;
  const meta = readDesignLoopMeta(projectRoot, loopId);
  const node = normalizeVersionMeta(
    readDesignLoopVersionMeta(projectRoot, loopId, version),
    version,
  );
  return {
    ...node,
    isTip: meta?.currentVersion === version,
    isAccepted: meta?.acceptedVersion === version,
  };
}

/** Ensure base version exists and is active (for continue/accept). */
export function assertActiveDesignLoopBase(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
}): DesignLoopVersionNode {
  const node = getDesignLoopVersionNode(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  if (!node) {
    throw new Error(`Design loop version v${opts.version} not found`);
  }
  if (node.status === "invalid") {
    throw new Error(
      `Design loop version v${opts.version} is invalid — pick an active base or restore via retry`,
    );
  }
  return node;
}

export function buildDesignLoopVersionTree(
  projectRoot: string,
  loopId: string,
): {
  tip: number;
  acceptedVersion?: number;
  versions: DesignLoopVersionNode[];
  tree: DesignLoopVersionTreeNode[];
} {
  const versions = listDesignLoopVersions(projectRoot, loopId);
  const meta = readDesignLoopMeta(projectRoot, loopId);
  const tip = resolveDesignLoopTip(projectRoot, loopId);
  const byParent = new Map<number | "root", number[]>();
  for (const v of versions) {
    const key = v.parentVersion == null ? "root" : v.parentVersion;
    const arr = byParent.get(key) ?? [];
    arr.push(v.version);
    byParent.set(key, arr);
  }
  const tree: DesignLoopVersionTreeNode[] = versions.map((v) => ({
    ...v,
    isTip: v.version === tip,
    children: byParent.get(v.version) ?? [],
  }));
  return {
    tip,
    acceptedVersion: meta?.acceptedVersion,
    versions: versions.map((v) => ({ ...v, isTip: v.version === tip })),
    tree,
  };
}

function writeVersionMetaFile(
  projectRoot: string,
  loopId: string,
  meta: DesignLoopVersionMeta,
): void {
  const path = join(
    designLoopVersionDir(projectRoot, loopId, meta.version),
    "META.json",
  );
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

/**
 * Soft-discard a version. If it is the tip, rewind currentVersion to parent.
 * Keeps vN/ on disk. Cannot discard the accepted version.
 */
export function invalidateDesignLoopVersion(opts: {
  projectRoot: string;
  loopId: string;
  version: number;
  reason?: string;
}): {
  loop: DesignLoopMeta;
  version: DesignLoopVersionNode;
  versions: DesignLoopVersionNode[];
  tree: DesignLoopVersionTreeNode[];
  tip: number;
} {
  const loopMeta = readDesignLoopMeta(opts.projectRoot, opts.loopId);
  if (!loopMeta) throw new Error(`Design loop not found: ${opts.loopId}`);
  if (loopMeta.acceptedVersion === opts.version) {
    throw new Error(
      `Cannot discard accepted version v${opts.version} — accept a different version first or continue from it`,
    );
  }
  const node = getDesignLoopVersionNode(
    opts.projectRoot,
    opts.loopId,
    opts.version,
  );
  if (!node) {
    throw new Error(`Design loop version v${opts.version} not found`);
  }
  if (node.status === "invalid") {
    // Idempotent: still return tree; tip may already be rewound
    const built = buildDesignLoopVersionTree(opts.projectRoot, opts.loopId);
    return {
      loop: loopMeta,
      version: node,
      versions: built.versions,
      tree: built.tree,
      tip: built.tip,
    };
  }

  const now = new Date().toISOString();
  const nextVersionMeta: DesignLoopVersionMeta = {
    version: node.version,
    parentVersion: node.parentVersion,
    status: "invalid",
    invalidReason: opts.reason?.trim() || "Discarded by operator",
    invalidatedAt: now,
    usedScaffold: node.usedScaffold,
    error: node.error,
    updatedAt: now,
  };
  writeVersionMetaFile(opts.projectRoot, opts.loopId, nextVersionMeta);

  let nextLoop = loopMeta;
  if (loopMeta.currentVersion === opts.version) {
    const parent = node.parentVersion ?? 0;
    nextLoop = {
      ...loopMeta,
      currentVersion: parent,
      updatedAt: now,
    };
    writeDesignLoopMeta(opts.projectRoot, nextLoop);
  } else {
    nextLoop = {
      ...loopMeta,
      updatedAt: now,
    };
    writeDesignLoopMeta(opts.projectRoot, nextLoop);
  }

  appendDesignLoopTranscript(
    opts.projectRoot,
    opts.loopId,
    "assistant",
    `Discarded v${opts.version} (invalid).${
      opts.reason?.trim() ? ` Reason: ${opts.reason.trim()}` : ""
    }${
      loopMeta.currentVersion === opts.version
        ? ` Tip rewound to v${node.parentVersion ?? 0}.`
        : ""
    }`,
  );

  const built = buildDesignLoopVersionTree(opts.projectRoot, opts.loopId);
  const updated =
    getDesignLoopVersionNode(opts.projectRoot, opts.loopId, opts.version) ??
    normalizeVersionMeta(nextVersionMeta, opts.version);

  return {
    loop: readDesignLoopMeta(opts.projectRoot, opts.loopId) ?? nextLoop,
    version: updated,
    versions: built.versions,
    tree: built.tree,
    tip: built.tip,
  };
}
