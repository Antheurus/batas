import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";

// A wrong injection is the user's signal that a trigger is too broad. Every report is kept in feedback.jsonl so the
// audits can rank triggers by it; a permanent mute in muted.json stops the id firing anywhere until it is unmuted.
const feedbackFile = () => join(config.stateDir, "feedback.jsonl");
const mutedFile = () => join(config.stateDir, "muted.json");

export type Feedback = { ts: string; ids: string[]; session: string; prompt: string; permanent: boolean };

export function reportWrong(ids: string[], session: string, prompt: string, permanent = false) {
  mkdirSync(config.stateDir, { recursive: true });
  const row: Feedback = { ts: new Date().toISOString(), ids, session, prompt: prompt.slice(0, 200), permanent };
  appendFileSync(feedbackFile(), `${JSON.stringify(row)}\n`);
}

export function readFeedback(): Feedback[] {
  if (!existsSync(feedbackFile())) return [];
  return readFileSync(feedbackFile(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Feedback);
}

export function mutedIds(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(mutedFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function setMuted(id: string, reason: string | null) {
  const muted = mutedIds();
  if (reason === null) delete muted[id];
  else muted[id] = reason;
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(mutedFile(), JSON.stringify(muted, null, 2));
}
