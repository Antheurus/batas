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
