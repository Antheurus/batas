import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { Store } from "./store.ts";

type HookCmd = { type: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCmd[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const repo = resolve(import.meta.dir, "..");
const hookCmd = `bun "${join(repo, "src", "hook.ts")}"`;
const mcpEntry = join(repo, "src", "mcp.ts");

const WANT: { event: string; matcher?: string }[] = [
  { event: "PreToolUse", matcher: "Bash|Read|Edit|Write|MultiEdit|NotebookEdit" },
  // Attributes files a Bash command changed (scripts, redirects, sed) to the session, for the collision guard.
  { event: "PostToolUse", matcher: "Bash" },
  { event: "UserPromptSubmit" },
  { event: "Stop" },
];

function installHooks(): string[] {
  const file = join(config.claudeHome, "settings.json");
  const raw = readFileSync(file, "utf8");
  const settings = JSON.parse(raw) as Settings;
  settings.hooks ??= {};
  const added: string[] = [];
  for (const w of WANT) {
    const groups = (settings.hooks[w.event] ??= []);
    const present = groups.some((g) => g.hooks.some((h) => h.command === hookCmd));
    if (present) continue;
    const group: HookGroup = { hooks: [{ type: "command", command: hookCmd, timeout: 5 }] };
    if (w.matcher) group.matcher = w.matcher;
    groups.push(group);
    added.push(w.event);
  }
  if (added.length) {
    copyFileSync(file, `${file}.bak-batas-${Date.now()}`);
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  }
  return added;
}

function installMcp(): string {
  const probe = Bun.spawnSync(["claude", "mcp", "get", "batas"], { stdout: "pipe", stderr: "pipe" });
  if (probe.exitCode === 0) return "already registered";
  const add = Bun.spawnSync(["claude", "mcp", "add", "--scope", "user", "batas", "--", "bun", mcpEntry], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (add.exitCode !== 0) throw new Error(`claude mcp add failed: ${add.stderr.toString()}`);
  return "registered (user scope)";
}

function installSkill(): string {
  const link = join(config.skillsDir, "batas");
  const target = join(repo, "skill");
  try {
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return "already linked";
    return `left alone: ${link} exists and is not our symlink`;
  } catch {
    symlinkSync(target, link);
    return `linked ${link} -> ${target}`;
  }
}

if (!existsSync(config.triggersFile)) {
  mkdirSync(dirname(config.triggersFile), { recursive: true });
  writeFileSync(config.triggersFile, "# batas triggers — see the batas repo README for the format\n");
}
const added = installHooks();
console.log(`hooks: ${added.length ? `added ${added.join(", ")}` : "already present"}`);
console.log(`mcp: ${installMcp()}`);
console.log(`skill: ${installSkill()}`);
const t = performance.now();
const store = new Store();
const r = store.refresh("all");
console.log(`index: ${r.changed} files indexed in ${Math.round(performance.now() - t)}ms -> ${config.indexFile}`);
console.log(`entries: ${store.stats().map((s) => `${s.kind} ${s.n}`).join(", ")}`);
store.close();
