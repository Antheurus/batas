# Lesson drafts from `just lesson-mine` — for the user's review, NOT applied

Source: `just lesson-mine 30 3` on 2026-10-08 (723 sessions). Each trigger was replayed against 30 days of real
commands (49,175): "catches" = failing commands it would have fired on, "fires" = share of all commands it fires on
(an id injects once per session). Applying any of these goes through `rules-writer` (item text in
`~/.claude/rules/p-lessons-injected.md`, full text in `~/.claude/references/lessons-full.md`, trigger in
`~/.claude/batas/triggers.toml`, then `just check`).

## Draft 1 — new item lessons:B56 (inject-only slice, section B)

**Measured:** 46 sessions hit it; the trigger catches 111/114 failing commands and fires on 0.28% of all commands.

> 56. **An unquoted word starting with `=` is a command lookup in zsh, so `echo =====` as a section divider fails with
> `(eval):1: ==== not found`** — and in a `;`-chained inspection the rest still runs, so the output just looks short.
> Quote it (`echo '====='`) or print dividers from `python3 -c`.

```toml
["lessons:B56"]
cmd = ['(^|[;&|(]\s*)echo\s+={2,}']
t_cmd = ['cat a.txt; echo =====; cat b.txt']
```

## Draft 2 — new item lessons:B57 (inject-only slice, section B)

**Measured:** 18 sessions across `.go`/`.vue`/`.ts`; catches 47/47 failing commands, fires on 1.23%.

> 57. **Unquoted `--include=*.go` is a glob to zsh, not a grep flag: with no file literally named like that, zsh aborts
> with `no matches found: --include=*.go` before grep runs.** Quote the pattern (`--include='*.go'`), or search through
> GitNexus / `python3`.

```toml
["lessons:B57"]
cmd = ['--include=[^\s''"]*\*']
t_cmd = ['grep -rn "Foo" backend --include=*.go']
```

## Draft 3 — extend lessons:B20 (no new item: B20 already owns "chained calls inherit cwd")

**Measured:** 15 sessions; catches 28/36 failing commands, fires on 1.33%. B20's only trigger today is
`. ./x.env`, so it never fired on these.

Add one sentence to B20: "A relative `cd backend` in a later call fails with `no such file or directory: backend`
because an earlier call already left the shell there — `cd` by absolute path."

```toml
# appended to ["lessons:B20"]
cmd += ['(^|[;&]\s*)cd\s+(backend|frontend|tests|src)\b']
t_cmd += ['cd backend && go test ./...']
```

## Dropped — `grep` rejecting `\|`

10 sessions showed `rg: regex parse error`, but `grep … \|` ran in 6,086 commands and only 13 of them failed, so `\|`
is not the trap (a trigger would fire on 12% of commands for nothing). B24 already owns "grep is a wrapper here";
nothing to add until the 13 failures show a shared cause.
