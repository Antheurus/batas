import { statSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest, RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "./config.ts";
import type { Entry, Kind } from "./corpus.ts";
import { ask, requestSync } from "./semantic.ts";
import { type Hit, Store } from "./store.ts";
import { mutedIds, readAcks, readFeedback, reportWrong, setMuted } from "./feedback.ts";
import { repoName } from "./hook.ts";
import { readHookLog } from "./log.ts";
import { Triggers } from "./triggers.ts";
import { logChangelog, logProgress, ORIGINS, recordMemory } from "./write.ts";

const KINDS = ["rule", "rule-section", "reference", "memory", "project-rule", "progress", "changelog", "context"] as const;
const KNOWLEDGE: Kind[] = ["rule", "rule-section", "reference", "memory", "project-rule", "context"];

// The server lives as long as its Claude session; the corpus is re-read from its files whenever one changed, and a
// change also nudges batasd to re-embed it.
const store = new Store();
let lastRefresh = 0;

function fresh(): Store {
  if (Date.now() - lastRefresh > 5000) {
    if (store.refresh("all").changed && lastRefresh) requestSync();
    lastRefresh = Date.now();
  }
  return store;
}

const WARMING = "batas semantic search is starting (two models load in ~10 s, the first full index takes a few minutes) — retry in a moment.";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function fail(err: unknown) {
  return { content: [{ type: "text" as const, text: `error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
}

function full(e: Entry): string {
  return `## ${e.id}\nkind: ${e.kind} | scope: ${e.scope} | source: ${e.source}:${e.line}\n\n${e.body}`;
}

export type ProjectSource = "arg" | "roots" | "cwd" | "none";
// cwd is set only by the stdio entry, where it is the Claude session's own launch directory; a shared server's process
// cwd belongs to no session. root may still be pending when a tool call arrives, and the call waits for it.
export type SessionContext = { cwd?: string; root?: Promise<string | undefined> };

const GLOBAL_KINDS: Kind[] = ["rule", "rule-section", "reference"];
const GLOBAL_ONLY = "scope: global only (no project known for this session; pass project)";
const NO_PROJECT = "no project for this session — pass project_dir (absolute repo path)";
const PROJECT_DIR =
  "Absolute path of the repo this write belongs to. Defaults to the session's project (its MCP root, or the launch " +
  "directory over stdio); required when the session has none.";

function isDir(p: string): boolean {
  return statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

export async function projectOf(ctx: SessionContext, explicit?: string): Promise<{ dir?: string; source: ProjectSource }> {
  if (explicit) {
    if (!isAbsolute(explicit) || !isDir(explicit)) throw new Error(`project_dir must be an absolute path to an existing directory: ${explicit}`);
    return { dir: explicit, source: "arg" };
  }
  const root = await ctx.root;
  if (root && isDir(root)) return { dir: root, source: "roots" };
  if (ctx.cwd) return { dir: ctx.cwd, source: "cwd" };
  return { source: "none" };
}

export async function firstRoot(server: McpServer): Promise<string | undefined> {
  try {
    const { roots } = await server.server.listRoots(undefined, { timeout: config.http.rootsMs });
    const uri = roots.find((r) => r.uri.startsWith("file://"))?.uri;
    return uri ? fileURLToPath(uri) : undefined;
  } catch {
    return undefined;
  }
}

function globalOnly(kinds: Kind[]): Kind[] {
  return kinds.filter((k) => GLOBAL_KINDS.includes(k));
}

export function createServer(ctx: SessionContext): McpServer {
  const server = new McpServer({ name: "batas", version: "0.1.0" });
  if (!ctx.cwd) {
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
      ctx.root = firstRoot(server);
    });
  }

  server.registerTool(
    "check",
    {
      description:
        "Pre-flight guardrail: BEFORE running a non-trivial command, editing a file in an unfamiliar area, or starting a task, " +
        "ask which recorded rules, past mistakes and user preferences apply. Pass the exact command and/or file path and/or a " +
        "one-line intent. Returns full rule text for trigger matches plus the closest recorded lessons, memories and project rules.",
      inputSchema: {
        command: z.string().optional().describe("Exact shell command about to run"),
        file: z.string().optional().describe("File path about to be read or edited"),
        intent: z.string().optional().describe("One line: what you are about to do, e.g. 'restore prod dump into local postgres'"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ command, file, intent }) => {
      try {
        const s = fresh();
        const triggers = Triggers.load();
        const out: string[] = [];
        const seen = new Set<string>();
        for (const m of triggers.match({ cmd: command, path: file, prompt: intent })) {
          const e = s.get(m.id);
          if (!e || seen.has(e.id)) continue;
          seen.add(e.id);
          out.push(`${full(e)}\n\n(fired by ${m.via} \`${m.pattern}\`)`);
        }
        const q = [intent, command, file ? basename(file) : undefined].filter(Boolean).join(" ");
        const p = await projectOf(ctx);
        const kinds: Kind[] = ["rule", "rule-section", "project-rule", "memory", "context"];
        const found = q ? await s.search(q, { kinds: p.dir ? kinds : globalOnly(kinds), scope: repoName(p.dir), limit: 6 }) : [];
        const related = (found ?? []).filter((h) => !seen.has(h.id));
        const lines = [
          out.length ? `# ${out.length} rule(s) triggered\n\n${out.join("\n\n---\n\n")}` : "# No trigger matched",
          related.length
            ? `\n# Related (semantic — read the ones that fit with get)\n${related.map((h) => `- ${h.id} [${h.kind}] ${h.title}`).join("\n")}`
            : found
              ? ""
              : `\n# Related: ${WARMING}`,
        ];
        if (!p.dir) lines.push(GLOBAL_ONLY);
        return text(lines.join("\n"));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "recall",
    {
      description:
        "Search everything the user and past sessions have recorded: global rules and incident references, per-project memory " +
        "(user preferences, feedback, decisions), project rules, docs/progress.md, docs/changelog.md, docs/context/, docs/lessons/ and docs/qa/context.md of every repo. " +
        "Use it for 'have we hit this before?', 'what does the user prefer about X?', 'how did another repo solve Y?'.",
      inputSchema: {
        query: z.string().describe("Keywords, error text, tool or concept names"),
        kinds: z.array(z.enum(KINDS)).optional().describe("Restrict to entry kinds"),
        project: z.string().optional().describe("Limit to global entries plus this repo/memory scope"),
        limit: z.number().int().min(1).max(30).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, kinds, project, limit }) => {
      try {
        // Inside a repo the default scope is that repo (plus global), and knowledge is ranked apart from history: as one
        // list, long English progress entries took a quarter of the top-3 slots meant for the distilled lesson.
        const p = await projectOf(ctx);
        const scope = project ?? repoName(p.dir);
        const global = !project && !p.dir;
        const answer = (t: string) => text(global ? `${t}\n${GLOBAL_ONLY}` : t);
        const s = fresh();
        const search = (k: Kind[], n: number) => {
          const within = global ? globalOnly(k) : k;
          return within.length ? s.search(query, { kinds: within, scope, limit: n }) : Promise.resolve([] as Hit[]);
        };
        const n = limit ?? 10;
        const line = (h: Hit) => `- ${h.id} [${h.kind}${h.scope === "global" ? "" : ` · ${h.scope}`}] ${h.title}\n  ${h.snippet.replace(/\s+/g, " ")}`;
        if (kinds?.length) {
          const hits = await search(kinds as Kind[], n);
          if (!hits) return answer(WARMING);
          return answer(hits.length ? hits.map(line).join("\n") : `No entries match "${query}".`);
        }
        const [known, past] = await Promise.all([search(KNOWLEDGE, n), search(["progress", "changelog"], Math.max(2, Math.ceil(n / 3)))]);
        if (!known || !past) return answer(WARMING);
        if (!known.length && !past.length) return answer(`No entries match "${query}".`);
        return answer(
          [
            ...known.map(line),
            ...(past.length ? ["", "# From session history (progress / changelog)", ...past.map(line)] : []),
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get",
    {
      description:
        "Fetch one entry in full by id — a rule address like 'gotcha:D27' or 'lessons:C18', a memory like " +
        "'memory:<project-slug>/<name>', or any id returned by recall/check. Partial ids resolve to the closest match.",
      inputSchema: { id: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ id }) => {
      try {
        const s = fresh();
        const e = s.get(id);
        if (!e) return text(`No entry with id "${id}". Try recall.`);
        const links = s.links(e.id);
        const spec = Triggers.load().specs[e.id];
        const who = spec?.origin ? `\n\norigin: ${spec.origin}${spec.recorded ? ` (recorded ${spec.recorded})` : ""}` : "";
        return text(`${full(e)}${who}${links.length ? `\n\nlinks: ${links.map((l) => l.dst).join(", ")}` : ""}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "record",
    {
      description:
        "Remember something for future sessions. type user|feedback|project|reference WRITES a memory file directly " +
        "(user = who the user is; feedback = a correction or confirmed approach, with **Why:** and **How to apply:**; " +
        "project = ongoing work/decision not derivable from code, absolute dates; reference = pointer to an external resource) " +
        "and adds its MEMORY.md pointer. type lesson DRAFTS a rule instead — it never writes to rules; it returns the closest " +
        "existing rules so you can extend one instead of duplicating, then apply it via the rules-writer skill.",
      inputSchema: {
        type: z.enum(["user", "feedback", "project", "reference", "lesson"]),
        name: z.string().describe("kebab-case slug, e.g. 'hooks-warn-not-ask'"),
        title: z.string().describe("Human title for the MEMORY.md index line"),
        description: z.string().describe("One line, used to decide relevance later"),
        triggers: z
          .array(z.string())
          .optional()
          .describe(
            "4-10 words or short phrases the user would actually TYPE when this memory applies, Indonesian AND English, " +
              "colloquial included (e.g. 'panas', 'lemot', 'hot', 'slow'). The hook injects the memory when a prompt says one.",
          ),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            "Repo names (directory basenames) this memory governs although it is recorded under another project, e.g. a backend " +
              "decision that binds its frontend repo. Every session in those repos is told its title on the first prompt.",
          ),
        body: z.string().describe("The fact/rule. For feedback/project follow with **Why:** and **How to apply:** lines"),
        project_dir: z.string().optional().describe(PROJECT_DIR),
        replace: z.boolean().optional().describe("Overwrite an existing memory with the same name"),
        origin: z
          .enum(ORIGINS)
          .describe(
            "Who started this record: user-requested (the user asked for it to be remembered), agent-initiated (the agent " +
              "noticed it unprompted), user-written (the user wrote or dictated the words themselves)",
          ),
      },
    },
    async (a) => {
      try {
        if (a.type === "lesson") {
          const similar =
            (await fresh().search(`${a.title} ${a.description} ${a.body}`, {
              kinds: ["rule", "rule-section", "project-rule", "memory"],
              limit: 6,
            })) ?? [];
          return text(
            [
              "# Draft only — nothing was written",
              "",
              `**${a.title}** — ${a.body}`,
              "",
              "## Closest existing entries — extend one of these rather than adding a duplicate",
              ...similar.map((h) => `- ${h.id} [${h.kind}] ${h.title}`),
              "",
              "## To apply",
              "Invoke the rules-writer skill (Mode D global / Mode A project). Place a global item by its TRIGGER: the always-on",
              "mother (gotcha-coding.md / lessons.md) for command- or session-triggered rules, a p-gotcha-*/p-lessons-* slice for",
              `rules that fire only while editing matching files. Then add its triggers to ${config.triggersFile},`,
              `with origin = "${a.origin}" and recorded = "${new Date().toLocaleDateString("sv-SE")}" on the same entry.`,
            ].join("\n"),
          );
        }
        const p = await projectOf(ctx, a.project_dir);
        if (!p.dir) return fail(NO_PROJECT);
        const w = recordMemory({
          projectDir: p.dir,
          type: a.type,
          name: a.name,
          title: a.title,
          description: a.description,
          body: a.body,
          replace: a.replace,
          origin: a.origin,
          triggers: a.triggers,
          repos: a.repos,
        });
        fresh();
        requestSync();
        return text(`${w.note}\n${w.file}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "log_progress",
    {
      description:
        "Prepend this session's entry to <project>/docs/progress.md (the agent-facing god file): one dense prose paragraph — " +
        "what was worked on, root cause, the fix and why that shape, what was verified with real numbers, deploy status, " +
        "follow-ups. Adds (cont) automatically for a second entry the same day.",
      inputSchema: {
        version: z.string().describe("X.Y.Z — the same version as the changelog entry"),
        title: z.string().describe("Short title"),
        body: z.string().describe("One dense prose paragraph, not bullets"),
        app: z.string().optional().describe("Monorepo app name, e.g. 'web'"),
        project_dir: z.string().optional().describe(PROJECT_DIR),
      },
    },
    async (a) => {
      try {
        const p = await projectOf(ctx, a.project_dir);
        if (!p.dir) return fail(NO_PROJECT);
        const w = logProgress({ projectDir: p.dir, version: a.version, title: a.title, body: a.body, app: a.app });
        return text(`${w.note}\n${w.file}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "log_changelog",
    {
      description:
        "Prepend a user-facing release entry to <project>/docs/changelog.md in plain non-technical language. Refuses a version " +
        "that already has a heading or is not newer than the newest one — two sessions picking the same number is the failure " +
        "this guards against.",
      inputSchema: {
        version: z.string().describe("X.Y.Z; agent bumps Z (fix) or Y (feature), never X"),
        title: z.string().describe("Short customer-facing title"),
        bullets: z.array(z.string()).min(1).describe("What changed from the user's point of view, plus any action required"),
        project_dir: z.string().optional().describe(PROJECT_DIR),
      },
    },
    async (a) => {
      try {
        const p = await projectOf(ctx, a.project_dir);
        if (!p.dir) return fail(NO_PROJECT);
        const w = logChangelog({ projectDir: p.dir, version: a.version, title: a.title, bullets: a.bullets });
        return text(`${w.note}\n${w.file}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "mute",
    {
      description:
        "Stop a rule or memory id from being injected anywhere (unmute: true reverses it). Use when the user says an " +
        "injection keeps being wrong ('batas nyasar' mutes for one session only; this is permanent). Then tighten the " +
        "id's triggers — muting is the stopgap, not the fix.",
      inputSchema: {
        id: z.string().describe("e.g. 'lessons:B24' or 'memory:<slug>/<name>'"),
        reason: z.string().optional().describe("Why it is wrong here — shown in status"),
        unmute: z.boolean().optional(),
      },
    },
    async (a) => {
      try {
        setMuted(a.id, a.unmute ? null : (a.reason ?? "muted by the user"));
        if (!a.unmute) reportWrong([a.id], "mcp", a.reason ?? "", true);
        return text(`${a.unmute ? "unmuted" : "muted everywhere"}: ${a.id}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "status",
    {
      description: "Health of the guardrail corpus: entry counts, rules without triggers, hook activity and latency over the last 24h.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const s = fresh();
        const p = await projectOf(ctx);
        const daemon = await ask<{ pid: number; entries: number; syncing: boolean }>({ op: "status" }, 1000);
        const triggers = Triggers.load();
        const ruleIds = s.entries("rule").map((r) => r.id);
        const covered = new Set(triggers.ids());
        const missing = ruleIds.filter((id) => !covered.has(id));
        const orphan = [...covered].filter((id) => !ruleIds.includes(id) && !/^(memory|hint):/.test(id));
        // Step 5b's other half: an always-on mother item whose verbatim text has no section in its *-full.md is injected
        // as the condensed line only, which is already in context.
        const motherRows = s.entries("rule");
        const noFullText = motherRows
          .filter((r) => /\/(lessons\.md|gotcha-coding\.md)$/.test(r.source))
          .map((r) => r.id)
          .filter((id) => {
            const [family, addr] = id.split(":");
            const file = family ? config.familyFullText[family] : undefined;
            const exact = s.entries("reference").some((e) => e.id === `ref:references/${file}#${addr?.toLowerCase()}`);
            return !!file && !!addr && !exact;
          });
        const rows = readHookLog(Date.now() - 24 * 3600 * 1000);
        let activity = "no hook activity recorded in 24h";
        if (rows.length) {
          const fires = rows.filter((r) => r.fired.length);
          const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
          const errors = rows.filter((r) => r.error);
          activity =
            `${rows.length} hook calls in 24h, ${fires.length} injected/blocked, p50 ${ms[Math.floor(ms.length / 2)] ?? 0}ms, ` +
            `p95 ${ms[Math.floor(ms.length * 0.95)] ?? 0}ms, ${errors.length} errors` +
            (errors.length ? ` (last: ${errors[errors.length - 1]?.error})` : "");
          const perSession = new Map<string, number>();
          for (const r of rows) if (r.session && r.bytes) perSession.set(r.session, (perSession.get(r.session) ?? 0) + r.bytes);
          const kb = [...perSession.values()].sort((a, b) => a - b).map((n) => Math.round(n / 1000));
          if (kb.length) {
            activity += `; injected per session: p50 ${kb[Math.floor(kb.length / 2)]} KB, max ${kb[kb.length - 1]} KB of a ${Math.round(config.inject.sessionBytes / 1000)} KB budget`;
          }
        }
        const reports = readFeedback();
        const reported = new Map<string, number>();
        for (const r of reports) for (const id of r.ids) reported.set(id, (reported.get(id) ?? 0) + 1);
        const muted = Object.entries(mutedIds());
        return text(
          [
            `semantic: ${daemon ? `batasd pid ${daemon.pid}, ${daemon.entries} vectors${daemon.syncing ? ", syncing" : ""}` : "batasd not answering (starting it)"}`,
            `entries: ${s.stats().map((r) => `${r.kind} ${r.n}`).join(", ")}`,
            `triggers: ${covered.size} ids in ${config.triggersFile}; ${missing.length} rules without triggers${missing.length ? `: ${missing.slice(0, 40).join(" ")}${missing.length > 40 ? " …" : ""}` : ""}`,
            orphan.length ? `orphan trigger ids (no such rule): ${orphan.join(" ")}` : "orphan trigger ids: none",
            `always-on items without a full-text section: ${noFullText.length ? noFullText.join(" ") : "none"}`,
            `hooks: ${activity}`,
            `reported wrong ("batas nyasar"): ${reported.size ? [...reported].sort((x, y) => y[1] - x[1]).map(([id, n]) => `${id} ×${n}`).join(", ") : "none"}`,
            `muted everywhere: ${muted.length ? muted.map(([id, why]) => `${id} (${why})`).join(", ") : "none"}`,
            `collision-guard acks in 7 days (each one bypassed a block): ${(() => {
              const acks = readAcks(Date.now() - 7 * 24 * 3600 * 1000);
              return acks.length ? `${acks.length} — ${[...new Set(acks.map((a) => a.kind))].join(", ")}` : "none";
            })()}`,
            `session repo: ${repoName(p.dir)} (source: ${p.source})`,
          ].join("\n"),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );
  return server;
}

type Session = { server: McpServer; transport: WebStandardStreamableHTTPServerTransport; ctx: SessionContext; streamOpened: () => void; idle?: Timer };

function rpcError(status: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }, { status });
}

export function serveHttp(port: number, host: string) {
  if (host !== config.http.host) throw new Error(`refusing to bind ${host}: batas serves HTTP on ${config.http.host} only`);
  const sessions = new Map<string, Session>();

  function touch(s: Session) {
    clearTimeout(s.idle);
    s.idle = setTimeout(() => void s.transport.close(), config.http.idleMs);
  }

  function open(): Session {
    const ctx: SessionContext = {};
    const server = createServer(ctx);
    let streamOpened = () => {};
    const stream = new Promise<void>((r) => (streamOpened = r));
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, s);
        touch(s);
      },
    });
    const s: Session = { server, transport, ctx, streamOpened };
    transport.onclose = () => {
      clearTimeout(s.idle);
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    server.server.oninitialized = () => {
      if (!server.server.getClientCapabilities()?.roots) return;
      // Claude Code opens its GET stream ~25 ms after initialized; a roots/list sent before that stream exists is dropped.
      ctx.root = Promise.race([stream.then(() => firstRoot(server)), Bun.sleep(config.http.rootsMs).then(() => undefined)]);
    };
    return s;
  }

  const http = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/mcp") return new Response("not found", { status: 404 });
      try {
        const sid = req.headers.get("mcp-session-id");
        if (sid) {
          const s = sessions.get(sid);
          if (!s) return rpcError(404, "Session not found");
          touch(s);
          const res = await s.transport.handleRequest(req);
          if (req.method === "GET" && res.status === 200) s.streamOpened();
          return res;
        }
        const body: unknown = req.method === "POST" ? await req.json().catch(() => undefined) : undefined;
        if (!isInitializeRequest(body)) return rpcError(400, "Bad Request: no session, send initialize first");
        const s = open();
        await s.server.connect(s.transport);
        return await s.transport.handleRequest(req, { parsedBody: body });
      } catch (err) {
        console.error(`batas mcp: ${req.method} ${req.headers.get("mcp-session-id") ?? "(no session)"} failed: ${String(err)}`);
        return rpcError(500, "Internal error");
      }
    },
  });
  if (http.hostname !== config.http.host) {
    void http.stop(true);
    throw new Error(`listening on ${http.hostname}, not ${config.http.host}; stopped`);
  }
  console.error(`batas mcp: listening on http://${http.hostname}:${http.port}/mcp`);
  return http;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { http: { type: "boolean" }, port: { type: "string" }, host: { type: "string" } }, strict: false });
  if (!values.http) await createServer({ cwd: process.cwd() }).connect(new StdioServerTransport());
  else {
    try {
      if (!/^\d+$/.test(String(values.port))) throw new Error("--http needs --port <number>");
      serveHttp(Number(values.port), String(values.host ?? config.http.host));
    } catch (err) {
      console.error(`batas mcp: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }
}
