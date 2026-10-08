// The corpus held in memory, parsed straight from its source files: the rules alone parse in ~8 ms, everything in ~265
// ms (7,990 entries), so a per-call hook parses what it needs and the long-lived MCP server keeps it all, re-parsing only
// files whose mtime moved. Search is semantic and lives in batasd; the SQLite + FTS5 index this replaced could only
// match words, and a database file shared between live sessions was the source of the "disk I/O error" class.
import { statSync } from "node:fs";
import { allSources, type Entry, type Kind, type Source } from "./corpus.ts";
import { semanticSearch } from "./semantic.ts";

const LINK_TO = /_linked to (\S+?) of ([A-Z]\d+)_/g;
const WIKI = /\[\[([^\]]+)\]\]/g;

export type Hit = Entry & { score: number; snippet: string };

export class Store {
  private byId = new Map<string, Entry>();
  private bySource = new Map<string, { mtime: number; ids: string[] }>();

  refresh(scope: "rules" | "all" = "all", extra: Source[] = []): { changed: number; removed: number } {
    const sources = [...allSources(scope), ...extra];
    const seen = new Set<string>();
    let changed = 0;
    for (const src of sources) {
      seen.add(src.file);
      let mtime: number;
      try {
        mtime = statSync(src.file).mtimeMs;
      } catch {
        continue;
      }
      if (this.bySource.get(src.file)?.mtime === mtime) continue;
      this.drop(src.file);
      let entries: Entry[] = [];
      try {
        entries = src.parse();
      } catch (err) {
        console.error(`batas: failed to parse ${src.file}: ${String(err)}`);
      }
      for (const e of entries) this.byId.set(e.id, e);
      this.bySource.set(src.file, { mtime, ids: entries.map((e) => e.id) });
      changed++;
    }
    let removed = 0;
    if (scope === "all") {
      for (const file of [...this.bySource.keys()].filter((f) => !seen.has(f))) {
        this.drop(file);
        removed++;
      }
    }
    return { changed, removed };
  }

  private drop(file: string) {
    for (const id of this.bySource.get(file)?.ids ?? []) this.byId.delete(id);
    this.bySource.delete(file);
  }

  get(id: string): Entry | undefined {
    const exact = this.byId.get(id);
    if (exact) return exact;
    let best: Entry | undefined;
    for (const e of this.byId.values()) if (e.id.includes(id) && (!best || e.id.length < best.id.length)) best = e;
    return best;
  }

  entries(kind?: Kind): Entry[] {
    const all = [...this.byId.values()];
    return kind ? all.filter((e) => e.kind === kind) : all;
  }

  memories(scope: string): Entry[] {
    return this.entries("memory").filter((e) => e.scope === scope);
  }

  memoryTitlesOutside(scope: string): Pick<Entry, "id" | "scope" | "title">[] {
    return this.entries("memory").filter((e) => e.scope !== scope);
  }

  links(id: string): { dst: string; kind: string }[] {
    const body = this.byId.get(id)?.body ?? "";
    return [
      ...[...body.matchAll(LINK_TO)].map((m) => ({ dst: `${m[1]}#${m[2]}`, kind: "linked_to" })),
      ...[...body.matchAll(WIKI)].map((m) => ({ dst: m[1] ?? "", kind: "wiki" })),
    ];
  }

  // undefined = batasd is not answering (it is started on the way); [] = it answered and nothing is close.
  async search(query: string, opts: { kinds?: Kind[]; scope?: string; limit?: number; timeoutMs?: number } = {}): Promise<Hit[] | undefined> {
    const hits = await semanticSearch(query, opts);
    if (!hits) return undefined;
    return hits.map((h) => {
      const e = this.byId.get(h.id);
      const body = e?.body ?? "";
      return {
        id: h.id,
        kind: h.kind,
        scope: h.scope,
        title: e?.title ?? h.title,
        body,
        source: h.source,
        line: e?.line ?? 1,
        score: h.score,
        snippet: body.replace(/^#+ .*\n/, "").slice(0, 240),
      };
    });
  }

  stats(): { kind: string; n: number }[] {
    const n = new Map<string, number>();
    for (const e of this.byId.values()) n.set(e.kind, (n.get(e.kind) ?? 0) + 1);
    return [...n].map(([kind, c]) => ({ kind, n: c })).sort((a, b) => b.n - a.n);
  }
}
