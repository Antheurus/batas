import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
const claudeHome = process.env.BATAS_CLAUDE_HOME ?? join(home, ".claude");
const stateDir = process.env.BATAS_STATE_DIR ?? join(home, ".batas");

export const config = {
  claudeHome,
  rulesDir: join(claudeHome, "rules"),
  referenceDirs: [join(claudeHome, "references")],
  skillsDir: join(claudeHome, "skills"),
  projectsDir: join(claudeHome, "projects"),
  sharedMemoryDir: join(claudeHome, "memory", "shared"),
  triggersFile: process.env.BATAS_TRIGGERS ?? join(claudeHome, "batas", "triggers.toml"),
  // Personal repos and work (Brighty) repos live in two folders; with only the first, every Brighty repo's rules,
  // lessons and progress were outside the corpus (none of Funnel's in 13,773 entries, 2026-10-10). Set here, not in the
  // launchd plist: batasd respawned by a hook call does not carry the plist's environment.
  projectRoots: (
    process.env.BATAS_PROJECT_ROOTS ??
    [join(home, "Documents", "PROJECT_MISPAQUL_ATTORIQ"), join(home, "Documents", "DATA_BRIGHTY_MISPAQUL_ATTORIQ")].join(":")
  )
    .split(":")
    .filter(Boolean),
  stateDir,
  sessionsDir: join(stateDir, "sessions"),
  families: { "gotcha-coding.md": "gotcha", "lessons.md": "lessons" } as Record<string, string>,
  familySlicePrefix: { gotcha: "p-gotcha-", lessons: "p-lessons-" } as Record<string, string>,
  familyFullText: { gotcha: "gotcha-full.md", lessons: "lessons-full.md" } as Record<string, string>,
  log: { maxBytes: 5 * 1024 * 1024, keep: 3 },
  liveWindowMs: 15 * 60 * 1000,
  latencyBudgetMs: { tool: 60, prompt: 150 },
  // Cosine floors for a prompt match on each model, and the Gemma cosine above which another project's memory is injected
  // in full rather than listed. Calibrated by scripts/semantic-calibrate.ts; see docs/plan/2026-10-08-semantic-recall.
  // A prompt match counts only when the best hit's Gemma cosine stands minGap above the 10th (scripts/semantic-calibrate.ts,
  // docs/plan/2026-10-08-semantic-recall/plan.md); fullCos lets another project's memory in full instead of listed.
  // writeHook stays off: a cosine gap does not separate a written file's lesson from noise (scripts/write-calibrate.ts).
  // BATAS_SEMANTIC_MIN_GAP overrides the prompt gate for one session (the behavior eval's forced-delivery arm).
  // memoryGap gates memories on their own (the best MEMORY over the same reference): rules and lessons took the single
  // passing slot from them. At 0.045, 34/300 real prompts pass and ~18 of the 22 added over 0.07 were relevant by hand;
  // below it about half were not (2026-10-09, scripts/semantic-calibrate.ts).
  semantic: {
    promptHook: true,
    minGap: Number(process.env.BATAS_SEMANTIC_MIN_GAP ?? 0.07),
    memoryGap: Number(process.env.BATAS_SEMANTIC_MEMORY_GAP ?? 0.045),
    writeHook: false,
    writeGap: 0.07,
    fullCos: 0.6,
  },
  // The shared MCP server binds loopback only. Claude Code sends no DELETE on a hard kill, so idleMs is the only session
  // cleanup; rootsMs bounds the wait for a client's GET stream plus its roots/list answer before a session goes projectless.
  http: { host: "127.0.0.1", idleMs: 6 * 3600 * 1000, rootsMs: 5000, watchMs: 2000, settleMs: 1000 },
  inject: { maxItems: 3, maxChars: 9000, maxPromptHints: 5, maxMemories: 2, memoryChars: 1500, maxMoreMemories: 8, maxRepoList: 12, sessionBytes: 64000 },
};

export type Config = typeof config;
