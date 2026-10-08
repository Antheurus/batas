// The one measurement that says whether batas works: when an agent opens a file, does the lesson about that file
// reach it? Each case is a fresh `claude -p` that may only Read the file and must then quote, from its own context, the
// headings of lessons about that file. Recall, MCP and search are off, so only automatic delivery can pass. Control
// files with no lesson must answer NONE, which catches a session that invents an answer.
//
//   bun scripts/delivery-eval.ts <repo> [cases=15] [controls=5] [seed=11]
// Costs one Claude session per case (~20 s each, 3 at a time); it is not part of `just check`.
import { join } from "node:path";
import { routeLessons } from "./lessons-route.ts";

// How the agent opens the file. The rule files only load through the Read/Edit/Write tools, and agents here open files
// with cat/sed and python as often, so each way is its own measurement.
const OPEN = {
  read: (f: string) => `Read ${f} with the Read tool.`,
  bash: (f: string) => `Show ${f} by running exactly this Bash command: sed -n '1,400p' ${f}`,
  python: (f: string) => `Show ${f} by running exactly this Bash command: python3 -c "print(open('${f}').read())"`,
} as const;
type Mode = keyof typeof OPEN;

const PROMPT = (file: string, mode: Mode) =>
  `${OPEN[mode](file)} Do not read, search or open any other file and do not call any other tool. Then look ONLY at what is ` +
  "already in your context (instructions, rules, system reminders, hook-injected text) and list, verbatim, the heading of " +
  "every lesson or rule that is specifically about code in that file (not general coding rules). One per line. If there " +
  "is none, reply exactly NONE.";

type Case = { file: string; title?: string };

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

async function runCase(repo: string, c: Case, mode: Mode): Promise<{ c: Case; ok: boolean; answer: string }> {
  const tools = mode === "read" ? "Read" : "Bash";
  const p = Bun.spawn(["claude", "-p", PROMPT(c.file, mode), "--allowedTools", tools], { cwd: repo, stdout: "pipe", stderr: "pipe", env: process.env });
  const answer = (await new Response(p.stdout).text()).trim();
  await p.exited;
  const ok = c.title ? delivered(answer, c.title) : /^NONE\b/i.test(answer);
  return { c, ok, answer };
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
  const { routes } = routeLessons(repo, files);
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
