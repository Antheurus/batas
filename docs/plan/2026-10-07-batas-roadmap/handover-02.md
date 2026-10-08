---
descriptor: 2026-10-07-batas-roadmap
sequence: 02
supersedes: handover-01
task: docs/plan/2026-10-07-batas-roadmap/task.md
plan: docs/plan/2026-10-08-semantic-recall/plan.md (the next build); docs/roadmap.md (items 10-13)
findings: docs/plan/2026-10-07-batas-roadmap/findings.md
written_at: 2026-10-08
written_by: cc-toriq session cd4d52e0 (roadmap 9/4/8/7/5, lessons-by-location rebuild, semantic measurement)
reason: context — 698k of 1M at the last check; the semantic build left is far over 100k
---

# Handover 02 — batas: semantic recall build is next

## State snapshot

Not an od-plan orchestration; git history is the ledger. batas `cc64cef` -> `7aee494` (v0.8.0 … v0.15.2), all pushed.
mendadak-pos `5940053b` + `128b5b46` (routed lessons) on `dev`, pushed. cc-toriq mirror pushed.

| Task | State | Evidence |
|---|---|---|
| Roadmap 9, 4, 8, 7, 5 | done | progress.md v0.8.0-v0.12.0 |
| Lessons delivered by location (routed path rules, Bash coverage, auto-regen, commit gate) | done | delivery-eval mendadak-pos: Read 0/15 -> 15/15, cat 0/15 -> 15/15, python 0/15 -> 15/15, controls 5/5 |
| MCP survives an index rebuilt under it | done v0.15.2 | test reproduces "disk I/O error" without the fix |
| **Semantic recall (task 13)** | **designed + measured, NOT built** | docs/plan/2026-10-08-semantic-recall/plan.md |
| Behavior eval | ran, inconclusive | evals/results/2026-10-08-behavior.json: A 0/8 and B 0/8 repeated |
| **Discriminating behavior eval (task 15)** | **open** | traps in NEW code, see below |

## User decisions this session (verbal)

- Semantic search is mandatory, no regex/lexical search; drop SQLite if it cannot do it ("nggk usah mikir 2x").
- Good in Indonesian AND English, two models ("pakai 2"); text only, no multimodal ("jauh lebih murah").
- EmbeddingGemma 2 was the user's suggestion; it won: gemma2 text-only + multilingual-e5-small RRF = EN 35/40, ID 36/40
  vs BM25 18/33.
- Safety guards (collision guard) stay deterministic — said to the user, no objection given.
- Graphify does not replace batas (re-checked v0.9.80: no embeddings, duplicates GitNexus); ideas went to roadmap 11-13.
- Wants no unproven claims: every number with its evidence, ask when stuck.

## Discoveries to carry

- Claude Code 2.1.293 loads path-scoped rules after `sed -n '<range>' <file>` (not after cat/head/grep/python), against
  the docs' "Read, Write, or Edit". batas skips sed reads to avoid duplicates. Re-probe after a Claude Code upgrade.
- `--allowedTools X` pre-approves X; it does not forbid Read. Verify which tools a probe session used from the hook log.
- Eval controls must fail only on quoting a lesson heading; a real path rule for the file is a correct answer.
- The behavior eval's traps were already guarded by code + tests, which the no-lesson arm cited; tasks must write NEW
  code where the trap recurs unguarded.
- `sentence-transformers[audio]` fails to build kenlm here; use `[image]>=6.1` and text-only
  `config_kwargs={"vision_config": None, "audio_config": None}`.
- This shell's grep/ls/wc mangle counts (lessons B24) — count in python.
- PreToolUse warnings land after the command runs: B56 fired on my own `echo =====` and it still failed.

## Known issues

| # | Severity | Issue | Status |
|---|---|---|---|
| 1 | risk | 264 mendadak-pos lessons route nowhere (160 no Simbol, 104 generic) — reach the agent only via recall | semantic recall + roadmap 11 |
| 2 | watch | a python read with an assembled path is invisible to Claude Code and batas (a change through it is caught) | accepted, documented |
| 3 | watch | MCP servers started before v0.15.2 keep the disk-I/O bug until their session restarts | self-resolving |
| 4 | watch | Indonesian semantic gain is +3/40 over BM25 — re-measure on a second repo's lessons before trusting the margin | open |

## Resume prompt

```
RESUME — batas semantic recall (not an od-plan orchestration; do NOT invoke od-execute)

Repo: ~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas
Handover: docs/plan/2026-10-07-batas-roadmap/handover-02.md   <- highest number is current
Plan: docs/plan/2026-10-08-semantic-recall/plan.md
Task: docs/plan/2026-10-07-batas-roadmap/task.md ; Roadmap: docs/roadmap.md (items 10-13)
Evals: evals/semantic-compare.py + evals/semantic-probes.json ; just delivery-eval ; evals/behavior-eval.py

Read: handover-02 -> plan -> roadmap. Build the plan's order 1-4: batasd (gemma2 text-only + me5-small, warm, unix
socket), LanceDB store, MCP recall/check on it, SQLite FTS removed, hook prompt path semantic. Acceptance: daemon
search reproduces EN>=35 ID>=36 on the 80 probes; hook prompt p95<=150ms warm; delivery-eval still 15/15. Then task
15: a discriminating behavior eval (traps in NEW code). Every claim with evidence; ask the user when stuck.
```
