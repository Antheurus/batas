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
- [ ] **Roadmap 5 — one shared memory instead of copies.** `just trigger-audit` shows the same memory copied into up to
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
- [ ] User decisions: (a) batas `CLAUDE.md` has never been committed (machine-wide gitignore) — `git add -f` it or keep
      local; (b) scrape-mono `p-platform-adapters.md` / `p-scraping-patterns.md` point at `backend/src/**`, which no
      longer exists, so they never load — fix the globs, delete, or leave; an untracked `all-workflow.md` there is
      another session's.
