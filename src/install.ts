import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { Store } from "./store.ts";

type HookCmd = { type: "command"; command: string; timeout?: number };
type HookGroup = { matcher?: string; hooks: HookCmd[] };
type Settings = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

const repo = resolve(import.meta.dir, "..");
const hookPath = join(repo, "src", "hook.ts");
const hookCmd = `bun "${hookPath}"`;

// Any spelling of this repo's hook command: quoted or not, through ~ or the absolute path. An exact-string match missed
// an older `bun ~/Documents/…/hook.ts` Stop entry and registered a second one (2026-10-13), so every Stop ran twice.
function isOurHook(command: string): boolean {
  const m = command.trim().match(/^bun\s+"?([^"]+?)"?$/);
  const path = m?.[1];
  return !!path && resolve(path.replace(/^~(?=\/)/, homedir())) === hookPath;
}
const mcpEntry = join(repo, "src", "mcp.ts");

const WANT: { event: string; matcher?: string }[] = [
  // Agent|Task: a subagent's brief is matched like a prompt and gets the memories appended (see briefSubagent)
  { event: "PreToolUse", matcher: "Bash|Read|Edit|Write|MultiEdit|NotebookEdit|Agent|Task" },
  // Attributes files a Bash command changed (scripts, redirects, sed) to the session, for the collision guard.
  // mcp__batas__record: the correction check reads which session recorded (src/hook.ts captureCorrection)
  { event: "PostToolUse", matcher: "Bash|mcp__batas__record" },
  { event: "UserPromptSubmit" },
  { event: "Stop" },
];

export function installHooks(): string[] {
  const file = join(config.claudeHome, "settings.json");
  const raw = readFileSync(file, "utf8");
  const settings = JSON.parse(raw) as Settings;
  settings.hooks ??= {};
  const added: string[] = [];
  for (const w of WANT) {
    const groups = (settings.hooks[w.event] ??= []);
    const [present, ...extra] = groups.filter((g) => g.hooks.some((h) => isOurHook(h.command)));
    for (const g of extra) {
      g.hooks = g.hooks.filter((h) => !isOurHook(h.command));
      added.push(`${w.event} (duplicate removed)`);
    }
    if (extra.length) settings.hooks[w.event] = groups.filter((g) => g.hooks.length);
    if (present) {
      for (const h of present.hooks) {
        if (isOurHook(h.command) && h.command !== hookCmd) {
          h.command = hookCmd;
          added.push(`${w.event} (path normalised)`);
        }
      }
      // an older install registered a narrower matcher; widen it in place rather than adding a second group
      if (w.matcher && present.matcher !== w.matcher) {
        present.matcher = w.matcher;
        added.push(`${w.event} (matcher widened)`);
      }
      continue;
    }
    const group: HookGroup = { hooks: [{ type: "command", command: hookCmd, timeout: 5 }] };
    if (w.matcher) group.matcher = w.matcher;
    settings.hooks[w.event]?.push(group);
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

// batasd starts at login and exits after 180 idle minutes (BATASD_IDLE_MIN in batasd.py; the user's choice 2026-10-09,
// reversing 2026-10-08's always-on); the next hook call starts it again. launchd restarts it only after a crash: a second copy exits 0 when another holds
// the lock, and KeepAlive=true would respawn that copy every 10 s forever.
const AGENT = "dev.batas.batasd";
function installAgent(): string {
  const uv = Bun.which("uv");
  const bun = Bun.which("bun");
  if (!uv || !bun) return "skipped: uv or bun not on PATH";
  const plist = join(homedir(), "Library", "LaunchAgents", `${AGENT}.plist`);
  const log = join(config.stateDir, "batasd.out");
  const path = [...new Set([dirname(uv), dirname(bun), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT}</string>
  <key>ProgramArguments</key>
  <array><string>${uv}</string><string>run</string><string>--script</string><string>${join(repo, "batasd", "batasd.py")}</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${path}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
</dict>
</plist>
`;
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(config.stateDir, { recursive: true });
  const same = existsSync(plist) && readFileSync(plist, "utf8") === xml;
  const domain = `gui/${process.getuid?.() ?? 501}`;
  const loaded = Bun.spawnSync(["launchctl", "print", `${domain}/${AGENT}`], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  if (same && loaded) return "already installed and loaded";
  if (loaded) Bun.spawnSync(["launchctl", "bootout", `${domain}/${AGENT}`]);
  writeFileSync(plist, xml);
  const boot = Bun.spawnSync(["launchctl", "bootstrap", domain, plist], { stdout: "pipe", stderr: "pipe" });
  if (boot.exitCode !== 0) throw new Error(`launchctl bootstrap failed: ${boot.stderr.toString()}`);
  return `installed ${plist} and loaded it`;
}

if (!existsSync(config.triggersFile)) {
  mkdirSync(dirname(config.triggersFile), { recursive: true });
  writeFileSync(config.triggersFile, "# batas triggers — see the batas repo README for the format\n");
}
if (import.meta.main) {
  const added = installHooks();
  console.log(`hooks: ${added.length ? `added ${added.join(", ")}` : "already present"}`);
  console.log(`mcp: ${installMcp()}`);
  console.log(`skill: ${installSkill()}`);
  console.log(`batasd agent: ${installAgent()}`);
  const t = performance.now();
  const store = new Store();
  const r = store.refresh("all");
  console.log(`corpus: ${r.changed} files parsed in ${Math.round(performance.now() - t)}ms`);
  console.log(`entries: ${store.stats().map((s) => `${s.kind} ${s.n}`).join(", ")}`);
  console.log("batasd: the first full embedding pass runs in the background after it starts (`just semantic-status`)");
}
