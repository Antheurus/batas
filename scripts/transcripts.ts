// Reads tool calls out of Claude Code session transcripts, in order. Shared by rule-audit and effect-audit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Call = { cmd?: string; path?: string; code?: string; session: string; ts: number };

export function transcriptFiles(dir: string, fromMs: number, toMs = Number.POSITIVE_INFINITY, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) transcriptFiles(p, fromMs, toMs, out);
    else if (name.endsWith(".jsonl") && st.mtimeMs >= fromMs && st.birthtimeMs <= toMs) out.push(p);
  }
  return out;
}

export function callsIn(file: string): Call[] {
  const calls: Call[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"tool_use"')) continue;
    let row: { timestamp?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = Date.parse(row.timestamp ?? "") || 0;
    for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
      if (b.type !== "tool_use" || !b.input) continue;
      const i = b.input;
      if (b.name === "Bash" && typeof i.command === "string") calls.push({ cmd: i.command, session: file, ts });
      else if (typeof i.file_path === "string") {
        const prose = /\.(md|mdx|txt|rst|toml)$/i.test(i.file_path);
        const code = prose ? undefined : [i.new_string, i.content].filter((x) => typeof x === "string").join("\n").slice(0, 20000);
        calls.push({ path: i.file_path, code: code || undefined, session: file, ts });
      }
    }
  }
  return calls;
}

export type ToolError = { cmd?: string; tool: string; error: string; session: string; ts: number };

// Failed tool calls, each paired with the call that produced it (a tool_result names its tool_use by id).
export function errorsIn(file: string): ToolError[] {
  const uses = new Map<string, { tool: string; cmd?: string }>();
  const out: ToolError[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const isUse = line.includes('"tool_use"');
    const isErr = line.includes('"is_error":true');
    if (!isUse && !isErr) continue;
    let row: { timestamp?: string; message?: { content?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        uses.set(b.id, { tool: String(b.name ?? ""), cmd: typeof input.command === "string" ? input.command : undefined });
      } else if (b.type === "tool_result" && b.is_error === true) {
        const c = b.content;
        const error = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
        const use = uses.get(String(b.tool_use_id ?? ""));
        out.push({ cmd: use?.cmd, tool: use?.tool ?? "?", error, session: file, ts: Date.parse(row.timestamp ?? "") || 0 });
      }
    }
  }
  return out;
}
