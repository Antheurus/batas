# batas Roadmap

Agreed with the user on 2026-10-07. Each item names the evidence that put it here; status is updated as items land.

**The `Priority N` headings are batches in the order they were agreed, not a ranking**: Priority 5 sits above 4 because
it was approved later, and 6 and 7 are simply the next batches. Item numbers are permanent addresses. Rank comes from
placement: an open item judged urgent is moved into Priority 1 with the date and reason, as item 19 was.

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

19. **Hooks read batas's file attribution before the transcript** (raised from Priority 7 on 2026-10-11: a live defect,
    hooks blocking on work that exists, and cheap since batas already holds the data; background in Priority 7) — batas already records every file a session
    changes, through Edit/Write and through Bash commands and scripts (`~/.batas/sessions/`, the PostToolUse
    attribution behind the git collision guard), from the filesystem rather than the transcript.
    `progress-changelog-reminder` and `rules-memory-reminder` read that record first and fall back to the transcript
    scan when it is absent. Closes E21 and E23 in every session, `claude -p` included, with no mod. Status: **done
    2026-10-11** — both hooks union `batas_touched(session_id)` with their transcript scan (a corrupt or missing state
    file adds nothing). Tests: new `tests/test-progress-changelog-reminder.py` 8/8 (3 fail on the old hook) and
    `test-rules-memory-reminder.py` 21/21 (2 new fail on the old hook). Replaying this session's real transcript with
    cwd=batas: the old hook blocks on both docs, already written through python and committed; the new one passes.
    Limit: batas attributes a Bash write only while the file is dirty after the call, so a write committed in the same
    command is still unseen, and a file another session writes during the call can be attributed here too.

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

## Priority 5 — learning loop (approved 2026-10-08; numbered 14-16 so it never collides with items 10-13 below)

Plan: `docs/plan/2026-10-08-learning-loop/plan.md`. Evidence: in one mendadak-pos session the user repeated the same
correction four times, 2 of 8 paraphrased recall probes missed content that was present, and nothing stopped a 780 KB
raw dump into `docs/lessons/`.

14. **Correction capture** — a correction in the user's own words injects "record this" and the Stop hook blocks once
    if no `record` followed. Status: planned.
15. **Content contract** — rule + `just lessons-lint` + a hook denying dump-shaped writes into `docs/lessons/`.
    Status: planned.
16. ~~**Semantic recall** — local multilingual embeddings fused with BM25 in the MCP server.~~ Status: **superseded
    2026-10-08** by item 10: the user requires semantic search only ("harus semantik, itu wajib"), so BM25 is not
    fused in anywhere; it survives only as the baseline the evals compare against. Do not rebuild it.

## Priority 4 — from the 2026-10-08 rebuild (lessons by location, semantic recall)

10. **Semantic recall with two fused models** — the user requires semantic search, good in Indonesian AND English.
    Measured on 40 mendadak-pos lessons x blind EN/ID paraphrases (top-3): BM25 18/33; me5-small+bge-m3 RRF 30/30
    (60 vs 51); Indonesian-only LazarusNLP models weak on this technical text. **Chosen: EmbeddingGemma 2 text-only +
    multilingual-e5-small, RRF — EN 35/40, ID 36/40.** Plan: docs/plan/2026-10-08-semantic-recall/plan.md (warm Python
    daemon, LanceDB, SQLite FTS removed). Status: **done 2026-10-08 (v0.16.0)** — same-corpus EN 35 / ID 36; repo-wide
    knowledge EN 27 / ID 31 against BM25 10 / 31; batasd always on via launchd. Results in the plan's "Built" section.
11. **Resolve `Simbol:` through the GitNexus graph instead of a declaration regex** — Graphify's design point is a
    deterministic tree-sitter AST pass; GitNexus already holds that AST graph here (one owner per concern, see the
    2026-08-12 rejection of Graphify as a GitNexus duplicate), so lessons-route should ask it, not re-parse.
12. **Provenance on every route** — Graphify tags each edge EXTRACTED or INFERRED. A routed lesson should say whether
    its file link is a declared symbol (exact) or an owner/field fallback (inferred), so a doubtful route is visible.
13. **Per-repo lesson map report** — Graphify's GRAPH_REPORT.md equivalent: files carrying the most lessons, lessons
    that route nowhere (264 in mendadak-pos), stale routes, delivery-eval history.

## Priority 6 — from Command Code Taste (compared 2026-10-09)

Taste (`commandcode.ai/docs/taste`) is the opposite half of the loop: it writes automatically (every accept, reject
and edit is a signal, classified by a hosted `taste-1` model) and reads back a whole style profile on every turn.
batas writes deliberately and reads only on a trigger. Two of its write-side ideas fit here.

17. **Silent correction capture** — extends item 14, which only hears a correction the user says out loud. The more
    common correction is unspoken: the user edits lines the agent just wrote. The PostToolUse hook already records the
    files each session writes, so a later change to those lines by the user (or by a Bash command outside any
    session) within N minutes is a cheap signal to suggest a `record`. It drafts, never writes a memory on its own.
    Evidence: Taste treats "correction diffs from your commits" as its strongest signal; batas has no write path
    that does not depend on someone noticing. Status: planned.
18. **Conflict check when a memory is written** — `record` searches the closest entries only for `type: "lesson"`
    (`src/mcp.ts`); a `user`/`feedback`/`project`/`reference` memory is written with no look at what already says the
    same or the opposite, and refuses only on an identical name. Run the same semantic search for memories and return
    the top matches with the write, so a duplicate or contradiction is visible at the moment it is made (Taste: "flags
    the conflict" instead of overwriting). Status: planned.

Not taken: confidence scores (batas memories are curated, not inferred, so there is nothing to score), a hosted
classifier (everything here stays local), and a public share registry (the mirror is private by design). Taste also
loads its profile on every turn, the always-on cost the 2026-10-07 tiering work exists to cut.

## Priority 7 — transcript blind spots (agreed 2026-10-09; item 19 moved to Priority 1)

The doc/rules/task Stop hooks in `~/.claude/hooks/` judge a session by scanning its transcript, and four recorded
blind spots come from that: E21 (an edit made through Bash or `python -c` is invisible, only Edit/Write is seen), E23
(its generated-file variant, cleared today with a byte-identical rewrite), E22 (a long session's calls span several
transcript files, so one file is a partial record and a hook can block forever) and E25 (the wrong session picked by
mtime, usage over-counted). Checked against the Claude Code mods API on 2026-10-09: a mod's `tool.call` sees every call
live, subagents included (`agentId`), but for Bash it sees the command, not which files changed, so it fixes E22/E25
and not E21/E23.

20. **Optional mod ledger for E22/E25** — a thin function-hooks mod appends every `tool.call` (main and subagent) to a
    per-session file the hooks read, with the transcript as fallback. It follows the split recorded on 2026-10-07
    (memory `mods-deferred-until-stable`): enforcement stays in the Python hooks, and a mod that is not loaded only
    brings the blind spots back for that session. Regenerate the types with `/plugin-types` first; the ones read on
    2026-10-09 date from 2026-10-07. Reuses the task-store reader of the shelved `task-band`. Status: deferred until
    item 19 lands and a blind spot is still seen.

Graphify itself was re-checked 2026-10-08 (v0.9.80): still "Not a vector index. No embeddings", a codebase graph
that duplicates GitNexus; it does not replace batas, which carries lessons, rules and preferences, not code structure.
