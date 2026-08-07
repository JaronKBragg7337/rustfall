// NPC fetch quests — one repeatable errand per helper (Batch 2, item 11).
//
// Each of the three base NPCs hands out a small, honest job that feeds back
// into the systems the player already understands:
//   · MARA (farmer)   — deposit 3 fuel cans. A DEPOSIT: the cans leave the
//                       player's pouch into her store, never touching the
//                       generator's tank, so the quest never fights the
//                       generator's own E-interaction.
//   · DEKE (scrapper) — deposit 5 scrap from the stockpile counter.
//   · ROOK (guard)    — kill 4 shamblers at night (wave-night kills count too).
//
// One active quest at a time; talk (E) to the giver to accept, to deposit, and
// to turn in. The engine owns the state transitions; this file is the data and
// the pure rules, so balancing is a matter of editing one table.
import type { Job } from "./entities";

export type QuestKind = "fuel" | "scrap" | "cull";

export interface QuestDef {
  giver: Job;
  kind: QuestKind;
  title: string;
  /** Imperative objective line shown on the HUD card. */
  objective: string;
  target: number;
  reward: { scrap?: number; fuel?: number };
  rewardText: string;
}

export const QUESTS: Record<Job, QuestDef> = {
  FARMER: {
    giver: "FARMER",
    kind: "fuel",
    title: "FUEL FOR THE LAMPS",
    objective: "Deposit fuel cans",
    target: 3,
    reward: { scrap: 8 },
    rewardText: "+8 SCRAP",
  },
  SCRAPPER: {
    giver: "SCRAPPER",
    kind: "scrap",
    title: "STOCKPILE RUN",
    objective: "Deposit scrap",
    target: 5,
    reward: { fuel: 1 },
    rewardText: "+1 FUEL CAN",
  },
  GUARD: {
    giver: "GUARD",
    kind: "cull",
    title: "NIGHT WATCH",
    objective: "Kill shamblers at night",
    target: 4,
    reward: { scrap: 12 },
    rewardText: "+12 SCRAP",
  },
};

/** The one quest currently in flight, if any. */
export interface ActiveQuest {
  def: QuestDef;
  /** Display name of the NPC who gave it (MARA / DEKE / ROOK). */
  giverName: string;
  progress: number;
}

export function questComplete(q: ActiveQuest): boolean {
  return q.progress >= q.def.target;
}
