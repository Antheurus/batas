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
