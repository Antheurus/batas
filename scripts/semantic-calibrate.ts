// Where the hook's standout gate (config.semantic.minGap: best Gemma cosine minus the 10th) should sit, measured, and
// whether semantic prompt matching reaches what trigger words reach. Three samples through the running batasd:
//   positives  the 80 blind probes of evals/semantic-probes.json: gap of those whose right lesson comes out on top
//   prompts    the user's recent real prompts (own words, deduplicated): how many would pass at each gap
//   triggered  memories the trigger words match on those same prompts: how many pass as the semantic top hit
// An absolute cosine floor was measured first and rejected: probe positives (Gemma 0.77 median) and unrelated prompts'
// top hits (0.72) overlap, so every floor either drops the positives or passes most prompts.
// Writes .semantic-calibrate.json with every prompt's passing hits, so the hits can be read and judged by a person.
//
//   bun scripts/semantic-calibrate.ts [prompts=300]
import { join } from "node:path";
import { config } from "../src/config.ts";
import { type Kind, memoryTriggers, projectSlug } from "../src/corpus.ts";
import { ownWords, repoName, saysTrigger } from "../src/hook.ts";
import { semanticSearch, type SemanticHit } from "../src/semantic.ts";
import { Store } from "../src/store.ts";
import { historyPrompts } from "./prompt-audit.ts";

const KINDS: Kind[] = ["memory", "rule", "rule-section", "project-rule", "context"];
const N = Number(process.argv[2] ?? 300);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] ?? 0;

const probes = (await Bun.file(join(import.meta.dir, "..", "evals", "semantic-probes.json")).json()) as { title: string; en: string; id: string }[];
const gapOf = (hits: SemanticHit[]) => Math.max(0, ...hits.map((h) => h.cos.g)) - (hits[0]?.ref ?? 1);
const best = (hits: SemanticHit[]) => hits.reduce<SemanticHit | undefined>((a, b) => (!a || b.cos.g > a.cos.g ? b : a), undefined);
const pos: number[] = [];
for (const p of probes) {
  for (const q of [p.en, p.id]) {
    const hits = (await semanticSearch(q, { kinds: KINDS, scope: "mendadak-pos", limit: 12, timeoutMs: 30000 })) ?? [];
    if (best(hits)?.title.trim() === p.title.trim()) pos.push(gapOf(hits));
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
    prompts.push({ text, project: r.project ? (repoName(r.project) ?? "") : "" });
  } catch {}
}
if (!historyPrompts().length) throw new Error("no history");

const rows: { prompt: string; hits: SemanticHit[]; triggered: string[] }[] = [];
for (const p of prompts) {
  const hits = (await semanticSearch(p.text, { kinds: KINDS, scope: p.project || undefined, limit: 12, timeoutMs: 30000 })) ?? [];
  const lower = p.text.toLowerCase();
  const triggered = memories.filter((m) => memoryTriggers(m.title).some((t) => saysTrigger(lower, t))).map((m) => m.id);
  rows.push({ prompt: p.text, hits, triggered });
}

console.log(`positives (right lesson is the top Gemma hit): ${pos.length}/80; gap p10 ${pct(pos, 0.1).toFixed(3)} p50 ${pct(pos, 0.5).toFixed(3)}`);
console.log(`real prompts: ${rows.length}; gap p50 ${pct(rows.map((r) => gapOf(r.hits)), 0.5).toFixed(3)} p90 ${pct(rows.map((r) => gapOf(r.hits)), 0.9).toFixed(3)}`);
const trig = rows.flatMap((r) => r.triggered.map((id) => ({ id, r })));
console.log(`trigger-word memory matches on these prompts: ${trig.length}`);
console.log("\ngap   | positives kept | prompts passing | trigger matches that are the passing top hit");
for (const g of [0.04, 0.05, 0.06, 0.065, 0.07, 0.08, 0.1]) {
  const passes = (r: { hits: SemanticHit[] }) => gapOf(r.hits) >= g;
  const reached = trig.filter((t) => passes(t.r) && best(t.r.hits)?.id === t.id).length;
  console.log(`${g.toFixed(3)} | ${String(pos.filter((x) => x >= g).length).padStart(3)}/${pos.length}         | ${String(rows.filter(passes).length).padStart(4)}/${rows.length}       | ${reached}/${trig.length}`);
}
// Memories alone: the best memory's Gemma cosine over the same reference. Rules and lessons crowd memories out of the
// single passing slot, so a memory that is clearly the closest MEMORY can sit under the shared gate.
const memOf = (hits: SemanticHit[]) => best(hits.filter((h) => h.kind === "memory"));
const memGap = (hits: SemanticHit[]) => (memOf(hits)?.cos.g ?? 0) - (hits[0]?.ref ?? 1);
console.log("\nmemory gap | prompts passing | trigger matches that are the passing best memory");
for (const g of [0.03, 0.035, 0.04, 0.045, 0.05, 0.06, 0.07]) {
  const passes = (r: { hits: SemanticHit[] }) => memGap(r.hits) >= g;
  const reached = trig.filter((t) => passes(t.r) && memOf(t.r.hits)?.id === t.id).length;
  console.log(`${g.toFixed(3)}      | ${String(rows.filter(passes).length).padStart(4)}/${rows.length}       | ${reached}/${trig.length}`);
}
await Bun.write(
  join(import.meta.dir, "..", ".semantic-calibrate.json"),
  JSON.stringify({ pos, rows: rows.map((r) => ({ prompt: r.prompt, gap: gapOf(r.hits), top: best(r.hits)?.id, memGap: memGap(r.hits), topMemory: memOf(r.hits)?.id, triggered: r.triggered })) }, null, 1),
);
