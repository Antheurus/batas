// A lesson in docs/lessons/ only helps if it reaches the agent while it works on the code it is about, and nothing did
// that: batas matched prompts and commands, and an agent rarely calls recall on its own. Claude Code itself loads a
// `.claude/rules/*.md` whose `paths:` match a file the moment that file is Read, Written or Edited, so this routes each
// lesson there: its `Simbol:` line is resolved to the file(s) that DEFINE those symbols, and one generated rule file
// per source file carries the full text of every lesson about it. Delivery then needs no trigger word, no recall and
// no batas process in the loop.
//
//   bun scripts/lessons-route.ts <repo>            dry run: what would be written, and lessons that resolve nowhere
//   bun scripts/lessons-route.ts <repo> --apply    rewrite <repo>/.claude/rules/lessons/ from scratch
//   bun scripts/lessons-route.ts <repo> --check    exit 1 when the generated files no longer match lessons + code
import { lessonsDir, parseLessons, routeRepo, ruleFile, staleFiles, writeRoutes } from "../src/lessons.ts";

export { definitions, type Lesson, parseLessons, resolveSymbol, type Route, routeLessons, ruleFile, staleFiles } from "../src/lessons.ts";

if (import.meta.main) {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: lessons-route.ts <repo> [--apply|--check]");
    process.exit(2);
  }
  const { routes, unresolved } = routeRepo(repo);
  const total = parseLessons(repo).length;
  const sizes = routes.map((r) => ruleFile(r).content.length).sort((a, b) => a - b);
  console.log(`${total} lessons; routed ${total - unresolved.length} to ${routes.length} source files; ${unresolved.length} resolve nowhere`);
  console.log(`rule file size: p50 ${sizes[Math.floor(sizes.length / 2)] ?? 0} B, p90 ${sizes[Math.floor(sizes.length * 0.9)] ?? 0} B, max ${sizes[sizes.length - 1] ?? 0} B`);
  const out = lessonsDir(repo);
  if (process.argv.includes("--check")) {
    const stale = staleFiles(out, routes);
    if (stale.length) {
      console.error(`STALE: ${stale.length} routed lesson file(s) differ from docs/lessons + code; run with --apply`);
      for (const n of stale.slice(0, 10)) console.error(`  ${n}`);
      process.exit(1);
    }
    console.log("routed lessons are current");
    process.exit(0);
  }
  if (process.argv.includes("--apply")) {
    writeRoutes(repo, routes);
    console.log(`wrote ${routes.length} files to ${out}`);
  }
  console.log("\nunresolved (no Simbol, or every symbol is generic / gone from the code):");
  for (const l of unresolved.slice(0, 40)) console.log(`  ${l.source}  ${l.title.slice(0, 90)}  [${l.symbols.join(", ")}]`);
  if (unresolved.length > 40) console.log(`  … ${unresolved.length - 40} more`);
}
