import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

export type HookLogRow = {
  ts: string;
  event?: string;
  tool?: string;
  session?: string;
  repo?: string;
  fired: string[];
  ms: number;
  // characters of context the call handed to the model
  bytes?: number;
  // a `claude -p` / SDK session (CLAUDE_CODE_ENTRYPOINT=sdk-cli): a probe the agent started, not a person's session
  headless?: boolean;
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

// Only the tail is read: this runs before git commands, and a 15-minute window is a few hundred rows at most.
export function liveSessions(repo: string, except: string, sinceMs: number, tailBytes = 256 * 1024): Map<string, number> {
  const file = logFile();
  const seen = new Map<string, number>();
  if (!existsSync(file)) return seen;
  const size = statSync(file).size;
  const start = Math.max(0, size - tailBytes);
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.includes(repo)) continue;
    try {
      const row = JSON.parse(line) as HookLogRow;
      const ts = Date.parse(row.ts);
      if (row.repo === repo && row.session && row.session !== except && !row.headless && ts >= sinceMs) {
        seen.set(row.session, Math.max(seen.get(row.session) ?? 0, ts));
      }
    } catch {}
  }
  return seen;
}
