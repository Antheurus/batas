// One memory used by several projects is stored once and each project's memory directory symlinks to it, so a
// correction lands everywhere instead of in the one copy that session happened to open. Chosen over a frontmatter
// `projects:` list that batas would resolve: a symlink is read natively by Claude Code, by batas (readdir + readFile
// follow it) and by the cc-toriq mirror (which records link targets), so nothing else had to change.
//
//   bun scripts/memory-share.ts                 list names present in 2+ projects, identical or drifted
//   bun scripts/memory-share.ts <name> [--from <file>] [--apply]
//
// Copies must be byte-identical unless --from names the merged text to keep; originals are backed up first.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { config } from "../src/config.ts";

export type Copy = { slug: string; file: string; text: string; shared: boolean };

export function copiesOf(name: string, projectsDir = config.projectsDir): Copy[] {
  const out: Copy[] = [];
  for (const slug of readdirSync(projectsDir)) {
    const file = join(projectsDir, slug, "memory", name);
    if (!existsSync(file)) continue;
    out.push({ slug, file, text: readFileSync(file, "utf8"), shared: lstatSync(file).isSymbolicLink() });
  }
  return out;
}

export function shareMemory(
  name: string,
  opts: { from?: string; apply?: boolean; projectsDir?: string; sharedDir?: string; backupDir?: string } = {},
): { plan: string[]; error?: string } {
  const projectsDir = opts.projectsDir ?? config.projectsDir;
  const sharedDir = opts.sharedDir ?? config.sharedMemoryDir;
  const backupDir = opts.backupDir ?? join(config.stateDir, "memory-share-backup");
  const copies = copiesOf(name, projectsDir).filter((c) => !c.shared);
  if (copies.length < 2 && !existsSync(join(sharedDir, name))) return { plan: [], error: `${name}: fewer than 2 copies, nothing to share` };
  const variants = new Set(copies.map((c) => c.text));
  if (variants.size > 1 && !opts.from) {
    return { plan: [], error: `${name}: ${variants.size} different versions — merge them into one file and pass --from <file>` };
  }
  const text = opts.from ? readFileSync(opts.from, "utf8") : (copies[0] as Copy).text;
  const dest = join(sharedDir, name);
  if (existsSync(dest) && readFileSync(dest, "utf8") !== text) return { plan: [], error: `${dest} exists with other content` };
  const plan = [`write ${dest}`, ...copies.map((c) => `link ${c.file} -> ${relative(join(projectsDir, c.slug, "memory"), dest)}`)];
  if (!opts.apply) return { plan };
  mkdirSync(sharedDir, { recursive: true });
  writeFileSync(dest, text);
  for (const c of copies) {
    mkdirSync(join(backupDir, c.slug), { recursive: true });
    copyFileSync(c.file, join(backupDir, c.slug, name));
    unlinkSync(c.file);
    symlinkSync(relative(join(projectsDir, c.slug, "memory"), dest), c.file);
  }
  return { plan };
}

if (import.meta.main) {
  const [name, ...rest] = process.argv.slice(2);
  if (!name) {
    const seen = new Map<string, Copy[]>();
    for (const slug of readdirSync(config.projectsDir)) {
      const dir = join(config.projectsDir, slug, "memory");
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md") || f === "MEMORY.md") continue;
        seen.set(f, [...(seen.get(f) ?? []), ...copiesOf(f).filter((c) => c.slug === slug)]);
      }
    }
    for (const [f, cs] of seen) {
      if (cs.length < 2) continue;
      const loose = cs.filter((c) => !c.shared);
      const state = !loose.length ? "shared" : new Set(loose.map((c) => c.text)).size > 1 ? "DRIFTED" : "identical copies";
      console.log(`${String(cs.length).padStart(3)} projects  ${state.padEnd(16)} ${f}`);
    }
  } else {
    const fromAt = rest.indexOf("--from");
    const r = shareMemory(name, { from: fromAt >= 0 ? rest[fromAt + 1] : undefined, apply: rest.includes("--apply") });
    if (r.error) {
      console.error(r.error);
      process.exit(1);
    }
    console.log(`${rest.includes("--apply") ? "APPLIED" : "DRY RUN (add --apply)"}\n${r.plan.join("\n")}`);
  }
}
