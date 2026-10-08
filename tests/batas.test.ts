import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { config } from "../src/config.ts";
import { evaluate, lateSemantic, logFlags } from "../src/hook.ts";
import { auditPrompts } from "../scripts/prompt-audit.ts";
import { gitIndex, judgePath, namedPaths, resolveRoot } from "../scripts/memory-audit.ts";
import { mine, signature } from "../scripts/lesson-mine.ts";
import { copiesOf, shareMemory } from "../scripts/memory-share.ts";
import { routeLessons, ruleFile, staleFiles } from "../scripts/lessons-route.ts";
import { routeRepo, writeRoutes } from "../src/lessons.ts";
import { errorsIn } from "../scripts/transcripts.ts";
import { allMemorySources } from "../src/corpus.ts";
import { mutedIds, readAcks, readFeedback, setMuted } from "../src/feedback.ts";
import { appendHookLog, liveSessions, readHookLog } from "../src/log.ts";
import { Store } from "../src/store.ts";
import { Triggers } from "../src/triggers.ts";
import { indexHook, INDEX_HOOK_MAX, logChangelog, logProgress, recordMemory } from "../src/write.ts";

const root = process.env.BATAS_TEST_ROOT as string;
const demo = join(root, "repos", "demo-app");
const store = new Store();
store.refresh("all");

describe("corpus", () => {
  test("indexes every numbered rule of both families exactly once", () => {
    const rows = store.entries("rule");
    const gotcha = rows.filter((r) => r.id.startsWith("gotcha:")).length;
    const lessons = rows.filter((r) => r.id.startsWith("lessons:")).length;
    expect(gotcha).toBe(155);
    expect(lessons).toBe(136);
  });

  test("a rule moved into a slice keeps its permanent address", () => {
    const e = store.get("gotcha:B13");
    expect(e?.source.endsWith("p-gotcha-db.md")).toBe(true);
    expect(e?.body).toContain("uuid5");
  });
});

describe("triggers", () => {
  const specs = Triggers.load().specs;
  const ids = Object.keys(specs).filter((id) => !id.startsWith("_"));

  test.skipIf(!ids.length)("cover every numbered rule and no phantom id", () => {
    const rules = store.entries("rule").map((r) => r.id);
    expect(rules.filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => id.startsWith("hint:") && !specs[id]?.text)).toEqual([]);
    expect(ids.filter((id) => !rules.includes(id) && !/^(memory|hint):/.test(id))).toEqual([]);
  });

  test.skipIf(!ids.length)("every rule in an injected-only slice has a cmd/path/code trigger — or it can never arrive", () => {
    const injected = store.entries("rule").filter((r) => r.source.endsWith("-injected.md")).map((r) => r.id);
    const unreachable = injected.filter((id) => {
      const s = specs[id] ?? {};
      return !(s.cmd?.length || s.path?.length || s.code?.length);
    });
    expect(unreachable).toEqual([]);
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

describe("memory index", () => {
  test("indexHook cuts at a clause break, then a word boundary, and leaves short hooks alone", () => {
    expect(indexHook("short hook")).toBe("short hook");
    expect(indexHook("its TOP CPU column is ps %CPU, not live load; confirm with top -l 2 before blaming a process and more")).toBe(
      "its TOP CPU column is ps %CPU, not live load",
    );
    const long = indexHook("a".repeat(10) + " word".repeat(40));
    expect(long.length).toBeLessThanOrEqual(INDEX_HOOK_MAX + 1);
    expect(long.endsWith("…")).toBe(true);
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

  test("a fired always-on family rule injects its verbatim full text, not the condensed line", () => {
    const input = { session_id: "f1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore -d app y.dump" } };
    const ctx = (evaluate(input, store, t).output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("restore reports success");
    expect(ctx).not.toContain("_linked from");
  });

  test("a prompt sharing three content words with a trigger-less memory only lists it, once", () => {
    const none = new Triggers({});
    const ask = (prompt: string, session_id: string) =>
      evaluate({ session_id, cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt }, store, none);
    const hit = ask("bikin hooks yang warn aja, jangan ask popups advisory", "m1").output as { hookSpecificOutput?: { additionalContext: string } };
    expect(hit.hookSpecificOutput?.additionalContext).toContain("- memory:-tmp-demo/hooks-warn-not-ask");
    expect(hit.hookSpecificOutput?.additionalContext).not.toContain("### memory:-tmp-demo/hooks-warn-not-ask");
    expect(ask("bikin hooks yang warn aja, jangan ask popups advisory", "m1").output).toEqual({});
    expect(ask("perketat\n\nHere is a note offered by a side agent:\n> hooks warn ask popups advisory", "m4").output).toEqual({});
  });

  test("a semantic hit arrives only when it stands out from the 10th neighbour, and only the best one", () => {
    const none = new Triggers({});
    const gap = config.semantic.minGap;
    const hit = (id: string, kind: string, scope: string, g: number) =>
      ({ id, kind, scope, title: id, source: "x", score: 0.03, cos: { g, e: 0.85 } }) as never;
    const crowd = (base: number) => Array.from({ length: 10 }, (_, i) => hit(`ref:filler-${i}`, "reference", "global", base - i * 0.001));
    const ask = (session_id: string, hits: never[]) =>
      JSON.stringify(evaluate({ session_id, cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "jangan tanya pakai popup" }, store, none, hits).output);
    const strong = ask("s1", [hit("memory:-tmp-demo/hooks-warn-not-ask", "memory", "-tmp-demo", 0.7 + gap + 0.01), ...crowd(0.7)]);
    expect(strong).toContain("### memory:-tmp-demo/hooks-warn-not-ask");
    expect(strong).not.toContain("filler");
    // the nearest neighbour of any prompt is always something; a top hit that does not stand out is noise
    expect(ask("s2", [hit("memory:-tmp-demo/hooks-warn-not-ask", "memory", "-tmp-demo", 0.7 + gap - 0.01), ...crowd(0.7)])).toBe("{}");
    // a standout rule is listed by id
    expect(ask("s3", [hit("gotcha:B13", "rule", "global", 0.8 + gap), ...crowd(0.8)])).toContain("- gotcha:B13");
    // another repo's project rule belongs to that repo's sessions
    expect(ask("s4", [hit("project:other-repo:all-x.md", "project-rule", "other-repo", 0.8 + gap), ...crowd(0.8)])).toBe("{}");
    // batasd's ref (the repo-wide 10th neighbour) decides, not how many hits came back
    const withRef = (g: number, ref: number) => ({ ...(hit("gotcha:B13", "rule", "global", g) as object), ref }) as never;
    expect(ask("s5", [withRef(0.8, 0.8 - gap - 0.005)])).toContain("- gotcha:B13");
    expect(ask("s6", [withRef(0.8, 0.8 - gap + 0.005)])).toBe("{}");
  });

  test("a late semantic match renders through the same gate, once", () => {
    const gap = config.semantic.minGap;
    const state = { injected: [], hinted: [], lastPrompt: [], muted: [], touched: [], started: Date.now(), bashStart: 0, spent: 0, pending: [] };
    const hit = (g: number, ref: number) =>
      ({ id: "memory:-tmp-demo/hooks-warn-not-ask", kind: "memory", scope: "-tmp-demo", title: "x", source: "x", score: 0.03, cos: { g, e: 0.85 }, ref }) as never;
    const input = { session_id: "late1", cwd: "/tmp/demo", hook_event_name: "PreToolUse" };
    expect(lateSemantic(input, store, [hit(0.8, 0.8 - gap + 0.01)], state)).toBeUndefined();
    const late = lateSemantic(input, store, [hit(0.8, 0.8 - gap - 0.01)], state);
    expect(late?.text).toContain("### memory:-tmp-demo/hooks-warn-not-ask");
    expect(lateSemantic(input, store, [hit(0.8, 0.8 - gap - 0.01)], state)).toBeUndefined();
    // a new file's match carries the rule's full text and names the file, under its own gate
    const wgap = config.semantic.writeGap;
    const rule = (g: number, ref: number) =>
      ({ id: "gotcha:B13", kind: "rule", scope: "global", title: "x", source: "x", score: 0.03, cos: { g, e: 0.85 }, ref }) as never;
    expect(lateSemantic(input, store, [rule(0.8, 0.8 - wgap + 0.01)], state, "write", "backend/x.go")).toBeUndefined();
    const w = lateSemantic(input, store, [rule(0.8, 0.8 - wgap - 0.01)], state, "write", "backend/x.go");
    expect(w?.text).toContain("matches the file just written (backend/x.go)");
    expect(w?.text).toContain("### gotcha:B13");
    expect(w?.text).toContain("uuid5");
  });

  test("another project's memory reaches a repo that has none of its own, through its trigger words", () => {
    // the prompt path loads every project's memories: a sibling repo (Funnel's frontend) is governed by decisions
    // recorded under another project (its backend), and with only its own loaded nothing could ever fire there
    const s = new Store();
    s.refresh("rules", allMemorySources());
    const out = evaluate({ session_id: "x1", cwd: "/tmp/sibling-repo", hook_event_name: "UserPromptSubmit", prompt: "udah, commit terus push aja" }, s, new Triggers({}));
    expect(out.fired).toContain("memory:-tmp-demo/land-without-asking");
  });

  test("a rule prompt phrase fires on the user's own words, never on a quoted line or a side agent's note", () => {
    const rt = new Triggers({ "gotcha:D2": { prompt: ["captcha"] } });
    const ask = (prompt: string, session_id: string) =>
      JSON.stringify(evaluate({ session_id, hook_event_name: "UserPromptSubmit", prompt }, store, rt).output);
    expect(ask("loop creator kena captcha terus", "q1")).toContain("gotcha:D2");
    expect(ask("benerin ini\n> it got a captcha", "q2")).not.toContain("gotcha:D2");
    expect(ask("perketat\n\nHere is a note offered by a side agent:\ncaptcha everywhere", "q3")).not.toContain("gotcha:D2");
  });

  test("prompt-audit counts each phrase the way the hook matches it, and names rules no prompt reached", () => {
    const specs = {
      "gotcha:D2": { prompt: ["captcha", "affiliate"] },
      "lessons:X1": { prompt: ["never said"], cmd: ["\\bfoo\\b"] },
      _negative: { t_prompt: ["captcha"] },
    };
    const a = auditPrompts(["affiliate dashboard", "kena captcha", "affiliate report\n> captcha", "unrelated"], specs);
    const hits = Object.fromEntries(a.phrases.map((p) => [p.phrase, p.hits]));
    expect(hits).toEqual({ captcha: 1, affiliate: 2, "never said": 0 });
    expect(a.pulling).toBe(3);
    expect(a.perPrompt).toEqual({ 0: 1, 1: 3 });
    expect(a.silentIds).toEqual(["lessons:X1"]);
  });

  test("memory-audit calls a path stale only when git once tracked it, and names where a rename went", () => {
    const repo = mkdtempSync(join(tmpdir(), "batas-memaudit-"));
    const run = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { stderr: "ignore" });
    run("init", "-q");
    run("config", "user.email", "t@example.com");
    run("config", "user.name", "t");
    mkdirSync(join(repo, "docs/rules"), { recursive: true });
    writeFileSync(join(repo, "docs/rules/lessons.md"), "lessons body that is long enough to keep its identity\n");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/gone.ts"), "export const x = 1;\n");
    run("add", "-A");
    run("commit", "-qm", "a");
    run("mv", "docs/rules/lessons.md", "docs/rules/all-lessons.md");
    run("rm", "-q", "src/gone.ts");
    run("commit", "-qm", "b");
    const idx = gitIndex(repo);
    const home = join(repo, "home");
    mkdirSync(join(home, ".claude/skills"), { recursive: true });
    const text = "See `docs/rules/lessons.md`, src/gone.ts, `docs/rules/all-lessons.md`, backups/x.dump, ~/.claude/skills/old/SKILL.md, ~/apps-dev/deploy/a.yml, ~/.claude/skills/plannotator-";
    const paths = namedPaths(text);
    expect(paths).not.toContain("~/.claude/skills/plannotator-");
    const v = Object.fromEntries(paths.map((p) => [p, judgePath(p, repo, idx, home)]));
    expect(v["docs/rules/lessons.md"]).toEqual({ path: "docs/rules/lessons.md", verdict: "stale", movedTo: "docs/rules/all-lessons.md" });
    expect(v["src/gone.ts"]?.verdict).toBe("stale");
    expect(v["src/gone.ts"]?.movedTo).toBeUndefined();
    expect(v["docs/rules/all-lessons.md"]?.verdict).toBe("ok");
    expect(v["backups/x.dump"]?.verdict).toBe("unjudged");
    expect(v["~/.claude/skills/old/SKILL.md"]?.verdict).toBe("stale");
    expect(v["~/apps-dev/deploy/a.yml"]?.verdict).toBe("unjudged");
    expect(resolveRoot(repo.replace(/[^A-Za-z0-9]/g, "-"))).toBe(repo);
  });

  test("past the session budget a rule or memory is named once instead of injected", () => {
    const spend = (session_id: string, spent: number) => {
      mkdirSync(config.sessionsDir, { recursive: true });
      writeFileSync(join(config.sessionsDir, `${session_id}.json`), JSON.stringify({ spent }));
    };
    const real = Triggers.load();
    const stash = (session_id: string) =>
      JSON.stringify(evaluate({ session_id, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git stash push -- a.ts" } }, store, real).output);
    expect(stash("bud0")).toContain("ATOMICALLY");
    spend("bud1", config.inject.sessionBytes - 200);
    const capped = stash("bud1");
    expect(capped).toContain("lessons:C18");
    expect(capped).not.toContain("ATOMICALLY");
    expect(capped).toContain("injection budget");
    expect(stash("bud1")).toBe("{}");
    const none = new Triggers({});
    const ask = (session_id: string) =>
      JSON.stringify(evaluate({ session_id, cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "commit terus push ya" }, store, none).output);
    expect(ask("bud2")).toContain("### memory:-tmp-demo/land-without-asking");
    spend("bud3", config.inject.sessionBytes - 200);
    const listed = ask("bud3");
    expect(listed).toContain("- memory:-tmp-demo/land-without-asking");
    expect(listed).not.toContain("### memory:");
  });

  test("lesson-mine groups one mistake across sessions and separates uncovered traps from rules that fire", () => {
    const dir = mkdtempSync(join(tmpdir(), "batas-mine-"));
    const session = (name: string, cmd: string, error: string) => {
      const use = { type: "tool_use", id: `tu-${name}`, name: "Bash", input: { command: cmd } };
      const res = { type: "tool_result", tool_use_id: `tu-${name}`, is_error: true, content: error };
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(
        file,
        [
          JSON.stringify({ timestamp: "2026-10-01T00:00:00Z", message: { content: [use] } }),
          JSON.stringify({ timestamp: "2026-10-01T00:00:01Z", message: { content: [res] } }),
        ].join("\n"),
      );
      return file;
    };
    const files = [
      session("a", "cat a.txt; echo =====; cat b.txt", "Exit code 1\n(eval):1: ===== not found"),
      session("b", "ls; echo ===; ls src", "Exit code 1\n(eval):3: === not found"),
      session("c", "echo ====== && pwd", "(eval):12: ====== not found"),
      session("d", "pg_restore -d app /tmp/x.dump", "pg_restore: error: connection to server at /tmp/.s.PGSQL.5432 failed"),
      session("e", "pg_restore -d shop /var/y.dump", "pg_restore: error: connection to server at /tmp/.s.PGSQL.5433 failed"),
      session("f", "pg_restore -d crm z.dump", "pg_restore: error: connection to server at /tmp/.s.PGSQL.5401 failed"),
      session("g", "python3 -c 'x()'", "Traceback\nKeyError: 'name'"),
      session("h", "python3 -c 'y()'", "KeyError: 'id'"),
      session("i", "python3 -c 'z()'", "KeyError: 'k'"),
      session("j", "rm x", "<tool_use_error>The user doesn't want to proceed</tool_use_error>"),
    ];
    const errors = files.flatMap(errorsIn);
    expect(errors).toHaveLength(10);
    expect(errors[0]?.cmd).toBe("cat a.txt; echo =====; cat b.txt");
    expect(signature("KeyError: 'x'")).toBeUndefined();
    const found = mine(errors, new Triggers({ "gotcha:B1": { cmd: ["\\bpg_restore\\b"] }, "lessons:C1": { cmd: ["\\becho\\b|\\bls\\b|\\bcat\\b|\\bpython3\\b|\\bpg_restore\\b|\\brm\\b"] } }));
    expect(found.map((c) => [c.signature, c.sessions, c.coveredBy])).toEqual([
      ["(eval):<n>: == not found", 3, []],
      ["pg_restore: error: connection to server at <path> failed", 3, ["gotcha:B1"]],
    ]);
  });

  test("memory-share stores one copy and links every project to it, refusing drifted copies without a merge", () => {
    const root = mkdtempSync(join(tmpdir(), "batas-share-"));
    const projectsDir = join(root, "projects");
    const sharedDir = join(root, "memory", "shared");
    const backupDir = join(root, "backup");
    const put = (slug: string, name: string, text: string) => {
      mkdirSync(join(projectsDir, slug, "memory"), { recursive: true });
      writeFileSync(join(projectsDir, slug, "memory", name), text);
    };
    for (const slug of ["-a", "-b", "-c"]) put(slug, "same.md", "---\nname: same\n---\nshared fact\n");
    put("-a", "drift.md", "v1\n");
    put("-b", "drift.md", "v2\n");
    const opts = { projectsDir, sharedDir, backupDir };
    expect(shareMemory("same.md", opts).plan).toHaveLength(4);
    expect(copiesOf("same.md", projectsDir).every((c) => !c.shared)).toBe(true);
    expect(shareMemory("same.md", { ...opts, apply: true }).error).toBeUndefined();
    const linked = copiesOf("same.md", projectsDir);
    expect(linked.map((c) => [c.shared, c.text])).toEqual([[true, "---\nname: same\n---\nshared fact\n"], [true, "---\nname: same\n---\nshared fact\n"], [true, "---\nname: same\n---\nshared fact\n"]]);
    writeFileSync(join(projectsDir, "-b", "memory", "same.md"), "corrected once\n");
    expect(readFileSync(join(projectsDir, "-c", "memory", "same.md"), "utf8")).toBe("corrected once\n");
    expect(existsSync(join(backupDir, "-a", "same.md"))).toBe(true);
    expect(shareMemory("drift.md", { ...opts, apply: true }).error).toContain("2 different versions");
    expect(copiesOf("drift.md", projectsDir).some((c) => c.shared)).toBe(false);
    writeFileSync(join(root, "merged.md"), "v1+v2\n");
    expect(shareMemory("drift.md", { ...opts, apply: true, from: join(root, "merged.md") }).error).toBeUndefined();
    expect(copiesOf("drift.md", projectsDir).map((c) => c.text)).toEqual(["v1+v2\n", "v1+v2\n"]);
  });

  test("the corpus carries a repo's docs/lessons and docs/qa/context.md", () => {
    const ids = store.entries("context").map((e) => e.id);
    expect(ids.some((id) => id.startsWith("project:demo-app:lessons/backend.md#tender-lebih-dari-bon-edc"))).toBe(true);
    expect(ids.some((id) => id.startsWith("project:demo-app:qa/context.md#"))).toBe(true);
  });

  test("lessons-route puts each lesson on the file that defines its symbol, and only there", () => {
    const repo = mkdtempSync(join(tmpdir(), "batas-route-"));
    const put = (f: string, text: string) => {
      mkdirSync(join(repo, f, ".."), { recursive: true });
      writeFileSync(join(repo, f), text);
    };
    put("backend/order_service.go", "package svc\n\ntype OrderService struct{}\n\nfunc (s *OrderService) SettleOrder() {}\n");
    put("backend/settlement.go", "package svc\n\ntype Settlement struct {\n\tNetRevenue int\n}\n");
    put("backend/caller.go", "package svc\n\nfunc run(s *OrderService) { s.SettleOrder() }\n");
    // a printer handler that defines its own Targets method must not receive the PnLService lesson
    put("backend/printers.go", "package svc\n\nfunc (h *PrinterHandler) Targets() {}\n");
    for (const f of ["a.ts", "b.ts", "c.ts"]) put(`frontend/${f}`, "export const loaded = true\n");
    // NetRevenue is a field of three other structs too, so only its owner type can point at the right file.
    for (const n of ["x", "y", "z"]) put(`backend/report_${n}.go`, `package svc\n\ntype Report${n} struct {\n\tNetRevenue int\n}\n`);
    put(
      "docs/lessons/backend.md",
      [
        "# Backend",
        "## Tender settled twice",
        "Simbol: `OrderService.SettleOrder`",
        "The overflow was settled twice.",
        "## Net revenue excludes the fee",
        "Simbol: `Settlement.NetRevenue`",
        "Fee is not revenue.",
        "## Generic flag",
        "Simbol: `loaded`",
        "Defined everywhere.",
        "## Billing targets",
        "Simbol: `PnLService` (`Targets`)",
        "Belongs to PnLService only.",
        "## No symbol at all",
        "Cross-cutting.",
        "",
      ].join("\n"),
    );
    const files = ["backend/order_service.go", "backend/settlement.go", "backend/caller.go", "frontend/a.ts", "frontend/b.ts", "frontend/c.ts", "backend/report_x.go", "backend/report_y.go", "backend/report_z.go", "backend/printers.go"];
    const { routes, unresolved } = routeLessons(repo, files);
    expect(routes.map((r) => [r.file, r.lessons.map((l) => l.title)])).toEqual([
      ["backend/order_service.go", ["Tender settled twice"]],
      ["backend/settlement.go", ["Net revenue excludes the fee"]],
    ]);
    expect(unresolved.map((l) => l.title)).toEqual(["Generic flag", "Billing targets", "No symbol at all"]);
    const rule = ruleFile(routes[0] as never);
    expect(rule.name).toBe("p-lessons-backend-order-service.md");
    expect(rule.content).toContain('paths:\n  - "backend/order_service.go"');
    expect(rule.content).toContain("The overflow was settled twice.");
    const out = join(repo, ".claude", "rules", "lessons");
    mkdirSync(out, { recursive: true });
    for (const r of routes) writeFileSync(join(out, ruleFile(r).name), ruleFile(r).content);
    expect(staleFiles(out, routes)).toEqual([]);
    writeFileSync(join(out, "p-lessons-gone.md"), "x");
    writeFileSync(join(out, rule.name), "edited by hand");
    expect(staleFiles(out, routes).sort()).toEqual(["p-lessons-backend-order-service.md", "p-lessons-gone.md"]);
  });

  test("a file opened or changed through Bash gets the lessons Claude Code does not load for that path", () => {
    const repo = mkdtempSync(join(tmpdir(), "batas-bashlessons-"));
    Bun.spawnSync(["git", "init", "-q", repo]);
    mkdirSync(join(repo, "backend"), { recursive: true });
    writeFileSync(join(repo, "backend", "order_service.go"), "package svc\n");
    writeFileSync(join(repo, "backend", "plain.go"), "package svc\n");
    mkdirSync(join(repo, ".claude", "rules", "lessons"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "rules", "lessons", "p-lessons-backend-order-service.md"),
      '---\nname: x\npaths:\n  - "backend/order_service.go"\n---\n\n## Tender settled twice\nThe overflow was settled twice.\n',
    );
    const t = new Triggers({});
    const bash = (session_id: string, command: string) =>
      JSON.stringify(evaluate({ session_id, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, t).output);
    expect(bash("bl1", "cat backend/order_service.go")).toContain("Tender settled twice");
    expect(bash("bl1", "head -40 backend/order_service.go")).toBe("{}");
    // Claude Code loads the path rule itself after `sed -n`; injecting it too would only duplicate it
    expect(bash("bl6", "sed -n '1,80p' backend/order_service.go")).toBe("{}");
    expect(bash("bl2", `python3 -c "print(open('backend/order_service.go').read())"`)).toContain("Tender settled twice");
    expect(bash("bl3", "cat backend/plain.go")).toBe("{}");
    expect(bash("bl4", "git commit -m 'touch backend/missing.go'")).not.toContain("Tender");
    // a script that rewrites the file without naming it in a way the command shows
    evaluate({ session_id: "bl5", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "python3 fix.py" } }, store, t);
    writeFileSync(join(repo, "backend", "order_service.go"), "package svc\n// changed\n");
    const after = JSON.stringify(
      evaluate({ session_id: "bl5", cwd: repo, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "python3 fix.py" } }, store, t).output,
    );
    expect(after).toContain("Tender settled twice");
  });

  test("routed lessons regenerate when a lesson changes, and a commit with stale ones is refused once", () => {
    const repo = mkdtempSync(join(tmpdir(), "batas-upkeep-"));
    const sh = (...a: string[]) => Bun.spawnSync(["git", "-C", repo, ...a], { stderr: "ignore" });
    sh("init", "-q");
    mkdirSync(join(repo, "backend"), { recursive: true });
    mkdirSync(join(repo, "docs", "lessons"), { recursive: true });
    writeFileSync(join(repo, "backend", "svc.go"), "package svc\n\nfunc SettleOrder() {}\n");
    const lesson = join(repo, "docs", "lessons", "backend.md");
    writeFileSync(lesson, "# B\n## Tender settled twice\nSimbol: `SettleOrder`\nOld wording.\n");
    sh("add", "-A");
    writeRoutes(repo, routeRepo(repo).routes);
    const rule = join(repo, ".claude", "rules", "lessons", "p-lessons-backend-svc.md");
    expect(readFileSync(rule, "utf8")).toContain("Old wording.");
    const t = new Triggers({});
    const call = (session_id: string, tool_name: string, tool_input: Record<string, string>) =>
      evaluate({ session_id, cwd: repo, hook_event_name: "PreToolUse", tool_name, tool_input }, store, t).output as {
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string };
      };
    // 1. a lesson edit reaches the generated file on the very next call
    writeFileSync(lesson, "# B\n## Tender settled twice\nSimbol: `SettleOrder`\nNew wording.\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(lesson, later, later);
    expect(call("up1", "Read", { file_path: join(repo, "backend", "svc.go") }).hookSpecificOutput?.additionalContext).toContain("regenerated");
    expect(readFileSync(rule, "utf8")).toContain("New wording.");
    // 2. a renamed symbol: the lesson now points nowhere, the commit is refused once with the files already rewritten
    writeFileSync(join(repo, "backend", "svc.go"), "package svc\n\nfunc SettleBill() {}\n");
    const first = call("up2", "Bash", { command: "git commit -m x" });
    expect(first.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(first.hookSpecificOutput?.permissionDecisionReason).toContain("git add -f .claude/rules/lessons/");
    expect(existsSync(rule)).toBe(false);
    expect(call("up2", "Bash", { command: "git commit -m x" }).hookSpecificOutput?.permissionDecision).toBeUndefined();
    // 3. a hand edit to a generated file is flagged
    expect(call("up3", "Edit", { file_path: rule, new_string: "x" }).hookSpecificOutput?.additionalContext).toContain("is generated from docs/lessons");
  });

  test("a trigger word alone recalls its memory here, and is listed from another project's cwd", () => {
    const none = new Triggers({});
    const here = evaluate({ session_id: "g1", cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "commit terus push ya" }, store, none)
      .output as { hookSpecificOutput?: { additionalContext: string } };
    expect(here.hookSpecificOutput?.additionalContext).toContain("### memory:-tmp-demo/land-without-asking");
    const there = evaluate({ session_id: "g2", cwd: "/tmp/other", hook_event_name: "UserPromptSubmit", prompt: "commit terus push ya" }, store, none)
      .output as { hookSpecificOutput?: { additionalContext: string } };
    expect(there.hookSpecificOutput?.additionalContext).toContain("- memory:-tmp-demo/land-without-asking");
    expect(there.hookSpecificOutput?.additionalContext).not.toContain("### memory:");
  });

  test("an unrelated prompt or another project's cwd recalls no memory", () => {
    const none = new Triggers({});
    expect(evaluate({ session_id: "m2", cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "deploy kubernetes cluster tonight" }, store, none).output).toEqual({});
    expect(evaluate({ session_id: "m3", cwd: "/tmp/other", hook_event_name: "UserPromptSubmit", prompt: "hooks warn popups" }, store, none).output).toEqual({});
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

  test("a command that only MENTIONS a pattern in a quoted argument does not fire; code args still do", () => {
    const qt = new Triggers({ "lessons:B13": { cmd: ["\\blsof\\s+-ti\\s*(tcp)?:\\d+"] } });
    const fires = (cmd: string) => qt.match({ cmd }).length > 0;
    expect(fires("lsof -ti tcp:3000")).toBe(true);
    expect(fires('just fire "lsof -ti tcp:3000"')).toBe(false);
    expect(fires("git commit -m 'never lsof -ti tcp:3000 again'")).toBe(false);
    expect(fires("cat > notes.sh <<'EOF'\nlsof -ti tcp:3000\nEOF")).toBe(false);
    expect(fires('bash -c "lsof -ti tcp:3000 | xargs kill"')).toBe(true);
    expect(fires('ssh srv "lsof -ti tcp:3000"')).toBe(true);
    expect(fires("python3 - <<'EOF'\nimport os; os.system('lsof -ti tcp:3000')\nEOF")).toBe(true);
  });

  test("a tool hint injects its text once per session; a harness task-notification never matches", () => {
    const ht = new Triggers({ "hint:record": { prompt: ["inget ya"], text: "call mcp__batas__record" } });
    const ask = (prompt: string, session_id: string) =>
      evaluate({ session_id, hook_event_name: "UserPromptSubmit", prompt }, store, ht);
    const first = ask("inget ya, gua nggak suka popup", "t1").output as { hookSpecificOutput?: { additionalContext: string } };
    expect(first.hookSpecificOutput?.additionalContext).toBe("batas: call mcp__batas__record");
    expect(ask("inget ya yang lain juga", "t1").output).toEqual({});
    expect(ask("<task-notification> inget ya </task-notification>", "t2").output).toEqual({});
  });

  test("origin shows on an injected rule and in a memory's title", () => {
    const ot = new Triggers({ "gotcha:B1": { cmd: ["\\bpg_restore\\b"], origin: "user-written" } });
    const r = evaluate(
      { session_id: "o1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore -d x a.dump" } },
      store,
      ot,
    ).output as { hookSpecificOutput: { additionalContext: string } };
    expect(r.hookSpecificOutput.additionalContext).toContain("### gotcha:B1 · user-written — fired by");
    const w = recordMemory({ projectDir: demo, type: "project", name: "origin-probe", title: "t", description: "d", body: "b", origin: "agent-initiated" });
    const s2 = new Store();
    s2.refresh("all");
    expect(s2.get(`memory:${w.file.split("/").at(-3)}/origin-probe`)?.title).toStartWith("[project · agent-initiated]");
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
    const a = { projectDir: demo, type: "feedback" as const, name: "No Popups", title: "No popups", description: "warn, never ask", body: "Rule.\n\n**Why:** x\n**How to apply:** y", origin: "user-requested" as const };
    const w = recordMemory(a);
    expect(readFileSync(w.file, "utf8")).toContain("type: feedback\n  origin: user-requested\n  recorded: ");
    expect(() => recordMemory({ ...a, name: "bad-origin", origin: "somebody" as never })).toThrow(/origin must be one of/);
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
  test("with batasd down, recall says it is warming up and get still answers", async () => {
    const client = new Client({ name: "batas-test-cold", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [join(import.meta.dir, "..", "src", "mcp.ts")],
        env: { ...(process.env as Record<string, string>) },
        cwd: demo,
      }),
    );
    const recall = (await client.callTool({ name: "recall", arguments: { query: "pg_dump restore empty database", limit: 3 } })) as {
      content: { text: string }[];
      isError?: boolean;
    };
    expect(recall.isError).toBeFalsy();
    expect(recall.content[0]?.text).toContain("semantic search is starting");
    const get = (await client.callTool({ name: "get", arguments: { id: "gotcha:B1" } })) as { content: { text: string }[] };
    expect(get.content[0]?.text).toContain("pg_dump");
    await client.close();
  }, 30000);

  test("lists the eight tools and answers recall and get over stdio", async () => {
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
    expect(tools).toEqual(["check", "get", "log_changelog", "log_progress", "mute", "recall", "record", "status"]);
    const get = (await client.callTool({ name: "get", arguments: { id: "lessons:C18" } })) as { content: { text: string }[] };
    expect(get.content[0]?.text).toContain("git stash push");
    const draft = (await client.callTool({
      name: "record",
      arguments: { type: "lesson", name: "x", title: "stash pop takes another session's work", description: "d", body: "git stash pop after a failed push", origin: "agent-initiated" },
    })) as { content: { text: string }[] };
    expect(draft.content[0]?.text).toContain("Draft only");
    expect(draft.content[0]?.text).toContain('origin = "agent-initiated"');
    await client.close();
  }, 30000);

  test("state stays under the test root", () => {
    expect(config.stateDir.startsWith(root)).toBe(true);
    expect(existsSync(join(config.claudeHome, "rules"))).toBe(true);
  });
});

describe("feedback and log", () => {
  test("'batas nyasar' mutes what the last PROMPT injected, never a rule the agent's own tool call fired", () => {
    const t = new Triggers({ "gotcha:B1": { cmd: ["\\bpg_restore\\b"] } });
    const prompt = (text: string) =>
      evaluate({ session_id: "mu1", cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: text }, store, t).output as {
        hookSpecificOutput?: { additionalContext: string };
      };
    const tool = () =>
      evaluate({ session_id: "mu1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore -d a x.dump" } }, store, t);
    expect(prompt("commit terus push ya").hookSpecificOutput?.additionalContext).toContain("land-without-asking");
    expect(tool().fired).toEqual(["gotcha:B1"]);
    const muted = prompt("batas nyasar itu");
    expect(muted.hookSpecificOutput?.additionalContext).toContain("memory:-tmp-demo/land-without-asking");
    expect(muted.hookSpecificOutput?.additionalContext).not.toContain("gotcha:B1");
    const report = readFeedback().find((f) => f.session === "mu1");
    expect(report?.ids).toEqual(["memory:-tmp-demo/land-without-asking"]);
  });

  test("'batas nyasar' with no prompt injection, or only inside a quoted note, does nothing", () => {
    const t = new Triggers({ "gotcha:B1": { cmd: ["\\bpg_restore\\b"] } });
    evaluate({ session_id: "mu2", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore x" } }, store, t);
    expect(evaluate({ session_id: "mu2", hook_event_name: "UserPromptSubmit", prompt: "batas nyasar" }, store, t).output).toEqual({});
    evaluate({ session_id: "mu3", cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "commit terus push ya" }, store, t);
    const quoted = "ok\n\nHere is a note offered by a side agent:\n> kalau nyasar ketik batas nyasar";
    expect(evaluate({ session_id: "mu3", cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: quoted }, store, t).output).toEqual({});
    expect(readFeedback().some((f) => f.session === "mu2" || f.session === "mu3")).toBe(false);
  });

  test("a permanent mute silences an id in every session until unmuted", () => {
    const t = new Triggers({ "gotcha:B1": { cmd: ["\\bpg_restore\\b"] } });
    const run = (session_id: string) =>
      evaluate({ session_id, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "pg_restore x" } }, store, t).fired;
    setMuted("gotcha:B1", "probe");
    expect(mutedIds()["gotcha:B1"]).toBe("probe");
    expect(run("pm1")).toEqual([]);
    setMuted("gotcha:B1", null);
    expect(run("pm2")).toEqual(["gotcha:B1"]);
  });

  test("the hook log rotates by size and is read back across files, errors included", () => {
    const saved = config.log.maxBytes;
    config.log.maxBytes = 300;
    for (let i = 0; i < 12; i++) appendHookLog({ ts: new Date().toISOString(), fired: [], ms: i, ...(i === 11 ? { error: "boom" } : {}) });
    config.log.maxBytes = saved;
    expect(existsSync(join(config.stateDir, "hook.log.1.jsonl"))).toBe(true);
    const rows = readHookLog(Date.now() - 60_000);
    expect(rows.some((r) => r.error === "boom")).toBe(true);
    expect(rows.length).toBeGreaterThan(3);
  });
});

describe("live-session collision guard", () => {
  const repo = mkdtempSync(join(tmpdir(), "batas-live-"));
  mkdirSync(join(repo, ".git"));
  const sub = join(repo, "apps", "web");
  mkdirSync(sub, { recursive: true });
  const t = new Triggers({});
  const git = (command: string, session_id: string, cwd = sub) =>
    evaluate({ session_id, cwd, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, t).output as {
      hookSpecificOutput?: { additionalContext: string };
    };
  const seen = (session: string, agoMs: number) =>
    appendHookLog({ ts: new Date(Date.now() - agoMs).toISOString(), session, repo, fired: [], ms: 1 });

  test("warns once when another session touched the same checkout in the window, from any subdirectory", () => {
    seen("other-a", 60_000);
    const first = git("git add -A && git commit -m x", "me-1");
    expect(first.hookSpecificOutput?.additionalContext).toContain("1 other Claude session(s) active in this checkout");
    expect(first.hookSpecificOutput?.additionalContext).toContain("never `git add -A`");
    expect(git("git commit -m second", "me-1")).toEqual({});
  });

  test("stays silent for a quoted mention, a read-only git command, a stale session, or only your own session", () => {
    seen("other-b", 60_000);
    expect(git('echo "git commit later"', "me-2")).toEqual({});
    expect(git("git log -3", "me-2")).toEqual({});
    const lonely = mkdtempSync(join(tmpdir(), "batas-lonely-"));
    mkdirSync(join(lonely, ".git"));
    appendHookLog({ ts: new Date(Date.now() - 3_600_000).toISOString(), session: "old", repo: lonely, fired: [], ms: 1 });
    appendHookLog({ ts: new Date().toISOString(), session: "me-3", repo: lonely, fired: [], ms: 1 });
    expect(git("git commit -m y", "me-3", lonely)).toEqual({});
  });
});

describe("collision guard blocks", () => {
  const run2 = (cwd: string, session_id: string, command: string, transcript_path?: string) =>
    evaluate({ session_id, cwd, transcript_path, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, new Triggers({})).output as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
  const repo = mkdtempSync(join(tmpdir(), "batas-deny-"));
  Bun.spawnSync(["git", "init", "-q", repo]);
  writeFileSync(join(repo, "mine.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "theirs.ts"), "export const b = 2;\n");
  // An IDLE other session: it wrote theirs.ts and has logged nothing since, so the live window cannot see it.
  mkdirSync(config.sessionsDir, { recursive: true });
  writeFileSync(join(config.sessionsDir, "idle-other.json"), JSON.stringify({ touched: [join(repo, "theirs.ts")] }));
  const t = new Triggers({});
  evaluate({ session_id: "me-d", cwd: repo, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(repo, "mine.ts"), new_string: "x" } }, store, t);
  const run = (command: string, session_id = "me-d") =>
    evaluate({ session_id, cwd: repo, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, t).output as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };
  const denied = (command: string, session_id?: string) => run(command, session_id).hookSpecificOutput?.permissionDecision === "deny";

  test("a sweeping command is denied while an idle session's file is dirty, and the denial names it", () => {
    const out = run("git add -A");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("theirs.ts");
    expect(out.hookSpecificOutput?.permissionDecisionReason).not.toContain("mine.ts");
    for (const c of ["git add .", "git commit -am wip", "git stash", "git checkout -- .", "git reset --hard", "git clean -fd"]) {
      expect(denied(c)).toBe(true);
    }
  });

  test("every way through works: explicit paths, the ack prefix, a mention in quotes or a heredoc", () => {
    for (const c of [
      "git add mine.ts",
      "git stash -- mine.ts",
      "git stash pop",
      "BATAS_ACK_FOREIGN=1 git add -A",
      'echo "never git add -A here"',
      "python3 - <<'EOF'\nprint('git add -A')\nEOF",
    ]) {
      expect(denied(c)).toBe(false);
    }
  });

  test("push is denied only while another session is live, and the ack prefix lets it through", () => {
    expect(denied("git push origin main", "me-p")).toBe(false);
    appendHookLog({ ts: new Date().toISOString(), session: "live-other", repo, fired: [], ms: 1 });
    const out = run("git push origin main", "me-p");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("git log @{u}..HEAD");
    expect(denied("BATAS_ACK_LIVE=1 git push origin main", "me-p")).toBe(false);
  });

  test("git global options before the subcommand do not hide it from the guard", () => {
    appendHookLog({ ts: new Date().toISOString(), session: "live-other", repo, fired: [], ms: 1 });
    for (const c of ["git -C . push origin main", "git -c user.email=a@b.c push", "git --no-pager -c x=y add -A"]) {
      expect(denied(c, "me-g")).toBe(true);
    }
    expect(logFlags({ tool_name: "Bash", tool_input: { command: "git -c user.name=t commit -qm x" } })).toEqual({ committed: true });
  });

  test("one checkout reached through a symlinked path is one repo", () => {
    const real = mkdtempSync(join(tmpdir(), "batas-real-"));
    Bun.spawnSync(["git", "init", "-q", real]);
    const link = `${real}-link`;
    symlinkSync(real, link);
    appendHookLog({ ts: new Date().toISOString(), session: "via-link", repo: realpathSync(link), fired: [], ms: 1 });
    expect([...liveSessions(link, "me-s", Date.now() - 60_000).keys()]).toEqual(["via-link"]);
    expect([...liveSessions(real, "me-s", Date.now() - 60_000).keys()]).toEqual(["via-link"]);
  });

  test("a claude -p session blocks a push only once it has committed in that repo", () => {
    const own = mkdtempSync(join(tmpdir(), "batas-headless-"));
    Bun.spawnSync(["git", "init", "-q", own]);
    const push = () => run2(own, "me-h", "git push origin main").hookSpecificOutput?.permissionDecision;
    appendHookLog({ ts: new Date().toISOString(), session: "probe-p", repo: own, fired: [], ms: 1, headless: true });
    expect(push()).toBeUndefined();
    appendHookLog({ ts: new Date().toISOString(), session: "job-p", repo: own, fired: [], ms: 1, headless: true });
    appendHookLog({ ts: new Date().toISOString(), session: "job-p", repo: own, fired: [], ms: 1, headless: true, committed: true });
    expect(push()).toBe("deny");
    const flags = (command: string) => logFlags({ tool_name: "Bash", tool_input: { command } }, "sdk-cli");
    expect(flags("git add a.ts && git commit -F - <<'EOF'\nx\nEOF")).toEqual({ headless: true, committed: true });
    expect(flags("echo 'never git commit here'")).toEqual({ headless: true });
    expect(logFlags({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, "cli")).toEqual({ committed: true });
  });

  test("files a Bash command or script changed are attributed to the session that ran it", () => {
    const r = mkdtempSync(join(tmpdir(), "batas-script-"));
    Bun.spawnSync(["git", "init", "-q", r]);
    const bash = (session_id: string, command: string, write?: string) => {
      evaluate({ session_id, cwd: r, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, t);
      if (write) writeFileSync(join(r, write), `${session_id}\n`);
      evaluate({ session_id, cwd: r, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } }, store, t);
    };
    bash("me-s", "ls");
    bash("script-other", "python3 codemod.py", "theirs-by-script.ts");
    bash("me-s", "python3 mine.py", "mine-by-script.ts");
    const out = run2(r, "me-s", "git add -A");
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("theirs-by-script.ts  (written by another session)");
    expect(out.hookSpecificOutput?.permissionDecisionReason).not.toContain("mine-by-script.ts");
  });

  test("session start is the transcript's birth: older dirt is foreign, the session's own earlier work is not", () => {
    const r = mkdtempSync(join(tmpdir(), "batas-pre-"));
    Bun.spawnSync(["git", "init", "-q", r]);
    const hourAgo = new Date(Date.now() - 3_600_000);
    writeFileSync(join(r, "leftover.ts"), "old\n");
    utimesSync(join(r, "leftover.ts"), hourAgo, hourAgo);
    const fresh = join(mkdtempSync(join(tmpdir(), "batas-tr-")), "fresh.jsonl");
    writeFileSync(fresh, "");
    const out = run2(r, "fresh-session", "git add -A", fresh);
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("leftover.ts  (dirty before this session started)");
    expect(run2(r, "no-transcript", "git add -A").hookSpecificOutput).toBeUndefined();
  });

  test("a session open before tracking existed is not blocked by its own untracked earlier work", () => {
    const r = mkdtempSync(join(tmpdir(), "batas-open-"));
    Bun.spawnSync(["git", "init", "-q", r]);
    // The session (its transcript) exists first; then it edits a file in a way nothing attributed — the state of
    // every session already open when the rule shipped. Its first guarded command must pass.
    const transcript = join(mkdtempSync(join(tmpdir(), "batas-tr-")), "open.jsonl");
    writeFileSync(transcript, "");
    Bun.sleepSync(20);
    writeFileSync(join(r, "own-earlier-work.ts"), "mine\n");
    expect(statSync(transcript).birthtimeMs).toBeLessThan(statSync(join(r, "own-earlier-work.ts")).mtimeMs);
    expect(run2(r, "open-session", "git add -A", transcript).hookSpecificOutput).toBeUndefined();
  });

  test("an ack that bypassed a real block is recorded", () => {
    const r = mkdtempSync(join(tmpdir(), "batas-ack-"));
    Bun.spawnSync(["git", "init", "-q", r]);
    writeFileSync(join(r, "x.ts"), "x\n");
    mkdirSync(config.sessionsDir, { recursive: true });
    writeFileSync(join(config.sessionsDir, "ack-other.json"), JSON.stringify({ touched: [join(r, "x.ts")] }));
    expect(run2(r, "acker", "BATAS_ACK_FOREIGN=1 git add -A").hookSpecificOutput).toBeUndefined();
    expect(readAcks(0).some((a) => a.session === "acker" && a.kind === "guard:ack-foreign")).toBe(true);
    run2(r, "acker2", "BATAS_ACK_FOREIGN=1 git add x.ts");
    expect(readAcks(0).some((a) => a.session === "acker2")).toBe(false);
  });

  test("the repo is the one the command cds into, not the session's cwd", () => {
    const busy = mkdtempSync(join(tmpdir(), "batas-busy-"));
    Bun.spawnSync(["git", "init", "-q", busy]);
    const quiet = mkdtempSync(join(tmpdir(), "batas-quiet-"));
    Bun.spawnSync(["git", "init", "-q", quiet]);
    appendHookLog({ ts: new Date().toISOString(), session: "busy-other", repo: busy, fired: [], ms: 1 });
    const push = (command: string) =>
      (evaluate({ session_id: "me-cd", cwd: busy, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }, store, t).output as {
        hookSpecificOutput?: { permissionDecision?: string };
      }).hookSpecificOutput?.permissionDecision;
    expect(push(`cd ${quiet} && git push origin main`)).toBeUndefined();
    expect(push(`git -C ${quiet} push origin main`)).toBeUndefined();
    expect(push(`cd ${quiet} && git commit -F - <<'EOF'\nmsg naming the last cd X / git -C X rule\nEOF\ngit push origin main`)).toBeUndefined();
    expect(push("git push origin main")).toBe("deny");
  });

  test("with no other session's dirty file, sweeping is allowed", () => {
    const clean = mkdtempSync(join(tmpdir(), "batas-clean-"));
    Bun.spawnSync(["git", "init", "-q", clean]);
    evaluate({ session_id: "solo", cwd: clean, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, store, t);
    writeFileSync(join(clean, "a.ts"), "x\n");
    const out = evaluate({ session_id: "solo", cwd: clean, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git add -A" } }, store, t)
      .output as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });
});

describe("Step 5b at edit time", () => {
  const t = new Triggers({});
  const memDirP = join(config.claudeHome, "projects", "-tmp-step", "memory");
  mkdirSync(memDirP, { recursive: true });
  const ctx = (session_id: string, tool_name: string, tool_input: Record<string, unknown>) =>
    (evaluate({ session_id, hook_event_name: "PreToolUse", tool_name, tool_input }, store, t).output as {
      hookSpecificOutput?: { additionalContext: string };
    }).hookSpecificOutput?.additionalContext ?? "";

  test("writing a memory without triggers warns; with triggers, or editing one that has them, does not", () => {
    const f = join(memDirP, "new-fact.md");
    expect(ctx("s5", "Write", { file_path: f, content: "---\nname: new-fact\ndescription: d\n---\n\nbody\n" })).toContain("has no `triggers:` line");
    expect(ctx("s6", "Write", { file_path: f, content: '---\nname: new-fact\ntriggers: "a, b"\n---\n\nbody\n' })).toBe("");
    const had = join(memDirP, "has-triggers.md");
    writeFileSync(had, '---\nname: x\nmetadata:\n  triggers: "a, b"\n---\n\nold\n');
    expect(ctx("s7", "Edit", { file_path: had, old_string: "old", new_string: "new" })).toBe("");
    expect(ctx("s8", "Write", { file_path: join(memDirP, "MEMORY.md"), content: "# index\n" })).toBe("");
  });

  test("editing a family rule file shows the Step 5b checklist once per session", () => {
    const f = join(config.claudeHome, "rules", "lessons.md");
    expect(ctx("s9", "Edit", { file_path: f, old_string: "a", new_string: "b" })).toContain("triggers.toml");
    expect(ctx("s9", "Edit", { file_path: f, old_string: "c", new_string: "d" })).not.toContain("Step 5b");
  });
});

describe("latency budget", () => {
  // The hook runs on every tool call of every session; a regression here is paid thousands of times a day, and
  // nothing else would notice it. Measures the in-process path main() runs: refresh, then evaluate.
  const p95 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
  const t = Triggers.load();

  test(`a tool call stays under ${config.latencyBudgetMs.tool}ms p95`, () => {
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const s = new Store();
      s.refresh("rules");
      evaluate({ session_id: `lat-t${i}`, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m x && git push origin main" } }, s, t);
      ms.push(performance.now() - started);
    }
    expect(p95(ms)).toBeLessThan(config.latencyBudgetMs.tool);
  });

  test(`a prompt with memory recall stays under ${config.latencyBudgetMs.prompt}ms p95`, () => {
    const ms: number[] = [];
    for (let i = 0; i < 40; i++) {
      const started = performance.now();
      const s = new Store();
      s.refresh("rules", allMemorySources());
      evaluate({ session_id: `lat-p${i}`, cwd: "/tmp/demo", hook_event_name: "UserPromptSubmit", prompt: "commit terus push, hooks warn popups" }, s, t);
      ms.push(performance.now() - started);
    }
    expect(p95(ms)).toBeLessThan(config.latencyBudgetMs.prompt);
  });
});

