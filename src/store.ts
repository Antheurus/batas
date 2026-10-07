import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";
import { allSources, type Source, type Entry, type Kind } from "./corpus.ts";

const LINK_TO = /_linked to (\S+?) of ([A-Z]\d+)_/g;
const WIKI = /\[\[([^\]]+)\]\]/g;

export type Hit = Entry & { score: number; snippet: string };

export class Store {
  readonly db: Database;

  constructor(file = config.indexFile) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA busy_timeout = 3000");
    this.db.run(`CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, mtime REAL NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL, source TEXT NOT NULL, line INTEGER NOT NULL)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS entries_source ON entries(source)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS links (src TEXT NOT NULL, dst TEXT NOT NULL, kind TEXT NOT NULL)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS links_src ON links(src)`);
    // Without it the hook's first memory read scanned the whole 112 MB entries table, ~150 ms on every prompt.
    this.db.run(`CREATE INDEX IF NOT EXISTS entries_kind_scope ON entries(kind, scope)`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
      id UNINDEXED, title, body, tokenize = 'porter unicode61')`);
  }

  refresh(scope: "rules" | "all" = "all", extra: Source[] = []): { changed: number; removed: number } {
    const sources = [...allSources(scope), ...extra];
    const known = new Map<string, number>(
      (this.db.query("SELECT path, mtime FROM files").all() as { path: string; mtime: number }[]).map((r) => [
        r.path,
        r.mtime,
      ]),
    );
    const seen = new Set<string>();
    let changed = 0;

    const tx = this.db.transaction(() => {
      for (const src of sources) {
        seen.add(src.file);
        let mtime: number;
        try {
          mtime = statSync(src.file).mtimeMs;
        } catch {
          continue;
        }
        if (known.get(src.file) === mtime) continue;
        this.dropSource(src.file);
        let entries: Entry[] = [];
        try {
          entries = src.parse();
        } catch (err) {
          console.error(`batas: failed to parse ${src.file}: ${String(err)}`);
        }
        for (const e of entries) this.insert(e);
        this.db.run("INSERT OR REPLACE INTO files (path, mtime) VALUES (?, ?)", [src.file, mtime]);
        changed++;
      }
    });
    tx();

    let removed = 0;
    if (scope === "all") {
      const gone = [...known.keys()].filter((p) => !seen.has(p));
      this.db.transaction(() => {
        for (const path of gone) {
          this.dropSource(path);
          this.db.run("DELETE FROM files WHERE path = ?", [path]);
          removed++;
        }
      })();
    }
    return { changed, removed };
  }

  private dropSource(path: string) {
    const ids = this.db.query("SELECT id FROM entries WHERE source = ?").all(path) as { id: string }[];
    for (const { id } of ids) {
      this.db.run("DELETE FROM fts WHERE id = ?", [id]);
      this.db.run("DELETE FROM links WHERE src = ?", [id]);
    }
    this.db.run("DELETE FROM entries WHERE source = ?", [path]);
  }

  private insert(e: Entry) {
    this.db.run("DELETE FROM fts WHERE id = ?", [e.id]);
    this.db.run(
      "INSERT OR REPLACE INTO entries (id, kind, scope, title, body, source, line) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [e.id, e.kind, e.scope, e.title, e.body, e.source, e.line],
    );
    this.db.run("INSERT INTO fts (id, title, body) VALUES (?, ?, ?)", [e.id, e.title, e.body]);
    for (const m of e.body.matchAll(LINK_TO)) {
      this.db.run("INSERT INTO links (src, dst, kind) VALUES (?, ?, 'linked_to')", [e.id, `${m[1]}#${m[2]}`]);
    }
    for (const m of e.body.matchAll(WIKI)) {
      this.db.run("INSERT INTO links (src, dst, kind) VALUES (?, ?, 'wiki')", [e.id, m[1] ?? ""]);
    }
  }

  get(id: string): Entry | undefined {
    const row = this.db.query("SELECT * FROM entries WHERE id = ?").get(id) as Entry | null;
    if (row) return row;
    const loose = this.db
      .query("SELECT * FROM entries WHERE id LIKE ? ORDER BY length(id) LIMIT 1")
      .get(`%${id}%`) as Entry | null;
    return loose ?? undefined;
  }

  memories(scope: string): Entry[] {
    return this.db.query("SELECT * FROM entries WHERE kind = 'memory' AND scope = ?").all(scope) as Entry[];
  }

  memoryTitlesOutside(scope: string): Pick<Entry, "id" | "scope" | "title">[] {
    return this.db
      .query("SELECT id, scope, title FROM entries WHERE kind = 'memory' AND scope != ?")
      .all(scope) as Pick<Entry, "id" | "scope" | "title">[];
  }

  links(id: string): { dst: string; kind: string }[] {
    return this.db.query("SELECT dst, kind FROM links WHERE src = ?").all(id) as { dst: string; kind: string }[];
  }

  search(query: string, opts: { kinds?: Kind[]; scope?: string; limit?: number } = {}): Hit[] {
    const terms = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((t) => t.length > 1);
    if (!terms.length) return [];
    const match = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    const where: string[] = ["fts MATCH ?"];
    const params: (string | number)[] = [match];
    if (opts.kinds?.length) {
      where.push(`e.kind IN (${opts.kinds.map(() => "?").join(",")})`);
      params.push(...opts.kinds);
    }
    if (opts.scope) {
      where.push("(e.scope = 'global' OR e.scope = ?)");
      params.push(opts.scope);
    }
    params.push(opts.limit ?? 8);
    const rows = this.db
      .query(
        `SELECT e.*, bm25(fts, 0, 4.0, 1.0) AS score,
                snippet(fts, 2, '[', ']', ' … ', 24) AS snippet
         FROM fts JOIN entries e ON e.id = fts.id
         WHERE ${where.join(" AND ")}
         ORDER BY score LIMIT ?`,
      )
      .all(...params) as Hit[];
    return rows;
  }

  stats(): { kind: string; n: number }[] {
    return this.db.query("SELECT kind, count(*) AS n FROM entries GROUP BY kind ORDER BY n DESC").all() as {
      kind: string;
      n: number;
    }[];
  }

  close() {
    this.db.close();
  }
}
