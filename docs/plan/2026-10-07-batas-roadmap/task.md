# batas roadmap — task

**The ask (user, 2026-10-07):** make batas help the user "all out" — every rule, memory and lesson on this machine
reaching the agent exactly when it matters, measured rather than assumed. The agreed roadmap with its evidence is
`docs/roadmap.md`; this file is the working checklist. Not an od-plan orchestration: there is no plan.md or
research.md, each item is built directly, measured, falsified, committed and pushed on its own.

## Done (2026-10-07)

- [x] Roadmap 1 — live-session collision guard (warn → block sweeping git + push; idle sessions; script edits)
- [x] Roadmap 2 — rule tiering from measured session reach (`just rule-audit`), 11 items moved inject-only
- [x] Roadmap 3 — `just effect-audit`, before/after repeat rate per rule
- [x] Roadmap 6 — rules-writer Step 5b enforced at the write

## Remaining, in recommended order

- [x] **Roadmap 9 — audit rule `prompt` triggers against prompt history.** `scripts/trigger-audit.py` does this for
      memory triggers only. Replay every `prompt` phrase in `~/.claude/batas/triggers.toml` against
      `~/.claude/history.jsonl` (own words only, like the hook), report over-general phrases and never-firing ones.
      Cheapest item; same shape as an existing script.
- [x] **Roadmap 4 — stale-memory audit.** `just memory-audit`: for each memory, extract file paths / symbols / ports it
      names; flag paths that no longer exist (absolute, or relative to the project root the memory slug maps to) and
      symbols GitNexus no longer resolves. Report only — the owner decides.
- [x] **Roadmap 8 — context budget per session.** First MEASURE bytes injected per session from the hook log and
      transcripts (`hook_success` attachments carry the injected text), then cap: past the cap, list ids instead of
      full text. Do not pick the cap before the measurement.
- [x] **Roadmap 5 — one shared memory instead of copies.** `just trigger-audit` shows the same memory copied into up to
      11 Brighty projects. Design decision needed (where the shared copy lives, how MEMORY.md points at it); bring the
      design to the user before building — it touches every project's memory directory.
- [x] **Roadmap 7 — mine lessons from transcripts.** The same error signature fixed 3+ times across sessions becomes a
      DRAFTED lesson + trigger for review. batas never writes rules (`record(type: "lesson")` drafts only).

## Landed 2026-10-07/08

Roadmap 9 `11dae40` (v0.8.0), 4 `410ad4a` (v0.9.0, paths only), 8 `07ea9b9` (v0.10.0), 7 `4453ebb` (v0.11.0); fresh-session
rule check passed (B1, C18, B14 inject their full text). Remaining: roadmap 5 (design with the user) and the user decisions.

## Also open

- [x] Verify the shortened global rules in a fresh session (rules load only at session start): a task that used to
      trigger a dropped detail (pg restore, git stash) — does the agent behave, does batas inject the full text?
- [x] User decisions (settled 2026-10-08: CLAUDE.md stays local; scrape-mono globs fixed in e6839ff9): (a) batas `CLAUDE.md` has never been committed (machine-wide gitignore) — `git add -f` it or keep
      local; (b) scrape-mono `p-platform-adapters.md` / `p-scraping-patterns.md` point at `backend/src/**`, which no
      longer exists, so they never load — fix the globs, delete, or leave; an untracked `all-workflow.md` there is
      another session's.

## Semantic recall and the behaviour question (2026-10-08)

- [x] **Task 13 — semantic search replaces lexical** (`docs/plan/2026-10-08-semantic-recall/plan.md`): batasd
      (EmbeddingGemma 2 + multilingual-e5-small, LanceDB vectors), SQLite removed, MCP recall/check semantic, prompt
      hook gated by a standout gap with late delivery, always-on launchd agent. v0.16.0 (c86deb0, 0418be0, 5c7a901).
- [x] **Task 15 — discriminating behaviour eval**: `evals/behavior-new-eval.py`, 8 traps in NEW code taken from
      lessons that route to no file, both arms without `docs/lessons`; A = batas on, B = batas off and no MCP.
      Result (`evals/results/2026-10-08-behavior-new.json`): A repeated 0/8, B 1/8 (English error copy) — still not
      discriminating. B avoided 7/8 from what the repo already shows (an owner like useHoverTip, a typed cookie
      composable, the charges store). And A got no semantic delivery: every prompt ran cold, and offline none of the 8
      requests clears the 0.07 gate although 7/8 target lessons rank 0-6 in the top 12 — a task prompt names what to
      build, not the trap.
- [ ] **Open design question for the user**: semantic search finds the trap lesson for a task (7/8 in the top 12),
      but the prompt gate (needed against noise) does not let it through. Candidate: run the semantic match at the
      moment the agent WRITES a new file (path + content say far more than the prompt), and inject a standout lesson
      there. Needs the user's go before building; measure with this eval in a repo whose code does not already guard
      the traps.

## Session 3 results and what is still unproven (2026-10-09)

- [x] Funnel behaviour eval (`evals/results/2026-10-08-behavior-funnel.json`): A 4/15 = B 4/15, target delivered 2/15;
      the right memory in context drops Beacon from 6/6 to 0/3. Subagent briefs (v0.17.0) proven by what agents said.
- [x] Memory delivery coverage (handover-03 #1) — v0.18.0: triggers run on warm prompts, memoryGap 0.045, repo-scoped
      code triggers (also on Bash-written files), `repos:` lists. Funnel eval A 2/15 vs B 7/15 repeated; delivery 6/15,
      so the 10/15 bar as written is NOT met; held-out wording reached 0/6 at prompt time until the repos list, then
      A 1/3 vs B 2/3 (n=1/case). `evals/results/2026-10-09-behavior-funnel-v018.json`
- [x] Word-overlap listing removed (handover-03 #2) — 273 -> 0 on 500 replayed prompts, trigger hits 109 -> 116, none lost
- [x] Prompt hook p95 142 -> 106 ms at load 7.4 (handover-03 #3) — parsed-entry cache
- [x] Behaviour proofs (handover-03 #4) — one more round of 4 sessions (cap 6): cumulative 2/2 vs 0/2 for full sessions and for subagents; the briefed subagent this time named the decision only as a closing note
- [x] Pasted blocks (#5, hook log `pasted:true` still has to show the tags reach the hook), path words on the SSE brief
      (#6), `memorySources` deleted (#7)
- [x] User 2026-10-11: interval polling is allowed for Funnel; memory clarified, live-scoreboard checks fixed and re-judged: original set A 2/15 vs B 4/15, held-out with repos list A 0/3 vs B 1/3
