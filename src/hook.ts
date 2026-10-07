import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.ts";
import { memorySources, memoryTriggers, parseMemory, projectSlug, type Entry } from "./corpus.ts";
import { mutedIds, recordAck, reportWrong } from "./feedback.ts";
import { appendHookLog, liveSessions } from "./log.ts";
import { Store } from "./store.ts";
import { dataSpans, type Match, matchOutside, Triggers } from "./triggers.ts";

type HookInput = {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
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
// touched is every file this session wrote through a file tool — what tells its dirty files from another session's.
// started and bashStart are epoch ms: when this session was first seen, and when its latest Bash call began.
type SessionState = {
  injected: string[];
  hinted: string[];
  lastPrompt: string[];
  muted: string[];
  touched: string[];
  started: number;
  bashStart: number;
  // bytes of context this session has received from batas, held against config.inject.sessionBytes
  spent: number;
};

// Harness-generated turns (a background agent finishing, a system reminder) arrive as UserPromptSubmit too; their
// text is an agent's report, not the user's request, so matching phrases in it only produces noise.
const SYSTEM_PROMPT = /<task-notification>|\[SYSTEM NOTIFICATION/;

// Measured 2026-10-07 over 236 sessions: p50 2.5 KB, p90 19.6 KB, max 36 KB injected per session. The budget sits
// above every observed session, so it only stops a runaway, never an ordinary day's rules.
const BUDGET_NOTE = `batas: this session's injection budget (${Math.round(config.inject.sessionBytes / 1000)} KB) is spent — further matches are named, not injected; read them with mcp__batas__get.`;
// The user's way of saying the last injection did not belong; it mutes those ids for the session and is recorded.
// Commands that read or write the shared index and working tree — exactly what a second session in the same checkout
// can corrupt or carry along (another session's push deployed a local commit on 2026-10-07).
const SHARED_GIT = /\bgit\s+(commit|push|add|stash|reset|checkout|switch|merge|rebase|pull|restore|clean|cherry-pick|revert)\b/;

// The directory a Bash command actually runs git in: a `cd X &&` or `git -C X` in the command beats the session's cwd.
// Using the session cwd blocked a `cd batas && git push` over activity in a different repo.
export function commandDir(raw: string | undefined, cwd: string | undefined): string | undefined {
  if (!raw) return cwd;
  // A heredoc body is data (a commit message quoting `cd x && git push` sent the guard to the wrong repo); quotes are
  // kept, since `cd "/path with spaces"` is a real target.
  const cmd = withoutHeredocs(raw);
  const home = process.env.HOME ?? "";
  const pick = (re: RegExp) => {
    let last: string | undefined;
    for (const m of cmd.matchAll(re)) last = m[2] ?? m[3] ?? m[4];
    return last;
  };
  const target = pick(/\bgit\s+-C\s+("([^"]+)"|'([^']+)'|(\S+))/g) ?? pick(/(?:^|[;&|(]\s*)cd\s+("([^"]+)"|'([^']+)'|([^\s;&|)]+))/g);
  if (!target) return cwd;
  const expanded = target.replace(/^~(?=\/|$)/, home).replace(/^\$HOME(?=\/|$)/, home).replace(/^\$\{HOME\}(?=\/|$)/, home);
  return expanded.startsWith("/") ? expanded : join(cwd ?? home, expanded);
}

export function repoRoot(cwd: string | undefined): string | undefined {
  let dir = cwd;
  while (dir && dir !== "/") {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = dirname(dir);
  }
  return undefined;
}

// Commands that take EVERY dirty file in the tree, so they cannot tell this session's work from another's.
const SWEEPING = [
  /\bgit\s+add\s+(?:[^|;&]*\s)?(-A|--all|-u|--update|\.)(?=\s|$|[;&|])/,
  /\bgit\s+commit\s+(?:[^|;&]*\s)?(-[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$|[;&|])/,
  /\bgit\s+stash(?!\s+(list|show|pop|apply|drop|branch)\b)(?![^|;&]*\s--\s)/,
  /\bgit\s+(checkout|restore)\s+(?:[^|;&]*\s)?(--\s+)?\.(?=\s|$|[;&|])/,
  /\bgit\s+reset\s+(?:[^|;&]*\s)?--hard\b/,
  /\bgit\s+clean\s+(?:[^|;&]*\s)?-[a-zA-Z]*f/,
];
const PUSH = /\bgit\s+push\b/;
const ACK_FOREIGN = /(^|[\s;&|])BATAS_ACK_FOREIGN=1\s/;
const ACK_LIVE = /(^|[\s;&|])BATAS_ACK_LIVE=1\s/;
const OTHERS_TOUCHED_WINDOW_MS = 24 * 3600 * 1000;

function dirtyFiles(repo: string): string[] {
  const out = Bun.spawnSync(["git", "-C", repo, "status", "--porcelain", "--untracked-files=all"], { stdout: "pipe", stderr: "ignore" });
  if (out.exitCode !== 0) return [];
  return out.stdout
    .toString()
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => join(repo, (l.slice(3).split(" -> ").pop() ?? "").replace(/^"|"$/g, "")));
}

function mtime(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

// After a Bash call, every dirty file whose mtime moved during it is this session's work: the only attribution that
// sees edits made by scripts, redirects and sed, which is how most edits on this machine are made.
function attributeBash(input: HookInput, state: SessionState): boolean {
  if (!state.bashStart) return false;
  const repos = new Set(
    [repoRoot(commandDir(input.tool_input?.command, input.cwd)), repoRoot(input.cwd)].filter((r): r is string => !!r),
  );
  let added = false;
  for (const repo of repos) {
    for (const f of dirtyFiles(repo)) {
      const m = mtime(f);
      if (m !== undefined && m >= state.bashStart - 5 && !state.touched.includes(f)) {
        state.touched.push(f);
        added = true;
      }
    }
  }
  return added;
}

// The session's real start is its transcript's creation time. Defaulting to "first seen by this hook" made every
// session already open when the rule shipped treat its OWN earlier work as pre-existing and get blocked; without a
// transcript the pre-session rule is skipped rather than guessed.
function sessionStart(input: HookInput): number | undefined {
  if (!input.transcript_path) return undefined;
  try {
    const st = statSync(input.transcript_path);
    return st.birthtimeMs || st.ctimeMs;
  } catch {
    return undefined;
  }
}

// Dirty files that are not this session's work: written by another session (even an idle one, which the 15-minute
// live window cannot see), or already dirty before this session started and never touched by it since.
function foreignDirty(repo: string, session: string, state: SessionState, started: number | undefined): { file: string; why: string }[] {
  const dirty = dirtyFiles(repo);
  const mine = state.touched;
  if (!dirty.length) return [];
  const theirs = new Set<string>();
  const since = Date.now() - OTHERS_TOUCHED_WINDOW_MS;
  const own = sessionFile(session);
  for (const f of existsSync(config.sessionsDir) ? readdirSync(config.sessionsDir) : []) {
    const p = join(config.sessionsDir, f);
    if (p === own || statSync(p).mtimeMs < since) continue;
    try {
      for (const t of (JSON.parse(readFileSync(p, "utf8")) as Partial<SessionState>).touched ?? []) {
        if (t.startsWith(`${repo}/`)) theirs.add(t);
      }
    } catch {}
  }
  const mineSet = new Set(mine);
  const out: { file: string; why: string }[] = [];
  for (const d of dirty) {
    if (mineSet.has(d)) continue;
    if (theirs.has(d)) out.push({ file: d, why: "written by another session" });
    else if (started !== undefined && (mtime(d) ?? Number.POSITIVE_INFINITY) < started) {
      out.push({ file: d, why: "dirty before this session started" });
    }
  }
  return out;
}

// A block must never fire on text that only MENTIONS a command, so deny decisions read the bare shell surface: every
// heredoc body and quoted string removed. (A warning may read deeper; a deny that fired on a script writing the
// words "git add -A" would stop legitimate work.)
export function withoutHeredocs(cmd: string): string {
  return cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, " ");
}

export function shellSurface(cmd: string): string {
  return withoutHeredocs(cmd)
    .replace(/'[^']*'/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ");
}

// Blocks only the two shapes that carried another session's work on 2026-10-07: a sweeping stage/discard while their
// files are dirty, and a push while they are live. Each has a code-supported way through, so it can never dead-lock.
function collisionDeny(input: HookInput, state: SessionState): { deny?: string; acked?: string } {
  const raw = input.tool_input?.command;
  if (!raw) return {};
  const cmd = shellSurface(raw);
  const repo = repoRoot(commandDir(raw, input.cwd));
  if (!repo) return {};
  if (SWEEPING.some((re) => re.test(cmd))) {
    const foreign = foreignDirty(repo, input.session_id ?? "", state, sessionStart(input));
    // An ack that was actually needed is logged, so a habit of acking past the guard shows up in status.
    if (foreign.length && ACK_FOREIGN.test(cmd)) return { acked: "guard:ack-foreign" };
    if (foreign.length) {
      return { deny: [
        `batas BLOCKED: this command takes every dirty file in ${repo}, and ${foreign.length} of them are not this session's work:`,
        ...foreign.slice(0, 12).map((f) => `  ${f.file.slice(repo.length + 1)}  (${f.why})`),
        ...(foreign.length > 12 ? [`  … and ${foreign.length - 12} more`] : []),
        "Do this instead: stage or discard YOUR files by explicit path (`git add <path> <path>`). That is the fix in",
        "almost every case. Only if you have read each file above and sweeping it is genuinely intended, re-run prefixed",
        "with `BATAS_ACK_FOREIGN=1 ` — every ack is logged and shown in batas status.",
      ].join("\n") };
    }
  }
  if (PUSH.test(cmd)) {
    const others = liveSessions(repo, input.session_id ?? "", Date.now() - config.liveWindowMs);
    if (others.size && ACK_LIVE.test(cmd)) return { acked: "guard:ack-live" };
    if (others.size) {
      return { deny: [
        `batas BLOCKED: ${others.size} other Claude session(s) were active in ${repo} within the last ${config.liveWindowMs / 60000} minutes,`,
        "and a push carries every commit on this branch — including any they made. Read `git log @{u}..HEAD` (or",
        "`git log origin/<branch>..HEAD`) and confirm every commit is yours, then re-run prefixed with `BATAS_ACK_LIVE=1 `.",
      ].join("\n") };
    }
  }
  return {};
}

function liveNote(input: HookInput, state: SessionState): { id: string; text: string } | undefined {
  const cmd = input.tool_input?.command;
  if (!cmd || !matchOutside(SHARED_GIT, cmd, dataSpans(cmd))) return undefined;
  const repo = repoRoot(commandDir(cmd, input.cwd));
  if (!repo) return undefined;
  const others = liveSessions(repo, input.session_id ?? "", Date.now() - config.liveWindowMs);
  if (!others.size) return undefined;
  const id = `live:${repo}:${[...others.keys()].sort().join(",")}`;
  if (state.injected.includes(id)) return undefined;
  const ago = Math.round((Date.now() - Math.max(...others.values())) / 1000);
  return {
    id,
    text: [
      `### ${others.size} other Claude session(s) active in this checkout (${repo}) — last seen ${ago}s ago`,
      "They share this index and working tree. Stage by path, never `git add -A` / `git add .`; re-read `git status` and",
      "`git log -1` immediately before committing; a push from here also carries any commit they made, and theirs carries",
      "yours. If what you are about to do would take or discard their work, stop and isolate in a detached worktree",
      "(lessons D2, D10, C14).",
    ].join("\n"),
  };
}

const isMemoryFile = (p: string) =>
  p.startsWith(`${config.projectsDir}/`) && /\/memory\/(?!MEMORY\.md$)[^/]+\.md$/.test(p);
const isFamilyFile = (p: string) =>
  p.startsWith(`${config.rulesDir}/`) && /\/(lessons\.md|gotcha-coding\.md|p-(lessons|gotcha)-[^/]+\.md)$/.test(p);
const HAS_TRIGGERS = /^\s*triggers:\s*\S/m;

// rules-writer Step 5b at the moment of the write, not after a backfill: a memory without triggers is never injected,
// and a family rule without its triggers.toml entry and full-text section is never delivered when it matters.
function step5bNote(input: HookInput, state: SessionState): { id: string; text: string } | undefined {
  const ti = input.tool_input ?? {};
  const p = ti.file_path ?? ti.notebook_path;
  if (!p || !input.tool_name || !WRITE_TOOLS.has(input.tool_name)) return undefined;
  if (isMemoryFile(p)) {
    const id = `step5b:${p}`;
    if (state.injected.includes(id)) return undefined;
    const written = [ti.content, ti.new_string, ...(ti.edits ?? []).map((e) => e.new_string)].filter(Boolean).join("\n");
    let existing = "";
    try {
      existing = input.tool_name === "Write" ? "" : readFileSync(p, "utf8");
    } catch {}
    if (HAS_TRIGGERS.test(written) || HAS_TRIGGERS.test(existing)) return undefined;
    return {
      id,
      text: [
        `### This memory has no \`triggers:\` line — the hook can never inject it (${basename(p)})`,
        'Add one frontmatter line before the closing `---`: `triggers: "word, short phrase, ..."` — 4-10 words the user',
        "actually TYPES when it applies, Indonesian AND English, no bare generic word (fix, deploy, landing). Or write it",
        "through mcp__batas__record with `triggers`. Then `just trigger-audit` in the batas repo.",
      ].join("\n"),
    };
  }
  if (isFamilyFile(p)) {
    const id = "step5b:rules";
    if (state.injected.includes(id)) return undefined;
    return {
      id,
      text: [
        "### Editing a gotcha/lessons rule file — rules-writer Step 5b applies before this is done",
        "A new or moved item needs (1) an entry in ~/.claude/batas/triggers.toml with cmd/path/code regexes, prompt phrases",
        "in Indonesian AND English, and a t_* fixture each; (2) its verbatim full wording in",
        "~/.claude/references/{lessons,gotcha}-full.md under `## <ID>` — a rewritten item updates that section too. Then",
        "`just check` in the batas repo (the recall test) and `just sync` in cc-toriq.",
      ].join("\n"),
    };
  }
  return undefined;
}

const MUTE_PROMPT = /\bbatas\s+(nyasar|salah|ngaco|keliru|wrong|irrelevant)\b/i;
const FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

function sessionFile(id: string): string {
  return join(config.sessionsDir, `${id.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

function loadSession(id: string): SessionState {
  try {
    const s = JSON.parse(readFileSync(sessionFile(id), "utf8")) as Partial<SessionState>;
    return {
      injected: s.injected ?? [],
      hinted: s.hinted ?? [],
      lastPrompt: s.lastPrompt ?? [],
      muted: s.muted ?? [],
      touched: s.touched ?? [],
      started: s.started ?? Date.now(),
      bashStart: s.bashStart ?? 0,
      spent: s.spent ?? 0,
    };
  } catch {
    return { injected: [], hinted: [], lastPrompt: [], muted: [], touched: [], started: Date.now(), bashStart: 0, spent: 0 };
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
export function ownWords(prompt: string): string {
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

  if (event === "PostToolUse") {
    if (input.tool_name !== "Bash") return { output: {}, fired: [] };
    const st = loadSession(session);
    if (attributeBash(input, st)) saveSession(session, st);
    return { output: {}, fired: [] };
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
  if (event === "PreToolUse" && input.tool_name === "Bash") {
    state.bashStart = Date.now();
    saveSession(session, state);
  }
  if (event === "PreToolUse" && input.tool_name && WRITE_TOOLS.has(input.tool_name)) {
    const p = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (p?.startsWith("/") && !state.touched.includes(p)) {
      state.touched.push(p);
      saveSession(session, state);
    }
  }
  if (probe.cmd) {
    const guard = collisionDeny(input, state);
    if (guard.deny) {
      return {
        output: { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: guard.deny } },
        fired: ["guard:collision"],
      };
    }
    if (guard.acked) recordAck(guard.acked, session, probe.cmd);
  }
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
  // Rule phrases read only the user's own words too, the same cut as memory recall: a quoted line is not a request.
  const own = probe.prompt ? { ...probe, prompt: ownWords(probe.prompt) } : probe;
  const matches = triggers.match(own).filter((m) => !state.injected.includes(m.id) && !silenced.has(m.id));
  const project = input.cwd ? projectSlug(input.cwd) : "";
  const memories =
    probe.prompt && project
      ? relevantMemories(store, probe.prompt, project, [...state.injected, ...state.hinted, ...silenced])
      : { full: [], more: [] };
  const live = probe.cmd ? liveNote(input, state) : probe.path ? step5bNote(input, state) : undefined;
  if (!matches.length && !memories.full.length && !memories.more.length && !live) return { output: {}, fired: [] };

  const sections: string[] = [];
  const fired: string[] = [];
  let chars = 0;
  if (live) {
    sections.push(live.text);
    fired.push(live.id);
    state.injected.push(live.id);
  }

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
    const overBudget: Pick<Entry, "id" | "title">[] = [];
    let recalledBytes = 0;
    for (const mem of memories.full) {
      const body = mem.body.length > config.inject.memoryChars ? `${mem.body.slice(0, config.inject.memoryChars)}…` : mem.body;
      const block = `### ${mem.id} — ${mem.title}\n${body}`;
      if (state.spent + recalledBytes + block.length > config.inject.sessionBytes) {
        overBudget.push(mem);
        continue;
      }
      recalled.push(block);
      recalledBytes += block.length;
      state.injected.push(mem.id);
      fired.push(mem.id);
    }
    const listed: string[] = [];
    for (const mem of [...overBudget, ...memories.more]) {
      listed.push(`- ${mem.id} — ${mem.title}`);
      state.hinted.push(mem.id);
      fired.push(mem.id);
    }
    if (!sections.length && !tools.length && !recalled.length && !listed.length) return { output: {}, fired: [] };
    state.lastPrompt = fired.filter((id) => !id.startsWith("hint:"));
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
      ...(overBudget.length ? [BUDGET_NOTE] : []),
    ].join("\n");
    state.spent += text.length;
    saveSession(session, state);
    return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired };
  }

  const deferred: string[] = [];
  let budgetHit = false;
  for (const m of matches) {
    const e = resolve(store, m.id);
    if (!e) continue;
    const block = render(store, e, m, triggers.specs[m.id]?.origin);
    // Past the session budget a rule is named once instead of injected; it stays one mcp__batas__get away.
    if (state.spent + chars + block.length > config.inject.sessionBytes) {
      budgetHit = true;
      deferred.push(e.id);
      fired.push(e.id);
      state.injected.push(e.id);
      continue;
    }
    if (fired.length >= config.inject.maxItems || chars + block.length > config.inject.maxChars) {
      deferred.push(e.id);
      continue;
    }
    sections.push(block);
    chars += block.length;
    fired.push(e.id);
    state.injected.push(e.id);
  }
  if (!sections.length && !budgetHit) return { output: {}, fired: [] };
  const head = `batas: ${fired.length} ${live ? "warning(s)" : "rule(s)"} apply to this ${probe.cmd ? "command" : "edit"} — read before proceeding.`;
  const tail = deferred.length ? `\n\nAlso matched (fetch with mcp__batas__get): ${deferred.join(", ")}` : "";
  const text = `${head}\n\n${sections.join("\n\n")}${tail}${budgetHit ? `\n${BUDGET_NOTE}` : ""}`;
  state.spent += text.length;
  saveSession(session, state);
  return { output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } }, fired };
}

function injectedBytes(output: object): number {
  const o = output as { reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecisionReason?: string } };
  return (o.hookSpecificOutput?.additionalContext ?? o.hookSpecificOutput?.permissionDecisionReason ?? o.reason ?? "").length;
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
      repo: repoRoot(input.tool_name === "Bash" ? commandDir(input.tool_input?.command, input.cwd) : input.cwd),
      fired: result.fired,
      ms: Math.round(performance.now() - started),
      bytes: injectedBytes(result.output),
      ...(process.env.CLAUDE_CODE_ENTRYPOINT === "sdk-cli" ? { headless: true } : {}),
      ...(error ? { error } : {}),
    });
  } catch {}
}

if (import.meta.main) await main();
