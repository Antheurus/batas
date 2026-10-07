# batas Progress

## Session — 2026-10-07 — v0.3.0 (memory recall on prompt, full-text family injection, compact MEMORY.md)

Three capabilities, driven by the global rules shortening done the same day in cc-toriq (always-on corpus 153.9k → 71.0k bytes, with the original wording of every family item kept verbatim in ~/.claude/references/lessons-full.md and gotcha-full.md). First, render() in hook.ts now resolves a fired gotcha:/lessons: id to its section in the matching full-text reference (config.familyFullText) and injects that text when it is longer. Without this the hook would only repeat the condensed line already in context, exactly when the incident detail matters. Both full-text files were added to allSources("rules"), so the hook's cheap refresh keeps them fresh. Second, a UserPromptSubmit now runs an FTS search over the memories of the session's project (projectSlug(input.cwd); the hook refreshes only that one memory dir via the new Store.refresh(scope, extra) parameter) and injects up to 2 full memory bodies, capped at 1500 chars and deduped per session. A bare FTS hit is always noise, so a memory qualifies only when it shares two distinct content words (≥4 chars, minus an English/Indonesian stopword list) with the prompt, at least one of them in its title or description. Probed on the real corpus with this session's prompts: the first version recalled a sorteer memory for "shorten context" through filler words (masih/banget/perlu); the title requirement plus stopwords removed it while keeping the batas, commit/push and chrome-hegemoni recalls. Hook latency over 5 probes was 20–56 ms warm and 249 ms cold. Third, write.ts gained indexHook() (cut at a clause break ≥30 chars, else a word boundary ≤80, skipping etc./e.g./i.e./vs) used by recordMemory, plus compactMemoryIndex() and `just memory-index [apply]`, which backs up each original to ~/.batas/memory-index-backup. Applied across 33 projects: MEMORY.md total 116,480 → 80,683 bytes. Verified: just check 25 pass / 0 fail (3 new tests: full-text injection, memory recall plus dedupe, unrelated prompt/other cwd recalls nothing); falsified by setting maxMemories to 0, which turned exactly the recall test red. Follow-up: the panas/hot-Mac prompt no longer recalls its memory because the word is in neither title nor description. That is a trade for precision; enriching memory descriptions is the fix if it matters.

---

## Session — 2026-09-30 (cont) — v0.2.0 (tool hints, injected-only reachability gate, origin of every record)

**Tool hints.** A 12-session skill-trigger probe showed 3/8 Indonesian paraphrases reaching batas. The hook path is the lever here (lessons I11), so the UserPromptSubmit branch now also emits `hint:*` entries from `triggers.toml`:
- `hint:record` fires on "inget ya", "jangan sampe keulang", …
- `hint:log` on "catat ke progress", "changelog";
- `hint:recall` on "pernah kejadian", "preferensi gua";
- `hint:check` on "hapus branch", "deploy ulang", "restore dump".

Each injects one line naming the tool, once per session. The hook log showed the hints reaching every positive session. The remaining misses were a harness trap: `--permission-mode plan` forbids writes, so record/log could never be called. Re-running the four write cases unrestricted gave 3/4 on batas, and the fourth went correctly to rules-writer. Overall 7/8 positives, 0/4 negatives.

**Notification filter.** UserPromptSubmit also fires on harness `<task-notification>` turns, and a subagent's report matched five rules. Such prompts are now skipped.

**Reachability gate.** cc-toriq v0.30.0 moved 70 always-on items into injected-only slices whose `paths:` match nothing. A new test fails if any item in a `*-injected.md` slice lacks a cmd/path/code trigger, since such a rule could never reach the agent.

**Origin.** The user asked for every record to say whether the agent or a human started it, because the agent usually writes either way. `record` now requires `origin`:
- `user-requested`
- `agent-initiated`
- `user-written`

For memory it is written into the frontmatter beside `recorded: <date>`, and surfaced as `[type · origin]` in the title. For rules it lives on the rule's `triggers.toml` entry (`origin`, `recorded`), keeping the always-on corpus unchanged, and is shown as `### id · origin` in injections and `origin: … (recorded …)` in `get`. Pre-existing entries carry none. Nothing guesses an origin for them, since a fabricated provenance is worse than a missing one. The only ones set today are those whose origin is known from this session (lessons I10, and the project_batas memory).

Verified: 21 tests, 0 failed. A fresh session's `get lessons:I10` returned `origin: agent-initiated (recorded 2026-09-30)`.

---

## Session — 2026-09-30 (cont) — v0.1.2 (cmd triggers ignore patterns that are only mentioned in a quoted argument)

The v0.1.0 build noted the E24 class as open: `just fire "lsof -ti tcp:59999"` injected lessons:B13 although it only mentioned the pattern, and every `git commit -m "..."` naming a destructive command would fire the same way. `dataSpans()` in `src/triggers.ts` now marks the parts of a command that are DATA: quoted arguments, and heredoc bodies fed to a non-interpreter. A cmd regex counts only when a match starts outside them (`matchOutside`). Code is not data. These stay live:
- arguments to `-c` / `-lc` / `-e` / `--command` / `--eval` / `eval` / `run-code`;
- quoted commands sent through `ssh` / `sshepherd` / `docker exec` / `kubectl exec`;
- heredoc bodies fed to python/node/bun/psql/sh, with no quote scanning inside them.

The first cut was driven by the recall fixtures and turned three red. `playwright-cli eval "..."` (B25, B35) and `ssh srv "docker logs ..."` (B55) are code, which is where the eval and remote rules came from. A python heredoc body containing `os.system('lsof ...')` was then masked by the quote scanner running inside it, which is why interpreter bodies are skipped. Verified: 18 tests, 0 failed, including a new case pinning four mentions that must NOT fire and three code forms that must. A cmd match now averages 0.14ms. A heredoc'd commit body naming `git reset --hard` fires only lessons:C4 (the commit rule), not C7. Known limit: text inside `bun -e '...'` is code by design, so a probe script that merely contains a pattern string still fires.

---

## Session — 2026-09-30 (cont) — v0.1.1 (Stop check no longer blocks a reply that only quotes a mistake)

The first live false positive came from the building session itself. The final report's evidence table quoted the test sentence "Mau saya commit dan push sekarang?", the commit-push reply regex matched it, and the Stop hook blocked a reply that was actually compliant: every commit was already pushed. A reply that quotes a mistaken sentence is not making it, so `unquoted()` in `src/triggers.ts` now removes fenced blocks and multi-word double-quoted spans before reply patterns run. The first cut also stripped inline backticks and single-word quotes. The recall test caught that at once: three fixtures went red, because lessons:B2's signal IS the backticked command (`silakan jalankan \`bun test\``) and hook-warn-not-ask's signal IS the one-word `"ask"`. So both of those stay in the checked text. Verified: 17 tests, 0 failed, with a new case pinning both directions (a quoted sentence and a fenced block pass, while an unquoted "I ran git reset --hard after the \"cleanup\" step" still blocks). Replaying the exact reply that was blocked, taken from the session transcript, through `src/hook.ts` now yields `{}`.

---

## Session — 2026-09-30 — v0.1.0 (guardrail memory: FTS5 index, three hooks, MCP server, skill)

batas exists because the user's hand-written guardrail corpus had grown to ~77k always-on tokens: 289 numbered incident rules in `~/.claude/rules/` plus 215 reference files, 560 memory files across 57 projects, and each repo's progress/changelog. The same session had already split `gotcha-coding.md` and `lessons.md` into path-scoped slices (floor 142.5k to 103.8k tokens), but a `paths:` glob fires only on a Read inside the session's project. That left every command-triggered rule dependent on being always-on. The user asked for a real system rather than more always-on text: an MCP server plus hooks plus a skill, "tooling that the agent can actually see".

**The shape.** The markdown files stay the source of truth, and batas indexes them. `src/corpus.ts` turns rule families into entries under their permanent addresses (`gotcha:D27`, `lessons:C18`), plus rule-file sections, reference sections, memory files, and project rules/progress/changelog/context across `~/Documents/PROJECT_MISPAQUL_ATTORIQ/*`. `src/store.ts` is bun:sqlite FTS5 in WAL mode at `~/.batas/index.db`, refreshed incrementally by mtime: 889 files and ~6,000 entries build once in ~6.4s, a no-change refresh takes 9ms, and the rules-only refresh the hook uses takes 1ms.

**Why SQLite over LadybugDB.** The user asked. The corpus is flat keyword documents, and many sessions run hooks concurrently, which WAL readers handle. Kuzu-family single-writer locking and storage-version mismatches are recorded in the user's own rules as GitNexus incidents. The few relations (`_linked to`, `[[wiki]]`) sit in a `links` table.

**Hooks.** `src/hook.ts` is one entry for PreToolUse (Bash command, Read/Edit/Write path, and the written content itself via a `code` trigger kind), UserPromptSubmit (one-line hints only) and Stop. Stop checks `last_assistant_message` against `reply`/`reply_ok` regexes, blocks once with the rule text, and honours `stop_hook_active`. Injection goes through `hookSpecificOutput.additionalContext`. It is deduped per session in `~/.batas/sessions/`, capped at 3 rules / 9,000 chars, and never sets `permissionDecision`, because `allow` would bypass the user's permission prompts. Every call is logged with its latency to `~/.batas/hook.log.jsonl`.

**MCP.** `src/mcp.ts` exposes seven tools: check, recall, get, record, log_progress, log_changelog, status. `record` writes memory directly (file + MEMORY.md pointer, and refuses a silent overwrite) but only DRAFTS a lesson, returning the closest existing rules, per the user's choice: global rules go through `rules-writer`. `log_changelog` refuses a duplicate or older version; `log_progress` adds `(cont)` itself.

**Triggers.** They live at `~/.claude/batas/triggers.toml`: 294 ids, which is all 289 rules plus 5 memory entries. A subagent drafted them with 468 fixtures. I added `reply` checks for rejected tools, "mau saya commit?" hand-backs and "silakan jalankan `bun test`" hand-backs, plus `code` triggers for defects visible only in written code (`parseInt(x) || def`, batched `Promise.all`, `${x}::jsonb`, two UPDATEs in one CTE, `SELECT DISTINCT gen_random_uuid()`, `createReadStream().pipe(res)`, the Vue optional-boolean prop).

**A bug found while building.** The first real run showed hooks at 300-600ms. Profiling put 298ms of it on compiling one `\p{L}` unicode regex per prompt phrase (~0.4ms each). I replaced that with a lowercase `indexOf` plus one shared boundary test: load dropped to 5ms and a hook call is 30-40ms wall, almost all of it Bun startup.

**Verification.** The `code` triggers then fired while this very progress entry was being written, because it quotes the patterns. So written content is no longer checked for `.md/.mdx/.txt/.rst/.toml` paths, and a test pins both directions. 16 bun tests, 0 failed. Tests are hermetic: rules are copied into a temp home. The recall test runs every fixture against its own id, with 45 negatives averaging 0.02 hits. It was falsified by breaking the C4 regex, which named `gotcha:C4` red, then restored green. `tsc --noEmit` is clean. The MCP was tested over real stdio with the SDK client.

Five real `claude -p` sessions:
- `lsof -ti` injected lessons:B13, and the agent quoted it.
- `mcp__batas__recall` returned gotcha:B1 after ToolSearch.
- A dictated "Mau saya commit dan push sekarang?" was blocked once by the commit-push memory; the second Stop passed.
- An Indonesian paraphrase about restoring a prod dump made the agent call recall on its own.
- A let-vs-const question fired nothing.

The hooks went live in the building session too: lessons:B13, I7 and the slice rule B45 were injected mid-build.

**Integration.** `just install` registered the MCP at user scope (✔ Connected), appended the three hooks to `~/.claude/settings.json` after a timestamped backup, and symlinked `skill/` to `~/.claude/skills/batas`. `progress-changelog-reminder.py` and `rules-memory-reminder.py` now count `mcp__batas__log_*` / `record` (non-lesson) as writes. `rules-memory-reminder`'s own suite reads 7/9, identically before and after that edit: the two failing cases are its POSITIVE controls ("must BLOCK"), a pre-existing defect left for the user to decide on.

**Follow-ups.**
- A command that merely *mentions* a pattern (`just fire "lsof -ti ..."`) still fires, the E24 class.
- In the paraphrase test the skill itself was not invoked; the agent reached recall only after four Bash calls.
- 29 rules are prompt-only, because their moment leaves no command or path signature.
- The next token lever is trimming `lessons.md` to an index now that the injector exists.

---
