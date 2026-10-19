# Plan — batas maturity gaps (items 23, 22, 21, 24)

Mode: Lean. Base: `main` of the batas repo; rules live in `~/.claude/rules/` and are mirrored into cc-toriq with
`just sync` (cc-toriq rule `all-sync-after-config-change`). Every edit to `~/.claude/rules/*.md` goes through the
`rules-writer` skill, Mode D (snapshot -> edit -> `edit-verify.py check` -> `corpus-lint.py` -> Step 5b triggers).
Rules edits are not live in the session that makes them; behaviour checks need a fresh `claude -p` (max 6 sessions per
eval, memory `eval-runs-max-six`).

## Phase 1 — item 23: orphans fail the check, counts are derived

- Extract the orphan computation in `src/mcp.ts` into an exported function the test can call.
- `tests/batas.test.ts`: assert zero orphan trigger ids; replace `toBe(157)` / `toBe(135)` with a count derived by
  parsing the numbered items of the two families on disk.
- Success: `just check` green; falsified by adding a fake `["lessons:Z99"]` entry to a temp copy of triggers.toml
  (must go red naming it) and by deleting one numbered item in a fixture (count follows without a hand edit).
- Docs: batas `docs/progress.md` + `docs/changelog.md`, roadmap item 23 status.

## Phase 2 — item 22: triggers for the 28, then move the rare ones

- For each of the 28 untriggered always-on items, add `cmd`/`path`/`code`/`prompt` triggers with `t_*` fixtures in
  `~/.claude/batas/triggers.toml` (prompt phrases in Indonesian AND English). Some may legitimately have no trigger
  (every-turn behaviour, e.g. lessons:A2 re-read the request): list those and leave them always-on.
- Re-run `just rule-audit`; move the non-destructive items at <= 2% into the `p-*-injected.md` slices (routing table in
  the mother updated, `_linked from_` re-pointed). Destructive items keep their line (item 2).
- Success: `just check` green (zero orphans from Phase 1), `corpus-lint` 0 failures, always-on bytes reported before ->
  after, `just prompt-audit` shows no new over-broad phrase (> 3%).

## Phase 3 — item 21: a line in the rules, the content in batas

Blocked on OPEN 1 and 2 in `task.md`.

- Give each in-scope unnumbered file's sections permanent addresses (scheme from OPEN 1).
- Condense each section to one or two prescriptive sentences always-on; its full wording lives under its address in
  `~/.claude/references/rules-full-text.md` (already per file) with `_linked from_` / `_linked to_` markers.
- Teach batas to index those sections as rule ids (today it indexes only the gotcha/lessons families) so a trigger can
  inject them; add triggers + fixtures.
- Success: always-on bytes before -> after (target: the ~45.9 KB of unnumbered files roughly halved), `just check`
  green, `corpus-lint` 0 failures, and Phase 4's eval shows the moved content still arrives.

## Phase 4 — item 24: recurring delivery-eval

- A `just` recipe running delivery-eval at the budget from OPEN 3 (proposed 4 cases + 2 controls) and comparing against
  the last saved result, failing on a drop. Run after Phase 2 and after Phase 3.
- Success: one recorded run per phase with its numbers in progress.md; the recipe goes red on a deliberately broken
  trigger.

## Not in this plan

Item 28 (deny-first for irreversible commands) and items 25-27; see `docs/roadmap.md` Priority 8.

## Final status

Built: `just check` now fails on orphan trigger ids, reused or unrecorded retired ids, malformed retired lines, duplicate
ids and orphan full-text sections, and derives every family's size from disk (item 23); the 28 untriggered gotcha/lessons
items got triggers or were declared every-turn, and 8 rare non-destructive ones moved inject-only (item 22); batas gained
eleven unlettered families (cs dod ver ui bduf gnx bf prim pc cm py) with full text in `references/rules-full/`, and the
eleven files were converted to a line in the rules plus the content in batas (item 21); `just delivery-check` re-runs a
4+2 rules eval on demand with a no-session hook pre-check (item 24). Alignment: Phase 3 split into 3A/3B-1/3B-2, and a
retired-id guard (01b) was added at the user's prompting; otherwise as planned. Always-on 72,644 -> 66,863 B, hook p50
unchanged. Learnings: green gates proved little on their own three times (link regex, step5b fixture, eval prompt) —
the per-block content audits and red proofs carried the run. Pending, the user's call: a 6-session delivery-check re-run
under the new prompt (the first run's 2/4 was a scoring defect; the pre-check shows 4/4 injected).
