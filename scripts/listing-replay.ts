// Replays real prompts from history through the prompt hook (cold: no batasd answer, so only the word paths run) and
// counts the memories it surfaces, split by why: the prompt says one of the memory's trigger words, or it does not
// (shared content words only). Run before and after a change to the word paths; the trigger column must hold.
//
//   bun scripts/listing-replay.ts [prompts=500] [out=.listing-replay.json]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { allMemorySources, memoryTriggers } from "../src/corpus.ts";
import { evaluate, ownWords, repoRoot, saysTrigger } from "../src/hook.ts";
import { Store } from "../src/store.ts";
import { Triggers } from "../src/triggers.ts";

const N = Number(process.argv[2] ?? 500);
const out = process.argv[3] ?? join(import.meta.dir, "..", ".listing-replay.json");
const store = new Store();
store.refresh("rules", allMemorySources());
const titles = new Map(store.entries("memory").map((m) => [m.id, m.title]));
const triggers = Triggers.load();

const seen = new Set<string>();
const prompts: { text: string; cwd: string }[] = [];
for (const line of readFileSync(join(config.claudeHome, "history.jsonl"), "utf8").split("\n").reverse()) {
  if (prompts.length >= N) break;
  try {
    const r = JSON.parse(line) as { display?: string; project?: string };
    const text = String(r.display ?? "").trim();
    if (text.length < 12 || text.startsWith("/") || seen.has(text) || !r.project || !repoRoot(r.project)) continue;
    seen.add(text);
    prompts.push({ text, cwd: r.project });
  } catch {}
}

const rows = prompts.map((p, i) => {
  const fired = evaluate({ session_id: `replay-${process.pid}-${i}`, cwd: p.cwd, hook_event_name: "UserPromptSubmit", prompt: p.text }, store, triggers).fired;
  const memories = fired.filter((id) => id.startsWith("memory:"));
  const lower = ownWords(p.text).toLowerCase();
  const said = (id: string) => memoryTriggers(titles.get(id) ?? "").some((t) => saysTrigger(lower, t));
  return { prompt: p.text.slice(0, 160), triggered: memories.filter(said), other: memories.filter((id) => !said(id)) };
});

const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0);
console.log(`prompts ${rows.length}`);
console.log(`memories surfaced: ${sum((r) => r.triggered.length + r.other.length)} (${(sum((r) => r.triggered.length + r.other.length) / rows.length).toFixed(2)} per prompt)`);
console.log(`  by a trigger word: ${sum((r) => r.triggered.length)} on ${rows.filter((r) => r.triggered.length).length} prompts`);
console.log(`  without one:       ${sum((r) => r.other.length)} on ${rows.filter((r) => r.other.length).length} prompts; max on one prompt ${Math.max(0, ...rows.map((r) => r.other.length))}`);
await Bun.write(out, JSON.stringify(rows, null, 1));
