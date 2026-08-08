// Save / load (Batch 2, item 16) — one versioned JSON blob in localStorage.
//
// What is saved: player position & hp, the backpack, the equipped weapon, the
// active fetch quest, generator fuel, time of day, the night counter (wave
// scheduling rides it), kills, and which loot nodes were already searched.
//
// What is NOT saved: entities. Robots, shamblers, stalkers, boars, vehicles
// and the boss all respawn from their deterministic seeds on load, so a
// continued run restocks the wasteland — live wave-night assaults in progress
// are therefore lost across a reload, which the schema comment owns up to.
// Loot nodes are rebuilt in the same seeded order every boot, so "taken"
// indexes are stable across sessions as long as the spawn code is unchanged.
import type { Slot } from "./inventory";
import type { Job } from "./entities";
import type { WeaponId } from "./weapons";

export const SAVE_KEY = "rustfall.save";
/**
 * v2 adds `cacheIds` (opened outer-ring supply caches) and `goretuskDead`
 * (the mini-boss stays dead once killed). Both are optional fields, so a v1
 * blob loads cleanly — the missing fields simply read as "nothing opened,
 * boss alive". Older-than-1 or newer-than-current blobs are rejected.
 */
export const SAVE_VERSION = 2;

export interface SaveData {
  /** Schema version. Anything else is treated as "no usable save". */
  v: number;
  savedAt: number; // wall-clock ms, for display only
  player: {
    pos: [number, number, number];
    hp: number;
    /** Mode at save time; vehicles/mech re-dock on load, so this restores as FOOT. */
    mode: "FOOT" | "VEHICLE" | "MECH";
  };
  /** Backpack slots, serialised by Inventory.toJSON(). */
  inventory: (Slot | null)[];
  /** Equipped weapon; "pulse" is always available. */
  weapon: WeaponId;
  /** The one active fetch quest, if any. */
  quest: { job: Job; giverName: string; progress: number } | null;
  /** Generator tank, in fractional cans. */
  genFuel: number;
  timeOfDay: number;
  /** Nights elapsed — every 3rd night is a wave night. */
  nightIndex: number;
  kills: number;
  /** Indexes into the seeded loot field that were already searched. */
  lootTaken: number[];
  /** v2: ids of opened outer-ring supply caches. Missing on v1 → none opened. */
  cacheIds?: string[];
  /** v2: GORETUSK ALPHA stays dead once killed. Missing on v1 → alive. */
  goretuskDead?: boolean;
}

/** Parse and validate. Returns null on anything unexpected — never throws. */
export function loadSave(): SaveData | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as SaveData;
    // v1 saves load as-is: the v2 fields are optional and default to empty.
    if (!data || typeof data !== "object" || (data.v !== 1 && data.v !== SAVE_VERSION)) return null;
    if (!data.player || !Array.isArray(data.player.pos) || data.player.pos.length !== 3) return null;
    if (typeof data.timeOfDay !== "number" || !Array.isArray(data.inventory)) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeSave(data: SaveData): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch {
    // Private-mode quota etc. — a failed save must never crash the loop.
    return false;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    /* ignore */
  }
}

export function hasSave(): boolean {
  return loadSave() !== null;
}
