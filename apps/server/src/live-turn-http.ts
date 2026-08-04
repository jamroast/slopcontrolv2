/**
 * Shared helpers for streaming / stopping interactive live turns over HTTP.
 */

import type { Response } from "express";
import {
  askProgressLine,
  formatAskWorkingStub,
  isLiveTurnInterruptedError,
  type LiveProgressEvent,
} from "@slopcontrol/mastra";
import { liveTurns, type LiveTurnKind } from "./live-turns.js";

export function wantsLiveStream(req: {
  query?: Record<string, unknown>;
  headers?: { accept?: string };
}): boolean {
  const q = req.query ?? {};
  return (
    q.stream === "1" ||
    q.stream === "true" ||
    String(req.headers?.accept ?? "").includes("text/event-stream")
  );
}

export function beginSse(res: Response): void {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  (res as { flushHeaders?: () => void }).flushHeaders?.();
}

export function writeSse(
  res: Response,
  payload: Record<string, unknown>,
): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export type BoundLiveTurn = {
  turnId: string;
  signal: AbortSignal;
  onProgress: (event: LiveProgressEvent) => void;
  completeDone: (extra?: Record<string, unknown>) => void;
  completeInterrupted: (
    partial: string,
    extra?: Record<string, unknown>,
  ) => void;
  completeFailed: (error: string, extra?: Record<string, unknown>) => void;
  progressLines: string[];
};

/**
 * Register a live turn, optionally open SSE, and bridge onProgress → registry + SSE.
 */
export function bindLiveTurn(opts: {
  kind: LiveTurnKind;
  projectId: string;
  sessionId: string;
  res: Response;
  stream: boolean;
}): BoundLiveTurn {
  const turn = liveTurns.start({
    kind: opts.kind,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
  });
  const progressLines: string[] = [];

  if (opts.stream) {
    beginSse(opts.res);
    writeSse(opts.res, {
      type: "status",
      summary: "turn started",
      turnId: turn.turnId,
      askId: opts.kind === "ask" ? opts.sessionId : undefined,
      sessionId: opts.sessionId,
    });
  }

  const onProgress = (event: LiveProgressEvent) => {
    liveTurns.emit(turn.turnId, event);
    if (opts.stream) writeSse(opts.res, event);
    const line = askProgressLine(event);
    if (line) progressLines.push(line);
  };

  return {
    turnId: turn.turnId,
    signal: turn.controller.signal,
    onProgress,
    progressLines,
    completeDone(extra) {
      liveTurns.complete(turn.turnId, "done");
      if (opts.stream) {
        writeSse(opts.res, {
          type: "done",
          turnId: turn.turnId,
          sessionId: opts.sessionId,
          ...extra,
        });
        opts.res.end();
      }
    },
    completeInterrupted(partial, extra) {
      liveTurns.complete(turn.turnId, "interrupted", {
        reason: turn.interruptReason ?? "operator_stop",
        partialReply: partial,
      });
      if (opts.stream) {
        writeSse(opts.res, {
          type: "interrupted",
          code: "interrupted",
          reason: turn.interruptReason ?? "operator_stop",
          reply: partial,
          turnId: turn.turnId,
          sessionId: opts.sessionId,
          ...extra,
        });
        opts.res.end();
      }
    },
    completeFailed(error, extra) {
      liveTurns.complete(turn.turnId, "failed", { reason: error });
      if (opts.stream) {
        writeSse(opts.res, {
          type: "error",
          error,
          turnId: turn.turnId,
          sessionId: opts.sessionId,
          ...extra,
        });
        opts.res.end();
      }
    },
  };
}

export function workingStubFromBound(bound: BoundLiveTurn): string {
  return formatAskWorkingStub(bound.progressLines);
}

export { isLiveTurnInterruptedError, liveTurns };
