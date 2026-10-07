// Replay the user's real prompts (~/.claude/history.jsonl) through each rule's `prompt` phrases, one phrase at a time
// through the hook's own Triggers on the user's own words, so a count here is exactly what the hook would have done. trigger-audit does the
// same for memory triggers; this covers the rule side: phrases that fire on a large share of all prompts (they list
// the rule on unrelated requests) and phrases that never fired once (a rule nobody can reach by asking).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { ownWords } from "../src/hook.ts";
import { type TriggerSpec, Triggers } from "../src/triggers.ts";

export type PromptAudit = {
  prompts: number;
  pulling: number;
  perPrompt: Record<number, number>;
  phrases: { id: string; phrase: string; hits: number }[];
  silentIds: string[];
};

export function auditPrompts(prompts: string[], specs: Record<string, TriggerSpec>): PromptAudit {
  const single: Record<string, TriggerSpec> = {};
  const phrases: { id: string; phrase: string; hits: number }[] = [];
  for (const [id, s] of Object.entries(specs)) {
    if (id.startsWith("_")) continue;
    for (const phrase of s.prompt ?? []) {
      single[String(phrases.length)] = { prompt: [phrase] };
      phrases.push({ id, phrase, hits: 0 });
    }
  }
  const t = new Triggers(single);
  const perPrompt: Record<number, number> = {};
  let pulling = 0;
  for (const prompt of prompts) {
    const ids = new Set<string>();
    for (const m of t.match({ prompt: ownWords(prompt) })) {
      const p = phrases[Number(m.id)];
      if (!p) continue;
      p.hits++;
      ids.add(p.id);
    }
    if (ids.size) pulling++;
    const bucket = Math.min(ids.size, 5);
    perPrompt[bucket] = (perPrompt[bucket] ?? 0) + 1;
  }
  const firing = new Set(phrases.filter((p) => p.hits).map((p) => p.id));
  const silentIds = [...new Set(phrases.map((p) => p.id))].filter((id) => !firing.has(id));
  return { prompts: prompts.length, pulling, perPrompt, phrases, silentIds };
}

// Same filter as trigger-audit: slash commands and one-word acks are not requests.
export function historyPrompts(file = join(config.claudeHome, "history.jsonl")): string[] {
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const text = String((JSON.parse(line) as { display?: string }).display ?? "").trim();
      if (text.length >= 4 && !text.startsWith("/")) out.push(text);
    } catch {}
  }
  return out;
}

if (import.meta.main) {
  const share = Number(process.argv[2] ?? 0.01);
  const prompts = historyPrompts();
  const triggers = Triggers.load();
  const a = auditPrompts(prompts, triggers.specs);
  const pct = (n: number) => `${((n / Math.max(a.prompts, 1)) * 100).toFixed(1)}%`;
  console.log(`prompts ${a.prompts}; listing any rule: ${a.pulling} (${pct(a.pulling)})`);
  console.log("rules per prompt (5 = 5+):", a.perPrompt);
  const general = a.phrases.filter((p) => p.hits / Math.max(a.prompts, 1) >= share).sort((x, y) => y.hits - x.hits);
  console.log(`\nphrases firing on >= ${share * 100}% of prompts (make them more specific):`);
  for (const p of general) console.log(`  ${pct(p.hits).padStart(6)} ${String(p.hits).padStart(5)}  ${p.id.padEnd(16)} ${JSON.stringify(p.phrase)}`);
  const dead = a.phrases.filter((p) => !p.hits);
  console.log(`\nphrases that never fired: ${dead.length} of ${a.phrases.length}`);
  console.log(`rules no prompt ever reached (${a.silentIds.length}) — fine for cmd/path-driven rules, a gap otherwise:`);
  // A rule that also has cmd/path/code triggers still reaches the agent when the work starts; a prompt-only one does not.
  const promptOnly = a.silentIds.filter((id) => {
    const s = triggers.specs[id];
    return !(s?.cmd?.length || s?.path?.length || s?.code?.length);
  });
  console.log(`  ${a.silentIds.length - promptOnly.length} also have cmd/path/code triggers; ${promptOnly.length} are prompt-only:`);
  for (const id of promptOnly) console.log(`  ${id.padEnd(16)} ${JSON.stringify(triggers.specs[id]?.prompt)}`);
}
