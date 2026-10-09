# batas shared MCP server — findings

Append-only, newest at the bottom.

---

## Phase 00 — spike: `roots` over Streamable HTTP — VERIFIED-LIVE (gate passed)

- **Commit:** none in `src/` (spike); probe + logs kept under `phase0-probe/` and committed with this entry.
- **Attempts:** 2 of 3. Claude Code 2.1.296.
- **Result:** Claude Code answers a server-initiated `roots/list` over `type: http`. Two sessions got two
  `mcp-session-id`s (`61041193…`, `8dbb270d…`) and each its own launch cwd as the single root
  (`…/cc-toriq`, `…/cc-toriq/docs`). Orchestrator re-read `phase0-probe/probe.log` and confirmed both RESULT lines.
- **Deviation:** the second session was meant to start in `batas`, but Claude showed the folder-trust dialog there
  and no MCP connect happens behind it; accepting it writes `~/.claude.json`, which the brief forbade. The stand-in
  (`cc-toriq/docs`) proves the same thing — distinct session, distinct root. The cross-repo pair is re-checked with
  real sessions in Phase 05. OPEN #2 (fallback) is therefore not needed; the refuse-on-no-project path still ships.
- **Discovered:**
  1. **Send order:** Claude opens `GET /mcp` (the SSE channel) ~25 ms AFTER `notifications/initialized`. A
     `roots/list` sent from `oninitialized` before that GET exists is silently dropped (no SDK error, 20 s timeout —
     `phase0-probe/probe-attempt1.log`). The server must wait for the session's GET stream before asking.
  2. The request goes out on the GET SSE stream; the answer returns as a separate `POST` (202) with `mcp-session-id`.
  3. Before `initialize`, Claude sends a sessionless `POST server/discover` (protocolVersion `2026-07-28`); SDK 1.31.0
     answers 400 and Claude falls back to `initialize` (`2025-11-25`). Harmless.
  4. The root is the launch cwd, not the git root (subdir launch → subdir root). Same as today's `process.cwd()` in
     a stdio child, so stdio and HTTP resolve identically; `repoName()` must still be applied for scope.
  5. No `notifications/roots/list_changed` and no `DELETE` seen on a hard kill — session cleanup cannot rely on
     DELETE; the idle timeout in Phase 02 is load-bearing.
- **Notes for Phase 01/02:** resolve the root lazily-but-gated (await the GET stream or retry once) rather than
  fire-and-forget at `oninitialized`; a tool call arriving before roots resolve must await that resolution, not fall
  through to "no project".
