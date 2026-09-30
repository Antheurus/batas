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
| Is the corpus healthy / are hooks firing / which rules lack triggers | `status()` |

## Writing through batas

- **Memory** (`record` with user/feedback/project/reference) writes the file and its `MEMORY.md` pointer directly.
  Pass `replace: true` only after reading the existing one with `get` — the tool refuses a silent overwrite.
  Feedback and project bodies carry `**Why:**` and `**How to apply:**` lines; convert relative dates to absolute.
- **Rules are never written by batas.** A global rule reaches every repo on the machine, so it goes through
  `rules-writer` (draft, prove absent, pick one owner, edit against a snapshot). `record(type: "lesson")` does the
  duplicate search that step needs.
- **progress/changelog**: `log_changelog` refuses a version that already has a heading or is not newer than the
  newest — two sessions picking the same number is exactly what it prevents. Re-read the newest heading and bump.
  The Stop hooks that demand these docs recognise the batas tools as writes.

## When a hook fires

An injected block starting `batas:` is a rule that matched what is about to happen. Read it before running the
command. When the Stop hook blocks with `batas: your last reply matches a known mistake pattern`, either correct
the reply or the work, or state in one line why the reply complies — it blocks once per stop, never twice.

## Adding a trigger

Triggers live in `~/.claude/batas/triggers.toml`, one table per id (`["gotcha:B1"]`, `["memory:<slug>/<name>"]`):
`cmd` (JS regex on a Bash command), `path` (glob on a file path), `prompt` (phrases), `reply` + `reply_ok` (regex on
the final reply; `reply_ok` suppresses), each with `t_*` fixtures that must fire. `bun test` in the batas repo
fails when a fixture does not fire its own rule — that is the recall test, and a rule without a passing fixture is
a rule that can silently stop firing. After a rules change, add or update the entry, then run `just check` in
the batas repo and `just sync` in cc-toriq.

Repo: `~/Documents/PROJECT_MISPAQUL_ATTORIQ/batas` — `just install | test | recall "<q>" | fire "<cmd>" | log`.
