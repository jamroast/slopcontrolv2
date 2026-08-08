import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  watch,
  statSync,
  fstatSync,
} from "node:fs";
import { cmdUp } from "./cmd-up.js";
import { checkHttpHealth } from "./health.js";
import { loadConfig } from "./config.js";
import {
  cliLogsDir,
  listServiceLogFiles,
  readLastLines,
  serviceLogPath,
} from "./log-store.js";

export type CmdLogsOptions = {
  follow?: boolean;
  /** Print this many trailing lines before follow (default 80). */
  lines?: number;
  /** Start stack detached if server is not healthy. */
  up?: boolean;
  /** Service ids to show (default: all log files present, preferring server). */
  services?: string[];
  cwd?: string;
};

function parseLogsArgs(argv: string[]): CmdLogsOptions {
  const opts: CmdLogsOptions = { services: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-f" || a === "--follow") opts.follow = true;
    else if (a === "--up") opts.up = true;
    else if (a === "-n" || a === "--lines") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${a} requires a non-negative number`);
      }
      opts.lines = Math.floor(n);
    } else if (a === "-h" || a === "--help") {
      throw new Error("HELP");
    } else if (a.startsWith("-")) {
      throw new Error(`Unknown logs option: ${a}`);
    } else {
      opts.services!.push(a);
    }
  }
  return opts;
}

async function ensureStackUp(cwd: string): Promise<void> {
  const { config } = loadConfig(cwd);
  const healthy = await checkHttpHealth(config.server.health.http, "http-ok");
  if (healthy) {
    console.error(`[logs] server already healthy at ${config.server.health.http}`);
    return;
  }
  console.error("[logs] server not healthy — starting stack detached…");
  await cmdUp({ cwd, detach: true, quietConsole: false }, ["--detach"]);
}

/**
 * Follow a log file from its current end (or after printing last lines).
 * Resolves when abort fires.
 */
function followLogFile(
  filePath: string,
  label: string,
  startOffset: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let offset = startOffset;
    let fd: number | null = null;
    let fdIno: number | null = null;
    let watcher: ReturnType<typeof watch> | null = null;
    let timer: NodeJS.Timeout | null = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (fd != null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
        fdIno = null;
      }
    };

    const onAbort = () => {
      cleanup();
      resolve();
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      fd = openSync(filePath, "r");
      fdIno = fstatSync(fd).ino;
    } catch (err) {
      signal.removeEventListener("abort", onAbort);
      reject(err);
      return;
    }

    const pump = () => {
      if (closed) return;
      try {
        const st = statSync(filePath);
        const size = st.size;
        if (fd == null || st.ino !== fdIno) {
          // Rotated / recreated: fs.watch tracks the renamed inode, so
          // reopen the path to follow the fresh log.
          if (fd != null) {
            try {
              closeSync(fd);
            } catch {
              /* ignore */
            }
          }
          fd = openSync(filePath, "r");
          fdIno = fstatSync(fd).ino;
          offset = 0;
        }
        if (size < offset) {
          // truncated
          offset = 0;
        }
        if (size === offset) return;
        const len = size - offset;
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        offset += n;
        const text = buf.toString("utf-8", 0, n);
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          // Lines already include [label] from tee; avoid double-prefix when present
          if (line.startsWith("[")) process.stdout.write(`${line}\n`);
          else process.stdout.write(`[${label}] ${line}\n`);
        }
      } catch {
        /* transient */
      }
    };

    pump();
    try {
      watcher = watch(filePath, { persistent: true }, () => pump());
      // Poll as well: after rotation the watcher is bound to the renamed
      // inode and never fires for the new file at this path.
      timer = setInterval(pump, 2000);
      timer.unref?.();
    } catch (err) {
      cleanup();
      signal.removeEventListener("abort", onAbort);
      reject(err);
    }
  });
}

export async function cmdLogs(
  argv: string[] = [],
  cwd: string = process.cwd(),
): Promise<void> {
  let opts: CmdLogsOptions;
  try {
    opts = parseLogsArgs(argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "HELP") {
      console.log(`Usage: slopcontrol logs [-f|--follow] [-n N] [--up] [service…]

  -f, --follow   Keep streaming new log lines
  -n, --lines N  Show last N lines first (default 80; 0 = none)
  --up           Start the stack detached if the server is not healthy
  service        Optional service id(s): server, web, opencode, …

Log files: ${cliLogsDir()}/<service>.log
`);
      return;
    }
    throw err;
  }

  if (opts.up) {
    await ensureStackUp(opts.cwd ?? cwd);
  }

  const lines = opts.lines ?? 80;
  const available = listServiceLogFiles();
  let targets = available;
  if (opts.services && opts.services.length > 0) {
    targets = opts.services.map((id) => {
      const hit = available.find((a) => a.id === id);
      return hit ?? { id, path: serviceLogPath(id), size: 0 };
    });
  } else if (targets.length === 0) {
    // Prefer server even if empty so --follow waits for creation after --up
    targets = [{ id: "server", path: serviceLogPath("server"), size: 0 }];
  }

  const missing = targets.filter((t) => !existsSync(t.path) || t.size === 0);
  if (missing.length === targets.length && !opts.follow) {
    console.error(
      `No log output yet under ${cliLogsDir()}.\n` +
        `Start the stack with logging:  slopcontrol up -d\n` +
        `Then:  slopcontrol logs -f`,
    );
    process.exitCode = 1;
    return;
  }

  for (const t of targets) {
    if (!existsSync(t.path)) {
      if (opts.follow) {
        console.error(`[logs] waiting for ${t.path} …`);
        continue;
      }
      console.error(`[logs] missing ${t.path}`);
      continue;
    }
    const chunk = readLastLines(t.path, lines);
    if (chunk) {
      process.stdout.write(`${chunk}\n`);
    }
  }

  if (!opts.follow) return;

  console.error(`[logs] following ${targets.map((t) => t.id).join(", ")}  (Ctrl+C to stop)`);

  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.on("SIGINT", onSig);
  process.on("SIGTERM", onSig);

  try {
    await Promise.all(
      targets.map(async (t) => {
        // Wait until file exists when started with --up before spawn finishes writing
        const deadline = Date.now() + 90_000;
        while (!existsSync(t.path) && Date.now() < deadline && !ac.signal.aborted) {
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!existsSync(t.path) || ac.signal.aborted) return;
        const size = statSync(t.path).size;
        await followLogFile(t.path, t.id, size, ac.signal);
      }),
    );
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}
