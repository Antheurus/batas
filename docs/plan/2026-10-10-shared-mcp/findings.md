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

---

## Phase 01 — per-session project context — executor return (SHIPPED-UNVERIFIED)

- **Commit:** `d45486d` (on `wip/shared-mcp`, worktree `../batas-wt-shared-mcp`, not on main yet). Attempts 1/3.
- **Files:** `src/mcp.ts` (module body → `createServer(ctx)`, inline async `projectOf(ctx, explicit?)`, exported
  `firstRoot(server)`, `roots/list_changed` handler only when ctx has no cwd), `tests/batas.test.ts`
  (`describe("session project")`, 5 tests). 77 pass / 0 fail; typecheck rc 0; one `process.cwd` at the stdio entry.
- **Deviations:** no `session-context.ts` (inline); `recall.project` is a repo NAME so stays
  `project ?? repoName(projectOf(ctx).dir)`; global-only = kinds rule/rule-section/reference.
- **Discovered:** Phase 2 must set `ctx.root = firstRoot(server)` only after the client's GET stream opens.

## Audit — Block 2 (Phase 01 @ d45486d) — RECEIPT, 3 findings

Auditor drove stdio with a real SDK client from a temp git dir (status `source: cwd`, recall/check scoped, record +
log_changelog into temp dirs), no-project refusal ×3 tools ×3 calls, spaced root uri, list_changed re-resolve — all
VERIFIED-LIVE. Receipt verbatim:

1. **`src/mcp.ts:51-57` (`projectOf`) and `:59-67` (`firstRoot`): waiting for roots has no timeout of its own.**
   `projectOf` awaits `ctx.root` with nothing bounding it; the only limit is the SDK's default `listRoots` timeout of
   60 s. A client that advertises roots, sends `list_changed` and never answers `roots/list` blocks every tool call
   ~60 s, including `check`. failing check: `bun test tests/audit-phase1.test.ts -t "NEVER answered"` → expected
   `status returned after <2000 ms`; measured **59986 ms**.
2. **record/log_progress/log_changelog (`projectOf(ctx, a.project_dir)`): `project_dir` and root paths are never
   validated.** A relative `project_dir` writes relative to the server's own cwd (an indirect `process.cwd()`); a
   non-existent `project_dir` or a root pointing at a missing dir is silently created with `docs/` inside. failing
   check: `bun test tests/audit-phase1.test.ts -t "bad project_dir"` → expected `PROBE relative project_dir: true`
   and `PROBE nonexistent project_dir: true … created: false`; currently `undefined … landed in process cwd: true` and
   `undefined … created: true`.
3. **`src/mcp.ts:236`: `record.project_dir` still says "Defaults to the session's working directory"**; log_progress
   and log_changelog `project_dir` have no description. failing check:
   `grep -c "Defaults to the session's working directory" src/mcp.ts` → expected `0` (currently `1`).

Informational: a non-`file://` uri anywhere in the root list makes the SDK reject the whole list → `source: none`
(spec-violating client; not filed). The auditor's probe file hung `just check` past 300 s when run with the main
suite (the 60 s never-answered probe) — must not join the default suite unbounded. Probes salvaged to the session
scratchpad and handed to the fix executor.

**Resolution:** folded into the next dispatch as a receipt fix on top of Phase 02 (Phase 02 already bounds the
initial roots request with `config.http.rootsMs`; the `list_changed` path is still unbounded — Phase 02 executor
found the same).

## Phase 02 — Streamable HTTP mode — executor return (SHIPPED-UNVERIFIED, audit pending)

- **Commit:** `c424d56` (on `wip/shared-mcp`). Attempts 1/3.
- **Files:** `src/config.ts` (`http: { host: "127.0.0.1", idleMs: 6h, rootsMs: 5000 }`), `src/mcp.ts`
  (`serveHttp(port, host)`, `parseArgs` entry; session `{server, transport, ctx, streamOpened, idle}`; sessionless
  non-initialize → 400 without a session (Claude's `server/discover`), unknown sid → 404; host ≠ 127.0.0.1 refused
  before bind and re-checked after listen), `tests/batas.test.ts` (`describe("over HTTP")`, 5 tests).
- **Reported:** 82 pass / 0 fail; late-GET test fails without the gate (falsified); loopback 400 / LAN `000`;
  `lsof` 127.0.0.1 only; `--host 0.0.0.0` exit 1; idle server footprint **55 MB**.
- **Discovered:** Bun's default `idleTimeout` (10 s) cuts the SSE stream before the SDK's 15 s keep-alive —
  `idleTimeout: 0` is required. GitNexus index for batas is stale (8f06f18), no Phase 1/2 symbols.
- **Duration finding:** Phase 02 executor ran 34 min, the Phase 01 audit 36 min; both transcripts show the same two
  silent windows (20:10–20:26 and 20:28–20:43) — ~31 min of shared external stall (API/harness), not the plan or a
  slow check.

## Phase 01 receipt fix — `ebfc226` — receipt cleared (re-audit: orchestrator re-ran the receipt's checks)

- Fix executor 1/3: `firstRoot` passes `{ timeout: config.http.rootsMs }` to `listRoots` (both the HTTP initialize
  path and the `list_changed` handler); `projectOf` refuses a relative or non-existent `project_dir` ("project_dir
  must be an absolute path to an existing directory") and treats a root pointing at a missing dir as no project; one
  shared `PROJECT_DIR` description for record/log_progress/log_changelog. Probe file results before folding:
  never-answered 286 ms (was 59986 ms); relative + nonexistent refused, `created: false`. Probes folded into
  `tests/batas.test.ts` as assertions; audit-phase1* files deleted; falsified against the pre-fix `mcp.ts` (4 new
  regression tests fail there).
- **Re-audit (orchestrator, worktree at ebfc226):** `bun test` → 87 pass / 0 fail [9.40s]; `tsc --noEmit` → 0;
  `grep -c "Defaults to the session's working directory" src/mcp.ts` → 0; `grep -n process.cwd src/mcp.ts` → one hit
  (line 536, stdio entry); `ls tests` → batas.test.ts, preload.ts; `bun test -t "session project"` → 15 pass / 0
  fail, with named tests for the bound (line 951), relative/non-existent refusal (837), missing-dir root (825, 938),
  spaced uri (929). **Phase 01: VERIFIED-LIVE for the receipt surface; block 2 closed.**
- **Discovered (not fixed, recorded):** an empty `project_dir` (`""`) falls back to the session's project rather
  than refusing; a non-file uri before a file uri in roots → no project (SDK schema rejects the list); a failing
  bound test can leave `rootsMs` at 300 and take the late-GET test down with it.

## Audit — Block 3 (Phase 02 @ c424d56) — RECEIPT empty (clean)

All VERIFIED-LIVE by the auditor in its own worktree: suite 82/0 (97/0 with its 15-test audit file); 60 concurrent
calls from two root-distinct HTTP clients → each memory dir got exactly its own 15 files, zero crossover; one
session's unknown tool / zod-invalid record / bad project_dir did not disturb the other; DELETE → 200 then 404, fresh
init works; `idleMs=400` with 50 abandoned sessions → all 404 after 1.2 s, heap 60.6 → 44.1 MB; sessionless
`server/discover` → 400, no sid; non-JSON / batch-with-initialize / GET or DELETE without sid / 20 MB body → 400
generic, wrong Accept → 406, wrong path → 404, no stack or path in any body; bind on 47483 → lsof 127.0.0.1 only,
LAN and `[::1]` → 000; `--host` localhost / ::1 / 0.0.0.0 / LAN IP / "127.0.0.1 " all refused exit 1; stdio →
`(source: cwd)`. **Real Claude Code 2.1.296** over HTTP (47486, temp `BATAS_CLAUDE_HOME`, tmux from cc-toriq, no
prompt): `roots/list` answered in 27 ms with `file:///…/cc-toriq`; held 20 s past the 15 s keep-alive, one roots
request, no reconnect.

Out-of-scope note from the auditor: `project_dir: "/nonexistent/zzz\0"` wrote at c424d56 (pre-fix). Orchestrator
re-checked at ebfc226: `projectOf({}, "/nonexistent/zzz\0")` now throws `ERR_INVALID_ARG_VALUE` (the SDK turns a
thrown tool error into `isError`, nothing written); `projectOf({}, "")` → `{source: none}`.
Auditor's `tests/http-audit.test.ts` (15 tests) + `audit-roots-logger.ts` salvaged to the session scratchpad
(`audit02-salvage/`) — candidates to fold into the suite. **Phase 02: VERIFIED-LIVE; block 3 closed.**

## Phase 03 — launchd agent and restart story — executor return (SHIPPED-UNVERIFIED, audit pending)

- **Commit:** `5c4a558` (on `wip/shared-mcp`). Attempts 1/3. **Duration 2 h 42 min** — far past the 15 min bar; most
  of it went to diagnosing the TCC hang below (a launchd-started bun that never listens and logs nothing).
- **Files:** `justfile` (`mcp-install repo=justfile_directory() port="3481" label="dev.batas.mcp"`, `mcp-restart`,
  `mcp-status`, `mcp-uninstall`; plist generated with python plistlib: bun resolved via `command -v`, `RunAtLoad`,
  `KeepAlive true`, `ThrottleInterval 10`, `WorkingDirectory <repo>`, batasd's PATH, log
  `~/.batas/<label minus dev.batas.>.out`), `src/mcp.ts` (HTTP-only source watcher), `src/config.ts`
  (`http.watchMs: 2000`, `http.settleMs: 1000`).
- **Restart story: (b) self-exit.** (a) rejected: the repo has no git hooks and nothing runs `just check` or a
  restart automatically. The server snapshots `src/*.ts` mtimes, polls every 2 s, and exits 0 only when no request is
  in flight and the last response is ≥1 s old; `KeepAlive true` (batasd's `{SuccessfulExit:false}` would leave an
  exit 0 dead). Proven: touch → exit 0 in 0.8 s, new pid listening 0.8 s later; an in-flight call held 5 s answered
  normally and exit came 2.05 s after it; with the guard removed the call was cut (falsified).
- **Throwaway proof** (`dev.batas.mcp-phase3test`, 47490, from a scratchpad COPY of the tree): running, 127.0.0.1
  only, initialize 200 with session id; kill → new pid 0.3 s; `mcp-restart` → new pid (10.3 s, throttled); uninstall
  → service gone, plist gone, port free. `plutil -lint` OK. 87 pass / 0 fail ×3 runs (one earlier run: 181 s, 1 fail,
  name not captured — possible flake).
- **Discovered:**
  1. **BLOCKER for Phase 04 — launchd-started bun cannot read `~/Documents` (TCC).** TCC.db grants
     `kTCCServiceSystemPolicyDocumentsFolder` to `/opt/homebrew/Cellar/uv/0.9.30/bin/uv` (why batasd works) and to
     `/opt/homebrew/Cellar/node/26.5.0_1/bin/node` (why gitnexus works — `/opt/homebrew/bin/gitnexus` is a node
     script), but not to `~/.bun/bin/bun`. The main checkout and `config.projectRoots` both live under `~/Documents`.
     Needs a human grant (System Settings → Privacy & Security → Files and Folders / Full Disk Access) — and a grant
     on an unsigned binary path may need redoing after a bun upgrade.
  2. Every self-restart drops all sessions/SSE streams; Claude Code must re-initialize on the 404 — not yet proven
     live (Phase 05).
  3. Calls during the restart gap (up to ThrottleInterval) get connection refused.

## Audit — Block 4 (Phase 03 @ 5c4a558) — RECEIPT, 3 findings (two blocked on the TCC grant)

VERIFIED-LIVE by the auditor: plist content + `plutil -lint`; `just -n mcp-install` defaults → repo
`justfile_directory()`, 3481, `dev.batas.mcp`; install twice idempotent, 127.0.0.1 only; status/restart when not
installed → clear launchctl error, exit 1; uninstall when not installed → exit 0; **an idle open GET stream does NOT
count as in flight** (touch → new pid in 759 ms with an SDK client connected); after restart the client gets
`Session not found` 404 and must re-initialize; stdio has no watcher (touch → still alive 7 s later, 8 tools).
Receipt (condensed from the auditor's return; checks verbatim):

1. **`src/mcp.ts:36-41` (`fresh()` → `store.refresh("all")`): under launchd the first store-reading tool call
   (`get`, `status`, `check`) never answers and blocks the event loop** (a following `initialize` also times out).
   Same code direct / under `env -i` answers in 0.39 s. Inferred cause: the TCC Documents block — the store's sync
   walk reads `skillsDir` and `projectRoots` (`src/corpus.ts:174,251`), and the skills are symlinks into
   `~/Documents`. failing check: install a throwaway label from a copy outside Documents, then
   `curl -m 6 -X POST … -H "mcp-session-id: $SID" -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get","arguments":{"id":"lessons:B10"}}}' http://127.0.0.1:<port>/mcp`
   → expected HTTP 200 within ~1 s; actual curl exit 28 and the next initialize times out.
2. **`src/mcp.ts:~507-531` (`s.pending`) / `:~580-585`: a request that never gets a response blocks restart
   indefinitely** — after a `tools/call check` with no GET stream, `utimes src/config.ts` → still the old pid at 30 s
   and ~150 s. Confounded by #1 (`check` calls `fresh()`). failing check:
   `bun tests/audit03-vanished-client.probe.ts <port> <src file>` → expected `RESTARTED` within ~10 s; actual
   `NOT RESTARTED` at 30 s. Retest after #1; if it persists, `pending` needs a deadline.
3. **Suite flake** — 3 runs: 9 s, 9 s, **694 s** (all 87/0); executor saw 181 s with 1 fail. Orchestrator reproduced on
   main after landing: **86 pass / 1 fail in 932 s** (stopped the remaining runs). Name being captured.

Not driven: restart storm under a save burst, mid-poll temp-file rename (code reading: one exit per poll tick,
ThrottleInterval caps relaunches). The recipe has no way to pass env to the job. Auditor's probes salvaged to
`audit03-salvage/` in the session scratchpad. Audit duration ~2 h — much of it waiting on the hung launchd server.

**Resolution:** #1 is the Phase 03 TCC blocker showing up in a second place — it needs the user's grant for
`~/.bun/bin/bun`, not code (though a TCC-blocked sync read freezing the whole server is worth a guard). #2 is retested
once #1 is cleared. #3 is investigated now.

### Receipt item 3 (suite flake) — resolved: not a code defect, the Mac was asleep

Orchestrator ran the suite 5× with a 90 s cap: 8.8 s, 8.7 s, then **924 s** with
`(fail) latency budget > a prompt with memory recall stays under 150ms p95 [916649.98ms] — timed out after 5000ms`.
The Python driver's own 90 s timeout never fired, so the driver was frozen too. `pmset -g log`: the machine has been
in `Maintenance Sleep` for ~912–927 s at a time with ~45 s DarkWakes since at least 08:12 (the user is away). Every
slow run, the 181 s/694 s/932 s runs and the two ~15 min silent windows in the Phase 02 / audit transcripts line up
with that. The failing test is pre-existing (latency budget), not part of this plan. Closed.
