import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export type HookLogRow = {
  ts: string;
  event?: string;
  tool?: string;
  session?: string;
  fired: string[];
  ms: number;
  error?: string;
};

function logFile(n = 0): string {
  return join(config.stateDir, n === 0 ? "hook.log.jsonl" : `hook.log.${n}.jsonl`);
}

// The log is appended on every tool call of every session, so it rotates by size: hook.log.jsonl, then .1, .2 …
function rotate() {
  const current = logFile();
  if (!existsSync(current) || statSync(current).size < config.log.maxBytes) return;
  const oldest = logFile(config.log.keep);
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let n = config.log.keep - 1; n >= 1; n--) {
    if (existsSync(logFile(n))) renameSync(logFile(n), logFile(n + 1));
  }
  renameSync(current, logFile(1));
}

export function appendHookLog(row: HookLogRow) {
  mkdirSync(config.stateDir, { recursive: true });
  rotate();
  appendFileSync(logFile(), `${JSON.stringify(row)}\n`);
}

export function readHookLog(sinceMs: number): HookLogRow[] {
  const rows: HookLogRow[] = [];
  for (let n = config.log.keep; n >= 0; n--) {
    const file = logFile(n);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as HookLogRow;
        if (Date.parse(row.ts) >= sinceMs) rows.push(row);
      } catch {}
    }
  }
  return rows;
}
