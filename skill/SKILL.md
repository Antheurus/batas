---
name: batas
description: >-
  Guardrail memory for this machine: every rule, past mistake, user preference, decision and trick recorded across
  all repos, served by the batas MCP server (mcp__batas__check / recall / get / record / log_progress /
  log_changelog / status). This skill should be used whenever the agent is about to do something that has gone wrong
  before, or wants to know what the user prefers — "pernah kejadian gini belum?", "cek rules dulu", "apa aturannya",
  "inget ini", "catat ini", "simpen ke memory", "jangan sampe keulang", "have we hit this before", "what does the user
  prefer about X", "remember this", "log progress", "tulis changelog", "update progress.md", "batas status", or when a
  batas hook injects a rule into context. Use it proactively before a destructive or unfamiliar command, before
  writing docs/progress.md or docs/changelog.md, and when saving a memory. Not for reading source code — that is
  GitNexus; batas is about behaviour, not code structure.
---

# batas — the guardrail layer

GitNexus answers "what does this code do". batas answers "what has gone wrong here before, and what does the user
want". Both are consulted before acting; neither replaces the other.

The markdown files stay the source of truth — `~/.claude/rules/`, `~/.claude/references/`, per-project `memory/`,
each repo's `.claude/rules/`, `docs/progress.md`, `docs/changelog.md`. batas indexes them (SQLite FTS5 at
`~/.batas/index.db`, refreshed on file mtime) and makes them reachable three ways:

| Path | Fires | Reliability |
|---|---|---|
| **PreToolUse hook** | the moment a Bash command or a Read/Edit/Write path matches a rule's trigger — injects the full rule once per session | deterministic |
| **UserPromptSubmit hook** | prompt phrases — injects one-line hints naming rule ids | deterministic |
| **Stop hook** | the final reply matches a known mistake pattern — blocks once with the rule so the reply gets corrected | deterministic |
| **MCP tools** | when the agent calls them | only as good as the agent's habit |

The hooks are what make it dependable; the tools are for the questions no trigger can predict.

## Loading the tools

The MCP tools are deferred in this harness. Load them in one call before the first use:

```
ToolSearch({query: "select:mcp__batas__check,mcp__batas__recall,mcp__batas__get,mcp__batas__record,mcp__batas__log_progress,mcp__batas__log_changelog,mcp__batas__status"})
```

## Which tool

| Situation | Call |
|---|---|
| About to run a destructive, unfamiliar or production-touching command | `check({command, intent})` |
| About to edit a file in an area not touched yet this session | `check({file, intent})` |
| "Have we hit this error before?" / "how did another repo solve this?" | `recall({query: "<error text or concept>"})` |
| "What does the user prefer about X?" | `recall({query, kinds: ["memory"]})` |
| A hook named an id without its full text (`gotcha:D27`, `lessons:C18`) | `get({id})` |
| The user states a preference, corrects an approach, or confirms one | `record({type: "feedback" \| "user", ...})` |
| A project decision or constraint not derivable from the code | `record({type: "project", ...})` |
| A new gotcha worth a rule | `record({type: "lesson", ...})` → returns a draft plus the closest existing rules; apply it with the `rules-writer` skill |
| End of a session where real engineering landed | `log_progress` + `log_changelog`, same version |
| Is the corpus healthy / are hooks firing / which rules lack triggers | `status()` — also shows hook errors, "batas nyasar" reports and permanent mutes |
| The user says an injected rule or memory keeps being wrong | `mute({id, reason})` (permanent, every session) — then tighten that id's triggers; `unmute: true` reverses |

## Writing through batas

- **Every `record` carries `origin`:** `user-requested` when the user asked for it ("inget ini", "catat"),
  `agent-initiated` when the agent learned it unprompted, and `user-written` when the user wrote the words. Pick
  it from what actually happened, never by default. It is shown next to the id wherever the entry surfaces.
- **Memory** (`record` with user/feedback/project/reference) writes the file and its `MEMORY.md` pointer directly.
  Pass `replace: true` only after reading the existing one with `get` — the tool refuses a silent overwrite.
  Feedback and project bodies carry `**Why:**` and `**How to apply:**` lines; convert relative dates to absolute.
- **Every memory carries `triggers`** — pass 4–10 words or short phrases the user would actually TYPE when it
  applies, Indonesian AND English, colloquial included (`"mac panas, kipas kenceng, overheat"`). A memory written by
  hand gets the same as one frontmatter line, `triggers: "a, b, c"`. A trigger hit is the ONLY thing that injects a
  memory in full, so a memory without triggers is effectively invisible to the hook. Never a bare generic word that
  would fire on unrelated prompts (`fix`, `deploy`, `landing`, or the platform name inside that platform's own repo);
  pair it with its subject instead (`deploy lms`). After adding triggers, run `just trigger-audit` in the batas repo.
- **Rules are never written by batas.** A global rule reaches every repo on the machine, so it goes through
  `rules-writer` (draft, prove absent, pick one owner, edit against a snapshot). `record(type: "lesson")` does the
  duplicate search that step needs.
- **progress/changelog**: `log_changelog` refuses a version that already has a heading or is not newer than the
  newest — two sessions picking the same number is exactly what it prevents. Re-read the newest heading and bump.
  The Stop hooks that demand these docs recognise the batas tools as writes.

## When a hook fires

An injected block starting `batas:` is a rule that matched what is about to happen. Read it before running the
command. **If the user says "batas nyasar" (or salah/ngaco/keliru), the hook mutes what its LAST PROMPT injection brought
(memories, rule hints — never the rules fired by your own tool calls) for the rest of the session and logs the report;
the phrase counts only in the user's own words, not inside a quoted note** — nothing to do unless they want it gone for good, which is `mute`. A fired `gotcha:`/`lessons:` item arrives as its verbatim FULL text (from `~/.claude/references/{gotcha,
lessons}-full.md`), not the condensed line already in context — that is where the recipe and the incident live. On a
prompt, `batas: project memories that may bear on this request` carries up to two memories whose triggers the prompt
said; use one only if it actually applies, and open a listed id with `get` when it bears on the work. When the Stop hook blocks with `batas: your last reply matches a known mistake pattern`, either correct
the reply or the work, or state in one line why the reply complies — it blocks once per stop, never twice.

## Adding a trigger

**Memory triggers live in the memory's own frontmatter (`triggers:`), never in `triggers.toml`.** Matching uses the
user's own words only (quoted `>` lines and side-agent notes are cut), a whole-word hit, and multi-word triggers in any
order. `just trigger-audit [threshold]` replays every memory trigger against `~/.claude/history.jsonl` and reports the
hit rate, memories without triggers, and terms firing on more than 3% of their project's prompts — make those more
specific rather than deleting the memory's only route in.

**Rule triggers** live in `~/.claude/batas/triggers.toml`, one table per id (`["gotcha:B1"]`):
`cmd` (JS regex on a Bash command), `path` (glob on a file path), `prompt` (phrases), `reply` + `reply_ok` (regex on
the final reply; `reply_ok` suppresses), each with `t_*` fixtures that must fire. `bun test` in the batas repo
fails when a fixture does not fire its own rule — that is the recall test, and a rule without a passing fixture is
a rule that can silently stop firing. After a rules change, add or update the entry, then run `just check` in
the batas repo and `just sync` in cc-toriq.

**Rule triggers are audited by replay:** `just rule-audit [days] [share]` runs the real tool calls of recent transcripts
through the hook's own matcher and lists noisy ids (with the share of SESSIONS they reach, since an id injects once per
session) and cmd/path/code ids that never fired — a broken regex and a rare situation look identical until replayed.

**Whether an injection works is measured, not assumed:** `just effect-audit [days] [min]` compares, per rule, how often its
trigger matched AGAIN later in a session, before batas went live versus after. Mistake-shaped rules should drop and
situational ones (`git push`) stay flat as the control. A mistake-shaped rule that does not drop is being ignored,
so fix its wording or delivery. **The collision guard BLOCKS two shapes** (roadmap item 1): a sweeping git command (`add -A`, `commit -a`, bare `stash`,
`checkout .`, `reset --hard`, `clean -f`) while the repo holds a dirty file that is not this session's work — written by
another session (Edit/Write, and any file a Bash command or script changed, via the PostToolUse hook), idle sessions
included, or already dirty before this session started — and a `git push` while another session is live in the same root. Read the denial: it names the files.
**Stage by explicit path — that is the fix in almost every case.** Only after reading each listed file, re-run
prefixed with `BATAS_ACK_FOREIGN=1 ` / `BATAS_ACK_LIVE=1 `; every ack that bypassed a real block is logged and counted in
`status`, so acking by reflex is visible. "Before this session started" means before its transcript was created. Other
shared-checkout git commands only warn.

Repo: `~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas` — `just install | check | recall "<q>" | fire "<cmd>" | log | rule-audit | trigger-audit | effect-audit`.
`just check` includes a latency budget (60 ms tool call, 150 ms prompt, in-process, at ~600-memory scale).
