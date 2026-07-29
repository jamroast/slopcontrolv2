#!/usr/bin/env node
import { cmdDown } from "./cmd-down.js";
import { cmdInit } from "./cmd-init.js";
import { cmdStatus } from "./cmd-status.js";
import { cmdUp } from "./cmd-up.js";

const HELP = `slopcontrol — run the SlopControl stack (server + coding engine)

Usage:
  slopcontrol init              Write slopcontrol.yaml in the current directory
  slopcontrol up                Start coding engine then server (stream logs)
  slopcontrol down              Stop processes tracked in ~/.slopcontrol/cli/stack.pid.json
  slopcontrol status            Health + PID status for configured services
  slopcontrol help              Show this help

Config: walk up from cwd for slopcontrol.yaml, else ~/.slopcontrol/slopcontrol.yaml
`;

async function main(): Promise<void> {
  const raw = process.argv.slice(2);
  // Tolerate accidental `--` from nested pnpm forwarding
  while (raw[0] === "--") raw.shift();
  const cmd = raw[0]?.trim() || "help";

  switch (cmd) {
    case "init":
      cmdInit();
      break;
    case "up":
      await cmdUp();
      break;
    case "down":
      await cmdDown();
      break;
    case "status":
      await cmdStatus();
      break;
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
});
