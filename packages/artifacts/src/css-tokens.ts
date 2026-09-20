import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type MockCustomProperty = {
  name: string;
  value: string;
};

/**
 * Extract custom-property definitions (`--name: value`) from a design mock's
 * `<style>` blocks (the `:root` and `[data-theme]` token ladders). These are the
 * tokens an implementation must carry into the consumer's CSS. Layout/dimension
 * tokens like `--pane-w` live here and are the most commonly dropped when the
 * coding agent hand-wires a `var(--pane-w)` reference without its definition.
 */
export function extractMockCustomProperties(html: string): MockCustomProperty[] {
  const props = new Map<string, string>();
  for (const m of (html ?? "").matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = m[1] ?? "";
    for (const decl of css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
      const name = decl[1]!.trim();
      const value = decl[2]!.trim();
      if (!props.has(name)) props.set(name, value);
    }
  }
  return [...props.entries()].map(([name, value]) => ({ name, value }));
}

/** Every `var(--x)` reference in a body of source/CSS, deduped in first-seen order. */
export function collectCssVarReferences(code: string): string[] {
  const refs = new Set<string>();
  for (const m of (code ?? "").matchAll(/var\(\s*(--[\w-]+)/g)) {
    refs.add(m[1]!);
  }
  return [...refs];
}

/** `var(--x)` references that are not present in `definedVars`. */
export function findUndefinedCssVarRefs(opts: {
  code: string;
  definedVars: Iterable<string>;
}): string[] {
  const defined = new Set([...opts.definedVars].map((v) => v.trim()));
  return collectCssVarReferences(opts.code).filter((r) => !defined.has(r));
}

/**
 * Collect `--x` names defined in a project's own CSS files (source tree, not
 * node_modules/dist). Used to detect a mock token the consumer never wired.
 */
export function collectProjectCssVarNames(projectRoot: string): Set<string> {
  const defined = new Set<string>();
  const roots = [
    join(projectRoot, "src"),
    join(projectRoot, "app"),
    join(projectRoot, "public"),
    join(projectRoot, "styles"),
    join(projectRoot, "web", "src"),
    join(projectRoot, "packages"),
  ];
  const seen = new Set<string>();
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || !existsSync(dir)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules" || name === "dist") {
        continue;
      }
      const abs = join(dir, name);
      try {
        if (name.endsWith(".css")) {
          if (seen.has(abs)) continue;
          seen.add(abs);
          for (const m of readFileSync(abs, "utf-8").matchAll(/(--[\w-]+)\s*:/g)) {
            defined.add(m[1]!);
          }
        } else if (!name.includes(".")) {
          walk(abs, depth + 1);
        }
      } catch {
        /* ignore unreadable files */
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return defined;
}

/** Mock custom properties NOT defined in the project's own CSS. */
export function findMissingMockTokensInProject(opts: {
  projectRoot: string;
  html: string;
}): MockCustomProperty[] {
  const props = extractMockCustomProperties(opts.html);
  const defined = collectProjectCssVarNames(opts.projectRoot);
  return props.filter((p) => !defined.has(p.name));
}
