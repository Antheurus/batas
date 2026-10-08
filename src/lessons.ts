// Lessons routed to a source file live in <repo>/.claude/rules/lessons/ as path-scoped rules (scripts/lessons-route.ts).
// Claude Code loads one only when its file goes through the Read, Edit or Write tool; an agent that opens or rewrites the
// file with cat, sed or a python script gets nothing. This is the shared lookup the hook uses to cover that path.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

export function lessonRuleName(file: string): string {
  const slug = file.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "-").toLowerCase();
  return `p-lessons-${slug}.md`;
}

export function routedLessons(repo: string, absFile: string): { id: string; text: string } | undefined {
  const rel = relative(repo, absFile);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const rule = join(repo, ".claude", "rules", "lessons", lessonRuleName(rel));
  if (!existsSync(rule)) return undefined;
  const body = readFileSync(rule, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  return { id: `lessons-file:${rel}`, text: body };
}

const SOURCE_PATH = /(?:^|[\s'"`(=,])((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.(?:go|ts|tsx|js|mjs|vue|py|sql))(?=$|[\s'"`),:;])/g;

// Every existing source file a command names, quotes included: `python3 -c "open('a.go')"` opens a.go as surely as
// `sed -n 1,80p a.go` does. Only paths that exist count, so prose in a commit message names nothing.
// Claude Code 2.1.293 itself loads a file's path-scoped rules after `sed -n '<range>' <file>` (probed 3/3 and 15/15 with
// batas switched off) but not after cat, head, grep or a python script (NONE each), so a `sed -n` read is left to it.
const SED_READ = /\bsed\s+-n\s+(?:'[^']*'|"[^"]*"|\S+)\s+((?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*)/g;

export function filesInCommand(raw: string, dir: string): string[] {
  const out = new Set<string>();
  const nativelyLoaded = new Set([...raw.matchAll(SED_READ)].map((m) => m[1] as string));
  for (const m of raw.matchAll(SOURCE_PATH)) {
    const p = m[1] as string;
    if (nativelyLoaded.has(p)) continue;
    const abs = isAbsolute(p) ? p : resolve(dir, p);
    if (existsSync(abs)) out.add(abs);
  }
  return [...out];
}

export type Lesson = { source: string; title: string; text: string; symbols: string[] };
export type Route = { file: string; lessons: Lesson[] };

export const CODE = /\.(go|ts|tsx|js|mjs|vue|py)$/;
const SKIP = /(^|\/)(node_modules|dist|\.nuxt|\.output|vendor)\//;
// A declaration the file OWNS. Calls and imports are deliberately not matched: matching any mention put a median of 8
// unrelated lessons on every file.
const DEF =
  /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+|(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+|(?:export\s+)?(?:const|let|var)\s+|(?:export\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+|def\s+|class\s+)([A-Za-z_]\w+)/gm;

export function parseLessons(repo: string): Lesson[] {
  const dir = join(repo, "docs", "lessons");
  if (!existsSync(dir)) return [];
  const out: Lesson[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const body = readFileSync(join(dir, name), "utf8");
    for (const sec of body.split(/^## /m).slice(1)) {
      const title = (sec.split("\n")[0] ?? "").trim();
      const line = sec.match(/^\**Simbol\**:\s*(.+)$/m)?.[1] ?? "";
      // "`Owner` (`a`, `b`)" names Owner.a and Owner.b: read bare, `a` routed a billing lesson onto an unrelated
      // printer handler that happened to define a method of the same name.
      const qualified = line.replace(/`([\w.]+)`\s*\(([^)]*)\)/g, (_m, owner: string, inner: string) =>
        inner.replace(/`([\w.]+)`/g, (_x, member: string) => `\`${owner}.${member}\``),
      );
      const symbols = [...qualified.matchAll(/`([^`]+)`/g)].map((m) => (m[1] ?? "").replace(/\(\)$/, "")).filter(Boolean);
      out.push({ source: `docs/lessons/${name}`, title, text: `## ${sec.trimEnd()}`, symbols });
    }
  }
  return out;
}

export function definitions(repo: string, files: string[]): Map<string, Set<string>> {
  const defs = new Map<string, Set<string>>();
  for (const f of files) {
    let text = "";
    try {
      text = readFileSync(join(repo, f), "utf8");
    } catch {
      continue;
    }
    defs.set(f, new Set([...text.matchAll(DEF)].map((m) => m[1] as string)));
  }
  return defs;
}

// `Owner.member` resolves to files defining `member` that also mention `Owner` (a Go receiver, a store, a class); a bare
// name resolves only when at most two files define it, since a name defined everywhere (`loaded`, `Replace`) points at
// nothing in particular.
export function resolveSymbol(sym: string, defs: Map<string, Set<string>>, text: (f: string) => string): string[] {
  const parts = sym.split(".");
  const member = parts[parts.length - 1] as string;
  const owner = parts.length > 1 ? (parts[parts.length - 2] as string) : undefined;
  if (!/^[A-Za-z_]\w{2,}$/.test(member)) return [];
  const definers = (name: string) => [...defs].filter(([, d]) => d.has(name)).map(([f]) => f);
  const owners = definers(member);
  if (owners.length) {
    if (owner) return owners.filter((f) => text(f).includes(owner));
    return owners.length <= 2 ? owners : [];
  }
  // No declaration of its own: a struct field or a member of a grouped `const (...)` block. Its owner type is the
  // better anchor when there is one; otherwise the one or two files that declare it as an indented name.
  if (owner && /^[A-Z]/.test(owner)) {
    const typed = definers(owner);
    if (typed.length && typed.length <= 2) return typed;
  }
  const field = new RegExp(String.raw`^\s+${member}\b\s*[\w*\[\]{}.]*\s*(=|\x60|$|[A-Za-z*\[])`, "m");
  const declaring = [...defs.keys()].filter((f) => field.test(text(f)));
  return declaring.length <= 2 ? declaring : [];
}

export function routeLessons(repo: string, files: string[]): { routes: Route[]; unresolved: Lesson[] } {
  const code = files.filter((f) => CODE.test(f) && !SKIP.test(f) && !/(_test\.go|\.spec\.ts|\.test\.ts)$/.test(f));
  const defs = definitions(repo, code);
  const cache = new Map<string, string>();
  const text = (f: string) => {
    if (!cache.has(f)) cache.set(f, readFileSync(join(repo, f), "utf8"));
    return cache.get(f) as string;
  };
  const byFile = new Map<string, Lesson[]>();
  const unresolved: Lesson[] = [];
  for (const lesson of parseLessons(repo)) {
    const targets = new Set(lesson.symbols.flatMap((s) => resolveSymbol(s, defs, text)));
    if (!targets.size) {
      unresolved.push(lesson);
      continue;
    }
    for (const f of targets) byFile.set(f, [...(byFile.get(f) ?? []), lesson]);
  }
  const routes = [...byFile].map(([file, lessons]) => ({ file, lessons })).sort((a, b) => a.file.localeCompare(b.file));
  return { routes, unresolved };
}

export function ruleFile(route: Route): { name: string; content: string } {
  const name = lessonRuleName(route.file);
  const slug = name.replace(/^p-lessons-|\.md$/g, "");
  const sources = [...new Set(route.lessons.map((l) => l.source))].join(", ");
  const content = [
    "---",
    `name: lessons-${slug}`,
    `description: "Lessons about ${route.file} — generated from ${sources} by batas lessons-route; edit the source, not this file"`,
    "paths:",
    `  - "${route.file}"`,
    "---",
    "",
    `# Lessons for \`${basename(route.file)}\``,
    "",
    "Past mistakes and invariants recorded for code defined in this file. Read them before changing it.",
    "",
    ...route.lessons.map((l) => `${l.text}\n`),
  ].join("\n");
  return { name, content };
}

// Generated files that are missing, changed, or no longer generated: any of them means the routing lies about the code.
export function staleFiles(out: string, routes: Route[]): string[] {
  const want = new Map(routes.map((r) => [ruleFile(r).name, ruleFile(r).content]));
  const have = existsSync(out) ? readdirSync(out).filter((f) => f.endsWith(".md")) : [];
  return [
    ...[...want].filter(([n, c]) => !existsSync(join(out, n)) || readFileSync(join(out, n), "utf8") !== c).map(([n]) => n),
    ...have.filter((n) => !want.has(n)),
  ];
}


const MARKER = ".generated";

function lessonsStamp(repo: string): number {
  const dir = join(repo, "docs", "lessons");
  if (!existsSync(dir)) return 0;
  return Math.max(0, ...readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => statSync(join(dir, f)).mtimeMs));
}

export function lessonsDir(repo: string): string {
  return join(repo, ".claude", "rules", "lessons");
}

export function routeRepo(repo: string): { routes: Route[]; unresolved: Lesson[] } {
  const ls = Bun.spawnSync(["git", "-C", repo, "ls-files"], { stdout: "pipe", stderr: "ignore" });
  return routeLessons(repo, ls.stdout.toString().split("\n").filter(Boolean));
}

// Rewrites the generated directory from scratch and stamps it with the lessons' newest mtime.
export function writeRoutes(repo: string, routes: Route[]): void {
  const out = lessonsDir(repo);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const r of routes) {
    const f = ruleFile(r);
    writeFileSync(join(out, f.name), f.content);
  }
  writeFileSync(join(out, MARKER), String(lessonsStamp(repo)));
}

// Cheap enough for every hook call: only repos that already carry routed lessons, and only a stat of docs/lessons.
// Returns the files that changed when a lesson was edited since the last generation.
export function regenIfLessonsChanged(repo: string): string[] | undefined {
  const out = lessonsDir(repo);
  const marker = join(out, MARKER);
  if (!existsSync(marker)) return undefined;
  if (lessonsStamp(repo) <= Number(readFileSync(marker, "utf8") || 0)) return undefined;
  return regenAll(repo);
}

// Full re-resolution against the code, for the moment before a commit: a renamed or moved symbol shows up only here.
export function regenAll(repo: string): string[] {
  if (!existsSync(join(lessonsDir(repo), MARKER))) return [];
  const { routes } = routeRepo(repo);
  const stale = staleFiles(lessonsDir(repo), routes);
  if (stale.length || lessonsStamp(repo) > Number(readFileSync(join(lessonsDir(repo), MARKER), "utf8") || 0)) writeRoutes(repo, routes);
  return stale;
}
