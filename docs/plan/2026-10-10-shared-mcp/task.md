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

### Clarifications (2026-10-10, AskUserQuestion)

- Port for the shared server? → **3481** (Recommended).
- Keep stdio as a supported mode? → **Ya, tetap** — default with no flag, the bypass if the shared server breaks.
- OPEN #2 (fallback if roots fail over HTTP) — moot: Phase 00 proved roots work over HTTP (findings.md).

## Execution DAG

Linear chain, every block sequential. Phases 0–4 are executor dispatches; Phase 5 is driven by the orchestrator (needs real Claude sessions and the user's live config).

### Block 1 — sequential
- [x] Phase 00 — spike: `roots` over Streamable HTTP (gate)
  - _Plan: plan.md §Phase 0_
  - _Blocked by: none_

### Block 2 — sequential
- [ ] Phase 01 — per-session project context, stdio unchanged
  - _Plan: plan.md §Phase 1_
  - _Blocked by: Phase 00_

### Block 3 — sequential
- [ ] Phase 02 — Streamable HTTP mode
  - _Plan: plan.md §Phase 2_
  - _Blocked by: Phase 01_

### Block 4 — sequential
- [ ] Phase 03 — launchd agent and restart story
  - _Plan: plan.md §Phase 3_
  - _Blocked by: Phase 02_

### Block 5 — sequential
- [ ] Phase 04 — switch over and record it
  - _Plan: plan.md §Phase 4_
  - _Blocked by: Phase 03_

### Block 6 — sequential
- [ ] Phase 05 — acceptance (from where the user stands)
  - _Plan: plan.md §Phase 5_
  - _Blocked by: Phase 04_

## OPEN — decisions for the user before Phase 3

1. **Port.** Proposed **3481** (next to gitnexus 3480; unregistered in `~/.claude/references/infra.md` and free on
   2026-10-10). The user picks; never choose a port without asking (lessons H1).
2. **Fallback if Phase 0 fails** (Claude Code does not answer `roots/list` over HTTP): writes REQUIRE `project_dir`
   and refuse without it, reads fall back to global-only scope with a note. Agree before Phase 1 hard-codes either.
3. **Keep stdio as a supported mode?** Proposed yes (default with no flag), so a broken shared server can be bypassed
   by flipping one `~/.claude.json` entry back.
