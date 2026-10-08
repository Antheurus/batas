// Where the new-file gate (config.semantic.writeGap) should sit. A written file is searched as `path\ncontent` within
// its repo, like the hook does; the best Gemma cosine minus the repo's 10th-best is the gap.
//   positives  files the behavior eval's agents wrote for a trap (evals/results/*behavior-new*.json): the gap of the
//              ones whose target lesson comes out as the top hit
//   writes     real Write calls of source files from recent transcripts: how many would pass, and their top hit,
//              saved to .write-calibrate.json to be read by a person
//
//   bun scripts/write-calibrate.ts [days=14] [n=300]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import type { Kind } from "../src/corpus.ts";
import { repoName } from "../src/hook.ts";
import { semanticSearch, type SemanticHit } from "../src/semantic.ts";
import { callsIn, transcriptFiles } from "./transcripts.ts";

const KINDS: Kind[] = ["memory", "rule", "rule-section", "project-rule", "context"];
const SOURCE = /\.(go|ts|tsx|js|mjs|vue|svelte|py|sql|html)$/;
const days = Number(process.argv[2] ?? 14);
const N = Number(process.argv[3] ?? 300);
const gapOf = (h: SemanticHit[]) => Math.max(0, ...h.map((x) => x.cos.g)) - (h[0]?.ref ?? 1);
const best = (h: SemanticHit[]) => h.reduce<SemanticHit | undefined>((a, b) => (!a || b.cos.g > a.cos.g ? b : a), undefined);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)] ?? 0;

// files added in a unified diff: path -> added text
function newFiles(diff: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const part of diff.split(/^diff --git /m).slice(1)) {
    const path = part.match(/^\+\+\+ b\/(.+)$/m)?.[1];
    if (!path || !SOURCE.test(path)) continue;
    const text = part.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");
    if (text.length > 80) out.push({ path, text });
  }
  return out;
}

const results = join(import.meta.dir, "..", "evals", "results");
const pos: { key: string; gap: number; hit: boolean }[] = [];
for (const f of ["2026-10-08-behavior-new.json"]) {
  const r = JSON.parse(readFileSync(join(results, f), "utf8")) as { cases: { key: string; diff: string }[] };
  const cases = JSON.parse(readFileSync(join(import.meta.dir, "..", "evals", "behavior-new-cases.json"), "utf8")) as { key: string; title: string }[];
  for (const c of r.cases) {
    const title = cases.find((x) => x.key === c.key)?.title ?? "";
    for (const nf of newFiles(c.diff)) {
      const h = (await semanticSearch(`${nf.path}\n${nf.text.slice(0, 1500)}`, { kinds: KINDS, scope: "mendadak-pos", limit: 12, timeoutMs: 30000 })) ?? [];
      pos.push({ key: c.key, gap: gapOf(h), hit: !!best(h)?.title.includes(title.slice(0, 25)) });
    }
  }
}

const writes: { path: string; repo: string; gap: number; top?: string }[] = [];
const files = transcriptFiles(config.projectsDir, Date.now() - days * 86400_000);
outer: for (const t of files.reverse()) {
  for (const c of callsIn(t)) {
    if (!c.path || !c.code || !SOURCE.test(c.path) || c.path.includes("/tmp/")) continue;
    const repo = repoName(c.path.split("/").slice(0, -1).join("/")) ?? "";
    const h = (await semanticSearch(`${c.path}\n${c.code.slice(0, 1500)}`, { kinds: KINDS, scope: repo || undefined, limit: 12, timeoutMs: 30000 })) ?? [];
    writes.push({ path: c.path.replace(/^.*PROJECT_MISPAQUL_ATTORIQ\/|^.*MISPAQUL_ATTORIQ\//, ""), repo, gap: gapOf(h), top: best(h)?.id });
    if (writes.length >= N) break outer;
  }
}

const hits = pos.filter((p) => p.hit);
console.log(`positives: ${pos.length} new files from the eval, target lesson on top in ${hits.length}; their gap p10 ${pct(hits.map((p) => p.gap), 0.1).toFixed(3)} p50 ${pct(hits.map((p) => p.gap), 0.5).toFixed(3)}`);
console.log(`real writes: ${writes.length}; gap p50 ${pct(writes.map((w) => w.gap), 0.5).toFixed(3)} p90 ${pct(writes.map((w) => w.gap), 0.9).toFixed(3)}`);
console.log("\ngap   | positives (target on top) kept | real writes passing");
for (const g of [0.04, 0.05, 0.06, 0.07, 0.08, 0.1]) {
  console.log(`${g.toFixed(3)} | ${String(hits.filter((p) => p.gap >= g).length).padStart(3)}/${hits.length}                         | ${String(writes.filter((w) => w.gap >= g).length).padStart(4)}/${writes.length}`);
}
await Bun.write(join(import.meta.dir, "..", ".write-calibrate.json"), JSON.stringify({ pos, writes: writes.sort((a, b) => b.gap - a.gap) }, null, 1));
