/**
 * Join shell line continuations ending in `\`.
 * Prevents `cmd && \` from being run as a broken standalone command.
 */
export function joinShellContinuations(lines: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) {
      if (buf) {
        // Comment/blank mid-continuation — flush incomplete as-is (validator catches trailing \)
        out.push(buf);
        buf = "";
      }
      continue;
    }
    if (buf) {
      buf = `${buf.replace(/\\$/, "").replace(/\s+$/, "")} ${line.trim()}`;
    } else {
      buf = line.trim();
    }
    if (buf.endsWith("\\")) {
      continue;
    }
    out.push(buf);
    buf = "";
  }
  if (buf) out.push(buf);
  return out;
}

/** True when a command still ends with an unjoined `\` (broken check). */
export function hasTrailingShellContinuation(command: string): boolean {
  return /\\\s*$/.test(command.trim());
}

/**
 * True when a shell fragment is an incomplete compound (e.g. `if …; then` without `fi`).
 * Used to reject bad Automated Checks before they hit `/bin/sh`.
 */
export function isIncompleteShellCompound(command: string): boolean {
  const c = (command ?? "").trim();
  if (!c) return false;
  if (/\b(then|do|else|elif)\s*$/.test(c)) return true;
  if (/[{(]\s*$/.test(c)) return true;

  const count = (re: RegExp) => (c.match(re) ?? []).length;
  const ifs = count(/\bif\b/g);
  const fis = count(/\bfi\b/g);
  if (ifs > fis) return true;

  const dos = count(/\bdo\b/g);
  const dones = count(/\bdone\b/g);
  if (dos > dones) return true;
  if (/\b(while|until|for)\b/.test(c) && dos === 0) return true;

  const cases = count(/\bcase\b/g);
  const esacs = count(/\besac\b/g);
  if (cases > esacs) return true;

  const opens = count(/{/g);
  const closes = count(/}/g);
  if (opens > closes) return true;

  return false;
}

type ShellNesting = {
  ifDepth: number;
  loopDepth: number;
  caseDepth: number;
  braceDepth: number;
};

function emptyNesting(): ShellNesting {
  return { ifDepth: 0, loopDepth: 0, caseDepth: 0, braceDepth: 0 };
}

function nestingOpen(n: ShellNesting): number {
  return n.ifDepth + n.loopDepth + n.caseDepth + n.braceDepth;
}

function applyShellNesting(n: ShellNesting, line: string): void {
  const tokens = line.match(/\b(if|fi|while|until|for|do|done|case|esac)\b|[{}]/g) ?? [];
  for (const t of tokens) {
    switch (t) {
      case "if":
        n.ifDepth += 1;
        break;
      case "fi":
        n.ifDepth = Math.max(0, n.ifDepth - 1);
        break;
      case "while":
      case "until":
      case "for":
        n.loopDepth += 1;
        break;
      case "done":
        n.loopDepth = Math.max(0, n.loopDepth - 1);
        break;
      case "case":
        n.caseDepth += 1;
        break;
      case "esac":
        n.caseDepth = Math.max(0, n.caseDepth - 1);
        break;
      case "{":
        n.braceDepth += 1;
        break;
      case "}":
        n.braceDepth = Math.max(0, n.braceDepth - 1);
        break;
      default:
        break;
    }
  }
}

/**
 * Coalesce multi-line shell compounds (`if/fi`, `while/done`, `case/esac`, `{ }`)
 * into single commands after backslash-joining. Independent one-liners stay separate.
 *
 * @deprecated Prefer extractCheckCells (one fence = one script). Kept for unit tests
 * and any legacy call sites that still split lines.
 */
export function coalesceShellCompounds(commands: string[]): string[] {
  const out: string[] = [];
  let buf = "";
  let nest = emptyNesting();

  const flush = () => {
    if (buf) out.push(buf);
    buf = "";
    nest = emptyNesting();
  };

  for (const raw of commands) {
    const cmd = raw.trim();
    if (!cmd) continue;

    if (!buf) {
      applyShellNesting(nest, cmd);
      if (nestingOpen(nest) === 0 && !isIncompleteShellCompound(cmd)) {
        out.push(cmd);
        nest = emptyNesting();
        continue;
      }
      buf = cmd;
      continue;
    }

    buf = `${buf}\n${cmd}`;
    applyShellNesting(nest, cmd);
    if (nestingOpen(nest) === 0) {
      flush();
    }
  }
  if (buf) flush();
  return out;
}
