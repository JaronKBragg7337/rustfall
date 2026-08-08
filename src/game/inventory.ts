// Backpack & inventory — a slot-based model for everything the player carries.
//
// Before this, carried things were two bare counters (`player.fuel` and
// `engine.scrap`) with no upper bound and no place for anything new. A slot
// grid gives the game a real backpack: stack limits make fuel cans something
// you plan around, and non-stackable gear (the craftable weapons) has a place
// to live that the save file can serialise.
//
// Deliberately weight-free: encumbrance math is a different game. Capacity
// pressure comes from slots and stack caps alone.
//
// Accessors stay tiny and pure (`count`, `add`, `remove`, `spaceFor`) so the
// generator, the quest deposits and the crafting bench all draw from the same
// store without knowing how it is laid out.

export type ItemId = "fuel_can" | "scrap" | "pipe_rifle" | "scrap_shotgun" | "medkit";

export interface ItemDef {
  name: string;
  /** HUD glyph — emoji, so no icon atlas is needed. */
  glyph: string;
  /** Max per slot; 1 = non-stackable gear. */
  stack: number;
  /** One-line hint shown in the panel. */
  desc: string;
}

export const ITEMS: Record<ItemId, ItemDef> = {
  fuel_can: {
    name: "FUEL CAN",
    glyph: "⛽",
    stack: 4,
    desc: "Feeds the base generator. Use near it, or press E.",
  },
  scrap: {
    name: "SCRAP",
    glyph: "⚙",
    stack: 40,
    desc: "Raw material. Craft with it at the workbench.",
  },
  pipe_rifle: {
    name: "PIPE RIFLE",
    glyph: "🎯",
    stack: 1,
    desc: "Slow, hits like a train. Tap to equip.",
  },
  scrap_shotgun: {
    name: "SCRAP SHOTGUN",
    glyph: "💥",
    stack: 1,
    desc: "Six-pellet spread, short range. Tap to equip.",
  },
  medkit: {
    name: "MEDKIT",
    glyph: "🩹",
    stack: 3,
    desc: "Field trauma kit. Use from the backpack: +40 integrity.",
  },
};

export const SLOT_COUNT = 12;

export interface Slot {
  id: ItemId;
  count: number;
}

export class Inventory {
  /** Fixed-length slot grid; null = empty. */
  slots: (Slot | null)[] = new Array<Slot | null>(SLOT_COUNT).fill(null);

  count(id: ItemId): number {
    let n = 0;
    for (const s of this.slots) if (s && s.id === id) n += s.count;
    return n;
  }

  has(id: ItemId): boolean {
    return this.slots.some((s) => s !== null && s.id === id);
  }

  /** How many more of `id` would fit right now. */
  spaceFor(id: ItemId): number {
    const cap = ITEMS[id].stack;
    let space = 0;
    for (const s of this.slots) {
      if (s === null) space += cap;
      else if (s.id === id) space += cap - s.count;
    }
    return space;
  }

  /**
   * Add up to `n` of `id`. Returns how many actually fit — partial adds are
   * allowed for stacks so a pickup can top off a pouch and leave the rest.
   */
  add(id: ItemId, n = 1): number {
    let left = n;
    const cap = ITEMS[id].stack;
    // top off existing stacks first, then claim empty slots, so the grid
    // compacts itself instead of fragmenting into half-full stacks
    for (const s of this.slots) {
      if (left <= 0) break;
      if (s && s.id === id && s.count < cap) {
        const take = Math.min(cap - s.count, left);
        s.count += take;
        left -= take;
      }
    }
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      if (this.slots[i] === null) {
        const take = Math.min(cap, left);
        this.slots[i] = { id, count: take };
        left -= take;
      }
    }
    return n - left;
  }

  /** Remove up to `n` of `id`. Returns how many were actually removed. */
  remove(id: ItemId, n = 1): number {
    let left = n;
    for (let i = this.slots.length - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (!s || s.id !== id) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return n - left;
  }

  /** Remove whatever occupies slot `i` (one unit). */
  removeAt(i: number, n = 1): Slot | null {
    const s = this.slots[i];
    if (!s) return null;
    s.count -= n;
    const out = { id: s.id, count: Math.min(n, s.count + n) };
    if (s.count <= 0) this.slots[i] = null;
    return out;
  }

  /** Serialisable form: same shape as the slot grid. */
  toJSON(): (Slot | null)[] {
    return this.slots.map((s) => (s ? { id: s.id, count: s.count } : null));
  }

  /** Rebuild from a save. Unknown item ids and bad counts are dropped. */
  static fromJSON(data: unknown): Inventory {
    const inv = new Inventory();
    if (!Array.isArray(data)) return inv;
    for (let i = 0; i < Math.min(data.length, SLOT_COUNT); i++) {
      const raw = data[i] as { id?: unknown; count?: unknown } | null;
      if (!raw || typeof raw !== "object") continue;
      const id = raw.id as ItemId;
      if (typeof id !== "string" || !(id in ITEMS)) continue;
      const count = Math.floor(typeof raw.count === "number" ? raw.count : 0);
      if (count <= 0) continue;
      inv.slots[i] = { id, count: Math.min(count, ITEMS[id].stack) };
    }
    return inv;
  }
}
