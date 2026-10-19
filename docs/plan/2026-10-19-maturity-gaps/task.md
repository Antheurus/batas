# Task — batas maturity gaps (roadmap items 23, 22, 21, 24)

## The ask, verbatim

> "gas kerjain 4 itu jadikan plan dulu abis itu kita /od-handover karena udah 40%"

"4 itu" are the four items recommended on 2026-10-19 from roadmap Priority 8 (`docs/roadmap.md`), in this order:

1. **Item 23** — `just check` fails on orphan trigger ids and derives the corpus size instead of hard-coding it.
2. **Item 22** — move the rarely-firing always-on items inject-only, after the 28 untriggered always-on items gain triggers.
3. **Item 21** — tier the 15 unnumbered always-on rule files with the agreed shape: **a line in the rules, the content in batas**.
4. **Item 24** — delivery-eval as a recurring regression.

The user's goal behind all four: the always-on rules are the expensive part (75,114 bytes, ~18.8k tokens re-sent on
every model request); batas injection is cheap. Shrink the always-on half without losing any rule.

## DAG

- [ ] Phase 1 — item 23 (orphan gate + derived counts). No dependency. Lands first: it is the safety net every later
      rule move relies on.
- [ ] Phase 2 — item 22 (triggers for the 28, then move rare non-destructive items). Depends on Phase 1.
- [ ] Phase 3 — item 21 (address + trigger + condense the 15 unnumbered files). Depends on Phase 1; OPEN decisions
      below must be answered before it starts.
- [ ] Phase 4 — item 24 (recurring delivery-eval). Depends on Phase 1; run once after each of Phases 2 and 3.

## OPEN (only the user can settle)

1. **Address scheme for the unnumbered files** (Phase 3). Proposed: a per-file prefix plus a number, kept permanent like
   `gotcha:`/`lessons:` (e.g. `cs:12` for coding-standard Rule 12, `dod:3` for definition-of-done). Alternative:
   heading slugs, which break on a heading rename.
2. **Which unnumbered files are exempt** (Phase 3). Proposed exempt, staying whole always-on: `00-index.md` (the map),
   `01-request-fidelity.md` and `persona.md` (every-turn behaviour with no trigger to hang on). Everything else is in
   scope.
3. **Recurring delivery-eval budget** (Phase 4). delivery-eval spawns real `claude -p` sessions; memory
   `eval-runs-max-six` caps an eval at 6 sessions unless asked. Proposed: 4 cases + 2 controls per run, on demand via
   `just` after a rule move, not on a timer.
4. **Item 28 (deny-first for irreversible commands)** is NOT in this plan. It touches memory
   `feedback_hook-warn-not-ask` and needs its own decision.

## Answered 2026-10-19 (resume session)

- OPEN 1: prefix plus number, permanent like `gotcha:`/`lessons:` (e.g. `cs:12`, `dod:3`).
- OPEN 2: exempt and kept whole always-on: `00-index.md`, `01-request-fidelity.md`, `persona.md`. All other files are in scope.
- OPEN 3: 4 cases plus 2 controls per run (6 `claude -p` sessions), run by hand through `just` after a rule move, never on a timer.
- New from the user mid-resume: roadmap item 29 (per-rule fire ledger in a mod, then prune). Not in this plan; after items 21-24.
