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
