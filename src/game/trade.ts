// Barter economy (SAL the Trader) — data only, the engine owns the rules.
//
// Scrap is the only currency SAL accepts: he sells consumables and the two
// bench guns at a premium over crafting, and he buys scrap back in bulk for
// fuel. The prices make the workbench the cheap-but-local option and SAL the
// anywhere-convenient one — a fuel can costs 8 scrap here but a cache run
// pays 5–10, so a round trip roughly breaks even.
//
// Guns are one-time purchases: once owned, the offer shows as SOLD.

export type TradeId = "sell_scrap" | "buy_medkit" | "buy_fuel" | "buy_rifle" | "buy_shotgun";

export interface TradeOffer {
  id: TradeId;
  name: string;
  /** HUD glyph, same emoji convention as the backpack. */
  glyph: string;
  /** Scrap price. For "sell" this is what SAL takes per unit bought from you. */
  cost: number;
  kind: "sell" | "buy";
  blurb: string;
}

export const TRADE_OFFERS: TradeOffer[] = [
  {
    id: "sell_scrap", name: "SELL SCRAP ×10", glyph: "⚙", cost: 10, kind: "sell",
    blurb: "Ten scrap for one fuel can. SAL always needs metal.",
  },
  {
    id: "buy_medkit", name: "MEDKIT", glyph: "🩹", cost: 6, kind: "buy",
    blurb: "Field trauma kit. +40 integrity when used.",
  },
  {
    id: "buy_fuel", name: "FUEL CAN", glyph: "⛽", cost: 8, kind: "buy",
    blurb: "Feeds the base generator through one night.",
  },
  {
    id: "buy_rifle", name: "PIPE RIFLE", glyph: "🎯", cost: 60, kind: "buy",
    blurb: "Slow bolt, one heavy slug. Cheaper at the workbench.",
  },
  {
    id: "buy_shotgun", name: "SCRAP SHOTGUN", glyph: "💥", cost: 100, kind: "buy",
    blurb: "Six-pellet cone. Cheaper at the workbench.",
  },
];
