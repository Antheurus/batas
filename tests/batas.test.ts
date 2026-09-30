import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../src/config.ts";
import { evaluate } from "../src/hook.ts";
import { Store } from "../src/store.ts";
import { Triggers } from "../src/triggers.ts";
import { logChangelog, logProgress, recordMemory } from "../src/write.ts";

const root = process.env.BATAS_TEST_ROOT as string;
const demo = join(root, "repos", "demo-app");
const store = new Store();
store.refresh("all");

describe("corpus", () => {
  test("indexes every numbered rule of both families exactly once", () => {
    const rows = store.db.query("SELECT id FROM entries WHERE kind = 'rule'").all() as { id: string }[];
    const gotcha = rows.filter((r) => r.id.startsWith("gotcha:")).length;
    const lessons = rows.filter((r) => r.id.startsWith("lessons:")).length;
    expect(gotcha).toBe(155);
    expect(lessons).toBe(134);
  });

  test("a rule moved into a slice keeps its permanent address", () => {
    const e = store.get("gotcha:B13");
    expect(e?.source.endsWith("p-gotcha-db.md")).toBe(true);
    expect(e?.body).toContain("uuid5");
  });

  test("search reaches memory and other repos' project rules", () => {
    expect(store.search("additionalContext ask popups").map((h) => h.id)).toContain("memory:-tmp-demo/hooks-warn-not-ask");
    expect(store.search("ESC/POS codepage rupiah")[0]?.scope).toBe("demo-app");
  });
});

describe("triggers", () => {
  const specs = Triggers.load().specs;
  const ids = Object.keys(specs).filter((id) => !id.startsWith("_"));

  test.skipIf(!ids.length)("cover every numbered rule and no phantom id", () => {
    const rules = (store.db.query("SELECT id FROM entries WHERE kind = 'rule'").all() as { id: string }[]).map((r) => r.id);
    expect(rules.filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => !rules.includes(id) && !id.startsWith("memory:"))).toEqual([]);
  });

  test.skipIf(!ids.length)("every fixture fires its own rule (the recall test)", () => {
    const t = Triggers.load();
    const misses: string[] = [];
    for (const id of ids) {
      const s = specs[id] ?? {};
      for (const cmd of s.t_cmd ?? []) if (!t.match({ cmd }).some((m) => m.id === id)) misses.push(`${id} cmd: ${cmd}`);
      for (const path of s.t_path ?? []) if (!t.match({ path }).some((m) => m.id === id)) misses.push(`${id} path: ${path}`);
      for (const code of s.t_code ?? []) if (!t.match({ code }).some((m) => m.id === id)) misses.push(`${id} code: ${code}`);
      for (const prompt of s.t_prompt ?? []) if (!t.match({ prompt }).some((m) => m.id === id)) misses.push(`${id} prompt: ${prompt}`);
      for (const reply of s.t_reply ?? []) if (!t.match({ reply }).some((m) => m.id === id)) misses.push(`${id} reply: ${reply}`);
      for (const reply of s.t_reply_ok ?? []) if (t.match({ reply }).some((m) => m.id === id)) misses.push(`${id} reply_ok fired: ${reply}`);
    }
    expect(misses).toEqual([]);
  });

  test.skipIf(!specs._negative)("ordinary commands, paths and prompts stay quiet", () => {
    const t = Triggers.load();
    const neg = specs._negative ?? {};
    const hits = [
      ...(neg.t_cmd ?? []).map((cmd) => t.match({ cmd }).length),
      ...(neg.t_path ?? []).map((path) => t.match({ path }).length),
      ...(neg.t_prompt ?? []).map((prompt) => t.match({ prompt }).length),
    ];
    const avg = hits.reduce((a, b) => a + b, 0) / Math.max(1, hits.length);
    expect(avg).toBeLessThan(1);
  });
});

describe("hook", () => {
  const t = new Triggers({
    "gotcha:B1": { cmd: ["\\bpg_restore\\b"], prompt: ["pg_dump"] },
    "lessons:C7": { reply: ["\\bgit reset --hard\\b"], reply_ok: ["would run"] },
  });

  test("injects the full rule once per session for a matching command", () => {
    const input = { session_id: "h1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore -d app x.dump" } };
    const first = evaluate(input, store, t);
    const ctx = (first.output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("gotcha:B1");
    expect(ctx).toContain("genuinely empty database");
    expect(evaluate(input, store, t).output).toEqual({});
  });

  test("prompt matches give one-line hints, not full text", () => {
    const r = evaluate({ session_id: "h2", hook_event_name: "UserPromptSubmit", prompt: "restore pg_dump kemarin" }, store, t);
    const ctx = (r.output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("- gotcha:B1:");
    expect(ctx).not.toContain("COPY");
  });

  test("Stop blocks a violating reply, once, and respects reply_ok and stop_hook_active", () => {
    const base = { session_id: "h3", hook_event_name: "Stop" };
    const bad = evaluate({ ...base, last_assistant_message: "I ran git reset --hard." }, store, t).output as { decision?: string; reason?: string };
    expect(bad.decision).toBe("block");
    expect(bad.reason).toContain("lessons:C7");
    expect(evaluate({ ...base, last_assistant_message: "I would run git reset --hard only if you say so." }, store, t).output).toEqual({});
    expect(evaluate({ ...base, stop_hook_active: true, last_assistant_message: "git reset --hard" }, store, t).output).toEqual({});
  });

  test("a reply that only QUOTES the mistake is not blocked", () => {
    const base = { session_id: "h5", hook_event_name: "Stop" };
    for (const quoted of [
      'The test sentence "I ran git reset --hard." was blocked.',
      "Evidence:\n```\ngit reset --hard\n```",
    ]) {
      expect(evaluate({ ...base, last_assistant_message: quoted }, store, t).output).toEqual({});
    }
    const real = evaluate({ ...base, last_assistant_message: 'Done — I ran git reset --hard after the "cleanup" step.' }, store, t);
    expect((real.output as { decision?: string }).decision).toBe("block");
  });

  test("code triggers fire on source edits but not on prose that quotes the pattern", () => {
    const ct = new Triggers({ "gotcha:C4": { code: ["\\bparseInt\\([^()\\n]*\\)\\s*\\|\\|"] } });
    const edit = (file_path: string, session_id: string) =>
      evaluate(
        { session_id, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path, new_string: "const n = parseInt(x) || 3" } },
        store,
        ct,
      ).fired;
    expect(edit("/r/src/config.ts", "c1")).toEqual(["gotcha:C4"]);
    expect(edit("/r/docs/progress.md", "c2")).toEqual([]);
  });

  test("a Read of an unrelated file stays silent", () => {
    const r = evaluate({ session_id: "h4", hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "/x/README.md" } }, store, t);
    expect(r.output).toEqual({});
  });
});

describe("writers", () => {
  test("changelog refuses a duplicate or older version and prepends a newer one", () => {
    expect(() => logChangelog({ projectDir: demo, version: "0.2.0", title: "x", bullets: ["y"] })).toThrow(/already has a heading/);
    expect(() => logChangelog({ projectDir: demo, version: "0.1.9", title: "x", bullets: ["y"] })).toThrow(/not newer/);
    logChangelog({ projectDir: demo, version: "0.3.0", title: "Batas", bullets: ["Aturan muncul sendiri."] });
    const text = readFileSync(join(demo, "docs", "changelog.md"), "utf8");
    expect(text.indexOf("## v0.3.0")).toBeLessThan(text.indexOf("## v0.2.0"));
  });

  test("progress creates the file, then marks a same-day second entry (cont)", () => {
    logProgress({ projectDir: demo, version: "0.3.0", title: "first", body: "Did a thing." });
    logProgress({ projectDir: demo, version: "0.3.0", title: "second", body: "Did another." });
    const text = readFileSync(join(demo, "docs", "progress.md"), "utf8");
    expect(text.startsWith("# demo-app Progress")).toBe(true);
    expect(text).toMatch(/## Session — \d{4}-\d{2}-\d{2} \(cont\) — v0\.3\.0 \(second\)[\s\S]*\(first\)/);
  });

  test("memory is written with frontmatter and a MEMORY.md pointer, and refuses silent overwrite", () => {
    const a = { projectDir: demo, type: "feedback" as const, name: "No Popups", title: "No popups", description: "warn, never ask", body: "Rule.\n\n**Why:** x\n**How to apply:** y" };
    const w = recordMemory(a);
    expect(readFileSync(w.file, "utf8")).toContain("type: feedback");
    const index = readFileSync(join(w.file, "..", "MEMORY.md"), "utf8");
    expect(index).toContain("- [No popups](no-popups.md) — warn, never ask");
    expect(() => recordMemory(a)).toThrow(/already exists/);
    recordMemory({ ...a, description: "updated line", replace: true });
    const again = readFileSync(join(w.file, "..", "MEMORY.md"), "utf8");
    expect(again.match(/no-popups\.md/g)?.length).toBe(1);
    expect(again).toContain("updated line");
  });
});

describe("mcp server", () => {
  test("lists the seven tools and answers recall and get over stdio", async () => {
    const client = new Client({ name: "batas-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [join(import.meta.dir, "..", "src", "mcp.ts")],
        env: { ...(process.env as Record<string, string>) },
        cwd: demo,
      }),
    );
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual(["check", "get", "log_changelog", "log_progress", "recall", "record", "status"]);
    const recall = (await client.callTool({ name: "recall", arguments: { query: "pg_dump restore empty database", limit: 3 } })) as {
      content: { text: string }[];
    };
    expect(recall.content[0]?.text).toContain("gotcha:B1");
    const get = (await client.callTool({ name: "get", arguments: { id: "lessons:C18" } })) as { content: { text: string }[] };
    expect(get.content[0]?.text).toContain("git stash push");
    const draft = (await client.callTool({
      name: "record",
      arguments: { type: "lesson", name: "x", title: "stash pop takes another session's work", description: "d", body: "git stash pop after a failed push" },
    })) as { content: { text: string }[] };
    expect(draft.content[0]?.text).toContain("Draft only");
    expect(draft.content[0]?.text).toContain("lessons:C18");
    await client.close();
  }, 30000);

  test("state stays under the test root", () => {
    expect(config.stateDir.startsWith(root)).toBe(true);
    expect(existsSync(join(config.claudeHome, "rules"))).toBe(true);
  });
});
