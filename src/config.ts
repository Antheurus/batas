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
  projectRoots: (process.env.BATAS_PROJECT_ROOTS ?? join(home, "Documents", "PROJECT_MISPAQUL_ATTORIQ"))
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
  semantic: { promptHook: true, minGap: Number(process.env.BATAS_SEMANTIC_MIN_GAP ?? 0.07), writeHook: false, writeGap: 0.07, fullCos: 0.6 },
  inject: { maxItems: 3, maxChars: 9000, maxPromptHints: 5, maxMemories: 2, memoryChars: 1500, maxMoreMemories: 8, sessionBytes: 64000 },
};

export type Config = typeof config;
