// Does an injection change behaviour? For each rule trigger, among sessions where it matched at least once, how often
// did it match AGAIN later in the same session — before batas existed versus after. For a mistake-shaped trigger
// (`| head && echo`, `lsof -ti`) a repeat is the mistake repeated, so a working injection lowers the rate; for a
// situational one (`git push`) repeats are normal and the rate should not move, which is the control. The rules text
// also changed over the period, so read a drop as "the rule plus its delivery", not injection alone.
import { config } from "../src/config.ts";
import { Triggers } from "../src/triggers.ts";
import { callsIn, transcriptFiles } from "./transcripts.ts";

const days = Number(process.argv[2] ?? 21);
const minSessions = Number(process.argv[3] ?? 8);
const launch = Date.parse(process.argv[4] ?? "2026-09-30T08:16:00Z");
const DAY = 24 * 3600 * 1000;

const triggers = Triggers.load();
const ids = triggers.ids().filter((id) => {
  const s = triggers.specs[id];
  return !/^(hint|memory):/.test(id) && !!s && !!(s.cmd?.length || s.path?.length || s.code?.length);
});

function tally(files: string[]) {
  const matched = new Map<string, number>();
  const repeated = new Map<string, number>();
  for (const file of files) {
    const counts = new Map<string, number>();
    for (const c of callsIn(file)) {
      for (const m of triggers.match(c)) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
    }
    for (const [id, n] of counts) {
      matched.set(id, (matched.get(id) ?? 0) + 1);
      if (n >= 2) repeated.set(id, (repeated.get(id) ?? 0) + 1);
    }
  }
  return { matched, repeated, sessions: files.length };
}

const all = transcriptFiles(config.projectsDir, launch - days * DAY);
const before = tally(all.filter((f) => Bun.file(f).lastModified < launch));
const after = tally(all.filter((f) => Bun.file(f).lastModified >= launch && Bun.file(f).lastModified < launch + days * DAY + 365 * DAY));

const rows = ids
  .map((id) => {
    const b = before.matched.get(id) ?? 0;
    const a = after.matched.get(id) ?? 0;
    const rb = b ? (before.repeated.get(id) ?? 0) / b : 0;
    const ra = a ? (after.repeated.get(id) ?? 0) / a : 0;
    return { id, b, a, rb, ra, delta: ra - rb };
  })
  .filter((r) => r.b >= minSessions && r.a >= minSessions)
  .sort((x, y) => x.delta - y.delta);

const pct = (x: number) => `${(x * 100).toFixed(0)}%`.padStart(4);
console.log(`sessions: ${before.sessions} before batas (${days}d), ${after.sessions} after; rules with >= ${minSessions} matched sessions on both sides: ${rows.length}`);
console.log("repeat rate = share of sessions where the trigger matched again after its first match\n");
console.log("  id              before  after   change   (sessions before / after)");
for (const r of rows) {
  console.log(`  ${r.id.padEnd(14)}  ${pct(r.rb)}   ${pct(r.ra)}   ${(r.delta >= 0 ? "+" : "") + (r.delta * 100).toFixed(0).padStart(3)} pt   (${r.b} / ${r.a})`);
}
