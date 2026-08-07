/**
 * Ask-parity Working stubs + final reply for design/plan loops.
 */
import {
  appendLoopChatMessage,
  replaceLastAssistantLoopChatMessage,
  readLoopChatMessages,
  type LoopChatKind,
  type LoopChatMessage,
} from "@slopcontrol/artifacts";
import {
  askProgressLine,
  type LiveProgressEvent,
} from "@slopcontrol/mastra";

export function createLoopChatTurn(opts: {
  projectRoot: string;
  kind: LoopChatKind;
  loopId: string;
  bound: {
    onProgress: (event: LiveProgressEvent) => void;
  };
  workingStubFromBound: (bound: any) => string;
}): {
  onProgress: (event: LiveProgressEvent) => void;
  finalizeAssistant: (
    reply: string,
    meta?: { version?: number; ops?: string[]; assets?: string[] },
  ) => LoopChatMessage[];
  appendUser: (content: string) => LoopChatMessage[];
  messages: () => LoopChatMessage[];
} {
  let workingStubStarted = false;

  return {
    appendUser(content: string) {
      return appendLoopChatMessage(opts.projectRoot, opts.kind, opts.loopId, {
        role: "user",
        content,
        meta: { kind: "final" },
      });
    },
    onProgress(event: LiveProgressEvent) {
      opts.bound.onProgress(event);
      const line = askProgressLine(event);
      if (!line) return;
      const stub = opts.workingStubFromBound(opts.bound);
      if (!workingStubStarted) {
        appendLoopChatMessage(opts.projectRoot, opts.kind, opts.loopId, {
          role: "assistant",
          content: stub,
          meta: { kind: "working" },
        });
        workingStubStarted = true;
      } else {
        replaceLastAssistantLoopChatMessage(
          opts.projectRoot,
          opts.kind,
          opts.loopId,
          stub,
          { meta: { kind: "working" } },
        );
      }
    },
    finalizeAssistant(reply, meta) {
      const content = reply.trim() || "(empty reply)";
      const at = new Date().toISOString();
      if (workingStubStarted) {
        return replaceLastAssistantLoopChatMessage(
          opts.projectRoot,
          opts.kind,
          opts.loopId,
          content,
          {
            at,
            meta: { kind: "final", ...meta },
          },
        );
      }
      return appendLoopChatMessage(opts.projectRoot, opts.kind, opts.loopId, {
        role: "assistant",
        content,
        at,
        meta: { kind: "final", ...meta },
      });
    },
    messages() {
      return readLoopChatMessages(opts.projectRoot, opts.kind, opts.loopId);
    },
  };
}
