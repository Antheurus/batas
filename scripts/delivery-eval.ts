// The one measurement that says whether batas works: when an agent opens a file, does the lesson about that file
// reach it? Each case is a fresh `claude -p` that may only Read the file and must then quote, from its own context, the
// headings of lessons about that file. Recall, MCP and search are off, so only automatic delivery can pass. Control
// files with no lesson must answer NONE, which catches a session that invents an answer.
//
//   bun scripts/delivery-eval.ts <repo> [cases=15] [controls=5] [seed=11]
// Costs one Claude session per case (~20 s each, 3 at a time); it is not part of `just check`.
//
// The same measurement for the global rules that moved out of the always-on files (coding-standard, definition of done,
// the Phase 2 gotcha moves): `--rules [cases=4] [controls=2] [seed=11]` Reads a harmless file at a trigger's path fixture
// inside a throwaway directory and fails when delivery drops against the last saved `.delivery-eval-rules.json`.
// `--precheck [cases] [controls] [seed]` runs only the real hook on the same fixtures (no session) and prints what it injected.
// `--compare <previous.json> <current.json>` runs only that comparison.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "../src/config.ts";
import { headline } from "../src/corpus.ts";
import { routeLessons } from "./lessons-route.ts";

// How the agent opens the file. The rule files only load through the Read/Edit/Write tools, and agents here open files
// with cat/sed and python as often, so each way is its own measurement.
const OPEN = {
  read: (f: string) => `Read ${f} with the Read tool.`,
  // cat, not sed -n: Claude Code loads path rules itself after `sed -n`, so sed could not show whether batas helps.
  bash: (f: string) => `Show ${f} by running exactly this Bash command: cat ${f}`,
  python: (f: string) => `Show ${f} by running exactly this Bash command: python3 -c "print(open('${f}').read())"`,
} as const;
type Mode = keyof typeof OPEN;

const PROMPT = (file: string, mode: Mode) =>
  `${OPEN[mode](file)} Do not read, search or open any other file and do not call any other tool. Then look ONLY at what is ` +
  "already in your context (instructions, rules, system reminders, hook-injected text) and list, verbatim, the heading of " +
  "every lesson or rule that is specifically about code in that file (not general coding rules). One per line. If there " +
  "is none, reply exactly NONE.";

// The rules mode scores delivery: which hook-injected blocks reached the session. It must not ask which rules are
// "specifically about" the file, because the model then drops general rules (cs:20) that were in fact delivered.
// Bump RULES_PROMPT_VERSION whenever this wording changes: a saved result from another version is a new baseline.
export const RULES_PROMPT_VERSION = 2;
const RULES_PROMPT = (file: string) =>
  `Read ${file} with the Read tool. Do not read, search or open any other file and do not call any other tool. Then look ` +
  "ONLY at what is already in your context and list, verbatim, the `### <id>` heading line of every block that a hook " +
  "injected (the blocks that start with `batas:`). One per line. If there is none, reply exactly NONE.";

type Case = { file: string; title?: string };
let allTitles: string[] = [];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// Share of the expected heading's words that appear on one answer line; 0.6 tolerates the agent trimming backticks.
function delivered(answer: string, title: string): boolean {
  const want = new Set(norm(title).split(" ").slice(0, 12));
  return answer.split("\n").some((line) => {
    const got = new Set(norm(line).split(" "));
    return [...want].filter((w) => got.has(w)).length / Math.max(want.size, 1) >= 0.6;
  });
}

async function runCase(repo: string, c: Case, mode: Mode, prompt?: string): Promise<{ c: Case; ok: boolean; answer: string }> {
  const tools = mode === "read" ? "Read" : "Bash";
  const p = Bun.spawn(["claude", "-p", prompt ?? PROMPT(c.file, mode), "--allowedTools", tools], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env });
  const answer = (await new Response(p.stdout).text()).trim();
  await p.exited;
  // A control fails only by quoting a lesson heading: naming a real path-scoped project rule for that file is correct.
  const ok = c.title ? delivered(answer, c.title) : !allTitles.some((t) => delivered(answer, t));
  return { c, ok, answer };
}

// Rule families converted in Phase 3, plus the gotcha items Phase 2 moved inject-only. Path triggers only: a cmd fixture
// can be a destructive command, and the session would run it.
const MOVED = /^(?:(?:cs|dod|ver|ui|bduf|gnx|bf|prim|pc|cm|py):\d+|gotcha:(?:A1|A2|A7|A10|E37))$/;
const CONTROL_PATHS = ["notes/meeting-minutes.txt", "assets/team-photo-caption.txt", "docs/lunch-order.txt", "drafts/holiday-plan.txt"];

// injected = the real hook put the rule in the session's context (deterministic); ok = the session quoted it.
export type RuleResult = { id: string; kind: "case" | "control"; file: string; ok: boolean; answer: string; injected?: boolean };
export type RulesRun = { date: string; seed: number; key: string; promptVersion?: number; results: RuleResult[] };

export function compareRules(prev: RulesRun, cur: RulesRun): { drops: string[]; note?: string } {
  if (prev.promptVersion !== cur.promptVersion) return { drops: [], note: "prompt version differs from the saved result: this run is a new baseline" };
  if (prev.key !== cur.key) return { drops: [], note: "case set differs from the saved result: this run is a new baseline" };
  const drops: string[] = [];
  for (const r of cur.results) {
    const before = prev.results.find((p) => p.id === r.id && p.kind === r.kind);
    if (r.kind === "control" && !r.ok) drops.push(`control ${r.file} quoted a rule`);
    else if (r.kind === "case" && !r.ok && before?.ok) drops.push(`case ${r.id} (${r.file}) was delivered before and is not now`);
  }
  const passes = (x: RulesRun) => x.results.filter((r) => r.kind === "case" && r.ok).length;
  if (passes(cur) < passes(prev) && !drops.some((d) => d.startsWith("case"))) drops.push(`passes fell from ${passes(prev)} to ${passes(cur)}`);
  return { drops };
}

// The injected block is "### <id> — fired by path ...\n<rule text>". A table body has no headline a session could quote;
// otherwise the headline is the rule's bold head, as corpus.ts derives it for every other rule.
export function injectedHeadline(body: string): string {
  const lines = body.split("\n").filter((l) => !l.trimStart().startsWith("|"));
  const text = lines.join("\n");
  if (/\*\*(.+?)\*\*/.test(text)) return headline(text);
  return body.trimStart().startsWith("|") ? "" : (lines[0] ?? "").split(" ").slice(0, 12).join(" ");
}

function injected(path: string): Map<string, string> {
  const event = { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: path }, cwd: dirname(path), session_id: `delivery-${crypto.randomUUID()}` };
  const out = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "hook.ts")], { stdin: new TextEncoder().encode(JSON.stringify(event)) }).stdout.toString();
  const text: string = out ? (JSON.parse(out).hookSpecificOutput?.additionalContext ?? "") : "";
  const found = new Map<string, string>();
  for (const m of text.matchAll(/### (\S+) — fired by path[^\n]*\n([\s\S]*?)(?=\n### |\s*$)/g)) found.set(m[1] as string, injectedHeadline(m[2] ?? ""));
  return found;
}

export type Attribution = "delivered" | "model" | "delivery";

// A miss is the model's when the hook injected the rule and the session did not quote it, and delivery's when it never arrived.
export const attribute = (wasInjected: boolean, quoted: boolean): Attribution => (quoted ? "delivered" : wasInjected ? "model" : "delivery");

function ruleCandidates(): { id: string; rel: string }[] {
  const specs = Bun.TOML.parse(readFileSync(config.triggersFile, "utf8")) as Record<string, { path?: string[]; t_path?: string[] }>;
  return Object.entries(specs)
    .filter(([id, e]) => MOVED.test(id) && e.path?.length && e.t_path?.length)
    .map(([id, e]) => ({ id, rel: (e.t_path as string[])[0]!.replace(/^\/Users\/[^/]+\//, "") }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The id is the evidence; the headline only covers a session that quoted the rule text without its id.
export const answers = (answer: string, id: string, head: string) =>
  new RegExp(`(?<![\\w:])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`, "i").test(answer) || (head !== "" && delivered(answer, head));

// The deterministic half: build the fixtures, run the real hook on each, no session. Controls must fire no trigger at all.
export function planRules(root: string, n: number, m: number, seed: number) {
  const rand = rng(seed);
  const pick = <T>(xs: T[], k: number) => [...xs].sort(() => rand() - 0.5).slice(0, k);
  const make = (rel: string) => {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, rel.endsWith(".json") ? "{}\n" : "placeholder\n");
    return file;
  };
  const everything = new Map<string, string>();
  const resolved = ruleCandidates().map((c) => {
    const file = make(c.rel);
    const fired = injected(file);
    for (const [id, head] of fired) everything.set(id, head);
    return { id: c.id, file, rel: c.rel, fired, headline: fired.get(c.id) };
  });
  const cases = pick(resolved, n).sort((a, b) => a.id.localeCompare(b.id));
  const controls = pick(CONTROL_PATHS, m).sort().map((rel) => {
    const file = make(rel);
    return { rel, file, fired: injected(file) };
  });
  for (const c of controls) if (c.fired.size) throw new Error(`control ${c.rel} fires a trigger (${[...c.fired.keys()].join(", ")}); pick another path`);
  return { cases, controls, everything };
}

async function runRules(n: number, m: number, seed: number): Promise<RulesRun> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "batas-rules-eval-")));
  try {
    const { cases, controls, everything } = planRules(root, n, m, seed);
    const results: RuleResult[] = new Array(cases.length + controls.length);
    const ask = (file: string) => runCase(root, { file }, "read", RULES_PROMPT(file));
    const jobs = [
      ...cases.map((c, i) => async () => {
        if (c.headline === undefined) return void (results[i] = { id: c.id, kind: "case", file: c.rel, ok: false, injected: false, answer: "(the hook did not fire for this fixture, no session spent)" });
        const { answer } = await ask(c.file);
        results[i] = { id: c.id, kind: "case", file: c.rel, ok: answers(answer, c.id, c.headline), injected: true, answer };
      }),
      ...controls.map((c, j) => async () => {
        const { answer } = await ask(c.file);
        const quoted = [...everything].some(([id, head]) => answers(answer, id, head));
        results[cases.length + j] = { id: "control", kind: "control", file: c.rel, ok: !quoted, injected: false, answer };
      }),
    ];
    let cursor = 0;
    const worker = async () => {
      for (let i = cursor++; i < jobs.length; i = cursor++) await jobs[i]!();
    };
    await Promise.all([worker(), worker(), worker()]);
    return { date: new Date().toISOString().slice(0, 10), seed, key: [...cases.map((c) => c.id), ...controls.map((c) => c.rel)].join(","), promptVersion: RULES_PROMPT_VERSION, results };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function precheckTable(n: number, m: number, seed: number): string[] {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "batas-rules-precheck-")));
  try {
    const { cases, controls } = planRules(root, n, m, seed);
    return [
      ...cases.map((c) => `case    ${c.id.padEnd(10)} ${c.rel.padEnd(34)} injected=${c.headline === undefined ? "no " : "yes"} fired=[${[...c.fired.keys()].join(", ")}]`),
      ...controls.map((c) => `control ${"-".padEnd(10)} ${c.rel.padEnd(34)} injected=no  fired=[${[...c.fired.keys()].join(", ")}]`),
    ];
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(prev: RulesRun | undefined, cur: RulesRun): number {
  console.log("     kind    id           file                               injected quoted  answer");
  for (const r of cur.results) {
    const inj = r.injected === undefined ? "?" : r.injected ? "yes" : "no";
    const verdict = r.kind === "case" && r.injected !== undefined ? attribute(r.injected, r.ok) : "";
    console.log(`${r.ok ? "OK " : "NO "} ${r.kind.padEnd(7)} ${r.id.padEnd(12)} ${r.file.padEnd(34)} ${inj.padEnd(8)} ${(r.kind === "case" ? (r.ok ? "yes" : "no") : r.ok ? "none" : "yes").padEnd(6)} ${verdict.padEnd(9)} ${r.answer.replace(/\s+/g, " ").slice(0, 80)}`);
  }
  const cases = cur.results.filter((r) => r.kind === "case");
  const controls = cur.results.filter((r) => r.kind === "control");
  console.log(`\n[rules] delivered ${cases.filter((r) => r.ok).length}/${cases.length}; controls clean ${controls.filter((r) => r.ok).length}/${controls.length}`);
  if (!prev) {
    console.log("no previous result: this run is the baseline, saved");
    return 0;
  }
  const { drops, note } = compareRules(prev, cur);
  if (note) console.log(note);
  for (const d of drops) console.log(`DROP ${d}`);
  console.log(drops.length ? `delivery dropped against the saved result of ${prev.date}` : `no drop against the saved result of ${prev.date}`);
  return drops.length ? 1 : 0;
}

const readRun = (file: string): RulesRun | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RulesRun;
  } catch {
    return undefined;
  }
};

if (import.meta.main && process.argv[2] === "--compare") {
  const [prev, cur] = [readRun(process.argv[3] ?? ""), readRun(process.argv[4] ?? "")];
  if (!prev || !cur) throw new Error("usage: delivery-eval.ts --compare <previous.json> <current.json>");
  process.exit(report(prev, cur));
}

if (import.meta.main && process.argv[2] === "--precheck") {
  const [n, m, seed] = [Number(process.argv[3] ?? 4), Number(process.argv[4] ?? 2), Number(process.argv[5] ?? 11)];
  for (const line of precheckTable(n, m, seed)) console.log(line);
  process.exit(0);
}

if (import.meta.main && process.argv[2] === "--rules") {
  const [n, m, seed] = [Number(process.argv[3] ?? 4), Number(process.argv[4] ?? 2), Number(process.argv[5] ?? 11)];
  const saved = join(import.meta.dir, "..", ".delivery-eval-rules.json");
  const prev = readRun(saved);
  const cur = await runRules(n, m, seed);
  const code = report(prev, cur);
  // A degraded run never replaces the baseline it was judged against, or the next run would pass against the drop.
  if (code === 0) writeFileSync(saved, JSON.stringify(cur, null, 1));
  else writeFileSync(saved.replace(".json", ".failed.json"), JSON.stringify(cur, null, 1));
  process.exit(code);
}

if (import.meta.main) {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: delivery-eval.ts <repo> [cases] [controls] [seed] [read|bash|python]");
    process.exit(2);
  }
  const [n, m, seed] = [Number(process.argv[3] ?? 15), Number(process.argv[4] ?? 5), Number(process.argv[5] ?? 11)];
  const mode = (process.argv[6] ?? "read") as Mode;
  if (!(mode in OPEN)) throw new Error(`mode must be one of ${Object.keys(OPEN).join(", ")}`);
  const files = Bun.spawnSync(["git", "-C", repo, "ls-files"]).stdout.toString().split("\n").filter(Boolean);
  const { routes, unresolved } = routeLessons(repo, files);
  allTitles = [...new Set([...routes.flatMap((r) => r.lessons.map((l) => l.title)), ...unresolved.map((l) => l.title)])];
  const rand = rng(seed);
  const pick = <T>(xs: T[], k: number) => [...xs].sort(() => rand() - 0.5).slice(0, k);
  const routed = new Set(routes.map((r) => r.file));
  const cases: Case[] = [
    ...pick(routes, n).map((r) => ({ file: r.file, title: r.lessons[0]?.title })),
    ...pick(files.filter((f) => /\.(go|ts|vue)$/.test(f) && !routed.has(f) && !/test|spec/.test(f)), m).map((file) => ({ file })),
  ];
  // Three workers pull from one cursor, so a slow session never holds the others back.
  const results: { c: Case; ok: boolean; answer: string }[] = new Array(cases.length);
  let cursor = 0;
  const worker = async () => {
    for (let i = cursor++; i < cases.length; i = cursor++) results[i] = await runCase(repo, cases[i] as Case, mode);
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const r of results) console.log(`${r.ok ? "OK " : "NO "} ${r.c.title ? "lesson " : "control"} ${r.c.file}`);
  const pos = results.filter((r) => r.c.title);
  const neg = results.filter((r) => !r.c.title);
  console.log(`\n[${mode}] delivered ${pos.filter((r) => r.ok).length}/${pos.length} lessons; controls clean ${neg.filter((r) => r.ok).length}/${neg.length}`);
  await Bun.write(join(import.meta.dir, "..", `.delivery-eval-${mode}.json`), JSON.stringify(results, null, 1));
}
