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

  match(event: { cmd?: string; path?: string; code?: string; prompt?: string; reply?: string }): Match[] {
    const out: Match[] = [];
    for (const c of this.compiled) {
      if (event.cmd) {
        const hit = c.cmd.find((r) => r.test(event.cmd as string));
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
