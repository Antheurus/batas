import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { config } from "./config.ts";
import { memorySources, memoryTriggers, parseMemory, projectSlug, type Entry } from "./corpus.ts";
import { mutedIds, reportWrong } from "./feedback.ts";
import { appendHookLog } from "./log.ts";
import { Store } from "./store.ts";
import { type Match, Triggers } from "./triggers.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
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

// lastPrompt is what the PROMPT hook injected most recently — the only thing "batas nyasar" can be about, since the
// user never sees the rules fired by the agent's own tool calls.
type SessionState = { injected: string[]; hinted: string[]; lastPrompt: string[]; muted: string[] };

// Harness-generated turns (a background agent finishing, a system reminder) arrive as UserPromptSubmit too; their
// text is an agent's report, not the user's request, so matching phrases in it only produces noise.
const SYSTEM_PROMPT = /<task-notification>|\[SYSTEM NOTIFICATION/;
// The user's way of saying the last injection did not belong; it mutes those ids for the session and is recorded.
const MUTE_PROMPT = /\bbatas\s+(nyasar|salah|ngaco|keliru|wrong|irrelevant)\b/i;
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function sessionFile(id: string): string {
  return join(config.sessionsDir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function loadSession(id: string): SessionState {
  try {
    const s = JSON.parse(readFileSync(sessionFile(id), "utf8")) as Partial<SessionState>;
    return { injected: s.injected ?? [], hinted: s.hinted ?? [], lastPrompt: s.lastPrompt ?? [], muted: s.muted ?? [] };
  } catch {
    return { injected: [], hinted: [], lastPrompt: [], muted: [] };
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

// An always-on family item is condensed and already in context; when its trigger fires, what is worth injecting is
// the original wording kept verbatim in the family's full-text reference.
function fullText(store: Store, e: Entry): string | undefined {
  const [family, addr] = e.id.split(":");
  const name = family ? config.familyFullText[family] : undefined;
  if (!name || !addr) return undefined;
  const ref = store.get(`ref:references/${name}#${addr.toLowerCase()}`);
  if (!ref || ref.title !== addr) return undefined;
  return ref.body.replace(/^## .*\n/, "").replace(/^_linked from [^\n]*\n+/, "").trim();
}

function render(store: Store, e: Entry, m: Match, origin?: string): string {
  const who = origin ? ` · ${origin}` : "";
  const full = fullText(store, e);
  const body = full && full.length > e.body.length ? full : e.body;
  return `### ${e.id}${who} — fired by ${m.via} \`${m.pattern}\` (${basename(e.source)}:${e.line})\n${body}`;
}

const STOPWORDS = new Set(
  "this that with from have what when where which there their they them then than into about would could should bikin baru yang dengan untuk dari juga udah sudah bisa harus kalau atau tapi biar nggak gimana kita lagi buat jadi aja mana sama ini itu banget masih perlu secara mungkin terus padahal kenapa ngapain dong deh sih tuh nih kayak gitu gini pake pakai mau minta tolong coba please make sure".split(" "),
);

function saysWord(promptLower: string, word: string): boolean {
  // Every memory's triggers are checked on every prompt; compiling a unicode regex for each costs ~1 s in total, so
  // a plain substring test rules out almost all of them first.
  if (!promptLower.includes(word)) return false;
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(promptLower);
}

// A multi-word trigger matches when every one of its words is said, in any order: "mac gua panas" says "mac panas".
function saysTrigger(promptLower: string, trigger: string): boolean {
  return saysWord(promptLower, trigger) || trigger.split(/\s+/).length > 1 && trigger.split(/\s+/).every((w) => saysWord(promptLower, w));
}

// Only the user's own words count: a quoted line or a side agent's note pasted into the prompt is someone else's
// text, and matching it pulled unrelated memories in on the first live day.
function ownWords(prompt: string): string {
  const cut = prompt.search(/Here is a note offered by a side agent/i);
  return (cut >= 0 ? prompt.slice(0, cut) : prompt)
    .split("\n")
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
}

// Every prompt shares some word with some memory, so a bare FTS hit is noise. A memory matches when the prompt says
// one of its trigger words; only those are injected in full. Without a trigger, sharing three distinct content words
// (two in its title or description) only LISTS it, and other projects' memories need a trigger to be listed at all.
function relevantMemories(
  store: Store,
  prompt: string,
  project: string,
  skip: string[],
): { full: Entry[]; more: Pick<Entry, "id" | "title">[] } {
  const lower = ownWords(prompt).toLowerCase();
  const tokens = [...new Set(lower.split(/[^\p{L}\p{N}_]+/u))].filter((w) => w.length > 2 && !STOPWORDS.has(w));
  const words = tokens.filter((w) => w.length >= 4);
  if (!tokens.length) return { full: [], more: [] };
  // Reads memories through the (kind, scope) index and matches in JS: an FTS query over the whole corpus matched
  // progress and changelog rows before filtering to memories, and cost ~50 ms a prompt on its own.
  const triggered = (h: Pick<Entry, "title">) => memoryTriggers(h.title).some((t) => saysTrigger(lower, t));
  const overlap = (h: Entry) => {
    const title = h.title.toLowerCase();
    const text = `${title}\n${h.body.toLowerCase()}`;
    const inText = words.filter((w) => text.includes(w)).length;
    return inText >= 3 && words.filter((w) => title.includes(w)).length >= 2 ? inText : 0;
  };
  const local = store.memories(project).filter((h) => !skip.includes(h.id));
  const strong = local.filter(triggered);
  const weak = local
    .filter((h) => !strong.includes(h))
    .map((h) => ({ h, n: overlap(h) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.h);
  const matched = [...strong, ...weak];
  const elsewhere = store
    .memoryTitlesOutside(project)
    .filter((h) => !skip.includes(h.id) && triggered(h))
    // The same memory is often copied into several sibling projects; list each name once.
    .filter((h, i, all) => all.findIndex((o) => o.id.split("/").pop() === h.id.split("/").pop()) === i);
  const full = strong.slice(0, config.inject.maxMemories);
  return {
    full,
    more: [...matched.filter((h) => !full.includes(h)), ...elsewhere].slice(0, config.inject.maxMoreMemories),
  };
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
        return e ? render(store, e, m, triggers.specs[m.id]?.origin) : `### ${m.id} (not indexed — run \`just reindex\` in the batas repo)`;
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
  } else if (event === "UserPromptSubmit" && input.prompt && !SYSTEM_PROMPT.test(input.prompt)) {
    probe = { prompt: input.prompt };
  }
  if (!probe.cmd && !probe.path && !probe.code && !probe.prompt) return { output: {}, fired: [] };

  const state = loadSession(session);
  if (probe.prompt && MUTE_PROMPT.test(ownWords(probe.prompt))) {
    if (!state.lastPrompt.length) return { output: {}, fired: [] };
    const ids = state.lastPrompt;
    reportWrong(ids, session, probe.prompt);
    state.muted.push(...ids);
    state.lastPrompt = [];
    saveSession(session, state);
    const text = [
      `batas: muted for the rest of this session: ${ids.join(", ")}. The report is logged for the trigger audits.`,
      "If one of these should never fire again, call mcp__batas__mute({id, reason}) — and tighten its triggers.",
    ].join("\n");
    return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired: [] };
  }
  const silenced = new Set([...state.muted, ...Object.keys(mutedIds())]);
  const matches = triggers.match(probe).filter((m) => !state.injected.includes(m.id) && !silenced.has(m.id));
  const project = input.cwd ? projectSlug(input.cwd) : "";
  const memories =
    probe.prompt && project
      ? relevantMemories(store, probe.prompt, project, [...state.injected, ...state.hinted, ...silenced])
      : { full: [], more: [] };
  if (!matches.length && !memories.full.length && !memories.more.length) return { output: {}, fired: [] };

  const sections: string[] = [];
  const fired: string[] = [];
  let chars = 0;

  if (probe.prompt) {
    const unseen = matches.filter((m) => !state.hinted.includes(m.id));
    const tools: string[] = [];
    for (const m of unseen.filter((x) => x.id.startsWith("hint:"))) {
      const text = triggers.specs[m.id]?.text;
      if (!text) continue;
      tools.push(text);
      state.hinted.push(m.id);
      fired.push(m.id);
    }
    const fresh = unseen.filter((m) => !m.id.startsWith("hint:")).slice(0, config.inject.maxPromptHints);
    for (const m of fresh) {
      const e = resolve(store, m.id);
      if (!e) continue;
      sections.push(`- ${e.id}: ${e.title}`);
      state.hinted.push(m.id);
      fired.push(m.id);
    }
    const recalled: string[] = [];
    for (const mem of memories.full) {
      const body = mem.body.length > config.inject.memoryChars ? `${mem.body.slice(0, config.inject.memoryChars)}…` : mem.body;
      recalled.push(`### ${mem.id} — ${mem.title}\n${body}`);
      state.injected.push(mem.id);
      fired.push(mem.id);
    }
    const listed: string[] = [];
    for (const mem of memories.more) {
      listed.push(`- ${mem.id} — ${mem.title}`);
      state.hinted.push(mem.id);
      fired.push(mem.id);
    }
    if (!sections.length && !tools.length && !recalled.length && !listed.length) return { output: {}, fired: [] };
    state.lastPrompt = fired.filter((id) => !id.startsWith("hint:"));
    saveSession(session, state);
    const text = [
      ...(recalled.length
        ? ["batas: project memories that may bear on this request — use one only if it actually applies to what was asked:", ...recalled, ""]
        : []),
      ...(listed.length
        ? ["batas: more memories that match (full text: mcp__batas__get <id>) — open any that bear on the work:", ...listed, ""]
        : []),
      ...tools.map((t) => `batas: ${t}`),
      ...(sections.length
        ? [
            "batas: rules that may apply to this request (full text: mcp__batas__get, or they inject when the matching",
            "command/file comes up):",
            ...sections,
          ]
        : []),
    ].join("\n");
    return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired };
  }

  const deferred: string[] = [];
  for (const m of matches) {
    const e = resolve(store, m.id);
    if (!e) continue;
    const block = render(store, e, m, triggers.specs[m.id]?.origin);
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
  let error: string | undefined;
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const store = new Store();
    store.refresh("rules", input.hook_event_name === "UserPromptSubmit" && input.cwd ? memorySources(projectSlug(input.cwd)) : []);
    result = evaluate(input, store, Triggers.load());
    store.close();
    pruneSessions();
  } catch (err) {
    error = err instanceof Error ? `${err.message} @ ${err.stack?.split("\n")[1]?.trim() ?? "?"}` : String(err);
    console.error(`batas hook error: ${error}`);
  }
  process.stdout.write(JSON.stringify(result.output));
  try {
    appendHookLog({
      ts: new Date().toISOString(),
      event: input.hook_event_name,
      tool: input.tool_name,
      session: input.session_id,
      fired: result.fired,
      ms: Math.round(performance.now() - started),
      ...(error ? { error } : {}),
    });
  } catch {}
}

if (import.meta.main) await main();
