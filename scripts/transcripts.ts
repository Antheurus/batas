// Reads tool calls out of Claude Code session transcripts, in order. Shared by rule-audit and effect-audit.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Call = { cmd?: string; path?: string; code?: string; session: string; ts: number };

export function transcriptFiles(dir: string, fromMs: number, toMs = Number.POSITIVE_INFINITY, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) continue;
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

// ts: when the failure came back; usedAt: when the failing call was issued, so a later call can be told apart from a
// parallel one sent in the same message.
export type ToolError = { cmd?: string; tool: string; error: string; session: string; ts: number; usedAt: number };

// Failed tool calls, each paired with the call that produced it (a tool_result names its tool_use by id).
export function errorsIn(file: string): ToolError[] {
  const uses = new Map<string, { tool: string; cmd?: string; at: number }>();
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
        uses.set(b.id, { tool: String(b.name ?? ""), cmd: typeof input.command === "string" ? input.command : undefined, at: Date.parse(row.timestamp ?? "") || 0 });
      } else if (b.type === "tool_result" && b.is_error === true) {
        const c = b.content;
        const error = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
        const use = uses.get(String(b.tool_use_id ?? ""));
        const ts = Date.parse(row.timestamp ?? "") || 0;
        out.push({ cmd: use?.cmd, tool: use?.tool ?? "?", error, session: file, ts, usedAt: use?.at ?? ts });
      }
    }
  }
  return out;
}

// Every tool call and every failed result of one session, in transcript order: what the initiative eval walks to ask
// whether the agent turned to batas around a failure or before a destructive command.
export type ToolEvent =
  | { type: "use"; id: string; name: string; cmd?: string; query?: string; ts: number }
  | { type: "error"; id: string; tool: string; error: string; ts: number };

export function eventsIn(file: string): ToolEvent[] {
  const names = new Map<string, string>();
  const out: ToolEvent[] = [];
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
    const ts = Date.parse(row.timestamp ?? "") || 0;
    for (const b of content as Record<string, unknown>[]) {
      if (b.type === "tool_use" && typeof b.id === "string") {
        const input = (b.input ?? {}) as Record<string, unknown>;
        const name = String(b.name ?? "");
        names.set(b.id, name);
        out.push({ type: "use", id: b.id, name, cmd: typeof input.command === "string" ? input.command : undefined, query: typeof input.query === "string" ? input.query : undefined, ts });
      } else if (b.type === "tool_result" && b.is_error === true) {
        const c = b.content;
        const error = typeof c === "string" ? c : Array.isArray(c) ? c.map((x: { text?: string }) => x.text ?? "").join("\n") : "";
        const id = String(b.tool_use_id ?? "");
        out.push({ type: "error", id, tool: names.get(id) ?? "?", error, ts });
      }
    }
  }
  return out;
}

// How the session was first offered batas's recall: "deferred" (behind tool search), "loaded" (alwaysLoad), or
// undefined when it never had batas. Read from the harness's own records in the transcript (deferred_tools_delta lists
// what went behind tool search, tool_offer_record what was offered directly), so the alwaysLoad control group needs no
// session id on the MCP side.
export function recallListing(file: string): "deferred" | "loaded" | undefined {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes("mcp__batas__recall")) continue;
    const deferred = line.includes('"deferred_tools_delta"');
    const offered = line.includes('"tool_offer_record"');
    if (!deferred && !offered) continue;
    let row: { attachment?: { addedNames?: unknown; offered?: unknown } };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const names = (deferred ? row.attachment?.addedNames : row.attachment?.offered) as unknown;
    if (Array.isArray(names) && names.includes("mcp__batas__recall")) return deferred ? "deferred" : "loaded";
  }
  return undefined;
}
