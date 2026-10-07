// The learning loop in ~/.claude/CLAUDE.md depends on an agent remembering to write a lesson. This finds the ones
// nobody wrote: an error signature that failed tool calls in several separate sessions. Each group is checked against
// the rule triggers on its own commands, so the report separates "no rule exists" (a lesson to draft) from "a rule
// fires and the mistake repeats anyway" (a rule whose wording or tier is not working). Drafts only: batas never writes
// a rule, it goes through rules-writer.
import { config } from "../src/config.ts";
import { Triggers } from "../src/triggers.ts";
import { errorsIn, type ToolError, transcriptFiles } from "./transcripts.ts";

// The harness's own refusals and a user saying no are not mistakes to learn from.
const NOT_A_MISTAKE =
  /^<tool_use_error>|user doesn't want|user rejected|YOUR PLAN WAS NOT APPROVED|hook (error|blocking)|PreToolUse:|denied this tool|Permission to use/i;
// A bare exception name or a traceback frame is an agent's own script being debugged, not a repeated trap.
const GENERIC = /^(\w*(Error|Exception)(: <\w+>| <\w+>)?|raise .*|response = self\.parent\.error\(|triggerUncaughtException\(|<s>:? ?\{?)$/;
const ERRORISH = /error|fatal|denied|not found|cannot|can't|failed|exception|refused|no such|does not exist|invalid|unexpected/i;

// One line that names the failure, with every path, number, hash and quoted value blanked so the same mistake made on
// different files groups together. "Exit code N" alone says nothing; the first error-looking line after it does.
export function signature(error: string): string | undefined {
  if (NOT_A_MISTAKE.test(error.slice(0, 300))) return undefined;
  const lines = error.split("\n").map((l) => l.trim()).filter((l) => l && !/^Exit code \d+$/.test(l));
  const line = lines.find((l) => ERRORISH.test(l)) ?? lines[0];
  if (!line) return undefined;
  const sig = line
    .replace(/(['"`]).*?\1/g, "<s>")
    .replace(/(~|\.{1,2})?(\/[\w.@+-]+)+/g, "<path>")
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,40}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/={2,}/g, "==")
    .replace(/\s+/g, " ")
    .slice(0, 140);
  if (GENERIC.test(sig)) return undefined;
  return sig.replace(/<\w+>|[^A-Za-z]/g, "").length >= 6 ? sig : undefined;
}

export type Candidate = {
  signature: string;
  sessions: number;
  example: { cmd?: string; error: string };
  // rule ids that fire on at least half of the group's commands, and at three times their rate on failed commands at
  // large: a rule that fires on every git command "covers" every git error and explains none of them
  coveredBy: string[];
};

export function mine(errors: ToolError[], triggers: Triggers, minSessions = 3): Candidate[] {
  const groups = new Map<string, ToolError[]>();
  for (const e of errors) {
    const sig = signature(e.error);
    if (!sig) continue;
    const g = groups.get(sig) ?? [];
    g.push(e);
    groups.set(sig, g);
  }
  const allCmds = errors.map((e) => e.cmd).filter((c): c is string => !!c);
  const base = new Map<string, number>();
  for (const cmd of allCmds) for (const m of triggers.match({ cmd })) base.set(m.id, (base.get(m.id) ?? 0) + 1);
  const out: Candidate[] = [];
  for (const [sig, g] of groups) {
    const sessions = new Set(g.map((e) => e.session)).size;
    if (sessions < minSessions) continue;
    const cmds = g.map((e) => e.cmd).filter((c): c is string => !!c);
    const fires = new Map<string, number>();
    for (const cmd of cmds) for (const m of triggers.match({ cmd })) fires.set(m.id, (fires.get(m.id) ?? 0) + 1);
    const coveredBy = [...fires]
      .filter(([id, n]) => {
        const rate = n / cmds.length;
        const baseRate = (base.get(id) ?? 0) / Math.max(allCmds.length, 1);
        return !id.startsWith("hint:") && rate >= 0.5 && rate >= 3 * baseRate;
      })
      .map(([id]) => id);
    const first = g[0] as ToolError;
    out.push({ signature: sig, sessions, example: { cmd: first.cmd, error: first.error }, coveredBy });
  }
  return out.sort((a, b) => b.sessions - a.sessions);
}

if (import.meta.main) {
  const days = Number(process.argv[2] ?? 30);
  const min = Number(process.argv[3] ?? 3);
  const since = Date.now() - days * 24 * 3600 * 1000;
  // Subagent transcripts repeat their parent's failures under another file name; count each session once.
  const files = transcriptFiles(config.projectsDir, since).filter((f) => !f.includes("/subagents/"));
  const candidates = mine(files.flatMap(errorsIn), Triggers.load(), min);
  const clip = (s: string, n: number) => s.replace(/\s+/g, " ").slice(0, n);
  const uncovered = candidates.filter((c) => !c.coveredBy.length);
  console.log(`${files.length} sessions over ${days} days; ${candidates.length} error signatures in >= ${min} sessions`);
  console.log(`${uncovered.length} with no rule firing on their commands (lesson drafts), ${candidates.length - uncovered.length} repeating despite a rule\n`);
  console.log("== NO RULE — draft a lesson through rules-writer, then a triggers.toml entry with the example as t_cmd");
  for (const c of uncovered) {
    console.log(`\n[${c.sessions} sessions] ${c.signature}`);
    if (c.example.cmd) console.log(`  cmd:   ${clip(c.example.cmd, 160)}`);
    console.log(`  error: ${clip(c.example.error, 160)}`);
  }
  console.log("\n== RULE FIRES, MISTAKE REPEATS — check the rule's wording or tier (just effect-audit)");
  for (const c of candidates.filter((x) => x.coveredBy.length)) {
    console.log(`  [${c.sessions} sessions] ${c.coveredBy.join(" ")}  ${c.signature}`);
  }
}
