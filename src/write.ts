import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.ts";
import { projectSlug } from "./corpus.ts";

export type Written = { file: string; note: string };

const VERSION = /^\d+\.\d+\.\d+$/;

function today(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function prependUnderH1(text: string, block: string, fallbackH1: string): string {
  if (!text.trim()) return `${fallbackH1}\n\n${block}\n`;
  const lines = text.split("\n");
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 === -1) return `${fallbackH1}\n\n${block}\n\n${text}`;
  let at = h1 + 1;
  while (at < lines.length && !lines[at]?.startsWith("## ")) at++;
  const head = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  const rest = lines.slice(at).join("\n");
  const sep = /\n---\n/.test(text) ? "\n\n---\n\n" : "\n\n";
  return rest.trim() ? `${head}\n\n${block}${sep}${rest}` : `${head}\n\n${block}\n`;
}

export function newestVersion(text: string): string | undefined {
  return text.match(/^## v(\d+\.\d+\.\d+)/m)?.[1] ?? text.match(/— v(\d+\.\d+\.\d+)/)?.[1];
}

export function logProgress(a: {
  projectDir: string;
  version: string;
  title: string;
  body: string;
  app?: string;
}): Written {
  if (!VERSION.test(a.version)) throw new Error(`version must be X.Y.Z, got "${a.version}"`);
  const file = join(a.projectDir, "docs", "progress.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const date = today();
  const newest = text.match(/^## Session — (\d{4}-\d{2}-\d{2})/m)?.[1];
  const cont = newest === date ? " (cont)" : "";
  const app = a.app ? ` (${a.app})` : "";
  const block = `## Session — ${date}${cont} — v${a.version}${app} (${a.title})\n\n${a.body.trim()}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, prependUnderH1(text, block, `# ${basename(a.projectDir)} Progress`));
  return { file, note: `prepended "## Session — ${date}${cont} — v${a.version}"` };
}

export function logChangelog(a: { projectDir: string; version: string; title: string; bullets: string[] }): Written {
  if (!VERSION.test(a.version)) throw new Error(`version must be X.Y.Z, got "${a.version}"`);
  if (!a.bullets.length) throw new Error("a changelog entry needs at least one bullet");
  const file = join(a.projectDir, "docs", "changelog.md");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const dup = new RegExp(`^## v${a.version.replace(/\./g, "\\.")}(\\s|$)`, "m");
  if (dup.test(text)) {
    throw new Error(
      `v${a.version} already has a heading in ${file} — another session may have taken it. Re-read the newest heading and pick the next version.`,
    );
  }
  const newest = newestVersion(text);
  if (newest && cmpVersion(a.version, newest) <= 0) {
    throw new Error(`v${a.version} is not newer than the newest heading v${newest} — pick a higher version.`);
  }
  const block = `## v${a.version} — ${a.title}\n\n${a.bullets.map((b) => `- ${b.replace(/^-\s*/, "")}`).join("\n")}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, prependUnderH1(text, block, `# ${basename(a.projectDir)} Changelog`));
  return { file, note: `prepended "## v${a.version}" (previous newest: ${newest ?? "none"})` };
}

export type MemoryType = "user" | "feedback" | "project" | "reference";

// Who started the record: the user asked for it, the agent learned it unprompted, or the user wrote the words.
// The agent usually does the writing either way, so this is the one fact the file itself cannot show.
export const ORIGINS = ["user-requested", "agent-initiated", "user-written"] as const;
export type Origin = (typeof ORIGINS)[number];

export function memoryDir(projectDir: string): string {
  return join(config.projectsDir, projectSlug(projectDir), "memory");
}

export function recordMemory(a: {
  projectDir: string;
  type: MemoryType;
  name: string;
  title: string;
  description: string;
  body: string;
  origin: Origin;
  replace?: boolean;
}): Written {
  if (!ORIGINS.includes(a.origin)) throw new Error(`origin must be one of ${ORIGINS.join(", ")}`);
  const name = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!name) throw new Error("name must contain letters or digits");
  if (/\n/.test(a.description)) throw new Error("description must be one line");
  const dir = memoryDir(a.projectDir);
  const file = join(dir, `${name}.md`);
  const exists = existsSync(file);
  if (exists && !a.replace) {
    throw new Error(`${file} already exists — read it (mcp__batas__get memory:<slug>/${name}) and pass replace: true to update it`);
  }
  mkdirSync(dir, { recursive: true });
  const description = a.description.replace(/"/g, "'");
  writeFileSync(
    file,
    `---\nname: ${name}\ndescription: "${description}"\nmetadata:\n  type: ${a.type}\n  origin: ${a.origin}\n  recorded: ${today()}\n---\n\n${a.body.trim()}\n`,
  );
  const index = join(dir, "MEMORY.md");
  const indexText = existsSync(index) ? readFileSync(index, "utf8") : "# Memory Index\n\n";
  const pointer = `- [${a.title}](${name}.md) — ${a.description}`;
  const has = indexText.split("\n").findIndex((l) => l.includes(`](${name}.md)`));
  let nextIndex: string;
  if (has >= 0) {
    const lines = indexText.split("\n");
    lines[has] = pointer;
    nextIndex = lines.join("\n");
  } else {
    nextIndex = `${indexText.replace(/\s*$/, "")}\n${pointer}\n`;
  }
  writeFileSync(index, nextIndex);
  return { file, note: `${exists ? "updated" : "created"} ${name}.md and ${has >= 0 ? "updated" : "added"} its MEMORY.md pointer` };
}
