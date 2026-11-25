# batas

*Batas* is Indonesian for "limit" or "boundary". This is the guardrail layer for Claude Code on this machine.
[GitNexus](https://github.com/abhigyanpatwari/GitNexus) tells the agent what the code does. batas tells it what
has gone wrong before and what the user wants. It covers the rules, past mistakes, preferences, decisions and tricks
recorded across every repo.

batas does not own that knowledge. The markdown files stay the source of truth: they are hand-written, mirrored to
git, and readable by a human. batas indexes them and puts them in front of the agent at the moment they matter.

| What gets indexed | Where it lives |
|---|---|
| Global rules (always-on + path-scoped slices), addressed `gotcha:D27`, `lessons:C18`, `cs:12` | `~/.claude/rules/*.md` |
| Incident write-ups and skill references | `~/.claude/references/`, `~/.claude/skills/*/references/` |
| Per-project memory: user, feedback, project, reference | `~/.claude/projects/*/memory/*.md` |
| Project rules, `docs/progress.md`, `docs/changelog.md`, `docs/context/`, `docs/lessons/`, `docs/qa/context.md` | every repo under the project roots |

## How it reaches the agent

| Surface | When | What it does |
|---|---|---|
| `PreToolUse` hook | a Bash command or a Read/Edit/Write path matches a trigger, or the code being written matches a `code` pattern (optionally scoped to one `repo`) | injects the full rule or memory via `additionalContext`, once per session |
| `PostToolUseFailure` hook | any tool call fails with a new error signature (not an interrupt, a user's no, or batas itself), up to 5 per session | one line in the failed result: call `recall` with the error, worded by the agent; logged as `cue:recall` |
| `PostToolUse` hook, Bash | a file the command wrote (heredoc, redirect, script) matches a `code` trigger — a new file whole, a tracked one only its added lines | same, after the write |
| `UserPromptSubmit` hook | a prompt phrase matches | injects one-line hints naming the rule ids |
| `UserPromptSubmit` hook | the prompt says one of a memory's `triggers`, or (batasd warm) a memory stands out by meaning: memory gap ≥ 0.045 | injects up to 2 memory bodies in full, once per session — so `MEMORY.md` only needs a short pointer line (`just memory-index` keeps it short); another project's triggered memory is listed by id |
| `UserPromptSubmit` hook | first prompt of a session in a repo named by a memory's `repos:` (worktrees and subagent briefs too) | lists those memories' titles and ids once — standing decisions recorded under another project (a backend's rules for its frontend), which fresh wording reached 0/6 times through triggers or meaning |
| `UserPromptSubmit` hook | the user says "batas nyasar" / salah / ngaco | mutes what the last prompt injected (memories, rule hints — never a rule fired by a tool call) for the session and logs it to `~/.batas/feedback.jsonl`; `mute` makes it permanent (`~/.batas/muted.json`) |
| `PreToolUse` hook, sweeping git command | `git add -A/./-u`, `commit -a`, `stash` without paths, `checkout .`, `restore .`, `reset --hard`, `clean -f` while the repo has a dirty file that is not this session's work: written by another session (from its Edit/Write calls, and from a `PostToolUse` hook that attributes every file a Bash command or script changed during the call — idle sessions included), or dirty since before this session's transcript was created | **denies**, naming the files; way through: stage by path, or prefix `BATAS_ACK_FOREIGN=1 ` |
| `PreToolUse` hook, `git push` | another session logged in the same repo root within 15 minutes | **denies**; way through: check `git log @{u}..HEAD`, then prefix `BATAS_ACK_LIVE=1 ` |
| `PreToolUse` hook, other shared-checkout git command | another session live in the same root | warns once per set of sessions |
| `PreToolUse` hook, always-on family rule | a family trigger fires (`gotcha:`, `lessons:`, `cs:`, ...) | injects the item's verbatim full text from `~/.claude/references/{gotcha,lessons}-full.md` or `~/.claude/references/rules-full/<file>`, not the condensed line already in context |
| `Stop` hook | the final reply matches a known mistake pattern | blocks once with the rule, and honours `stop_hook_active` |
| MCP `batas` | when the agent calls it | `check`, `recall`, `get`, `record`, `log_progress`, `log_changelog`, `status`; `check` and `recall` carry `_meta["anthropic/alwaysLoad"]`, so Claude Code keeps them out of tool search and the first call needs no `ToolSearch`; `recall` also names the `[[linked]]` memories of its top memory hits, both directions |
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

Rule ids are permanent addresses. Deleting or moving a numbered rule out of the corpus means adding its id to
`~/.claude/batas/retired-ids.txt` (`<family>:<ID>  # <date> <where it went>`); `just check` fails on a gap that is not
listed there and on a listed id that a new rule has taken.

### Rule families

Every numbered rule file is a family, mapped in `src/config.ts` (`families`, `familyLettered`, `familyFullText`):

| File | Prefix | Numbering | Full text |
|---|---|---|---|
| `gotcha-coding.md` + `p-gotcha-*.md` | `gotcha` | lettered, `## D. ...` then `27. ` → `gotcha:D27` | `references/gotcha-full.md` |
| `lessons.md` + `p-lessons-*.md` | `lessons` | lettered → `lessons:C18` | `references/lessons-full.md` |
| `coding-standard.md` | `cs` | file-wide → `cs:12` | `references/rules-full/coding-standard.md` |
| `02-definition-of-done.md` | `dod` | file-wide | `references/rules-full/02-definition-of-done.md` |
| `03-real-verification.md` | `ver` | file-wide | `references/rules-full/03-real-verification.md` |
| `04-ui-consistency.md` | `ui` | file-wide | `references/rules-full/04-ui-consistency.md` |
| `05-design-then-scope.md` | `bduf` | file-wide | `references/rules-full/05-design-then-scope.md` |
| `gitnexus-first.md` | `gnx` | file-wide | `references/rules-full/gitnexus-first.md` |
| `batas-first.md` | `bf` | file-wide | `references/rules-full/batas-first.md` |
| `primitive.md` | `prim` | file-wide | `references/rules-full/primitive.md` |
| `progress-changelog.md` | `pc` | file-wide | `references/rules-full/progress-changelog.md` |
| `commit-message.md` | `cm` | file-wide | `references/rules-full/commit-message.md` |
| `python-c-over-bash.md` | `py` | file-wide | `references/rules-full/python-c-over-bash.md` |

`00-index.md`, `01-request-fidelity.md` and `persona.md` are not families: they stay whole and always-on.

A file-wide family counts items only once the file carries the line `<!-- batas:numbered -->`; until then it is
indexed by `##` section like any other rule file. In a converted file an item is a top-level line `N. **...**` (no
indent, outside a code fence), running to the next item or heading; `N` is unique in the file and permanent. Its full
wording sits in the family's full-text file under `## N` (the file opens with a `# ` title line). `just check` fails
when a converted item has no `## N` section; the hook falls back to the condensed line instead of throwing.

## Commands

| | |
|---|---|
| `just install` | registers the MCP server (user scope), adds the three hooks to `~/.claude/settings.json` (after writing a backup), links the skill, and builds the index |
| `just check` | typecheck + tests |
| `just recall "restore a dump into an empty database"` | search by meaning from the terminal |
| `just semantic-status` / `just batasd-restart` | is batasd up, how many vectors; restart it on the current code |
| `just semantic-eval [--lessons\|--repo\|--all]` / `just semantic-calibrate` | recall quality on the 80 blind probes; where the prompt gate sits |
| `just delivery-check` | after a rule move: 6 fresh `claude -p` sessions (4 moved/converted global rules, 2 controls) each Read a harmless file at a rule's path fixture; exits 1 when delivery drops against the saved `.delivery-eval-rules.json` (the first run saves the baseline). `bun scripts/delivery-eval.ts --compare <previous.json> <current.json>` runs only the comparison |
| `just eval` | the scorecard below: does batas change behaviour, and is what it injects relevant |
| `just eval-label` | pairs to label by hand for the relevance judge (`evals/relevance-labels.json`) |
| `just fire "git stash pop"` | which rules a command or phrase fires |
| `just log` | recent hook calls: what fired, and how many ms it took |
| `just reindex` | re-embed whatever changed, and wait for it |

State lives in `~/.batas/`: `vectors.lance` (batasd's embeddings), `batasd.sock` / `batasd.log`, `sessions/` (which
rules each session was already given) and `hook.log.jsonl`. The text itself is never copied: the hook and the MCP server
parse the markdown files directly (the rules in ~8 ms, all ~8,000 entries in ~265 ms).

## Measuring it — `just eval`

Five evals over the last 30 days of real sessions. Each is a set of cases with a baseline and a 95% interval (Wilson;
Newcombe for a difference), so a change to a rule, a trigger or the daemon shows up as a number that moved. Every run is
saved to `~/.batas/eval/` and the next one prints the change against it.

| | Case | Baseline | Verdict |
|---|---|---|---|
| Prevention | a mistake in a session (an error signature seen in 3+ sessions): after its rule was injected, was it made again on a later call? | mistakes no rule covers (the same mistakes un-reminded are printed too, but they are mostly calls the trigger does not match, so they are not a control) | `fewer` / `more` only when the whole interval of the difference is on one side of zero |
| Relevance | a memory a trigger word pulled into a prompt: did it help with that prompt? | — | the share of hand labels marked relevant is the triggers' precision; only `held-out` labels (not the ones trigger edits were chosen on) measure a change. The embedding judge (top 10% of the project's memories) is printed beside it with its own accuracy, and lists noise candidates for a person to read |
| Coverage | the same mistakes: does a rule fire on them at all? | — | the uncovered ones are lesson candidates |
| On time | the prompt's semantic match inside the 150 ms budget; hook latency within budget | — | — |
| Initiative | a failed tool call (once per session and error signature), and a destructive command (`reset --hard`, push `--force`, `branch -D`, `checkout .`/`restore .`, `stash drop`, `DROP`/`TRUNCATE` run by a SQL client, `docker volume rm`, `compose down -v`, `migrate reset`): did the agent call `recall` or `check` within the next / last 5 calls, unasked? Also the share of sessions that asked at all, and how many first asks needed a `ToolSearch` | `--cutover=<ISO>` splits the failure cases before and after a change; cued failures are printed apart | measured 2026-11-26, before the cue and `alwaysLoad`: 11/6,151 failures (0.2%), 0/534 destructive commands, 118/3,437 sessions asked, 92/118 first asks loaded the tool first |

The numbers are only as good as their judges, so the report starts with them. **When a rule was injected is replayed
from the transcript** (the hook injects a rule once, on its first trigger match), **against `triggers.toml` as it was
when that session started** (its git history in the cc-toriq mirror, `BATAS_TRIGGERS_HISTORY`), **and checked against the
hook log** on the covered cases of the days the log still holds. **The relevance judge is scored against hand labels** in `evals/relevance-labels.json`:
two variants — the whole prompt, and the prompt with the trigger words cut out — and the one with the higher balanced
accuracy is used. A label is a person's (or an agent's, named in `by`) call that the memory helps with that prompt; add
more with `just eval-label`. The semantic ranking itself is checked on the 80 known-answer probes of `just semantic-eval`.

## Search is semantic, triggers are not

- **Search by meaning.** `recall`, `check`'s related list, the prompt hook's memory and rule matching, and lesson lookup
  go through `batasd/batasd.py`: EmbeddingGemma 2 (text only) and multilingual-e5-small, fused by reciprocal rank. On 80
  blind English and Indonesian queries against 40 lessons it found the right one in the top 3 for 35/40 and 36/40,
  where the SQLite BM25 it replaced managed 18/40 and 33/40 (`evals/semantic-compare.py`, `just semantic-eval`).
- **One warm process, idled out after 180 minutes.** `just install` adds a launchd agent (`dev.batas.batasd`) that starts
  batasd at login and restarts it only after a crash. After 180 minutes with no request it exits (`BATASD_IDLE_MIN`, `0` =
  never; the user's choice 2026-10-09, reversing always-on) and the next hook call starts it again, so the first prompt
  after a long break goes on with trigger words only while the models load (~10 s). Measured
  2026-10-08: ~3.5 GB footprint on the GPU (`BATASD_DEVICE=cpu`: ~1.05 GB, but 0.2-2 s per query under load), 0.03 s
  of CPU per 150 s idle, 11% of one core at 3.5 queries a second.
- **A prompt never waits.** The hook gives batasd what is left of its 150 ms budget. An idle Apple GPU answers its first
  query in 0.5-0.7 s, so such a prompt goes on with trigger words only, and its search finishes in batasd under the
  session id; the session's next hook call, normally the turn's first tool use, picks it up and injects it.
- **Only a hit that stands out arrives.** A nearest neighbour always exists, so the hook injects the single best match
  only when its Gemma cosine stands at least 0.07 above this repo's 10th-best (about 5% of real prompts;
  `just semantic-calibrate`). Trigger words stay alongside: semantic reaches only a few of the memories they reach.
- **Command, file and code triggers stay regex** (`~/.claude/batas/triggers.toml`, the collision guard). A command is a
  literal surface, and a safety path should not be fuzzy or slower on every tool call. Decided with the user on
  2026-10-08.

## batas and Graphify

[Graphify](https://github.com/Graphify-Labs/graphify) comes up as the obvious ready-made alternative. It was measured
against this machine's real usage on 2026-08-12 and re-checked on 2026-09-30 and 2026-10-08 (v0.9.80, the current
release). It answers a different question, so it does not replace batas.

| | Graphify | batas |
|---|---|---|
| What it knows | the structure of a folder: code, docs, papers, images, video | what went wrong before and what the user wants: rules, incidents, memories, lessons, progress |
| Source | tree-sitter AST for code (deterministic, local); a model for docs and media | the hand-written markdown, parsed in place, never copied |
| Search | graph traversal; "Not a vector index. No embeddings, no vector store" (its README) | semantic: two local embedding models, Indonesian and English |
| When it reaches the agent | when the agent queries the graph; the Claude Code install adds a nudge in `CLAUDE.md` and a PreToolUse hook | on its own: a rule fires on the command or file, a lesson on the code being opened, a memory on the prompt |
| Overlap here | the same job as GitNexus, already installed and indexed across every repo | none: GitNexus covers code structure, batas covers behaviour |

Why it is not used:

- **Two code graphs is one concern with two owners.** GitNexus already holds the AST graph for every repo here and
  the rules require it before every edit. A second graph would drift from the first with nothing to reconcile them.
- **It has no answer for what batas is for.** A graph of the code cannot say that `pg_dump` into a migrated database
  drops tables, or that the user wants hooks to warn instead of ask. That knowledge lives in prose, which Graphify
  does not search by meaning.
- **The context it saves is not where the cost is.** The 2026-08-12 measurement put the expensive part in the
  always-loaded rules (~52k tokens on every first call), not in tool output. batas cut that floor by moving rules
  into slices and injected items; Graphify does not touch it.

What batas took from it (roadmap 11-13, `docs/roadmap.md`):

- **Resolve a lesson's `Simbol:` through the GitNexus graph** instead of the declaration regex in `src/lessons.ts`,
  the same deterministic-AST idea without a second parser.
- **Provenance on every route.** Graphify tags each edge `EXTRACTED` or `INFERRED`; a routed lesson should say
  whether its file link is a declared symbol (exact) or an owner or field fallback (inferred).
- **A per-repo lesson map**, the counterpart of its `GRAPH_REPORT.md`: files carrying the most lessons, lessons that
  route nowhere (264 in mendadak-pos), stale routes, and the delivery-eval history.


## batas and cocoindex-code

[cocoindex-code](https://github.com/cocoindex-io/cocoindex-code) was checked on 2026-10-09. It is semantic search over
source code: tree-sitter AST chunks, one embedding model (`snowflake-arctic-embed-xs` locally, or a cloud provider
through LiteLLM), LMDB + SQLite per repo, and a single MCP tool, `search`. Like Graphify, it answers a code question, so
it overlaps GitNexus, not batas.

| | cocoindex-code | batas |
|---|---|---|
| What it knows | where code doing X lives, across 28+ file types | rules, incidents, memories, lessons, progress |
| Chunking | AST nodes (functions, classes) | markdown items and sections, one memory per file |
| Embeddings | one model; asymmetric query/document params | two local models fused by RRF; e5 `query:`/`passage:` prompts already used |
| Daemon | starts on first use, exits after 180 min idle | starts at login via launchd, exits after 180 min idle, on the GPU |
| When it reaches the agent | when the agent calls `search`; its hooks only re-index | on its own: rule on command or file, memory on prompt, Stop check on the reply |
| Scope | one repo | every repo under the project roots |
| Evidence | "token saving by 70%", no method given | the recall test, plus 80 blind EN/ID probes |

Why it is not used:

- **Two code indexes is one concern with two owners.** GitNexus already holds the code graph for every repo, which is
  the same reason Graphify was turned down.
- **It has no answer for what batas is for.** Code search cannot say that a dump restored into a migrated database
  drops tables.
- **A pull-only tool gets forgotten.** 25 of 33 measured sessions made zero GitNexus calls; batas is hook-driven for
  exactly that reason, and an MCP-only `search` would share the problem.

Nothing was taken from it: incremental re-indexing, asymmetric query/document prompts and a warm model-holding
daemon that idles out are all already in batas, and AST-level code search belongs to GitNexus.
