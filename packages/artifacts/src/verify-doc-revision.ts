/**
 * Deterministic "did the revision actually land" gate for review revisions.
 *
 * Byte-identity is a *signal*, not a verdict: a no-op revision is sometimes
 * correct (feedback already satisfied). The LLM judge decides whether the
 * no-op was legitimate or a genuine miss. When no judge is bound, fail
 * closed on byte-identity (can't confirm a no-op was correct) but pass a
 * changed doc as best-effort.
 */

export interface DocRevisionJudgeInput {
  feedback: string;
  before: string;
  after: string;
}

export type DocRevisionJudge = (
  input: DocRevisionJudgeInput,
) => Promise<{ applied: string[]; missing: string[] }>;

export interface DocRevisionVerdict {
  ok: boolean;
  changed: boolean;
  missing: string[];
  reason: string;
}

/** Normalize a doc for byte-identity comparison: strip date lines, collapse
 * trailing whitespace, normalize line endings. */
export function normalizeDocForCompare(doc: string): string {
  return (doc ?? "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => !/^\s*Date:\s*\d{4}-\d{2}-\d{2}\s*$/i.test(line))
    .join("\n")
    .trim();
}

/** True when the two docs differ after normalization (ignoring date lines). */
export function docRevisionChanged(before: string, after: string): boolean {
  return normalizeDocForCompare(before) !== normalizeDocForCompare(after);
}

export async function verifyDocRevisionApplied(opts: {
  before: string;
  after: string;
  feedback: string;
  judge?: DocRevisionJudge;
}): Promise<DocRevisionVerdict> {
  const changed = docRevisionChanged(opts.before, opts.after);

  if (!opts.judge) {
    // Fail closed: without a judge, byte-identity is the only signal.
    if (!changed) {
      return {
        ok: false,
        changed,
        missing: [],
        reason: "byte-identical revision and no judge bound to confirm",
      };
    }
    return {
      ok: true,
      changed,
      missing: [],
      reason: "changed (unjudged)",
    };
  }

  const verdict = await opts.judge({
    feedback: opts.feedback,
    before: opts.before,
    after: opts.after,
  });
  const missing = (verdict.missing ?? []).filter((m) => m.trim());
  if (missing.length > 0) {
    return {
      ok: false,
      changed,
      missing,
      reason: `missing feedback: ${missing.join("; ")}`,
    };
  }
  return {
    ok: true,
    changed,
    missing: [],
    reason: changed ? "applied" : "no-op (feedback already satisfied)",
  };
}
