---
descriptor: 2026-10-07-batas-roadmap
sequence: 01
supersedes: none
task: docs/plan/2026-10-07-batas-roadmap/task.md
plan: none — not an od-plan orchestration; docs/roadmap.md is the agreed roadmap
research: none
findings: docs/plan/2026-10-07-batas-roadmap/findings.md
written_at: 2026-10-07 16:45 UTC
written_by: cc-toriq session cd4d52e0 (context shortening → batas v0.3.0 … v0.7.0)
reason: user-request
---

# Handover 01 — batas roadmap

## State snapshot

**No DAG.** Items are built one at a time directly in `~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas` (main), each
measured, falsified, committed and pushed on its own. Baselines: batas `de1c688` → `1fd3577`; cc-toriq `3b88112` →
`6e78247`. Both repos clean and equal to origin at handover.

**Task registry** (copied from TaskList; task.md agrees):

| Task | Name | Status | Notes |
|---|---|---|---|
| 1 | Roadmap 6: enforce Step 5b at edit time | complete | `a64d70f`, v0.7.0 |
| 2 | Roadmap 9: audit rule prompt triggers vs prompt history | pending | next — cheapest, same shape as trigger-audit |
| 3 | Roadmap 4: stale-memory audit | pending | |
| 5 | Roadmap 8: context budget per session | pending | measure before choosing a cap |
| 4 | Roadmap 5: one shared memory instead of copies | pending | design goes to the user first |
| 6 | Roadmap 7: mine lessons from transcripts | pending | drafts only |
| 8 | Verify shortened rules in a fresh session | pending | needs a NEW session — do it first thing |
| 7 | User decisions (batas CLAUDE.md, scrape-mono dead p-files) | pending | user's call |

Roadmap items 1, 2, 3 and 6 were completed before the TaskList existed; see `docs/plan/2026-10-07-batas-roadmap/findings.md`.

**Last completed action:** roadmap item 6 landed (`a64d70f`) with v0.7.0 docs (`1fd3577`), tests 45 pass / 0 fail.

**Immediate next action:** (1) run the fresh-session verification (task 8) since this new session is exactly that;
(2) build roadmap item 9: a rule-prompt-trigger audit replaying every `prompt` phrase in
`~/.claude/batas/triggers.toml` against `~/.claude/history.jsonl` with the hook's own-words cut, reporting
over-general and never-firing phrases — extend `scripts/trigger-audit.py` or add `scripts/prompt-audit.ts` reusing
`Triggers.match({prompt})` so matching is identical to the hook.

---

## In-flight context

### User confirmations (verbal, not in artifacts)

- All nine roadmap items are approved ("gas semuanya masuk"); the user wants batas to help them "all out".
- Hooks stay **advisory (warn)** except the collision guard, which the user explicitly asked to block ("benerin").
- Memory triggers are the user's model: rules and memories carry trigger words and batas finds every match.
- The user prefers stage-by-path over `BATAS_ACK_*`; acks are logged in `~/.batas/acks.jsonl` to make reflex acking
  visible.

### Discoveries made mid-run

- A PreToolUse injection lands AFTER the command runs (the hook never blocks except the collision guard), so
  destructive rules must stay always-on even when rare.
- The hook runs from source in EVERY open session the moment a file is saved — a bad change is live machine-wide at
  once (0.6.1 nearly blocked every open session). Test before saving `src/hook.ts`, not after.
- `store.get()` falls back to `LIKE '%id%'` — never use it for an existence check (use an exact query).
- Hermetic tests use a temp claudeHome without a dot: derive every path from `config`, never hardcode `/.claude/`.

### Environment / tooling notes

- Another Claude session is frequently live in cc-toriq; the guard will deny `git push` there — check
  `git log origin/main..HEAD`, then `BATAS_ACK_LIVE=1 git push`. Stage by explicit path.
- Commit bodies: always via `git commit -F - <<'EOF'` — `-m` bodies were blocked by commit-body-guard three times.
- After any `~/.claude` change (skills/batas symlink, settings.json, rules, memory): `just sync` + `just verify` in
  cc-toriq, then commit the mirror.
- batas `CLAUDE.md` is untracked (machine-wide gitignore) — its map is current locally but not in git.

---

## Known issues and blockers

| # | Severity | Description | Status |
|---|---|---|---|
| 1 | watch | Shortened rules are unverified in a fresh session (they only load at session start) | unresolved — task 8 |
| 2 | watch | Collision guard: two sessions' scripts writing the same repo inside one Bash call are indistinguishable by mtime | accepted limit, documented |
| 3 | watch | effect-audit before/after conflates rule wording changes with injection | stated in the script and progress |
| 4 | risk | scrape-mono p-platform-adapters.md / p-scraping-patterns.md never load (dead `backend/src/**` globs) | user decision — task 7 |

---

## Resume prompt

```
RESUME — batas roadmap (not an od-plan orchestration; do NOT invoke od-execute)

Repo: ~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas
Handover: docs/plan/2026-10-07-batas-roadmap/handover-01.md   <- highest number; lower ones are archive
Task: docs/plan/2026-10-07-batas-roadmap/task.md
Findings: docs/plan/2026-10-07-batas-roadmap/findings.md
Roadmap: docs/roadmap.md

Read in this order: handover-01 -> task -> findings -> roadmap.
Then: (1) this is a fresh session, so verify the shortened global rules first (task 8); (2) build roadmap item 9
(rule prompt-trigger audit vs ~/.claude/history.jsonl, reusing Triggers.match so matching equals the hook), then 4, 8,
5 (design to the user first), 7. Each item: measure, build, falsify its test, `just check`, commit by path, push.
```
