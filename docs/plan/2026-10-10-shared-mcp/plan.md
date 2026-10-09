# batas shared MCP server — plan

Read `task.md` (the ask, OPEN decisions) and `research.md` (line numbers, probe log, measurements) first. Every phase
ends committed and pushed on `main` with `bun test` green; `just check` stays green throughout (it is the recall test
and the latency budget).

## Design in one paragraph

`mcp.ts` gains a per-MCP-session **context** `{ projectDir?: string, source: "arg" | "roots" | "cwd" | "none" }`.
Project resolution, highest first: **(1)** the tool's explicit `project` / `project_dir` argument; **(2)** the
session's MCP root (`roots/list`, first `file://` root, re-read on `notifications/roots/list_changed`); **(3)**
`process.cwd()` **only in stdio mode** (today's behaviour, unchanged); **(4)** nothing. Reads with no project search
global entries only and say so in the result; **writes with no project refuse** with an error naming `project_dir` —
a wrong-repo write is silent and permanent, a refusal costs one retry. The Store, batasd client and triggers stay
module-level and shared. HTTP mode builds one `McpServer` + transport per `mcp-session-id`, all closing over the
shared Store.

## Phase 0 — spike: `roots` over Streamable HTTP (gate)

**Goal:** prove Claude Code answers `roots/list` when the MCP is `type: http`.

- Write a throwaway Bun HTTP MCP server in the scratchpad (NOT in `src/`) on a free port the user has not reserved:
  answers `initialize`/`tools/list`, sends `roots/list` after `notifications/initialized`, logs every message to a file.
- Attach it to a fresh session WITHOUT touching user config:
  `claude --strict-mcp-config --mcp-config '{"mcpServers":{"probe":{"type":"http","url":"http://127.0.0.1:<port>/mcp"}}}'`
  started in tmux from two different repos (e.g. `cc-toriq`, `batas`), no prompt sent (no tokens).
- **Pass:** the log shows a `roots/list` result per session whose `uri` is that session's repo, and the two sessions
  carry different `mcp-session-id`s.
- **Fail:** stop, record the log in `research.md` §2, and ask the user for OPEN #2 (fallback) before Phase 1.

## Phase 1 — per-session project context, stdio unchanged

**Files:** `src/mcp.ts`, new `src/session-context.ts` (only if it earns its keep — a second caller is Phase 2; inline
otherwise), `tests/`.

- Turn the module body into `createServer(ctx: SessionContext): McpServer`; every `process.cwd()` site in
  research.md §1 reads `ctx` through ONE resolver function `projectOf(ctx, explicit?)` returning
  `{ dir?: string, source }`. No call site touches `process.cwd()` directly afterwards (grep proves it).
- `record`, `log_progress`, `log_changelog`: `projectDir = projectOf(...)`; if `dir` is undefined return
  `fail("no project for this session — pass project_dir (absolute repo path)")`. Add `project_dir` to the input schema
  of any write tool that lacks it.
- `check`, `recall`: scope from `projectOf`; when undefined, search global kinds only and append one line
  `scope: global only (no project known for this session; pass project)`.
- `status`: print `session repo: <name> (source: roots|cwd|arg|none)`.
- stdio entry (`bun src/mcp.ts`, no flag): `ctx` resolves via cwd exactly as today.
- **Tests** (`bun test`): resolver precedence (arg > roots > cwd > none); a write tool with no project refuses and
  writes nothing (assert the target files' bytes unchanged); stdio path still scopes to cwd.
- **Verify:** `bun test`, `just check`, and the existing MCP still works from this session (`status` answers).

## Phase 2 — Streamable HTTP mode

- `bun src/mcp.ts --http --port <p> --host 127.0.0.1`: `Bun.serve` + `webStandardStreamableHttp` from the SDK.
  Sessions map `mcp-session-id → { server, transport, ctx }`; create on `initialize`, delete on transport close and on
  an idle timeout (default 6 h, a config value in `src/config.ts`, not a literal).
- After `notifications/initialized`, call `roots/list` if the client advertised `roots`; store the first `file://`
  root (decoded to a path) in `ctx`; subscribe to `notifications/roots/list_changed` and re-read.
- Bind 127.0.0.1 only; refuse to start on any other host (lessons H10 — a named loopback in config is not a bind).
- **Tests:** an SDK `Client` with a `ListRootsRequestSchema` handler connects over HTTP twice with two different roots,
  calls `status` → each sees its own repo; calls `record` on both → each memory lands in its own project's memory dir
  (use a temp `config.projectsDir`, never the real one); a client with NO roots capability → `record` refuses.
- **Verify:** `bun test`; `curl -s -o /dev/null -w '%{http_code}' http://<LAN-IP>:<p>/mcp` returns `000` (not
  reachable off loopback).

## Phase 3 — launchd agent and restart story

- `~/Library/LaunchAgents/dev.batas.mcp.plist`, modelled on `dev.batas.batasd.plist` and `dev.gitnexus.mcp.plist`:
  `bun <repo>/src/mcp.ts --http --port <OPEN #1>`, `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, log
  `~/.batas/mcp.out`. Install it from a `just` recipe (justfile is the only command interface), plus
  `just mcp-restart` = `launchctl kickstart -k gui/501/dev.batas.mcp`.
- **Restart story (the batas-specific trap):** a shared server keeps serving the old `mcp.ts` after the user edits
  batas. Pick one and implement it: (a) `just check` / the post-commit path calls `just mcp-restart`, or (b) the server
  watches its own `src/*.ts` mtimes and exits(0) when they change so launchd relaunches it. Prefer (b) only if it
  cannot kill an in-flight request; otherwise (a).
- **Verify:** `launchctl print gui/501/dev.batas.mcp` running; `lsof -nP -iTCP:<p> -sTCP:LISTEN` shows only 127.0.0.1;
  kill the pid → launchd brings it back within ThrottleInterval.

## Phase 4 — switch over and record it

- Back up `~/.claude.json` (`cp ~/.claude.json ~/.claude.json.bak.$(date +%s)`), then
  `claude mcp remove batas -s user && claude mcp add --transport http -s user batas http://127.0.0.1:<p>/mcp`;
  `claude mcp list` must show `batas … (HTTP) - ✔ Connected`.
- `~/.claude/references/infra.md`: a row next to `gitnexus-mcp (machine-wide)`.
- Memory: extend `gitnexus-mcp-shared-http-3480` or write a sibling via `mcp__batas__record` (with `triggers`).
- Rules: `~/.claude/rules/batas-first.md` gains the restart line (shared server, `just mcp-restart` after editing
  batas), through the `rules-writer` skill; then `just sync` in cc-toriq.
- `docs/progress.md` + `docs/changelog.md` via `log_progress` / `log_changelog`, same new version.

## Phase 5 — acceptance (from where the user stands)

1. Two fresh Claude sessions in tmux, one in `cc-toriq`, one in `batas`, no prompt: footprint of each session tree
   (expect ≈ 260 MB, no `bun mcp.ts` child) and of the shared server.
2. Cross-repo isolation with the REAL client: in each session run one `record` of a throwaway memory (then delete both
   files) and confirm each landed in its own project's memory dir. This needs model calls — keep it to these two.
3. `status` from each session names its own repo with `source: roots`.
4. Negative path: an SDK client with no roots calling `log_progress` gets the refusal and no file changes.
5. Report numbers before/after (319 MB → measured) in the progress entry.

## Not in scope

The hooks (`src/hook.ts`, one short-lived `bun` per event) are unaffected. batasd is already shared. The 75 MB
plugins/hooks slice of a session is a separate investigation (cc-toriq session 2026-10-10).
