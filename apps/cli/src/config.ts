import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SlopcontrolYamlSchema,
  type SlopcontrolYaml,
} from "./config-schema.js";

export const CONFIG_FILENAME = "slopcontrol.yaml";

export function homeConfigPath(): string {
  return join(homedir(), ".slopcontrol", CONFIG_FILENAME);
}

/** Walk from startDir toward filesystem root looking for slopcontrol.yaml. */
export function findConfigPath(startDir: string = process.cwd()): string | undefined {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir || parsePath(dir).root === dir) break;
    dir = parent;
  }
  const home = homeConfigPath();
  if (existsSync(home)) return home;
  return undefined;
}

export function loadConfigFile(path: string): SlopcontrolYaml {
  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);
  return SlopcontrolYamlSchema.parse(parsed ?? {});
}

export function loadConfig(startDir?: string): {
  path: string;
  config: SlopcontrolYaml;
  rootDir: string;
} {
  const path = findConfigPath(startDir);
  if (!path) {
    throw new Error(
      `No ${CONFIG_FILENAME} found (walked up from ${startDir ?? process.cwd()}, ` +
        `also checked ${homeConfigPath()}). Run: slopcontrol init`,
    );
  }
  const config = loadConfigFile(path);
  return { path, config, rootDir: dirname(path) };
}
