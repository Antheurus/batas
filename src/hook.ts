import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.ts";
import { parseMemory, type Entry } from "./corpus.ts";
import { Store } from "./store.ts";
import { type Match, Triggers } from "./triggers.ts";

type HookInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    notebook_path?: string;
    new_string?: string;
    content?: string;
    edits?: { new_string?: string }[];
  };
  prompt?: string;
  last_assistant_message?: string;
  stop_hook_active?: boolean;
};

type SessionState = { injected: string[]; hinted: string[] };

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function sessionFile(id: string): string {
  return join(config.sessionsDir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function loadSession(id: string): SessionState {
  try {
    return JSON.parse(readFileSync(sessionFile(id), "utf8")) as SessionState;
  } catch {
    return { injected: [], hinted: [] };
  }
}

function saveSession(id: string, state: SessionState) {
  mkdirSync(config.sessionsDir, { recursive: true });
  writeFileSync(sessionFile(id), JSON.stringify(state));
}

function pruneSessions() {
  if (Math.random() > 0.02 || !existsSync(config.sessionsDir)) return;
  const now = Date.now();
  for (const f of readdirSync(config.sessionsDir)) {
    const p = join(config.sessionsDir, f);
    if (now - statSync(p).mtimeMs > SESSION_TTL_MS) unlinkSync(p);
  }
}

function resolve(store: Store, id: string): Entry | undefined {
  const hit = store.get(id);
  if (hit) return hit;
  const mem = id.match(/^memory:([^/]+)\/(.+)$/);
  if (mem?.[1] && mem[2]) {
    const file = join(config.projectsDir, mem[1], "memory", `${mem[2]}.md`);
    if (existsSync(file)) return parseMemory(file, mem[1]);
  }
  return undefined;
}

function render(e: Entry, m: Match): string {
  return `### ${e.id} — fired by ${m.via} \`${m.pattern}\` (${basename(e.source)}:${e.line})\n${e.body}`;
}

export function evaluate(input: HookInput, store: Store, triggers: Triggers): { output: object; fired: string[] } {
  const event = input.hook_event_name ?? "";
  const session = input.session_id ?? "nosession";

  if (event === "Stop" || event === "SubagentStop") {
    if (input.stop_hook_active || !input.last_assistant_message) return { output: {}, fired: [] };
    const matches = triggers.match({ reply: input.last_assistant_message }).filter((m) => m.via === "reply");
    if (!matches.length) return { output: {}, fired: [] };
    const parts = matches
      .slice(0, config.inject.maxItems)
      .map((m) => {
        const e = resolve(store, m.id);
        return e ? render(e, m) : `### ${m.id} (not indexed — run \`just reindex\` in the batas repo)`;
      });
    const reason = [
      "batas: your last reply matches a known mistake pattern. Re-check it against the rule below, then correct the",
      "reply (or the work) — or, if it genuinely complies, say in one line why and stop.",
      "",
      ...parts,
    ].join("\n");
    return { output: { decision: "block", reason }, fired: matches.map((m) => m.id) };
  }

  let probe: { cmd?: string; path?: string; code?: string; prompt?: string } = {};
  if (event === "PreToolUse") {
    if (input.tool_name === "Bash" && input.tool_input?.command) probe = { cmd: input.tool_input.command };
    else if (input.tool_name && FILE_TOOLS.has(input.tool_name)) {
      const ti = input.tool_input ?? {};
      const p = ti.file_path ?? ti.notebook_path;
      const prose = /\.(md|mdx|txt|rst|toml)$/i.test(p ?? "");
      const code = prose
        ? ""
        : [ti.new_string, ti.content, ...(ti.edits ?? []).map((e) => e.new_string)].filter(Boolean).join("\n");
      if (p || code) probe = { path: p, code: code || undefined };
    }
  } else if (event === "UserPromptSubmit" && input.prompt) {
    probe = { prompt: input.prompt };
  }
  if (!probe.cmd && !probe.path && !probe.code && !probe.prompt) return { output: {}, fired: [] };

  const state = loadSession(session);
  const matches = triggers.match(probe).filter((m) => !state.injected.includes(m.id));
  if (!matches.length) return { output: {}, fired: [] };

  const sections: string[] = [];
  const fired: string[] = [];
  let chars = 0;

  if (probe.prompt) {
    const fresh = matches.filter((m) => !state.hinted.includes(m.id)).slice(0, config.inject.maxPromptHints);
    for (const m of fresh) {
      const e = resolve(store, m.id);
      if (!e) continue;
      sections.push(`- ${e.id}: ${e.title}`);
      state.hinted.push(m.id);
      fired.push(m.id);
    }
    if (!sections.length) return { output: {}, fired: [] };
    saveSession(session, state);
    const text = [
      "batas: rules that may apply to this request (full text: mcp__batas__get, or they inject when the matching",
      "command/file comes up):",
      ...sections,
    ].join("\n");
    return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired };
  }

  const deferred: string[] = [];
  for (const m of matches) {
    const e = resolve(store, m.id);
    if (!e) continue;
    const block = render(e, m);
    if (fired.length >= config.inject.maxItems || chars + block.length > config.inject.maxChars) {
      deferred.push(e.id);
      continue;
    }
    sections.push(block);
    chars += block.length;
    fired.push(e.id);
    state.injected.push(e.id);
  }
  if (!sections.length) return { output: {}, fired: [] };
  saveSession(session, state);
  const head = `batas: ${fired.length} rule(s) apply to this ${probe.cmd ? "command" : "edit"} — read before proceeding.`;
  const tail = deferred.length ? `\n\nAlso matched (fetch with mcp__batas__get): ${deferred.join(", ")}` : "";
  const text = `${head}\n\n${sections.join("\n\n")}${tail}`;
  return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired };
}

async function main() {
  const started = performance.now();
  let input: HookInput = {};
  let result: { output: object; fired: string[] } = { output: {}, fired: [] };
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const store = new Store();
    store.refresh("rules");
    result = evaluate(input, store, Triggers.load());
    store.close();
    pruneSessions();
  } catch (err) {
    console.error(`batas hook error: ${String(err)}`);
  }
  process.stdout.write(JSON.stringify(result.output));
  try {
    mkdirSync(config.stateDir, { recursive: true });
    appendFileSync(
      join(config.stateDir, "hook.log.jsonl"),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        event: input.hook_event_name,
        tool: input.tool_name,
        session: input.session_id,
        fired: result.fired,
        ms: Math.round(performance.now() - started),
      })}\n`,
    );
  } catch {}
}

if (import.meta.main) await main();
