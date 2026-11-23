// Does batas earn its keep? Four evals over real use. Each one is a set of cases with a baseline and a 95% interval, so a
// change to a rule, a trigger or the daemon shows up as a number that moved rather than an impression.
//
//   prevention  a mistake made in a session: after the rule for it was injected, did the session make it again?
//               Baselines: the same mistakes in sessions where the rule had not been injected yet, and mistakes no rule
//               covers. When a rule was injected is replayed from the transcript (the hook injects a rule once, on its
//               first trigger match); the replay is checked against the hook log on the days the log still holds.
//   relevance   a memory a trigger word pulled into a prompt: does the prompt rank the memory in the top 10% of its
//               project's memories (batasd, both models)? Chance is k/N. Two judges — the whole prompt, and the prompt
//               with the trigger words cut out — are scored against hand labels (evals/relevance-labels.json) and the
//               one that agrees with them more is the one the verdicts use.
//   coverage    of the mistakes made in 3+ sessions, how many have a rule whose trigger fires on them.
//   on time     did the prompt's semantic match come back inside the prompt hook's budget.
//
// The relevance judge is itself checked first (scripts/semantic-eval.ts, 80 probes with known answers), and every run is
// saved to ~/.batas/eval/ and compared with the previous one.
//
//   bun scripts/eval.ts [days=30] [prompts=400] [--seed=7] [--no-judge] [--no-save]
//   bun scripts/eval.ts [days=30] --label-sample=40    unlabelled pairs to judge by hand, as JSON for the labels file
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "../src/config.ts";
import { memoryTriggers, projectSlug } from "../src/corpus.ts";
import { memoryPromptText, ownWords, saysTrigger } from "../src/hook.ts";
import { type HookLogRow, readHookLog } from "../src/log.ts";
import { semanticSearch } from "../src/semantic.ts";
import { Store } from "../src/store.ts";
import { Triggers } from "../src/triggers.ts";
import { mine, redact, signature } from "./lesson-mine.ts";
import { callsIn, errorsIn, type ToolError, transcriptFiles } from "./transcripts.ts";

export type Interval = { k: number; n: number; p: number; lo: number; hi: number };

// Wilson score interval: honest at small n and at 0% / 100%, where the normal approximation collapses to a point.
export function wilson(k: number, n: number, z = 1.96): Interval {
  if (!n) return { k, n, p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { k, n, p, lo: Math.max(0, (c - m) / d), hi: Math.min(1, (c + m) / d) };
}

// Newcombe's hybrid score interval for a difference of two proportions (a - b), built from the two Wilson intervals.
export function difference(a: Interval, b: Interval): { d: number; lo: number; hi: number } {
  const d = a.p - b.p;
  return { d, lo: d - Math.hypot(a.p - a.lo, b.hi - b.p), hi: d + Math.hypot(a.hi - a.p, b.p - b.lo) };
}

export type Verdict = "fewer" | "more" | "no difference" | "too few";

// Fewer or more repeats than the baseline only when the whole 95% interval of the difference sits on one side of zero.
export function compare(a: Interval, b: Interval, minN = 5): Verdict {
  if (a.n < minN || b.n < minN) return "too few";
  const { lo, hi } = difference(a, b);
  return hi < 0 ? "fewer" : lo > 0 ? "more" : "no difference";
}

// P(X >= k) for X ~ Binomial(n, p), summed in log space so n in the thousands does not underflow.
export function binomTail(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  const lgamma = (x: number): number => {
    const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x;
    const t = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
    let s = 1.000000000190015;
    for (const c of g) s += c / ++y;
    return -t + Math.log((2.5066282746310005 * s) / x);
  };
  const lc = (i: number) => lgamma(n + 1) - lgamma(i + 1) - lgamma(n - i + 1);
  let tail = 0;
  for (let i = k; i <= n; i++) tail += Math.exp(lc(i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  return Math.min(1, tail);
}

export const sessionOf = (transcript: string) => basename(transcript).replace(/\.jsonl$/, "");

export type Group = "reminded" | "unreminded" | "uncovered";
export type PreventionCase = { session: string; signature: string; group: Group; rules: string[]; repeated: boolean; cmd?: string; ts: number };

// One case per (session, mistake). It repeated when the same signature failed again on a call issued after the first
// failure came back — a parallel call sent in the same message is the same attempt. It was reminded when one of the
// rules that cover the signature had been injected in that session by the time the first failure came back.
export function preventionCases(errors: ToolError[], coveredBy: Map<string, string[]>, injected: Map<string, Map<string, number>>): PreventionCase[] {
  const groups = new Map<string, ToolError[]>();
  for (const e of errors) {
    const sig = signature(e.error);
    if (!sig) continue;
    const key = `${sessionOf(e.session)}\u0000${sig}`;
    const g = groups.get(key) ?? [];
    g.push(e);
    groups.set(key, g);
  }
  const out: PreventionCase[] = [];
  for (const [key, g] of groups) {
    const [session = "", sig = ""] = key.split("\u0000");
    g.sort((a, b) => a.ts - b.ts);
    const first = g[0] as ToolError;
    const repeated = g.some((e) => e.usedAt > first.ts);
    const rules = coveredBy.get(sig) ?? [];
    const at = injected.get(session);
    const reminded = rules.filter((r) => (at?.get(r) ?? Number.POSITIVE_INFINITY) <= first.ts);
    const group: Group = !rules.length ? "uncovered" : reminded.length ? "reminded" : "unreminded";
    out.push({ session, signature: sig, group, rules: reminded.length ? reminded : rules, repeated, cmd: first.cmd, ts: first.ts });
  }
  return out;
}

// First injection of each id per session, from the hook log: the hook injects an id once per session, so this is the
// moment the agent was told.
export function injections(rows: HookLogRow[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.session || !r.fired?.length) continue;
    const t = Date.parse(r.ts);
    const m = out.get(r.session) ?? new Map<string, number>();
    for (const id of r.fired) if (!m.has(id) || (m.get(id) as number) > t) m.set(id, t);
    out.set(r.session, m);
  }
  return out;
}

// The same moment replayed from a transcript: the first call each rule's trigger matches. Memories and hints are left
// out — they are matched on the prompt, not on a call. Only the main agent's transcript counts, which is also what it saw.
export function replayInjections(files: string[], triggers: Triggers): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const f of files) {
    const m = new Map<string, number>();
    for (const c of callsIn(f)) for (const hit of triggers.match(c)) if (!/^(memory|hint):/.test(hit.id) && !m.has(hit.id)) m.set(hit.id, c.ts);
    out.set(sessionOf(f), m);
  }
  return out;
}

// Balanced accuracy of a yes/no judge against labels: the mean of its hit rate on relevant and on irrelevant cases, so
// a judge that says "no" to everything scores 50%, not the share of irrelevant labels.
export function balancedAccuracy(rows: { label: boolean; said: boolean }[]): { acc: number; tpr: number; tnr: number; n: number } {
  const pos = rows.filter((r) => r.label);
  const neg = rows.filter((r) => !r.label);
  const tpr = pos.length ? pos.filter((r) => r.said).length / pos.length : 0;
  const tnr = neg.length ? neg.filter((r) => !r.said).length / neg.length : 0;
  return { acc: (tpr + tnr) / 2, tpr, tnr, n: rows.length };
}

export type Label = { prompt: string; memory: string; relevant: boolean; by: string; note?: string };

export type RelevanceCase = { memory: string; trigger: string; prompt: string; total: number; k: number; whole: boolean; cut: boolean };

// The top 10% of a project's memories, at least one: what "ranked as relevant" means, and k/N is the chance a random
// memory gets there.
export const topK = (total: number) => Math.max(1, Math.ceil(total * 0.1));

// The prompt with the trigger words cut out, so the judge rewards meaning rather than the word that already fired;
// undefined when too little is left to judge (fewer than 3 words with a letter in them).
export function withoutTriggers(prompt: string, words: string[]): string | undefined {
  let rest = ownWords(prompt);
  for (const w of words) {
    for (const part of w.split(/\s+/).filter(Boolean)) {
      const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rest = rest.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, "giu"), "$1 ");
    }
  }
  const left = rest.split(/\s+/).filter((t) => /\p{L}/u.test(t));
  return left.length >= 3 ? left.join(" ") : undefined;
}

// A trigger is judged only once it has fired often enough that a perfect one could have beaten chance (chance^n < 0.05);
// then it beats chance when its hits are unlikely under chance alone (one-sided binomial p < 0.05).
export function triggerVerdict(hits: number, n: number, chance: number): "beats chance" | "no better than chance" | "too few" {
  if (n < Math.ceil(Math.log(0.05) / Math.log(Math.max(chance, 1e-9)))) return "too few";
  return binomTail(hits, n, chance) < 0.05 ? "beats chance" : "no better than chance";
}

function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

type HistoryPrompt = { text: string; project: string; at: number };

function historyPrompts(sinceMs: number): HistoryPrompt[] {
  const file = join(config.claudeHome, "history.jsonl");
  if (!existsSync(file)) return [];
  const out: HistoryPrompt[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as { display?: string; project?: string; timestamp?: string | number };
      const text = String(r.display ?? "").trim();
      const at = Number(r.timestamp ?? 0);
      if (text.length >= 4 && !text.startsWith("/") && r.project && at >= sinceMs) out.push({ text, project: r.project, at });
    } catch {}
  }
  return out;
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const span = (i: Interval) => `${pct(i.p)} [${pct(i.lo)}-${pct(i.hi)}] (${i.k}/${i.n})`;
const clip = (s: string | undefined, n: number) => redact(s ?? "").replace(/\s+/g, " ").slice(0, n);

// The two judges for one prompt: the whole prompt, and the prompt with the trigger words cut out. A memory "ranks" when
// it is in the top k of its project's memories; undefined when batasd did not answer.
async function judgeBoth(text: string, words: string[], slug: string): Promise<{ whole: string[]; cut?: string[] } | undefined> {
  const whole = await semanticSearch(ownWords(text).slice(0, 4000), { prefix: `memory:${slug}/`, limit: 50, timeoutMs: 20000 });
  if (!whole) return undefined;
  const q = withoutTriggers(text, words);
  const cut = q ? await semanticSearch(q, { prefix: `memory:${slug}/`, limit: 50, timeoutMs: 20000 }) : undefined;
  return { whole: whole.map((h) => h.id), cut: cut?.map((h) => h.id) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith("--"));
  const days = Number(positional[0] ?? 30);
  const maxPrompts = Number(positional[1] ?? 400);
  const seed = Number(args.find((a) => a.startsWith("--seed="))?.slice(7) ?? 7);
  const labelSample = Number(args.find((a) => a.startsWith("--label-sample="))?.slice(15) ?? 0);
  const labelsFile = join(import.meta.dir, "..", "evals", "relevance-labels.json");
  const since = Date.now() - days * 24 * 3600 * 1000;
  const say = (s = "") => console.log(s);

  const store = new Store();
  store.refresh("all");
  const labels: Label[] = existsSync(labelsFile) ? (JSON.parse(readFileSync(labelsFile, "utf8")) as Label[]) : [];
  const labelled = new Set(labels.map((l) => `${l.prompt}\u0000${l.memory}`));

  // Every (prompt, memory) pair a memory trigger word produced in the window, own project only (the full injections).
  type Pair = { prompt: HistoryPrompt; slug: string; memory: string; trigger: string };
  const byPrompt: { prompt: HistoryPrompt; slug: string; pairs: Pair[]; words: string[] }[] = [];
  for (const p of historyPrompts(since)) {
    const slug = projectSlug(p.project);
    const lower = memoryPromptText(p.text);
    const pairs: Pair[] = [];
    const words: string[] = [];
    for (const m of store.memories(slug)) {
      const hit = memoryTriggers(m.title).filter((t) => saysTrigger(lower, t));
      if (!hit.length) continue;
      words.push(...hit);
      for (const t of hit) pairs.push({ prompt: p, slug, memory: m.id, trigger: t });
    }
    if (pairs.length) byPrompt.push({ prompt: p, slug, pairs, words });
  }
  const rand = seeded(seed);
  const shuffled = byPrompt
    .map((x) => ({ x, r: rand() }))
    .sort((a, b) => a.r - b.r)
    .map((y) => y.x);

  if (labelSample) {
    // One pair per prompt, never one already labelled, with what a person needs to decide: the prompt and the memory.
    const out: (Label & { trigger: string; memoryTitle: string; memoryText: string })[] = [];
    for (const s of shuffled) {
      const pr = s.pairs.find((x) => !labelled.has(`${x.prompt.text}\u0000${x.memory}`));
      if (!pr) continue;
      const e = store.get(pr.memory);
      out.push({ prompt: pr.prompt.text.slice(0, 600), memory: pr.memory, trigger: pr.trigger, memoryTitle: (e?.title ?? "").split(" · triggers:")[0] ?? "", memoryText: (e?.body ?? "").replace(/\s+/g, " ").slice(0, 500), relevant: false, by: "" });
      if (out.length >= labelSample) break;
    }
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // 0. The judges. The semantic ranking itself on 80 known-answer probes, then both relevance judges on the hand labels.
  let probes: { en: number; id: number } | undefined;
  if (!args.includes("--no-judge")) {
    const r = Bun.spawnSync(["bun", join(import.meta.dir, "semantic-eval.ts")], { stdout: "pipe", stderr: "pipe" });
    const text = r.stdout.toString();
    const en = Number(text.match(/^EN top1 \d+\/40 top3 (\d+)\/40/m)?.[1]);
    const id = Number(text.match(/^ID top1 \d+\/40 top3 (\d+)\/40/m)?.[1]);
    if (Number.isFinite(en) && Number.isFinite(id)) probes = { en, id };
  }
  const judged: { label: boolean; whole: boolean; cut?: boolean }[] = [];
  for (const l of labels) {
    const slug = l.memory.slice("memory:".length).split("/")[0] ?? "";
    const e = store.get(l.memory);
    if (!e || e.id !== l.memory) continue;
    const words = memoryTriggers(e.title).filter((t) => saysTrigger(memoryPromptText(l.prompt), t));
    const r = await judgeBoth(l.prompt, words, slug);
    if (!r) break;
    const k = topK(store.memories(slug).length);
    judged.push({ label: l.relevant, whole: r.whole.slice(0, k).includes(l.memory), cut: r.cut ? r.cut.slice(0, k).includes(l.memory) : undefined });
  }
  const wholeAcc = balancedAccuracy(judged.map((j) => ({ label: j.label, said: j.whole })));
  const cutRows = judged.filter((j) => j.cut !== undefined);
  const cutAcc = balancedAccuracy(cutRows.map((j) => ({ label: j.label, said: j.cut as boolean })));
  const useCut = cutAcc.n > 0 && cutAcc.acc > wholeAcc.acc;
  const judgeName = useCut ? "prompt without the trigger words" : "whole prompt";
  // The triggers themselves against the same labels: a trigger edit should stop firing on irrelevant pairs without
  // losing relevant ones.
  const fires = (l: Label) => {
    const e = store.get(l.memory);
    return !!e && e.id === l.memory && memoryTriggers(e.title).some((t) => saysTrigger(memoryPromptText(l.prompt), t));
  };
  const onRelevant = wilson(labels.filter((l) => l.relevant && fires(l)).length, labels.filter((l) => l.relevant).length);
  const onIrrelevant = wilson(labels.filter((l) => !l.relevant && fires(l)).length, labels.filter((l) => !l.relevant).length);

  // 1. Prevention. Recurring mistakes and which rules cover them, from every session in the window.
  const triggers = Triggers.load();
  const files = transcriptFiles(config.projectsDir, since).filter((f) => !f.includes("/subagents/"));
  const allErrors = files.flatMap(errorsIn);
  const candidates = mine(allErrors, triggers, 3);
  const coveredBy = new Map(candidates.filter((c) => c.coveredBy.length).map((c) => [c.signature, c.coveredBy]));
  const recurring = new Set(candidates.map((c) => c.signature));
  const replayed = replayInjections(files, triggers);
  const cases = preventionCases(allErrors, coveredBy, replayed).filter((c) => recurring.has(c.signature));
  const rate = (xs: PreventionCase[], g: Group) => {
    const ys = xs.filter((c) => c.group === g);
    return wilson(ys.filter((c) => c.repeated).length, ys.length);
  };
  const reminded = rate(cases, "reminded");
  const unreminded = rate(cases, "unreminded");
  const uncovered = rate(cases, "uncovered");
  // The replay against the hook log, on sessions the log saw from their first minute.
  const rows = readHookLog(since);
  const logStart = rows.length ? Math.min(...rows.map((r) => Date.parse(r.ts))) : Date.now();
  const logged = new Set(rows.map((r) => r.session).filter(Boolean) as string[]);
  const seen = new Set(files.filter((f) => logged.has(sessionOf(f)) && statSync(f).birthtimeMs >= logStart));
  const seenErrors = allErrors.filter((e) => seen.has(e.session));
  const liveCases = preventionCases(seenErrors, coveredBy, injections(rows)).filter((c) => recurring.has(c.signature));
  const replayCases = preventionCases(seenErrors, coveredBy, replayed).filter((c) => recurring.has(c.signature));
  const liveGroup = new Map(liveCases.map((c) => [`${c.session}\u0000${c.signature}`, c.group]));
  const agree = wilson(replayCases.filter((c) => liveGroup.get(`${c.session}\u0000${c.signature}`) === c.group).length, replayCases.length);

  // 2. Relevance of trigger-word memory injections, on a sample of prompts.
  const pairsTotal = byPrompt.reduce((a, s) => a + s.pairs.length, 0);
  const sample = shuffled.slice(0, maxPrompts);
  const rel: RelevanceCase[] = [];
  let daemonDown = false;
  for (const s of sample) {
    const r = await judgeBoth(s.prompt.text, s.words, s.slug);
    if (!r) {
      daemonDown = true;
      break;
    }
    const total = store.memories(s.slug).length;
    const k = topK(total);
    for (const pr of s.pairs) {
      const whole = r.whole.slice(0, k).includes(pr.memory);
      // Too little left once the words are out: the judge cannot say more than the word did, so it falls back to whole.
      const cut = r.cut ? r.cut.slice(0, k).includes(pr.memory) : whole;
      rel.push({ memory: pr.memory, trigger: pr.trigger, prompt: s.prompt.text, total, k, whole, cut });
    }
  }
  const said = (r: RelevanceCase) => (useCut ? r.cut : r.whole);
  const relHit = wilson(rel.filter(said).length, rel.length);
  const chance = rel.length ? rel.reduce((a, r) => a + r.k / r.total, 0) / rel.length : 0;
  const perTrigger = new Map<string, RelevanceCase[]>();
  for (const r of rel) {
    const key = `${r.memory}\u0000${r.trigger}`;
    perTrigger.set(key, [...(perTrigger.get(key) ?? []), r]);
  }
  const triggerRows = [...perTrigger].map(([key, xs]) => {
    const [memory = "", trigger = ""] = key.split("\u0000");
    const ch = xs.reduce((a, r) => a + r.k / r.total, 0) / xs.length;
    const hits = xs.filter(said).length;
    return { memory, trigger, n: xs.length, hits, chance: ch, verdict: triggerVerdict(hits, xs.length, ch), example: xs.find((r) => !said(r))?.prompt };
  });
  const noise = triggerRows.filter((t) => t.verdict === "no better than chance").sort((a, b) => b.n - a.n);
  const beats = triggerRows.filter((t) => t.verdict === "beats chance");

  // 3. Coverage of recurring mistakes, every session in the window.
  const coverage = wilson(cases.filter((c) => c.group !== "uncovered").length, cases.length);

  // 4. On time.
  const sem = rows.filter((r) => (r as { semantic?: string }).semantic);
  const warm = wilson(sem.filter((r) => (r as { semantic?: string }).semantic === "warm").length, sem.length);
  const within = (event: string, budget: number) => {
    const xs = rows.filter((r) => r.event === event);
    return wilson(xs.filter((r) => r.ms <= budget).length, xs.length);
  };
  const toolOnTime = within("PreToolUse", config.latencyBudgetMs.tool);
  const promptOnTime = within("UserPromptSubmit", config.latencyBudgetMs.prompt);

  const headline = {
    at: new Date().toISOString(),
    days,
    probes,
    judge: { name: judgeName, whole: wholeAcc, cut: cutAcc, labels: judged.length },
    prevention: { reminded, unreminded, uncovered, replayAgreesWithLog: agree },
    relevance: { hit: relHit, chance, noisy: noise.length, judged: noise.length + beats.length, injections30d: pairsTotal, onRelevant, onIrrelevant },
    coverage,
    onTime: { semantic: warm, tool: toolOnTime, prompt: promptOnTime },
  };
  const dir = join(config.stateDir, "eval");
  const previous = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .pop()
    : undefined;
  const before = previous ? (JSON.parse(readFileSync(join(dir, previous), "utf8")) as Partial<typeof headline>) : undefined;
  const delta = (now: number, then: number | undefined) =>
    then === undefined ? "" : `   ${now - then >= 0 ? "+" : ""}${((now - then) * 100).toFixed(1)} pt since ${before?.at?.slice(0, 16)}`;
  const pt = (x: { d: number; lo: number; hi: number }) => `${(x.d * 100).toFixed(1)} pt [${(x.lo * 100).toFixed(1)} to ${(x.hi * 100).toFixed(1)}]`;

  say(`batas eval — last ${days} days: ${files.length} sessions, ${byPrompt.length} prompts that pulled a memory by trigger word`);
  say("");
  say("0. JUDGES — can the numbers below be trusted?");
  say(probes ? `   semantic ranking, 80 known-answer probes: EN ${probes.en}/40, ID ${probes.id}/40 in top 3` : "   semantic ranking: skipped (--no-judge, or batasd not answering)");
  say(`   relevance judge vs ${judged.length} hand labels (balanced accuracy): whole prompt ${pct(wholeAcc.acc)}, without trigger words ${pct(cutAcc.acc)} -> using "${judgeName}"`);
  say(`   prevention replay vs the hook log (${seen.size} sessions it saw whole): ${span(agree)} of cases put in the same group`);
  say("");
  say("1. PREVENTION — after the rule for a mistake was injected, how often did the session make that mistake again?");
  say(`   reminded       ${span(reminded)}${delta(reminded.p, before?.prevention?.reminded.p)}`);
  say(`   not reminded   ${span(unreminded)}   same mistakes, rule not injected (yet)`);
  say(`   no rule        ${span(uncovered)}   mistakes no rule covers`);
  say(`   reminded vs not reminded: ${pt(difference(reminded, unreminded))} -> ${compare(reminded, unreminded)}`);
  say(`   reminded vs no rule:      ${pt(difference(reminded, uncovered))} -> ${compare(reminded, uncovered)}`);
  const perRule = new Map<string, PreventionCase[]>();
  for (const c of cases.filter((x) => x.group === "reminded")) for (const r of c.rules) perRule.set(r, [...(perRule.get(r) ?? []), c]);
  const ruleRows = [...perRule]
    .map(([id, xs]) => ({ id, i: wilson(xs.filter((c) => c.repeated).length, xs.length), xs }))
    .filter((r) => r.i.n >= 5)
    .sort((a, b) => b.i.n - a.i.n);
  if (ruleRows.length) say("   per rule (>= 5 reminded cases): repeat rate, and vs mistakes with no rule");
  for (const r of ruleRows.slice(0, 15)) {
    const ex = r.xs.find((c) => c.repeated) ?? r.xs[0];
    say(`     ${r.id.padEnd(12)} ${span(r.i).padEnd(30)} ${compare(r.i, uncovered).padEnd(14)} e.g. ${ex?.session.slice(0, 8)} ${clip(ex?.cmd, 60)}`);
  }
  say("");
  say(`2. RELEVANCE — a memory a trigger word pulled in: does the prompt rank it in its project's top 10%? (judge: ${judgeName})`);
  if (daemonDown) say("   batasd stopped answering part-way; the numbers cover the cases judged before that");
  say(`   relevant       ${span(relHit)}${delta(relHit.p, before?.relevance?.hit.p)}`);
  say(`   chance         ${pct(chance)}   -> ${chance ? (relHit.p / chance).toFixed(1) : "-"}x chance   (${rel.length} injections from ${sample.length} of ${byPrompt.length} prompts; ${pairsTotal} injections in ${days} days)`);
  say(`   on the hand labels, a trigger still fires on ${onRelevant.k}/${onRelevant.n} relevant pairs and ${onIrrelevant.k}/${onIrrelevant.n} irrelevant ones${before?.relevance?.onIrrelevant ? `   (was ${before.relevance.onRelevant?.k}/${before.relevance.onRelevant?.n} and ${before.relevance.onIrrelevant.k}/${before.relevance.onIrrelevant.n})` : ""}`);
  say(`   triggers with enough fires to judge: ${beats.length + noise.length}; beat chance ${beats.length}; no better than chance ${noise.length}${before?.relevance ? `   (was ${before.relevance.noisy})` : ""}`);
  for (const t of noise.slice(0, 15)) say(`     '${t.trigger}' -> ${t.memory.split("/").pop()}  ${t.hits}/${t.n} vs chance ${pct(t.chance)}  e.g. "${clip(t.example, 55)}"`);
  say("");
  say("3. COVERAGE — mistakes made in 3+ sessions: share of (session, mistake) cases a rule covers");
  say(`   ${span(coverage)}${delta(coverage.p, before?.coverage?.p)}`);
  for (const c of candidates.filter((x) => !x.coveredBy.length).slice(0, 8)) say(`     uncovered [${c.sessions} sessions] ${c.signature.slice(0, 90)}`);
  say("");
  say("4. ON TIME");
  say(`   prompt semantic match inside the ${config.latencyBudgetMs.prompt} ms budget: ${span(warm)}${delta(warm.p, before?.onTime?.semantic.p)}   (the rest arrive on the next tool call)`);
  say(`   tool hook within ${config.latencyBudgetMs.tool} ms: ${span(toolOnTime)}; prompt hook within ${config.latencyBudgetMs.prompt} ms: ${span(promptOnTime)}`);

  if (!args.includes("--no-save")) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${headline.at.replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ ...headline, triggers: triggerRows, rules: ruleRows.map((r) => ({ id: r.id, ...r.i })) }, null, 2));
    say("");
    say(`saved ${file}`);
  }
}
