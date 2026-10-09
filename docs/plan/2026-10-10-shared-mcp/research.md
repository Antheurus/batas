# batas shared MCP server — research

Everything here was measured or read on 2026-10-10. Quote it; do not re-derive it.

## 1. Where batas MCP depends on the session's cwd

`src/mcp.ts` (391 lines, `@modelcontextprotocol/sdk` 1.31.0, transport at line 391:
`await server.connect(new StdioServerTransport())`). `process.cwd()` is read at:

| Line | Tool | Use | Effect if wrong |
|---|---|---|---|
| 74 | `check` | `scope: repoName(process.cwd())` for the semantic search | ranks another repo's memory/rules |
| 110 | `recall` | `const scope = project ?? repoName(process.cwd())` | same |
| 226 | `record` | `projectDir: a.project_dir ?? process.cwd()` | **memory file written into another project's `memory/` dir** — `write.ts:90` `memoryDir()` = `config.projectsDir/<projectSlug(projectDir)>/memory` |
| 263 | `log_progress` | `projectDir: a.project_dir ?? process.cwd()` | **prepends to another repo's `docs/progress.md`** (`write.ts:50`) |
| 287 | `log_changelog` | same | **prepends to another repo's `docs/changelog.md`** (`write.ts:65`), and the version-uniqueness check runs against the wrong file |
| 382 | `status` | `session repo: ${repoName(process.cwd())}` | cosmetic |

`repoName(cwd)` lives in `src/hook.ts` (exported; `hook.ts:1128` runs `main()` only under `import.meta.main`, so the
import has no side effect). It maps a linked worktree back to its main checkout's basename.

Module-level state in `mcp.ts`: one `Store` (`const store = new Store()`), refreshed by `fresh()` at most every 5 s and
nudging batasd via `requestSync()` when files changed. Comment at line 18: "The server lives as long as its Claude
session". The Store is corpus-wide, not per-project, so it can be shared by every session as is.

batasd (the 3.4 GB Python embedding daemon) is ALREADY one launchd process for every session
(`~/Library/LaunchAgents/dev.batas.batasd.plist`); only the thin `mcp.ts` layer is per session.

## 2. Claude Code sends the session cwd as an MCP root (proven over stdio)

A logging stdio MCP server (`roots_probe.py`: answers `initialize`, then sends `roots/list` after
`notifications/initialized`) was attached with `claude --strict-mcp-config --mcp-config <file>` from
`cc-toriq`. Log, verbatim:

```
IN server/discover {...}
IN initialize capabilities: {'roots': {'listChanged': True}, 'elicitation': {'form': {}, 'url': {}}} client: {'name': 'claude-code', 'title': 'Claude Code', 'version': '2.1.296', ...}
IN notifications/initialized
IN tools/list
IN roots/list -> {'roots': [{'uri': 'file:///Users/macbook/Documents/PROJECT_MISPAQUL_ATTORIQ/cc-toriq'}]}
```

So: Claude Code 2.1.296 advertises `roots` with `listChanged`, and answers `roots/list` with exactly one root, the
session's working directory. **Not yet proven: the same over Streamable HTTP** — there the server→client request rides
the SSE stream the client opens with `GET /mcp` (or the response stream of a POST). That is Phase 0.

## 3. How gitnexus does it (the model to copy)

- `gitnexus mcp --http --port 3480 --host 127.0.0.1`, one process under launchd (`dev.gitnexus.mcp`, `KeepAlive`,
  log `~/Library/Logs/gitnexus-mcp.log`), Streamable HTTP at `POST /mcp` plus legacy SSE.
- `~/.claude.json` user scope: `{"type": "http", "url": "http://127.0.0.1:3480/mcp"}`, set with
  `claude mcp add --transport http -s user gitnexus http://127.0.0.1:3480/mcp`.
- Repo resolution, from its own tool description: "repo-scoped read-only tools use the configured MCP default or the
  registered path containing the GitNexus process cwd … If neither applies, specify the `repo` parameter explicitly."
  Under the shared server the process cwd is `$HOME`, so every call must name `repo` — acceptable for gitnexus because
  it only READS. batas writes, so it cannot rely on the agent remembering; hence roots + refuse.
- After a gitnexus upgrade the shared server keeps old code; fix is `launchctl kickstart -k gui/501/dev.gitnexus.mcp`
  (now in `~/.claude/rules/gitnexus-first.md`). **batas has the same trap, worse: the user edits batas itself often,
  and a shared server keeps serving the old `mcp.ts` until restarted.**

## 4. Measurements (idle fresh session, 30–40 s after start, no prompt, `footprint`)

| Variant | Total |
|---|---|
| full setup, both MCPs stdio | 402–409 MB (`claude` 257–264 + gitnexus node 87 + batas bun 58) |
| after gitnexus moved to HTTP | 319 MB (`claude` 260 + batas bun 59) |
| `--strict-mcp-config` (no MCP) | 247–250 MB (three runs) |
| `--bare` | 163–167 MB |

Expected after this plan: a fresh session ≈ 260 MB, plus one shared batas server (measure it; gitnexus's shared server
was 94 MB).

## 5. SDK pieces available (1.31.0)

`dist/esm/server/`: `streamableHttp.js` (Node `IncomingMessage` based), `webStandardStreamableHttp.js` (Fetch
`Request`/`Response` — the fit for `Bun.serve`), `sse.js`, `stdio.js`, `mcp.js`. One `McpServer` connects to one
transport, so the multi-session pattern is a server + transport PER MCP session, keyed by `mcp-session-id`, all
closing over the shared module-level Store.
