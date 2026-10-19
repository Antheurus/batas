import type { TriggerSpec } from "../src/triggers.ts";

export const triggerable = (specs: Record<string, TriggerSpec>, id: string) => {
  const sp = specs[id];
  return !!sp && !!(sp.cmd?.length || sp.path?.length || sp.code?.length);
};

// An every-turn item carries an empty trigger table on purpose; only a rule with a real pattern can be "never fired".
export const neverFired = (ids: string[], specs: Record<string, TriggerSpec>, fires: Map<string, number>, live: Map<string, number>) =>
  ids.filter((id) => !fires.get(id) && !live.get(id) && triggerable(specs, id));
