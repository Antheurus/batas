default:
    @just --list

# register the MCP server + hooks in ~/.claude and build the index
install:
    bun install
    bun src/install.ts

test:
    bun test

typecheck:
    bunx tsc --noEmit

check: typecheck test

# rebuild the whole index from scratch
reindex:
    rm -f ~/.batas/index.db ~/.batas/index.db-wal ~/.batas/index.db-shm
    bun -e 'import {Store} from "./src/store.ts"; const s=new Store(); console.log(s.refresh("all")); console.log(s.stats())'

# search the corpus from the terminal, e.g. `just recall "pg_dump restore"`
recall query:
    bun -e 'import {Store} from "./src/store.ts"; const s=new Store(); s.refresh("all"); for (const h of s.search(process.argv[1], {limit: 10})) console.log(h.id.padEnd(60), h.title.slice(0, 90))' "{{query}}"

# which rules fire for a command, e.g. `just fire "git stash pop"`
fire cmd:
    bun -e 'import {Triggers} from "./src/triggers.ts"; console.log(Triggers.load().match({cmd: process.argv[1], prompt: process.argv[1]}))' "{{cmd}}"

# hook activity: calls, fires, latency
log n="20":
    tail -n {{n}} ~/.batas/hook.log.jsonl

# shorten every project's MEMORY.md pointer lines to a short hook (dry run; `just memory-index apply` writes, backing up to ~/.batas/memory-index-backup)
memory-index mode="dry":
    bun -e 'import {readdirSync, existsSync} from "node:fs"; import {join} from "node:path"; import {config} from "./src/config.ts"; import {compactMemoryIndex} from "./src/write.ts"; const apply = process.argv[1] === "apply"; let b = 0, a = 0; for (const p of readdirSync(config.projectsDir)) { const f = join(config.projectsDir, p, "memory", "MEMORY.md"); if (!existsSync(f)) continue; const r = compactMemoryIndex(f, join(config.stateDir, "memory-index-backup"), apply); b += r.before; a += r.after; if (r.before !== r.after) console.log(String(r.before).padStart(6), "->", String(r.after).padStart(6), p.slice(0, 70)); } console.log(apply ? "APPLIED" : "DRY RUN", b, "->", a)' "{{mode}}"

# measure memory triggers against the real prompt history: hit rate, memories without triggers, over-general terms (default threshold 3%)
trigger-audit threshold="0.03":
    python3 scripts/trigger-audit.py {{threshold}}

# memories naming a file that no longer exists: stale only when git once tracked it, with the rename target (report only)
memory-audit:
    bun scripts/memory-audit.ts

# replay the real prompt history through every rule `prompt` phrase, own words only like the hook: over-general phrases and rules no prompt reached (share threshold, default 1%)
prompt-audit share="0.01":
    bun scripts/prompt-audit.ts {{share}}

# replay real tool calls from recent transcripts through the rule triggers: noisy and never-firing ids (days, noisy share)
rule-audit days="14" share="0.02" promote="0.3" demote="0.02":
    bun scripts/rule-audit.ts {{days}} {{share}} {{promote}} {{demote}}

# did injections change behaviour? repeat rate of each trigger per session, before vs after batas went live (days per side, min sessions)
effect-audit days="21" min="8":
    bun scripts/effect-audit.ts {{days}} {{min}}
