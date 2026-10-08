import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
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
  // the call ran `git commit`: a headless session that commits is carried by the next push, so it counts as live
  committed?: boolean;
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
const realPaths = new Map<string, string>();
function realPath(p: string): string {
  let r = realPaths.get(p);
  if (r === undefined) {
    try {
      r = realpathSync(p);
    } catch {
      r = p;
    }
    realPaths.set(p, r);
  }
  return r;
}

export function liveSessions(repo: string, except: string, sinceMs: number, tailBytes = 256 * 1024): Map<string, number> {
  const file = logFile();
  const seen = new Map<string, number>();
  const headless = new Map<string, number>();
  const committers = new Set<string>();
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
  // One checkout can be logged under two spellings (/tmp/x from a `cd`, /private/tmp/x from a session cwd), so rows
  // are compared by real path; the cheap prefilter only needs the repo's directory name.
  const want = realPath(repo);
  const names = [basename(repo), basename(want)];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!names.some((n) => line.includes(n))) continue;
    try {
      const row = JSON.parse(line) as HookLogRow;
      const ts = Date.parse(row.ts);
      if (!row.repo || realPath(row.repo) !== want || !row.session || row.session === except || ts < sinceMs) continue;
      if (row.committed) committers.add(row.session);
      const into = row.headless ? headless : seen;
      into.set(row.session, Math.max(into.get(row.session) ?? 0, ts));
    } catch {}
  }
  for (const [session, ts] of headless) if (committers.has(session)) seen.set(session, Math.max(seen.get(session) ?? 0, ts));
  return seen;
}
