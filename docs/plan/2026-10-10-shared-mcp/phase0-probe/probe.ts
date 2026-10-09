import { Server } from "/Users/macbook/Documents/PROJECT_MISPAQUL_ATTORIQ/batas/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "/Users/macbook/Documents/PROJECT_MISPAQUL_ATTORIQ/batas/node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js";
import { ListToolsRequestSchema } from "/Users/macbook/Documents/PROJECT_MISPAQUL_ATTORIQ/batas/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";
import { appendFileSync } from "node:fs";
const PORT = 47311;
const LOG = import.meta.dir + "/probe.log";
const log = (o: Record<string, unknown>) => appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...o }) + "\n");
const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
const getOpen = new Map<string, () => void>();
const getOpenP = new Map<string, Promise<void>>();
const waitGet = (sid: string) => { if (!getOpenP.has(sid)) getOpenP.set(sid, new Promise<void>((r) => getOpen.set(sid, r))); return getOpenP.get(sid)!; };

function makeSession() {
  const server = new Server({ name: "roots-probe", version: "0.0.1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (sid) => { sessions.set(sid, transport); log({ ev: "session-initialized", sid }); },
  });
  const origSend = transport.send.bind(transport);
  transport.send = async (msg: any, opts?: any) => { log({ dir: "out", sid: transport.sessionId, msg, opts: opts ? Object.keys(opts) : [] }); return origSend(msg, opts); };
  server.oninitialized = async () => {
    const sid = transport.sessionId;
    log({ ev: "oninitialized", sid, clientCaps: server.getClientCapabilities(), clientInfo: server.getClientVersion() });
    await Promise.race([waitGet(sid!), new Promise((r) => setTimeout(r, 5000))]);
    log({ ev: "sending roots/list now", sid });
    const t0 = Date.now();
    try {
      const r = await server.listRoots(undefined, { timeout: 20000 });
      log({ ev: "roots/list RESULT", sid, ms: Date.now() - t0, result: r });
    } catch (e: any) {
      log({ ev: "roots/list ERROR", sid, ms: Date.now() - t0, error: String(e?.message ?? e) });
    }
  };
  return { server, transport };
}

Bun.serve({
  port: PORT, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/mcp") return new Response("nf", { status: 404 });
    const sid = req.headers.get("mcp-session-id");
    let body: unknown = null;
    if (req.method === "POST") { try { body = await req.clone().json(); } catch { body = "<unparsable>"; } }
    log({ dir: "in", method: req.method, sid, accept: req.headers.get("accept"), body });
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid) { log({ ev: "unknown-session", sid }); return new Response("unknown session", { status: 404 }); }
      const s = makeSession();
      await s.server.connect(s.transport);
      transport = s.transport;
    }
    const res = await transport.handleRequest(req);
    if (req.method === "GET" && sid) { waitGet(sid); getOpen.get(sid)?.(); }
    log({ ev: "response", method: req.method, sid, status: res.status, ctype: res.headers.get("content-type") });
    return res;
  },
});
log({ ev: "listening", port: PORT, pid: process.pid });
