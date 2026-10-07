# batas

*Batas* is Indonesian for "limit" or "boundary". This is the guardrail layer for Claude Code on this machine.
[GitNexus](https://github.com/abhigyanpatwari/GitNexus) tells the agent what the code does. batas tells it what
has gone wrong before and what the user wants. It covers the rules, past mistakes, preferences, decisions and tricks
recorded across every repo.

batas does not own that knowledge. The markdown files stay the source of truth: they are hand-written, mirrored to
git, and readable by a human. batas indexes them and puts them in front of the agent at the moment they matter.

| What gets indexed | Where it lives |
|---|---|
| Global rules (always-on + path-scoped slices), addressed `gotcha:D27`, `lessons:C18` | `~/.claude/rules/*.md` |
| Incident write-ups and skill references | `~/.claude/references/`, `~/.claude/skills/*/references/` |
| Per-project memory: user, feedback, project, reference | `~/.claude/projects/*/memory/*.md` |
| Project rules, `docs/progress.md`, `docs/changelog.md`, `docs/context/` | every repo under the project roots |

## How it reaches the agent

| Surface | When | What it does |
|---|---|---|
| `PreToolUse` hook | a Bash command or a Read/Edit/Write path matches a trigger | injects the full rule via `additionalContext`, once per session |
| `UserPromptSubmit` hook | a prompt phrase matches | injects one-line hints naming the rule ids |
| `UserPromptSubmit` hook | the prompt shares two content words with a memory of the session's project (one in its title or description) | injects up to 2 memory bodies in full, once per session — so `MEMORY.md` only needs a short pointer line (`just memory-index` keeps it short) |
| `UserPromptSubmit` hook | the user says "batas nyasar" / salah / ngaco | mutes the last injection for the session and logs it to `~/.batas/feedback.jsonl`; `mute` makes it permanent (`~/.batas/muted.json`) |
| `PreToolUse` hook, always-on family rule | a `gotcha:`/`lessons:` trigger fires | injects the item's verbatim full text from `~/.claude/references/{gotcha,lessons}-full.md`, not the condensed line already in context |
| `Stop` hook | the final reply matches a known mistake pattern | blocks once with the rule, and honours `stop_hook_active` |
| MCP `batas` | when the agent calls it | `check`, `recall`, `get`, `record`, `log_progress`, `log_changelog`, `status` |
| Skill `batas` | on its trigger phrases | tells the agent which tool fits which situation |

The hooks are the reliable path, because they fire without the agent having to remember anything. The MCP tools
are for questions no trigger can predict.

## Writes

- `record` with type `user`, `feedback`, `project` or `reference` writes the memory file and its `MEMORY.md`
  pointer directly. It refuses to overwrite silently.
- Every `record` takes a required `origin`, which states who started the record. The agent usually does the writing
  either way, so this is the one fact the file cannot show:
  - `user-requested`: the user asked for it to be remembered.
  - `agent-initiated`: the agent noticed it unprompted.
  - `user-written`: the user wrote or dictated the words.

  For a memory, `origin` is written into its frontmatter along with `recorded: <date>`. For a rule, it goes on the
  rule's entry in `triggers.toml`. It is shown next to the id in hook injections, in `get`, and in `recall` titles.
  Entries that predate this field carry no origin; nothing guesses one for them.
- `record` with type `lesson` only **drafts**. It returns the closest existing rules and never writes to
  `~/.claude/rules/`. Global rules reach every repo, so they go through the `rules-writer` skill.
- `log_changelog` refuses a version that already has a heading or is not newer than the newest one.
- `log_progress` adds `(cont)` automatically for a second entry the same day.

## Triggers

Triggers live in `~/.claude/batas/triggers.toml`, next to the rules they fire, and are mirrored with them:

```toml
["gotcha:B1"]
cmd      = ['\bpg_restore\b']           # JS regex, case-insensitive, matched against a Bash command
path     = ['**/*.dump']                # glob matched against a Read/Edit/Write path
prompt   = ['pg_dump', 'restore database']
reply    = ['...']                      # regex on the final reply (Stop hook)
reply_ok = ['...']                      # suppresses a reply match
t_cmd    = ['pg_restore -d app x.dump'] # fixtures: each must fire this id
```

`bun test` is the **recall test**. Every fixture must fire its own rule, and ordinary commands must stay quiet. A
rule whose fixture stops firing turns the suite red instead of failing silently in a real session.

## Commands

| | |
|---|---|
| `just install` | registers the MCP server (user scope), adds the three hooks to `~/.claude/settings.json` (after writing a backup), links the skill, and builds the index |
| `just check` | typecheck + tests |
| `just recall "pg_dump restore"` | search from the terminal |
| `just fire "git stash pop"` | which rules a command or phrase fires |
| `just log` | recent hook calls: what fired, and how many ms it took |
| `just reindex` | rebuild the index from scratch |

State lives in `~/.batas/`: `index.db` (SQLite FTS5, WAL), `sessions/` (which rules each session was already given)
and `hook.log.jsonl`.

## Why SQLite FTS5 and not a graph or embeddings

- **Shape of the data.** The corpus is a few thousand flat documents, and the questions are keyword questions
  ("pg_dump", "git stash", an error string). BM25 answers those exactly.
- **Concurrent sessions.** Many sessions run hooks at once, and WAL mode takes many concurrent readers.
- **Nothing to install.** It is built into Bun, with no native addon to load on every hook call.
- **Relations.** The few relations that exist (`_linked to`, `[[wiki]]`) sit in a `links` table.
- **Embeddings** can be added later as a fallback if keyword recall proves insufficient. The recall test is what
  will say so.
