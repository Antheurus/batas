# Research — measured 2026-10-19 (cc-toriq session f489f00b)

All figures below were produced by a command in that session; re-run before relying on one.

## Always-on weight

`python3 ~/.claude/skills/rules-writer/scripts/corpus-lint.py`: 16 always-on files, 72,644 bytes (~18,161 tokens);
plus `~/.claude/CLAUDE.md` 2,470 = 75,114. Per file (bytes): lessons.md 19,709 · gotcha-coding.md 9,501 ·
coding-standard.md 5,813 · 03-real-verification.md 4,394 · 02-definition-of-done.md 4,389 · gitnexus-first.md 4,003 ·
00-index.md 3,402 · persona.md 3,314 · batas-first.md 3,173 · 04-ui-consistency.md 2,663 · progress-changelog.md 2,662 ·
primitive.md 2,523 · CLAUDE.md 2,470 · 05-design-then-scope.md 2,116 · python-c-over-bash.md 1,988 ·
01-request-fidelity.md 1,671 · commit-message.md 1,323.

Addressable today: only lessons.md + gotcha-coding.md (29.2 KB). The other 15 (~45.9 KB) are invisible to
`just rule-audit`.

`~/.claude/references/rules-full-text.md` already holds the pre-condensation text of every unnumbered file, per file —
the "content in batas" half of item 21 largely exists; what is missing is addresses, triggers, and batas indexing those
sections as injectable ids.

## `just rule-audit` (batas repo)

- 20 always-on items at <= 2% of sessions, 7,363 bytes total, e.g. lessons:B37 0.1% 534 B, lessons:B47 0.1% 472 B,
  gotcha:B11 0.1% 441 B, lessons:C10 0.5% 322 B ... gotcha:A1 0.6% 118 B (full list: re-run the recipe).
- 28 always-on items with no cmd/path/code trigger: gotcha:A3 A4 A5 A9 A11 C6 C13; lessons:A2 A3 A4 A5 A6 B2 B17 B22
  B23 B31 B39 B40 B49 C6 C8 D6 D10 F2 F3 H4 I4.
- Inject-only items reaching >= 30% of sessions: lessons:B24 43.5%, lessons:B57 37.5%, gotcha:E26 35.9% (they fire on
  commands and arrive; no change proposed).
- Item 2's standing rule: destructive items stay always-on even when rare, because a PreToolUse injection lands after
  the command ran.

## Orphan triggers and hard-coded counts (item 23)

- `src/mcp.ts` ~line 408 computes `orphan` (trigger ids with no rule) and prints it in `status` (~line 447). No test
  asserts it, so `just check` passes with orphans.
- `tests/batas.test.ts` line ~40: `expect(gotcha).toBe(157)` / `expect(lessons).toBe(135)`; moved from 136 by hand on
  2026-10-19 when lessons A1 left lessons.md (commit eef21b3). The earlier E36/E37 move did the same (8ae415f).

## Delivery-eval (item 24)

- `just delivery-eval repo mode cases controls seed` -> `bun scripts/delivery-eval.ts`; spawns `claude -p`.
- Saved results `.delivery-eval-{read,bash,python}.json` all dated 2026-10-08.

## Hook log (context for item 26, not in this plan)

Full log 2026-09-30 -> 2026-10-19: PreToolUse n=57,269 p50 18 ms p99 366 ms; PostToolUse n=29,090 p50 70 ms;
Stop n=3,269 p50 26 ms p99 1,546 ms; UserPromptSubmit n=4,567 p50 29 ms p99 1,213 ms.
