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
