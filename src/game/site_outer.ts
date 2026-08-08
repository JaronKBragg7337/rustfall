// Outer-ring expansion — four sites in the new territory between the inhabited
// core and the (400 x 400) world edge:
//
//   1. CRASHED CARGO PLANE (-140, -150) — the outer-ring landmark. A twin-
//      engine prop freighter augered in: nose-down fuselage at a slight roll,
//      tail section 15 m behind the break, one wing sheared off, two engines
//      (one torn loose), a debris trail of cargo, scorched earth. The fuselage
//      interior is WALKABLE through a registered side tear and out the rear
//      break (registered too) over a dirt berm; collision is hand-carved in
//      chunks — no box ever spans the bore or the tear.
//   2. RUINED SUBURBAN BLOCK (-150, 120) — three brick house shells on an
//      overgrown street: doorway + window apertures registered, collapsed
//      roofs (rafters + half-fallen IND01 sheets), interior rubble, a leaning
//      telephone pole with sagging catenary wire, a rusted sedan hulk.
//   3. MILITARY CHECKPOINT (0, 160) — sandbag emplacements, a watchtower
//      platform with ladder + climb volume, jersey barriers, a toppled
//      barrier arm, hazard signage, supply crates, perimeter posts with
//      sagging chain.
//   4. JUNKYARD (172, -108) — crushed-car stack rows, a tire-wall maze
//      fragment, oil stains, and a gantry crane rail pair with a hoist frame.
//
// Same assembly rules as world.ts / site_industrial.ts / site_wash.ts /
// site_base.ts: primary -> secondary -> tertiary; rivets/bolts/tires/bags
// instanced and geometry cached through kit.ts; trim is separate geometry;
// everything grounds through terrain.heightAt(); apertures registered;
// collision carved per child or in honest chunks. Random jitter draws from
// its own stream (makeRng 77031) so every existing RNG sequence is untouched.
//
// Siting was probed against terrain.ts (throwaway script, deleted after):
// all four sites stand >= 51 m from the dry-wash centreline (washDist),
// >= 5 m inside the +/-200 m edge, on ground with |gradient| <= ~0.10, and
// no two sites overlap. The briefed junkyard spot (155, -60) sat ON the wash
// centreline (washDist 0.0) — moved to (172, -108), the flattest probed
// candidate (washDist 54.9, |x| max extent 194).
import * as THREE from "./three";
import { registerAsset, registerAperture, makeRng, type AssetFlags } from "./constants";
import { matOf } from "./textures";
import { plain } from "./surface";
import { bev, bevelBox, part, flatBox, cyl, bolts, rivets, along, hinge, wireSpan, type Placement } from "./kit";
import { heightAt, normalAt } from "./terrain";
import type { WorldRefs } from "./world";

// Domestic aperture set (declared once, used everywhere — doctrine Part 1).
const T = 0.2;                            // masonry thickness, matching world.ts
const DOOR_W = 1.0, DOOR_H = 2.1;
const WIN_W = 1.2, WIN_H = 1.2, WIN_SILL = 0.95;

const steel = () => plain(0x55524d, 0.44, 0.85);
const dark = () => plain(0x34322f, 0.58, 0.8);

// ─────────────────────────── placement helpers ───────────────────────────
// Same contract as makeSiteBuilder in site_industrial.ts / site_wash.ts.
// `unit` here returns the AssetRecord (a superset of the sibling files'
// return — nothing consumed it) so aperture owners can be registered.
function makeOuterBuilder(refs: WorldRefs) {
  const deco = (o: THREE.Object3D, x?: number, y?: number, z?: number): THREE.Object3D => {
    if (x !== undefined) o.position.set(x, y!, z!);
    refs.scene.add(o);
    return o;
  };

  // "children": each structural child gets its own collider; subtrees tagged
  // userData.noCollide never become invisible snags.
  const unit = (
    g: THREE.Group, x: number, y: number, z: number, role: string,
    ry = 0, collide: boolean | "children" = true, flags: AssetFlags = {}
  ) => {
    g.position.set(x, y, z);
    g.rotation.y = ry;
    refs.scene.add(g);
    const rec = registerAsset(role, g, "AST", flags);
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
    return rec;
  };

  return { deco, unit };
}

/** Cylinder between two points — braces, wires, stays (site_base pattern). */
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

/**
 * Chunked axis-aligned colliders for a yaw-rotated slab, copied from
 * site_wash.ts: one AABB per chunk along the slab's length, computed from the
 * real rotated corners — the honest alternative to Box3.setFromObject on a
 * rotated deck, whose single AABB inflates into an invisible wall (doctrine
 * 6B.7). `tops` steps the chunk heights so ramps and pitched floors walk true.
 */
function slabColliders(
  refs: WorldRefs,
  cx: number, cz: number, yaw: number,
  len: number, wid: number,
  bottom: number, tops: number[]
) {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const n = tops.length;
  for (let i = 0; i < n; i++) {
    const z0 = -len / 2 + (i * len) / n;
    const z1 = -len / 2 + ((i + 1) * len) / n;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [lx, lz] of [[-wid / 2, z0], [wid / 2, z0], [-wid / 2, z1], [wid / 2, z1]] as const) {
      const wx = cx + lx * ca + lz * sa;
      const wz = cz - lx * sa + lz * ca;
      minX = Math.min(minX, wx); maxX = Math.max(maxX, wx);
      minZ = Math.min(minZ, wz); maxZ = Math.max(maxZ, wz);
    }
    refs.colliders.push(new THREE.Box3(
      new THREE.Vector3(minX, bottom, minZ),
      new THREE.Vector3(maxX, tops[i], maxZ)
    ));
  }
}

/** Local (x,z) -> world for a yawed site frame. Matches slabColliders' mapping. */
function l2w(ax: number, az: number, yaw: number, lx: number, lz: number): [number, number] {
  return [ax + lx * Math.cos(yaw) + lz * Math.sin(yaw), az - lx * Math.sin(yaw) + lz * Math.cos(yaw)];
}

/**
 * Ground decal — a thin disc conforming to the local terrain normal. Sits
 * within millimetres of the heightfield and declares belowGrade because its
 * uphill edge beds into the slope by design. No collider: you walk over it.
 */
function groundPatch(refs: WorldRefs, x: number, z: number, r: number, mat: THREE.Material, role: string) {
  const gy = heightAt(x, z);
  const n = normalAt(x, z);
  const m = part(cyl(r, r, 0.025, 20), mat, { shadow: false });
  m.position.set(x, gy + 0.02, z);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
  refs.scene.add(m);
  registerAsset(role, m, "AST", { belowGrade: true });
}

// ═══════════════════════════ 1 · CRASHED CARGO PLANE ═══════════════════════════
// Twin-engine prop freighter, augered in on a NW heading. Site frame: yaw
// YA = -0.55 about the anchor; local +Z runs from nose to tail. The fuselage
// is pitched nose-down 0.22 rad with a 0.10 roll; its skin is four arc panels
// per ring segment so the port-side tear (segment 2) is a REAL hole — the
// panels are simply absent there — and all collision is chunked by hand:
// floor as stepped slab chunks, walls as one chunk per segment per side with
// the tear segment's port chunk omitted. The bore stays genuinely walkable.

const PLANE = { x: -140, z: -150, yaw: -0.55, pitch: 0.22, roll: 0.10, R: 1.45, SEG: 3.1, NSEG: 4 } as const;

/** Twin-row radial engine: cowl ring, cowl body, hub, three prop blades. */
function makeEngine(rng: () => number, bent: boolean): THREE.Group {
  const gun = matOf("MET03", 1.5);  // gunmetal cowl
  const dk = dark();
  const st = steel();
  const g = new THREE.Group();
  g.add(part(new THREE.TorusGeometry(0.58, 0.16, 8, 20), gun, { pos: [0, 0, 0] }));
  g.add(part(cyl(0.52, 0.58, 1.15, 16), gun, { pos: [0, 0, -0.55], rot: [Math.PI / 2, 0, 0] }));
  // crankcase face + push-rod bumps behind the cowl lip
  g.add(part(cyl(0.4, 0.4, 0.1, 14), dk, { pos: [0, 0, 0.02], rot: [Math.PI / 2, 0, 0] }));
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    g.add(part(cyl(0.035, 0.035, 0.14, 6), dk, { pos: [Math.cos(a) * 0.33, Math.sin(a) * 0.33, 0.06], rot: [Math.PI / 2, 0, 0] }));
  }
  // prop: hub, spinner, three blades — one bent back on the torn engine
  g.add(part(cyl(0.12, 0.17, 0.35, 10), st, { pos: [0, 0, 0.2], rot: [Math.PI / 2, 0, 0] }));
  g.add(part(cyl(0.02, 0.12, 0.25, 10), gun, { pos: [0, 0, 0.46], rot: [-Math.PI / 2, 0, 0] }));
  for (let k = 0; k < 3; k++) {
    const a = k * (Math.PI * 2 / 3) + rng() * 0.12;
    const bend = bent && k === 1 ? -0.62 : (bent ? -0.18 : 0);
    g.add(bev(0.14, 1.1, 0.045, dk, {
      pos: [-0.62 * Math.sin(a), 0.62 * Math.cos(a), 0.18],
      rot: [bend, 0, a],
    }));
  }
  // exhaust stubs under the cowl
  for (const sx of [-0.25, 0, 0.25]) {
    g.add(part(cyl(0.045, 0.05, 0.3, 6), dk, { pos: [sx, -0.5, -0.35], rot: [0.5, 0, 0] }));
  }
  return g;
}

function buildCrashSite(refs: WorldRefs, rng: () => number) {
  const { deco, unit } = makeOuterBuilder(refs);
  const { x: AX, z: AZ, yaw: YA, pitch: P, roll: RL, R, SEG, NSEG } = PLANE;
  const gy0 = heightAt(AX, AZ);
  const olive = matOf("MET02", 3);            // olive armor skin
  const skin = olive.clone();                 // the bore is walkable — line it
  skin.side = THREE.DoubleSide;
  const gun = matOf("MET03", 2);              // gunmetal structure
  const tread = matOf("MET05", 1.5);          // cargo floor
  const glass = matOf("CRV08", 1);            // cracked cockpit glazing
  const dk = dark();
  const st = steel();

  // ── the fuselage ──
  // Origin: nose-plane tube centre, embedded so the nose buries ~2 m
  // (belowGrade, declared). Children live in a noCollide shell: every collider
  // is pushed by hand below, chunked and carved around the tear.
  const f = new THREE.Group();
  f.position.set(AX, gy0 - 0.55, AZ);
  f.rotation.order = "YXZ";
  f.rotation.set(-P, YA, RL);
  const shell = new THREE.Group();
  shell.userData.noCollide = true;
  f.add(shell);

  // skin arc panels: 4 per ring segment; theta maps local (r sin t, -r cos t)
  const ARC = Math.PI / 2;
  const SIDES = [
    { name: "bottom", t0: -ARC / 2 },
    { name: "starboard", t0: ARC / 2 },
    { name: "top", t0: 3 * ARC / 2 },
    { name: "port", t0: 5 * ARC / 2 },
  ];
  const TEAR_SEG = 2; // port panel of this segment is GONE — the walk-in tear
  for (let i = 0; i < NSEG; i++) {
    const mid = i * SEG + SEG / 2;
    for (const s of SIDES) {
      if (i === TEAR_SEG && s.name === "port") continue;
      const geo = new THREE.CylinderGeometry(R, R, SEG - 0.06, 12, 1, true, s.t0, ARC);
      shell.add(part(geo, skin, { pos: [0, 0, mid], rot: [Math.PI / 2, 0, 0] }));
    }
  }
  // frame rings at the segment joints + torn rim at the break
  for (const z of [SEG, SEG * 2, SEG * 3]) {
    shell.add(part(new THREE.TorusGeometry(R - 0.06, 0.05, 6, 22), gun, { pos: [0, 0, z] }));
  }
  shell.add(part(new THREE.TorusGeometry(R - 0.03, 0.06, 6, 22, 4.4), gun, { pos: [0, 0, SEG * NSEG], rot: [0, 0, 0.7] }));
  // torn skin petals at the break and around the tear
  for (let i = 0; i < 6; i++) {
    const a = 0.7 + i * 0.75;
    shell.add(part(flatBox(0.46, 0.035, 0.72), skin, {
      pos: [Math.sin(a) * (R + 0.12), -Math.cos(a) * (R + 0.12), SEG * NSEG + 0.28],
      rot: [0.5 + rng() * 0.4, 0, a],
    }));
  }
  for (const tz of [SEG * TEAR_SEG + 0.1, SEG * (TEAR_SEG + 1) - 0.1]) {
    shell.add(part(flatBox(0.5, 0.035, 0.8), skin, {
      pos: [-R - 0.08, 0.3, tz], rot: [0, 0.5, 0.9 + rng() * 0.3],
    }));
  }
  // cargo floor: real tread plates, one per segment, on two longeron rails
  for (let i = 0; i < NSEG; i++) {
    shell.add(part(flatBox(1.9, 0.05, SEG - 0.1), tread, { pos: [0, -1.15, i * SEG + SEG / 2] }));
  }
  for (const sx of [-0.85, 0.85]) {
    shell.add(part(flatBox(0.08, 0.1, SEG * NSEG - 0.2), gun, { pos: [sx, -1.22, SEG * NSEG / 2] }));
  }
  // longerons at the panel joints
  for (const [lx, ly] of [[1.03, -1.03], [-1.03, -1.03], [1.03, 1.03], [-1.03, 1.03]] as const) {
    shell.add(part(flatBox(0.06, 0.06, SEG * NSEG - 0.2), gun, { pos: [lx, ly, SEG * NSEG / 2] }));
  }
  // rivet bands at every frame station — instanced, domes facing outward
  const rv: Placement[] = [];
  for (const z of [0.05, SEG, SEG * 2, SEG * 3, SEG * NSEG - 0.05]) {
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      rv.push({ pos: [Math.sin(a) * (R + 0.015), -Math.cos(a) * (R + 0.015), z], rot: [0, 0, a + Math.PI] });
    }
  }
  shell.add(rivets(rv, st));

  // nose cone + cockpit glazing + instrument glareshield behind it
  const nose = part(cyl(R, 0.3, 2.4, 16), skin, { pos: [0, 0, -1.2], rot: [Math.PI / 2, 0, 0] });
  shell.add(nose);
  shell.add(part(flatBox(0.52, 0.5, 0.03), glass, { pos: [0, 0.62, -2.02], rot: [-0.52, 0, 0], shadow: false }));
  for (const sx of [-1, 1]) {
    shell.add(part(flatBox(0.5, 0.46, 0.03), glass, { pos: [sx * 0.52, 0.42, -1.86], rot: [-0.45, sx * -0.58, 0], shadow: false }));
  }
  shell.add(part(flatBox(1.1, 0.22, 0.4), dk, { pos: [0, 0.28, -1.55], rot: [0.25, 0, 0] }));
  for (const sx of [-0.3, 0.3]) {
    shell.add(part(cyl(0.02, 0.02, 0.3, 6), dk, { pos: [sx, 0.05, -1.45], rot: [0.5, 0, 0] }));
  }
  // cockpit bulkhead at z 0.15 — the nose stays sealed, honestly
  shell.add(part(cyl(R - 0.04, R - 0.04, 0.08, 16), gun, { pos: [0, 0, 0.15], rot: [Math.PI / 2, 0, 0] }));
  shell.add(part(flatBox(0.5, 0.7, 0.06), dk, { pos: [0.3, -0.2, 0.22] }));

  // cargo still in the hold, riding the floor
  shell.add(bev(0.7, 0.6, 0.7, matOf("IND03", 1), { pos: [0.3, -0.82, 3.6], rot: [0, 0.3, 0] }));
  shell.add(bev(0.55, 0.5, 0.55, matOf("IND03", 1), { pos: [-0.42, -0.87, 4.6], rot: [0, -0.2, 0] }));
  shell.add(part(cyl(0.29, 0.29, 0.88, 14), matOf("CRV07", 1), { pos: [0.15, -0.68, 5.6] }));

  // starboard wing stub, sheared at 4 m: spar, skin, broken tip, flap+hinges
  shell.add(part(flatBox(3.4, 0.16, 1.2), gun, { pos: [2.6, 0.15, 4.4], rot: [0, 0, 0.06] }));
  shell.add(part(flatBox(3.5, 0.05, 1.8), skin, { pos: [2.65, 0.26, 4.4], rot: [0, 0, 0.06] }));
  shell.add(part(flatBox(3.5, 0.05, 1.8), skin, { pos: [2.65, 0.02, 4.4], rot: [0, 0, 0.06] }));
  for (let i = 0; i < 3; i++) {
    shell.add(part(flatBox(0.7, 0.05, 0.5), skin, {
      pos: [4.35 + rng() * 0.2, 0.14, 3.8 + i * 0.55], rot: [0, 0.3 * (rng() - 0.5), 0.35 + rng() * 0.4],
    }));
  }
  shell.add(part(flatBox(2.2, 0.04, 0.5), skin, { pos: [2.3, -0.04, 5.42], rot: [0.18, 0, 0.06] }));
  for (const hx of [1.55, 3.05]) {
    shell.add(hinge(0.4, gun, st, { pos: [hx, 0.02, 5.18], rot: [0, 0, Math.PI / 2] }));
  }
  // port wing root stump — the rest sheared off (lies 15 m away, below)
  shell.add(part(flatBox(1.3, 0.16, 1.4), gun, { pos: [-1.6, 0.18, 4.4], rot: [0, 0, -0.2] }));
  shell.add(part(flatBox(0.9, 0.05, 1.2), skin, { pos: [-2.1, 0.1, 4.4], rot: [0, 0, -0.5] }));

  // engine A, still on the stub wing, nose into the dirt
  const engA = makeEngine(rng, false);
  engA.position.set(2.9, -0.05, 3.1);
  engA.rotation.y = Math.PI; // faces the nose
  shell.add(engA);

  refs.scene.add(f);
  f.updateMatrixWorld(true);
  const fusRec = registerAsset("crashed freighter fuselage", f, "AST", { belowGrade: true, interpenetrates: true });

  // ── hand-carved collision for the fuselage (shell is noCollide) ──
  const lw = (lx: number, ly: number, lz: number) => f.localToWorld(new THREE.Vector3(lx, ly, lz));
  // floor: 8 stepped chunks — a walkable ramp rising toward the break
  {
    const LEN = SEG * NSEG, N = 8;
    const tops: number[] = [];
    for (let i = 0; i < N; i++) tops.push(lw(0, -1.1, ((i + 1) * LEN) / N).y);
    const [cx, cz] = l2w(AX, AZ, YA, 0, LEN / 2);
    slabColliders(refs, cx, cz, YA, LEN, 1.9, lw(0, -1.15, 0).y - 0.5, tops);
  }
  // walls: one chunk per segment per side; the tear segment's port chunk is
  // simply never pushed — the opening is carved by omission
  for (let i = 0; i < NSEG; i++) {
    const z0 = i * SEG + 0.03, z1 = (i + 1) * SEG - 0.03;
    for (const s of [-1, 1] as const) {
      if (i === TEAR_SEG && s === -1) continue;
      const [cx, cz] = l2w(AX, AZ, YA, s * 1.3, (z0 + z1) / 2);
      slabColliders(refs, cx, cz, YA, z1 - z0, 0.4,
        lw(s * 1.3, -1.35, z0).y - 0.05, [lw(s * 1.3, 1.35, z1).y + 0.05]);
    }
  }
  // cockpit bulkhead
  {
    const [cx, cz] = l2w(AX, AZ, YA, 0, 0.15);
    slabColliders(refs, cx, cz, YA, 0.35, 2.7, lw(0, -1.4, 0.15).y, [lw(0, 1.4, 0.15).y]);
  }
  // nose cone + engine A: compact solids, conservative AABBs
  refs.colliders.push(new THREE.Box3().setFromObject(nose));
  refs.colliders.push(new THREE.Box3().setFromObject(engA));
  // wing stub: two thin chunks
  {
    const [cx, cz] = l2w(AX, AZ, YA, 2.65, 4.4);
    slabColliders(refs, cx, cz, YA + Math.PI / 2, 3.5, 1.9,
      lw(2.65, -0.1, 4.4).y - 0.1, [lw(2.65, 0.32, 4.4).y + 0.08, lw(2.65, 0.32, 4.4).y + 0.08]);
  }

  // the tear and the rear break are registered apertures — they must stay open
  const tearC = lw(-1.42, 0.05, SEG * TEAR_SEG + SEG / 2);
  registerAperture(fusRec.id, { x: tearC.x, y: tearC.y, z: tearC.z }, 2.6, 1.9, "x");
  const breakC = lw(0, 0, SEG * NSEG + 0.05);
  registerAperture(fusRec.id, { x: breakC.x, y: breakC.y, z: breakC.z }, 1.9, 2.0, "z");

  // ── dirt berm: stepped ramp up to the rear break (two-way exit) ──
  {
    const berm = new THREE.Group();
    const dirt = matOf("TER02", 2);
    const steps: Array<[number, number, number, number]> = [ // lz, top, w, d
      [SEG * NSEG + 1.1, 0.45, 2.6, 1.6],
      [SEG * NSEG + 2.3, 0.85, 2.4, 1.4],
      [SEG * NSEG + 3.4, 1.2, 2.2, 1.2],
    ];
    for (const [lz, top, w, d] of steps) {
      berm.add(bev(w, 0.6, d, dirt, { pos: [0, top - 0.3 - gy0, lz], radius: 0.1 }));
    }
    const [bx, bz] = l2w(AX, AZ, YA, 0, 0);
    unit(berm, bx, gy0, bz, "dirt berm", YA, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── tail section, 15 m behind the break, rolled onto its side ──
  {
    const [tx, tz] = l2w(AX, AZ, YA, 1.5, 27);
    const gyT = heightAt(tx, tz);
    const t = new THREE.Group();
    // tapering tail cone, torn rim, stringers
    t.add(part(cyl(0.75, 1.35, 6.0, 16), skin, { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] }));
    t.add(part(new THREE.TorusGeometry(1.3, 0.06, 6, 20, 4.0), gun, { pos: [0, 0, -3], rot: [0, 0, 0.9] }));
    for (let i = 0; i < 4; i++) {
      const a = 0.9 + i * 1.1;
      t.add(part(flatBox(0.42, 0.035, 0.66), skin, {
        pos: [Math.sin(a) * 1.42, Math.cos(a) * 1.42, -3.25], rot: [0.55, 0, a],
      }));
    }
    for (const [lx, ly] of [[0.9, 0.9], [-0.9, 0.9], [0.9, -0.9], [-0.9, -0.9]] as const) {
      t.add(part(flatBox(0.05, 0.05, 5.8), gun, { pos: [lx * 0.78, ly * 0.78, 0] }));
    }
    // fin + rudder with real hinges; stabilizers + elevators the same
    t.add(part(flatBox(0.09, 2.6, 1.9), skin, { pos: [0, 1.3, 1.85], rot: [-0.32, 0, 0] }));
    t.add(part(flatBox(0.06, 2.2, 0.8), skin, { pos: [0, 1.15, 2.9], rot: [-0.14, 0, 0] }));
    for (const hy of [0.45, 1.15, 1.85]) {
      t.add(hinge(0.42, gun, st, { pos: [0, hy, 2.52], rot: [0, 0, 0] }));
    }
    for (const sx of [-1, 1] as const) {
      t.add(part(flatBox(2.5, 0.07, 1.15), skin, { pos: [sx * 1.35, 0.45, 1.6], rot: [0, 0, sx * -0.08] }));
      t.add(part(flatBox(2.3, 0.05, 0.5), skin, { pos: [sx * 1.3, 0.4, 2.4], rot: [0.1, 0, sx * -0.08] }));
      for (const ex of [0.6, 1.7]) {
        t.add(hinge(0.36, gun, st, { pos: [sx * ex, 0.46, 2.12], rot: [0, 0, Math.PI / 2] }));
      }
    }
    // oxygen bottles + a seat frame spilled at the break mouth
    t.add(part(cyl(0.09, 0.09, 0.6, 8), matOf("CRV09", 1), { pos: [0.4, -0.9, -3.6], rot: [1.2, 0, 0.4] }));
    t.add(part(flatBox(0.5, 0.06, 0.5), gun, { pos: [-0.5, -1.0, -3.8], rot: [0.3, 0.7, 0] }));
    unit(t, tx, gyT + 0.55, tz, "freighter tail section", YA + 0.35, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── sheared port wing, flat on the ground 15 m off the port side ──
  {
    const [wx, wz] = l2w(AX, AZ, YA, -14, 6);
    const gyW = heightAt(wx, wz);
    const w = new THREE.Group();
    w.add(part(flatBox(5.8, 0.09, 1.7), skin, { pos: [0, 0, 0] }));
    w.add(part(flatBox(5.8, 0.07, 1.7), skin, { pos: [0, -0.14, 0] }));
    w.add(part(flatBox(6.2, 0.14, 0.18), gun, { pos: [-0.2, -0.06, -0.2] })); // exposed spar at the tear
    w.add(part(flatBox(2.2, 0.07, 1.5), skin, { pos: [3.9, 0.05, 0.1], rot: [0, 0, 0.12] })); // tip panel, kinked
    for (let i = 0; i < 3; i++) {
      w.add(part(flatBox(0.6, 0.05, 0.45), skin, {
        pos: [-3.0 - rng() * 0.3, 0.02, -0.5 + i * 0.5], rot: [0, 0.3 * (rng() - 0.5), -0.3 - rng() * 0.3],
      }));
    }
    // aileron with its hinges, flap-track fairings, tip light housing
    w.add(part(flatBox(2.6, 0.05, 0.45), skin, { pos: [-1.2, -0.02, 1.05], rot: [0.12, 0, 0] }));
    for (const hx of [-2.1, -0.3]) w.add(hinge(0.36, gun, st, { pos: [hx, 0.02, 0.86], rot: [0, 0, Math.PI / 2] }));
    for (const fx of [0.8, 2.0]) w.add(bev(0.24, 0.12, 0.9, gun, { pos: [fx, -0.16, 0.9] }));
    w.add(part(cyl(0.06, 0.08, 0.14, 8), dk, { pos: [4.95, 0.1, 0.1] }));
    unit(w, wx, gyW + 0.2, wz, "sheared wing", YA - 0.9, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── engine B, torn loose, half-buried in the debris field ──
  {
    const [ex, ez] = l2w(AX, AZ, YA, 5.5, 9.5);
    const gyE = heightAt(ex, ez);
    const e = makeEngine(rng, true);
    unit(e, ex, gyE + 0.1, ez, "freighter engine", rng() * Math.PI, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── debris trail: cargo spilled from the break toward the tail ──
  {
    const debris = new THREE.Group();
    const crateMat = matOf("IND03", 1.5);
    const drumMat = matOf("CRV07", 1);
    const panelMat = matOf("MET03", 1.5);
    const [dcx, dcz] = l2w(AX, AZ, YA, 1.5, 23.5); // trail centroid
    for (let i = 0; i < 12; i++) {
      const t = i / 11;
      const lx = 0.5 + 2 * t + (rng() - 0.5) * 6;
      const lz = 13.5 + 20.5 * t + (rng() - 0.5) * 3;
      const [dx, dz] = l2w(AX, AZ, YA, lx, lz);
      const gy = heightAt(dx, dz);
      const kind = i % 4;
      const d = new THREE.Group();
      if (kind === 0) {
        d.add(bev(0.62, 0.55, 0.62, crateMat, { pos: [0, 0.2, 0], rot: [0, rng() * 3, 0] }));
        d.add(bev(0.5, 0.4, 0.5, crateMat, { pos: [0.55, 0.12, 0.3], rot: [0.2, rng() * 3, 0.15] }));
      } else if (kind === 1) {
        const drum = new THREE.Group();
        drum.add(part(cyl(0.29, 0.29, 0.88, 14), drumMat, { pos: [0, 0.44, 0] }));
        for (const hy of [0.28, 0.6]) drum.add(part(cyl(0.305, 0.305, 0.05, 14), drumMat, { pos: [0, hy, 0] }));
        drum.rotation.z = Math.PI / 2;
        drum.rotation.y = rng() * Math.PI;
        drum.position.y = 0.24;
        d.add(drum);
      } else if (kind === 2) {
        d.add(part(flatBox(1.3, 0.05, 0.9), panelMat, { pos: [0, 0.1, 0], rot: [0.25 * (rng() - 0.5), rng() * 3, 0.3 * (rng() - 0.5)] }));
        d.add(part(flatBox(0.7, 0.04, 0.5), skin, { pos: [0.5, 0.06, 0.4], rot: [0.4, rng() * 3, 0.2] }));
      } else {
        d.add(part(cyl(0.32, 0.32, 0.7, 12), matOf("CRV05", 1), { pos: [0, 0.2, 0], rot: [1.35, rng() * 3, 0] }));
      }
      d.position.set(dx - dcx, gy - 0.08, dz - dcz);
      debris.add(d);
    }
    // children carry positions relative to the trail centroid; pieces are
    // half-buried in the scoured ground by design
    unit(debris, dcx, 0, dcz, "crash debris", 0, "children", { belowGrade: true, interpenetrates: true });
  }

  // small instanced scrap along the same trail — dressing, never collides
  {
    const places: Placement[] = [];
    for (let i = 0; i < 20; i++) {
      const t = rng();
      const lx = 0.5 + 2 * t + (rng() - 0.5) * 8;
      const lz = 12 + 23 * t + (rng() - 0.5) * 4;
      const [sx2, sz2] = l2w(AX, AZ, YA, lx, lz);
      places.push({ pos: [sx2, heightAt(sx2, sz2) + 0.03, sz2], rot: [rng() * 0.6, rng() * 3, rng() * 0.6] });
    }
    deco(instancedPlaces(flatBox(0.32, 0.04, 0.22), matOf("MET03", 1), places));
  }

  // ── scorched earth: under engine A, engine B, and the break ──
  for (const [lx, lz, r] of [[2.2, 2.6, 2.6], [5.2, 9.8, 2.2], [0.8, 16.5, 2.9]] as const) {
    const [sx2, sz2] = l2w(AX, AZ, YA, lx, lz);
    groundPatch(refs, sx2, sz2, r, matOf("TER05", 3), "scorch patch");
  }
}

// ═══════════════════════════ 2 · RUINED SUBURBAN BLOCK ═══════════════════════════
// Three house shells on an overgrown east-west street, ~7 x 5.5 m footprints,
// rooms 3-4 m, domestic aperture set. Walls are built as piers / sills /
// lintels around real openings, so collision is honest by construction and
// every opening is registered. Roofs are fallen in: rafters and IND01 sheets
// get chunked colliders (a 55° lean inflates a plain AABB into a wall — 6B.7).

interface Opening { cx: number; w: number; sill: number; h: number }

/** One straight wall run along local +X, centred at x 0, base at y 0. */
function wallRun(len: number, top: number, ops: Opening[], mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  let cur = -len / 2;
  const sorted = [...ops].sort((a, b) => a.cx - b.cx);
  for (const o of sorted) {
    const x0 = o.cx - o.w / 2, x1 = o.cx + o.w / 2;
    if (x0 - cur > 0.04) g.add(bev(x0 - cur, top, T, mat, { pos: [(cur + x0) / 2, top / 2, 0] }));
    if (o.sill > 0.04) g.add(bev(o.w, o.sill, T, mat, { pos: [o.cx, o.sill / 2, 0] }));
    const linH = top - o.sill - o.h;
    if (linH > 0.04) g.add(bev(o.w, linH, T, mat, { pos: [o.cx, o.sill + o.h + linH / 2, 0] }));
    cur = x1;
  }
  if (len / 2 - cur > 0.04) g.add(bev(len / 2 - cur, top, T, mat, { pos: [(cur + len / 2) / 2, top / 2, 0] }));
  return g;
}

function buildHouse(
  refs: WorldRefs, rng: () => number, hx: number, hz: number,
  opts: {
    w: number; d: number;
    wallMat: THREE.Material; gableMat: THREE.Material;
    tops: { front: number; back: number; left: number; right: number };
    partition: boolean; chimney: boolean; sheetOutside: boolean;
  }
) {
  const { unit } = makeOuterBuilder(refs);
  const { w, d } = opts;
  const gy = heightAt(hx, hz);
  const slabTop = 0.10;
  const h = new THREE.Group();

  // foundation slab, edges proud of the ground like a real raft
  h.add(bev(w + 0.2, 0.16, d + 0.2, matOf("IND04", 3), { pos: [0, 0.02, 0] }));

  // front wall (faces the street, -z): door + two windows
  const front = wallRun(w, opts.tops.front, [
    { cx: 0.9, w: DOOR_W, sill: 0, h: DOOR_H },
    { cx: -2.1, w: WIN_W, sill: WIN_SILL, h: WIN_H },
    { cx: 2.5, w: WIN_W, sill: WIN_SILL, h: WIN_H },
  ], opts.wallMat);
  front.position.set(0, slabTop, -d / 2 + T / 2);
  h.add(front);
  // back wall: two windows
  const back = wallRun(w, opts.tops.back, [
    { cx: -1.6, w: WIN_W, sill: WIN_SILL, h: WIN_H },
    { cx: 1.6, w: WIN_W, sill: WIN_SILL, h: WIN_H },
  ], opts.wallMat);
  back.position.set(0, slabTop, d / 2 - T / 2);
  h.add(back);
  // gables run between front and back
  const left = wallRun(d - 2 * T, opts.tops.left, [], opts.gableMat);
  left.rotation.y = Math.PI / 2;
  left.position.set(-w / 2 + T / 2, slabTop, 0);
  h.add(left);
  const right = wallRun(d - 2 * T, opts.tops.right, [{ cx: 0, w: WIN_W, sill: WIN_SILL, h: WIN_H }], opts.gableMat);
  right.rotation.y = Math.PI / 2;
  right.position.set(w / 2 - T / 2, slabTop, 0);
  h.add(right);
  // interior partition with its own doorway — rooms read as rooms
  if (opts.partition) {
    const part0 = wallRun(d - 2 * T, Math.min(2.6, opts.tops.front, opts.tops.back), [
      { cx: -0.6, w: DOOR_W, sill: 0, h: DOOR_H },
    ], opts.gableMat);
    part0.rotation.y = Math.PI / 2;
    part0.position.set(0.4, slabTop, 0);
    h.add(part0);
  }

  // chimney breast on the back-left corner
  if (opts.chimney) {
    h.add(bev(0.6, opts.tops.back + 0.6, 0.6, opts.wallMat, { pos: [-w / 2 + 0.9, (opts.tops.back + 0.6) / 2, d / 2 - 1.0] }));
    h.add(bev(1.3, 0.85, 0.5, opts.wallMat, { pos: [-w / 2 + 0.9, 0.42, d / 2 - 1.35] }));
    h.add(part(flatBox(0.5, 0.5, 0.04), dark(), { pos: [-w / 2 + 0.9, 0.62, d / 2 - 1.61] })); // hearth mouth
  }

  // interior rubble — low enough to step over, clear of every registered opening
  const rub = new THREE.Group();
  rub.userData.noCollide = true;
  const rubMat = matOf("TER07", 2);
  const spots: Array<[number, number]> = [[-2.2, 0.8], [-1.2, -1.4], [1.9, 1.3], [2.6, -0.9], [-2.7, -0.3]];
  const nR = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < nR; i++) {
    const [sx, sz] = spots[i % spots.length];
    const s = 0.3 + rng() * 0.35;
    rub.add(bev(s, s * 0.55, s * 0.8, rubMat, {
      pos: [sx + (rng() - 0.5) * 0.4, slabTop + s * 0.18, sz + (rng() - 0.5) * 0.4],
      rot: [rng() * 0.4, rng() * 3, rng() * 0.4],
    }));
  }
  // two fallen rafters lying flat in the rubble
  for (const [rx, rz, ra] of [[-0.6, 0.4, 0.4], [1.4, -1.7, 1.9]] as const) {
    rub.add(part(flatBox(0.07, 0.14, 3.2), matOf("IND03", 2), { pos: [rx, slabTop + 0.08, rz], rot: [0, ra, 0] }));
  }
  h.add(rub);

  const rec = unit(h, hx, gy - 0.06, hz, "house shell", 0, "children", { belowGrade: true });

  // ── registered apertures (only where the wall still stands above them) ──
  const doorY = gy + slabTop + DOOR_H / 2;
  const winY = gy + slabTop + WIN_SILL + WIN_H / 2;
  if (opts.tops.front >= DOOR_H + 0.2) {
    registerAperture(rec.id, { x: hx + 0.9, y: doorY, z: hz - d / 2 }, DOOR_W, DOOR_H, "z");
  }
  if (opts.tops.front >= WIN_SILL + WIN_H + 0.1) {
    for (const cx of [-2.1, 2.5]) registerAperture(rec.id, { x: hx + cx, y: winY, z: hz - d / 2 }, WIN_W, WIN_H, "z");
  }
  if (opts.tops.back >= WIN_SILL + WIN_H + 0.1) {
    for (const cx of [-1.6, 1.6]) registerAperture(rec.id, { x: hx + cx, y: winY, z: hz + d / 2 }, WIN_W, WIN_H, "z");
  }
  if (opts.tops.right >= WIN_SILL + WIN_H + 0.1) {
    registerAperture(rec.id, { x: hx + w / 2, y: winY, z: hz }, WIN_W, WIN_H, "x");
  }
  if (opts.partition) {
    registerAperture(rec.id, { x: hx + 0.4, y: doorY, z: hz - 0.6 }, DOOR_W, DOOR_H, "x");
  }

  // ── collapsed roof: leaning rafters + half-fallen IND01 sheets ──
  // Chunked colliders, pushed by hand; the meshes are noCollide dressing.
  const rf = new THREE.Group();
  rf.userData.noCollide = true;
  const raftMat = matOf("IND03", 2);
  const sheetMat = matOf("IND01", 2);
  const rafters: Array<[number, number, number]> = []; // [x, z, dirSign]
  const nLean = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < nLean; i++) {
    const rx = -w / 2 + 1.0 + i * ((w - 2) / Math.max(1, nLean - 1)) + (rng() - 0.5) * 0.5;
    const dir = i % 2 === 0 ? 1 : -1;
    rafters.push([rx, dir * (d / 2 - 1.15), dir]);
  }
  for (const [rx, rz, dir] of rafters) {
    rf.add(part(flatBox(0.07, 0.16, 3.3), raftMat, {
      pos: [rx, slabTop + 1.28, rz - dir * 0.75], rot: [dir * 0.98, 0, 0],
    }));
    // honest chunks for the lean: plan 1.8 m long, thin, stepped tops
    const topBase = gy + slabTop;
    slabColliders(refs, hx + rx, hz + rz - dir * 0.75, 0, 1.8, 0.2, topBase,
      dir > 0 ? [topBase + 0.7, topBase + 1.6, topBase + 2.4] : [topBase + 2.4, topBase + 1.6, topBase + 0.7]);
  }
  // corrugated sheet slumped over the back wall into the interior
  {
    const sx = 0.8, sz = d / 2 - 1.15;
    rf.add(part(flatBox(2.6, 0.04, 2.4), sheetMat, { pos: [sx, slabTop + opts.tops.back - 0.55, sz], rot: [0.5, 0, 0] }));
    slabColliders(refs, hx + sx, hz + sz, 0, 2.1, 2.6, gy + slabTop,
      [gy + slabTop + opts.tops.back - 1.4, gy + slabTop + opts.tops.back - 0.2]);
  }
  // and one sheet leaning on the OUTSIDE of the front wall
  if (opts.sheetOutside) {
    const sx = -1.5, sz = -d / 2 - 0.98;
    rf.add(part(flatBox(2.8, 0.04, 2.3), sheetMat, { pos: [sx, slabTop + 1.22, sz], rot: [-0.95, 0, 0] }));
    slabColliders(refs, hx + sx, hz + sz, 0, 1.9, 2.8, gy - 0.1,
      [gy + 0.9, gy + 1.8, gy + 2.6]);
  }
  h.add(rf);
  // re-ground the group matrix after late additions, then nothing else to do —
  // rf carries no colliders of its own beyond the chunks above
  h.updateMatrixWorld(true);
  return rec;
}

function buildSuburb(refs: WorldRefs, rng: () => number) {
  const { deco, unit } = makeOuterBuilder(refs);
  const brick = matOf("STR03", 2.4);
  const dmgBrick = matOf("IND05", 2.4);

  buildHouse(refs, rng, -166, 123, {
    w: 7.2, d: 5.6, wallMat: brick, gableMat: brick,
    tops: { front: 3.0, back: 2.2, left: 2.6, right: 2.1 },
    partition: true, chimney: true, sheetOutside: false,
  });
  buildHouse(refs, rng, -152, 123.4, {
    w: 7.6, d: 6.0, wallMat: dmgBrick, gableMat: brick,
    tops: { front: 2.8, back: 3.0, left: 1.5, right: 2.4 },
    partition: false, chimney: false, sheetOutside: true,
  });
  buildHouse(refs, rng, -138, 122.6, {
    w: 6.8, d: 5.2, wallMat: brick, gableMat: dmgBrick,
    tops: { front: 3.0, back: 1.8, left: 2.4, right: 2.8 },
    partition: true, chimney: false, sheetOutside: false,
  });

  // ── the street: patched-asphalt slabs conforming to the ground ──
  {
    const places: Placement[] = [];
    for (let i = 0; i < 6; i++) {
      const sx = -169 + i * 8.0;
      const sz = 116.5;
      const n = normalAt(sx, sz);
      places.push({
        pos: [sx, heightAt(sx, sz) + 0.02, sz],
        rot: [Math.atan2(n.z, n.y), 0, -Math.atan2(n.x, n.y)],
      });
    }
    const street = instancedPlaces(flatBox(8.2, 0.05, 5.0), matOf("IND07", 4), places);
    deco(street);
    registerAsset("street patch", street, "AST", { belowGrade: true });
  }
  // driveway aprons to the sedan and house C's gable
  for (const [dx, dz] of [[-146.8, 119.4], [-134.9, 120.0]] as const) {
    const n = normalAt(dx, dz);
    const p = part(flatBox(3.0, 0.05, 3.4), matOf("IND07", 4), {
      pos: [dx, heightAt(dx, dz) + 0.02, dz],
      rot: [Math.atan2(n.z, n.y), 0, -Math.atan2(n.x, n.y)],
      shadow: false,
    });
    deco(p);
    registerAsset("driveway patch", p, "AST", { belowGrade: true });
  }

  // ── rusted sedan hulk in the driveway of house B ──
  {
    const sx = -147.0, sz = 119.2, gy = heightAt(sx, sz);
    const rust = matOf("MET01", 1.5);
    const dk = dark();
    const c = new THREE.Group();
    c.add(bev(4.35, 0.5, 1.74, rust, { pos: [0, 0.45, 0], radius: 0.08 }));       // body tub
    c.add(bev(0.6, 0.35, 0.7, dk, { pos: [0, 0.62, -1.35] }));                    // engine block under the gap
    c.add(part(flatBox(1.5, 0.05, 1.62), rust, { pos: [0, 0.78, -1.38], rot: [0.12, 0, 0] }));  // hood, gaped
    c.add(part(flatBox(1.3, 0.05, 1.6), rust, { pos: [0, 0.74, 1.5], rot: [-0.08, 0, 0] }));    // trunk lid
    for (const [px, pz] of [[-0.95, -0.72], [0.95, -0.72], [-0.95, 0.72], [0.95, 0.72]] as const) {
      c.add(part(flatBox(0.07, 0.55, 0.07), rust, { pos: [px, 0.97, pz] }));      // cabin pillars
    }
    c.add(part(flatBox(2.15, 0.06, 1.58), rust, { pos: [0, 1.28, 0] }));          // roof skin
    c.add(bev(0.5, 0.4, 0.5, matOf("CRV06", 1), { pos: [-0.45, 0.75, 0.1], radius: 0.08 }));  // seats
    c.add(bev(0.5, 0.4, 0.5, matOf("CRV06", 1), { pos: [0.45, 0.75, 0.1], radius: 0.08, rot: [0, 0.3, 0] }));
    const tyre = matOf("CRV03", 1);
    for (const [wx2, wz2] of [[-0.82, -1.35], [0.82, -1.35], [-0.82, 1.35]] as const) {
      c.add(part(new THREE.TorusGeometry(0.34, 0.125, 10, 18), tyre, { pos: [wx2, 0.34, wz2], rot: [0, 0, Math.PI / 2] }));
    }
    c.add(part(cyl(0.16, 0.16, 0.06, 10), dk, { pos: [0.82, 0.3, 1.35], rot: [0, 0, Math.PI / 2] })); // 4th wheel gone
    unit(c, sx, gy - 0.04, sz, "sedan hulk", 0.5, "children");
  }

  // ── leaning telephone pole + snapped stub, sagging catenary between ──
  {
    const px = -163, pz = 116.2, gy = heightAt(px, pz);
    const wood = matOf("IND03", 1.5);
    const dk = dark();
    const p = new THREE.Group();
    const lean = -0.16; // toward -z, away from the houses
    p.add(part(cyl(0.13, 0.17, 7.2, 10), wood, { pos: [0, 2.95, -0.57], rot: [lean, 0, 0] }));
    p.add(part(flatBox(2.3, 0.09, 0.09), wood, { pos: [0, 5.85, -1.02], rot: [lean, 0, 0] }));
    const trim = new THREE.Group();
    trim.userData.noCollide = true;
    for (const ix of [-0.95, 0, 0.95]) {
      trim.add(part(cyl(0.03, 0.04, 0.09, 6), dk, { pos: [ix, 5.93, -1.04] }));
    }
    // snapped stub pole 18 m down the street
    const stx = -144.5, stz = 116.6, gy2 = heightAt(stx, stz);
    const stub = new THREE.Group();
    stub.add(part(cyl(0.12, 0.15, 4.6, 10), wood, { pos: [0, 1.7, 0] }));
    stub.add(part(flatBox(0.2, 0.5, 0.2), wood, { pos: [0.05, 4.05, 0], rot: [0, 0, 0.5] })); // splintered top
    unit(stub, stx, gy2, stz, "snapped pole", 0.3, "children", { belowGrade: true });
    // catenary spans: two crossarm tips -> stub top, one down wire to a coil
    trim.add(wireSpan([px - 0.95, gy + 5.9, pz - 1.03], [stx, gy2 + 4.0, stz], 1.1, dk, { radius: 0.012, segments: 14 }));
    trim.add(wireSpan([px + 0.95, gy + 5.9, pz - 1.03], [stx, gy2 + 4.0, stz], 1.25, dk, { radius: 0.012, segments: 14 }));
    trim.add(wireSpan([stx, gy2 + 4.0, stz], [-143.6, heightAt(-143.6, 118.0) + 0.06, 118.0], 0.25, dk, { radius: 0.012, segments: 10 }));
    trim.add(part(new THREE.TorusGeometry(0.35, 0.035, 6, 16), dk, { pos: [-143.6, heightAt(-143.6, 118.0) + 0.05, 118.0], rot: [Math.PI / 2, 0, 0] }));
    p.add(trim);
    unit(p, px, gy, pz, "telephone pole", 0, "children", { belowGrade: true }); // planted 0.6 m deep
  }
}

// ═══════════════════════════ 3 · MILITARY CHECKPOINT ═══════════════════════════
// A road block on the south approach: jersey-barrier line with a lane gap, a
// toppled barrier arm down the lane, sandbag nests flanking it, a watchtower
// platform with a real climb volume, signage, supply crates, and a sagging
// chain perimeter. Everything beds into the slope through heightAt per unit.

/** U-shaped sandbag nest: three instanced runs, one collider per run. */
function sandbagNest(rng: () => number, mat: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  const bagGeo = bevelBox(0.58, 0.24, 0.34);
  const runs: Array<{ along: "x" | "z"; at: number; from: number; to: number }> = [
    { along: "x", at: -1.1, from: -1.6, to: 1.6 },   // front
    { along: "z", at: -1.6, from: -1.1, to: 1.1 },   // left
    { along: "z", at: 1.6, from: -1.1, to: 1.1 },    // right
  ];
  for (const run of runs) {
    const places: Placement[] = [];
    const n = Math.floor((run.to - run.from) / 0.62);
    for (let course = 0; course < 3; course++) {
      for (let i = 0; i < n; i++) {
        const t = run.from + 0.31 + i * 0.62 + (course % 2) * 0.29;
        if (t > run.to - 0.2) continue;
        const jx = (rng() - 0.5) * 0.05, jz = (rng() - 0.5) * 0.05;
        places.push({
          pos: run.along === "x" ? [t + jx, 0.13 + course * 0.24, run.at + jz] : [run.at + jx, 0.13 + course * 0.24, t + jz],
          rot: [0, (run.along === "z" ? Math.PI / 2 : 0) + (rng() - 0.5) * 0.14, (rng() - 0.5) * 0.06],
        });
      }
    }
    g.add(instancedPlaces(bagGeo, mat, places));
  }
  return g;
}

function buildCheckpoint(refs: WorldRefs, rng: () => number) {
  const { unit } = makeOuterBuilder(refs);
  const conc = matOf("IND04", 3);
  const dk = dark();
  const st = steel();

  // ── jersey barrier line across the lane, z = 158 ──
  const jersey = () => {
    const b = new THREE.Group();
    b.add(bev(1.8, 0.34, 0.6, conc, { pos: [0, 0.17, 0] }));
    b.add(bev(1.7, 0.55, 0.28, conc, { pos: [0, 0.615, 0] }));
    return b;
  };
  for (const bx of [-7.2, -5.4, -3.6, 3.6, 5.4, 7.2]) {
    unit(jersey(), bx, heightAt(bx, 158) - 0.04, 158, "concrete barrier", 0, "children");
  }
  // one toppled, dragged clear of the lane mouth — rotated about its LONG
  // axis, so the cross-section lies down and the length stays horizontal
  {
    const b = new THREE.Group();
    b.add(bev(1.8, 0.34, 0.6, conc, { pos: [0, 0.2, 0], rot: [1.45, 0, 0] }));
    b.add(bev(1.7, 0.55, 0.28, conc, { pos: [0, 0.27, 0.58], rot: [1.45, 0, 0] }));
    unit(b, 2.9, heightAt(2.9, 160.2) - 0.05, 160.2, "toppled barrier", 0.35, "children", { interpenetrates: true });
  }

  // ── barrier arm, pivot housing at the lane edge, arm fallen down the lane ──
  {
    const ax = 1.9, az = 158, gy = heightAt(ax, az);
    const g = new THREE.Group();
    g.add(bev(0.24, 1.05, 0.24, conc, { pos: [0, 0.52, 0] }));
    g.add(bev(0.42, 0.32, 0.36, dk, { pos: [0, 1.12, 0] }));                  // pivot housing
    g.add(part(cyl(0.05, 0.05, 0.3, 8), st, { pos: [0, 1.12, 0], rot: [Math.PI / 2, 0, 0] })); // pivot pin
    g.add(part(flatBox(0.15, 0.12, 4.3), matOf("MET08", 1.2), { pos: [0, 0.53, 2.27], rot: [0.235, 0, 0] })); // fallen arm
    g.add(bev(0.3, 0.24, 0.5, dk, { pos: [0, 1.05, -0.42] }));                // counterweight
    unit(g, ax, gy, az, "checkpoint barrier arm", 0, "children");
  }

  // ── sandbag nests flanking the lane ──
  const bagMat = matOf("STR06", 1);
  unit(sandbagNest(rng, bagMat), -8, heightAt(-8, 153.5) - 0.05, 153.5, "sandbag emplacement", 0, "children", { belowGrade: true });
  unit(sandbagNest(rng, bagMat), 8, heightAt(8, 153.5) - 0.05, 153.5, "sandbag emplacement", 0, "children", { belowGrade: true });

  // ── watchtower platform: timber legs, tread deck, railing, tarp roof ──
  {
    const tx = 10, tz = 166, gy = heightAt(tx, tz);
    const wood = matOf("IND03", 2);
    const t = new THREE.Group();
    for (const [lx, lz] of [[-1.05, -1.05], [1.05, -1.05], [-1.05, 1.05], [1.05, 1.05]] as const) {
      t.add(part(flatBox(0.15, 3.5, 0.15), wood, { pos: [lx, 1.5, lz] })); // sunk 0.25
      t.add(bev(0.4, 0.08, 0.4, conc, { pos: [lx, 0.04, lz] }));           // foot pad
    }
    const braces = new THREE.Group();
    braces.userData.noCollide = true;
    for (const s of [-1, 1] as const) {
      braces.add(strut([-1.05, 0.6, s * 1.05], [1.05, 2.6, s * 1.05], 0.04, wood));
      braces.add(strut([s * 1.05, 0.6, -1.05], [s * 1.05, 2.6, 1.05], 0.04, wood));
    }
    t.add(braces);
    t.add(bev(2.7, 0.08, 2.7, matOf("IND08", 1.5), { pos: [0, 3.29, 0] })); // tread deck
    for (const s of [-1, 1] as const) {
      t.add(part(flatBox(2.7, 0.1, 0.08), wood, { pos: [0, 3.2, s * 1.31], shadow: false }));
      t.add(part(flatBox(0.08, 0.1, 2.7), wood, { pos: [s * 1.31, 3.2, 0], shadow: false }));
    }
    // railing: corner + mid posts, two rail levels
    for (const [lx, lz] of [[-1.28, -1.28], [1.28, -1.28], [-1.28, 1.28], [1.28, 1.28], [0, -1.28], [0, 1.28], [-1.28, 0]] as const) {
      t.add(part(flatBox(0.06, 1.0, 0.06), wood, { pos: [lx, 3.83, lz] }));
    }
    for (const ry of [3.95, 4.28]) {
      for (const s of [-1, 1] as const) {
        t.add(part(flatBox(2.62, 0.05, 0.04), wood, { pos: [0, ry, s * 1.28] }));
        t.add(part(flatBox(0.04, 0.05, 2.62), wood, { pos: [s * 1.28, ry, 0] }));
      }
    }
    // tarp roof on four posts, pitched to shed
    for (const [lx, lz] of [[-1.15, -1.15], [1.15, -1.15], [-1.15, 1.15], [1.15, 1.15]] as const) {
      t.add(part(flatBox(0.09, lz < 0 ? 2.3 : 2.05, 0.09), wood, { pos: [lx, 4.3 + (lz < 0 ? 0.12 : 0), lz] }));
    }
    const roof = new THREE.Group();
    roof.userData.noCollide = true;
    roof.add(part(flatBox(2.9, 0.04, 2.9), matOf("IND09", 1.5), { pos: [0, 5.45, 0.05], rot: [0.11, 0, 0] }));
    roof.add(part(cyl(0.03, 0.03, 2.9, 6), wood, { pos: [0, 5.58, -1.1], rot: [0, 0, Math.PI / 2] }));
    t.add(roof);
    unit(t, tx, gy, tz, "watchtower platform", 0, "children", { belowGrade: true }); // legs bed into the slope

    // east-face ladder: dressing + a climb volume (water-tower pattern)
    const ladder = new THREE.Group();
    for (const s of [-0.26, 0.26]) ladder.add(part(flatBox(0.05, 3.9, 0.05), st, { pos: [1.42, 1.8, s] }));
    for (let i = 0; i < 10; i++) {
      ladder.add(part(cyl(0.016, 0.016, 0.52, 5), st, { pos: [1.42, 0.35 + i * 0.36, 0], rot: [Math.PI / 2, 0, 0] }));
    }
    ladder.userData.noCollide = true;
    t.add(ladder);
    refs.climbZones.push(new THREE.Box3(
      new THREE.Vector3(tx + 0.7, gy, tz - 0.45),
      new THREE.Vector3(tx + 1.55, gy + 3.6, tz + 0.45)
    ));
  }

  // ── faded hazard sign at the lane mouth ──
  {
    const sx = 3.2, sz = 155.6, gy = heightAt(sx, sz);
    const g = new THREE.Group();
    g.add(part(flatBox(0.07, 1.95, 0.07), st, { pos: [0, 0.9, 0], rot: [0, 0, 0.09] }));
    g.add(part(flatBox(0.95, 0.6, 0.03), matOf("MET08", 1.2), { pos: [0.09, 1.62, 0], rot: [0, 0, 0.09] }));
    g.add(bolts(along([-0.3, 1.78, 0.02], [0.48, 1.78, 0.02], 3, [Math.PI / 2, 0, 0]), st, 0.012));
    unit(g, sx, gy, sz, "hazard sign", 0.2, "children");
  }

  // ── supply crate cluster, one stack tarped ──
  {
    const cx = -9, cz = 164, gy = heightAt(cx, cz);
    const wood = matOf("IND03", 1.5);
    const g = new THREE.Group();
    g.add(bev(0.72, 0.62, 0.72, wood, { pos: [0, 0.31, 0], rot: [0, 0.1, 0] }));
    g.add(bev(0.66, 0.58, 0.66, wood, { pos: [0.75, 0.29, 0.2], rot: [0, -0.25, 0] }));
    g.add(bev(0.6, 0.5, 0.6, wood, { pos: [0.28, 0.86, 0.08], rot: [0, 0.45, 0] }));
    g.add(bev(0.7, 0.6, 0.7, wood, { pos: [-0.85, 0.3, 0.55], rot: [0, 0.7, 0] }));
    // tarped pile: two crates under a draped tarp with rope straps
    g.add(bev(0.72, 0.62, 0.72, wood, { pos: [-0.2, 0.31, 1.35], rot: [0, 0.2, 0] }));
    g.add(bev(0.66, 0.58, 0.66, wood, { pos: [0.55, 0.29, 1.5], rot: [0, -0.1, 0] }));
    const tarp = new THREE.Group();
    tarp.userData.noCollide = true;
    tarp.add(bev(1.75, 0.42, 1.35, matOf("IND09", 1.5), { pos: [0.18, 0.82, 1.42], radius: 0.18, rot: [0, 0.12, 0] }));
    tarp.add(strut([-0.6, 0.9, 1.1], [0.95, 0.9, 1.75], 0.015, dk));
    tarp.add(strut([-0.6, 0.9, 1.75], [0.95, 0.9, 1.1], 0.015, dk));
    g.add(tarp);
    unit(g, cx, gy - 0.03, cz, "supply crate cluster", 0.4, "children", { interpenetrates: true });
  }

  // ── chain perimeter: posts every 3.5 m, two sagging strands ──
  {
    const pz = 149.2;
    const g = new THREE.Group();
    const xs: number[] = [];
    for (let x = -14; x <= 14; x += 3.5) xs.push(x);
    for (const px of xs) {
      const gy = heightAt(px, pz);
      g.add(part(flatBox(0.09, 1.4, 0.09), st, { pos: [px, gy + 0.62 - heightAt(0, pz), 0] }));
    }
    const chains = new THREE.Group();
    chains.userData.noCollide = true;
    for (let i = 0; i < xs.length - 1; i++) {
      const gyA = heightAt(xs[i], pz), gyB = heightAt(xs[i + 1], pz);
      const gyR = heightAt(0, pz);
      // one span between posts 5 and 6 is down: both ends at the dirt
      const down = i === 5;
      const yA = down ? gyA + 0.04 : gyA + (down ? 0 : 1.28);
      const yB = down ? gyB + 0.04 : gyB + 1.28;
      chains.add(wireSpan([xs[i], yA - gyR, 0], [xs[i + 1], yB - gyR, 0], down ? 0.02 : 0.17, dk, { radius: 0.013, segments: 8 }));
      if (!down) {
        chains.add(wireSpan([xs[i], gyA + 0.72 - gyR, 0], [xs[i + 1], gyB + 0.72 - gyR, 0], 0.13, dk, { radius: 0.011, segments: 8 }));
      }
    }
    g.add(chains);
    // posts bed into the slope individually; the span box vs centre-grade
    // reading is a slope artefact, so the intent is declared
    unit(g, 0, heightAt(0, pz), pz, "checkpoint perimeter", 0, "children", { belowGrade: true });
  }
  // a fallen chain-link panel leaning on the east barrier run
  {
    const g = new THREE.Group();
    const meshMat = matOf("STR07", 1.4).clone();
    meshMat.side = THREE.DoubleSide;
    g.add(part(flatBox(3.0, 1.5, 0.025), meshMat, { pos: [0, 0.75, 0], rot: [-0.3, 0, 0] }));
    g.add(part(flatBox(3.04, 0.05, 0.04), st, { pos: [0, 1.44, 0.22], rot: [-0.3, 0, 0] }));
    unit(g, 5.2, heightAt(5.2, 157.4), 157.4, "fallen fence panel", 0.15, "children", { interpenetrates: true });
  }
}

// ═══════════════════════════ 4 · JUNKYARD ═══════════════════════════
// Crushed-car stacks in two rows, a tire-wall maze fragment, oil stains, and
// a gantry crane: rail pair following the grade in segments, hoist frame with
// a trolley, chain and magnet. Stacks interpenetrate by design and say so.

/** One crushed car body — a pressed hull with the cabin pancaked into it. */
function crushedCar(rng: () => number, paint: THREE.Material): THREE.Group {
  const dk = dark();
  const g = new THREE.Group();
  g.add(bev(1.74, 0.44, 3.85, paint, { pos: [0, 0.26, 0], radius: 0.07 }));
  g.add(bev(1.5, 0.3, 1.9, paint, { pos: [0, 0.6, 0.1], radius: 0.1 }));
  g.add(bev(0.5, 0.28, 0.55, dk, { pos: [0, 0.5, -1.35], radius: 0.05 })); // engine lump
  g.add(part(flatBox(1.4, 0.03, 0.7), matOf("CRV08", 1), { pos: [0, 0.77, -0.45], rot: [0.1, 0, 0], shadow: false })); // glass sandwich
  for (const bz of [-1.95, 1.95]) g.add(part(flatBox(1.76, 0.1, 0.14), dk, { pos: [0, 0.16, bz] }));
  // two of the four wheels survive the crusher, poking out sideways
  const tyre = matOf("CRV03", 1);
  const corners: Array<[number, number]> = [[-0.85, -1.2], [0.85, -1.2], [-0.85, 1.3], [0.85, 1.3]];
  corners.sort(() => rng() - 0.5);
  for (const [wx2, wz2] of corners.slice(0, 2)) {
    g.add(part(new THREE.TorusGeometry(0.32, 0.12, 8, 16), tyre, { pos: [wx2, 0.3, wz2], rot: [0, 0, Math.PI / 2] }));
  }
  return g;
}

function buildJunkyard(refs: WorldRefs, rng: () => number) {
  const { deco, unit } = makeOuterBuilder(refs);
  const dk = dark();
  const st = steel();

  // ── crushed-car stack rows ──
  const paints = [matOf("MET01", 1.5), matOf("CRV04", 1.5), matOf("IND02", 1.5), matOf("MET06", 1.5), matOf("MET02", 2)];
  const spots: Array<[number, number]> = [
    [160, -102.5], [166, -102.5], [172, -102.5], [178, -102.5], // row A
    [162, -110.5], [170, -110.5], [178, -110.5],                // row B
  ];
  let paintIdx = 0;
  for (const [sx, sz] of spots) {
    const gy = heightAt(sx, sz);
    const stack = new THREE.Group();
    const nCar = 2 + Math.floor(rng() * 2); // 2-3 high
    for (let i = 0; i < nCar; i++) {
      const car = crushedCar(rng, paints[paintIdx++ % paints.length]);
      car.position.set((rng() - 0.5) * 0.36, i * 0.66, (rng() - 0.5) * 0.3);
      car.rotation.y = (rng() - 0.5) * 0.28;
      stack.add(car);
    }
    unit(stack, sx, gy - 0.05, sz, "crushed car stack", (rng() - 0.5) * 0.2, "children", { interpenetrates: true });
  }

  // ── tire-wall maze fragment: instanced tires, one collider per run ──
  {
    const maze = new THREE.Group();
    const tyreGeo = new THREE.TorusGeometry(0.3, 0.12, 8, 16);
    const tyreMat = matOf("CRV03", 1);
    const MCX = 161.75, MCZ = -119.5; // maze centroid — the group sits here
    const runs: Array<[number, number, number, number]> = [ // x0, z0, x1, z1
      [157, -116.5, 163, -116.5],
      [163, -116.5, 163, -121],
      [159, -118.5, 159, -122.5],
      [159, -122.5, 166.5, -122.5],
      [166.5, -119.5, 166.5, -122.5],
    ];
    for (const [x0, z0, x1, z1] of runs) {
      const places: Placement[] = [];
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.max(2, Math.floor(len / 0.62));
      const yawR = Math.atan2(x1 - x0, z1 - z0);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const px = x0 + (x1 - x0) * t, pz = z0 + (z1 - z0) * t;
        for (let layer = 0; layer < 3; layer++) {
          places.push({
            pos: [px - MCX + (rng() - 0.5) * 0.05, heightAt(px, pz) + 0.14 + layer * 0.25, pz - MCZ + (rng() - 0.5) * 0.05],
            rot: [Math.PI / 2, yawR + (rng() - 0.5) * 0.3, 0],
          });
        }
      }
      maze.add(instancedPlaces(tyreGeo, tyreMat, places));
    }
    // tires follow the grade run by run; they bed into the slope by design
    unit(maze, MCX, 0, MCZ, "tire wall maze", 0, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── oil stains under the stacks and by the hoist ──
  const oilMat = plain(0x16130f, 0.38, 0.05);
  for (let i = 0; i < 7; i++) {
    const [sx, sz] = spots[i % spots.length];
    const ox = sx + (rng() - 0.5) * 4.5, oz = sz + (rng() - 0.5) * 4.5;
    groundPatch(refs, ox, oz, 0.9 + rng() * 1.1, oilMat, "oil stain");
  }

  // ── gantry crane: rail pair following the grade, then the hoist frame ──
  {
    const rails = new THREE.Group();
    const railMat = dk;
    const RCX = 181.4, RCZ = -107; // rail-run centroid
    for (const rx of [179.6, 183.2]) {
      for (let s = 0; s < 3; s++) {
        const cz = -102.3 - s * 4.7;
        rails.add(part(flatBox(0.16, 0.14, 4.6), railMat, { pos: [rx - RCX, heightAt(rx, cz) + 0.16, cz - RCZ] }));
        rails.add(part(flatBox(0.3, 0.05, 0.34), railMat, { pos: [rx - RCX, heightAt(rx, cz) + 0.245, cz + 2.32 - RCZ], shadow: false })); // fishplate
      }
    }
    // rail segments step down the grade like the railway siding does
    unit(rails, RCX, 0, RCZ, "gantry rails", 0, "children", { belowGrade: true });
    // sleepers: instanced dressing under both rails
    const sleepers: Placement[] = [];
    for (let i = 0; i < 12; i++) {
      const sz2 = -100.2 - i * 1.17;
      sleepers.push({ pos: [181.4, heightAt(181.4, sz2) + 0.05, sz2] });
    }
    deco(instancedPlaces(flatBox(4.4, 0.09, 0.26), matOf("IND03", 2), sleepers));
  }
  {
    const hx = 181.4, hz = -107, gy = heightAt(hx, hz);
    const g = new THREE.Group();
    const frame = matOf("MET06", 2);
    for (const [lx, lz] of [[-2.1, -2.1], [2.1, -2.1], [-2.1, 2.1], [2.1, 2.1]] as const) {
      g.add(part(flatBox(0.18, 5.7, 0.18), frame, { pos: [lx, 2.6, lz] })); // sunk 0.25
      g.add(bev(0.42, 0.08, 0.42, frame, { pos: [lx, 0.04, lz] }));
    }
    const braces = new THREE.Group();
    braces.userData.noCollide = true;
    for (const sx of [-1, 1] as const) {
      braces.add(strut([sx * 2.1, 3.2, -2.1], [sx * 2.1, 5.3, -0.9], 0.045, frame));
      braces.add(strut([sx * 2.1, 3.2, 2.1], [sx * 2.1, 5.3, 0.9], 0.045, frame));
    }
    g.add(braces);
    for (const sx of [-1, 1] as const) {
      g.add(part(flatBox(0.2, 0.26, 4.6), frame, { pos: [sx * 2.1, 5.55, 0] })); // side beams
    }
    g.add(part(flatBox(4.6, 0.3, 0.24), frame, { pos: [0, 5.75, 0] }));          // main beam
    g.add(bolts([
      ...along([-2.1, 5.72, -0.14], [-2.1, 5.72, 0.14], 2, [0, 0, Math.PI / 2]),
      ...along([2.1, 5.72, -0.14], [2.1, 5.72, 0.14], 2, [0, 0, Math.PI / 2]),
    ], st, 0.014));
    // trolley, chain and magnet
    g.add(bev(0.55, 0.4, 0.6, matOf("MET05", 1), { pos: [0.3, 5.45, 0] }));
    const lift = new THREE.Group();
    lift.userData.noCollide = true;
    lift.add(part(cyl(0.02, 0.02, 2.3, 6), dk, { pos: [0.3, 4.1, 0] }));
    lift.add(bev(0.16, 0.28, 0.12, dk, { pos: [0.3, 2.9, 0] }));
    lift.add(part(cyl(0.55, 0.55, 0.14, 16), matOf("MET06", 1.5), { pos: [0.3, 2.72, 0] }));
    g.add(lift);
    unit(g, hx, gy, hz, "gantry hoist", 0, "children");
  }

  // a working pair of drums by the hoist
  {
    const g = new THREE.Group();
    const drumMat = matOf("CRV07", 1);
    for (const [dx2, dz2, tip] of [[0, 0, false], [0.65, 0.25, true]] as const) {
      const d = new THREE.Group();
      d.add(part(cyl(0.29, 0.29, 0.88, 14), drumMat, { pos: [0, 0.44, 0] }));
      for (const hy of [0.28, 0.6]) d.add(part(cyl(0.305, 0.305, 0.05, 14), drumMat, { pos: [0, hy, 0] }));
      d.position.set(dx2, 0, dz2);
      if (tip) { d.rotation.z = Math.PI / 2; d.position.y = 0.3; d.rotation.y = rng() * Math.PI; }
      g.add(d);
    }
    unit(g, 184.6, heightAt(184.6, -104.2), -104.2, "junk drums", rng() * 2, true, { interpenetrates: true });
  }
}

// ═══════════════════════════ 5 · SEALED LOOT CACHES ═══════════════════════════
// One sturdy supply cache at each outer site. Cross-agent contract: every cache
// registers role "loot_cache" on its ROOT, and the root position IS the
// interact point — the behaviour agent looks these up in the asset registry.
// 0.9 x 0.6 x 0.5 m: painted IND02 lid, rusted MET01 bands, instanced rivets,
// hinge + latch hardware. Own RNG stream (55123) — every existing draw is
// untouched. Grounded through heightAt (the plane cache beds on the fuselage
// cargo floor — see below).

/** The sealed supply cache — same assembly at all four sites. */
function makeCache(): THREE.Group {
  const body = matOf("MET01", 1.5);  // rusted plate box
  const lid = matOf("IND02", 1);     // painted metal lid
  const dk = dark();
  const st = steel();
  const g = new THREE.Group();

  // ── primary: skids, box, overhanging lid ──
  for (const sz of [-0.18, 0.18]) g.add(part(flatBox(0.86, 0.05, 0.08), dk, { pos: [0, 0.025, sz] }));
  g.add(bev(0.9, 0.46, 0.5, body, { pos: [0, 0.28, 0], radius: 0.015 }));
  g.add(bev(0.94, 0.09, 0.54, lid, { pos: [0, 0.545, 0], radius: 0.02 }));

  // ── secondary: bands, hinge, latch ──
  for (const sx of [-0.26, 0.26]) {
    g.add(part(flatBox(0.07, 0.5, 0.52), body, { pos: [sx, 0.3, 0] }));        // girth straps
    g.add(part(flatBox(0.07, 0.02, 0.56), dk, { pos: [sx, 0.585, 0] }));       // strap over the lid
  }
  for (const hx of [-0.22, 0.22]) g.add(hinge(0.14, dk, st, { pos: [hx, 0.5, -0.27], rot: [0, 0, Math.PI / 2] }));
  // latch on the front face: hasp plate, staple, pull handle
  g.add(part(flatBox(0.09, 0.14, 0.02), dk, { pos: [0, 0.44, 0.26] }));
  g.add(part(cyl(0.018, 0.018, 0.1, 6), st, { pos: [0, 0.53, 0.28], rot: [0, 0, Math.PI / 2] }));
  g.add(part(new THREE.TorusGeometry(0.045, 0.012, 6, 12, Math.PI), st, { pos: [0, 0.46, 0.28], rot: [Math.PI / 2, 0, Math.PI] }));

  // ── tertiary: instanced rivets — lid rim + strap lines ──
  const rv: Placement[] = [];
  for (const rx of [-0.38, -0.13, 0.13, 0.38]) {
    rv.push({ pos: [rx, 0.545, 0.272], rot: [Math.PI / 2, 0, 0] });
    rv.push({ pos: [rx, 0.545, -0.272], rot: [-Math.PI / 2, 0, 0] });
  }
  for (const sx of [-0.26, 0.26]) for (const ry of [0.12, 0.3, 0.48]) {
    rv.push({ pos: [sx, ry, 0.265], rot: [Math.PI / 2, 0, 0] });
    rv.push({ pos: [sx, ry, -0.265], rot: [-Math.PI / 2, 0, 0] });
  }
  g.add(rivets(rv, st));
  return g;
}

function buildLootCaches(refs: WorldRefs, rng: () => number) {
  const { unit } = makeOuterBuilder(refs);

  // 1 · CRASH SITE — inside the walkable fuselage, aft bay on the cargo floor.
  // Rebuild the fuselage transform (same numbers as buildCrashSite) and solve
  // the cache's footing through it: the floor rides ~0.5 m above terrain here,
  // so heightAt is only a floor guard, not the support — the support is the
  // registered fuselage, which the terrain-clearance check cannot see. Intent
  // declared: unsupported.
  {
    const { x: AX, z: AZ, yaw: YA, pitch: P, roll: RL } = PLANE;
    const fT = new THREE.Object3D();
    fT.position.set(AX, heightAt(AX, AZ) - 0.55, AZ);
    fT.rotation.order = "YXZ";
    fT.rotation.set(-P, YA, RL);
    fT.updateMatrixWorld(true);
    // cargo floor top is local y -1.125; aft bay clear of the spilled cargo
    const w = fT.localToWorld(new THREE.Vector3(0.35, -1.125, 9.8));
    const y = Math.max(w.y, heightAt(w.x, w.z) + 0.01);
    unit(makeCache(), w.x, y, w.z, "loot_cache", YA + 0.3, "children", { unsupported: true });
  }

  // 2 · SUBURB — inside house A (-166, 123), on the foundation slab, clear of
  // the door aperture (x -165.1 / z 120.2), the partition (x -165.6) and the
  // chimney breast (-168.7, 124.8)
  {
    const cx = -166.8, cz = 124.6;
    unit(makeCache(), cx, heightAt(cx, cz) + 0.05, cz, "loot_cache", 0.2 + rng() * 0.2, "children");
  }

  // 3 · CHECKPOINT — beside the supply-crate cluster (-9, 164), just off its
  // footprint, facing the lane
  {
    const cx = -11.0, cz = 165.6;
    unit(makeCache(), cx, heightAt(cx, cz), cz, "loot_cache", -0.4 + rng() * 0.2, "children");
  }

  // 4 · JUNKYARD — near the gantry hoist (181.4, -107), outside its leg
  // footprint (x <= 183.5) and 1.1 m clear of the east rail line
  {
    const cx = 184.3, cz = -110.2;
    unit(makeCache(), cx, heightAt(cx, cz), cz, "loot_cache", 0.9 + rng() * 0.3, "children");
  }
}

// ═══════════════════ 6 · GORETUSK WALLOW (crash-site boss arena) ═══════════════════
// Something big beds down beside the wreck: a churned-mud wallow ring, scrap
// panels raked by tusks, gnawed bones. Cross-agent contract: ONE marker
// registers role "boss_arena_goretusk" — a trampled TER09 disc at the arena
// centre, invisible-ish under the mud but present in the registry; its
// position is the mini-boss spawn point. Own RNG stream (66437).

function buildGoretuskArena(refs: WorldRefs, rng: () => number) {
  const { unit } = makeOuterBuilder(refs);
  // open ground NE of the fuselage — clear of the debris trail (local x 0.5-2.5),
  // the sheared wing (-14, 6), engine B (5.5, 9.5) and the tail (1.5, 27)
  const [cx, cz] = l2w(PLANE.x, PLANE.z, PLANE.yaw, 18, 8);
  const mud = matOf("TER09", 4);

  // THE MARKER — the wallow's trampled centre disc. No collider; you walk the
  // mud. Spawn point = this disc's position.
  groundPatch(refs, cx, cz, 3.4, mud, "boss_arena_goretusk");
  // trample ring: satellite scuffs where it turns in its sleep
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + (rng() - 0.5) * 0.5;
    const r = 4.4 + rng() * 1.3;
    groundPatch(refs, cx + Math.cos(a) * r, cz + Math.sin(a) * r, 1.0 + rng() * 0.8, mud, "trample patch");
  }

  // ── tusk-gouged scrap markers: wreck panels raked parallel, half-buried ──
  {
    const g = new THREE.Group();
    const panelMats = [matOf("MET03", 1.5), matOf("MET01", 1.5), matOf("MET02", 1.5)];
    const gouge = dark();
    for (let i = 0; i < 3; i++) {
      const a = 0.7 + i * 2.1 + (rng() - 0.5) * 0.4;
      const r = 5.2 + rng() * 0.9;
      const px = Math.cos(a) * r, pz = Math.sin(a) * r;
      const panel = new THREE.Group();
      const lean = 0.9 + rng() * 0.5;
      panel.add(part(flatBox(1.5, 0.05, 0.9), panelMats[i], { pos: [0, 0.32, 0], rot: [lean, 0, 0] }));
      // three parallel gouges: bright-metal furrows torn across the panel face
      for (const gx of [-0.22, 0, 0.22]) {
        panel.add(part(flatBox(0.05, 0.02, 0.8), gouge, { pos: [gx, 0.35, 0.01], rot: [lean, 0.12, 0], shadow: false }));
      }
      panel.position.set(px, heightAt(cx + px, cz + pz) - heightAt(cx, cz) - 0.06, pz);
      panel.rotation.y = rng() * Math.PI;
      g.add(panel);
    }
    // children bed into the wallow mud by design
    unit(g, cx, heightAt(cx, cz), cz, "tusk-gouged scrap", 0, "children", { belowGrade: true, interpenetrates: true });
  }

  // ── gnawed bones: rib arcs and long bones in the mud (dressing, no snag) ──
  {
    const g = new THREE.Group();
    const bone = matOf("CRV02", 1);
    for (let i = 0; i < 4; i++) {
      const a = rng() * Math.PI * 2;
      const r = 1.2 + rng() * 3.4;
      const bx = cx + Math.cos(a) * r, bz = cz + Math.sin(a) * r;
      const by = heightAt(bx, bz);
      if (i % 2 === 0) {
        // rib arc, sprung out of the mud
        g.add(part(new THREE.TorusGeometry(0.42 + rng() * 0.15, 0.032, 6, 12, 1.5 + rng() * 0.5), bone, {
          pos: [bx - cx, by - heightAt(cx, cz) + 0.06, bz - cz],
          rot: [Math.PI / 2 + (rng() - 0.5) * 0.6, rng() * 3, (rng() - 0.5) * 0.8],
        }));
      } else {
        // long bone with both knuckle ends
        const len = 0.6 + rng() * 0.35;
        const yaw = rng() * Math.PI;
        const lx = bx - cx, lz = bz - cz, ly = by - heightAt(cx, cz) + 0.045;
        g.add(part(cyl(0.028, 0.034, len, 7), bone, { pos: [lx, ly, lz], rot: [Math.PI / 2, yaw, 0] }));
        for (const e of [-1, 1]) {
          g.add(part(new THREE.SphereGeometry(0.05, 7, 6), bone, {
            pos: [lx + Math.sin(yaw) * e * len / 2, ly, lz + Math.cos(yaw) * e * len / 2],
          }));
        }
      }
    }
    unit(g, cx, heightAt(cx, cz), cz, "goretusk bones", 0, false, { belowGrade: true, interpenetrates: true });
  }
}

// ═══════════════════════════ entry point ═══════════════════════════

export function buildOuter(refs: WorldRefs): void {
  const rng = makeRng(77031); // own stream — every existing sequence untouched
  buildCrashSite(refs, rng);
  buildSuburb(refs, rng);
  buildCheckpoint(refs, rng);
  buildJunkyard(refs, rng);
  // additive batches on their own streams — the four site sequences above are untouched
  buildLootCaches(refs, makeRng(55123));
  buildGoretuskArena(refs, makeRng(66437));
}
