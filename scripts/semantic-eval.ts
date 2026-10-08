// Acceptance 1 of docs/plan/2026-10-08-semantic-recall/plan.md, through the daemon itself: the 80 blind probes of
// evals/semantic-probes.json (40 mendadak-pos lessons, one English and one Indonesian query each) must put the right
// lesson in the top 3 at least as often as the offline comparison did (EN 35/40, ID 36/40).
//
//   bun scripts/semantic-eval.ts [scope=mendadak-pos] [--all]   (--all searches every kind and scope, the harder case)
import { join } from "node:path";
import { semanticSearch } from "../src/semantic.ts";

const probes = (await Bun.file(join(import.meta.dir, "..", "evals", "semantic-probes.json")).json()) as { title: string; en: string; id: string }[];
const all = process.argv.includes("--all");
// --lessons: the offline comparison's own corpus (docs/lessons only), to show the daemon reproduces it
const lessonsOnly = process.argv.includes("--lessons");
// --repo: every kind, this repo plus global entries — what recall answers from inside the repo
const repoWide = process.argv.includes("--repo");
const scope = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "mendadak-pos";
const norm = (s: string) => s.replace(/^#+\s*/, "").trim();
const res: Record<string, { top1: number; top3: number; ms: number[]; miss: string[] }> = {};
for (const lang of ["en", "id"] as const) {
  const r = (res[lang] = { top1: 0, top3: 0, ms: [] as number[], miss: [] as string[] });
  for (const p of probes) {
    const t = performance.now();
    const hits = await semanticSearch(p[lang], repoWide ? { scope, limit: 3, timeoutMs: 30000 } : all ? { limit: 3, timeoutMs: 30000 } : { kinds: ["context"], scope, limit: 3, timeoutMs: 30000, ...(lessonsOnly ? { prefix: `project:${scope}:lessons/` } : {}) });
    r.ms.push(performance.now() - t);
    if (!hits) throw new Error("batasd is not answering");
    const pos = hits.findIndex((h) => norm(h.title) === norm(p.title));
    if (pos === 0) r.top1++;
    if (pos >= 0) r.top3++;
    else r.miss.push(`${p[lang]}  ->  ${hits[0]?.title.slice(0, 70)}`);
  }
}
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
for (const [lang, r] of Object.entries(res)) {
  console.log(`${lang.toUpperCase()} top1 ${r.top1}/40 top3 ${r.top3}/40  round-trip p95 ${p95(r.ms).toFixed(0)}ms`);
  for (const m of r.miss) console.log(`   miss: ${m}`);
}
