// Flag memories that name a file which no longer exists. A memory is read as fact by the next session, so a path that
// moved is worse than no path. Calibrated against the real corpus before shipping: of 1,233 named paths a plain exists()
// check called 540 missing, almost all of them false (a server's /etc, a skill-relative `references/x.md`, a gitignored
// dump). So a verdict is only given where it can be proven: a relative path is STALE when its repo's git history once
// tracked it and the tree no longer does (with the rename target when git recorded one); an absolute path is checked
// only when its first two directories under the home exist on this machine. Everything else is left unjudged.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { config } from "../src/config.ts";

export type GitIndex = { top: string; now: Set<string>; ever: Set<string>; renamed: Map<string, string> };
export type PathVerdict = { path: string; verdict: "ok" | "stale" | "unjudged"; movedTo?: string };

const PATH = /(?<![\w/.~-])((?:~|\/Users)\/[\w./@+-]+|(?:[\w@.-]+\/)+[\w@.-]+\.\w{1,10})/g;

export function namedPaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PATH)) {
    const p = (m[1] ?? "").replace(/[.,:;)'"`]+$/, "");
    // a placeholder, a glob, or a path the prose cut short is not a claim about one file
    if (!p || /[<*{$]|\.\.\.|-$/.test(p)) continue;
    out.add(p);
  }
  return [...out];
}

// A memory directory slug is its project path with every non-alphanumeric turned into "-", so the path is recovered by
// walking the real filesystem and taking the longest entry whose sanitized name prefixes what is left.
export function resolveRoot(slug: string): string | undefined {
  let cur = "/";
  let rest = slug.replace(/^-+/, "");
  while (rest) {
    let entries: string[];
    try {
      entries = readdirSync(cur).sort((a, b) => b.length - a.length);
    } catch {
      return undefined;
    }
    const next = entries.find((e) => {
      const s = e.replace(/[^A-Za-z0-9]/g, "-");
      return rest === s || rest.startsWith(`${s}-`);
    });
    if (!next) return undefined;
    rest = rest.slice(next.replace(/[^A-Za-z0-9]/g, "-").length).replace(/^-+/, "");
    cur = join(cur, next);
  }
  return cur;
}

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

export function gitIndex(root: string): GitIndex | undefined {
  const top = git(root, ["rev-parse", "--show-toplevel"]).trim();
  if (!top) return undefined;
  const lines = (s: string) => new Set(s.split("\n").filter(Boolean));
  const renamed = new Map<string, string>();
  for (const line of git(top, ["log", "--all", "-M", "--diff-filter=R", "--name-status", "--format="]).split("\n")) {
    const [status, from, to] = line.split("\t");
    if (status?.startsWith("R") && from && to && !renamed.has(from)) renamed.set(from, to);
  }
  return {
    top,
    now: lines(git(top, ["ls-files"])),
    ever: lines(git(top, ["log", "--all", "--format=", "--name-only"])),
    renamed,
  };
}

const suffixOf = (p: string, names: Iterable<string>) => {
  for (const n of names) if (n === p || n.endsWith(`/${p}`)) return n;
  return undefined;
};

export function judgePath(p: string, root: string | undefined, idx: GitIndex | undefined, home = homedir()): PathVerdict {
  if (p.startsWith("~") || p.startsWith("/")) {
    const full = p.startsWith("~") ? join(home, p.slice(1)) : p;
    if (!full.startsWith(`${home}/`)) return { path: p, verdict: "unjudged" };
    const anchor = join(home, ...full.slice(home.length + 1).split("/").slice(0, 2));
    if (!existsSync(anchor)) return { path: p, verdict: "unjudged" };
    return { path: p, verdict: existsSync(full) ? "ok" : "stale" };
  }
  if (!root) return { path: p, verdict: "unjudged" };
  if (existsSync(join(root, p))) return { path: p, verdict: "ok" };
  if (!idx) return { path: p, verdict: "unjudged" };
  if (suffixOf(p, idx.now)) return { path: p, verdict: "ok" };
  const was = suffixOf(p, idx.ever);
  if (!was) return { path: p, verdict: "unjudged" };
  let to = idx.renamed.get(was);
  for (let hops = 0; to && idx.renamed.has(to) && hops < 10; hops++) to = idx.renamed.get(to);
  return { path: p, verdict: "stale", movedTo: to && idx.now.has(to) ? to : undefined };
}

if (import.meta.main) {
  const roots = new Map<string, string | undefined>();
  const indexes = new Map<string, GitIndex | undefined>();
  const counts = { ok: 0, stale: 0, unjudged: 0 };
  const report: string[] = [];
  let memories = 0;
  let staleMemories = 0;
  for (const slug of readdirSync(config.projectsDir)) {
    const dir = join(config.projectsDir, slug, "memory");
    if (!existsSync(dir)) continue;
    if (!roots.has(slug)) roots.set(slug, resolveRoot(slug));
    const root = roots.get(slug);
    if (root && !indexes.has(root)) indexes.set(root, gitIndex(root));
    const idx = root ? indexes.get(root) : undefined;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || name === "MEMORY.md") continue;
      memories++;
      const verdicts = namedPaths(readFileSync(join(dir, name), "utf8")).map((p) => judgePath(p, root, idx));
      for (const v of verdicts) counts[v.verdict]++;
      const stale = verdicts.filter((v) => v.verdict === "stale");
      if (!stale.length) continue;
      staleMemories++;
      report.push(`memory:${slug}/${basename(name, ".md")}`);
      for (const v of stale) report.push(`    ${v.path}${v.movedTo ? `  -> now ${v.movedTo}` : "  (gone)"}`);
    }
  }
  console.log(`memories ${memories}; naming a stale path: ${staleMemories}`);
  console.log(`named paths: ${counts.ok} exist, ${counts.stale} stale, ${counts.unjudged} unjudged (remote, untracked or no repo)`);
  console.log("Report only: the owner decides whether to rewrite or delete each memory.\n");
  console.log(report.join("\n"));
}
