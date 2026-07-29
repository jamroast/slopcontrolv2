import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ObsidianSyncOptions {
  vaultPath?: string;
}

export class ObsidianSync {
  constructor(private readonly opts: ObsidianSyncOptions) {}

  get enabled(): boolean {
    return Boolean(this.opts.vaultPath);
  }

  writeDecisionNote(input: {
    title: string;
    project: string;
    iterations: number;
  }): void {
    if (!this.opts.vaultPath) return;

    const dir = join(this.opts.vaultPath, "03-Decisions");
    mkdirSync(dir, { recursive: true });
    const safe = input.title
      .replace(/[^a-zA-Z0-9 ]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .toLowerCase()
      .slice(0, 60);
    const date = new Date().toISOString().split("T")[0];

    writeFileSync(
      join(dir, `${safe}-decision.md`),
      `---\ntype: decision\ndate: ${date}\nstatus: implemented\nproject: "${input.project}"\n---\n\n## Implementation Complete\n\nCompleted in ${input.iterations} iteration(s).\n`,
      "utf-8",
    );
  }

  writeResearchSummary(input: {
    slug: string;
    content: string;
  }): void {
    if (!this.opts.vaultPath) return;

    const dir = join(this.opts.vaultPath, "02-Projects");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${input.slug}-research.md`), input.content, "utf-8");
  }
}
