import { EventEmitter } from "node:events";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RunStage } from "@slopcontrol/types";

/** Minimal run snapshot emitted on stage writes (server choke point). */
export type RunStageUpdate = {
  id: string;
  stage: RunStage;
  phaseId?: string;
  projectId?: string;
  previousStage?: RunStage;
};

/** Persisted event line in the JSONL log. */
export type RunStageEvent = RunStageUpdate & {
  seq: number;
  ts: string;
  type: "run_stage";
};

const COMPACT_MAX_EVENTS = 1000;
const COMPACT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const COMPACT_FILE_THRESHOLD_BYTES = 1_000_000;

/**
 * In-process pub/sub for run stage transitions, optionally persisted to an
 * append-only JSONL log so notifications survive restarts and dashboards can
 * replay/resume instead of polling.
 *
 * When `logPath` is set, every emit appends a line before the in-process
 * emit. `seq` is monotonic, recovered from the last log line on startup.
 */
export class RunStageBroker {
  private readonly emitter = new EventEmitter();
  private readonly logPath?: string;
  private seq = 0;

  constructor(opts?: { logPath?: string }) {
    this.emitter.setMaxListeners(200);
    this.logPath = opts?.logPath;
    if (this.logPath) {
      this.seq = this.recoverSeq(this.logPath);
    }
  }

  emit(update: RunStageUpdate): void {
    if (this.logPath) {
      this.seq += 1;
      const event: RunStageEvent = {
        seq: this.seq,
        ts: new Date().toISOString(),
        type: "run_stage",
        ...update,
      };
      try {
        mkdirSync(dirname(this.logPath), { recursive: true });
        appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, "utf-8");
      } catch {
        /* persistence is best-effort — in-process emit still fires */
      }
    }
    this.emitter.emit(update.id, update);
    this.emitter.emit("*", update);
  }

  subscribe(
    runId: string,
    listener: (update: RunStageUpdate) => void,
  ): () => void {
    this.emitter.on(runId, listener);
    return () => {
      this.emitter.off(runId, listener);
    };
  }

  /** Current seq (0 when no log or no events yet). */
  currentSeq(): number {
    return this.seq;
  }

  /** Read the log and return events with seq > afterSeq, in order. */
  replaySince(afterSeq: number): RunStageEvent[] {
    if (!this.logPath || !existsSync(this.logPath)) return [];
    const out: RunStageEvent[] = [];
    for (const line of readFileSync(this.logPath, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as RunStageEvent;
        if (typeof event.seq === "number" && event.seq > afterSeq) {
          out.push(event);
        }
      } catch {
        /* skip malformed lines */
      }
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Rewrite the log keeping the latest event per run plus all events newer
   * than 24h. Called once on startup when the file exceeds the threshold.
   * Returns true when compaction ran.
   */
  compact(maxEvents = COMPACT_MAX_EVENTS): boolean {
    if (!this.logPath || !existsSync(this.logPath)) return false;
    const all = this.replaySince(0);
    if (all.length === 0) return false;
    let size = 0;
    try {
      size = readFileSync(this.logPath).length;
    } catch {
      return false;
    }
    if (size < COMPACT_FILE_THRESHOLD_BYTES && all.length <= maxEvents) {
      return false;
    }

    const cutoff = Date.now() - COMPACT_MAX_AGE_MS;
    const latestByRun = new Map<string, RunStageEvent>();
    for (const event of all) {
      latestByRun.set(event.id, event);
    }
    const keep = new Map<number, RunStageEvent>();
    for (const event of latestByRun.values()) {
      keep.set(event.seq, event);
    }
    for (const event of all) {
      if (Date.parse(event.ts) >= cutoff) {
        keep.set(event.seq, event);
      }
    }
    let kept = [...keep.values()].sort((a, b) => a.seq - b.seq);
    if (kept.length > maxEvents) {
      kept = kept.slice(kept.length - maxEvents);
    }

    const tmp = `${this.logPath}.tmp`;
    writeFileSync(
      tmp,
      kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length ? "\n" : ""),
      "utf-8",
    );
    renameSync(tmp, this.logPath);
    return true;
  }

  private recoverSeq(logPath: string): number {
    if (!existsSync(logPath)) return 0;
    try {
      const lines = readFileSync(logPath, "utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i]?.trim();
        if (!trimmed) continue;
        const event = JSON.parse(trimmed) as RunStageEvent;
        if (typeof event.seq === "number") return event.seq;
      }
    } catch {
      /* fall through to 0 */
    }
    return 0;
  }
}
