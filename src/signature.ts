// The one owner of what counts as a mistake and how a failure is grouped: lesson-mine and eval read transcripts with
// it, and the hook keys its after-failure recall cue on it, so a cue and a measured case are the same thing.
// The harness's own refusals, a user saying no or pressing stop, and a search that simply found nothing (grep exits 1)
// are not mistakes to learn from.
const NOT_A_MISTAKE =
  /^<tool_use_error>|user doesn't want|user rejected|YOUR PLAN WAS NOT APPROVED|hook (error|blocking)|PreToolUse:|denied this tool|Permission to use|^\[Request interrupted by user|^(Exit code 1\n)?0 matches for /i;
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
