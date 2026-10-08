# batas Roadmap

Agreed with the user on 2026-10-07. Each item names the evidence that put it here; status is updated as items land.

## Priority 1

1. **Live-session collision guard** — before a state-changing git command, warn when another session is active in the
   same checkout. Evidence: on 2026-10-07 another session's push deployed a local commit to prod
   (memory `another-session-pushes-this-checkout`), `git add -A` swept another session's files, and an `index.lock`
   was held by a parallel process. Status: **done 2026-10-07** — hook log carries `repo`; a shared-checkout git command
   warns when another session touched the same root within 15 minutes. **Hardened the same day:** a warning alone
   let the command run and could not see an IDLE session's dirty files, so each session now records the files it
   writes, sweeping git commands are denied while another session's file is dirty, and `git push` is denied while
   another session is live — each with an acknowledged way through. Then: files changed by Bash commands and scripts
   are attributed through a PostToolUse hook (most edits here are scripted), and a file dirty since before the session
   started counts as not its work.
2. **Rule tiering from measured frequency** — rules reaching >30% of sessions belong always-on; always-on items that
   almost never fire move to inject-only. Evidence: `just rule-audit` shows C1/C4/B24 at 32–41% of sessions; the
   always-on corpus is the measured context cost. Status: **done 2026-10-07** — `just rule-audit` reports tiering; 11
   non-destructive items moved inject-only (71,220 -> 70,025 always-on bytes). Destructive items stay always-on even
   when rare, because a PreToolUse injection lands after the command has run; promotion was not worth its cost.
3. **Does an injection help** — after a rule is injected, does the agent still repeat the pattern it warns about?
   Evidence: today lessons:B14 fired after the `| head && echo` mistake had already been made once. Status: **done
   2026-10-07** — `just effect-audit`: B14 repeat rate 50% -> 19%, B20 82% -> 41%, B10 32% -> 9%, while situational
   controls (B8, C2, C4) stayed flat.

## Priority 2 — memory health

4. **Stale-memory audit** — flag memories naming files, symbols or ports that no longer exist (path checks plus
   GitNexus). Evidence: the shortening guide records a stale fact ("PIN must be unique") re-entering the always-on tier. Status:
   **done 2026-10-07 (paths)** — `just memory-audit`: 60 of 593 memories name 84 paths that git once tracked and no
   longer does, 41 of them with the file's new location from git's rename record. A plain exists() check called 540
   paths missing and was almost all false (server paths, skill-relative paths, gitignored dumps), so unprovable paths
   stay unjudged. Symbols and ports are not checked yet: a symbol needs each repo's GitNexus index and a port has no
   source of truth beyond `~/.claude/references/infra.md`.
5. **One shared memory instead of copies** — a memory used by several projects is stored once with a project list.
   Evidence: `just trigger-audit` found the same memory copied into 11 Brighty projects. Status: **done 2026-10-08** —
   `just memory-share`: one file in `~/.claude/memory/shared/`, each project's copy replaced by a relative symlink
   (read natively by Claude Code, batas and the mirror; a frontmatter `projects:` list was rejected because Claude Code
   would not load it). Copies must be identical or merged first. Measured: only 2 memories were copied (19 files);
   hegemoni-product-brand-domains had drifted into 3 versions across 9 projects, merged without conflict (one added
   the staging domain fact, one only had other triggers).
6. **Enforce rules-writer Step 5b at edit time** — a rules edit without its `triggers.toml` / `*-full.md` update warns
   immediately. Evidence: memory triggers needed a 586-file backfill because nothing enforced them from the start.
   Status: **done 2026-10-07** — a memory written without `triggers:` warns at the write; a family rule edit shows the
   checklist once per session; `status` lists always-on items without a full-text section (0 of 91 today).

## Priority 3

7. **Mine lessons from transcripts** — the same error fixed 3+ times across sessions becomes a drafted lesson with a
   trigger. Evidence: the learning loop in `~/.claude/CLAUDE.md` currently depends on an agent remembering to write it. Status:
   **done 2026-10-07** — `just lesson-mine [days] [min]`: failed tool calls paired with their commands, grouped by a
   normalized error line, checked against the triggers with lift (a rule firing on every git command explains no git
   error). 723 sessions / 30 days: 57 signatures in 3+ sessions, 39 with no rule (drafts), 18 repeating despite one.
   It found lessons:B29 blind to every multi-line `python3 -c` (16 sessions; `.*` stops at a newline), fixed in
   triggers.toml. Top drafts awaiting rules-writer: zsh `echo =====` (46 sessions), `grep` aliased to rg rejecting
   `\|` (10), unquoted `--include=*.go` globbing in zsh (18 across extensions), `cd backend` from the wrong cwd (15).
8. **Context budget per session** — a ceiling on bytes batas may inject into one session. Status: **done 2026-10-07** —
   measured first from transcript attachments over 7 days: 236 sessions, p50 2.5 KB, p90 19.6 KB, max 36 KB injected
   (PreToolUse 1.45 MB of the 1.52 MB total). A tight cap would cut real rules to save little, so the budget is a 64 KB
   ceiling above every observed session: past it a rule or memory is named once instead of injected. Every hook call
   now logs `bytes`, and `status` reports per-session p50/max against the budget.
9. **Audit rule `prompt` triggers against prompt history** — `trigger-audit` covers memories only. Status: **done
   2026-10-07** — `just prompt-audit` replays 15,379 real prompts through each phrase via the hook's own matcher. Two
   fixes came out of it: gotcha:D2 listed on 372 prompts (2.4%) through the bare words `tiktok`/`tokopedia`/`affiliate`,
   of which about 30 were about pacing a loop, so it now fires on throttling words only; and rule phrases were matched
   against quoted lines and side-agent notes while memory recall was not, so both now read the user's own words.
   Prompts listing any rule: 11.4% -> 9.4%. The remaining top phrases (`handover`, `deploy`, `xlsx`) are on-topic for
   their rules and stay. 58 prompt-only rules were never reached by any prompt; reported, not changed.

## Priority 4 — learning loop (approved 2026-10-08)

Plan: `docs/plan/2026-10-08-learning-loop/plan.md`. Evidence: in one mendadak-pos session the user repeated the same
correction four times, 2 of 8 paraphrased recall probes missed content that was present, and nothing stopped a 780 KB
raw dump into `docs/lessons/`.

10. **Correction capture** — a correction in the user's own words injects "record this" and the Stop hook blocks once
    if no `record` followed. Status: planned.
11. **Content contract** — rule + `just lessons-lint` + a hook denying dump-shaped writes into `docs/lessons/`.
    Status: planned.
12. **Semantic recall** — local multilingual embeddings fused with BM25 in the MCP server; eval 6/8 → target ≥ 7/8.
    Status: planned.

## Priority 4 — from the 2026-10-08 rebuild (lessons by location, semantic recall)

10. **Semantic recall with two fused models** — the user requires semantic search, good in Indonesian AND English.
    Measured on 40 mendadak-pos lessons x blind EN/ID paraphrases (top-3): BM25 18/33; me5-small+bge-m3 RRF 30/30
    (60 vs 51); Indonesian-only LazarusNLP models weak on this technical text. **Chosen: EmbeddingGemma 2 text-only +
    multilingual-e5-small, RRF — EN 35/40, ID 36/40.** Plan: docs/plan/2026-10-08-semantic-recall/plan.md (warm Python
    daemon, LanceDB, SQLite FTS removed). Status: designed and measured, not built.
11. **Resolve `Simbol:` through the GitNexus graph instead of a declaration regex** — Graphify's design point is a
    deterministic tree-sitter AST pass; GitNexus already holds that AST graph here (one owner per concern, see the
    2026-08-12 rejection of Graphify as a GitNexus duplicate), so lessons-route should ask it, not re-parse.
12. **Provenance on every route** — Graphify tags each edge EXTRACTED or INFERRED. A routed lesson should say whether
    its file link is a declared symbol (exact) or an owner/field fallback (inferred), so a doubtful route is visible.
13. **Per-repo lesson map report** — Graphify's GRAPH_REPORT.md equivalent: files carrying the most lessons, lessons
    that route nowhere (264 in mendadak-pos), stale routes, delivery-eval history.

Graphify itself was re-checked 2026-10-08 (v0.9.80): still "Not a vector index. No embeddings", a codebase graph
that duplicates GitNexus; it does not replace batas, which carries lessons, rules and preferences, not code structure.
