---
descriptor: 2026-10-07-batas-roadmap
sequence: 03
supersedes: handover-02
task: docs/plan/2026-10-07-batas-roadmap/task.md
plan: docs/plan/2026-10-08-semantic-recall/plan.md (built); docs/roadmap.md (items 11-16 open)
findings: docs/plan/2026-10-07-batas-roadmap/findings.md (session 3 at the end)
written_at: 2026-10-09
written_by: cc-toriq session cd4d52e0 (semantic recall build, behaviour evals, subagent briefs)
reason: user request — next session must turn every unproven item into "fixed" or "proven in prod"
---

# Handover 03 — batas: make delivery prove itself

## State snapshot

Not an od-plan orchestration; git history is the ledger. batas `22088df` -> `01c6a63` (v0.16.0 … v0.17.0), all pushed,
tree clean. cc-toriq mirror pushed (`3686dd1`). batasd runs under launchd `dev.batas.batasd` (MPS, ~3.5 GB), 7,994
vectors. Session task board: #16 write-time delivery (built, switched OFF), #17 Funnel eval (done) — no row open.

| Unit | State | Evidence |
|---|---|---|
| Semantic recall, SQLite removed (task 13) | done v0.16.0 | same-corpus EN 35 / ID 36; repo-wide EN 27 / ID 31 vs BM25 10 / 31 |
| Prompt gate (standout gap >= 0.07) + late delivery of cold prompts | done | 16/300 real prompts pass, ~18/22 relevant |
| batasd always on (user's choice) | done | launchd runs=2 after kill -9; idle 0.03 s CPU / 150 s |
| Cross-project memory triggers | fixed v0.16.1 | real hook: old {} -> fixed lists funnel-no-live-streaming |
| Subagent briefs carry memories | done v0.17.0 | briefed subagent quoted the 7 Oct decision, control did not |
| Brief beats a conflicting memory | done | 3/3 left the typo fix uncommitted |
| Write-time lesson matching | built, OFF | similarity cannot pair new code with trap lessons (findings) |
| **Delivery coverage** | **NOT proven** | Funnel eval: target delivered 2/15, A 4/15 = B 4/15 |

## User decisions (this session)

- Command / file / code triggers stay regex; search and prompt matching are semantic (memory
  `batas-command-file-triggers-stay-regex`). BM25 survives only as an eval baseline — never rebuild it (roadmap 16).
- batasd always on, on the GPU, ~3.5 GB accepted (memory `batasd-always-on-mps`). Power was the user's worry; measured fine.
- Behaviour must be proven by what an agent SAYS or DOES on its own, never by asking it to recite the hook.
- "Kalau memang nggak guna ya nggak guna" — report a null result plainly; the user prefers truth to a rescued claim.
- Next session: every unproven item below is either fixed or proven to run in prod. No handing back a list.

## Known issues (the next session's work, in this order)

| # | Issue | Evidence | What "done" means |
|---|---|---|---|
| 1 | **Memory delivery coverage.** Right memory was the top semantic hit for 3/4 Funnel requests but under the 0.07 gate (gaps 0.037-0.059); triggers like `beacon funnel` need every word; every eval prompt ran cold | evals/results/2026-10-08-behavior-funnel.json | a memory-specific gate (memories only: lower gap, or top-1 memory with a margin over the 2nd memory) calibrated with `just semantic-calibrate` negatives; multi-word triggers reviewed; then the Funnel eval re-run 3 runs/arm shows A delivered >= 10/15 and A repeats < B |
| 2 | **Noisy word-overlap listing** ("3 shared content words" lists unrelated memories — 8 listed on one prompt here, fed by pasted text) | this conversation's hook injections | remove or gate it; prove with a replay over history that listed-per-prompt drops and trigger hits stay |
| 3 | **Prompt hook latency over 150 ms under load** (156-252 ms cold, parse of all 604 memories ~39 ms p50 / 84 max) | hook.log ms on eval sessions | cache parsed memories (e.g. a JSON snapshot keyed by mtimes) or start the parse in parallel; p95 <= 150 ms over 40 real prompts at load ~6 |
| 4 | **Small n** — subagent and full-session proofs are 1 run per arm | progress v0.17.0 | re-run the realtime-SSE probe 3x per arm (session and subagent) and the Funnel eval after #1 |
| 5 | Pasted text and the eval's fixed task suffix shift semantic queries ("jangan commit, jangan push" pulled the wrong memories) | arm C of the Funnel eval | ownWords strips pasted blocks if the hook can see them; re-probe |
| 6 | Two extra memories appended to the SSE subagent brief (brighty-v2 repo notes) were never judged for relevance | hook log 18:07:34Z | read them; tighten if noise |
| 7 | `memorySources(project)` in `src/corpus.ts` has no callers left in src, scripts or tests (the hook uses `allMemorySources`) | repo-wide search | ask the user wire-or-delete (dead-code rule) |

## Discoveries to carry

- An idle Apple GPU answers its first query in 0.5-0.7 s; every eval session's first prompt is cold. Late delivery
  (stash + next hook call) is the design answer; keep it.
- Hook script edits apply to every live session immediately (gotcha E10): switch a risky path OFF with a config flag
  before measuring it, and read the hook log for live impact before saying "none".
- Eval delivery checks must compare real paths (`/tmp` vs `/private/tmp`).
- `BATAS_OFF=1` (whole hook), `BATAS_NO_SUBAGENT_BRIEF=1`, `BATAS_NO_WRITE_SEMANTIC=1`, `BATAS_SEMANTIC_MIN_GAP`
  (per-session gate) exist for A/B arms.
- Restart batasd only with `just batasd-restart` (launchctl kickstart); never kill by name.

## Resume prompt

```
RESUME — batas: fix or prove-in-prod every unproven delivery item (not an od-plan orchestration; do NOT invoke od-execute)

Repo: ~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas
Handover: docs/plan/2026-10-07-batas-roadmap/handover-03.md   <- highest number is current
Read: handover-03 -> docs/plan/2026-10-07-batas-roadmap/findings.md (Session 3) -> docs/plan/2026-10-08-semantic-recall/plan.md
Evals: evals/behavior-new-eval.py (--cases behavior-cco-cases.json, --arms, --tag), scripts/semantic-calibrate.ts, scripts/write-calibrate.ts

Work Known issues 1-7 in order. Done = the evidence column's bar, measured, not argued: memory delivery >= 10/15
and A < B on the Funnel eval, listing noise down on a history replay, prompt p95 <= 150 ms at load ~6, 3 runs/arm for
the behaviour proofs. Behaviour is judged by what agents say or do on their own. Ask the user when stuck.
```
