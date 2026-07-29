import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  findConfigPath,
} from "./config.js";
import { DEFAULT_SLOPCONTROL_YAML } from "./config-schema.js";

export function cmdInit(cwd: string = process.cwd()): void {
  const existing = findConfigPath(cwd);
  const target = join(cwd, CONFIG_FILENAME);
  if (existsSync(target)) {
    console.log(`${CONFIG_FILENAME} already exists at ${target}`);
    return;
  }
  if (existing && existing !== target) {
    console.log(`Note: also found ${existing}`);
  }
  writeFileSync(target, DEFAULT_SLOPCONTROL_YAML, "utf-8");
  console.log(`Wrote ${target}`);
}
