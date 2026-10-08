// The corpus as batasd sees it: one JSON line per entry, with a content hash so the daemon re-embeds only what changed.
// The parsers stay in TypeScript; the daemon runs this instead of owning a second copy of them.
import { statSync } from "node:fs";
import { allSources, type Entry } from "./corpus.ts";

export function entryHash(e: Pick<Entry, "title" | "body">): string {
  return new Bun.CryptoHasher("sha1").update(`${e.title}\n${e.body}`).digest("hex");
}

if (import.meta.main && process.argv.includes("--stamp")) {
  // What changed is decided from file paths and mtimes alone; parsing runs only when this differs from the last run.
  const h = new Bun.CryptoHasher("sha1");
  for (const src of allSources("all")) {
    try {
      h.update(`${src.file}\0${statSync(src.file).mtimeMs}\n`);
    } catch {}
  }
  console.log(h.digest("hex"));
} else if (import.meta.main) {
  const out: string[] = [];
  for (const src of allSources("all")) {
    let entries: Entry[] = [];
    try {
      entries = src.parse();
    } catch (err) {
      console.error(`batas: failed to parse ${src.file}: ${String(err)}`);
    }
    for (const e of entries) {
      out.push(JSON.stringify({ id: e.id, kind: e.kind, scope: e.scope, title: e.title, source: e.source, hash: entryHash(e), text: e.body }));
    }
  }
  await Bun.write(Bun.stdout, `${out.join("\n")}\n`);
}
