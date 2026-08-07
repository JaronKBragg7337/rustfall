// Industrial expansion (Batch 1) — railway siding with boxcars, rail water
// tower, perimeter watchtower, gas-station ruin, scrap magnet crane, and
// seeded detail props.
//
// Same assembly rules as world.ts:
//   · Primary form, then secondary components, then tertiary construction
//     detail. Rivets, bolts and sleepers are instanced; geometry is cached by
//     dimension through kit.ts.
//   · Everything grounds through terrain.heightAt(). The rail line follows the
//     grade in 5.5 m segments instead of pretending the desert is level — the
//     terrain pads are owned by terrain.ts, so no new grading is added here.
//   · Apertures are registered and collision is carved per child; nothing
//     solid ever spans an opening.
//   · Siting was checked against the deterministic prop scatter (makeRng 9137)
//     so nothing here lands on an existing asset; these props draw from their
//     own stream (makeRng 20240) and leave the original sequence untouched.
import * as THREE from "./three";
import { registerAsset, registerAperture, makeRng, type AssetFlags } from "./constants";
import { matOf } from "./textures";
import { plain } from "./surface";
import { bev, bevelBox, part, flatBox, cyl, bolts, rivets, along, type Placement } from "./kit";
import { heightAt } from "./terrain";
import type { WorldRefs } from "./world";

const T = 0.2;             // masonry thickness, matching world.ts
const H = 3.0;             // storey height
const DOOR_W = 1.0, DOOR_H = 2.1;              // domestic/salvage set, as world.ts
const WIN_W = 1.2, WIN_H = 1.2, WIN_SILL = 0.95;

// ─────────────────────────── shared surfaces ───────────────────────────
const M = {
  corrugated: (size = 2) => matOf("IND01", size),  // roofs, crane cab, canopy
  painted: (size = 2) => matOf("IND02", size),     // boxcars, tank, pumps, signs
  wood: (size = 2) => matOf("IND03", size),        // sleepers, timber legs, pallets
  concrete: (size = 3) => matOf("IND04", size),    // islands, footings, floors
  brick: (size = 3) => matOf("IND05", size),       // kiosk walls
  ballast: (size = 3) => matOf("IND06", size),     // rail bed
  asphalt: (size = 4) => matOf("IND07", size),     // forecourt pad
  tread: (size = 1.5) => matOf("IND08", size),     // platforms, decks
  tarp: (size = 1.5) => matOf("IND09", size),      // covered crates
  tyre: () => matOf("CRV03", 1),
  drum: () => matOf("CRV07", 1),
  glass: () => matOf("CRV08", 1.5),
};
const steel = () => plain(0x55524d, 0.44, 0.85);
const dark = () => plain(0x34322f, 0.58, 0.8);

// ─────────────────────────── placement helpers ───────────────────────────
// Mirrors makeBuilder in world.ts so the two files speak one vocabulary.
function makeSiteBuilder(refs: WorldRefs) {
  const solid = (
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, role: string,
    opts: { ry?: number; collide?: boolean; radius?: number; flags?: AssetFlags } = {}
  ): THREE.Mesh => {
    const m = bev(w, h, d, mat, { pos: [x, y + h / 2, z], radius: opts.radius });
    if (opts.ry) m.rotation.y = opts.ry;
    refs.scene.add(m);
    registerAsset(role, m, "AST", opts.flags);
    if (opts.collide !== false) {
      m.updateMatrixWorld(true);
      refs.colliders.push(new THREE.Box3().setFromObject(m));
    }
    return m;
  };

  const deco = (o: THREE.Object3D, x?: number, y?: number, z?: number): THREE.Object3D => {
    if (x !== undefined) o.position.set(x, y!, z!);
    refs.scene.add(o);
    return o;
  };

  // See world.ts for why "children" matters: one box over an aperture seals it.
  const unit = (
    g: THREE.Group, x: number, y: number, z: number, role: string,
    ry = 0, collide: boolean | "children" = true, flags: AssetFlags = {}
  ) => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    refs.scene.add(g);
    const rec = registerAsset(role, g, "AST", flags);
    const ap = g.userData.aperture as
      { x: number; y: number; z: number; w: number; h: number; axis: "x" | "z"; glazed?: boolean } | undefined;
    if (ap && !ap.glazed) {
      const ca = Math.cos(ry), sa = Math.sin(ry);
      registerAperture(rec.id,
        { x: x + ap.x * ca + ap.z * sa, y: y + ap.y, z: z - ap.x * sa + ap.z * ca },
        ap.w, ap.h, ry % Math.PI === 0 ? ap.axis : (ap.axis === "x" ? "z" : "x"));
    }
    if (collide) {
      g.updateMatrixWorld(true);
      if (collide === "children") {
        for (const child of g.children) {
          if (child.userData.noCollide) continue;
          const b = new THREE.Box3().setFromObject(child);
          if (!b.isEmpty()) refs.colliders.push(b);
        }
      } else {
        refs.colliders.push(new THREE.Box3().setFromObject(g));
      }
    }
    return g;
  };

  return { solid, deco, unit };
}

/** Cylinder between two points — diagonal bracing, backstays, cables. */
function strut(a: [number, number, number], b: [number, number, number], r: number, mat: THREE.Material): THREE.Mesh {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const dir = vb.clone().sub(va);
  const len = dir.length();
  const m = part(cyl(r, r, len, 6), mat);
  m.position.copy(va).addScaledVector(dir, 0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

/** Instanced placements — same contract as kit.ts's internal helper. */
function instancedPlaces(geo: THREE.BufferGeometry, mat: THREE.Material, places: Placement[]): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(geo, mat, places.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  places.forEach((pl, i) => {
    p.set(...pl.pos);
    e.set(...(pl.rot ?? [0, 0, 0]));
    q.setFromEuler(e);
    const k = pl.scale ?? 1;
    s.set(k, k, k);
    m.compose(p, q, s);
    im.setMatrixAt(i, m);
  });
  im.instanceMatrix.needsUpdate = true;
  im.castShadow = true;
  im.receiveShadow = true;
  return im;
}

// ═══════════════════════════ 1 · RAILWAY SIDING ═══════════════════════════
// A siding off the old main line, terminating at a buffer stop just west of
// the highway — the transfer point where rail freight met the road. The line
// stops at x = 0 deliberately: further east the highway pad's grade transition
// is a 10% ramp no railway would be built on.

const RAIL_Z = 72;
const RAIL_X0 = -88;
const RAIL_X1 = 0;
const RAIL_SEG = 5.5;
const GAUGE = 1.435;                  // standard gauge, metres
const BED_H = 0.35, BED_SINK = 0.12;  // ballast shoulder sits slightly proud
const SLP_H = 0.15, RAIL_H = 0.17;
const RAIL_TOP = BED_H - BED_SINK + SLP_H + RAIL_H; // 0.55 m above local grade

function buildRailway(refs: WorldRefs) {
  const { deco, unit } = makeSiteBuilder(refs);
  const ballast = M.ballast(3);
  const wood = M.wood(2);
  const railSteel = plain(0x4d443c, 0.6, 0.75);

  // Track bed + rail pairs, pitched per segment to follow the grade.
  for (let x = RAIL_X0; x < RAIL_X1; x += RAIL_SEG) {
    const x1 = Math.min(x + RAIL_SEG, RAIL_X1);
    const xc = (x + x1) / 2;
    const h0 = heightAt(x, RAIL_Z), h1 = heightAt(x1, RAIL_Z);
    const g = new THREE.Group();
    g.add(bev(RAIL_SEG + 0.02, BED_H, 4.4, ballast, { pos: [0, BED_H / 2 - BED_SINK, 0] }));
    for (const sz of [-1, 1]) {
      g.add(bev(RAIL_SEG + 0.3, RAIL_H, 0.07, railSteel, { pos: [0, BED_H - BED_SINK + SLP_H + RAIL_H / 2, sz * GAUGE / 2] }));
    }
    g.rotation.z = Math.atan2(h1 - h0, x1 - x);
    // Step-over height, so no collider — a 0.55 m box wall across the map would
    // fence the player out of the whole north side.
    unit(g, xc, (h0 + h1) / 2, RAIL_Z, "rail bed", 0, false);
  }

  // Sleepers: instanced, one mesh per 11 m chunk, each following the real
  // grade. Registering them in chunks keeps each asset's box local to the
  // ground that actually supports it.
  const sleeperGeo = bevelBox(0.22, SLP_H, 2.5);
  for (let xs = RAIL_X0; xs < RAIL_X1; xs += 11) {
    const xe = Math.min(xs + 11, RAIL_X1);
    const places: Placement[] = [];
    for (let x = xs + 0.33; x <= xe - 0.3; x += 0.65) {
      const h = heightAt(x, RAIL_Z);
      places.push({
        pos: [x, h + BED_H - BED_SINK + SLP_H / 2, RAIL_Z],
        rot: [0, 0, Math.atan2(heightAt(x + 0.33, RAIL_Z) - heightAt(x - 0.33, RAIL_Z), 0.66)],
      });
    }
    const im = instancedPlaces(sleeperGeo, wood, places);
    deco(im);
    registerAsset("rail sleepers", im, "AST");
  }

  // Buffer stop at the terminus: inclined struts, timber head, ballast mound.
  {
    const bx = 0.9;
    const by = heightAt(bx, RAIL_Z);
    const g = new THREE.Group();
    g.add(strut([0, 0.05, -GAUGE / 2], [0.8, 0.85, -GAUGE / 2], 0.09, steel()));
    g.add(strut([0, 0.05, GAUGE / 2], [0.8, 0.85, GAUGE / 2], 0.09, steel()));
    g.add(part(flatBox(0.18, 0.3, 2.3), steel(), { pos: [0.8, 0.9, 0] }));
    g.add(bev(0.22, 0.55, 0.7, wood, { pos: [0.95, 0.9, 0] }));
    g.add(bev(1.8, 0.5, 3.2, ballast, { pos: [0.1, 0.08, 0] }));
    g.add(bolts([{ pos: [0.9, 0.9, 0.42], rot: [Math.PI / 2, 0, 0] }, { pos: [0.9, 0.9, -0.42], rot: [Math.PI / 2, 0, 0] }], steel(), 0.016));
    unit(g, bx, by, RAIL_Z, "buffer stop", 0, true, { interpenetrates: true });
  }

  // Two boxcars spotted on the siding.
  boxcar(unit, -42);
  boxcar(unit, -20);
}

/**
 * 40-ft boxcar: 15.4 x 3.0 m body, roof 4.0 m above the rail head. Sliding
 * side doors (closed — the car is one solid collider, no aperture), two
 * two-axle bogies, end ladders, a roof walkway, and one instanced rivet run.
 * Group origin sits on the rail-top plane, so grounding is heightAt + RAIL_TOP.
 */
function boxcar(unit: ReturnType<typeof makeSiteBuilder>["unit"], cx: number) {
  const L = 15.4, W = 3.0;
  const paint = M.painted(4);
  const wood = M.wood(2);
  const st = steel();
  const dk = dark();
  const g = new THREE.Group();

  // running gear: two bogies, two wheelsets each, treads on the rail head
  for (const bx of [-5.3, 5.3]) {
    for (const ax of [-1.0, 1.0]) {
      for (const sz of [-1, 1]) {
        g.add(part(cyl(0.42, 0.42, 0.12, 16), dk, { pos: [bx + ax, 0.42, sz * GAUGE / 2], rot: [Math.PI / 2, 0, 0] }));
      }
      g.add(part(cyl(0.05, 0.05, 1.5, 8), dk, { pos: [bx + ax, 0.42, 0], rot: [Math.PI / 2, 0, 0] }));
    }
    for (const sz of [-1, 1]) g.add(bev(2.7, 0.4, 0.12, dk, { pos: [bx, 0.52, sz * 0.85] }));
    g.add(bev(1.3, 0.22, 1.9, dk, { pos: [bx, 0.95, 0] }));
  }
  g.add(bev(13.8, 0.18, 2.6, dk, { pos: [0, 1.06, 0] }));                    // underframe
  for (const sx of [-1, 1]) g.add(bev(0.55, 0.28, 0.34, dk, { pos: [sx * (L / 2 + 0.3), 0.95, 0] })); // couplers

  // body + roof
  g.add(bev(L, 2.85, W, paint, { pos: [0, 2.575, 0], radius: 0.03 }));
  g.add(bev(L + 0.08, 0.1, W + 0.08, paint, { pos: [0, 4.05, 0], radius: 0.02 }));
  for (let i = 0; i < 12; i++) {
    const x = -6.6 + i * 1.2;
    for (const sz of [-1, 1]) g.add(part(flatBox(0.1, 2.7, 0.05), paint, { pos: [x, 2.575, sz * 1.51], shadow: false }));
  }
  // roof walkway: boards on bearers, the crew path along the roof
  g.add(part(flatBox(L - 3.2, 0.04, 0.55), wood, { pos: [0, 4.12, 0] }));
  for (let i = 0; i < 6; i++) g.add(part(flatBox(0.12, 0.05, 0.55), wood, { pos: [-5.5 + i * 2.2, 4.09, 0], shadow: false }));

  // sliding side doors, closed: panel, overhead track, rollers, stops, latch
  for (const sz of [-1, 1]) {
    g.add(part(flatBox(2.5, 2.3, 0.08), paint, { pos: [0, 2.4, sz * 1.54] }));
    g.add(part(flatBox(3.8, 0.08, 0.05), dk, { pos: [0, 3.62, sz * 1.55] }));
    for (const rx of [-0.8, 0.8]) g.add(part(cyl(0.05, 0.05, 0.05, 8), st, { pos: [rx, 3.56, sz * 1.56], rot: [Math.PI / 2, 0, 0] }));
    for (const ex of [-1.8, 1.8]) g.add(bev(0.08, 0.14, 0.08, dk, { pos: [ex, 3.56, sz * 1.55] }));
    g.add(part(flatBox(0.06, 0.3, 0.06), dk, { pos: [1.12, 2.2, sz * 1.57] }));
    // door frame rivets
    g.add(rivets([
      ...along([-1.3, 1.35, sz * 1.53], [-1.3, 3.5, sz * 1.53], 6, [sz * Math.PI / 2, 0, 0]),
      ...along([1.3, 1.35, sz * 1.53], [1.3, 3.5, sz * 1.53], 6, [sz * Math.PI / 2, 0, 0]),
    ], st));
  }

  // end ladders (to the roof walkway) + brake gear at the +x end
  for (const sx of [-1, 1]) {
    for (const sz of [0.58, 1.12]) g.add(part(flatBox(0.05, 2.95, 0.05), st, { pos: [sx * 7.73, 2.6, sz] }));
    for (let i = 0; i < 8; i++) {
      g.add(part(cyl(0.018, 0.018, 0.54, 5), st, { pos: [sx * 7.73, 1.25 + i * 0.36, 0.85], rot: [Math.PI / 2, 0, 0] }));
    }
  }
  g.add(part(cyl(0.02, 0.02, 0.8, 6), dk, { pos: [7.6, 3.0, -0.95] }));
  g.add(part(cyl(0.17, 0.17, 0.04, 10), dk, { pos: [7.72, 3.45, -0.95], rot: [0, 0, Math.PI / 2] }));
  g.add(bev(0.15, 0.2, 0.15, dk, { pos: [7.6, 3.55, -0.95] }));

  // rivet seams: top and bottom chords of both sides plus both end faces
  const rv: Placement[] = [];
  for (const y of [1.35, 3.85]) {
    for (const sz of [-1, 1]) rv.push(...along([-7.4, y, sz * 1.53], [7.4, y, sz * 1.53], 26, [sz * Math.PI / 2, 0, 0]));
    for (const sx of [-1, 1]) rv.push(...along([sx * 7.72, y, -1.3], [sx * 7.72, y, 1.3], 10, [0, 0, sx * -Math.PI / 2]));
  }
  g.add(rivets(rv, st));

  unit(g, cx, heightAt(cx, RAIL_Z) + RAIL_TOP, RAIL_Z, "boxcar", 0, true);
}

// ═══════════════════════════ 2 · RAIL WATER TOWER ═══════════════════════════
// 6 m riveted tank on four braced legs beside the siding, spout over the
// track. The ladder is a climb VOLUME (refs.climbZones); the rungs are
// dressing — a 20 mm rung is not something a capsule can stand on.

function buildWaterTower(refs: WorldRefs) {
  const { unit } = makeSiteBuilder(refs);
  const tx = 2, tz = 65;
  const ty = heightAt(tx, tz);
  const paint = M.painted(4);
  const st = steel();
  const dk = dark();
  const g = new THREE.Group();

  // legs + ring beams (structural children — these carry the colliders)
  for (const [lx, lz] of [[-1.6, -1.6], [1.6, -1.6], [-1.6, 1.6], [1.6, 1.6]] as const) {
    g.add(bev(0.24, 6.2, 0.24, M.painted(2), { pos: [lx, 3.0, lz] })); // sunk 0.1
  }
  for (const by of [2.2, 4.2]) {
    for (const sz of [-1, 1]) {
      g.add(part(flatBox(3.2, 0.16, 0.1), dk, { pos: [0, by, sz * 1.6] }));
      g.add(part(flatBox(0.1, 0.16, 3.2), dk, { pos: [sz * 1.6, by, 0] }));
    }
  }
  // X-bracing between the legs — tagged: diagonal boxes across the leg bays
  // would wall off the walkable space under the tank.
  const braces = new THREE.Group();
  for (const [y0, y1] of [[0.4, 2.1], [2.4, 4.1]] as const) {
    for (const sz of [-1, 1]) {
      braces.add(strut([-1.5, y0, sz * 1.6], [1.5, y1, sz * 1.6], 0.035, st));
      braces.add(strut([1.5, y0, sz * 1.6], [-1.5, y1, sz * 1.6], 0.035, st));
      braces.add(strut([sz * 1.6, y0, -1.5], [sz * 1.6, y1, 1.5], 0.035, st));
      braces.add(strut([sz * 1.6, y0, 1.5], [sz * 1.6, y1, -1.5], 0.035, st));
    }
  }
  braces.userData.noCollide = true;
  g.add(braces);

  // tank: shell, base ring, conical roof, hatch
  g.add(part(cyl(3, 3, 3.5, 24), paint, { pos: [0, 7.75, 0] }));
  g.add(part(cyl(3.12, 3.12, 0.18, 24), dk, { pos: [0, 6.09, 0] }));
  g.add(part(cyl(0.12, 3.05, 0.8, 24), paint, { pos: [0, 9.9, 0] }));
  g.add(part(cyl(0.3, 0.35, 0.25, 10), dk, { pos: [0.9, 10.25, 0] }));
  // rivet bands + vertical seam, instanced
  const rv: Placement[] = [];
  for (const by of [6.6, 8.9]) {
    for (let i = 0; i < 42; i++) {
      const a = (i / 42) * Math.PI * 2;
      rv.push({ pos: [Math.cos(a) * 3.02, by, Math.sin(a) * 3.02], rot: [0, -a, -Math.PI / 2] });
    }
  }
  for (let i = 0; i < 9; i++) rv.push({ pos: [3.02, 6.3 + i * 0.36, 0], rot: [0, 0, -Math.PI / 2] });
  const tankRivets = rivets(rv, st);
  tankRivets.userData.noCollide = true;
  g.add(tankRivets);

  // spout arm over the track side (+z): horizontal run, downturned end, brace
  const spout = new THREE.Group();
  spout.add(part(cyl(0.09, 0.09, 1.5, 8), dk, { pos: [0, 5.5, 3.35], rot: [Math.PI / 2, 0, 0] }));
  spout.add(part(cyl(0.09, 0.09, 1.3, 8), dk, { pos: [0, 4.95, 4.05] }));
  spout.add(strut([0, 6.3, 2.9], [0, 5.45, 4.0], 0.03, st));
  spout.add(bev(0.28, 0.34, 0.28, dk, { pos: [0, 5.9, 2.55] })); // counterweight
  spout.userData.noCollide = true;
  g.add(spout);

  // access platform beside the tank at the top of the ladder
  g.add(bev(1.7, 0.1, 1.3, M.tread(), { pos: [0, 6.0, -3.45] }));
  // platform railing, three sides, 1.2 m gap at the ladder climb-out
  for (const sx of [-0.725, 0.725]) g.add(bev(0.25, 1.0, 0.06, st, { pos: [sx, 6.55, -4.05] }));
  for (const sx of [-0.82, 0.82]) g.add(bev(0.06, 1.0, 1.3, st, { pos: [sx, 6.55, -3.45] }));

  // ladder: rungs + stiles, decorative — the climbable part is the volume below
  const ladder = new THREE.Group();
  for (const sx of [-0.25, 0.25]) ladder.add(part(flatBox(0.05, 6.4, 0.05), st, { pos: [sx, 3.1, -4.1] }));
  for (let i = 0; i < 17; i++) ladder.add(part(cyl(0.018, 0.018, 0.5, 5), st, { pos: [0, 0.3 + i * 0.36, -4.1], rot: [0, 0, Math.PI / 2] }));
  ladder.userData.noCollide = true;
  g.add(ladder);

  unit(g, tx, ty, tz, "water tower", 0, "children");

  // Climb volume: straddles the rung line and reaches just past the platform
  // edge, stopping 0.16 m above the deck — any higher and step-up mounts the
  // railing. Centred between the legs so the capsule never overlaps one.
  refs.climbZones.push(new THREE.Box3(
    new THREE.Vector3(tx - 0.55, ty, tz - 4.5),
    new THREE.Vector3(tx + 0.55, ty + 6.21, tz - 3.5)
  ));
}

// ═══════════════════════════ 3 · WATCHTOWER ═══════════════════════════
// Second tower on the home-base perimeter, north-east corner, covering the
// gate approach. Braced timber legs, tread-plate deck, railing, corrugated
// roof — and a spotlight fixture aimed outward. The light itself belongs to
// the other agent; the fixture position is exported below and registered with
// role "watchtower_spotlight_fixture" so it can be found at runtime.

export const WATCHTOWER_POS = { x: 4, z: -34 } as const;
export const WATCHTOWER_SPOTLIGHT_POS = {
  x: WATCHTOWER_POS.x + 1.55,
  y: heightAt(WATCHTOWER_POS.x, WATCHTOWER_POS.z) + 6.85,
  z: WATCHTOWER_POS.z + 1.55,
} as const;
/** Aim point ~12 m out, north-east, away from the compound. */
export const WATCHTOWER_SPOTLIGHT_TARGET = {
  x: WATCHTOWER_SPOTLIGHT_POS.x + 8.4,
  y: WATCHTOWER_SPOTLIGHT_POS.y - 1.8,
  z: WATCHTOWER_SPOTLIGHT_POS.z + 8.4,
} as const;

function buildWatchtower(refs: WorldRefs) {
  const { deco, unit } = makeSiteBuilder(refs);
  const tx = WATCHTOWER_POS.x, tz = WATCHTOWER_POS.z;
  const ty = heightAt(tx, tz);
  const legH = 5;
  const wood = M.wood(2);
  const st = steel();
  const g = new THREE.Group();

  for (const [lx, lz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]] as const) {
    g.add(bev(0.26, legH + 0.3, 0.26, wood, { pos: [lx, (legH + 0.3) / 2 - 0.25, lz] }));
  }
  // cross-bracing, decorative so the space under the deck stays walkable
  const braces = new THREE.Group();
  for (const sz of [-1, 1]) {
    braces.add(strut([-1.1, 0.6, sz * 1.2], [1.1, 2.3, sz * 1.2], 0.045, wood));
    braces.add(strut([1.1, 2.4, sz * 1.2], [-1.1, 4.1, sz * 1.2], 0.045, wood));
    braces.add(strut([sz * 1.2, 0.6, -1.1], [sz * 1.2, 2.3, 1.1], 0.045, wood));
    braces.add(strut([sz * 1.2, 2.4, 1.1], [sz * 1.2, 4.1, -1.1], 0.045, wood));
  }
  braces.userData.noCollide = true;
  g.add(braces);
  // knee braces from legs into the deck joists
  const knees = new THREE.Group();
  for (const [lx, lz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]] as const) {
    knees.add(strut([lx, legH - 1.0, lz], [lx * 0.4, legH - 0.05, lz * 0.4], 0.04, wood));
  }
  knees.userData.noCollide = true;
  g.add(knees);
  // deck joists (visible from below) + tread-plate platform
  const joists = new THREE.Group();
  for (let i = -1; i <= 1; i++) joists.add(part(flatBox(3.3, 0.14, 0.09), wood, { pos: [0, legH - 0.07, i * 1.1] }));
  joists.userData.noCollide = true;
  g.add(joists);
  g.add(bev(3.4, 0.14, 3.4, M.tread(), { pos: [0, legH + 0.07, 0] }));

  // Railing: posts, two rails and a kick plate per side. Each side is one
  // child, so "children" collision gives a solid barrier — an open railing
  // visually, a guard the capsule cannot slip through mechanically.
  const railSide = (len: number) => {
    const s = new THREE.Group();
    const n = Math.max(2, Math.round(len / 1.1));
    for (let i = 0; i <= n; i++) {
      s.add(part(flatBox(0.06, 1.05, 0.06), st, { pos: [-len / 2 + (i * len) / n, 0.525, 0] }));
    }
    s.add(part(flatBox(len, 0.06, 0.06), st, { pos: [0, 1.02, 0] }));
    s.add(part(flatBox(len, 0.05, 0.05), st, { pos: [0, 0.55, 0] }));
    s.add(part(flatBox(len, 0.14, 0.03), M.tread(), { pos: [0, 0.07, 0] }));
    return s;
  };
  const deckTop = legH + 0.14;
  const rN = railSide(3.4); rN.position.set(0, deckTop, 1.67); g.add(rN);
  const rS = railSide(3.4); rS.position.set(0, deckTop, -1.67); g.add(rS);
  const rW = railSide(3.4); rW.position.set(-1.67, deckTop, 0); rW.rotation.y = Math.PI / 2; g.add(rW);
  // east side split around the ladder climb-out (1.2 m gap, wider than the zone)
  const rE1 = railSide(1.1); rE1.position.set(1.67, deckTop, -1.15); rE1.rotation.y = Math.PI / 2; g.add(rE1);
  const rE2 = railSide(1.1); rE2.position.set(1.67, deckTop, 1.15); rE2.rotation.y = Math.PI / 2; g.add(rE2);

  // roof: corner posts, mono-pitch corrugated slab, fascia
  for (const [lx, lz] of [[-1.55, -1.55], [1.55, -1.55], [-1.55, 1.55], [1.55, 1.55]] as const) {
    g.add(part(flatBox(0.09, 2.2, 0.09), st, { pos: [lx, deckTop + 1.1, lz] }));
  }
  const roof = bev(3.9, 0.07, 3.9, M.corrugated(3), { pos: [0, deckTop + 2.24, 0], radius: 0.015 });
  roof.rotation.x = 0.08;
  g.add(roof);
  const fascia = part(flatBox(3.95, 0.12, 0.05), st, { pos: [0, deckTop + 2.1, 1.95] });
  fascia.userData.noCollide = true;
  g.add(fascia);

  // ladder up the east face — geometry only, climbability is the volume below
  const ladder = new THREE.Group();
  for (const sz of [-0.25, 0.25]) ladder.add(part(flatBox(0.05, 5.6, 0.05), st, { pos: [1.95, 2.55, sz] }));
  for (let i = 0; i < 15; i++) ladder.add(part(cyl(0.018, 0.018, 0.5, 5), st, { pos: [1.95, 0.3 + i * 0.36, 0], rot: [Math.PI / 2, 0, 0] }));
  ladder.userData.noCollide = true;
  g.add(ladder);

  unit(g, tx, ty, tz, "watchtower", 0, "children");

  refs.climbZones.push(new THREE.Box3(
    new THREE.Vector3(tx + 1.05, ty, tz - 0.55),
    new THREE.Vector3(tx + 2.35, ty + legH + 0.3, tz + 0.55)
  ));

  // Spotlight fixture on the NE roof post, aimed away from the compound.
  // Declared intent: it wraps its mounting post (interpenetrates) and hangs
  // below the roof's top face, which the support heuristic cannot see past
  // (unsupported) — it is bolted to the tower, not floating.
  const fixture = new THREE.Group();
  fixture.add(bev(0.07, 0.22, 0.07, dark(), { pos: [0, 0.1, 0] }));            // yoke stem
  fixture.add(part(flatBox(0.05, 0.16, 0.26), dark(), { pos: [-0.1, 0.24, 0] }));
  fixture.add(part(flatBox(0.05, 0.16, 0.26), dark(), { pos: [0.1, 0.24, 0] }));
  fixture.add(part(cyl(0.11, 0.14, 0.34, 10), dark(), { pos: [0, 0.3, 0.05], rot: [Math.PI / 2 + 0.15, 0, 0] }));
  fixture.add(part(cyl(0.115, 0.115, 0.02, 10), M.glass(), { pos: [0, 0.275, 0.225], rot: [Math.PI / 2 + 0.15, 0, 0], shadow: false }));
  fixture.add(bolts([{ pos: [0, 0.02, 0.05], rot: [Math.PI / 2, 0, 0] }], steel(), 0.014));
  fixture.rotation.y = Math.PI / 4;
  deco(fixture, WATCHTOWER_SPOTLIGHT_POS.x, WATCHTOWER_SPOTLIGHT_POS.y - 0.25, WATCHTOWER_SPOTLIGHT_POS.z);
  registerAsset("watchtower_spotlight_fixture", fixture, "AST", { unsupported: true, interpenetrates: true });
}

// ═══════════════════════════ 4 · GAS STATION RUIN ═══════════════════════════

/** Brick wall with a door opening: jambs + head, no leaf — it's a ruin. */
function ruinedDoorWall(len: number, mat: THREE.Material, horiz: boolean): THREE.Group {
  const g = new THREE.Group();
  const leftLen = (len - DOOR_W) / 2;
  const off = (len - leftLen) / 2;
  const seg = (c: number, l: number) =>
    horiz ? bev(l, H, T, mat, { pos: [c, H / 2, 0] }) : bev(T, H, l, mat, { pos: [0, H / 2, c] });
  g.add(seg(-off, leftLen), seg(off, leftLen));
  g.add(horiz
    ? bev(DOOR_W + 0.3, H - DOOR_H, T + 0.12, mat, { pos: [0, DOOR_H + (H - DOOR_H) / 2, 0] })
    : bev(T + 0.12, H - DOOR_H, DOOR_W + 0.3, mat, { pos: [0, DOOR_H + (H - DOOR_H) / 2, 0] }));
  // spalled bricks around the opening
  const chip = part(flatBox(0.24, 0.12, T + 0.06), mat, { pos: horiz ? [DOOR_W / 2 + 0.05, DOOR_H - 0.3, 0] : [0, DOOR_H - 0.3, DOOR_W / 2 + 0.05], rot: [0, 0, 0.12] });
  chip.userData.noCollide = true;
  g.add(chip);
  g.userData.aperture = { x: 0, y: DOOR_H / 2, z: 0, w: DOOR_W, h: DOOR_H, axis: horiz ? "z" : "x" };
  return g;
}

/** Brick wall with a broken window: jambs, sill, head, glass shards left. */
function ruinedWindowWall(len: number, mat: THREE.Material, horiz: boolean): THREE.Group {
  const g = new THREE.Group();
  const jamb = (len - WIN_W) / 2;
  const off = (len - jamb) / 2;
  const head = WIN_SILL + WIN_H;
  const seg = (c: number, l: number) =>
    horiz ? bev(l, H, T, mat, { pos: [c, H / 2, 0] }) : bev(T, H, l, mat, { pos: [0, H / 2, c] });
  g.add(seg(-off, jamb), seg(off, jamb));
  g.add(horiz
    ? bev(WIN_W, WIN_SILL, T, mat, { pos: [0, WIN_SILL / 2, 0] })
    : bev(T, WIN_SILL, WIN_W, mat, { pos: [0, WIN_SILL / 2, 0] }));
  g.add(horiz
    ? bev(WIN_W + 0.24, H - head, T + 0.1, mat, { pos: [0, head + (H - head) / 2, 0] })
    : bev(T + 0.1, H - head, WIN_W + 0.24, mat, { pos: [0, head + (H - head) / 2, 0] }));
  // shards still in the frame corners — dressing, never collision
  const shards = new THREE.Group();
  shards.add(part(flatBox(0.16, 0.05, 0.02), M.glass(), { pos: [-WIN_W / 2 + 0.08, head - 0.03, 0], rot: [0, 0, -0.5], shadow: false }));
  shards.add(part(flatBox(0.12, 0.05, 0.02), M.glass(), { pos: [WIN_W / 2 - 0.06, WIN_SILL + 0.03, 0], rot: [0, 0, 0.7], shadow: false }));
  if (!horiz) shards.rotation.y = Math.PI / 2;
  shards.userData.noCollide = true;
  g.add(shards);
  g.userData.aperture = { x: 0, y: WIN_SILL + WIN_H / 2, z: 0, w: WIN_W, h: WIN_H, axis: horiz ? "z" : "x" };
  return g;
}

function buildGasStation(refs: WorldRefs) {
  const { solid, deco, unit } = makeSiteBuilder(refs);
  const FLOOR = heightAt(27, -8) + 0.04;   // forecourt pad top — the site datum
  const K = FLOOR + 0.06;                  // kiosk floor slab top
  const brick = M.brick(3);
  const concrete = M.concrete(3);
  const paint = M.painted(2);
  const dk = dark();
  const st = steel();

  // forecourt: patched asphalt apron between the highway and the kiosk
  solid(16, 0.08, 14, M.asphalt(4), 27, FLOOR - 0.08, -8, "forecourt pad", { collide: false });

  // kiosk: 6 x 4 m brick shell, doorway west to the pumps, broken windows N/S
  solid(6.1, 0.06, 4.1, concrete, 31, FLOOR, -8, "kiosk floor", { collide: false });
  unit(ruinedDoorWall(4, brick, false), 28, K, -8, "kiosk wall", 0, "children");
  unit(ruinedWindowWall(6, brick, true), 31, K, -10, "kiosk wall", 0, "children");
  unit(ruinedWindowWall(6, brick, true), 31, K, -6, "kiosk wall", 0, "children");
  solid(T, H, 4, brick, 34, K, -8, "kiosk wall");
  // damaged flat roof: two slabs, the south-west bay is gone
  solid(6.5, 0.16, 2.8, concrete, 31, K + H, -8.9, "kiosk roof", { collide: false });
  solid(2.6, 0.16, 1.8, concrete, 32.7, K + H, -6.7, "kiosk roof", { collide: false });
  // fallen door leaf, exposed rebar at the break, interior rubble
  deco(part(flatBox(DOOR_W - 0.06, DOOR_H - 0.08, 0.05), M.wood(1.5), { pos: [29.2, K + 0.06, -7.2], rot: [-Math.PI / 2 + 0.12, 0.4, 0] }));
  for (let i = 0; i < 4; i++) {
    deco(part(cyl(0.012, 0.012, 0.5, 5), st, { pos: [29 + i * 0.5, K + H - 0.02, -6.6], rot: [0.5 + i * 0.2, 0, 0.3] }));
  }
  {
    const rubble = new THREE.Group();
    const rr = makeRng(31007);
    for (let i = 0; i < 7; i++) {
      rubble.add(bev(0.25 + rr() * 0.45, 0.14 + rr() * 0.2, 0.25 + rr() * 0.4, concrete, {
        pos: [(rr() - 0.5) * 1.6, 0.1 + rr() * 0.12, (rr() - 0.5) * 1.4], rot: [rr(), rr() * 3, rr() * 0.6],
      }));
    }
    unit(rubble, 32.6, K, -8.6, "kiosk rubble", 0, false, { belowGrade: true, interpenetrates: true });
  }

  // pump island with two period pumps: body, dial glass, hose, nozzle, bolts
  solid(4.6, 0.18, 1.6, concrete, 24, FLOOR, -8, "pump island");
  const pump = (px: number, ry: number) => {
    const g = new THREE.Group();
    g.add(bev(0.7, 0.12, 0.55, dk, { pos: [0, 0.06, 0] }));
    g.add(bev(0.62, 1.3, 0.46, paint, { pos: [0, 0.77, 0], radius: 0.03 }));
    g.add(bev(0.66, 0.08, 0.5, dk, { pos: [0, 1.46, 0] }));
    g.add(part(flatBox(0.4, 0.44, 0.02), dk, { pos: [0, 1.02, 0.24] }));
    g.add(part(cyl(0.09, 0.09, 0.025, 12), M.glass(), { pos: [0, 1.1, 0.25], rot: [Math.PI / 2, 0, 0], shadow: false }));
    for (let i = 0; i < 3; i++) g.add(part(flatBox(0.08, 0.1, 0.02), st, { pos: [-0.11 + i * 0.11, 0.92, 0.25], shadow: false }));
    // hose: loop on the flank, nozzle in its boot
    const hose = part(new THREE.TorusGeometry(0.3, 0.024, 6, 12, Math.PI * 1.35), dk, { pos: [-0.34, 0.95, 0], rot: [0, Math.PI / 2, 0.4] });
    hose.userData.noCollide = true;
    g.add(hose);
    g.add(bev(0.05, 0.2, 0.08, dk, { pos: [-0.35, 0.62, 0.12], radius: 0.015 }));
    g.add(bolts([{ pos: [0.26, 0.13, 0.2] }, { pos: [-0.26, 0.13, 0.2] }, { pos: [0.26, 0.13, -0.2] }, { pos: [-0.26, 0.13, -0.2] }], st, 0.013));
    unit(g, px, FLOOR + 0.18, -8, "fuel pump", ry, true);
  };
  pump(23.05, 0);
  pump(24.95, Math.PI);

  // flat canopy on four columns over the island
  for (const [cx, cz] of [[21.6, -10.4], [26.4, -10.4], [21.6, -5.6], [26.4, -5.6]] as const) {
    solid(0.62, 0.3, 0.62, concrete, cx, FLOOR - 0.12, cz, "canopy footing");
    solid(0.26, 4.2, 0.26, paint, cx, FLOOR, cz, "canopy column");
  }
  solid(8.8, 0.3, 6.8, M.corrugated(3), 24, FLOOR + 4.2, -8, "canopy roof", { collide: false });
  for (const sz of [-1, 1]) deco(part(flatBox(8.9, 0.22, 0.05), dk, { pos: [24, FLOOR + 4.32, -8 + sz * 3.42] }));
  for (const sx of [-1, 1]) deco(part(flatBox(0.05, 0.22, 6.9), dk, { pos: [24 + sx * 4.42, FLOOR + 4.32, -8] }));

  // leaning price-sign pylon by the road
  {
    const py = heightAt(18, -2);
    const g = new THREE.Group();
    g.add(bev(0.7, 0.5, 0.7, concrete, { pos: [0, 0.13, 0] })); // sunk base block
    g.add(bev(0.2, 4.6, 0.2, paint, { pos: [0, 2.05, 0] }));
    g.add(bev(1.9, 1.4, 0.1, paint, { pos: [0, 3.7, 0], radius: 0.02 }));
    g.add(part(flatBox(2.0, 0.08, 0.14), dk, { pos: [0, 4.42, 0] }));
    for (let i = 0; i < 3; i++) g.add(part(flatBox(0.34, 0.5, 0.03), dk, { pos: [-0.55 + i * 0.55, 3.55, 0.06], shadow: false }));
    g.rotation.z = 0.08;   // the lean — frost heave got it decades ago
    g.rotation.x = -0.05;
    unit(g, 18, py, -2, "price sign pylon", 0.9, true);
  }
}

// ═══════════════════════════ 5 · SCRAP MAGNET CRANE ═══════════════════════════
// Tracked salvage crane parked in the container yard, boom swung over the open
// sorting ground north-west of the stacks, disc magnet hanging at head height.
// Static: world.ts has no per-frame hook (engine owns the loop), so no sway.

function buildCrane(refs: WorldRefs) {
  const { unit } = makeSiteBuilder(refs);
  const cx = 34, cz = -23;
  const cy = heightAt(cx, cz);
  // boom toward (28, -20): open yard, clear of the container stacks
  const yaw = Math.atan2(28 - cx, -20 - cz);
  const dk = dark();
  const st = steel();
  const g = new THREE.Group();

  // tracked base: frame, sprocket, idler, rollers, top-run pads
  for (const sz of [-1, 1]) {
    const track = new THREE.Group();
    track.add(bev(4.6, 0.7, 0.8, dk, { pos: [0, 0.5, 0], radius: 0.06 }));
    track.add(part(cyl(0.4, 0.4, 0.84, 12), st, { pos: [2.05, 0.45, 0], rot: [Math.PI / 2, 0, 0] }));
    track.add(part(cyl(0.34, 0.34, 0.84, 12), st, { pos: [-2.05, 0.42, 0], rot: [Math.PI / 2, 0, 0] }));
    for (let i = 0; i < 4; i++) track.add(part(cyl(0.24, 0.24, 0.78, 10), dk, { pos: [-1.2 + i * 0.8, 0.3, 0], rot: [Math.PI / 2, 0, 0] }));
    const pads: Placement[] = [];
    for (let i = 0; i < 11; i++) pads.push({ pos: [-2.1 + i * 0.42, 0.89, 0] });
    track.add(instancedPlaces(flatBox(0.34, 0.07, 0.86), st, pads));
    track.position.set(0, 0, sz * 1.05);
    g.add(track);
  }
  // rotating deck
  g.add(bev(4.0, 0.3, 3.0, M.tread(), { pos: [0, 1.05, 0] }));
  // operator cab, facing the boom (+z local)
  const cab = new THREE.Group();
  cab.add(bev(1.9, 1.75, 1.6, M.corrugated(2), { pos: [0, 0.875, 0], radius: 0.03 }));
  cab.add(part(flatBox(1.2, 0.7, 0.02), M.glass(), { pos: [0, 1.15, 0.81], shadow: false }));
  cab.add(part(flatBox(0.7, 1.3, 0.03), M.corrugated(2), { pos: [0.96, 0.85, -0.2] }));
  cab.add(part(flatBox(0.05, 0.12, 0.05), st, { pos: [1.0, 0.8, 0.05] }));
  cab.add(bev(2.0, 0.08, 1.7, dk, { pos: [0, 1.79, 0] }));
  cab.add(part(cyl(0.05, 0.05, 0.5, 8), dk, { pos: [-0.6, 2.0, -0.5] }));
  cab.add(bolts(along([-0.8, 0.15, 0.81], [0.8, 0.15, 0.81], 6, [Math.PI / 2, 0, 0]), st, 0.012));
  cab.position.set(0.9, 1.2, -0.4);
  g.add(cab);
  // counterweight
  g.add(bev(1.5, 1.1, 2.5, M.painted(3), { pos: [-1.7, 1.75, 0], radius: 0.04 }));
  // gantry + backstays
  const gantry = new THREE.Group();
  gantry.add(strut([-1.3, 1.2, -0.9], [-0.9, 3.7, -0.2], 0.05, st));
  gantry.add(strut([-1.3, 1.2, 0.5], [-0.9, 3.7, -0.2], 0.05, st));
  gantry.add(strut([-0.9, 3.7, -0.2], [0.9, 6.2, 4.2], 0.014, dk));
  gantry.add(strut([-0.9, 3.7, -0.2], [0.9, 4.65, 2.9], 0.014, dk));
  // Same failure law as the boom: a diagonal group's AABB fences off the deck.
  gantry.userData.noCollide = true;
  g.add(gantry);
  // boom foot pedestal
  g.add(bev(0.7, 0.75, 0.7, dk, { pos: [0.9, 1.55, 0.8] }));

  // lattice boom — tagged noCollide: its axis-aligned box would stretch from
  // the deck to the tip and fence off the whole working side of the crane.
  const boom = new THREE.Group();
  for (const [lx, ly] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]] as const) {
    boom.add(part(flatBox(0.09, 0.09, 9.8), dk, { pos: [lx, ly, 4.9] }));
  }
  for (let i = 0; i < 15; i++) {
    const z0 = 0.3 + i * 0.65;
    boom.add(part(flatBox(0.68, 0.05, 0.05), st, { pos: [0, 0.3, z0], shadow: false }));
    boom.add(part(flatBox(0.68, 0.05, 0.05), st, { pos: [0, -0.3, z0], shadow: false }));
    boom.add(part(flatBox(0.05, 0.68, 0.05), st, { pos: [0.3, 0, z0], shadow: false }));
    boom.add(part(flatBox(0.05, 0.68, 0.05), st, { pos: [-0.3, 0, z0], shadow: false }));
    boom.add(part(flatBox(0.05, 0.05, 0.82), st, { pos: [i % 2 ? 0.15 : -0.15, 0.3, z0 + 0.32], rot: [0, i % 2 ? 0.72 : -0.72, 0], shadow: false }));
  }
  boom.add(bev(0.5, 0.42, 0.5, dk, { pos: [0, 0, 9.7] }));
  boom.add(part(cyl(0.16, 0.16, 0.2, 10), st, { pos: [0, 0, 9.55], rot: [0, 0, Math.PI / 2] }));
  boom.position.set(0.9, 1.9, 0.8);
  boom.rotation.x = -0.9;
  boom.userData.noCollide = true;
  g.add(boom);

  // hoist cable + disc magnet, vertical in crane space (yaw-only parent)
  const tipY = 1.9 + Math.sin(0.9) * 9.7, tipZ = 0.8 + Math.cos(0.9) * 9.7;
  const cable = part(cyl(0.016, 0.016, tipY - 2.15, 6), dk, { pos: [0.9, (tipY + 2.15) / 2, tipZ] });
  cable.userData.noCollide = true;
  g.add(cable);
  const magnet = new THREE.Group();
  magnet.add(part(cyl(0.7, 0.62, 0.3, 18), dk, { pos: [0, 0, 0] }));
  magnet.add(part(cyl(0.72, 0.72, 0.08, 18), st, { pos: [0, 0.19, 0] }));
  magnet.add(bev(0.16, 0.22, 0.1, st, { pos: [0, 0.34, 0] }));
  magnet.position.set(0.9, 2.0, tipZ);
  g.add(magnet);

  unit(g, cx, cy, cz, "scrap crane", yaw, "children");
}

// ═══════════════════════════ 6 · DETAIL PROPS ═══════════════════════════
// Own RNG stream (seed 20240) so the original scatter sequence is untouched.
// Sites were checked against the seeded scatter: nothing here shares ground
// with an existing prop.

function billboard(unit: ReturnType<typeof makeSiteBuilder>["unit"], x: number, z: number, ry: number) {
  const y = heightAt(x, z);
  const wood = M.wood(2);
  const paint = M.painted(3);
  const dk = dark();
  const g = new THREE.Group();
  for (const sx of [-1.5, 1.5]) g.add(bev(0.16, 3.8, 0.16, wood, { pos: [sx, 1.65, 0] })); // posts, sunk 0.25
  const panel = new THREE.Group();
  panel.add(part(flatBox(3.8, 1.9, 0.05), paint, { pos: [0, 2.6, 0.06] }));
  for (const sy of [1.7, 3.5]) panel.add(part(flatBox(3.85, 0.12, 0.08), wood, { pos: [0, sy, 0.04] }));
  for (const sx of [-1.85, 0, 1.85]) panel.add(part(flatBox(0.1, 1.9, 0.07), wood, { pos: [sx, 2.6, 0.03] }));
  panel.add(part(flatBox(1.1, 0.5, 0.02), dk, { pos: [-0.8, 2.75, 0.1], shadow: false })); // peeling ad remnant
  g.add(panel);
  const brace = new THREE.Group();
  brace.add(strut([-1.5, 0.4, -0.9], [-1.5, 2.4, -0.02], 0.05, wood));
  brace.add(strut([1.5, 0.4, -0.9], [1.5, 2.4, -0.02], 0.05, wood));
  brace.userData.noCollide = true;
  g.add(brace);
  g.rotation.z = 0.05;   // leaning
  g.rotation.x = -0.04;
  // posts are footings — sunk on purpose
  unit(g, x, y, z, "billboard", ry, "children", { belowGrade: true });
}

function tireStack(unit: ReturnType<typeof makeSiteBuilder>["unit"], rng: () => number, x: number, z: number) {
  const y = heightAt(x, z);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    g.add(part(new THREE.TorusGeometry(0.38, 0.15, 10, 18), M.tyre(), {
      pos: [(rng() - 0.5) * 0.14, 0.16 + i * 0.27, (rng() - 0.5) * 0.14],
      rot: [Math.PI / 2 + (rng() - 0.5) * 0.14, 0, rng() * Math.PI],
    }));
  }
  unit(g, x, y, z, "tire stack", rng() * Math.PI, true, { interpenetrates: true });
}

function palletPile(unit: ReturnType<typeof makeSiteBuilder>["unit"], rng: () => number, x: number, z: number) {
  const y = heightAt(x, z);
  const wood = M.wood(1.5);
  const g = new THREE.Group();
  const n = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) {
    const p = new THREE.Group();
    for (let s = 0; s < 6; s++) p.add(part(flatBox(1.2, 0.022, 0.1), wood, { pos: [0, 0.135, -0.4 + s * 0.16] }));
    for (const bx of [-0.5, 0, 0.5]) p.add(part(flatBox(0.1, 0.075, 1.0), wood, { pos: [bx, 0.08, 0] }));
    for (const bx of [-0.5, 0, 0.5]) for (const bz of [-0.44, 0, 0.44]) {
      p.add(part(flatBox(0.1, 0.08, 0.1), wood, { pos: [bx, 0.04, bz] }));
    }
    p.position.set((rng() - 0.5) * 0.2, i * 0.15, (rng() - 0.5) * 0.2);
    p.rotation.y = (rng() - 0.5) * 0.5;
    g.add(p);
  }
  unit(g, x, y, z, "pallet pile", 0, true, { interpenetrates: true });
}

function drumCluster(unit: ReturnType<typeof makeSiteBuilder>["unit"], rng: () => number, x: number, z: number, groundY?: number) {
  const y = groundY ?? heightAt(x, z);
  const g = new THREE.Group();
  const dk = dark();
  const st = steel();
  const drum = (dx: number, dz: number, tipped: boolean) => {
    const d = new THREE.Group();
    d.add(part(cyl(0.29, 0.29, 0.88, 14), M.drum(), { pos: [0, 0.44, 0] }));
    for (const hy of [0.28, 0.60]) d.add(part(cyl(0.305, 0.305, 0.05, 14), M.drum(), { pos: [0, hy, 0] }));
    d.add(part(cyl(0.30, 0.30, 0.03, 14), dk, { pos: [0, 0.885, 0] }));
    d.add(part(cyl(0.045, 0.045, 0.025, 6), st, { pos: [0.16, 0.90, 0] }));
    d.position.set(dx, 0, dz);
    if (tipped) {
      d.rotation.z = Math.PI / 2;
      d.position.y = 0.3;
      d.rotation.y = rng() * Math.PI;
    }
    g.add(d);
  };
  const n = 3 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.6;
    drum(Math.cos(a) * 0.55, Math.sin(a) * 0.55, false);
  }
  drum(1.05, 0.4, true); // one knocked over
  unit(g, x, y, z, "oil drum cluster", rng() * Math.PI, true, { interpenetrates: true });
}

function tarpedCrates(unit: ReturnType<typeof makeSiteBuilder>["unit"], rng: () => number, x: number, z: number) {
  const y = heightAt(x, z);
  const wood = M.wood(1.5);
  const dk = dark();
  const g = new THREE.Group();
  // three crates in an L, one on top
  g.add(bev(1.0, 1.0, 1.0, wood, { pos: [-0.52, 0.5, 0] }));
  g.add(bev(1.0, 1.0, 1.0, wood, { pos: [0.52, 0.5, 0.12] }));
  g.add(bev(1.0, 1.0, 1.0, wood, { pos: [-0.45, 0.5, 1.05] }));
  g.add(bev(0.9, 0.9, 0.9, wood, { pos: [-0.15, 1.45, 0.3], radius: 0.02 }));
  // tarp draped over the lot, tied down with a rope run
  g.add(bev(2.5, 1.75, 2.3, M.tarp(), { pos: [-0.1, 0.95, 0.45], radius: 0.3 }));
  g.add(part(cyl(0.015, 0.015, 2.6, 5), dk, { pos: [-0.1, 1.1, 0.45], rot: [0, 0, Math.PI / 2] }));
  unit(g, x, y, z, "tarped crates", rng() * Math.PI, true, { interpenetrates: true });
}

// ═══════════════════════════ entry point ═══════════════════════════

export function buildIndustrial(refs: WorldRefs): void {
  const { unit } = makeSiteBuilder(refs);
  const rng = makeRng(20240);

  buildRailway(refs);
  buildWaterTower(refs);
  buildWatchtower(refs);
  buildGasStation(refs);
  buildCrane(refs);

  // detail props — billboards lean over the highway, the rest cluster around
  // the new sites where work would have left them
  billboard(unit, 21, 34, -0.35);
  billboard(unit, 7.5, -70, 1.5);
  tireStack(unit, rng, 24.5, 0.5);
  tireStack(unit, rng, -30, 67);
  tireStack(unit, rng, 24.2, -22);
  palletPile(unit, rng, -14, 68);
  palletPile(unit, rng, 30, 0.5);
  palletPile(unit, rng, -2, -30);
  drumCluster(unit, rng, 6.5, 67.5);
  drumCluster(unit, rng, 32, -13.5, heightAt(27, -8) + 0.04); // on the forecourt pad
  drumCluster(unit, rng, 42, -24);
  tarpedCrates(unit, rng, -40, 68);
  tarpedCrates(unit, rng, 20.5, -16.5);
  tarpedCrates(unit, rng, 7, -31);
}
