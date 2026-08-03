// World builder: highway, ruins, home base, container yard, the Homestead, props.
//
// Assembly rules (see kit.ts for the vocabulary):
//   · Primary form first, then secondary components, then tertiary construction
//     detail. A wall is not a box — it is a wall, a sill, a lintel, a frame, and
//     the fixings that hold them together.
//   · Trim is separate geometry. Fascia, soffit, gutter and cover strips are their
//     own meshes so they cast their own shadow lines; painted-on trim reads flat.
//   · Real dimensions. Containers are 6.06 x 2.44 x 2.59 m, doors 1.0 x 2.1 m,
//     stair risers 0.2 m, masonry 0.2 m thick. Proportions are most of what makes
//     an object legible at a glance.
//   · Everything is grounded through terrain.heightAt(), never assumed to be at 0.
import * as THREE from "./three";
import { WORLD, registerAsset, QUALITY, makeRng } from "./constants";
import { surface, plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, rivets, along, seam, weld, vent, hinge, gutter, window as windowUnit } from "./kit";
import { heightAt, normalAt } from "./terrain";

export interface WorldRefs {
  scene: THREE.Scene;
  colliders: THREE.Box3[];
}

const T = WORLD.THICK;   // 0.2 m masonry
const H = WORLD.WALL_H;  // 3.0 m storey
const DOOR_W = 1.0, DOOR_H = 2.1;
const WIN_W = 1.2, WIN_H = 1.2, WIN_SILL = 0.95;

// ─────────────────────────── shared surfaces ───────────────────────────
const S = {
  brick: () => surface("STR03", { tile: 2.4, grime: 0.65, grimeHeight: 2.2, dust: 0.4 }),
  concrete: () => surface("STR04", { tile: 3.2, grime: 0.7, grimeHeight: 2.4, dust: 0.45 }),
  plank: () => surface("STR01", { tile: 1.5, grime: 0.55, grimeHeight: 1.4, dust: 0.4 }),
  shanty: () => surface("STR02", { tile: 2.2, grime: 0.6, grimeHeight: 1.8 }),
  patch: () => surface("STR05", { tile: 2.4, grime: 0.6, grimeHeight: 1.8 }),
  sandbag: () => surface("STR06", { tile: 0.9, grime: 0.5, grimeHeight: 0.8 }),
  chain: () => surface("STR07", { tile: 1.4 }),
  ply: () => surface("STR08", { tile: 1.6, grime: 0.5, grimeHeight: 1.2 }),
  containerBlue: () => surface("STR09", { tile: 2.4, grime: 0.6, grimeHeight: 2.0, dust: 0.5 }),
  rustPlate: () => surface("MET01", { tile: 1.6, grime: 0.55, grimeHeight: 1.4 }),
  corrugated: () => surface("MET04", { tile: 1.6, grime: 0.5, grimeHeight: 1.6 }),
  tread: () => surface("MET05", { tile: 1.1 }),
  hazard: () => surface("MET08", { tile: 1.2, grime: 0.5, grimeHeight: 1.0 }),
  pipe: () => surface("MET07", { tile: 1.0 }),
  asphalt: () => surface("TER03", { tile: 4.0, grime: 0.35, grimeHeight: 0.4, dust: 0.5 }),
  road: () => surface("TER08", { tile: 6.0, grime: 0.3, grimeHeight: 0.3, dust: 0.5 }),
  rubbleMat: () => surface("TER07", { tile: 2.0 }),
  mud: () => surface("TER09", { tile: 2.0 }),
  barrel: () => surface("CRV07", { local: true, tile: 1.4, grime: 0.5, grimeHeight: 0.6 }),
  tyre: () => surface("CRV03", { local: true, tile: 0.7 }),
  glass: () => plain(0x33484c, 0.1, 0.4),
  steel: () => plain(0x55524d, 0.44, 0.85),
  darkSteel: () => plain(0x34322f, 0.58, 0.8),
  timber: () => plain(0x6d5636, 0.86, 0.02),
  crop: () => plain(0x5d7c30, 0.9, 0),
};

// ─────────────────────────── placement helpers ───────────────────────────

function makeBuilder(refs: WorldRefs) {
  /** Structural mesh: beveled, shadowed, registered, and collidable. */
  const solid = (
    w: number, h: number, d: number, mat: THREE.Material,
    x: number, y: number, z: number, role: string,
    opts: { ry?: number; collide?: boolean; radius?: number } = {}
  ): THREE.Mesh => {
    const m = bev(w, h, d, mat, { pos: [x, y + h / 2, z], radius: opts.radius });
    if (opts.ry) m.rotation.y = opts.ry;
    refs.scene.add(m);
    registerAsset(role, m);
    if (opts.collide !== false) {
      m.updateMatrixWorld(true);
      refs.colliders.push(new THREE.Box3().setFromObject(m));
    }
    return m;
  };

  /** Detail mesh: no collider, no registry entry — trim, fixings, dressing. */
  const deco = (o: THREE.Object3D, x?: number, y?: number, z?: number): THREE.Object3D => {
    if (x !== undefined) o.position.set(x, y!, z!);
    refs.scene.add(o);
    return o;
  };

  /**
   * Group placed as one unit.
   *
   * `collide` matters more than it looks. "box" wraps the whole group in one
   * Box3 — right for a solid object like a container. For a wall with a doorway
   * it is catastrophic: the single box spans the opening and seals the door, so
   * the room becomes unreachable even though it renders as a hole. Wall
   * assemblies therefore use "children", which gives each jamb, lintel and sill
   * its own volume and leaves the aperture genuinely open. Meshes tagged
   * `userData.noCollide` (the swinging door leaf) are skipped.
   */
  const unit = (
    g: THREE.Group, x: number, y: number, z: number, role: string,
    ry = 0, collide: boolean | "children" = true
  ) => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    refs.scene.add(g);
    registerAsset(role, g);
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

// ─────────────────────────── wall assemblies ───────────────────────────

/**
 * Masonry wall with a door opening: jambs, a lintel that projects past the
 * reveal, a timber frame, hinges and a handle. The opening stays a real hole.
 */
function doorAssembly(len: number, mat: THREE.Material, horiz: boolean): THREE.Group {
  const g = new THREE.Group();
  const jamb = (len - DOOR_W) / 2;
  const off = (len - jamb) / 2;
  const steel = S.steel();
  const dark = S.darkSteel();
  const timber = S.timber();

  const seg = (c: number, l: number) =>
    horiz ? bev(l, H, T, mat, { pos: [c, H / 2, 0] }) : bev(T, H, l, mat, { pos: [0, H / 2, c] });
  g.add(seg(-off, jamb), seg(off, jamb));
  // lintel: projects 60 mm proud of the wall face on both sides
  g.add(horiz
    ? bev(DOOR_W + 0.3, H - DOOR_H, T + 0.12, mat, { pos: [0, DOOR_H + (H - DOOR_H) / 2, 0] })
    : bev(T + 0.12, H - DOOR_H, DOOR_W + 0.3, mat, { pos: [0, DOOR_H + (H - DOOR_H) / 2, 0] }));
  // timber lining around the reveal
  const lining = (c: number) => horiz
    ? part(flatBox(0.07, DOOR_H, T + 0.02), timber, { pos: [c, DOOR_H / 2, 0] })
    : part(flatBox(T + 0.02, DOOR_H, 0.07), timber, { pos: [0, DOOR_H / 2, c] });
  g.add(lining(-DOOR_W / 2), lining(DOOR_W / 2));
  g.add(horiz
    ? part(flatBox(DOOR_W + 0.14, 0.07, T + 0.02), timber, { pos: [0, DOOR_H, 0] })
    : part(flatBox(T + 0.02, 0.07, DOOR_W + 0.14), timber, { pos: [0, DOOR_H, 0] }));
  // the door itself, hung open against the reveal
  const leaf = new THREE.Group();
  leaf.add(part(flatBox(DOOR_W - 0.04, DOOR_H - 0.06, 0.045), S.ply(), { pos: [(DOOR_W - 0.04) / 2, 0, 0] }));
  leaf.add(part(flatBox(DOOR_W - 0.12, 0.07, 0.055), timber, { pos: [(DOOR_W - 0.04) / 2, 0.62, 0.005] }));
  leaf.add(part(flatBox(DOOR_W - 0.12, 0.07, 0.055), timber, { pos: [(DOOR_W - 0.04) / 2, -0.62, 0.005] }));
  leaf.add(part(flatBox(0.05, 0.11, 0.05), dark, { pos: [DOOR_W - 0.16, 0, 0.05] })); // handle
  leaf.add(bolts(along([0.12, 0.62, 0.035], [DOOR_W - 0.16, 0.62, 0.035], 4), steel, 0.011));
  leaf.position.set(horiz ? -DOOR_W / 2 : 0, DOOR_H / 2, horiz ? 0 : -DOOR_W / 2);
  leaf.rotation.y = horiz ? -1.15 : -1.15 + Math.PI / 2;
  // The leaf hangs open across part of the reveal; giving it a collider would
  // narrow the doorway to less than a body's width.
  leaf.userData.noCollide = true;
  g.add(leaf);
  for (const hy of [DOOR_H * 0.2, DOOR_H * 0.8]) {
    g.add(hinge(0.16, dark, steel, {
      pos: horiz ? [-DOOR_W / 2, hy, T / 2 + 0.02] : [T / 2 + 0.02, hy, -DOOR_W / 2],
    }));
  }
  // threshold plate
  g.add(part(flatBox(horiz ? DOOR_W + 0.1 : T + 0.14, 0.035, horiz ? T + 0.14 : DOOR_W + 0.1), dark, { pos: [0, 0.017, 0] }));
  return g;
}

/** Masonry wall with a fully built window unit set into the reveal. */
function windowAssembly(len: number, mat: THREE.Material, horiz: boolean): THREE.Group {
  const g = new THREE.Group();
  const jamb = (len - WIN_W) / 2;
  const off = (len - jamb) / 2;
  const head = WIN_SILL + WIN_H;

  const seg = (c: number, l: number) =>
    horiz ? bev(l, H, T, mat, { pos: [c, H / 2, 0] }) : bev(T, H, l, mat, { pos: [0, H / 2, c] });
  g.add(seg(-off, jamb), seg(off, jamb));
  // spandrel below, head above
  g.add(horiz
    ? bev(WIN_W, WIN_SILL, T, mat, { pos: [0, WIN_SILL / 2, 0] })
    : bev(T, WIN_SILL, WIN_W, mat, { pos: [0, WIN_SILL / 2, 0] }));
  g.add(horiz
    ? bev(WIN_W + 0.24, H - head, T + 0.1, mat, { pos: [0, head + (H - head) / 2, 0] })
    : bev(T + 0.1, H - head, WIN_W + 0.24, mat, { pos: [0, head + (H - head) / 2, 0] }));

  const w = windowUnit(WIN_W, WIN_H, T, S.timber(), S.glass(), plain(0x8d8577, 0.8, 0.05), { mullions: 1 });
  w.position.set(0, WIN_SILL + WIN_H / 2, 0);
  if (!horiz) w.rotation.y = Math.PI / 2;
  g.add(w);
  return g;
}

// ─────────────────────────── the world ───────────────────────────

export function buildWorld(refs: WorldRefs): void {
  const { solid, deco, unit } = makeBuilder(refs);
  const rng = makeRng(9137);
  const steel = S.steel();
  const dark = S.darkSteel();
  const timber = S.timber();

  // ── HIGHWAY ────────────────────────────────────────────────────────────
  // The terrain pad grades this corridor flat, the way a real road is cut.
  const roadY = heightAt(14, 0);
  const roadLen = WORLD.SIZE * 1.4;
  const road = part(flatBox(8, 0.05, roadLen), S.road(), { pos: [14, roadY + 0.025, 0], shadow: false });
  refs.scene.add(road);
  registerAsset("road", road, "TER");
  for (const sx of [-1, 1]) {
    // shoulder + kerb
    deco(part(flatBox(1.6, 0.06, roadLen), S.asphalt(), { pos: [14 + sx * 4.8, roadY + 0.03, 0], shadow: false }));
    deco(part(flatBox(0.18, 0.16, roadLen), S.concrete(), { pos: [14 + sx * 4.05, roadY + 0.08, 0], shadow: false }));
  }
  // Armco guard rail: posts, corrugated beam, bolts. Broken in places.
  for (let i = 0; i < 46; i++) {
    const z = -roadLen / 2 + i * (roadLen / 46) + 2;
    if (rng() < 0.24) continue; // collapsed sections
    // The road deliberately overruns the map so it fades into fog, but rails
    // are real assets — keep them inside the world bound.
    if (Math.abs(z) > WORLD.SIZE / 2 - 2) continue;
    const gx = 14 - 5.4;
    // Each surviving section is one registered asset, so it carries an ID and a
    // grid address in the inspection layer instead of being anonymous dressing.
    const rail = new THREE.Group();
    rail.add(part(flatBox(0.1, 0.9, 0.1), dark, { pos: [0, 0.45, 0] }));
    rail.add(part(flatBox(0.05, 0.32, roadLen / 46), S.corrugated(), { pos: [0.09, 0.72, 0] }));
    if (i % 3 === 0) rail.add(bolts([{ pos: [0.12, 0.72, 0], rot: [0, Math.PI / 2, 0] }], steel, 0.014));
    unit(rail, gx, roadY, z, "guard rail", 0, false);
  }
  // lane-line wear: patches of exposed aggregate through the paint
  for (let i = 0; i < 30; i++) {
    const z = (rng() - 0.5) * roadLen;
    const x = 14 + (rng() - 0.5) * 7;
    deco(part(flatBox(0.6 + rng() * 1.8, 0.02, 0.7 + rng() * 2.4), S.asphalt(), { pos: [x, roadY + 0.055, z], shadow: false }));
  }

  // ── RUINED PRE-WAR BLOCK ───────────────────────────────────────────────
  const ruinAt = (ox: number, oz: number, matKey: "brick" | "concrete") => {
    const mat = matKey === "brick" ? S.brick() : S.concrete();
    const y = heightAt(ox, oz);
    const M4 = WORLD.MODULE;
    // three standing walls, one collapsed
    solid(M4 * 2, H, T, mat, ox, y, oz - M4, "ruin wall");
    solid(T, H, M4 * 2, mat, ox - M4, y, oz, "ruin wall");
    solid(T, H * 0.55, M4 * 2, mat, ox + M4, y, oz, "ruin wall broken");
    // exposed rebar out of the broken top
    for (let i = 0; i < 6; i++) {
      const rz = oz - M4 + rng() * M4 * 2;
      deco(part(cyl(0.014, 0.014, 0.5 + rng() * 0.5, 5), S.rustPlate(), {
        pos: [ox + M4, y + H * 0.55 + 0.3, rz], rot: [rng() * 0.4 - 0.2, 0, rng() * 0.5 - 0.25],
      }));
    }
    // window openings punched in the long wall + a concrete lintel over each
    for (const wx of [-M4 * 0.55, M4 * 0.55]) {
      deco(part(flatBox(1.5, 0.16, T + 0.1), S.concrete(), { pos: [ox + wx, y + 2.3, oz - M4] }));
    }
    // wall-base rubble skirt and a collapsed heap where the fourth wall was
    const heap = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 1.7;
      heap.add(bev(0.3 + rng() * 0.7, 0.16 + rng() * 0.34, 0.3 + rng() * 0.6, S.rubbleMat(), {
        pos: [Math.cos(a) * r, 0.1 + rng() * 0.28, Math.sin(a) * r], rot: [rng(), rng() * 3, rng() * 0.5],
      }));
    }
    unit(heap, ox, y, oz + M4, "rubble", 0, false);
    deco(part(flatBox(M4 * 2, 0.1, 0.7), S.rubbleMat(), { pos: [ox, y + 0.05, oz - M4 + 0.45], shadow: false }));
  };
  ruinAt(-26, -18, "concrete");
  ruinAt(-38, -6, "brick");
  ruinAt(36, 20, "concrete");
  ruinAt(48, 6, "brick");
  ruinAt(-20, 34, "concrete");

  // ── HOME BASE ──────────────────────────────────────────────────────────
  const bx = -6, bz = -44;
  const baseY = heightAt(bx, bz);
  const M4 = WORLD.MODULE;

  /** Scrap perimeter: posts, panels, top rail, angled bracing. */
  const scrapWall = (cx: number, cz: number, len: number, horiz: boolean, mat: THREE.Material) => {
    solid(horiz ? len : T, H, horiz ? T : len, mat, cx, baseY, cz, "base wall");
    const n = Math.max(2, Math.round(len / 2));
    for (let i = 0; i <= n; i++) {
      const t = -len / 2 + (i * len) / n;
      const px = horiz ? cx + t : cx;
      const pz = horiz ? cz : cz + t;
      deco(part(flatBox(0.12, H + 0.25, 0.12), dark, { pos: [px, baseY + (H + 0.25) / 2, pz] }));
      if (i < n) {
        deco(part(flatBox(horiz ? 0.06 : 0.14, 0.14, horiz ? 0.14 : 0.06), steel, {
          pos: [horiz ? px + len / n / 2 : px + 0.11, baseY + H - 0.2, horiz ? pz + 0.11 : pz + len / n / 2],
        }));
      }
    }
    // top rail + rivet line down the panel joints
    deco(part(flatBox(horiz ? len : 0.16, 0.1, horiz ? 0.16 : len), steel, { pos: [cx, baseY + H + 0.05, cz] }));
    deco(rivets(
      horiz ? along([cx - len / 2 + 0.3, baseY + 1.5, cz + T / 2 + 0.01], [cx + len / 2 - 0.3, baseY + 1.5, cz + T / 2 + 0.01], Math.round(len))
            : along([cx + T / 2 + 0.01, baseY + 1.5, cz - len / 2 + 0.3], [cx + T / 2 + 0.01, baseY + 1.5, cz + len / 2 - 0.3], Math.round(len)),
      steel));
    // diagonal bracing
    for (let i = 0; i < Math.max(1, Math.round(len / 6)); i++) {
      const t = -len / 2 + (i + 0.5) * (len / Math.max(1, Math.round(len / 6)));
      deco(part(flatBox(horiz ? 3.2 : 0.07, 0.07, horiz ? 0.07 : 3.2), steel, {
        pos: [horiz ? cx + t : cx + 0.12, baseY + 1.5, horiz ? cz + 0.12 : cz + t],
        rot: horiz ? [0, 0, 0.72] : [0.72, 0, 0],
      }));
    }
  };
  scrapWall(bx, bz - M4 * 1.5, M4 * 3, true, S.patch());
  scrapWall(bx, bz + M4 * 1.5, M4 * 3, true, S.shanty());
  scrapWall(bx - M4 * 1.5, bz, M4 * 3, false, S.patch());
  scrapWall(bx + M4 * 1.5, bz - M4, M4, false, S.shanty());
  scrapWall(bx + M4 * 1.5, bz + M4, M4, false, S.shanty());
  // gate posts flanking the gap, with a hazard-striped boom
  for (const gz of [bz - M4 / 2, bz + M4 / 2]) {
    deco(part(flatBox(0.22, H + 0.6, 0.22), dark, { pos: [bx + M4 * 1.5, baseY + (H + 0.6) / 2, gz] }));
  }
  deco(part(cyl(0.07, 0.07, M4 - 0.3, 8), S.hazard(), { pos: [bx + M4 * 1.5, baseY + 1.2, bz], rot: [Math.PI / 2, 0, 0] }));

  // watchtower: braced legs, deck, cabin with a mono-pitch roof, ladder
  {
    const tx = bx - 8, tz = bz - 8, legH = 5;
    const ty = heightAt(tx, tz);
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      solid(0.2, legH, 0.2, timber, tx + lx * 1.5, ty, tz + lz * 1.5, "tower leg");
      // cross-bracing between legs
      deco(part(flatBox(3.1, 0.09, 0.09), timber, { pos: [tx + lx * 1.5 * 0, ty + 2.4, tz + lz * 1.5], rot: [0, 0, 0.1] }));
      deco(part(flatBox(0.09, 0.09, 3.1), timber, { pos: [tx + lx * 1.5, ty + 3.4, tz], rot: [0.1, 0, 0] }));
    }
    solid(3.6, 0.18, 3.6, S.plank(), tx, ty + legH, tz, "tower deck");
    // deck joists visible from below
    for (let i = -1; i <= 1; i++) deco(part(flatBox(3.5, 0.12, 0.1), timber, { pos: [tx, ty + legH - 0.08, tz + i * 1.2] }));
    // cabin: corner posts, waist-high boarding, open firing gap, roof
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      deco(part(flatBox(0.1, 1.9, 0.1), timber, { pos: [tx + lx * 1.7, ty + legH + 1.13, tz + lz * 1.7] }));
    }
    for (const [ox, oz, w, d] of [[0, -1.7, 3.4, 0.08], [0, 1.7, 3.4, 0.08], [-1.7, 0, 0.08, 3.4], [1.7, 0, 0.08, 3.4]] as const) {
      deco(part(flatBox(w, 1.0, d), S.ply(), { pos: [tx + ox, ty + legH + 0.68, tz + oz] }));
    }
    solid(4.0, 0.12, 4.0, S.corrugated(), tx, ty + legH + 2.06, tz, "tower roof", { collide: false });
    deco(part(flatBox(4.1, 0.1, 0.14), steel, { pos: [tx, ty + legH + 2.0, tz + 2.0] })); // fascia
    deco(gutter(4.0, steel, { pos: [tx, ty + legH + 1.98, tz + 2.14], downpipe: legH + 1.6 }));
    // ladder up one leg
    for (let i = 0; i < 14; i++) {
      deco(part(cyl(0.02, 0.02, 0.52, 5), steel, { pos: [tx + 1.5, ty + 0.3 + i * 0.36, tz - 1.86], rot: [0, 0, Math.PI / 2] }));
    }
    for (const rx of [-0.26, 0.26]) {
      deco(part(flatBox(0.05, legH, 0.05), steel, { pos: [tx + 1.5 + rx, ty + legH / 2, tz - 1.86] }));
    }
  }

  // farm plots: raised beds with plank sides, corner stakes, irrigation line
  for (let i = 0; i < 3; i++) {
    const px = bx - 2 + i * 3.5, pz = bz + 2.5;
    const py = heightAt(px, pz);
    const bed = new THREE.Group();
    for (const [ox, oz, w, d] of [[0, -1, 3, 0.08], [0, 1, 3, 0.08], [-1.5, 0, 0.08, 2], [1.5, 0, 0.08, 2]] as const) {
      bed.add(part(flatBox(w, 0.34, d), timber, { pos: [ox, 0.17, oz] }));
    }
    for (const [cx2, cz2] of [[-1.5, -1], [1.5, -1], [-1.5, 1], [1.5, 1]] as const) {
      bed.add(part(flatBox(0.1, 0.5, 0.1), timber, { pos: [cx2, 0.25, cz2] }));
    }
    bed.add(part(flatBox(2.84, 0.22, 1.84), S.mud(), { pos: [0, 0.24, 0], shadow: false }));
    // rows of crops, not one green slab
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 7; c++) {
        const h2 = 0.24 + Math.random() * 0.2;
        bed.add(part(flatBox(0.16, h2, 0.16), S.crop(), { pos: [-1.2 + c * 0.4, 0.35 + h2 / 2, -0.6 + r * 0.6], rot: [0, Math.random(), 0] }));
      }
    }
    bed.add(part(cyl(0.022, 0.022, 3.0, 5), dark, { pos: [0, 0.4, -0.95], rot: [0, 0, Math.PI / 2] }));
    unit(bed, px, py, pz, "farm plot", 0, false);
  }

  // scrap stockpile: a heap of distinct pieces, not a cone
  {
    const px = bx + 3.5, pz = bz - 2.5, py = heightAt(px, pz);
    const pile = new THREE.Group();
    for (let i = 0; i < 22; i++) {
      const a = rng() * Math.PI * 2, r = rng() * 1.5;
      pile.add(bev(0.2 + rng() * 0.8, 0.1 + rng() * 0.3, 0.2 + rng() * 0.7, i % 3 ? S.rustPlate() : S.corrugated(), {
        pos: [Math.cos(a) * r, 0.1 + rng() * 0.9 * (1 - r / 2), Math.sin(a) * r],
        rot: [rng() * 1.2, rng() * 3, rng() * 1.2],
      }));
    }
    unit(pile, px, py, pz, "scrap pile", 0, false);
  }

  // sandbag emplacement: staggered courses, not four identical blocks
  for (let course = 0; course < 3; course++) {
    const n = 5 - course;
    for (let i = 0; i < n; i++) {
      const px = bx + 7.5;
      const pz = bz - 4 + i * 1.0 + course * 0.5;
      solid(1.1, 0.3, 0.62, S.sandbag(), px, heightAt(px, pz) + course * 0.29, pz, "sandbags", {
        ry: 0.1 * (i % 2 ? 1 : -1), radius: 0.09, collide: course === 0,
      });
    }
  }

  // ── SHIPPING CONTAINER YARD ────────────────────────────────────────────
  // ISO 20 ft: 6.058 x 2.438 x 2.591 m. Corrugations, corner castings, door gear.
  const container = (cx: number, cz: number, ry: number, matFn: () => THREE.Material, stackY = 0) => {
    const L = 6.058, W = 2.438, Hc = 2.591;
    const g = new THREE.Group();
    const mat = matFn();
    g.add(bev(L, Hc, W, mat, { pos: [0, Hc / 2, 0], radius: 0.012 }));
    // corrugated side profile — real ribs, so the silhouette and shading break up
    for (let i = 0; i < 22; i++) {
      const x = -L / 2 + 0.28 + i * ((L - 0.56) / 21);
      for (const sz of [-1, 1]) {
        g.add(part(flatBox(0.07, Hc - 0.34, 0.035), mat, { pos: [x, Hc / 2, sz * (W / 2 + 0.016)], shadow: false }));
      }
    }
    // top/bottom rails and corner castings
    for (const sy of [0.09, Hc - 0.09]) {
      g.add(part(flatBox(L, 0.16, W + 0.04), S.rustPlate(), { pos: [0, sy, 0] }));
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const sy of [0.09, Hc - 0.09]) {
      g.add(bev(0.24, 0.18, 0.20, dark, { pos: [sx * (L / 2 - 0.12), sy, sz * (W / 2 - 0.10)], radius: 0.02 }));
    }
    // end doors: two leaves, four locking bars with cams, handles, hinges
    for (const side of [-1, 1] as const) {
      const leaf = part(flatBox(0.05, Hc - 0.28, W / 2 - 0.06), mat, { pos: [-L / 2 - 0.005, Hc / 2, side * (W / 4)] });
      g.add(leaf);
      for (let b = 0; b < 2; b++) {
        const bz2 = side * (W / 4) + (b ? 0.34 : -0.34);
        g.add(part(cyl(0.026, 0.026, Hc - 0.42, 6), steel, { pos: [-L / 2 - 0.04, Hc / 2, bz2] }));
        g.add(part(flatBox(0.07, 0.14, 0.07), dark, { pos: [-L / 2 - 0.055, Hc / 2 + 0.1, bz2] }));
        g.add(part(flatBox(0.05, 0.06, 0.18), dark, { pos: [-L / 2 - 0.06, Hc / 2 - 0.05, bz2] })); // handle
      }
      for (const hy of [Hc * 0.22, Hc * 0.78]) {
        g.add(hinge(0.16, dark, steel, { pos: [-L / 2 - 0.02, hy, side * (W / 2 - 0.08)], rot: [0, Math.PI / 2, 0] }));
      }
    }
    // shut line between the two door leaves, and the weld run along the top rail
    g.add(seam(Hc - 0.3, dark, { pos: [-L / 2 - 0.04, Hc / 2, 0], vertical: true }));
    g.add(weld(L, dark, { pos: [0, Hc - 0.18, W / 2 + 0.02], rot: [0, 0, Math.PI / 2], thickness: 0.016 }));
    g.add(rivets(along([-L / 2 + 0.3, 0.20, W / 2 + 0.04], [L / 2 - 0.3, 0.20, W / 2 + 0.04], 18), steel));
    g.add(part(flatBox(1.1, 0.34, 0.02), S.hazard(), { pos: [0.9, Hc * 0.62, W / 2 + 0.05], shadow: false }));
    // roof pooling / rain streaks read as a darker weathered panel
    g.add(part(flatBox(L - 0.5, 0.012, W - 0.4), S.rustPlate(), { pos: [0, Hc + 0.006, 0], shadow: false }));
    unit(g, cx, heightAt(cx, cz) + stackY, cz, "container", ry);
  };
  container(30, -30, 0.2, S.containerBlue);
  container(33.2, -30.4, -0.15, S.patch);
  container(30.8, -27, 1.62, S.containerBlue);
  container(30, -30, 0.2, S.corrugated, 2.591); // stacked
  container(-46, 22, 0.9, S.containerBlue);
  container(-43.4, 23.6, 0.75, S.shanty);

  // ── THE HOMESTEAD ──────────────────────────────────────────────────────
  buildHomestead(solid, deco, unit);

  // ── SCATTERED PROPS ────────────────────────────────────────────────────
  for (let i = 0; i < QUALITY.props; i++) {
    const px = (rng() - 0.5) * (WORLD.SIZE - 24);
    const pz = (rng() - 0.5) * (WORLD.SIZE - 24);
    const py = heightAt(px, pz);
    const n = normalAt(px, pz);
    const kind = rng();

    if (kind < 0.3) {
      // 200 L drum: rolling hoops, bung, hazard band
      const g = new THREE.Group();
      g.add(part(cyl(0.29, 0.29, 0.88, 14), S.barrel(), { pos: [0, 0.44, 0] }));
      for (const hy of [0.28, 0.60]) g.add(part(cyl(0.305, 0.305, 0.05, 14), S.barrel(), { pos: [0, hy, 0] }));
      g.add(part(cyl(0.30, 0.30, 0.03, 14), dark, { pos: [0, 0.885, 0] }));
      g.add(part(cyl(0.045, 0.045, 0.025, 6), steel, { pos: [0.16, 0.90, 0] }));
      g.add(part(flatBox(0.26, 0.2, 0.01), S.hazard(), { pos: [0, 0.5, 0.292], shadow: false }));
      unit(g, px, py, pz, "barrel", rng() * 3, false);
    } else if (kind < 0.55) {
      // crate: plank faces with corner battens and a stencil panel
      const g = new THREE.Group();
      const c = 1.0;
      g.add(bev(c, c, c, S.plank(), { pos: [0, c / 2, 0] }));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        g.add(part(flatBox(0.07, c + 0.02, 0.07), timber, { pos: [sx * (c / 2 - 0.02), c / 2, sz * (c / 2 - 0.02)] }));
      }
      for (const sz of [-1, 1]) {
        g.add(part(flatBox(c - 0.06, 0.07, 0.03), timber, { pos: [0, c - 0.14, sz * (c / 2 + 0.005)] }));
        g.add(part(flatBox(c - 0.06, 0.07, 0.03), timber, { pos: [0, 0.14, sz * (c / 2 + 0.005)] }));
      }
      g.add(part(flatBox(0.42, 0.26, 0.01), S.ply(), { pos: [0, c * 0.55, c / 2 + 0.012], shadow: false }));
      unit(g, px, py, pz, "crate", rng() * Math.PI, false);
    } else if (kind < 0.72) {
      const t = part(new THREE.TorusGeometry(0.38, 0.15, 10, 18), S.tyre(), {
        pos: [0, 0.15, 0], rot: [Math.PI / 2, 0, rng() * Math.PI],
      });
      const g = new THREE.Group();
      g.add(t);
      unit(g, px, py, pz, "tire", 0, false);
    } else if (kind < 0.86) {
      // timber pallet — slats, bearers, blocks
      const g = new THREE.Group();
      for (let s2 = 0; s2 < 6; s2++) g.add(part(flatBox(1.2, 0.022, 0.1), timber, { pos: [0, 0.135, -0.4 + s2 * 0.16] }));
      for (const bx2 of [-0.5, 0, 0.5]) g.add(part(flatBox(0.1, 0.075, 1.0), timber, { pos: [bx2, 0.08, 0] }));
      for (const bx2 of [-0.5, 0, 0.5]) for (const bz2 of [-0.44, 0, 0.44]) {
        g.add(part(flatBox(0.1, 0.08, 0.1), timber, { pos: [bx2, 0.04, bz2] }));
      }
      unit(g, px, py, pz, "pallet", rng() * Math.PI, false);
    } else {
      // debris cluster: broken slab, rebar, scattered chunks
      const g = new THREE.Group();
      g.add(bev(1.4 + rng(), 0.16, 1.0 + rng(), S.concrete(), { pos: [0, 0.08, 0], rot: [0.05, rng(), 0.04] }));
      for (let r = 0; r < 4; r++) {
        g.add(part(cyl(0.012, 0.012, 0.6 + rng() * 0.6, 5), S.rustPlate(), {
          pos: [(rng() - 0.5) * 1.2, 0.2, (rng() - 0.5) * 0.9], rot: [1.2 + rng() * 0.4, rng() * 3, 0],
        }));
      }
      for (let c = 0; c < 5; c++) {
        g.add(bev(0.2 + rng() * 0.4, 0.14 + rng() * 0.2, 0.2 + rng() * 0.4, S.rubbleMat(), {
          pos: [(rng() - 0.5) * 2.2, 0.1, (rng() - 0.5) * 1.8], rot: [rng(), rng() * 3, rng()],
        }));
      }
      unit(g, px, py, pz, "debris", rng() * Math.PI, false);
    }

    // lay props back onto the slope instead of standing them bolt upright
    const last = refs.scene.children[refs.scene.children.length - 1];
    last.rotation.x += Math.atan2(-n.z, n.y) * 0.9;
    last.rotation.z += Math.atan2(n.x, n.y) * 0.9;
  }
}

// ─────────────────────────── the Homestead ───────────────────────────
// A real two-storey house: rooms, doors, windows, stairs, and a roof assembly
// with fascia, soffit, gutter and downpipes.
function buildHomestead(
  solid: ReturnType<typeof makeBuilder>["solid"],
  deco: ReturnType<typeof makeBuilder>["deco"],
  unit: ReturnType<typeof makeBuilder>["unit"]
) {
  const hx = 30, hz = 44;
  const y0 = heightAt(hx, hz);
  const HW = 12, HD = 8;          // 12 x 8 m footprint
  const L2 = y0 + H;              // level-2 structural datum
  const brick = S.brick();
  const plank = S.plank();
  const steel = S.steel();
  const dark = S.darkSteel();
  const timber = S.timber();

  const wallSeg = (cx: number, cz: number, len: number, h: number, horiz: boolean, mat: THREE.Material, base: number, role = "house wall") =>
    solid(horiz ? len : T, h, horiz ? T : len, mat, cx, base, cz, role);

  // ── plinth: the house sits on a footing course, not on bare dirt ──
  solid(HW + 0.5, 0.35, HD + 0.5, S.concrete(), hx, y0 - 0.3, hz, "footing", { collide: false });

  // ── GROUND FLOOR: exterior ──
  const front = hz - HD / 2, back = hz + HD / 2;
  unit(doorAssembly(6, brick, true), hx - 3, y0, front, "house front wall", 0, "children");
  unit(windowAssembly(6, brick, true), hx + 3, y0, front, "house front wall", 0, "children");
  unit(windowAssembly(6, brick, true), hx - 3, y0, back, "house back wall", 0, "children");
  unit(windowAssembly(6, brick, true), hx + 3, y0, back, "house back wall", 0, "children");
  unit(windowAssembly(HD, brick, false), hx - HW / 2, y0, hz, "house west wall", 0, "children");
  wallSeg(hx + HW / 2, hz, HD, H, false, brick, y0, "house east wall");

  // quoins at the corners — separate stones, catching their own light
  for (const [cx, cz] of [[hx - HW / 2, front], [hx + HW / 2, front], [hx - HW / 2, back], [hx + HW / 2, back]] as const) {
    for (let i = 0; i < 9; i++) {
      deco(part(flatBox(0.46, 0.28, 0.28), S.concrete(), { pos: [cx, y0 + 0.18 + i * 0.32, cz], rot: [0, i % 2 ? Math.PI / 2 : 0, 0] }));
    }
  }

  // ── GROUND FLOOR: interior partitions ──
  unit(doorAssembly(HD, plank, false), hx, y0, hz, "interior wall", 0, "children");
  unit(doorAssembly(6, plank, true), hx + 3, y0, hz, "interior wall", 0, "children");

  // ── STAIRS: 16 risers at 0.2 m, 0.26 m going — walkable, code-plausible ──
  const RISE = (H + T) / 16, GOING = 0.26;
  const stairX = hx - HW / 2 + 0.95;
  for (let i = 1; i <= 16; i++) {
    const top = i * RISE;
    const sz = hz + 2.9 - (i - 0.5) * GOING;
    solid(1.7, top, GOING, plank, stairX, y0, sz, "stair tread");
    deco(part(flatBox(1.72, RISE * 0.9, 0.03), timber, { pos: [stairX, y0 + top - RISE / 2, sz - GOING / 2 - 0.01] })); // riser board
  }
  // stringer + newel + handrail
  for (const sx of [-0.88, 0.88]) {
    deco(part(flatBox(0.06, 0.3, 4.4), timber, { pos: [stairX + sx, y0 + 1.5, hz + 0.8], rot: [-0.65, 0, 0] }));
  }
  deco(part(flatBox(0.09, 1.0, 0.09), timber, { pos: [stairX + 0.88, y0 + 0.5, hz + 2.9] }));
  deco(part(cyl(0.028, 0.028, 4.3, 6), timber, { pos: [stairX + 0.88, y0 + 1.55, hz + 0.85], rot: [-0.65, 0, 0] }));

  // ── LEVEL 2 ──
  solid(10.2, T, HD, plank, hx + 0.9, L2, hz, "floor slab L2");
  // Landing must bridge the stair head (z 42.87) all the way to the front wall,
  // and reach the west wall face at x 23.9. Sized 1.7 x 1.4 it stopped at z 41.4,
  // leaving a 1.7 x 1.34 m hole at the top of the stairs, and stopped at x 24.1,
  // leaving a 0.2 m slot under the L2 west wall you could see daylight through.
  solid(1.9, T, 2.9, plank, hx - HW / 2 + 0.85, L2, hz - HD / 2 + 1.45, "stair landing");
  // exposed floor joists under the slab
  for (let i = -4; i <= 4; i++) deco(part(flatBox(9.9, 0.16, 0.09), timber, { pos: [hx + 0.9, L2 - 0.09, hz + i * 0.85] }));

  const L2b = L2 + T;
  const H2 = H - 0.4;
  unit(doorAssembly(HD - 2, plank, false), hx + 0.9, L2b, hz + 1, "L2 interior wall", 0, "children");
  unit(windowAssembly(10.2, brick, true), hx + 0.9, L2b, hz - HD / 2, "L2 wall", 0, "children");
  wallSeg(hx + 0.9, hz + HD / 2, 10.2, H2, true, brick, L2b, "L2 wall");
  wallSeg(hx + HW / 2, hz, HD, H2, false, brick, L2b, "L2 wall");
  // Runs from the west wall face (x 23.9) to meet the front window assembly at
  // x 25.8; at 1.8 m it started at x 24.9 and left an 0.8 m slot at the corner.
  wallSeg(hx - 4.7, hz - HD / 2, 2.8, H2, true, brick, L2b, "L2 wall");
  wallSeg(hx - HW / 2, hz - HD / 2 + 0.7, 1.4, H2, false, brick, L2b, "L2 wall");

  // ── ROOF ASSEMBLY over the east half; west half stays an open terrace ──
  const roofY = L2b + H2;
  solid(10.4, 0.16, HD + 0.4, S.corrugated(), hx + 0.9, roofY, hz, "roof slab");
  // corrugation ribs
  for (let i = 0; i < 26; i++) {
    deco(part(flatBox(0.09, 0.05, HD + 0.4), S.corrugated(), { pos: [hx + 0.9 - 5.1 + i * 0.4, roofY + 0.19, hz], shadow: false }));
  }
  // fascia (vertical board at the eave), soffit (horizontal underside), gutter
  for (const sz of [-1, 1] as const) {
    deco(part(flatBox(10.6, 0.24, 0.05), timber, { pos: [hx + 0.9, roofY + 0.04, hz + sz * (HD / 2 + 0.22)] }));      // fascia
    deco(part(flatBox(10.6, 0.03, 0.42), plank, { pos: [hx + 0.9, roofY - 0.08, hz + sz * (HD / 2 + 0.02)] }));       // soffit
    deco(gutter(10.4, steel, { pos: [hx + 0.9, roofY - 0.06, hz + sz * (HD / 2 + 0.30)], downpipe: sz > 0 ? roofY - y0 - 0.4 : undefined }));
    // soffit vents
    for (const vx of [-3.4, 0, 3.4]) {
      deco(vent(0.5, 0.16, steel, dark, { pos: [hx + 0.9 + vx, roofY - 0.09, hz + sz * (HD / 2 + 0.02)], rot: [Math.PI / 2, 0, 0] }));
    }
  }
  deco(part(flatBox(0.05, 0.24, HD + 0.5), timber, { pos: [hx + 6.1, roofY + 0.04, hz] })); // gable-end barge board
  // chimney: stack, corbelled cap, flue pot
  {
    const cx = hx + 4.6, cz = hz + 2.6;
    solid(0.9, 2.2, 0.9, brick, cx, roofY, cz, "chimney", { collide: false });
    deco(part(flatBox(1.14, 0.14, 1.14), S.concrete(), { pos: [cx, roofY + 2.26, cz] }));
    deco(part(cyl(0.19, 0.22, 0.4, 10), S.barrel(), { pos: [cx, roofY + 2.52, cz] }));
    deco(part(flatBox(1.0, 0.03, 1.0), dark, { pos: [cx, roofY + 0.02, cz], shadow: false })); // flashing
  }

  // ── railings: stairwell edge and terrace edge ──
  const railing = (cx: number, cz: number, len: number, horiz: boolean) => {
    const g = new THREE.Group();
    g.add(part(cyl(0.026, 0.026, len, 6), steel, { pos: [0, 1.0, 0], rot: horiz ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0] }));
    g.add(part(cyl(0.02, 0.02, len, 6), steel, { pos: [0, 0.55, 0], rot: horiz ? [0, 0, Math.PI / 2] : [Math.PI / 2, 0, 0] }));
    const n = Math.max(2, Math.round(len / 0.85));
    for (let i = 0; i <= n; i++) {
      const t = -len / 2 + (i * len) / n;
      g.add(part(flatBox(0.045, 1.0, 0.045), steel, { pos: [horiz ? t : 0, 0.5, horiz ? 0 : t] }));
    }
    unit(g, cx, L2b, cz, "railing", 0, false);
  };
  railing(hx - 4.2, hz + 1.3, 5.4, false);
  railing(hx - HW / 2 + 0.05, hz + 1.3, 5.4, false);
  railing(hx - HW / 2 + 0.9, hz + HD / 2 - 0.05, 1.8, true);

  // ── FURNITURE: every room gets a job ──
  // workshop bench with legs, apron, vice and tool rail
  {
    const bx2 = hx + 3, bz2 = hz - 3.1;
    const g = new THREE.Group();
    g.add(part(flatBox(1.9, 0.07, 0.75), plank, { pos: [0, 0.86, 0] }));
    g.add(part(flatBox(1.8, 0.12, 0.06), timber, { pos: [0, 0.76, -0.33] }));
    for (const sx of [-0.85, 0.85]) for (const sz of [-0.31, 0.31]) {
      g.add(part(flatBox(0.09, 0.83, 0.09), timber, { pos: [sx, 0.42, sz] }));
    }
    g.add(part(flatBox(0.2, 0.16, 0.22), dark, { pos: [-0.72, 0.97, 0.2] }));   // vice
    g.add(part(cyl(0.018, 0.018, 0.3, 6), steel, { pos: [-0.72, 0.97, 0.36], rot: [Math.PI / 2, 0, 0] }));
    g.add(part(flatBox(1.8, 0.5, 0.03), S.ply(), { pos: [0, 1.22, -0.36] }));   // tool board
    for (let i = 0; i < 5; i++) g.add(part(flatBox(0.04, 0.22, 0.04), steel, { pos: [-0.7 + i * 0.35, 1.18, -0.33] }));
    unit(g, bx2, y0, bz2, "workbench");
  }
  // beds: frame, slats, mattress, blanket roll
  const bed = (bx2: number, bz2: number, base: number, role: string) => {
    const g = new THREE.Group();
    for (const sx of [-0.92, 0.92]) g.add(part(flatBox(0.08, 0.42, 1.0), timber, { pos: [sx, 0.21, 0] }));
    g.add(part(flatBox(1.9, 0.06, 1.0), timber, { pos: [0, 0.34, 0] }));
    g.add(part(flatBox(1.82, 0.16, 0.92), surface("CRV05", { tile: 1.2, gamma: 0.75, gain: 1.1 }), { pos: [0, 0.45, 0] }));
    g.add(part(cyl(0.13, 0.13, 0.8, 8), surface("CRV06", { tile: 0.9, gamma: 0.75 }), { pos: [-0.72, 0.6, 0], rot: [Math.PI / 2, 0, Math.PI / 2] }));
    g.add(part(flatBox(0.08, 0.5, 1.0), timber, { pos: [0.95, 0.5, 0] })); // headboard
    unit(g, bx2, base, bz2, role);
  };
  bed(hx + 4.3, hz + 3.1, y0, "bed");
  bed(hx + 4.5, hz - 2.8, L2b, "bunk");
  // living-room table with a lamp
  {
    const g = new THREE.Group();
    g.add(part(flatBox(1.3, 0.06, 1.3), plank, { pos: [0, 0.74, 0] }));
    for (const sx of [-0.55, 0.55]) for (const sz of [-0.55, 0.55]) {
      g.add(part(flatBox(0.08, 0.72, 0.08), timber, { pos: [sx, 0.36, sz] }));
    }
    g.add(part(cyl(0.09, 0.12, 0.06, 10), dark, { pos: [0.3, 0.8, 0.2] }));
    g.add(part(cyl(0.06, 0.09, 0.16, 10), plain(0xffd9a0, 0.5, 0.1, { emissive: 0xffb347, emissiveIntensity: 0.7 }), { pos: [0.3, 0.9, 0.2] }));
    unit(g, hx - 3, y0, hz + 1.5, "table");
  }
  // armory crate upstairs
  {
    const g = new THREE.Group();
    g.add(bev(1.1, 0.8, 0.7, plank, { pos: [0, 0.4, 0] }));
    g.add(part(flatBox(1.14, 0.08, 0.74), timber, { pos: [0, 0.82, 0] }));
    for (const sx of [-0.4, 0.4]) g.add(part(flatBox(0.1, 0.1, 0.76), dark, { pos: [sx, 0.78, 0] }));
    g.add(part(flatBox(0.1, 0.14, 0.05), steel, { pos: [0, 0.6, 0.36] }));
    g.add(bolts(along([-0.45, 0.2, 0.355], [0.45, 0.2, 0.355], 5), steel, 0.013));
    unit(g, hx + 3.5, L2b, hz + 2.5, "armory crate");
  }
}
