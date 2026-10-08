import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { config } from "./config.ts";
import { memorySources, memoryTriggers, parseMemory, projectSlug, type Entry, type Kind } from "./corpus.ts";
import { mutedIds, recordAck, reportWrong } from "./feedback.ts";
import { filesInCommand, lessonsDir, regenAll, regenIfLessonsChanged, routedLessons } from "./lessons.ts";
import { appendHookLog, liveSessions } from "./log.ts";
import { semanticSearch, takeStashed, type SemanticHit } from "./semantic.ts";
import { Store } from "./store.ts";

const SEMANTIC_KINDS: Kind[] = ["memory", "rule", "rule-section", "project-rule", "context"];
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
  // semantic searches left with batasd for a later hook call to pick up: the prompt's, and each new file's
  pending: Pending[];
};

type Pending = { key: string; kind: "prompt" | "write"; at: number; file?: string };

// Harness-generated turns (a background agent finishing, a system reminder) arrive as UserPromptSubmit too; their
// text is an agent's report, not the user's request, so matching phrases in it only produces noise.
const SYSTEM_PROMPT = /<task-notification>|\[SYSTEM NOTIFICATION/;

// The budget sits above every measured session, so it only stops a runaway, never an ordinary day's rules.
const BUDGET_NOTE = `batas: this session's injection budget (${Math.round(config.inject.sessionBytes / 1000)} KB) is spent — further matches are named, not injected; read them with mcp__batas__get.`;
// The user's way of saying the last injection did not belong; it mutes those ids for the session and is recorded.
// Commands that read or write the shared index and working tree — exactly what a second session in the same checkout
// can corrupt or carry along.
// `git`, then any global options (-C dir, -c key=value, --no-pager), then the subcommand: written as `git\s+push`, a
// plain `git -C ../repo push` walked straight past every pattern below.
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]+))*\s+`;
const git = (rest: string) => new RegExp(GIT + rest);
const SHARED_GIT = git(String.raw`(commit|push|add|stash|reset|checkout|switch|merge|rebase|pull|restore|clean|cherry-pick|revert)\b`);

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

// The repo a project rule or lesson is scoped to. A worktree's `.git` is a file naming the main repo's git dir, and
// the corpus is indexed from the main checkout, so a session in `mendadak-pos-wt-x` still means `mendadak-pos`.
export function repoName(cwd: string | undefined): string | undefined {
  const root = repoRoot(cwd);
  if (!root) return undefined;
  try {
    const dotgit = join(root, ".git");
    if (statSync(dotgit).isFile()) {
      const gitdir = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      const main = gitdir?.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)?.[1];
      if (main) return basename(main);
    }
  } catch {}
  return basename(root);
}

// Commands that take EVERY dirty file in the tree, so they cannot tell this session's work from another's.
const SWEEPING = [
  git(String.raw`add\s+(?:[^|;&]*\s)?(-A|--all|-u|--update|\.)(?=\s|$|[;&|])`),
  git(String.raw`commit\s+(?:[^|;&]*\s)?(-[a-zA-Z]*a[a-zA-Z]*|--all)(?=\s|$|[;&|])`),
  git(String.raw`stash(?!\s+(list|show|pop|apply|drop|branch)\b)(?![^|;&]*\s--\s)`),
  git(String.raw`(checkout|restore)\s+(?:[^|;&]*\s)?(--\s+)?\.(?=\s|$|[;&|])`),
  git(String.raw`reset\s+(?:[^|;&]*\s)?--hard\b`),
  git(String.raw`clean\s+(?:[^|;&]*\s)?-[a-zA-Z]*f`),
];
const PUSH = git(String.raw`push\b`);
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
function attributeBash(input: HookInput, state: SessionState): string[] {
  if (!state.bashStart) return [];
  const repos = new Set(
    [repoRoot(commandDir(input.tool_input?.command, input.cwd)), repoRoot(input.cwd)].filter((r): r is string => !!r),
  );
  const added: string[] = [];
  for (const repo of repos) {
    for (const f of dirtyFiles(repo)) {
      const m = mtime(f);
      if (m !== undefined && m >= state.bashStart - 5 && !state.touched.includes(f)) {
        state.touched.push(f);
        added.push(f);
      }
    }
  }
  return added;
}

// Lessons routed to files a Bash command opened or changed, which Claude Code's path rules never load for. Each file's
// lessons go in once per session and count against the session budget.
function bashLessons(files: string[], input: HookInput, state: SessionState): { text: string; ids: string[] } | undefined {
  if (process.env.BATAS_NO_BASH_LESSONS === "1") return undefined;
  const parts: string[] = [];
  const ids: string[] = [];
  let bytes = 0;
  for (const f of files) {
    const repo = repoRoot(dirname(f));
    const hit = repo ? routedLessons(repo, f) : undefined;
    if (!hit || state.injected.includes(hit.id)) continue;
    if (state.spent + bytes + hit.text.length > config.inject.sessionBytes) {
      parts.push(`(more lessons for ${hit.id.slice("lessons-file:".length)} — session budget spent; read .claude/rules/lessons/)`);
      continue;
    }
    parts.push(hit.text);
    bytes += hit.text.length;
    ids.push(hit.id);
    state.injected.push(hit.id);
  }
  if (!parts.length) return undefined;
  const text = [
    "batas: lessons recorded for the file(s) this Bash command opened or changed — Claude Code only loads them for the",
    "Read/Edit/Write tools, so here they are. Read them before changing this code.",
    "",
    ...parts,
  ].join("\n");
  state.spent += text.length;
  return { text, ids };
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

// Blocks only the two shapes that carry another session's work: a sweeping stage/discard while their
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
      pending: s.pending ?? [],
    };
  } catch {
    return { injected: [], hinted: [], lastPrompt: [], muted: [], touched: [], started: Date.now(), bashStart: 0, spent: 0, pending: [] };
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
export function saysTrigger(promptLower: string, trigger: string): boolean {
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
  semantic?: SemanticHit[],
): { full: Entry[]; more: Pick<Entry, "id" | "title">[] } {
  if (semantic) return semanticMemories(store, project, skip, semantic);
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

// A nearest neighbour always exists and absolute cosines overlap (the right lesson for a probe: Gemma 0.77 median; the
// top hit of an unrelated real prompt: 0.72), so only a hit that STANDS OUT counts: the best Gemma cosine at least
// config.semantic.minGap above the 10th-best over this repo's entries (`ref`, from batasd). Calibrated 2026-10-08 with
// `just semantic-calibrate` on 80 probes and 300 real prompts: at 0.07 it passes 16/300 prompts (~18 of 22 read by hand
// at 0.065 were relevant) and keeps 20/43 probe positives. Only that single best hit passes.
export function passing(semantic: SemanticHit[], minGap = config.semantic.minGap): SemanticHit[] {
  if (!semantic.length) return [];
  const g = semantic.map((h) => h.cos.g ?? 0).sort((a, b) => b - a);
  const best = semantic.reduce((a, b) => ((b.cos.g ?? 0) > (a.cos.g ?? 0) ? b : a));
  const ref = semantic[0]?.ref ?? g[Math.min(9, g.length - 1)] ?? 1;
  return (best.cos.g ?? 0) - ref >= minGap ? [best] : [];
}

function semanticMemories(
  store: Store,
  project: string,
  skip: string[],
  semantic: SemanticHit[],
  minGap = config.semantic.minGap,
): { full: Entry[]; more: Pick<Entry, "id" | "title">[] } {
  const hits = passing(semantic, minGap).filter((h) => h.kind === "memory" && !skip.includes(h.id));
  const seen = new Set<string>();
  const unique = hits.filter((h) => {
    const name = h.id.split("/").pop() ?? h.id;
    if (seen.has(name)) return false;
    seen.add(name);
    return true;
  });
  const entries = unique.map((h) => resolve(store, h.id)).filter((e): e is Entry => !!e);
  const strong = entries.filter((e, i) => (unique[i]?.cos.g ?? 0) >= config.semantic.fullCos || e.scope === project).slice(0, config.inject.maxMemories);
  return { full: strong, more: entries.filter((e) => !strong.includes(e)).slice(0, config.inject.maxMoreMemories) };
}

// Rules, project rules and lessons whose meaning is close to the prompt: listed by id like a prompt-phrase match, so the
// agent opens the ones that apply. Another repo's project rules and lessons are not this session's business.
function semanticRules(semantic: SemanticHit[] | undefined, repo: string | undefined, skip: Set<string>, minGap = config.semantic.minGap): SemanticHit[] {
  if (!semantic) return [];
  return passing(semantic, minGap)
    .filter((h) => h.kind !== "memory" && !skip.has(h.id))
    .filter((h) => h.scope === "global" || h.scope === repo)
    .slice(0, config.inject.maxPromptHints);
}

// Routed lesson files are a generated copy of docs/lessons resolved against the code, so they go stale the moment either
// changes. A lesson edit is caught on the next hook call (a stat of docs/lessons), a renamed or moved symbol only by a
// full re-resolution, which runs before a commit: the commit is refused once, with the files already regenerated, so
// the next attempt can stage them. Hand edits to the generated files are flagged, since the next run discards them.
function lessonsUpkeep(input: HookInput, probe: { cmd?: string; path?: string }): { id: string; text: string; deny?: boolean } | undefined {
  const dir = probe.cmd ? commandDir(probe.cmd, input.cwd) : probe.path ? dirname(probe.path) : input.cwd;
  const repo = repoRoot(dir);
  if (!repo || !existsSync(lessonsDir(repo))) return undefined;
  if (probe.path?.includes("/.claude/rules/lessons/") && input.tool_name && WRITE_TOOLS.has(input.tool_name)) {
    return {
      id: "lessons:generated",
      text: "batas: .claude/rules/lessons/ is generated from docs/lessons by `just lessons-route` — the next run discards an edit here. Change the lesson in docs/lessons/ instead.",
    };
  }
  if (probe.cmd && git(String.raw`commit\b`).test(shellSurface(probe.cmd)) && !ACK_FOREIGN.test(probe.cmd)) {
    const stale = regenAll(repo);
    if (stale.length) {
      return {
        id: "lessons:stale",
        deny: true,
        text:
          `batas: ${stale.length} routed lesson file(s) were stale against docs/lessons and the code, and have just been regenerated ` +
          "(a lesson changed, or a symbol it names was renamed or moved). Stage them with this commit — `git add -f .claude/rules/lessons/` — then commit again.",
      };
    }
    return undefined;
  }
  const changed = regenIfLessonsChanged(repo);
  if (!changed?.length) return undefined;
  return {
    id: "lessons:regen",
    text: `batas: docs/lessons changed, so .claude/rules/lessons/ was regenerated (${changed.length} file(s)). Commit them with the lesson change.`,
  };
}

// A semantic match delivered on a later hook call than the one that asked for it. For a prompt: batasd could not
// answer inside the prompt budget (an idle Apple GPU takes 0.5-0.7 s to answer its first query), and the next call is
// normally the turn's first tool use, so the match still lands before the agent acts. For a new file: the write was
// never held up for the search, so the match lands after the file exists, and it says so — full text, because the
// agent has to compare the file against it, not go look it up.
export function lateSemantic(
  input: HookInput,
  store: Store,
  hits: SemanticHit[],
  state: SessionState,
  kind: "prompt" | "write" = "prompt",
  file?: string,
): { text: string; fired: string[] } | undefined {
  const minGap = kind === "write" ? config.semantic.writeGap : config.semantic.minGap;
  const silenced = new Set([...state.muted, ...Object.keys(mutedIds())]);
  const skip = [...state.injected, ...state.hinted, ...silenced];
  const project = input.cwd ? projectSlug(input.cwd) : "";
  const mem = semanticMemories(store, project, skip, hits, minGap);
  const rules = semanticRules(hits, repoName(input.cwd), new Set(skip), minGap);
  const lines: string[] = [];
  const fired: string[] = [];
  const full = (e: Entry) => {
    const body = e.body.length > config.inject.memoryChars ? `${e.body.slice(0, config.inject.memoryChars)}…` : e.body;
    return `### ${e.id} — ${e.title}\n${body}`;
  };
  for (const m of mem.full) {
    const block = full(m);
    if (state.spent + block.length > config.inject.sessionBytes) continue;
    lines.push(block);
    state.injected.push(m.id);
    fired.push(m.id);
  }
  for (const m of mem.more) {
    lines.push(`- ${m.id} — ${m.title}`);
    state.hinted.push(m.id);
    fired.push(m.id);
  }
  for (const h of rules) {
    const e = resolve(store, h.id);
    if (kind === "write" && e) {
      lines.push(full(e));
      state.injected.push(h.id);
    } else {
      lines.push(`- ${h.id}: ${e?.title ?? h.title}`);
      state.hinted.push(h.id);
    }
    fired.push(h.id);
  }
  if (!lines.length) return undefined;
  const head =
    kind === "write"
      ? `batas: a recorded lesson matches the file just written (${file ?? "?"}). Check that file against it now and fix it if it applies:`
      : "batas: closest recorded match for the user's last request (arrived after the prompt) — use it only if it applies:";
  const text = [head, ...lines].join("\n");
  state.spent += text.length;
  return { text, fired };
}

export function evaluate(input: HookInput, store: Store, triggers: Triggers, semantic?: SemanticHit[]): { output: object; fired: string[] } {
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
    const changed = attributeBash(input, st);
    const lessons = changed.length ? bashLessons(changed, input, st) : undefined;
    if (changed.length) saveSession(session, st);
    const upkeep = changed.some((f) => f.includes("/docs/lessons/")) ? lessonsUpkeep(input, {}) : undefined;
    const text = [lessons?.text, upkeep?.text].filter(Boolean).join("\n\n");
    if (!text) return { output: {}, fired: [] };
    return {
      output: { hookSpecificOutput: { hookEventName: event, additionalContext: text } },
      fired: [...(lessons?.ids ?? []), ...(upkeep ? [upkeep.id] : [])],
    };
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
      ? relevantMemories(store, probe.prompt, project, [...state.injected, ...state.hinted, ...silenced], semantic)
      : { full: [], more: [] };
  const meant = probe.prompt
    ? semanticRules(semantic, repoName(input.cwd), new Set([...state.injected, ...state.hinted, ...silenced, ...matches.map((m) => m.id)]))
    : [];
  const upkeep = event === "PreToolUse" ? lessonsUpkeep(input, probe) : undefined;
  if (upkeep?.deny) {
    return {
      output: { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: upkeep.text } },
      fired: [upkeep.id],
    };
  }
  const live = probe.cmd ? liveNote(input, state) : probe.path ? step5bNote(input, state) : undefined;
  const opened = probe.cmd
    ? bashLessons(filesInCommand(probe.cmd, commandDir(probe.cmd, input.cwd) ?? input.cwd ?? "/"), input, state)
    : undefined;
  if (!matches.length && !meant.length && !memories.full.length && !memories.more.length && !live && !opened && !upkeep) return { output: {}, fired: [] };

  const sections: string[] = [];
  const fired: string[] = [];
  let chars = 0;
  if (live) {
    sections.push(live.text);
    fired.push(live.id);
    state.injected.push(live.id);
  }
  if (opened) {
    sections.push(opened.text);
    fired.push(...opened.ids);
  }
  if (upkeep) {
    sections.push(upkeep.text);
    fired.push(upkeep.id);
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
    for (const h of meant.slice(0, Math.max(0, config.inject.maxPromptHints - fresh.length))) {
      sections.push(`- ${h.id}: ${resolve(store, h.id)?.title ?? h.title}`);
      state.hinted.push(h.id);
      fired.push(h.id);
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

const SEMANTIC_WRITE = /\.(go|ts|tsx|js|mjs|vue|svelte|py|sql|html)$/;

// Searches left with batasd are picked up here on every later hook call of the session: a cold prompt's, and the one
// each newly written source file starts (the write itself never waits for it). At Stop, anything still pending is
// waited for briefly and, if it matches, blocks the stop once — otherwise a turn that ends right after the write would
// never see the lesson about it. A deny keeps them pending, so the match is not spent on a call that did not happen.
async function settleSemantic(
  input: HookInput,
  store: Store,
  result: { output: object; fired: string[] },
  semanticState: "warm" | "cold" | undefined,
): Promise<{ output: object; fired: string[] }> {
  const session = input.session_id as string;
  const event = input.hook_event_name;
  const state = loadSession(session);
  let dirty = false;
  if (event === "UserPromptSubmit" && semanticState === "cold") {
    state.pending.push({ key: session, kind: "prompt", at: Date.now() });
    dirty = true;
  }
  const file = input.tool_input?.file_path;
  const content = input.tool_input?.content;
  if (
    event === "PreToolUse" && input.tool_name === "Write" && config.semantic.writeHook &&
    file && typeof content === "string" && SEMANTIC_WRITE.test(file) && process.env.BATAS_NO_WRITE_SEMANTIC !== "1"
  ) {
    const rel = input.cwd && file.startsWith(input.cwd) ? file.slice(input.cwd.length + 1) : file;
    const key = `${session}:w:${Date.now()}`;
    void semanticSearch(`${rel}\n${content.slice(0, 1500)}`, { kinds: SEMANTIC_KINDS, scope: repoName(input.cwd), limit: 12, stash: key, timeoutMs: 30 });
    state.pending.push({ key, kind: "write", at: Date.now(), file: rel });
    dirty = true;
  }
  const now = Date.now();
  const live = state.pending.filter((p) => now - p.at < 300_000);
  if (live.length !== state.pending.length) dirty = true;
  state.pending = live;
  const o = result.output as { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName?: string; additionalContext?: string; permissionDecision?: string } };
  const stopping = event === "Stop" || event === "SubagentStop";
  const ready = live.filter((p) => !(event === "UserPromptSubmit" && p.kind === "prompt") && !(event === "PreToolUse" && p.kind === "write" && now - p.at < 5));
  if (!ready.length || o.hookSpecificOutput?.permissionDecision === "deny" || (stopping && input.stop_hook_active)) {
    if (dirty) saveSession(session, state);
    return result;
  }
  const texts: string[] = [];
  const fired: string[] = [];
  for (const p of ready) {
    const hits = await takeStashed(p.key, 40, stopping ? 1500 : 0);
    if (hits === undefined) continue;
    if (hits === null) {
      if (stopping) state.pending = state.pending.filter((x) => x !== p);
      continue;
    }
    state.pending = state.pending.filter((x) => x !== p);
    const late = lateSemantic(input, store, hits, state, p.kind, p.file);
    if (late) {
      texts.push(late.text);
      fired.push(...late.fired);
    }
  }
  saveSession(session, state);
  if (!texts.length) return result;
  const text = texts.join("\n\n");
  if (stopping) {
    const reason = o.decision === "block" && o.reason ? `${o.reason}\n\n${text}` : text;
    return { output: { decision: "block", reason }, fired: [...result.fired, ...fired] };
  }
  const prior = o.hookSpecificOutput?.additionalContext;
  return {
    output: { ...o, hookSpecificOutput: { ...o.hookSpecificOutput, hookEventName: event, additionalContext: prior ? `${prior}\n\n${text}` : text } },
    fired: [...result.fired, ...fired],
  };
}

// A `claude -p` session is the agent's own probe until it commits; from then on its commits ride on the next push.
export function logFlags(input: HookInput, entrypoint?: string): { headless?: true; committed?: true } {
  const command = input.tool_name === "Bash" ? (input.tool_input?.command ?? "") : "";
  return {
    ...(entrypoint === "sdk-cli" ? { headless: true as const } : {}),
    ...(git(String.raw`commit\b`).test(shellSurface(command)) ? { committed: true as const } : {}),
  };
}

function injectedBytes(output: object): number {
  const o = output as { reason?: string; hookSpecificOutput?: { additionalContext?: string; permissionDecisionReason?: string } };
  return (o.hookSpecificOutput?.additionalContext ?? o.hookSpecificOutput?.permissionDecisionReason ?? o.reason ?? "").length;
}

async function main() {
  // The control arm of an A/B eval: a session that must run with no batas at all.
  if (process.env.BATAS_OFF === "1") {
    process.stdout.write("{}");
    return;
  }
  const started = performance.now();
  let input: HookInput = {};
  let result: { output: object; fired: string[] } = { output: {}, fired: [] };
  let error: string | undefined;
  let semantic: SemanticHit[] | undefined;
  let semanticState: "warm" | "cold" | undefined;
  try {
    input = JSON.parse(await Bun.stdin.text()) as HookInput;
    const prompting = input.hook_event_name === "UserPromptSubmit" && !!input.prompt && !SYSTEM_PROMPT.test(input.prompt);
    // Sent before the corpus is read, so the daemon encodes while this process parses; whatever is left of the prompt
    // budget is the wait. A cold or busy daemon costs this prompt its semantic match (the trigger words still run),
    // never the user's time.
    const own = prompting && config.semantic.promptHook ? ownWords(input.prompt ?? "").trim() : "";
    // Scoped to the session's repo: the standout gate compares the best hit with this repo's 10th neighbour, which is
    // what actually competes here (an unscoped reference drowned the right lesson in every other repo's entries).
    const pending = own ? semanticSearch(own, { kinds: SEMANTIC_KINDS, scope: repoName(input.cwd), limit: 12, stash: input.session_id, timeoutMs: Math.max(20, config.latencyBudgetMs.prompt - (performance.now() - started) - 30) }) : undefined;
    const store = new Store();
    store.refresh("rules", prompting && input.cwd ? memorySources(projectSlug(input.cwd)) : []);
    if (pending) {
      semantic = await pending;
      semanticState = semantic ? "warm" : "cold";
    }
    result = evaluate(input, store, Triggers.load(), semantic);
    if (input.session_id) result = await settleSemantic(input, store, result, semanticState);
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
      ...logFlags(input, process.env.CLAUDE_CODE_ENTRYPOINT),
      ...(semanticState ? { semantic: semanticState } : {}),
      ...(error ? { error } : {}),
    });
  } catch {}
}

if (import.meta.main) await main();
