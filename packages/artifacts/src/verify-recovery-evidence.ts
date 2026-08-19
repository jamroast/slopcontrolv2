import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readLearningIndex } from "./learnings.js";
import { verifyRecoveryAlreadyAttempted } from "./verify-recovery-execute.js";

export type VerifyRecoveryStepInput = {
  name: string;
  command?: string;
  exitCode?: number;
  output?: string;
};

export type VerifyRecoveryEvidence = {
  verifyCwd: string;
  projectRoot: string;
  step: VerifyRecoveryStepInput;
  packageManager: string;
  installErrno: string | null;
  installStep: boolean;
  nodeModulesPresent: boolean;
  recoveryAlreadyAttempted: boolean;
  learningHints: string[];
  promptBlock: string;
};

const INSTALL_STEP = /deps-install|post-merge-root-verify:deps-install/i;

const ERRNO_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\bENOTEMPTY\b/i, label: "ENOTEMPTY" },
  { re: /\bEINTEGRITY\b/i, label: "EINTEGRITY" },
  { re: /\bEBUSY\b/i, label: "EBUSY" },
  { re: /\berrno\s+-66\b/i, label: "errno-66" },
];

function detectPackageManager(cwd: string): string {
  try {
    const raw = readFileSync(join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { packageManager?: string };
    const pm = String(pkg.packageManager ?? "");
    if (pm.startsWith("pnpm@")) return "pnpm";
    if (pm.startsWith("yarn@")) return "yarn";
    if (pm.startsWith("npm@")) return "npm";
  } catch {
    // fall through
  }
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  return "npm";
}

function parseInstallErrno(text: string): string | null {
  for (const { re, label } of ERRNO_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

function learningHintsForFailure(
  projectRoot: string,
  stepText: string,
): string[] {
  const index = readLearningIndex(projectRoot);
  const tags = new Set<string>();
  if (/ENOTEMPTY|errno\s+-66/i.test(stepText)) tags.add("stale-node-modules");
  if (/EINTEGRITY/i.test(stepText)) tags.add("npm-cache");
  if (/exit\s+127|command not found/i.test(stepText)) tags.add("deps");

  const hints: string[] = [];
  for (const record of index.learnings) {
    if (record.tags.some((t) => tags.has(t) || t === "verify-recovery")) {
      hints.push(`${record.title}: ${record.lesson}`.slice(0, 400));
      if (hints.length >= 2) break;
    }
  }
  return hints;
}

export function isHarnessRecoverableStep(step: VerifyRecoveryStepInput): boolean {
  if (!step.name) return false;
  if (INSTALL_STEP.test(step.name)) return true;
  if (/^compose|^docker|^port-/i.test(step.name)) return true;
  const ctx = `${step.name}\n${step.command ?? ""}\n${step.output ?? ""}`;
  if (parseInstallErrno(ctx)) return true;
  return false;
}

export function buildVerifyRecoveryEvidence(opts: {
  verifyCwd: string;
  projectRoot: string;
  step: VerifyRecoveryStepInput;
}): VerifyRecoveryEvidence {
  const stepText = [
    opts.step.name,
    opts.step.command ?? "",
    opts.step.output ?? "",
  ].join("\n");
  const packageManager = detectPackageManager(opts.verifyCwd);
  const installErrno = parseInstallErrno(stepText);
  const installStep = INSTALL_STEP.test(opts.step.name);
  const nodeModulesPresent = existsSync(join(opts.verifyCwd, "node_modules"));
  const recoveryAlreadyAttempted = verifyRecoveryAlreadyAttempted(stepText);
  const learningHints = learningHintsForFailure(opts.projectRoot, stepText);

  const promptBlock = [
    `Verify cwd: ${opts.verifyCwd}`,
    `Package manager hint: ${packageManager}`,
    `Failing step: ${opts.step.name}${opts.step.command ? ` (${opts.step.command})` : ""}`,
    `Exit code: ${opts.step.exitCode ?? "unknown"}`,
    installErrno ? `Install errno signal: ${installErrno}` : null,
    `node_modules present: ${nodeModulesPresent}`,
    recoveryAlreadyAttempted ? "Recovery already attempted in this verify pass." : null,
    learningHints.length
      ? `Prior learnings (hints only):\n${learningHints.map((h) => `- ${h}`).join("\n")}`
      : null,
    "",
    "Failed step output (tail):",
    (opts.step.output ?? "").slice(-4_000),
  ]
    .filter((line) => line !== null)
    .join("\n");

  return {
    verifyCwd: opts.verifyCwd,
    projectRoot: opts.projectRoot,
    step: opts.step,
    packageManager,
    installErrno,
    installStep,
    nodeModulesPresent,
    recoveryAlreadyAttempted,
    learningHints,
    promptBlock,
  };
}

export function verifyRecoveryExhausted(checksOutput: string): boolean {
  return verifyRecoveryAlreadyAttempted(checksOutput);
}
