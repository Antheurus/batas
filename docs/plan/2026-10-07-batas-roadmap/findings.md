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

## Session 2 (2026-10-08) — roadmap 9/4/8/7/5, then the rebuild

- `11dae40` v0.8.0 prompt-audit; `410ad4a` v0.9.0 memory-audit (84 stale paths in 60 memories); `07ea9b9` v0.10.0
  per-session budget (measured max 36 KB, cap 64 KB); `4453ebb` v0.11.0 lesson-mine (found B29 blind to multi-line
  python -c); `268b34f` v0.12.0 memory-share (19 files -> 2).
- The user found batas unusable: lessons reached an agent only through prompt words or an explicit recall. Measured
  0/15 delivered. `da37247` v0.15.0 routes each lesson to the file defining its Simbol as a path rule (mendadak-pos
  560/824 -> 398 files), covers Bash reads/edits, regenerates on lesson edits and gates commits. Delivery 15/15 for
  Read, cat and python; controls 5/5. `v0.15.1` withdrew a sed-based Bash number (Claude Code loads rules after
  `sed -n` itself) and fixed an owner-less Simbol misroute.
- `52b3ed9` v0.15.2: `just reindex` deleted the index under live MCP servers ("disk I/O error"); now rebuilt in place and
  the server reopens.
- Semantic recall measured (`7aee494`): gemma2 text-only + me5-small RRF EN 35/40 ID 36/40 vs BM25 18/33. Not built.
- Behavior eval inconclusive (A 0/8, B 0/8 repeated): the traps were guarded by existing code and tests.
- Lessons: an eval whose "before" arm already passes is measuring the wrong path — check what produced the pass
  before reporting a gain; measure the thing at risk (sed vs cat).

## Session 3 (2026-10-08/09) — semantic recall built, behaviour proven to the edge of what is delivered

- `c86deb0` v0.16.0 semantic recall: batasd (EmbeddingGemma 2 text-only + multilingual-e5-small, RRF k=60, MPS),
  LanceDB holds only vectors, SQLite removed, text parsed from the files (rules ~8 ms, all 7,991 entries ~265 ms).
  Same-corpus probes EN 35 / ID 36 (acceptance 1). Repo-wide knowledge EN 27 / ID 31 vs BM25 10 / 31 on the same
  corpus; recall now ranks knowledge apart from history and interleaves repo with global (EN 17 -> 27).
- `0418be0` prompt gate = best Gemma cosine minus the repo's true 10th-best (`ref` from batasd) >= 0.07: 16/300 real
  prompts, ~18/22 relevant on a hand read. Absolute cosine rejected (positives 0.77 vs noise 0.72). Shipped once with a
  bug (missing cosines read as 0 opened the gate); log showed no live injection. Idle Apple GPU answers its first query
  in 0.47-0.71 s, so a cold prompt's search is stashed and delivered on the next hook call.
- `5c7a901` user chose batasd always on (launchd `dev.batas.batasd`, MPS, ~3.5 GB, idle 0.03 s CPU / 150 s). CPU mode
  rejected: 0.2-2 s per query under load. Power measured with machine-monitor + top.
- `e35c9b0` write-time lesson matching built and switched OFF: similarity cannot pair a new file with its trap lesson
  (6/29 on top, gaps below noise; bge-reranker-v2-m3 scored targets 0.00-0.41 at 1.2 s, +3.9 GB). A trap lesson applies
  only after reasoning about the implementation. LLM-judge route offered, not chosen.
- Behaviour evals: mendadak-pos new-code traps A 0/8 vs B 1/8 (repo guards them). Funnel fe-v2 memory traps, 3 runs/arm:
  A 4/15 = B 4/15, target delivered 2/15. Exact naming memory in context: Beacon 0/3 vs 6/6 without. Results in
  `evals/results/2026-10-08-behavior-{new,funnel}.json`.
- `82751ac` v0.16.1 regression fixed: the in-memory store parsed only the session's own project's memories, so no
  memory recorded under another project fired on its triggers (Funnel backend memories never reached fe-v2).
- `91e11a7` v0.17.0 subagents: a subagent never sends UserPromptSubmit; its brief is now matched like a prompt at the
  Agent/Task PreToolUse and the memories are appended (updatedInput). Proven by what agents said unprompted: briefed
  subagent quoted the user's 7 Oct no-live decision, unbriefed one planned SSE; hook log 182 ms vs 19 ms.
- `01c6a63` brief beats a conflicting memory ("jangan commit" brief + "commit without asking" memory): 3/3 obeyed the
  brief. Negation-aware triggers were built and rejected: on 3,000 real prompts they dropped on-topic hits
  ("nggk mau auto compact" is that memory's topic).
- Lessons: an eval must log per run whether the thing under test was DELIVERED (hook log, real paths — /tmp vs
  /private/tmp hid it); a hook change that applies immediately (E10) mid-eval splits an arm, rerun it; read the hook
  log before claiming no live impact; a pipe to `head` killed `just install` before it wrote (B14).

## Session 4 — 2026-10-09 (v0.18.0)

- A warm batasd silently replaced the trigger-word path: the same prompt fired its memory cold and nothing warm.
  Every earlier "semantic + triggers" claim held only for cold prompts.
- Scores on cases whose sentences were read while choosing triggers do not generalise: held-out requests written by
  an agent blind to triggers got 0/6 prompt-time delivery. A per-repo `repos:` title list is what reached them.
- A fixed instruction suffix appended to every eval prompt dominated the semantic query (ceo-chart's memory fell out
  of the top 12); send it as a system prompt.
- Headless agents write new files with `cat > file`; any write-time check must also read Bash-written files, and
  mtime attribution catches other sessions' files, so only content patterns may fire there.
- A cache of parsed entries must be keyed by the parser's version too, not only by the source file's mtime.
- Evals capped at 6 sessions per run by the user; a 30-session run took over an hour.

