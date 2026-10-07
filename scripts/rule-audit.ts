// Replay real tool calls from recent session transcripts through the hook's own Triggers, to find rule triggers that
// never fire (a broken regex looks exactly like a rare situation until replayed) and ones that fire on too much.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { readFeedback } from "../src/feedback.ts";
import { readHookLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { Triggers } from "../src/triggers.ts";

const days = Number(process.argv[2] ?? 14);
const noisyShare = Number(process.argv[3] ?? 0.02);
const since = Date.now() - days * 24 * 3600 * 1000;

function transcripts(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) transcripts(p, out);
    else if (name.endsWith(".jsonl") && st.mtimeMs >= since) out.push(p);
  }
  return out;
}

type Call = { cmd?: string; path?: string; code?: string; session: string };
const calls: Call[] = [];
for (const file of transcripts(config.projectsDir)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let row: { message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (b.type !== "tool_use" || !b.input) continue;
      const i = b.input;
      if (b.name === "Bash" && typeof i.command === "string") calls.push({ cmd: i.command, session: file });
      else if (typeof i.file_path === "string") {
        const prose = /\.(md|mdx|txt|rst|toml)$/i.test(i.file_path);
        const code = prose ? undefined : [i.new_string, i.content].filter((x) => typeof x === "string").join("\n").slice(0, 20000);
        calls.push({ path: i.file_path, code: code || undefined, session: file });
      }
    }
  }
}

const triggers = Triggers.load();
const ruleIds = triggers.ids().filter((id) => !/^(hint|memory):/.test(id));
const fires = new Map<string, number>(ruleIds.map((id) => [id, 0]));
// The hook injects an id at most once per session, so the share of SESSIONS reached is what an id actually costs.
const sessionsHit = new Map<string, Set<string>>();
for (const c of calls) {
  for (const m of triggers.match(c)) {
    if (!fires.has(m.id)) continue;
    fires.set(m.id, (fires.get(m.id) ?? 0) + 1);
    if (!sessionsHit.has(m.id)) sessionsHit.set(m.id, new Set());
    sessionsHit.get(m.id)?.add(c.session);
  }
}
const sessionCount = new Set(calls.map((c) => c.session)).size;

const live = new Map<string, number>();
for (const r of readHookLog(since)) for (const id of r.fired) live.set(id, (live.get(id) ?? 0) + 1);
const reported = new Map<string, number>();
for (const f of readFeedback()) for (const id of f.ids) reported.set(id, (reported.get(id) ?? 0) + 1);

const cmdOnly = (id: string) => {
  const s = triggers.specs[id];
  return !!s && !(s.prompt?.length || s.reply?.length);
};
const never = ruleIds.filter((id) => !fires.get(id) && !live.get(id) && cmdOnly(id));
const noisy = ruleIds
  .map((id) => ({ id, n: fires.get(id) ?? 0 }))
  .filter((r) => r.n / Math.max(calls.length, 1) >= noisyShare)
  .sort((a, b) => b.n - a.n);

console.log(`replayed ${calls.length} tool calls in ${sessionCount} transcripts from ${days} days against ${ruleIds.length} rule triggers`);
console.log(`\nNOISY — fire on >= ${(noisyShare * 100).toFixed(0)}% of tool calls (tighten the regex or path glob):`);
for (const r of noisy) console.log(`  ${((r.n / calls.length) * 100).toFixed(1).padStart(5)}% of calls, ${(((sessionsHit.get(r.id)?.size ?? 0) / Math.max(sessionCount, 1)) * 100).toFixed(0).padStart(3)}% of sessions  ${r.id.padEnd(14)} ${r.n}${reported.get(r.id) ? `  reported wrong ×${reported.get(r.id)}` : ""}`);
console.log(`\nNEVER FIRED — no replay hit and no live fire in ${days} days, cmd/path/code triggers only (check the regex against a real command, or accept it as rare):`);
for (const id of never) console.log(`  ${id.padEnd(14)} ${JSON.stringify(triggers.specs[id]?.cmd ?? triggers.specs[id]?.path ?? triggers.specs[id]?.code ?? []).slice(0, 110)}`);
if (reported.size) {
  console.log("\nREPORTED WRONG by the user:");
  for (const [id, n] of [...reported].sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(30)} ×${n}`);
}

// Tiering: the always-on mothers are paid every turn of every session, an injected item only when it fires. An item
// reaching most sessions is cheaper always-on; one that almost never fires but can still be triggered is cheaper
// injected. Destructiveness is not measurable here, so the report proposes and the rules-writer rubric (Q4) decides.
const store = new Store();
store.refresh("rules");
const ALWAYS_ON = new Set(["lessons.md", "gotcha-coding.md"]);
const promoteShare = Number(process.argv[4] ?? 0.3);
const demoteShare = Number(process.argv[5] ?? 0.02);
const rows = (store.db.query("SELECT id, source, body FROM entries WHERE kind = 'rule'").all() as { id: string; source: string; body: string }[]).map(
  (r) => ({ ...r, file: r.source.split("/").pop() ?? "", share: (sessionsHit.get(r.id)?.size ?? 0) / Math.max(sessionCount, 1) }),
);
const triggerable = (id: string) => {
  const sp = triggers.specs[id];
  return !!sp && !!(sp.cmd?.length || sp.path?.length || sp.code?.length);
};
const demote = rows.filter((r) => ALWAYS_ON.has(r.file) && r.share < demoteShare && triggerable(r.id)).sort((a, b) => b.body.length - a.body.length);
const promote = rows.filter((r) => !ALWAYS_ON.has(r.file) && r.share >= promoteShare).sort((a, b) => b.share - a.share);
const untriggerable = rows.filter((r) => ALWAYS_ON.has(r.file) && !triggerable(r.id));
console.log(`\nTIERING — always-on items reaching < ${(demoteShare * 100).toFixed(0)}% of sessions that a cmd/path/code trigger can still deliver (move to inject-only; destructive ones stay, rules-writer Q4):`);
for (const r of demote) console.log(`  ${r.id.padEnd(14)} ${(r.share * 100).toFixed(1).padStart(5)}% of sessions  ${String(r.body.length).padStart(5)} bytes always-on`);
console.log(`  total: ${demote.length} items, ${demote.reduce((a, r) => a + r.body.length, 0)} bytes`);
console.log(`\nTIERING — inject-only items reaching >= ${(promoteShare * 100).toFixed(0)}% of sessions (consider always-on):`);
for (const r of promote) console.log(`  ${r.id.padEnd(14)} ${(r.share * 100).toFixed(1).padStart(5)}% of sessions  in ${r.file}`);
console.log(`\nalways-on items with no cmd/path/code trigger (can only stay always-on, or gain a trigger first): ${untriggerable.map((r) => r.id).join(" ") || "none"}`);

