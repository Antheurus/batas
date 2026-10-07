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
  triggersFile: process.env.BATAS_TRIGGERS ?? join(claudeHome, "batas", "triggers.toml"),
  projectRoots: (process.env.BATAS_PROJECT_ROOTS ?? join(home, "Documents", "PROJECT_MISPAQUL_ATTORIQ"))
    .split(":")
    .filter(Boolean),
  stateDir,
  indexFile: join(stateDir, "index.db"),
  sessionsDir: join(stateDir, "sessions"),
  families: { "gotcha-coding.md": "gotcha", "lessons.md": "lessons" } as Record<string, string>,
  familySlicePrefix: { gotcha: "p-gotcha-", lessons: "p-lessons-" } as Record<string, string>,
  familyFullText: { gotcha: "gotcha-full.md", lessons: "lessons-full.md" } as Record<string, string>,
  log: { maxBytes: 5 * 1024 * 1024, keep: 3 },
  liveWindowMs: 15 * 60 * 1000,
  latencyBudgetMs: { tool: 60, prompt: 150 },
  inject: { maxItems: 3, maxChars: 9000, maxPromptHints: 5, maxMemories: 2, memoryChars: 1500, maxMoreMemories: 8 },
};

export type Config = typeof config;
