# batas shared MCP server — task

**The ask (user, 2026-10-10):** make the batas MCP work the way gitnexus now does — ONE long-lived HTTP server that
every Claude Code session connects to, instead of a `bun src/mcp.ts` child spawned per session. Written as a plan now;
another agent will build it.

**Why it matters:** the machine is a 16 GB MacBook that ran at 95% swap with 16 Claude sessions open (10.7 GB). Each
session carries its own batas MCP (`bun mcp.ts`, measured 58–59 MB idle). gitnexus was moved to a shared launchd HTTP
server on 127.0.0.1:3480 the same day and cut a fresh idle session from 402 MB to 319 MB; batas is the remaining
per-session MCP.

**The one thing that makes this harder than gitnexus:** batas resolves "which project am I in" from
`process.cwd()` in seven places, and three of them WRITE (memory, progress.md, changelog.md). A shared server has one
cwd for every session, so done naively it writes one repo's memory into another repo's directory with no error. The
design below resolves the project per MCP session from MCP `roots` (Claude Code sends the session's cwd — proven over
stdio, see research.md), with an explicit `project_dir` argument above it and a loud refusal below it.

Mode: **Lean** (od-execute). Plan: `plan.md`. Evidence: `research.md`.

## Checklist (DAG: 0 → 1 → 2 → 3 → 4; 5 after 4)

- [ ] **Phase 0 — spike: do `roots` survive Streamable HTTP with real Claude Code?** Gate for the whole design.
- [ ] **Phase 1 — per-session project context in `mcp.ts`, stdio behaviour unchanged.**
- [ ] **Phase 2 — Streamable HTTP mode (`--http --port`), one McpServer per MCP session, shared Store.**
- [ ] **Phase 3 — launchd agent `dev.batas.mcp`, `just` recipes, restart story.**
- [ ] **Phase 4 — switch `~/.claude.json`, register the port, update memory/rules, progress + changelog.**
- [ ] **Phase 5 — acceptance: cross-repo write isolation, fresh-session memory, two live sessions.**

## OPEN — decisions for the user before Phase 3

1. **Port.** Proposed **3481** (next to gitnexus 3480; unregistered in `~/.claude/references/infra.md` and free on
   2026-10-10). The user picks; never choose a port without asking (lessons H1).
2. **Fallback if Phase 0 fails** (Claude Code does not answer `roots/list` over HTTP): writes REQUIRE `project_dir`
   and refuse without it, reads fall back to global-only scope with a note. Agree before Phase 1 hard-codes either.
3. **Keep stdio as a supported mode?** Proposed yes (default with no flag), so a broken shared server can be bypassed
   by flipping one `~/.claude.json` entry back.
