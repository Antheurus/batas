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

# re-embed whatever changed and wait for it (batasd keeps vectors in ~/.batas/vectors.lance; the text stays in its files)
reindex:
    bun -e 'import {ask, start} from "./src/semantic.ts"; const r = await ask({op: "sync", wait: true}, 3600000); if (!r) { start(); console.log("batasd was not running; started it, the first index runs in the background (just semantic-status)"); } else console.log(r)'

# search the corpus from the terminal by meaning, e.g. `just recall "restore a dump into an empty database"`
recall query:
    bun -e 'import {Store} from "./src/store.ts"; const s=new Store(); s.refresh("all"); const hits = await s.search(process.argv[1], {limit: 10, timeoutMs: 30000}); if (!hits) console.log("batasd is starting, retry in a moment"); for (const h of hits ?? []) console.log(h.id.padEnd(60), h.title.slice(0, 90))' "{{query}}"

# stop batasd and start it again on the current code (vectors reload from disk, nothing is re-embedded); through launchd when its agent is loaded
batasd-restart:
    #!/usr/bin/env bash
    if launchctl print "gui/$(id -u)/dev.batas.batasd" >/dev/null 2>&1; then
      bun -e 'import {ask} from "./src/semantic.ts"; await ask({op: "quit"}, 2000)'; sleep 1.5
      launchctl kickstart -k "gui/$(id -u)/dev.batas.batasd"
    else
      bun -e 'import {ask, start} from "./src/semantic.ts"; import {rmSync} from "node:fs"; import {join} from "node:path"; import {config} from "./src/config.ts"; await ask({op: "quit"}, 2000); await Bun.sleep(1500); rmSync(join(config.stateDir, "batasd.spawned"), {force: true}); start();'
    fi
    bun -e 'import {ask} from "./src/semantic.ts"; for (let i = 0; i < 60; i++) { const r = await ask({op: "status"}, 1000); if (r) { console.log("running", r); break; } await Bun.sleep(1000); }'

# run the MCP server as one launchd agent on loopback HTTP, for every session; it exits when src/*.ts changes and launchd starts it on the new code (log ~/.batas/<label minus dev.batas.>.out)
mcp-install repo=justfile_directory() port="3481" label="dev.batas.mcp":
    #!/usr/bin/env bash
    set -euo pipefail
    bun="$(command -v bun)"
    plist="$HOME/Library/LaunchAgents/{{label}}.plist"
    log="$HOME/.batas/{{trim_start_match(label, "dev.batas.")}}.out"
    mkdir -p "$HOME/.batas"
    python3 -c 'import plistlib, sys; bun, repo, port, label, log, plist = sys.argv[1:]; plistlib.dump({"Label": label, "ProgramArguments": [bun, f"{repo}/src/mcp.ts", "--http", "--port", port], "EnvironmentVariables": {"PATH": "/opt/homebrew/bin:/Users/macbook/.bun/bin:/usr/bin:/bin:/usr/sbin:/sbin"}, "WorkingDirectory": repo, "RunAtLoad": True, "KeepAlive": True, "ThrottleInterval": 10, "StandardOutPath": log, "StandardErrorPath": log}, open(plist, "wb"))' "$bun" "{{repo}}" "{{port}}" "{{label}}" "$log" "$plist"
    plutil -lint "$plist"
    launchctl bootout "gui/$(id -u)/{{label}}" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
    for i in $(seq 1 30); do lsof -nP -iTCP:{{port}} -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 0.5; done
    lsof -nP -iTCP:{{port}} -sTCP:LISTEN || { echo "{{label}} is not listening on {{port}}, see $log"; exit 1; }

# stop the MCP agent and start it again on the current code
mcp-restart label="dev.batas.mcp":
    launchctl kickstart -k "gui/$(id -u)/{{label}}"

# MCP agent: launchd state and pid, then the last lines of its log
mcp-status label="dev.batas.mcp" n="20":
    @launchctl print "gui/$(id -u)/{{label}}" | /usr/bin/grep -E '^\s+(state|pid|last exit code|runs) ='
    @tail -n {{n}} "$HOME/.batas/{{trim_start_match(label, "dev.batas.")}}.out"

# remove the MCP agent and its plist, which frees its port
mcp-uninstall label="dev.batas.mcp":
    launchctl bootout "gui/$(id -u)/{{label}}" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/{{label}}.plist"

# batasd: pid, vectors held, whether a sync is running (starts it when it is down)
semantic-status:
    bun -e 'import {ask} from "./src/semantic.ts"; console.log((await ask({op: "status"}, 2000)) ?? "not answering: started it, models load in ~15 s")'

# acceptance 1: the 80 blind EN/ID probes through batasd, right lesson in top 3 (target EN>=35 ID>=36); --all searches every kind
semantic-eval *args:
    bun scripts/semantic-eval.ts {{args}}

# where the hook's cosine floor sits: probe positives kept, real prompts with a hit, trigger-word matches also reached
semantic-calibrate n="300":
    bun scripts/semantic-calibrate.ts {{n}}

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

# error signatures that failed tool calls in several sessions: uncovered ones are lesson drafts, covered ones are rules not working (days, min sessions)
lesson-mine days="30" min="3":
    bun scripts/lesson-mine.ts {{days}} {{min}}

# one memory used by several projects, stored once and symlinked: no args lists copies (identical or drifted); `just memory-share <name> [--from merged.md] [--apply]`
memory-share *args:
    bun scripts/memory-share.ts {{args}}

# route each docs/lessons entry to the file that defines its Simbol, as a path-scoped rule Claude Code loads on Read (dry run; --apply writes, --check fails when stale)
lessons-route repo *args:
    bun scripts/lessons-route.ts {{repo}} {{args}}

# does a lesson reach the agent when it opens the file? fresh claude -p sessions; mode read | bash (sed) | python (costs one session per case)
delivery-eval repo mode="read" cases="15" controls="5" seed="11":
    bun scripts/delivery-eval.ts {{repo}} {{cases}} {{controls}} {{seed}} {{mode}}

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
