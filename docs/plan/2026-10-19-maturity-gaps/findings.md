# Findings — batas maturity gaps

## 2026-10-19 — planning session (cc-toriq f489f00b, written retrospectively)

- No phase dispatched. The plan was written directly from measurements already taken in the session (see
  `docs/plan/2026-10-19-maturity-gaps/research.md`) instead of an od-plan Explore fan-out, because the session was at
  406k tokens and the user asked for plan-then-handover.
- Roadmap Priority 8 (items 21-28) landed in `docs/roadmap.md` (commits 6222b6e, 6623fc3).
- Same session, already landed and relevant to Phase 1: lessons A1 left `~/.claude/rules/lessons.md` for the
  compact-percentage mod; its `["lessons:A1"]` trigger was removed by hand and `tests/batas.test.ts` moved 136 -> 135
  (eef21b3). That hand edit is the exact defect item 23 removes.

## 2026-10-19 — Phase 01 orphan gate + derived counts (resume session)

- Bucket SHIPPED-UNVERIFIED, commit d19c342, 1 of 3 attempts, sonnet, 118 s. Orchestrator re-ran `just check`: 100 pass, 0 fail.
- `orphanTriggerIds(triggers, ids)` exported from src/mcp.ts; `countFamilyItems(dir, family)` in src/corpus.ts reuses `parseFamily`.
  Hard-coded 157/135 gone. Falsified: fake `lessons:Z99` in a temp triggers.toml went red naming it; a fixture with one item
  removed counted 67 -> 66.
- Deviation: `status` now compares against every entry id, not only kind=rule, because the old comparison reported a
  `project:mendadak-pos:lessons/backend.md#…` trigger as an orphan though it resolves (a real false positive in production).
- Discovered: `project:` trigger ids cannot be checked in `just check` (the sandbox has no project repos); only `status` sees them.
- User decision mid-phase: keep the id format as is (no random 4-char ids). Added Phase 01b: a retired-id list so a gap's number
  is never reused (the one hole no gate covered). Dispatched.

## 2026-10-19 — Phase 01b retired-id guard

- Bucket SHIPPED-UNVERIFIED, batas 3d61720, cc-toriq mirror 772bf78 (`just verify` 3946/3946), 1 attempt, sonnet, 147 s.
  `just check` 103 pass. `~/.claude/batas/retired-ids.txt` seeded with the only gap in the corpus, `lessons:A1`
  (gotcha 157 items, no gap; lessons 135, A1 missing). Falsified both ways against a temp HOME: reuse of A1 red, an
  unrecorded removal of A3 red naming it and pointing at retired-ids.txt.
- Known limit: deleting the LAST item of a section leaves no visible gap; only the orphan-trigger gate catches it, and
  only when that item had a trigger.
- Roadmap item 29 now carries the delete-candidate gates (trigger exists, fixture fires, not destructive, zero situations).

## 2026-10-19 — Block 1 audit (sonnet, 333 s) — RECEIPT, 2 findings

RECEIPT — Batch, Phases 01 and 01b (d19c342, 3d61720)
- src/corpus.ts `readRetiredIds`, the `.replace(/#.*$/, "")` line — a CRLF line with a comment keeps its comment (`.` does
  not match `\r`), so `"lessons:A1  # x"` is returned, never equals a real id, and reuse test (a) passes silently.
  failing check: `printf 'lessons:A1  # x\r\n' > $S/r.txt; bun -e 'import {readRetiredIds} from "./src/corpus.ts"; console.log(JSON.stringify(readRetiredIds(process.argv[1])))' $S/r.txt` → expected `["lessons:A1"]`; actual `["lessons:A1  # x"]`.
- tests/batas.test.ts:54-57 zero-orphan test passes vacuously when triggers.toml is missing (`Triggers.load`,
  src/triggers.ts:137, returns an empty set with no error); same silent mode for a missing retired-ids.txt.
  failing check: `BATAS_TRIGGERS=/nonexistent/x.toml bun test 2>&1 | grep -E "pass|fail"` → expected a failure naming the missing triggers file; actual 0 fail.
- Informational probes: malformed lines (`not-an-id`, lowercase `lessons:a1`) are returned verbatim and match nothing, silently.
Clean on spec: all-entry-id comparison cannot hide a gotcha/lessons orphan; familyGaps per section correct.
Audit worktree removed (no test files to salvage). Receipt folded into a fix dispatch before Block 2.

## 2026-10-19 — Block 1 receipt fix (2dedee6, sonnet, 153 s, 1 attempt) — re-check clean

- `readRetiredIds` splits on `/\r?\n/`; new tests: triggers file and retired-ids file exist and load ids; every retired line
  matches `^(gotcha|lessons):[A-Z]\d+$`. Runtime stays lenient (Triggers.load and src/install.ts unchanged), only the gate is strict.
- Re-check run by the orchestrator on the main tree, every receipt check: CRLF comment -> `["lessons:A1"]`; `BATAS_RETIRED_IDS`
  -> a file holding `not-an-id` -> `malformed line in …: not-an-id`, 104 pass 2 fail; real files `just check` 106 pass 0 fail.
  Executor: missing retired-ids -> `retired-ids file missing`; missing triggers (writable path) -> `triggers file loaded no ids`.
  The re-check was done by the orchestrator running the receipt's own checks, not a second auditor dispatch.
- Executor ran a `git stash` mid-diagnosis that briefly took this file; popped at once, `git stash list` empty, content intact.
- Discovered: src/install.ts creates an empty triggers.toml at import when none exists; that is why a missing file degraded to empty.
- Block 1 DONE: Phase 01 VERIFIED-LIVE through `just check` + falsifications on temp copies.

## 2026-10-19 — Phase 02 triggers + moves (opus, 899 s, 1 attempt) — SHIPPED-UNVERIFIED, audit in flight

- batas 177548c (docs v0.21.0), cc-toriq mirror 9811540 (8 paths by name; another session's dirty infra.md left out).
- 18 of 28 untriggered items got cmd/path/code triggers (regexes replayed against 14 days of real calls before writing; five
  first drafts narrowed, e.g. B49 on `lsof -sTCP:LISTEN` hit 31.5% of sessions). 10 stay every-turn: gotcha A4 A5; lessons
  A2 A3 A5 A6 B2 B17 B23 F2 (the hook never sees their moment: design judgement, Agent/WebFetch calls, tool output).
- Of the 20 rare items: moved gotcha E37 E36 A2 A7 A10 A1, lessons C10 C14; split lessons H6; kept as destructive lessons B37
  B47 E10 C12 C15 E9, gotcha B11 E11 B10; kept as every-turn lessons B1, gotcha C10.
- Always-on 72,644 -> 70,789 B (-1,855; lessons.md 19,709 -> 19,323, gotcha-coding.md 9,501 -> 8,013). Smaller than the 7,363 B
  ceiling because most of the rare bytes are destructive. Ids 292 -> 292, none lost; `just check` 106 pass.
- Deviation: seven newly triggered items under 2% (lessons B49 F3 H4 A4, gotcha A11 C6 A9) kept always-on until Phase 4 measures them.
- Discovered (pre-existing, not touched): gotcha-full.md B2 `_linked from` still names gotcha-coding.md; lessons:C12 regex
  never fired in 14 days; lessons C1 C4 B24 noisy (2.0-2.8% of calls); `_negative` Button.tsx fires lessons:G2.

## 2026-10-19 — Block 2 audit (sonnet, 273 s) — RECEIPT, 2 findings + 1 observation folded in

RECEIPT — Phase 2 (cc-toriq 9811540, batas 177548c)
- claude-home/batas/triggers.toml `["lessons:C8"]` (~line 1177): new cmd matches only `git worktree list`; `git worktree add`
  and `git worktree remove` (the risky moments) do not fire it.
  failing check: `cd batas && bun -e 'import {Triggers} from "./src/triggers"; const t=Triggers.load(); for (const c of ["git worktree add ../x HEAD","git worktree remove ../x"]) console.log(c, t.match({cmd:c}).some(m=>m.id==="lessons:C8"))'` → expected `true` for both; today `false`.
- claude-home/rules/p-lessons-injected.md (C10, C14) + `["lessons:C14"]`: both protect another session's uncommitted work
  (destructive per the brief) but were moved inject-only; their triggers cover `git add -p`, `git apply --cached`,
  `git update-index --cacheinfo`, not a plain `git add <file>` on a path another session left dirty.
  failing check: `bun -e 'import {Triggers} from "./src/triggers"; const t=Triggers.load(); console.log(t.match({cmd:"git add docs/progress.md"}).some(m=>["lessons:C14","lessons:C10"].includes(m.id)))'` → expected `true`; today `false`.
- Observation: gotcha E36's "a guard or hook that delegates to a shared server must do the work itself when the server does
  not answer" clause left the always-on file; editing a hook does not fire its triggers.
Clean elsewhere: no moved item is credential/production/email/webcam; ids 292; routing and links resolve; no new trigger
fires on git status, ls, bun test, git log -1, git diff, docker ps.

Orchestrator decision on the fix: C10/C14 go BACK always-on (widening to every `git add` would be the noisiest rule in the
corpus); C8 gains add/remove; E36 returns to the mother as a short item carrying the guard clause, one owner.

## 2026-10-19 — Block 2 receipt fix (batas ae51de9, cc-toriq d2ef797, sonnet, 125 s, 1 attempt) — re-check clean

- C8 now `git worktree (list|add|remove)` with add/remove fixtures; C10 + C14 back in lessons.md section C with their
  pre-Phase-2 wording; E36 back in gotcha-coding.md as a one-sentence stub carrying the guard clause (one owner, slice copy removed).
- Orchestrator re-ran every receipt check on the live files: C8 add/remove both `true`; `do the work itself` 1 line in
  gotcha-coding.md, 0 `36.` in the slice; C10/C14 present in lessons.md §C; `just check` 106 pass 0 fail; corpus-lint 0 failures.
- Always-on after Phase 2 + fix: 71,637 B (from 72,644; -1,007 net). Ids 292.
- Deviation: commit-body-guard rejects an `od(...)` subject (not a conventional type); fix commits use `fix(od-…)`.
- Block 2 DONE.

## 2026-10-19 — Phase 03 split into 3A (batas) and 3B (rule files); Phase 03A (opus, 458 s, 1 attempt) — SHIPPED-UNVERIFIED, audit in flight

- Split reason: one dispatch would have changed the shared parser and 11 always-on files at once; 3A lands and is audited
  with zero rule edits, so 3B is pure content against a proven contract.
- a78bf02: prefix map in src/config.ts (cs dod ver ui bduf gnx bf prim pc cm py); `parseFamily` extended (unlettered
  families), full text home `~/.claude/references/rules-full/<file>`; every Phase 1 gate reads prefixes from config.
  113 tests pass. Hook p50 37.5-38.7 -> 38.7 ms (+1.6%). impact HIGH on parseFamily/familyOf/globalSources/allSources/fullText/render.
- Deviation: a file counts as converted only when it carries `<!-- batas:numbered -->` (coding-standard already has 23
  `N. **` lines, DoD three 1-4 lists, primitive a 1-3 list — "anywhere in the file" would have gone red today).
- Deviation: `get` now returns full text for every family, gotcha/lessons included (lookup moved hook.ts -> Store.fullSection).
- 3B contract (from the executor): marker line; items `N. **Head** — one or two sentences`, numbers permanent (keep cs:1..23);
  other numbered lists in a converted file must not use `N. **`; full text `rules-full/<file>` with `## N` per item,
  optional `_linked from ../../rules/<file> of N_`; triggers `["cs:12"]` + `t_*` fixtures; retired ids in retired-ids.txt.

## 2026-10-19 — Phase 03A audit (opus, 469 s) — RECEIPT, 4 findings (+ probe 2 folded in)

No gotcha/lessons regression: real-hook injection for 9 commands identical both arms (10,269 B total), index ids identical
(rule 292), rule-audit output identical; `get` grew as declared (e.g. lessons:C18 514 -> 2,243 B) but is pull-only.
RECEIPT — Phase 3A (a78bf02)
1. src/hook.ts:371 `isFamilyFile` (:398-409) — step5b note fires on unconverted family files (coding-standard.md today),
   telling the agent to create `cs:` triggers/rules-full sections that would be orphans.
   failing check: real hook PreToolUse Edit `~/.claude/rules/coding-standard.md` → expected no `### Editing a numbered rule file` block while unmarked; fires now.
2. src/corpus.ts:71-72 + :211-213 — marker present, zero `N. **` items → file vanishes from the index, no gate red.
   failing check: fixture marker + prose only → expected ≥1 entry or a test red naming the file; today `[]`.
3. src/corpus.ts:109-112 — a converted file drops all prose outside items from search.
   failing check: fixture with `PROSE-MARK` intro + `## Rule Priority` `PROSE-MARK-2` + items 1,2 → expected ≥1 hit; today `[]`.
4. tests/batas.test.ts:40 — duplicate id (`12.` twice, or two files on one prefix) fails as `family cs: store 3 vs count 4`, id unnamed.
   failing check: fixture `12.` twice → expected message contains `cs:12`.
(+) probe 2: orphan full-text `## 7` with no item → silent; folded into the fix as a red test naming `cs:7`.

## 2026-10-19 — Phase 03A receipt fix (4d37d24, opus, 287 s, 1 attempt) — re-check clean; 3A DONE

- `convertedFamily()` is the one converted-test (hook step5b + parseRuleFile); prose outside items is indexed via
  `parseSections(…, skipLines)`; `familyDefects` names zero-item, duplicate-id, shared-prefix and orphan-full-text cases.
- Orchestrator re-check: `just check` 118 pass 0 fail; real hook Edit on coding-standard.md -> 0 step5b blocks.
  Executor: 9-command injection table unchanged (10,269 B); hook p50 38.9 ms (+0.5%); mcp listening on new code.
- Known: a Write creating a brand-new converted file gets no step5b note (file not on disk yet). impact CRITICAL on
  `parseSections` (optional param, default unchanged).
- Phase 3B dispatched in two batches (same triggers.toml, so sequential): 3B-1 coding-standard, 02, 03, 04, 05;
  3B-2 gitnexus-first, batas-first, primitive, progress-changelog, commit-message, python-c-over-bash.

## 2026-10-19 — Phase 03B-1 (opus, 1,250 s, 1 attempt) — SHIPPED-UNVERIFIED, content audit in flight

- batas b40de5f, cc-toriq e19158d. cs 27, dod 17, ver 10, ui 7, bduf 5 items, each with a rules-full section.
  Five files 19,375 -> 12,085 B (-37.6%); 16-file always-on 71,637 -> 64,374 B. Sentence-set script: 0 missing per file
  (falsified by deleting one sentence -> `1 missing`). `just check` 118/0, corpus-lint 0.
- 36 every-turn items carry empty trigger tables (the coverage test requires an entry per id). Triggers cut for firing
  on > 3% of sessions: cs:14 JSDoc 22.8%, ver:5 playwright 21.4%, ui:1 component paths 15.9%, ui:2 CSS 5.8-10.5%.
- Hook design: a PROMPT match only ever shows a one-line hint, never full text (locked by a test), so prompt-only items
  (cs:26, dod:6 7 11 13 17, ver:8, ui:3 5 6, bduf:2 3 5) were written to stand alone. Kept as is — prompt hints stay cheap.
- Defect to fold into 3B-2: the step5b test picks "any family file still unconverted"; after 3B-2 none remain and the
  assertion silently becomes a no-op. It needs a fixture instead.
- Duration 21 min (> 15): the cost was a triggers.toml write that produced invalid TOML (raw newline in a literal
  string), restored byte-identical from the snapshot, then rewritten. 3B-2 gets that warning up front.

## 2026-10-19 — Phase 03B-1 content audit (opus, 239 s) — RECEIPT, 11 findings

Mechanical gates green, content not: six items lost load-bearing wording from the always-on text into rules-full, which
an every-turn or prompt-only item never injects. Cold read: 3 of 5 situations changed what the agent would DO.
RECEIPT (checks verbatim from the auditor):
1. 02-definition-of-done.md:10 dod:1 — "Default posture is prod-ready … unfinished one" left. `grep -c 'Default posture is prod-ready' ~/.claude/rules/02-definition-of-done.md` → 1 (now 0)
2. 03-real-verification.md:16 ver:2 — UI row lost `playwright-cli`, HTTP lost `progressive-uat`. `grep -cE 'UI[^;]*playwright-cli' …` → 1; `grep -c 'progressive-uat' …` → 1
3. 03-real-verification.md:17 ver:3 — scraper/worker/extension evidence specifics left. `grep -c 'docs/automation/captures/' …` → 1; `grep -c 'freshness timestamp' …` → 1
4. 03-real-verification.md:22 ver:8 — artifact format (HTML page per shot / one .md), "annotations are the next work", obswrite/clickup-writer left. `grep -c 'one HTML page beside the screenshots' …` → 1; `grep -c 'clickup-writer' …` → 1
5. coding-standard.md cs:12 — "one accessor / seed", "Hardcode only secrets…" left; path trigger misses pricing.ts. `grep -c 'read through one accessor' …` → 1; `grep -c 'Hardcode only secrets' …` → 1
6. coding-standard.md cs:26 — "bitten twice … promotes to gotcha-coding.md", no Repository/DTO tiers, cartridge pointer left. `grep -c 'bitten twice' …` → 1
7. 04-ui-consistency.md ui:3 — "never call a fitting plain design dated" left. `grep -c 'dated' …` → 1
8. 00-index.md:12 stale, no mention of references/rules-full/. `grep -c 'rules-full/' ~/.claude/rules/00-index.md` → >=1
9. rules-full/coding-standard.md:208,212 link copied verbatim resolves to references/references/…; re-point to `../incidents-data-and-db.md`.
10. corpus-lint.py:106-107 LINK_TO/LINK_FROM only match `[A-Z]\d+`; the 95 `of N` markers are never checked (gate vacuous for this phase).
11. b40de5f's claim "rejected-trigger items keep their full content always-on" is false; closes with 2 and 3.
Folded in: the step5b test's unconverted case becomes a fixture (it would go vacuous after 3B-2).
Lesson for 3B-2: the sentence-set script proves no sentence was LOST, not that it stayed always-on; the dispatch now
requires every every-turn/prompt-only item to keep its named tools, paths, numbers and procedures in the line.

## 2026-10-19 — Phase 03B-1 receipt fix (batas c056531, cc-toriq 7dbc615, opus, 282 s, 1 attempt) — re-check clean; 3B-1 DONE

- All 12 items cleared. Orchestrator re-ran the receipt greps on the live files: each phrase now 1 (was 0); `just check`
  118/0; corpus-lint 0 failures with the widened `of ([A-Z]?\d+)` regex (69 bare-number markers now checked; newly caught
  only the two `of 23` links of item 9). Falsified on a corpus copy: a bad `of 97` and the old path were each reported.
- Cold read via `claude -p --model sonnet` (1 session): UI evidence names playwright-cli; "mana buktinya" names the HTML
  page format; fee constant names "one accessor / seed".
- Bytes: five files 12,085 -> 13,466; 16-file always-on 65,825 B (from 72,644 at session start).
- step5b test now uses a fixture home, so it keeps asserting after 3B-2 converts every file.

## 2026-10-19 — Phase 03B-2 (opus, 902 s, 1 attempt) — SHIPPED-UNVERIFIED, audit in flight

- batas f5e7145, cc-toriq f2b5f69. gnx 11, bf 12, prim 7, pc 13, cm 6, py 6 items. `just check` 118/0, corpus-lint 0,
  sentences 0 missing, named-token check 0 missing (falsified: deleting `just mcp-restart` -> 1), ToolSearch lines byte-identical.
  Cold read (1 sonnet session) named the same tool/command for all five situations.
- The six files GREW 65,825 -> 66,863 B (+1,038): already short, nearly every item keeps its named tools always-on, plus
  marker/bold-head overhead. Value kept: addresses + triggers (feeds roadmap item 29's per-rule counts).
- Discovered: `Store.fullBody` injects full text only when it is longer than the line; bf/py full sections needed the
  pre-conversion wording added for that.
- SECURITY: while sampling commands from other sessions' transcripts, the executor printed plaintext credentials already
  sitting in those transcripts (three sshpass passwords for internal/remote SSH hosts and one local API key). Orchestrator
  checked: no value in scratchpad files (cand3/cand4.toml match only the word) nor in f2b5f69 / f5e7145. Values were not
  repeated here. User told to rotate the four.

## 2026-10-19 — Phase 03B-2 audit (sonnet, 157 s) — RECEIPT empty (clean); Phase 03 DONE

- Fences byte-identical (both ToolSearch lines, cm template, py env sweep); no backticked token or number missing;
  gnx:6 one line still maps all 14 question->tool pairs; no new trigger fires on common commands; plain `git commit` does
  not fire cm:1.
- Worth-it: all six grew (+1,038 B). 594 B is the marker (required by src/corpus.ts) plus "Full text per item" pointer
  lines (444 B, the only in-file path to rules-full — kept). Net cost ~1 KB always-on, bought per-item addresses.
- Phase 03 totals: 16-file always-on 71,637 B (after Phase 2) -> 66,863 B; session start was 72,644 B (-5,781 B, ~-1.4k
  tokens per request). 11 files addressed: cs 27, dod 17, ver 10, ui 7, bduf 5, gnx 11, bf 12, prim 7, pc 13, cm 6, py 6.
