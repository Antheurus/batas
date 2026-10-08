// Where the hook's semantic floor (config.semantic.minCos) should sit, measured, and whether moving prompt matching off
// trigger words loses anything. Three samples through the running batasd:
//   positives  the 80 blind probes of evals/semantic-probes.json against their own lesson (cosines of the right entry)
//   prompts    the user's recent real prompts (own words, deduplicated): how many would get a hit at each floor
//   triggered  memories the trigger words match on those same prompts: how many semantic search also reaches
// Writes .semantic-calibrate.json with every prompt's passing hits, so the hits can be read and judged by a person.
//
//   bun scripts/semantic-calibrate.ts [prompts=300]
import { join } from "node:path";
import { config } from "../src/config.ts";
import { type Kind, memoryTriggers, projectSlug } from "../src/corpus.ts";
import { ownWords, saysTrigger } from "../src/hook.ts";
import { semanticSearch, type SemanticHit } from "../src/semantic.ts";
import { Store } from "../src/store.ts";
import { historyPrompts } from "./prompt-audit.ts";

const KINDS: Kind[] = ["memory", "rule", "rule-section", "project-rule", "context"];
const N = Number(process.argv[2] ?? 300);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] ?? 0;

const probes = (await Bun.file(join(import.meta.dir, "..", "evals", "semantic-probes.json")).json()) as { title: string; en: string; id: string }[];
const pos: { g: number; e: number }[] = [];
for (const p of probes) {
  for (const q of [p.en, p.id]) {
    const hits = (await semanticSearch(q, { kinds: ["context"], scope: "mendadak-pos", limit: 10, timeoutMs: 30000 })) ?? [];
    const h = hits.find((x) => x.title.trim() === p.title.trim());
    if (h) pos.push(h.cos);
  }
}

const store = new Store();
store.refresh("all");
const memories = store.entries("memory");
const seen = new Set<string>();
const prompts: { text: string; project: string }[] = [];
const history = (await Bun.file(join(config.claudeHome, "history.jsonl")).text()).split("\n").filter(Boolean).reverse();
for (const line of history) {
  if (prompts.length >= N) break;
  try {
    const r = JSON.parse(line) as { display?: string; project?: string };
    const text = ownWords(String(r.display ?? "")).trim();
    if (text.length < 12 || text.startsWith("/") || seen.has(text)) continue;
    seen.add(text);
    prompts.push({ text, project: r.project ? projectSlug(r.project) : "" });
  } catch {}
}
if (!historyPrompts().length) throw new Error("no history");

const rows: { prompt: string; hits: SemanticHit[]; triggered: string[] }[] = [];
for (const p of prompts) {
  const hits = (await semanticSearch(p.text, { kinds: KINDS, limit: 12, timeoutMs: 30000 })) ?? [];
  const lower = p.text.toLowerCase();
  const triggered = memories.filter((m) => memoryTriggers(m.title).some((t) => saysTrigger(lower, t))).map((m) => m.id);
  rows.push({ prompt: p.text, hits, triggered });
}

console.log(`positives (right lesson found in top 10): ${pos.length}/80`);
console.log(`  gemma cos p10 ${pct(pos.map((x) => x.g), 0.1).toFixed(3)} p50 ${pct(pos.map((x) => x.g), 0.5).toFixed(3)} | me5 cos p10 ${pct(pos.map((x) => x.e), 0.1).toFixed(3)} p50 ${pct(pos.map((x) => x.e), 0.5).toFixed(3)}`);
const top = rows.map((r) => r.hits[0]?.cos ?? { g: 0, e: 0 });
console.log(`real prompts: ${rows.length}; top-1 gemma cos p50 ${pct(top.map((x) => x.g), 0.5).toFixed(3)} p90 ${pct(top.map((x) => x.g), 0.9).toFixed(3)} | me5 p50 ${pct(top.map((x) => x.e), 0.5).toFixed(3)} p90 ${pct(top.map((x) => x.e), 0.9).toFixed(3)}`);
const trig = rows.flatMap((r) => r.triggered.map((id) => ({ id, hit: r.hits.find((h) => h.id === id) })));
console.log(`trigger-word memory matches on these prompts: ${trig.length}`);
console.log("\nfloor (gemma, me5) | positives kept | prompts with >=1 hit | hits per prompt | trigger matches also reached");
for (const g of [0.35, 0.4, 0.45, 0.5, 0.55, 0.6]) {
  for (const e of [0.8, 0.82, 0.84, 0.86]) {
    const ok = (c: { g: number; e: number }) => c.g >= g && c.e >= e;
    const kept = pos.filter(ok).length;
    const withHit = rows.filter((r) => r.hits.some((h) => ok(h.cos))).length;
    const perPrompt = rows.reduce((n, r) => n + r.hits.filter((h) => ok(h.cos)).length, 0) / Math.max(rows.length, 1);
    const reached = trig.filter((t) => t.hit && ok(t.hit.cos)).length;
    console.log(`  ${g.toFixed(2)}, ${e.toFixed(2)}      | ${String(kept).padStart(3)}/${pos.length}         | ${String(withHit).padStart(4)}/${rows.length}            | ${perPrompt.toFixed(2)}            | ${reached}/${trig.length}`);
  }
}
await Bun.write(join(import.meta.dir, "..", ".semantic-calibrate.json"), JSON.stringify({ pos, rows }, null, 1));
