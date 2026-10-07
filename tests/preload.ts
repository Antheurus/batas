import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "batas-test-"));
const claudeHome = join(root, "claude");
const realHome = join(homedir(), ".claude");

cpSync(join(realHome, "rules"), join(claudeHome, "rules"), { recursive: true });
cpSync(join(realHome, "references"), join(claudeHome, "references"), { recursive: true });
const realTriggers = join(realHome, "batas", "triggers.toml");
if (existsSync(realTriggers)) cpSync(realTriggers, join(claudeHome, "batas", "triggers.toml"));

const memDir = join(claudeHome, "projects", "-tmp-demo", "memory");
mkdirSync(memDir, { recursive: true });
writeFileSync(
  join(memDir, "hooks-warn-not-ask.md"),
  "---\nname: hooks-warn-not-ask\ndescription: \"Advisory hooks should warn via additionalContext, never ask popups\"\nmetadata:\n  type: feedback\n---\n\nThe user prefers permissionDecision allow plus additionalContext over ask popups.\n",
);

writeFileSync(
  join(memDir, "land-without-asking.md"),
  "---\nname: land-without-asking\ndescription: \"Agent lands its own work on the base\"\ntriggers: \"commit, push, tunggu aba-aba\"\nmetadata:\n  type: feedback\n---\n\nNever wait for a go-signal to land finished work.\n",
);

// Production carries ~600 memories with triggers across projects; the latency budget is only honest at that scale.
const bulkDir = join(claudeHome, "projects", "-tmp-bulk", "memory");
mkdirSync(bulkDir, { recursive: true });
for (let i = 0; i < 600; i++) {
  writeFileSync(
    join(bulkDir, `bulk-${i}.md`),
    `---\nname: bulk-${i}\ndescription: "Synthetic memory ${i} about vendor${i} checkout flow"\ntriggers: "vendor${i}, vendor${i} checkout, ${["webhook","printer","struk","ongkir","resi","voucher"][i % 6]} vendor${i}, alur bayar ${i}"\nmetadata:\n  type: project\n---\n\nBody ${i}.\n`,
  );
}

const repos = join(root, "repos");
const demo = join(repos, "demo-app");
mkdirSync(join(demo, "docs"), { recursive: true });
mkdirSync(join(demo, ".claude", "rules"), { recursive: true });
writeFileSync(
  join(demo, ".claude", "rules", "all-lessons.md"),
  "# Lessons Learned\n\n## Receipt printer needs ESC/POS codepage 16\nPrinting rupiah symbols garbles unless the codepage is set first.\n",
);
writeFileSync(
  join(demo, "docs", "changelog.md"),
  "# demo-app Changelog\n\n## v0.2.0 — Struk printer\n\n- Struk sekarang tercetak rapi.\n",
);

process.env.BATAS_CLAUDE_HOME = claudeHome;
process.env.BATAS_STATE_DIR = join(root, "state");
process.env.BATAS_PROJECT_ROOTS = repos;
process.env.BATAS_TEST_ROOT = root;
