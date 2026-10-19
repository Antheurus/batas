---
descriptor: 2026-10-19-maturity-gaps
sequence: 01
supersedes: none
task: docs/plan/2026-10-19-maturity-gaps/task.md
plan: docs/plan/2026-10-19-maturity-gaps/plan.md
research: docs/plan/2026-10-19-maturity-gaps/research.md
findings: docs/plan/2026-10-19-maturity-gaps/findings.md
written_at: 2026-10-19 (session f489f00b, cc-toriq)
written_by: Antheurus, planning session that measured batas maturity
reason: user-request (context measured 406,369 tokens)
---

# Handover 01 — batas maturity gaps (roadmap items 23, 22, 21, 24)

## State snapshot

**Current DAG block:** none started. No TaskList board exists for the planning session (`task-state-guard.py --list`:
"no task board"), so the registry below comes from `task.md`'s checkboxes.

| Phase | Name | Status | Notes |
|---|---|---|---|
| 1 | item 23 — orphan gate + derived counts | pending | no dependency; start here |
| 2 | item 22 — triggers for 28, move rare items | pending | depends on Phase 1 |
| 3 | item 21 — a line in the rules, content in batas | pending | blocked on OPEN 1 + 2 in task.md |
| 4 | item 24 — recurring delivery-eval | pending | blocked on OPEN 3; runs after Phases 2 and 3 |

**Last completed action:** plan bundle written (task, research, plan, findings) in
`docs/plan/2026-10-19-maturity-gaps/`; roadmap Priority 8 pushed (batas HEAD 6623fc3).

**Immediate next action:** ask the user OPEN 1-3 from `docs/plan/2026-10-19-maturity-gaps/task.md` in one
AskUserQuestion, then invoke od-execute for Phase 1 (it needs none of the answers).

---

## In-flight context

### User confirmations (verbal, not in artifacts)

- The four items and their order (23 -> 22 -> 21 -> 24) were the agent's recommendation; the user said "gas kerjain 4
  itu".
- Item 21's shape is decided: "kita bisa jadikan line di rules dan isinya ada di batas" — keep a condensed line
  always-on, full text in batas. Destructive lines stay always-on.
- The user's motive: always-on rules are the expensive part; hook block text is cheap (~41k tokens over 114 sessions in
  7 days vs ~18.8k tokens per request for the rules).

### Discoveries made mid-run

- `~/.claude/references/rules-full-text.md` already holds per-file pre-condensation text for the unnumbered files, so
  Phase 3's "content" half mostly exists; batas does not index it as rule ids yet.
- delivery-eval spawns real `claude -p` sessions (cost, memory `eval-runs-max-six`).

### Environment / tooling notes

- Rules edits go through the `rules-writer` skill (a guard denies without it) and end with `just sync` + `just verify`
  in cc-toriq.
- Multiple Claude sessions were live in cc-toriq; stage by path, never `git add -A`; `git push` there needs
  `BATAS_ACK_LIVE=1` after checking `git log origin/main..HEAD` is all yours.
- Hard stop is now 500k (`CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=500000`), handover line 400k (compact-percentage mod +
  `context-check.py`). `/cp` raises the stop for one session.

---

## Known issues and blockers

| # | Severity | Description | Status |
|---|---|---|---|
| 1 | blocker (Phase 3) | Address scheme for unnumbered files (OPEN 1) not chosen | unresolved |
| 2 | blocker (Phase 3) | Which unnumbered files are exempt (OPEN 2) not chosen | unresolved |
| 3 | blocker (Phase 4) | Recurring eval budget (OPEN 3) not chosen | unresolved |
| 4 | watch | The plan skipped od-plan's sign-off gate; treat the user's "gas" as approval of Phases 1-2 only | open |

---

## Resume prompt

```
RESUME ORCHESTRATION

Descriptor: 2026-10-19-maturity-gaps   (repo: ~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas)
Handover: docs/plan/2026-10-19-maturity-gaps/handover-01.md   <- highest number; lower ones are archive
Task: docs/plan/2026-10-19-maturity-gaps/task.md
Findings: docs/plan/2026-10-19-maturity-gaps/findings.md
Plan: docs/plan/2026-10-19-maturity-gaps/plan.md
Research: docs/plan/2026-10-19-maturity-gaps/research.md

Read in this order: handover-01 -> task -> findings (tail) -> plan -> research (skim).

Then: ask the user OPEN 1-3 from task.md in one AskUserQuestion, then Skill({skill: "od-execute"}) starting at Phase 1 (item 23).
Do not re-plan. Do not re-ask questions already answered in the artifacts.
```
