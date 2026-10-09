import { existsSync, readFileSync } from "node:fs";
import picomatch from "picomatch";
import { config } from "./config.ts";

export type TriggerSpec = {
  cmd?: string[];
  path?: string[];
  prompt?: string[];
  reply?: string[];
  reply_ok?: string[];
  code?: string[];
  text?: string;
  origin?: string;
  recorded?: string;
  repo?: string[];
  t_code?: string[];
  t_cmd?: string[];
  t_path?: string[];
  t_prompt?: string[];
  t_reply?: string[];
  t_reply_ok?: string[];
};

export type Via = "cmd" | "path" | "code" | "prompt" | "reply";
export type Match = { id: string; via: Via; pattern: string };

type Compiled = {
  id: string;
  repo: string[];
  cmd: RegExp[];
  path: { glob: string; test: (p: string) => boolean }[];
  code: RegExp[];
  prompt: ReturnType<typeof phrase>[];
  reply: RegExp[];
  replyOk: RegExp[];
};

const WORD = /[\p{L}\p{N}_]/u;

// A reply that QUOTES a mistaken sentence (a test input, an example, evidence) is not making it, so quoted
// multi-word spans and fenced blocks are removed before reply patterns run. Inline code and one-word quotes
// stay: "silakan jalankan `bun test`" and permissionDecision "ask" carry their signal exactly there.
function unquoted(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/"[^"\n]*\s[^"\n]*"|“[^”\n]*\s[^”\n]*”/g, " ");
}

const CODE_FLAGS = /(?:^|\s)(?:-c|-lc|-e|--command|--eval|eval|run-code)\s*$/;
const REMOTE_SEGMENT = /(?:^|[;&|(]\s*)(?:ssh|sshepherd|docker\s+exec|kubectl\s+exec)\b[^;&|]*$/;
const INTERPRETER = /(?:^|[\s;&|(])(?:python3?|node|bun|psql|sqlite3|bash|sh|zsh|ruby|perl)\b[^\n;&|]*$/;

// Spans of a shell command that are DATA — a quoted argument or a heredoc body — and so cannot be the command
// the rule is about: `git commit -m "never git push --force"` and `just fire "lsof -ti :3000"` only mention a
// pattern. Code handed to an interpreter (`psql -c "..."`, `python3 -c`, a heredoc fed to python) is not data.
export function dataSpans(cmd: string): [number, number][] {
  const spans: [number, number][] = [];
  const codeBodies: [number, number][] = [];
  const heredoc = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?:\n|$)/g;
  for (let m = heredoc.exec(cmd); m; m = heredoc.exec(cmd)) {
    const before = cmd.slice(0, m.index);
    const start = m.index + m[0].indexOf("\n") + 1;
    const body: [number, number] = [start, start + (m[3]?.length ?? 0)];
    (INTERPRETER.test(before.split("\n").pop() ?? "") ? codeBodies : spans).push(body);
  }
  const inAny = (at: number, list: [number, number][]) => list.some(([a, b]) => at >= a && at < b);
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i];
    if (inAny(i, codeBodies)) {
      i++;
      continue;
    }
    if ((ch === "'" || ch === '"') && !inAny(i, spans)) {
      let j = i + 1;
      while (j < cmd.length && cmd[j] !== ch) j += ch === '"' && cmd[j] === "\\" ? 2 : 1;
      const before = cmd.slice(0, i);
      if (!CODE_FLAGS.test(before) && !REMOTE_SEGMENT.test(before)) spans.push([i, j + 1]);
      i = j + 1;
      continue;
    }
    i++;
  }
  return spans;
}

export function matchOutside(re: RegExp, text: string, spans: [number, number][]): boolean {
  if (!spans.length) return re.test(text);
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (let m = g.exec(text); m; m = g.exec(text)) {
    const at = m.index;
    if (!spans.some(([a, b]) => at >= a && at < b)) return true;
    if (m[0].length === 0) g.lastIndex++;
  }
  return false;
}

// Compiling one `\p{L}` regex per phrase cost ~0.4ms each and ~300ms per hook call across the corpus;
// a lowercase indexOf with a single shared boundary test does the same match in microseconds.
function phrase(p: string): { source: string; test: (text: string) => boolean } {
  const needle = p.toLowerCase();
  return {
    source: p,
    test: (text: string) => {
      const hay = text.toLowerCase();
      for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
        const before = hay[at - 1];
        const after = hay[at + needle.length];
        if ((!before || !WORD.test(before)) && (!after || !WORD.test(after))) return true;
      }
      return false;
    },
  };
}

export class Triggers {
  readonly specs: Record<string, TriggerSpec>;
  private compiled: Compiled[];

  constructor(specs: Record<string, TriggerSpec>) {
    this.specs = specs;
    this.compiled = Object.entries(specs)
      .filter(([id]) => !id.startsWith("_"))
      .map(([id, s]) => ({
        id,
        repo: s.repo ?? [],
        cmd: (s.cmd ?? []).map((r) => new RegExp(r, "i")),
        path: (s.path ?? []).map((g) => ({ glob: g, test: picomatch(g, { dot: true, nocase: true }) })),
        code: (s.code ?? []).map((r) => new RegExp(r, "i")),
        prompt: (s.prompt ?? []).map(phrase),
        reply: (s.reply ?? []).map((r) => new RegExp(r, "iu")),
        replyOk: (s.reply_ok ?? []).map((r) => new RegExp(r, "iu")),
      }));
  }

  static load(file = config.triggersFile): Triggers {
    if (!existsSync(file)) return new Triggers({});
    return new Triggers(Bun.TOML.parse(readFileSync(file, "utf8")) as Record<string, TriggerSpec>);
  }

  // `repo` limits a spec to sessions in those repos (by name, worktrees included): a memory recorded for one codebase
  // whose mistake is visible only in code, where the same code elsewhere is fine.
  match(event: { cmd?: string; path?: string; code?: string; prompt?: string; reply?: string; repo?: string }): Match[] {
    const out: Match[] = [];
    const spans = event.cmd ? dataSpans(event.cmd) : [];
    for (const c of this.compiled) {
      if (c.repo.length && !(event.repo && c.repo.includes(event.repo))) continue;
      if (event.cmd) {
        const hit = c.cmd.find((r) => matchOutside(r, event.cmd as string, spans));
        if (hit) {
          out.push({ id: c.id, via: "cmd", pattern: hit.source });
          continue;
        }
      }
      if (event.path) {
        const hit = c.path.find((g) => g.test(event.path as string));
        if (hit) {
          out.push({ id: c.id, via: "path", pattern: hit.glob });
          continue;
        }
      }
      if (event.code) {
        const hit = c.code.find((r) => r.test(event.code as string));
        if (hit) {
          out.push({ id: c.id, via: "code", pattern: hit.source });
          continue;
        }
      }
      if (event.prompt) {
        const hit = c.prompt.find((r) => r.test(event.prompt as string));
        if (hit) {
          out.push({ id: c.id, via: "prompt", pattern: hit.source });
          continue;
        }
      }
      if (event.reply && c.reply.length) {
        const own = unquoted(event.reply);
        const hit = c.reply.find((r) => r.test(own));
        if (hit && !c.replyOk.some((r) => r.test(own))) {
          out.push({ id: c.id, via: "reply", pattern: hit.source });
        }
      }
    }
    return out;
  }

  ids(): string[] {
    return this.compiled.map((c) => c.id);
  }
}
