# batas roadmap — findings

Written retrospectively at handover (this session was not an od-plan orchestration). Baselines: batas `de1c688`
(v0.2.0) → `1fd3577` (v0.7.0); cc-toriq `3b88112` → `6e78247`. Every entry below is one commit range; the numbers are
the ones measured at the time, also recorded in each commit body and in `docs/progress.md`.

## Context shortening (cc-toriq)

- `ee980c8` — global always-on rules 153,885 → 71,025 bytes. Original wording of every item moved verbatim to
  `~/.claude/references/{lessons,gotcha}-full.md` (by ID) and `rules-full-text.md` (per file).
- scrape-mono (separate repo, `5bc8d716`) — all-* rules ~161k → 23,875 bytes, 117 entries archived in docs/lessons/.
- Re-measured at the end: cc-toriq 164.7k → 96.0k, scrape-mono 323.9k → 124.1k, ocr-service 173.2k → 93.6k total
  instruction bytes, all under the 150k-char warning.

## batas v0.3 — memory carried by the hook

- `516525c` full-text injection for fired family rules; memory recall on UserPromptSubmit; `just memory-index`
  (MEMORY.md 116,480 → 80,683 bytes across 33 projects).
- `79e37f1`, `acd955e` — first live day injected noise; fixed by: own words only (side-agent notes and `>` lines cut),
  only a trigger hit injects, word overlap lists. 586 memories backfilled with `triggers:` (cc-toriq `2b1b175`).
- `0be97fc` — `just trigger-audit` against 15,309 real prompts: 8.3% pull any memory.

## batas v0.4 — prod-readiness

- `c8af0ff` — log.ts (rotation, error field), "batas nyasar" mute + `mute` tool, `just rule-audit`, latency gate.
  Prompt path 252 → 42 ms p50 after an entries(kind, scope) index and a substring prefilter; the gate had missed a
  1.2 s regression until the fixture was scaled to 600 memories.
- `0a8084f` — "batas nyasar" muted a command rule (B29) instead of the prompt's memory, and fired on a quoted note.

## Roadmap 1–3 (v0.5–0.6.2)

- `d95f98f` live-session warning; `e8fcf4c` blocking (sweeping git while another session's file is dirty; push while
  live); `2b51324` script edits attributed via PostToolUse; `b4d7372` session start from transcript birth (0.6.1 would
  have blocked every already-open session on its own work).
- Guard misfires found on this very work: a heredoc mentioning `git add`, the session cwd instead of the command's
  `cd`, a commit message naming `git -C X`. Each fixed with a falsified test.
- `18a0ef6` tiering — a PreToolUse injection lands AFTER the command runs, so destructive rules stay always-on even when
  rare; 11 non-destructive items moved (cc-toriq `21f05b1`).
- `ce862ca` effect-audit — B14 50→19%, B20 82→41%, B10 32→9% repeat rate; situational controls flat.

## Roadmap 6 (v0.7.0)

- `a64d70f` — memory write without `triggers:` warns; family rule edit shows the Step 5b checklist; status lists
  always-on items without full text (0 of 91).

## Recurring lessons from the session (apply to the remaining items)

- Falsify every new test by breaking the code it guards. Three tests this session passed while asserting nothing
  (a `touch -t` that moves mtime not birthtime; a regex that never matched the reproduced shape; a 3-memory fixture
  that could not show a 1.2 s regression).
- Anything that BLOCKS must read only the shell surface (no heredocs, no quotes) and resolve the command's own
  directory; a warning may read deeper.
- Calibrate any matcher with negatives that must return NOTHING before shipping (lessons B54, improve lesson 14).
