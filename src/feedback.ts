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

// Every time an agent acks past the collision guard while the guard would have denied. A rising count means agents
// learned to reach for the ack instead of staging by path, which turns the guard into a no-op.
const acksFile = () => join(config.stateDir, "acks.jsonl");

export function recordAck(kind: string, session: string, command: string) {
  mkdirSync(config.stateDir, { recursive: true });
  appendFileSync(acksFile(), `${JSON.stringify({ ts: new Date().toISOString(), kind, session, command: command.slice(0, 200) })}\n`);
}

export function readAcks(sinceMs: number): { ts: string; kind: string; session: string; command: string }[] {
  if (!existsSync(acksFile())) return [];
  return readFileSync(acksFile(), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { ts: string; kind: string; session: string; command: string })
    .filter((r) => Date.parse(r.ts) >= sinceMs);
}
