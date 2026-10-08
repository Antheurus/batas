# batas learning loop — correction capture, semantic recall, content contract

Approved by the user 2026-10-08 (all three). Written at the end of a mendadak-pos session that measured where batas
fell short; build it in a fresh session, one item at a time, each with its eval before and after.

## Evidence (2026-10-08, mendadak-pos comment cleanup)

- The user had to repeat the same correction four times in one session ("simpan ke batas", "jangan sampai ilang",
  "bukan arsip mentah", "kok gua bilang mulu") because nothing turns a correction into a memory unless the agent
  remembers to. Recorded by hand at the end as memory `knowledge-moved-to-batas-distilled-not-dumped`.
- Recall is lexical (FTS5 `porter unicode61`, `bm25(fts, 0, 4.0, 1.0)` in `src/store.ts`). 8 paraphrased probes against
  the newly distilled `docs/lessons/*.md`: 6 found the intended entry in the top 3; the misses were "poin redeem
  diskonnya kebesaran" (entry says "menggandakan diskon redeem 5,5x") and the English "card payment more than the bill
  total" (entry is Indonesian). Content was present; vocabulary did not match.
- Nothing stopped an agent from writing 780 KB of raw removed comments into `docs/lessons/` (one section per
  file/declaration, including comments deleted because they were false). No rule says what shape batas content takes.
- Regex triggers misfired on agents' text (B11 on "assert ... not in", B4 on "WITH … UPDATE" inside a comment, A6 on
  the path `navRegistry`); 4 of 7 worktree agents saw no injection at all.

## Full surface

### 1. Correction capture
- **Detect** a correction in the user's OWN words (reuse the prompt matcher that already strips quotes and side-agent
  notes): Indonesian and English shapes — `kok (gua|gue|aku) (bilang|ngomong) (mulu|terus)`, `udah (gua|gue) bilang`,
  `kan (harusnya|seharusnya)`, `harusnya (jadi )?default`, `jangan .{0,40} lagi`, `I (already )?told you`,
  `why do (I|you) keep`, `stop doing`. Tune on the 15,379-prompt history with `just prompt-audit` before shipping;
  report precision on a hand-labelled sample of 50 hits.
- **UserPromptSubmit**: on a hit, inject additionalContext: the user just corrected you; restate the correction in one
  line and record it with `mcp__batas__record` (type feedback, `triggers` required) before continuing.
- **Stop**: if the turn carried a correction flag and the transcript shows no `mcp__batas__record` (or memory file
  write) since that prompt, block ONCE with the reason; honour `stop_hook_active` (gotcha E17).
- Eval: replay today's session prompts; the four corrections must each produce one recorded memory, zero on the
  non-correction prompts.

### 2. Semantic recall — SUPERSEDED 2026-10-08

Built instead as semantic-only search (no BM25 fusion, no BM25 fallback; the user requires semantic search):
`docs/plan/2026-10-08-semantic-recall/plan.md`, v0.16.0. The text below is the original proposal, kept as history.

- **Embedding**: local, multilingual (Indonesian + English), no API key. Recommended: `multilingual-e5-small`
  (384 dims) through `@huggingface/transformers` in bun; vectors stored as Float32 BLOBs in the existing sqlite;
  brute-force cosine over all entries (~10k × 384 is well under 50 ms).
- **Where**: computed at `reindex` (incremental by content hash), queried in the MCP server (`recall`, `check`), which
  stays warm. **Not in the hook path**: each hook is a fresh bun process and a cold model load costs seconds; revisit
  only with a measured warm daemon.
- **Ranking**: reciprocal-rank fusion of BM25 and cosine; keep BM25 alone as the fallback when the model is missing.
- Eval set: today's 8 probes plus 20 more written as an agent would type them (half English against Indonesian
  entries). Baseline 6/8 top-3; target ≥ 7/8 and the English probe found. Report latency p50/p95 for recall.

### 3. Content contract
- **Rule** (through rules-writer, global): what goes into a batas-read home — one entry per mistake; title = the trap
  plus the symptom words people type (Indonesian and English) plus the symbol; a `Simbol:` line verified against
  current code; no raw dumps, no per-file comment archives; git history and session scratch are not storage.
- **Checker** `just lessons-lint <repo>`: entries without `Simbol:`, entries over ~3,000 chars (BM25 length penalty),
  duplicate titles, headings shaped `## <path> · <declaration>` (dump detector), and a large batch of sections added
  in one write.
- **Hook**: a Write/Edit into `docs/lessons/` that adds the dump shape or 20+ sections at once is denied with the
  contract; prove it on the 2026-10-08 raw archive (must deny) and the distilled files (must allow).

## Shipping order (proposed cut)
1 → 3 → 2. Correction capture is the user's top complaint and cheap; the contract stops new damage; semantic recall is
the largest change and benefits from content already in the right shape.

## Open
- Model choice and disk/cold-start budget for semantic recall (e5-small ≈ 120 MB); whether a warm daemon is worth it
  so the hook path also gets semantic matching.
- Whether a correction hit should DENY the next tool call (stronger) or only block at Stop (current proposal).
