import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { config } from "./config.ts";

export type Kind =
  | "rule"
  | "rule-section"
  | "reference"
  | "memory"
  | "project-rule"
  | "progress"
  | "changelog"
  | "context";

export type Entry = {
  id: string;
  kind: Kind;
  scope: string;
  title: string;
  body: string;
  source: string;
  line: number;
};

const FAMILY_HEAD = /^## ([A-Z])\. (.+)$/;
const FAMILY_ITEM = /^(\d+)\. /;

export function stripFrontmatter(text: string): { fm: Record<string, string>; body: string; offset: number } {
  if (!text.startsWith("---\n")) return { fm: {}, body: text, offset: 0 };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { fm: {}, body: text, offset: 0 };
  const fm: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const m = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (m?.[1] && m[2] !== undefined) fm[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const after = text.indexOf("\n", end + 4);
  const body = after === -1 ? "" : text.slice(after + 1);
  const offset = text.slice(0, after + 1).split("\n").length - 1;
  return { fm, body, offset };
}

export function familyOf(file: string): string | undefined {
  const name = basename(file);
  if (config.families[name]) return config.families[name];
  for (const [family, prefix] of Object.entries(config.familySlicePrefix)) {
    if (name.startsWith(prefix)) return family;
  }
  return undefined;
}

export function headline(body: string): string {
  const bold = body.match(/\*\*(.+?)\*\*/);
  const text = (bold?.[1] ?? body).replace(/`/g, "").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

export function parseFamily(file: string, family: string): Entry[] {
  const { body, offset } = stripFrontmatter(readFileSync(file, "utf8"));
  const lines = body.split("\n");
  const out: Entry[] = [];
  let section: string | undefined;
  let current: { id: string; start: number; lines: string[] } | undefined;
  let inFence = false;

  const flush = () => {
    if (!current) return;
    while (current.lines.length && !current.lines.at(-1)?.trim()) current.lines.pop();
    const text = current.lines.join("\n");
    out.push({
      id: current.id,
      kind: "rule",
      scope: "global",
      title: headline(text),
      body: text,
      source: file,
      line: current.start + offset + 1,
    });
    current = undefined;
  };

  lines.forEach((line, i) => {
    if (line.startsWith("```")) inFence = !inFence;
    const head = !inFence && line.match(FAMILY_HEAD);
    if (head) {
      flush();
      section = head[1];
      return;
    }
    const item = !inFence && section ? line.match(FAMILY_ITEM) : null;
    if (item) {
      flush();
      current = { id: `${family}:${section}${item[1]}`, start: i, lines: [line] };
      return;
    }
    if (line.startsWith("## ")) {
      flush();
      section = undefined;
      return;
    }
    current?.lines.push(line);
  });
  flush();
  return out;
}

export function parseSections(file: string, idPrefix: string, kind: Kind, scope: string, headRe = /^## /): Entry[] {
  const raw = readFileSync(file, "utf8");
  const { body, offset } = stripFrontmatter(raw);
  const lines = body.split("\n");
  const out: Entry[] = [];
  let title = basename(file, ".md");
  let start = 0;
  let buf: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = buf.join("\n").trim();
    if (text.length > 20) {
      const key = out.length === 0 && start === 0 ? idPrefix : `${idPrefix}#${slug(title)}`;
      const id = out.some((e) => e.id === key) ? `${key}-${out.length}` : key;
      out.push({ id, kind, scope, title, body: text, source: file, line: start + offset + 1 });
    }
    buf = [];
  };

  lines.forEach((line, i) => {
    if (line.startsWith("```")) inFence = !inFence;
    if (!inFence && headRe.test(line)) {
      flush();
      title = line.replace(/^#+\s*/, "").trim();
      start = i;
    }
    buf.push(line);
  });
  flush();
  return out;
}

export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

function listMd(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(dir, f));
}

export type Source = { file: string; parse: () => Entry[] };

export function globalSources(): Source[] {
  const sources: Source[] = [];

  for (const file of listMd(config.rulesDir)) {
    const family = familyOf(file);
    const name = basename(file);
    sources.push({
      file,
      parse: () =>
        family ? parseFamily(file, family) : parseSections(file, `rule:${name}`, "rule-section", "global"),
    });
  }

  const refDirs = [...config.referenceDirs];
  if (existsSync(config.skillsDir)) {
    for (const skill of readdirSync(config.skillsDir)) {
      refDirs.push(join(config.skillsDir, skill, "references"));
    }
  }
  for (const dir of refDirs) {
    for (const file of listMd(dir)) {
      const rel = relative(config.claudeHome, file);
      sources.push({ file, parse: () => parseSections(file, `ref:${rel}`, "reference", "global") });
    }
  }

  if (existsSync(config.projectsDir)) {
    for (const project of readdirSync(config.projectsDir)) {
      for (const file of listMd(join(config.projectsDir, project, "memory"))) {
        if (basename(file) === "MEMORY.md") continue;
        sources.push({ file, parse: () => [parseMemory(file, project)] });
      }
    }
  }
  return sources;
}

const TRIGGERS_MARK = " · triggers: ";

// A memory's `triggers:` are the words the user actually types when it applies (Indonesian and English); they ride in
// the indexed title so FTS ranks them high, and memoryTriggers() reads them back out for the hook's exact match.
export function memoryTriggers(title: string): string[] {
  const i = title.indexOf(TRIGGERS_MARK);
  if (i < 0) return [];
  return title
    .slice(i + TRIGGERS_MARK.length)
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 1);
}

export function parseMemory(file: string, project: string): Entry {
  const { fm, body } = stripFrontmatter(readFileSync(file, "utf8"));
  const raw = readFileSync(file, "utf8");
  const type = fm.type ?? raw.match(/^\s+type:\s*(\w+)/m)?.[1] ?? "note";
  const origin = fm.origin ?? raw.match(/^\s+origin:\s*([\w-]+)/m)?.[1];
  const triggers = (fm.triggers ?? raw.match(/^\s+triggers:\s*(.+)$/m)?.[1] ?? "").replace(/^["'\[]|["'\]]$/g, "").trim();
  const name = basename(file, ".md");
  return {
    id: `memory:${project}/${name}`,
    kind: "memory",
    scope: project,
    title: `[${type}${origin ? ` · ${origin}` : ""}] ${fm.name ?? name} — ${fm.description ?? ""}${triggers ? `${TRIGGERS_MARK}${triggers}` : ""}`.trim(),
    body: body.trim(),
    source: file,
    line: 1,
  };
}

export function projectSources(): Source[] {
  const sources: Source[] = [];
  for (const root of config.projectRoots) {
    if (!existsSync(root)) continue;
    for (const repo of readdirSync(root)) {
      const dir = join(root, repo);
      if (repo.startsWith(".") || repo.includes("-wt-")) continue;
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const file of listMd(join(dir, ".claude", "rules"))) {
        sources.push({
          file,
          parse: () => parseSections(file, `project:${repo}:${basename(file)}`, "project-rule", repo),
        });
      }
      const progress = join(dir, "docs", "progress.md");
      if (existsSync(progress)) {
        sources.push({
          file: progress,
          parse: () => parseSections(progress, `project:${repo}:progress`, "progress", repo),
        });
      }
      const changelog = join(dir, "docs", "changelog.md");
      if (existsSync(changelog)) {
        sources.push({
          file: changelog,
          parse: () => parseSections(changelog, `project:${repo}:changelog`, "changelog", repo),
        });
      }
      for (const sub of ["context", "lessons"]) {
        for (const file of listMd(join(dir, "docs", sub))) {
          sources.push({
            file,
            parse: () => parseSections(file, `project:${repo}:${sub}/${basename(file)}`, "context", repo),
          });
        }
      }
      const qaContext = join(dir, "docs", "qa", "context.md");
      if (existsSync(qaContext)) {
        sources.push({
          file: qaContext,
          parse: () => parseSections(qaContext, `project:${repo}:qa/context.md`, "context", repo),
        });
      }
    }
  }
  return sources;
}

// The always-on family files are condensed; the hook injects the full original item from these references instead,
// so they ride the hook's cheap "rules" refresh rather than waiting for the MCP server's full one.
function familyFullTextSources(): Source[] {
  const dir = config.referenceDirs[0] ?? "";
  return Object.values(config.familyFullText)
    .map((name) => join(dir, name))
    .filter((file) => existsSync(file))
    .map((file) => ({
      file,
      parse: () => parseSections(file, `ref:${relative(config.claudeHome, file)}`, "reference", "global"),
    }));
}

export function memorySources(project: string): Source[] {
  return listMd(join(config.projectsDir, project, "memory"))
    .filter((file) => basename(file) !== "MEMORY.md")
    .map((file) => ({ file, parse: () => [parseMemory(file, project)] }));
}

export function allSources(scope: "rules" | "all"): Source[] {
  if (scope === "rules") {
    return [...familyFullTextSources(), ...listMd(config.rulesDir).map((file) => {
      const family = familyOf(file);
      return {
        file,
        parse: () =>
          family
            ? parseFamily(file, family)
            : parseSections(file, `rule:${basename(file)}`, "rule-section", "global"),
      };
    })];
  }
  return [...globalSources(), ...projectSources()];
}
