# batas semantic recall — two fused local models, a warm daemon, SQLite FTS removed

## The ask (user, 2026-10-08)

"gua nggk mau search by regex. harus semantik. itu wajib. kalo emang sqlite nggk bisa BUANG." Must be good in Indonesian
AND English, "pakai 2" (two models). Text only, no multimodal ("jauh lebih murah"). Knowledge search goes semantic;
the safety guards (collision guard on git push / add -A) stay deterministic because they are not search — stated to
the user, not objected to.

## Measured (evals/semantic-compare.py, evals/semantic-probes.json)

40 random mendadak-pos lessons, each with one English and one casual-Indonesian query written blind (no title words),
824-lesson corpus, right lesson in top 3:

| Model(s) | EN top-3 | ID top-3 | Load (warm cache) | Query |
|---|---|---|---|---|
| BM25 FTS5 (today) | 18 | 33 | — | — |
| multilingual-e5-small | 27 | 24 | 9 s | 1 ms |
| bge-m3 | 27 | 29 | 10 s | 5 ms |
| me5-small + bge-m3 (RRF) | 30 | 30 | | |
| LazarusNLP indo-e5 / indobert (Indonesian-only) | 21 / 4 | 18 / 10 | | weak on technical text |
| EmbeddingGemma 2, text-only | 32 | 34 | 7.8 s | 8 ms |
| **EmbeddingGemma 2 + me5-small (RRF k=60)** | **35** | **36** | | |

Decision: `google/embeddinggemma-2` loaded text-only (`config_kwargs={"vision_config": None, "audio_config": None}`,
740M -> 270M params; needs `sentence-transformers[image]>=6.1` — the `[audio]` extra fails to build kenlm here) with
`prompt_name="SearchQuery"` / `"Document"`, fused by reciprocal-rank fusion with `intfloat/multilingual-e5-small`
(`query: ` / `passage: ` prefixes). Caveat: the Indonesian gain over BM25 is +3/40; English is +17/40.

## Design

- **batasd** — a Python daemon (uv, sentence-transformers on MPS) holding both models warm, started on demand by the
  hook/MCP when its unix socket (`~/.batas/batasd.sock`) is absent, exits after N idle minutes. Cold load ~10 s, so the
  first call of a day may miss its budget: the hook then answers without memory/lesson recall rather than block, and
  logs it.
- **Store** — LanceDB (embedded, no server) table: id, kind, scope, title, body, source, mtime, content hash, one vector
  column per model. Incremental by content hash; SQLite and its FTS go (user: drop it if it cannot do semantic).
  sqlite-vec was not chosen: the system SQLite on macOS refuses extensions, and nothing else needs SQLite.
- **Search** — query embedded by both models, cosine top-50 each, RRF k=60, optional kind/scope filter. Used by
  `recall`, `check`, prompt -> memory/rule matching in the hook (replacing trigger-word matching for memories), and
  lesson lookup for files with no routed rule.
- **Hook path** — the hook (bun) asks the daemon over the socket with a 150 ms budget; latency gate in tests.
- **Kept** — path-scoped lesson routing (lessons-route), Bash lesson injection, collision guard, budget.

## Acceptance

1. `evals/semantic-compare.py` numbers reproduced by the daemon's own search: EN >= 35, ID >= 36 on the 80 probes.
2. Hook prompt path p95 <= 150 ms with the daemon warm; a cold daemon never blocks the prompt.
3. `just delivery-eval` unchanged (read/bash/python 15/15); behavior eval re-run.
4. MCP `recall`/`get` survive a daemon restart and an index rebuild (the v0.15.2 class).

## Order

1. Daemon + store + incremental index; reproduce the eval numbers through it (acceptance 1).
2. MCP recall/check on the daemon; remove FTS.
3. Hook prompt path: memories and rules by semantic match; retire trigger-word matching once the prompt eval
   (just trigger-audit / prompt-audit replaced by a semantic hit-rate replay) shows no loss.
4. Latency gate, cold-start behavior, docs, changelog.

## Built (2026-10-08) — where it departs from the design above, and why

- **LanceDB holds only vectors and the ids that key them.** Measured first: the whole corpus (7,990 entries, 14 MB)
  parses from its markdown in ~265 ms and the rules alone in ~8 ms, so the hook parses what it needs per call and the
  MCP server keeps everything in memory, re-parsing a file when its mtime moves. No second copy of the text exists to
  drift, and there is no shared database file for a live session to lose (the v0.15.2 "disk I/O error" class is gone
  by construction, not by a reopen guard). SQLite is not used anywhere.
- **batasd pulls the corpus itself** by running `src/export.ts` (the TypeScript parsers, one JSON line per entry with a
  sha1) at start, every 120 s, and when the MCP server writes a memory. It re-embeds only changed hashes and persists
  every 512 rows, so an interrupted first index keeps what it paid for.
- **Encode lock per 16 documents**, so a search arriving during a full index waits one small batch, not a chunk.
- **The hook keeps trigger words as the fallback** whenever batasd does not answer inside the prompt budget, and logs
  `semantic: warm|cold` per prompt. Trigger-word matching is retired only after `just semantic-calibrate` shows
  semantic reaches what it reaches.
- **Command, file and code triggers stay regex** (decided with the user 2026-10-08; memory
  `batas-command-file-triggers-stay-regex`). Semantic covers recall, check, prompt -> memory/rule/lesson matching.
- **Worktree sessions resolve to the main repo** (`repoName`), since the corpus is indexed from the main checkout.
