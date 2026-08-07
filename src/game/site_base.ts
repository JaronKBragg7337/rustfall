// Base upgrades (Batch 3, items 19–20) + the salvager's workbench.
//
//   · WORKBENCH — a proper outdoor bench beside the Homestead's front wall:
//     heavy timber top (IND03) on steel trestles (MET01), bench vice, tool
//     board with hanging tools, parts bin, instanced bolts. Registered with
//     role "workbench" — the crafting interaction looks that role up in the
//     asset registry (same pattern as the watchtower spotlight fixture). This
//     build is called BEFORE buildHomestead so a registry.find() lands on this
//     bench and not on the small interior workshop bench the house builds.
//   · ROOFTOP GARDEN (item 19) — raised planters (IND03 frames, TER01 soil) on
//     the Homestead's flat roof, instanced crop tufts, a scarecrow, pallet-
//     wood plank paths, and a new east-face ladder + eave platform so the roof
//     is genuinely reachable. Nothing blocks an existing aperture, the
//     interior stair, or the chimney.
//   · RAIN CATCHER (item 19) — gutter on the east gable eave (the one eave the
//     original build left bare; separate trim geometry like the homestead's
//     own gutters), a downpipe into a raised corrugated tank (IND01) on a
//     timber stand, tap + hose bib, overflow pipe, instanced rivets.
//   · TRADING POST (item 20) — NPC camp south of the boxcars on the railway
//     siding: stall with canvas awning (IND09), counter, goods display,
//     emissive lantern string, campfire ring with log seats, a hand-painted
//     TRADE sign (geometry, not a texture), and three prop clusters. Kept
//     clear of the rail bed (z 69.8–74.2) and the boxcar door tracks.
//
// Same assembly rules as world.ts / site_industrial.ts / site_wash.ts:
// primary → secondary → tertiary → instanced micro detail; real dimensions;
// grounding through terrain.heightAt(); collision carved per child. Random
// jitter draws from its own stream (makeRng 41771) so every existing RNG
// sequence is untouched.
import * as THREE from "./three";
import { registerAsset, makeRng, type AssetFlags } from "./constants";
import { matOf } from "./textures";
import { plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, rivets, gutter, type Placement } from "./kit";
import { heightAt } from "./terrain";
import type { WorldRefs } from "./world";

// Homestead geometry, restated from buildHomestead (world.ts): the garden and
// the rain catcher are built onto that house, so the numbers live here too.
const HX = 30, HZ = 44;            // house centre
// roofY = y0 + 3.0 (storey) + 0.2 (slab) + 2.6 (upper wall); slab 0.16 thick,
// corrugation ribs crown 0.055 above the slab top — garden pieces bed on them.
const ROOF_RISE = 3.0 + 0.2 + 2.6; // eave line above grade: y0 + 5.8
const SLAB_T = 0.16;
const RIB_H = 0.055;

/** The crafting interaction finds this asset by role — keep them in sync. */
export const WORKBENCH_POS = { x: 25.5, z: 38.6 } as const;

const steel = () => plain(0x55524d, 0.44, 0.85);
const dark = () => plain(0x34322f, 0.58, 0.8);

// ─────────────────────────── placement helpers ───────────────────────────
// Same contract as makeSiteBuilder in site_industrial.ts.
function makeSiteBuilder(refs: WorldRefs) {
  const deco = (o: THREE.Object3D, x?: number, y?: number, z?: number): THREE.Object3D => {
    if (x !== undefined) o.position.set(x, y!, z!);
    refs.scene.add(o);
    return o;
  };

  // "children": each structural child gets its own collider; subtrees tagged
  // userData.noCollide (awnings, tools, flames) never become invisible snags.
  const unit = (
    g: THREE.Group, x: number, y: number, z: number, role: string,
    ry = 0, collide: boolean | "children" = true, flags: AssetFlags = {}
  ) => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    refs.scene.add(g);
    registerAsset(role, g, "AST", flags);
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

  return { deco, unit };
}

/** Cylinder between two points — braces, wires, stays. */
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

// ═══════════════════════════ 1 · SALVAGER'S WORKBENCH ═══════════════════════════
// 1.8 x 0.75 m top at a real bench height of 0.9 m, against the Homestead's
// front wall, 0.6 m clear of the door aperture's swing line. Collision is per
// child: top, trestles and shelf are solid; everything above the top (vice,
// tools, bin) is tagged noCollide — the 0.9 m top already blocks the capsule,
// and small head-height boxes would only be invisible snags.

function buildWorkbench(refs: WorldRefs) {
  const { unit } = makeSiteBuilder(refs);
  const wx = WORKBENCH_POS.x, wz = WORKBENCH_POS.z;
  const wy = heightAt(wx, wz); // on the homestead pad — level by construction
  const wood = matOf("IND03", 2);    // heavy weathered timber
  const plate = matOf("MET01", 1.5); // rusted plate steel trestles
  const ply = matOf("STR08", 1.5);   // tool board
  const st = steel();
  const dk = dark();
  const g = new THREE.Group();

  // ── primary: the bench top, working face at exactly 0.9 m ──
  g.add(bev(1.8, 0.07, 0.75, wood, { pos: [0, 0.865, 0], radius: 0.012 }));
  // aprons under both long edges — the top reads as a built assembly, not a slab
  for (const sz of [-1, 1]) g.add(part(flatBox(1.7, 0.11, 0.05), wood, { pos: [0, 0.775, sz * 0.35] }));

  // ── secondary: two steel trestles, splayed legs, foot pads, bearers ──
  for (const sx of [-0.72, 0.72]) {
    for (const sz of [-1, 1]) {
      const leg = part(flatBox(0.07, 0.86, 0.07), plate, { pos: [sx, 0.415, sz * 0.26] });
      leg.rotation.x = sz * 0.12; // splay: feet wider than the bearer
      g.add(leg);
      g.add(part(flatBox(0.16, 0.05, 0.16), plate, { pos: [sx, 0.025, sz * 0.31] }));
    }
    g.add(part(flatBox(0.07, 0.07, 0.62), plate, { pos: [sx, 0.795, 0] }));  // top bearer
    g.add(part(flatBox(0.05, 0.05, 0.66), plate, { pos: [sx, 0.32, 0] }));   // cross rail
  }
  // lower shelf between the trestles, resting on the cross rails
  g.add(part(flatBox(1.5, 0.04, 0.5), wood, { pos: [0, 0.36, 0] }));

  // ── tertiary: everything on or above the top is one noCollide accessory ──
  const acc = new THREE.Group();
  acc.userData.noCollide = true;

  // bench vice at the east end: base, fixed + sliding jaws, jaw faces, screw
  acc.add(bev(0.2, 0.05, 0.24, dk, { pos: [0.68, 0.925, 0.12] }));
  acc.add(bev(0.05, 0.15, 0.22, dk, { pos: [0.78, 0.975, 0.12] }));        // fixed jaw
  acc.add(bev(0.05, 0.13, 0.22, dk, { pos: [0.6, 0.965, 0.12] }));         // sliding jaw
  acc.add(part(flatBox(0.015, 0.06, 0.2), st, { pos: [0.752, 1.02, 0.12] }));
  acc.add(part(flatBox(0.015, 0.06, 0.2), st, { pos: [0.628, 1.02, 0.12] }));
  acc.add(part(cyl(0.018, 0.018, 0.2, 8), st, { pos: [0.68, 0.94, 0.12], rot: [0, 0, Math.PI / 2] }));
  acc.add(part(cyl(0.01, 0.01, 0.2, 6), st, { pos: [0.56, 0.94, 0.12], rot: [Math.PI / 2, 0, 0] })); // T-handle

  // tool board on the house-side edge: posts, ply panel, pegs, hanging tools
  for (const sx of [-0.78, 0.78]) acc.add(part(flatBox(0.05, 0.75, 0.05), wood, { pos: [sx, 1.27, 0.33] }));
  acc.add(part(flatBox(1.66, 0.55, 0.03), ply, { pos: [0, 1.32, 0.345] }));
  // tool silhouettes from kit primitives, on the user (-z) face of the board
  const tool = (o: THREE.BufferGeometry, x: number, y: number) =>
    acc.add(part(o, st, { pos: [x, y, 0.315], shadow: false }));
  // two hammers: handle + head
  tool(flatBox(0.028, 0.26, 0.022), -0.55, 1.28);
  tool(flatBox(0.1, 0.045, 0.04), -0.55, 1.43);
  tool(flatBox(0.026, 0.24, 0.022), -0.25, 1.26);
  tool(flatBox(0.09, 0.04, 0.04), -0.25, 1.4);
  // two wrenches: shaft + open jaw block
  tool(flatBox(0.03, 0.26, 0.016), 0.05, 1.28);
  tool(flatBox(0.085, 0.04, 0.016), 0.05, 1.42);
  tool(flatBox(0.028, 0.22, 0.016), 0.3, 1.26);
  tool(flatBox(0.075, 0.036, 0.016), 0.3, 1.38);
  // a level with a pale vial
  tool(flatBox(0.3, 0.045, 0.022), 0.62, 1.3);
  acc.add(part(flatBox(0.03, 0.02, 0.024), plain(0xc8d8c9, 0.4, 0.05), { pos: [0.62, 1.3, 0.315], shadow: false }));
  // pegs above each tool
  for (const px of [-0.55, -0.25, 0.05, 0.3, 0.62]) {
    acc.add(part(cyl(0.008, 0.008, 0.05, 5), dk, { pos: [px, 1.52, 0.315], rot: [Math.PI / 2, 0, 0], shadow: false }));
  }

  // parts bin at the west end: tray, walls, divider, a few small parts
  acc.add(part(flatBox(0.42, 0.03, 0.3), wood, { pos: [-0.62, 0.915, 0.08] }));
  for (const sz of [-1, 1]) acc.add(part(flatBox(0.42, 0.08, 0.02), wood, { pos: [-0.62, 0.96, 0.08 + sz * 0.14] }));
  for (const sx of [-1, 1]) acc.add(part(flatBox(0.02, 0.08, 0.26), wood, { pos: [-0.62 + sx * 0.2, 0.96, 0.08] }));
  acc.add(part(flatBox(0.02, 0.07, 0.26), wood, { pos: [-0.62, 0.955, 0.08] }));
  acc.add(part(cyl(0.035, 0.035, 0.02, 8), st, { pos: [-0.72, 0.94, 0.02] }));
  acc.add(part(cyl(0.028, 0.028, 0.03, 6), dk, { pos: [-0.52, 0.945, 0.16] }));
  acc.add(part(flatBox(0.06, 0.025, 0.04), st, { pos: [-0.7, 0.945, 0.17] }));
  g.add(acc);

  // ── micro: instanced assembly bolts (tagged: no sparse collider boxes) ──
  const bl: Placement[] = [];
  for (const sx of [-0.72, 0.72]) for (const sz of [-0.2, 0.2]) {
    bl.push({ pos: [sx, 0.835, sz], rot: [0, 0, 0] });            // bearer → top, heads up
  }
  for (const bx of [0.6, 0.76]) for (const bz of [0.02, 0.22]) {
    bl.push({ pos: [bx, 0.905, bz], rot: [0, 0, 0] });            // vice mount
  }
  const boltMesh = bolts(bl, st, 0.013);
  boltMesh.userData.noCollide = true;
  g.add(boltMesh);

  // Role is the contract: the crafting station lookup finds exactly this.
  unit(g, wx, wy, wz, "workbench", 0, "children");
}

// ═══════════════════════════ 2 · ROOFTOP GARDEN ═══════════════════════════
// Four raised beds on the flat roof slab, 2.4 x 1.2 m — narrow enough to reach
// the middle from either side — with a plank path between the rows and a spur
// to the ladder platform. Crops are instanced tufts; the scarecrow is CRV05
// canvas on an IND03 frame. Everything beds on the corrugation ribs, which is
// what "grounded" means on a corrugated roof.

function buildRoofGarden(refs: WorldRefs, rng: () => number) {
  const { deco, unit } = makeSiteBuilder(refs);
  const y0 = heightAt(HX, HZ);
  const roofTop = y0 + ROOF_RISE + SLAB_T;   // walk surface of the roof slab
  const base = roofTop + RIB_H - 0.005;      // bed/plant bases ride the rib crowns
  const wood = matOf("IND03", 1.5);
  const soil = matOf("TER01", 1);
  const crop = plain(0x5d7c30, 0.9, 0);      // same crop green as the farm plots
  const canvas = matOf("CRV05", 1.2);
  const dk = dark();

  // beds: two rows of two, 0.6+ m off every roof edge, clear of the chimney
  // (34.6, 46.6) and of the ladder exit path along z ≈ 45.9–46.3
  const beds: Array<[number, number]> = [[27.6, 42.3], [30.4, 42.3], [27.6, 45.0], [30.4, 45.0]];
  const tuftGeo = cyl(0.015, 0.045, 0.2, 5);
  const tufts: Placement[] = [];
  for (const [bx, bz] of beds) {
    const bed = new THREE.Group();
    // side boards + corner posts + cap rails — an assembled box, not a slab
    for (const [ox, oz, w, d] of [[0, -0.575, 2.4, 0.05], [0, 0.575, 2.4, 0.05], [-1.175, 0, 0.05, 1.1], [1.175, 0, 0.05, 1.1]] as const) {
      bed.add(part(flatBox(w, 0.3, d), wood, { pos: [ox, 0.15, oz] }));
    }
    for (const [cx, cz] of [[-1.175, -0.575], [1.175, -0.575], [-1.175, 0.575], [1.175, 0.575]] as const) {
      bed.add(part(flatBox(0.08, 0.38, 0.08), wood, { pos: [cx, 0.19, cz] }));
    }
    for (const sz of [-1, 1]) bed.add(part(flatBox(2.45, 0.045, 0.1), wood, { pos: [0, 0.322, sz * 0.575] }));
    // soil fill, 40 mm below the cap rail
    bed.add(part(flatBox(2.3, 0.24, 1.06), soil, { pos: [0, 0.14, 0], shadow: false }));
    unit(bed, bx, base, bz, "planter bed", 0, true);

    // sprouting rows — instanced, with a seeded jitter so no two beds match
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 8; c++) {
        tufts.push({
          pos: [bx - 0.95 + c * 0.27 + (rng() - 0.5) * 0.06, base + 0.26 + 0.09, bz - 0.35 + r * 0.35 + (rng() - 0.5) * 0.06],
          rot: [(rng() - 0.5) * 0.3, rng() * 3, (rng() - 0.5) * 0.3],
        });
      }
    }
  }
  deco(instancedPlaces(tuftGeo, crop, tufts));

  // pallet-wood plank paths: between the rows, and from the ladder exit west
  const planks: Placement[] = [];
  for (let i = 0; i < 7; i++) planks.push({ pos: [26.6 + i * 0.82, roofTop + RIB_H + 0.0125, 43.65] });
  for (let i = 0; i < 5; i++) planks.push({ pos: [32.4 + i * 0.82, roofTop + RIB_H + 0.0125, 45.9] });
  deco(instancedPlaces(flatBox(0.8, 0.025, 0.14), wood, planks));

  // scarecrow guarding the beds: pole, crossarm, canvas tunic, burlap head, hat
  const sc = new THREE.Group();
  sc.add(part(flatBox(0.06, 1.75, 0.06), wood, { pos: [0, 0.875, 0] }));
  sc.add(part(flatBox(1.15, 0.05, 0.05), wood, { pos: [0, 1.32, 0] }));
  sc.add(bev(0.46, 0.6, 0.16, canvas, { pos: [0, 1.06, 0], radius: 0.05 }));
  sc.add(part(cyl(0.12, 0.15, 0.26, 8), matOf("CRV06", 1), { pos: [0, 1.52, 0] }));
  const straw = plain(0xb89a55, 0.95, 0);
  for (const sx of [-0.55, 0.55]) {
    sc.add(part(cyl(0.05, 0.02, 0.12, 6), straw, { pos: [sx, 1.28, 0], rot: [0, 0, sx > 0 ? -1.35 : 1.35] }));
  }
  sc.add(part(cyl(0.21, 0.21, 0.025, 10), dk, { pos: [0, 1.66, 0] }));
  sc.add(part(cyl(0.09, 0.12, 0.13, 8), dk, { pos: [0, 1.73, 0] }));
  unit(sc, 32.8, base, 44.3, "scarecrow", 0.5, false);

  // ── roof access: east-face ladder + eave platform ──
  // The roof had no access at all; without this the garden is a diorama. The
  // platform juts 0.9 m from the east wall at z 46.65–47.65 — north of the
  // seeded debris cluster at (36.9, 44.6), south of the corner quoins, clear
  // of the new gutter (z 40.0–44.4), the chimney, and every window (the east
  // face has none). Its top is flush with the roof walk surface.
  const plat = new THREE.Group();
  plat.add(bev(0.9, 0.06, 1.0, matOf("IND08", 1.5), { pos: [0.45, ROOF_RISE + SLAB_T - 0.03, 0] }));
  const braces = new THREE.Group();
  braces.userData.noCollide = true;
  for (const sz of [-0.35, 0.35]) {
    braces.add(strut([0.85, ROOF_RISE + SLAB_T - 0.1, sz], [0.06, ROOF_RISE + SLAB_T - 1.0, sz], 0.035, steel()));
  }
  plat.add(braces);
  // Bracketed to the wall face; no registered support touches its footprint,
  // so it declares the intent rather than tripping the floating check.
  unit(plat, 36.1, y0, 47.15, "roof access platform", 0, "children", { unsupported: true });

  // ladder: stiles + rungs are dressing; the climbable part is the volume.
  const ladder = new THREE.Group();
  for (const sz of [-0.26, 0.26]) ladder.add(part(flatBox(0.05, 6.1, 0.05), steel(), { pos: [37.1, 3.0, 47.15 + sz] }));
  for (let i = 0; i < 16; i++) {
    ladder.add(part(cyl(0.018, 0.018, 0.52, 5), steel(), { pos: [37.1, 0.32 + i * 0.36, 47.15], rot: [Math.PI / 2, 0, 0] }));
  }
  deco(ladder, 0, y0, 0);
  registerAsset("roof ladder", ladder, "AST");

  // Climb volume: centred just inside the platform so stepping off the top
  // lands on the deck (water-tower pattern), and clear of the wall face so the
  // capsule never overlaps the brickwork on the way up.
  refs.climbZones.push(new THREE.Box3(
    new THREE.Vector3(36.0, y0, 46.6),
    new THREE.Vector3(37.2, y0 + ROOF_RISE + SLAB_T + 0.3, 47.7)
  ));
}

// ═══════════════════════════ 3 · RAIN CATCHER ═══════════════════════════
// The east gable eave was the only roof edge with no gutter. A 4.4 m half-round
// run (kit gutter: own mesh, own shadow line, brackets) feeds a downpipe at its
// back end into a 1.1 m corrugated tank on a timber stand. Tap and hose bib on
// the front face; overflow down the east side. Gutter and pipe are trim —
// unregistered, exactly like the homestead's existing gutters.

function buildRainCatcher(refs: WorldRefs) {
  const { deco, unit } = makeSiteBuilder(refs);
  const y0 = heightAt(HX, HZ);
  const roofY = y0 + ROOF_RISE;
  const st = steel();
  const dk = dark();

  // gutter along the east eave, z 40.0–44.4 — the downpipe drops at its FRONT
  // end: a seeded debris cluster (makeRng 9137 stream) sits at (36.9, 44.6),
  // so the tank cannot stand under the back end
  const gut = gutter(4.4, st, { pos: [36.34, roofY - 0.06, 42.2] });
  gut.rotation.y = Math.PI / 2; // kit builds along +X; turn it onto the z-running eave
  deco(gut);

  // downpipe from the front end of the trough to the tank rim, strapped to the wall
  const pipeTop = roofY - 0.06 - 0.055;
  const pipeLen = pipeTop - (y0 + 1.95);
  deco(part(cyl(0.038, 0.038, pipeLen, 8), st, { pos: [36.34, y0 + 1.95 + pipeLen / 2, 40.12] }));
  for (const sy of [1.2, 2.6, 4.0]) {
    deco(part(flatBox(0.26, 0.03, 0.07), st, { pos: [36.21, y0 + sy, 40.12], shadow: false }));
  }

  // raised tank on a timber stand: rim under the downpipe at y0 + 1.92
  const wood = matOf("IND03", 1.5);
  const corr = matOf("IND01", 2);
  const g = new THREE.Group();
  for (const [lx, lz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]] as const) {
    g.add(part(flatBox(0.09, 0.82, 0.09), wood, { pos: [lx, 0.39, lz] }));
  }
  for (const sz of [-0.4, 0.4]) g.add(part(flatBox(0.89, 0.08, 0.07), wood, { pos: [0, 0.78, sz] }));
  for (const sx of [-0.4, 0.4]) g.add(part(flatBox(0.07, 0.08, 0.89), wood, { pos: [sx, 0.78, 0] }));
  const knees = new THREE.Group();
  knees.userData.noCollide = true;
  for (const [lx, lz] of [[-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]] as const) {
    knees.add(strut([lx, 0.45, lz], [lx * 0.6, 0.74, lz * 0.6], 0.03, wood));
  }
  g.add(knees);
  // tank: corrugated shell, hoops, lid, inlet collar under the downpipe
  g.add(part(cyl(0.55, 0.55, 1.12, 18), corr, { pos: [0, 1.36, 0] }));
  for (const hy of [0.85, 1.87]) g.add(part(cyl(0.56, 0.56, 0.05, 18), dk, { pos: [0, hy, 0] }));
  g.add(part(cyl(0.56, 0.56, 0.03, 18), corr, { pos: [0, 1.935, 0] }));
  g.add(part(cyl(0.1, 0.1, 0.04, 10), dk, { pos: [-0.46, 1.94, -0.18] }));
  // tap + hose bib on the front (-z) face
  const tap = new THREE.Group();
  tap.userData.noCollide = true;
  tap.add(part(cyl(0.025, 0.025, 0.16, 8), st, { pos: [0, 1.02, -0.6], rot: [Math.PI / 2, 0, 0] }));
  tap.add(part(cyl(0.02, 0.02, 0.12, 8), st, { pos: [0, 0.94, -0.67] }));
  tap.add(part(cyl(0.055, 0.055, 0.02, 10), dk, { pos: [0, 1.1, -0.62], rot: [Math.PI / 2, 0, 0] }));
  tap.add(part(cyl(0.015, 0.015, 0.08, 6), st, { pos: [0.1, 0.98, -0.6], rot: [Math.PI / 2, 0, 0] }));
  g.add(tap);
  // overflow: stub out of the east side, down leg to grade
  const ovf = new THREE.Group();
  ovf.userData.noCollide = true;
  ovf.add(part(cyl(0.028, 0.028, 0.2, 8), st, { pos: [0.6, 1.66, 0.15], rot: [0, 0, Math.PI / 2] }));
  ovf.add(part(cyl(0.028, 0.028, 1.6, 8), st, { pos: [0.68, 0.85, 0.15] }));
  g.add(ovf);
  // rivet rings on both hoops
  const rv: Placement[] = [];
  for (const hy of [0.88, 1.84]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      rv.push({ pos: [Math.cos(a) * 0.565, hy, Math.sin(a) * 0.565], rot: [0, -a, -Math.PI / 2] });
    }
  }
  const tankRivets = rivets(rv, st);
  tankRivets.userData.noCollide = true;
  g.add(tankRivets);

  unit(g, 36.8, heightAt(36.8, 40.3), 40.3, "rain tank", 0, "children");
}

// ═══════════════════════════ 4 · TRADING POST CAMP ═══════════════════════════
// South of the siding between the two boxcars: a canvas-roofed stall, a
// campfire with log seats, a painted TRADE sign, and work-a-day prop clusters.
// The rail bed (z 69.8–74.2) and the boxcar door tracks stay clear.

function buildTradingPost(refs: WorldRefs, rng: () => number) {
  const { unit } = makeSiteBuilder(refs);
  const wood = matOf("IND03", 2);
  const tarp = matOf("IND09", 1.5);
  const canvas = matOf("CRV05", 1.2);
  const st = steel();
  const dk = dark();

  // ── the stall: four poles, counter, pitched awning, goods, lanterns ──
  {
    const sx = -31, sz = 77.3, sy = heightAt(sx, sz);
    const g = new THREE.Group();
    // front (track-side, -z) poles stand taller so the awning pitches back
    for (const [lx, lz, h] of [[-1.4, -1.05, 2.4], [1.4, -1.05, 2.4], [-1.4, 1.05, 2.1], [1.4, 1.05, 2.1]] as const) {
      g.add(part(flatBox(0.09, h, 0.09), wood, { pos: [lx, h / 2 - 0.12, lz] })); // sunk 0.12
    }
    // counter at a real serving height, 0.95 m
    g.add(bev(2.4, 0.06, 0.55, wood, { pos: [0, 0.92, -0.78], radius: 0.012 }));
    g.add(part(flatBox(2.4, 0.7, 0.04), wood, { pos: [0, 0.5, -1.02] }));
    for (const cx of [-1.1, 0, 1.1]) g.add(part(flatBox(0.07, 0.89, 0.5), wood, { pos: [cx, 0.445, -0.78] }));

    // awning: pitched tarp sheet on ridge poles, with a valance — overhead
    // dressing, tagged so it never becomes a head-height collider
    const awn = new THREE.Group();
    awn.userData.noCollide = true;
    const sheet = part(flatBox(3.2, 0.035, 2.5), tarp, { pos: [0, 2.13, -0.05] });
    sheet.rotation.x = 0.1429; // front edge high: 2.28 over the front poles, 1.98 back
    awn.add(sheet);
    awn.add(part(cyl(0.03, 0.03, 3.3, 6), wood, { pos: [0, 2.28, -1.05], rot: [0, 0, Math.PI / 2] }));
    awn.add(part(cyl(0.025, 0.025, 2.9, 6), wood, { pos: [0, 1.98, 1.05], rot: [0, 0, Math.PI / 2] }));
    awn.add(part(flatBox(3.2, 0.16, 0.02), tarp, { pos: [0, 2.3, -1.28], rot: [0.14, 0, 0] }));
    g.add(awn);

    // lantern string between the front pole tops: sagging wire, 5 barn lanterns
    const lan = new THREE.Group();
    lan.userData.noCollide = true;
    lan.add(strut([-1.4, 2.26, -1.05], [0, 2.1, -1.05], 0.006, dk));
    lan.add(strut([0, 2.1, -1.05], [1.4, 2.26, -1.05], 0.006, dk));
    const glow = plain(0xffd9a0, 0.5, 0.1, { emissive: 0xffb347, emissiveIntensity: 1.6 });
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const lx = -1.4 + t * 2.8;
      const ly = 2.26 - Math.sin(t * Math.PI) * 0.16 - 0.1;
      lan.add(part(cyl(0.006, 0.006, 0.05, 5), dk, { pos: [lx, ly + 0.1, -1.05], shadow: false }));
      lan.add(part(cyl(0.05, 0.06, 0.025, 8), dk, { pos: [lx, ly + 0.07, -1.05] }));
      lan.add(part(cyl(0.045, 0.055, 0.09, 8), glow, { pos: [lx, ly, -1.05], shadow: false }));
      lan.add(part(cyl(0.055, 0.05, 0.02, 8), dk, { pos: [lx, ly - 0.055, -1.05] }));
    }
    g.add(lan);

    // goods: crates, sacks and a jar row on the counter; stock beneath it
    const goods = new THREE.Group();
    goods.userData.noCollide = true;
    goods.add(bev(0.34, 0.34, 0.34, wood, { pos: [-0.75, 1.12, -0.78] }));
    goods.add(bev(0.3, 0.3, 0.3, wood, { pos: [-0.38, 1.1, -0.72], rot: [0, 0.4, 0] }));
    goods.add(bev(0.36, 0.3, 0.3, canvas, { pos: [0.15, 1.1, -0.8], radius: 0.1 }));
    goods.add(bev(0.3, 0.26, 0.28, canvas, { pos: [0.52, 1.08, -0.74], radius: 0.09, rot: [0, 0.5, 0] }));
    const glass = matOf("CRV08", 1);
    for (let i = 0; i < 4; i++) {
      const jx = 0.85 + (i % 2) * 0.18, jz = -0.9 + Math.floor(i / 2) * 0.18;
      goods.add(part(cyl(0.065, 0.065, 0.16, 10), glass, { pos: [jx, 1.03, jz] }));
      goods.add(part(cyl(0.055, 0.055, 0.025, 10), dk, { pos: [jx, 1.12, jz] }));
    }
    goods.add(bev(0.5, 0.5, 0.5, wood, { pos: [0.6, 0.25, -0.3] }));
    goods.add(bev(0.42, 0.38, 0.36, canvas, { pos: [-0.5, 0.19, -0.35], radius: 0.12 }));
    g.add(goods);

    unit(g, sx, sy, sz, "trade stall", 0, "children");
  }

  // ── campfire: TER07 stone ring, charred logs, emissive fire, log seats ──
  {
    const fx = -27.2, fz = 78.5, fy = heightAt(fx, fz);
    const g = new THREE.Group();
    const stone = matOf("TER07", 1);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      g.add(bev(0.26 + rng() * 0.08, 0.2 + rng() * 0.08, 0.22 + rng() * 0.08, stone, {
        pos: [Math.cos(a) * 0.55, 0.06, Math.sin(a) * 0.55], rot: [0, rng() * 3, 0], radius: 0.05,
      }));
    }
    const fire = new THREE.Group();
    fire.userData.noCollide = true;
    for (const yaw of [0.3, 2.4, 4.5]) {
      fire.add(part(cyl(0.045, 0.05, 0.65, 7), dk, { pos: [Math.cos(yaw) * 0.12, 0.16, Math.sin(yaw) * 0.12], rot: [1.0, yaw, 0] }));
    }
    fire.add(part(cyl(0.32, 0.36, 0.08, 12), plain(0x3a1f14, 0.9, 0, { emissive: 0xd43d0a, emissiveIntensity: 0.8 }), { pos: [0, 0.1, 0] }));
    const flameOuter = plain(0xd96a1e, 0.7, 0, { emissive: 0xff6a1a, emissiveIntensity: 2.0 });
    const flameInner = plain(0xffc766, 0.6, 0, { emissive: 0xffb13d, emissiveIntensity: 2.6 });
    for (const [rx, rz, h, tilt] of [[0.05, 0.02, 0.45, 0.18], [-0.06, 0.05, 0.38, -0.22], [0.0, -0.06, 0.5, 0.1]] as const) {
      fire.add(part(cyl(0.015, 0.13, h, 6), flameOuter, { pos: [rx, 0.14 + h / 2, rz], rot: [tilt, 0, tilt * 0.6], shadow: false }));
    }
    fire.add(part(cyl(0.01, 0.07, 0.34, 6), flameInner, { pos: [0, 0.31, 0], shadow: false }));
    g.add(fire);
    // log seats around the fire
    for (const a of [0.6, 2.5, 4.4]) {
      const log = part(cyl(0.155, 0.155, 1.25, 10), wood, {
        pos: [Math.cos(a) * 1.25, 0.155, Math.sin(a) * 1.25],
        rot: [0, Math.PI / 2 - a, Math.PI / 2],
      });
      g.add(log);
    }
    unit(g, fx, fy, fz, "campfire", 0, "children", { interpenetrates: true });
  }

  // ── hand-painted TRADE sign: geometry letters in dark paint, both faces ──
  {
    const px = -24.6, pz = 75.0, py = heightAt(px, pz);
    const g = new THREE.Group();
    g.add(part(flatBox(0.12, 2.4, 0.12), wood, { pos: [0, 1.0, 0] })); // post, sunk 0.2
    const board = new THREE.Group();
    board.add(part(flatBox(1.5, 0.42, 0.04), wood, { pos: [0, 1.72, 0] }));
    board.add(strut([0, 1.36, 0], [-0.45, 1.53, 0], 0.03, wood)); // diagonal brace
    // pixel-font strokes: [cx, cy, w, h] in a 0.16 x 0.26 letter box
    const GLYPHS: Record<string, Array<[number, number, number, number]>> = {
      T: [[0, 0.1125, 0.16, 0.035], [0, -0.0175, 0.035, 0.225]],
      R: [[-0.0625, 0, 0.035, 0.26], [0.005, 0.1125, 0.145, 0.035], [0.0575, 0.06, 0.035, 0.115],
          [0, 0.005, 0.13, 0.035], [0.02, -0.045, 0.045, 0.06], [0.05, -0.1, 0.045, 0.06]],
      A: [[-0.0575, -0.02, 0.035, 0.22], [0.0575, -0.02, 0.035, 0.22], [0, 0.1125, 0.15, 0.035], [0, 0, 0.115, 0.035]],
      D: [[-0.0575, 0, 0.035, 0.26], [0.005, 0.1125, 0.14, 0.035], [0.005, -0.1125, 0.14, 0.035], [0.0575, 0, 0.035, 0.19]],
      E: [[-0.0575, 0, 0.035, 0.26], [0.005, 0.1125, 0.14, 0.035], [0, 0, 0.115, 0.035], [0.005, -0.1125, 0.14, 0.035]],
    };
    const paint = plain(0x2b2620, 0.85, 0.05);
    "TRADE".split("").forEach((ch, li) => {
      const lx = -0.43 + li * 0.215;
      for (const [cx, cy, w, h] of GLYPHS[ch]) {
        for (const face of [1, -1] as const) {
          // mirrored on the back face, so the word reads correctly from both sides
          board.add(part(flatBox(w, h, 0.014), paint, { pos: [face * (lx + cx), 1.72 + cy, face * 0.027], shadow: false }));
        }
      }
    });
    g.add(board);
    unit(g, px, py, pz, "trade sign", -0.15, "children");
  }

  // ── prop clusters: drums, a pallet stack, a sack pile ──
  {
    const drums = new THREE.Group();
    const drumMat = matOf("CRV07", 1);
    const drumAt = (dx: number, dz: number, tipped: boolean) => {
      const d = new THREE.Group();
      d.add(part(cyl(0.29, 0.29, 0.88, 14), drumMat, { pos: [0, 0.44, 0] }));
      for (const hy of [0.28, 0.6]) d.add(part(cyl(0.305, 0.305, 0.05, 14), drumMat, { pos: [0, hy, 0] }));
      d.add(part(cyl(0.3, 0.3, 0.03, 14), dk, { pos: [0, 0.885, 0] }));
      d.add(part(cyl(0.045, 0.045, 0.025, 6), st, { pos: [0.16, 0.9, 0] }));
      d.position.set(dx, 0, dz);
      if (tipped) { d.rotation.z = Math.PI / 2; d.position.y = 0.3; d.rotation.y = rng() * Math.PI; }
      drums.add(d);
    };
    drumAt(0, 0, false);
    drumAt(0.62, 0.2, false);
    drumAt(0.3, 0.62, false);
    drumAt(1.15, -0.15, true);
    unit(drums, -34.8, heightAt(-34.8, 77.8), 77.8, "oil drum cluster", rng() * 3, true, { interpenetrates: true });
  }
  {
    const stack = new THREE.Group();
    const pallet = (py: number, yaw: number) => {
      const p = new THREE.Group();
      for (let s = 0; s < 6; s++) p.add(part(flatBox(1.2, 0.022, 0.1), wood, { pos: [0, 0.135, -0.4 + s * 0.16] }));
      for (const bx of [-0.5, 0, 0.5]) p.add(part(flatBox(0.1, 0.075, 1.0), wood, { pos: [bx, 0.08, 0] }));
      for (const bx of [-0.5, 0, 0.5]) for (const bz of [-0.44, 0, 0.44]) {
        p.add(part(flatBox(0.1, 0.08, 0.1), wood, { pos: [bx, 0.04, bz] }));
      }
      p.position.y = py;
      p.rotation.y = yaw;
      stack.add(p);
    };
    pallet(0, 0);
    pallet(0.155, 0.12);
    pallet(0.31, -0.08);
    const lean = new THREE.Group(); // one pallet leaning against the stack
    for (let s = 0; s < 6; s++) lean.add(part(flatBox(1.2, 0.022, 0.1), wood, { pos: [0, 0.135, -0.4 + s * 0.16] }));
    for (const bx of [-0.5, 0, 0.5]) lean.add(part(flatBox(0.1, 0.075, 1.0), wood, { pos: [bx, 0.08, 0] }));
    lean.position.set(0.95, 0.02, 0.1);
    lean.rotation.z = -1.15;
    stack.add(lean);
    unit(stack, -22.4, heightAt(-22.4, 80.9), 80.9, "pallet stack", rng() * 3, true, { interpenetrates: true });
  }
  {
    const sacks = new THREE.Group();
    sacks.add(bev(0.52, 0.36, 0.42, canvas, { pos: [0, 0.16, 0], radius: 0.12 }));
    sacks.add(bev(0.46, 0.32, 0.38, canvas, { pos: [0.45, 0.14, 0.18], radius: 0.11, rot: [0, 0.5, 0] }));
    sacks.add(bev(0.44, 0.3, 0.36, canvas, { pos: [-0.32, 0.13, 0.32], radius: 0.1, rot: [0, 1.1, 0] }));
    sacks.add(bev(0.4, 0.28, 0.34, canvas, { pos: [0.08, 0.44, 0.14], radius: 0.1, rot: [0, 0.3, 0] }));
    unit(sacks, -33.6, heightAt(-33.6, 75.4), 75.4, "sack pile", rng() * 3, true, { interpenetrates: true });
  }
}

// ═══════════════════════════ entry point ═══════════════════════════

export function buildBaseUpgrades(refs: WorldRefs): void {
  const rng = makeRng(41771); // own stream — every existing sequence untouched
  buildWorkbench(refs);       // first: role "workbench" must win the lookup
  buildRoofGarden(refs, rng);
  buildRainCatcher(refs);
  buildTradingPost(refs, rng);
}
