// Craftable weapons (Batch 2, item 14) — stats, recipes, and the props.
//
// Two bench-built guns sit on top of the always-carried pulse sidearm:
//   · PIPE RIFLE    — a scavenged pipe on a gunmetal receiver. Slow bolt, very
//                     high single-shot damage, long honest reach.
//   · SCRAP SHOTGUN — a tread-plate breech with a chopped twin barrel. Six
//                     pellets in a cone, brutal inside 20 m, harmless past it.
//
// Firing itself stays in the engine (it owns the raycasts, tracers and
// cooldown); this file is the data — what each gun costs, how it shoots, and
// what it looks like hanging off the player model. Props follow the same
// contract as every other built thing: real dimensions, kit primitives,
// materials from the material cards (MET03 gunmetal for the rifle, IND08
// tread plate for the shotgun).
import * as THREE from "./three";
import { surface, plain } from "./surface";
import { bev, part, flatBox, cyl } from "./kit";
import type { ItemId } from "./inventory";

export type WeaponId = "pulse" | "pipe_rifle" | "scrap_shotgun";

export interface WeaponDef {
  id: WeaponId;
  name: string;
  glyph: string;
  /** Seconds between shots. */
  cooldown: number;
  /** Damage per pellet/bullet. */
  damage: number;
  /** Pellets per trigger pull; 1 for everything except the shotgun. */
  pellets: number;
  /** Ray length in metres. */
  range: number;
  /** Cone half-angle in radians applied to each pellet. */
  spread: number;
  /** Tracer colour. */
  tracer: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  pulse: {
    id: "pulse", name: "PULSE SIDEARM", glyph: "🔫",
    cooldown: 0.17, damage: 25, pellets: 1, range: 70, spread: 0, tracer: 0x9fe8ff,
  },
  pipe_rifle: {
    id: "pipe_rifle", name: "PIPE RIFLE", glyph: "🎯",
    cooldown: 0.95, damage: 85, pellets: 1, range: 90, spread: 0, tracer: 0xffb347,
  },
  scrap_shotgun: {
    id: "scrap_shotgun", name: "SCRAP SHOTGUN", glyph: "💥",
    cooldown: 0.85, damage: 9, pellets: 6, range: 22, spread: 0.075, tracer: 0xffd28a,
  },
};

/** The two craftable guns, in workbench-menu order. */
export interface Recipe {
  item: ItemId;
  weapon: WeaponId;
  name: string;
  cost: number; // scrap
  blurb: string;
}

export const RECIPES: Recipe[] = [
  {
    item: "pipe_rifle", weapon: "pipe_rifle", name: "PIPE RIFLE", cost: 25,
    blurb: "Slow bolt, one heavy slug. Reaches across the yard.",
  },
  {
    item: "scrap_shotgun", weapon: "scrap_shotgun", name: "SCRAP SHOTGUN", cost: 45,
    blurb: "Six-pellet cone. Owns anything inside twenty metres.",
  },
];

/**
 * The rifle, built to hang at the player's side: ~0.9 m long, gunmetal
 * receiver (MET03) with a plain steel pipe barrel and a wood-ish grip.
 * Forward is +Z so it can ride the body group's yaw unrotated.
 */
export function makeRifleProp(): THREE.Group {
  const g = new THREE.Group();
  const gunmetal = surface("MET03", { local: true, tile: 0.7, grime: 0.25 });
  const steel = plain(0x6a675f, 0.5, 0.85);
  const dark = plain(0x33312e, 0.6, 0.7);
  const wood = plain(0x5d4630, 0.85, 0.05);
  // receiver + pipe barrel + front band
  g.add(bev(0.07, 0.11, 0.34, gunmetal, { pos: [0, 0, 0.1] }));
  g.add(part(cyl(0.021, 0.021, 0.62, 10), steel, { pos: [0, 0.012, 0.55], rot: [Math.PI / 2, 0, 0] }));
  g.add(part(cyl(0.03, 0.03, 0.05, 10), dark, { pos: [0, 0.012, 0.3], rot: [Math.PI / 2, 0, 0] }));
  g.add(part(cyl(0.026, 0.026, 0.02, 10), dark, { pos: [0, 0.012, 0.84], rot: [Math.PI / 2, 0, 0] })); // muzzle ring
  // grip + stock + bolt handle + a scrap of magazine
  g.add(bev(0.055, 0.13, 0.07, wood, { pos: [0, -0.09, -0.02], rot: [0.35, 0, 0] }));
  g.add(bev(0.06, 0.1, 0.22, wood, { pos: [0, -0.035, -0.22], rot: [0.1, 0, 0] }));
  g.add(part(cyl(0.012, 0.012, 0.07, 8), steel, { pos: [0.055, 0.045, 0.05], rot: [0, 0, Math.PI / 2] }));
  g.add(part(flatBox(0.045, 0.12, 0.09), dark, { pos: [0, -0.1, 0.12], rot: [0.12, 0, 0] }));
  g.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; } });
  return g;
}

/**
 * The shotgun: shorter (~0.7 m) and fatter — twin chopped barrels under an
 * IND08 tread-plate breech, taped grip.
 */
export function makeShotgunProp(): THREE.Group {
  const g = new THREE.Group();
  const tread = surface("IND08", { local: true, tile: 0.6, grime: 0.3 });
  const steel = plain(0x54514b, 0.55, 0.8);
  const dark = plain(0x2e2c29, 0.65, 0.6);
  const tape = plain(0x7a6f52, 0.9, 0.05);
  // tread-plate breech block
  g.add(bev(0.1, 0.12, 0.3, tread, { pos: [0, 0, 0.05] }));
  // twin barrels side by side
  for (const sx of [-0.028, 0.028]) {
    g.add(part(cyl(0.026, 0.026, 0.42, 10), steel, { pos: [sx, 0.01, 0.42], rot: [Math.PI / 2, 0, 0] }));
    g.add(part(cyl(0.03, 0.03, 0.025, 10), dark, { pos: [sx, 0.01, 0.62], rot: [Math.PI / 2, 0, 0] }));
  }
  // barrel band, wrapped foregrip, stub stock
  g.add(part(flatBox(0.12, 0.05, 0.06), dark, { pos: [0, 0.01, 0.28] }));
  g.add(bev(0.07, 0.08, 0.14, tape, { pos: [0, -0.055, 0.3] }));
  g.add(bev(0.08, 0.1, 0.2, dark, { pos: [0, -0.03, -0.2], rot: [0.12, 0, 0] }));
  g.traverse((c) => { const m = c as THREE.Mesh; if (m.isMesh) { m.castShadow = true; } });
  return g;
}
