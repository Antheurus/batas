// Client for batasd (batasd/batasd.py): the only semantic search batas has. The daemon loads two models in ~10 s, so
// nothing here ever waits for a cold one: a call that cannot connect starts it detached and answers `undefined`, and the
// caller carries on without semantic results.
import { existsSync, openSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { config } from "./config.ts";
import type { Kind } from "./corpus.ts";

// ref: the 10th-best Gemma cosine over the filtered set (the same on every hit of one search).
export type SemanticHit = { id: string; kind: Kind; scope: string; title: string; source: string; score: number; cos: { g: number; e: number }; ref?: number };

const SOCK = join(config.stateDir, "batasd.sock");
const SPAWNED = join(config.stateDir, "batasd.spawned");
const SCRIPT = join(import.meta.dir, "..", "batasd", "batasd.py");

export function ask<T = Record<string, unknown>>(req: object, timeoutMs: number): Promise<T | undefined> {
  return new Promise((done) => {
    let buf = "";
    let settled = false;
    const finish = (v: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      done(v);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const sock = createConnection({ path: SOCK });
    sock.on("connect", () => sock.write(`${JSON.stringify(req)}\n`));
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        try {
          finish(JSON.parse(buf.slice(0, nl)) as T);
        } catch {
          finish(undefined);
        }
      }
    });
    sock.on("error", () => {
      start();
      finish(undefined);
    });
  });
}

// Detached and at most once a minute: every hook call of a cold machine would otherwise spawn its own uv run.
export function start(): void {
  if (process.env.BATAS_NO_DAEMON === "1") return;
  try {
    if (existsSync(SPAWNED) && Date.now() - statSync(SPAWNED).mtimeMs < 60_000) return;
    writeFileSync(SPAWNED, String(Date.now()));
    const out = openSync(join(config.stateDir, "batasd.out"), "a");
    Bun.spawn(["uv", "run", "--script", SCRIPT], { stdio: ["ignore", out, out], env: process.env }).unref();
  } catch {}
}

export async function semanticSearch(
  query: string,
  opts: { kinds?: Kind[]; scope?: string; limit?: number; timeoutMs?: number; prefix?: string; stash?: string } = {},
): Promise<SemanticHit[] | undefined> {
  const r = await ask<{ ok: boolean; hits?: SemanticHit[] }>(
    { op: "search", query, kinds: opts.kinds, scope: opts.scope, limit: opts.limit ?? 8, prefix: opts.prefix, stash: opts.stash },
    opts.timeoutMs ?? 5000,
  );
  return r?.ok ? (r.hits ?? []) : undefined;
}

export function requestSync(): void {
  void ask({ op: "sync" }, 500);
}

// The result of a search this session left with batasd because the prompt hook could not wait for it; null = nothing
// (yet), undefined = batasd did not answer.
export async function takeStashed(key: string, timeoutMs: number): Promise<SemanticHit[] | null | undefined> {
  const r = await ask<{ ok: boolean; hits: SemanticHit[] | null }>({ op: "take", key }, timeoutMs);
  return r?.ok ? r.hits : undefined;
}
