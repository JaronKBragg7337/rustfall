// Dry wash expansion (Batch 2, item 12) — a road/deck bridge and a corrugated
// culvert on the eroded channel carved in terrain.ts, plus channel-bed
// dressing (gravel bars, sunk stones, a dumped tire and barrel).
//
// Same assembly rules as world.ts / site_industrial.ts:
//   · Primary form first, then secondary components, then tertiary detail.
//     Bolts and corrugation ribs are instanced; geometry is cached through
//     kit.ts. Trim (rails, planks, flanges) is separate geometry, never paint.
//   · Everything grounds through terrain.heightAt() — which now includes the
//     wash carve, so abutments, headwalls and bed dressing solve their own
//     support from the new heightfield.
//   · Collision honesty at 45°: colliders are axis-aligned Box3s, and a thin
//     slab rotated 45° inflates to a giant square AABB (doctrine 6B.7) that
//     would seal the channel with an invisible floor. The deck, kerbs and
//     ramps therefore push CHUNKED axis-aligned colliders computed from their
//     real rotated corners; compact solids (abutments, headwall cheeks) keep
//     ordinary conservative AABBs, and the culvert bore stays genuinely open.
//   · Own RNG stream (seed 30911) so every other site's sequence is untouched.
import * as THREE from "./three";
import { registerAsset, registerAperture, makeRng, type AssetFlags } from "./constants";
import { matOf } from "./textures";
import { plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, along, type Placement } from "./kit";
import { heightAt, washCenter } from "./terrain";
import type { WorldRefs } from "./world";

const U_BRIDGE = 8;    // wash along-coordinate of the road bridge
const U_CULVERT = -20; // wash along-coordinate of the culvert

const steel = () => plain(0x55524d, 0.44, 0.85);
const dark = () => plain(0x34322f, 0.58, 0.8);

// ─────────────────────────── placement helpers ───────────────────────────
// Mirrors makeSiteBuilder in site_industrial.ts so all three files speak one
// vocabulary.
function makeWashBuilder(refs: WorldRefs) {
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

  return { solid, deco, unit };
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
 * Chunked axis-aligned colliders for a yaw-rotated horizontal slab. One AABB
 * per chunk along the slab's length, computed from the real rotated corners —
 * the honest alternative to Box3.setFromObject on a 45° deck, whose single
 * AABB would span the whole wash as an invisible floor (doctrine 6B.7).
 * `tops`/`bottom` let ramps step the chunk heights.
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

// ═══════════════════════════ 1 · ROAD BRIDGE ═══════════════════════════
// Cast-concrete (IND04) abutments and kerbs, steel stringers, and a
// weathered-wood (IND03) plank deck running across the wash at u = 8. The
// deck is flat and level; each abutment solves its own height from the bank
// it stands on, so the low-side abutment is simply taller.

function buildBridge(refs: WorldRefs) {
  const { solid, deco, unit } = makeWashBuilder(refs);
  const c = washCenter(U_BRIDGE);
  // Deck runs across the wash: local +Z maps to the wash normal n.
  const yaw = Math.atan2(c.nx, c.nz); // -π/4
  const conc = matOf("IND04", 3);
  const wood = matOf("IND03", 2);
  const grav = matOf("IND06", 3);
  const dk = dark();
  const st = steel();

  const DECK_LEN = 21, DECK_W = 4.4, SLAB_T = 0.25, KERB_H = 0.18;
  const PLANK_T = 0.05;

  // Abutments at ±10 m across the wash — just outside the carve's 9.2 m outer
  // influence, on uncarved natural ground.
  const ends = ([1, -1] as const).map((e) => {
    const x = c.x + e * 10 * c.nx, z = c.z + e * 10 * c.nz;
    return { e, x, z, gy: heightAt(x, z) };
  });
  const deckTop = Math.max(ends[0].gy, ends[1].gy) + 0.85; // slab top, level
  const walkTop = deckTop + PLANK_T;
  const y0 = deckTop - SLAB_T; // deck group origin

  // ── abutments, wingwalls, approach ramps ──
  for (const { e, x, z, gy } of ends) {
    solid(5.2, 0.5, 2.6, conc, x, gy - 0.42, z, "bridge abutment footing",
      { ry: yaw, flags: { belowGrade: true, interpenetrates: true } });
    // stem top = bearing-seat plane (slab underside minus stringers and pads)
    const stemH = deckTop - 0.52 - (gy - 0.12);
    solid(4.9, stemH, 1.5, conc, x, gy - 0.12, z, "bridge abutment",
      { ry: yaw, flags: { belowGrade: true } });
    // wingwalls angled back into the banks, tops flush with the kerb
    for (const s of [-1, 1] as const) {
      const wx = x + s * 2.55 * c.tx + e * 1.8 * c.nx;
      const wz = z + s * 2.55 * c.tz + e * 1.8 * c.nz;
      const wy = heightAt(wx, wz) - 0.25;
      solid(0.42, deckTop + KERB_H - wy, 3.0, conc, wx, wy, wz, "bridge wingwall",
        { ry: yaw + s * 0.6, flags: { belowGrade: true } });
    }
    // gravel approach ramp: pitched visual over four stepped colliders, each
    // riser well under the 0.52 m step-up so the deck stays walkable from the
    // bank on either side.
    const fx = c.x + e * (DECK_LEN / 2 + 3.4) * c.nx;
    const fz = c.z + e * (DECK_LEN / 2 + 3.4) * c.nz;
    const fy = heightAt(fx, fz);
    const rcx = c.x + e * (DECK_LEN / 2 + 1.6) * c.nx;
    const rcz = c.z + e * (DECK_LEN / 2 + 1.6) * c.nz;
    const pitch = Math.atan2(walkTop - fy, 3.4);
    const ramp = bev(4.0, 0.24, 3.6, grav, {
      pos: [rcx, (fy + walkTop) / 2 - 0.1, rcz], radius: 0.05,
    });
    ramp.rotation.order = "YXZ";
    ramp.rotation.y = yaw;
    ramp.rotation.x = e * pitch;
    deco(ramp);
    registerAsset("bridge approach ramp", ramp, "AST", { belowGrade: true, interpenetrates: true });
    const tops = [1, 2, 3, 4].map((i) => fy + (i / 4) * (walkTop - fy));
    slabColliders(refs, rcx, rcz, yaw, 3.2, 4.0, fy - 0.25, tops);
  }

  // ── deck group: slab, stringers, planks, kerbs, barriers, bolts ──
  const g = new THREE.Group();
  g.add(bev(DECK_W, SLAB_T, DECK_LEN, conc, { pos: [0, SLAB_T / 2, 0], radius: 0.02 }));
  for (const sx of [-1.5, 0, 1.5]) {
    g.add(part(flatBox(0.2, 0.22, DECK_LEN - 0.4), dk, { pos: [sx, -0.11, 0] }));
  }
  for (const bz of [-8, -4, 0, 4, 8]) {
    g.add(part(flatBox(DECK_W - 0.4, 0.1, 0.1), dk, { pos: [0, -0.16, bz], shadow: false }));
  }
  // bearing pads on the abutment seats + seat bolts
  for (const e of [-1, 1]) for (const sx of [-1.5, 0, 1.5]) {
    g.add(part(flatBox(0.34, 0.05, 0.5), dk, { pos: [sx, -0.245, e * 10] }));
  }
  g.add(bolts([
    ...along([-1.5, -0.21, -10.15], [1.5, -0.21, -10.15], 6, [0, 0, 0]),
    ...along([-1.5, -0.21, 10.15], [1.5, -0.21, 10.15], 6, [0, 0, 0]),
  ], st, 0.016));

  // plank running surface: real boards with 20 mm gaps, instanced
  const plankPlaces: Placement[] = [];
  for (let z = -DECK_LEN / 2 + 0.15; z <= DECK_LEN / 2 - 0.14; z += 0.3) {
    plankPlaces.push({ pos: [0, SLAB_T + PLANK_T / 2, z] });
  }
  g.add(instancedPlaces(flatBox(DECK_W - 0.1, PLANK_T, 0.28), wood, plankPlaces));

  // kerbs + barrier posts and rails — separate trim meshes, never painted on
  for (const sx of [-1, 1] as const) {
    g.add(bev(0.24, KERB_H, DECK_LEN, conc, { pos: [sx * (DECK_W / 2 - 0.12), SLAB_T + KERB_H / 2, 0] }));
    const px = sx * (DECK_W / 2 - 0.18);
    for (let i = 0; i <= 10; i++) {
      const pz = -DECK_LEN / 2 + 0.5 + i * ((DECK_LEN - 1) / 10);
      g.add(part(flatBox(i % 5 === 0 ? 0.1 : 0.07, 0.85, i % 5 === 0 ? 0.1 : 0.07), dk, {
        pos: [px, SLAB_T + KERB_H + 0.425, pz],
      }));
    }
    g.add(part(flatBox(0.05, 0.09, DECK_LEN), st, { pos: [px, SLAB_T + KERB_H + 0.82, 0] }));
    g.add(part(flatBox(0.04, 0.07, DECK_LEN), st, { pos: [px, SLAB_T + KERB_H + 0.42, 0] }));
    // post-base bolts, heads up
    g.add(bolts(
      along([px, SLAB_T + KERB_H + 0.012, -DECK_LEN / 2 + 0.5], [px, SLAB_T + KERB_H + 0.012, DECK_LEN / 2 - 0.5], 11, [0, 0, 0]),
      st, 0.013
    ));
  }

  unit(g, c.x, y0, c.z, "bridge deck", yaw, false);

  // chunked walk colliders: deck slab, both kerbs (the low wall that keeps a
  // vehicle off the edge — the rails above stay visual)
  slabColliders(refs, c.x, c.z, yaw, DECK_LEN, DECK_W, deckTop - 0.1, [walkTop, walkTop, walkTop, walkTop, walkTop, walkTop, walkTop, walkTop]);
  for (const sx of [-1, 1] as const) {
    const kx = c.x + sx * (DECK_W / 2 - 0.12) * Math.cos(yaw);
    const kz = c.z - sx * (DECK_W / 2 - 0.12) * Math.sin(yaw);
    slabColliders(refs, kx, kz, yaw, DECK_LEN, 0.24, deckTop, [deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H, deckTop + KERB_H]);
  }
}

// ═══════════════════════════ 2 · CORRUGATED CULVERT ═══════════════════════════
// A 2.8 m corrugated steel pipe (IND01) laid in the channel at u = -20,
// invert sunk 0.4 m into the bed (declared belowGrade) so the bore stays
// walkable at ~2.0 m wide × 2.4 m high. Cast-concrete headwalls at both ends
// are assembled around the opening — cheeks, spandrel, sill — so no collider
// ever spans the bore.

function buildCulvert(refs: WorldRefs) {
  const { unit } = makeWashBuilder(refs);
  const c = washCenter(U_CULVERT);
  const yaw = Math.atan2(c.tx, c.tz); // pipe axis down-wash, local +Z = tangent
  const conc = matOf("IND04", 3);
  const st = steel();
  const dk = dark();

  const R = 1.4, LEN = 18;
  const bedY = heightAt(c.x, c.z); // channel bed, carve included
  const pipeY = bedY + 1.0;        // invert 0.4 m below the bed

  // pipe: shell + instanced corrugation rings + end flanges
  const pipeMat = matOf("IND01", 3).clone();
  pipeMat.side = THREE.DoubleSide; // the bore is the whole point — line it
  const g = new THREE.Group();
  g.add(part(cyl(R, R, LEN, 28), pipeMat, { pos: [0, 0, 0], rot: [Math.PI / 2, 0, 0] }));
  const rings: Placement[] = [];
  for (let z = -LEN / 2 + 0.15; z <= LEN / 2 - 0.1; z += 0.3) rings.push({ pos: [0, 0, z] });
  g.add(instancedPlaces(new THREE.TorusGeometry(R + 0.02, 0.035, 6, 24), matOf("IND01", 2), rings));
  for (const e of [-1, 1] as const) {
    g.add(part(new THREE.TorusGeometry(R + 0.03, 0.06, 8, 28), dk, { pos: [0, 0, e * (LEN / 2)] }));
  }
  g.position.set(c.x, pipeY, c.z);
  g.rotation.y = yaw;
  refs.scene.add(g);
  const pipeRec = registerAsset("culvert pipe", g, "AST", { belowGrade: true, interpenetrates: true });

  // headwalls at both ends, each grounded on the bed where it stands
  for (const e of [-1, 1] as const) {
    const h = washCenter(U_CULVERT + e * 8.8);
    const hy = heightAt(h.x, h.z);
    const baseY = hy - 0.55;
    const hw = new THREE.Group();
    hw.add(bev(3.8, 0.6, 0.5, conc, { pos: [0, 0.3, 0] })); // sill, buried flush
    const cheekTop = pipeY + R + 0.35 - baseY;
    for (const sx of [-1, 1] as const) {
      hw.add(bev(0.7, cheekTop - 0.1, 0.45, conc, { pos: [sx * 1.55, (cheekTop + 0.1) / 2, 0] }));
      // wingwalls angled upstream/downstream into the banks
      const wing = bev(0.4, cheekTop - 0.6, 2.2, conc, { pos: [sx * 2.3, (cheekTop - 0.6) / 2 + 0.1, e * 1.1] });
      wing.rotation.y = sx * e * 0.5;
      hw.add(wing);
    }
    // spandrel above the crown — its underside clears a standing player
    const spH = 1.0;
    hw.add(bev(3.8, spH, 0.45, conc, { pos: [0, pipeY + R - 0.15 + spH / 2 - baseY, 0] }));
    // headwall face bolts
    hw.add(bolts([
      ...along([-1.7, cheekTop - 0.25, e * 0.24], [1.7, cheekTop - 0.25, e * 0.24], 8, [e > 0 ? 0 : Math.PI, 0, 0]),
      ...along([-1.7, 0.75, e * 0.24], [1.7, 0.75, e * 0.24], 8, [e > 0 ? 0 : Math.PI, 0, 0]),
    ], st, 0.014));
    unit(hw, h.x, baseY, h.z, "culvert headwall", yaw, "children", { belowGrade: true });

    // the bore, registered as an aperture so a future blocked-aperture check
    // can prove it stays open. The opening is cut through the wash tangent
    // (45°); the registry axis only knows x/z, so the nearer axis is declared.
    registerAperture(pipeRec.id, { x: h.x, y: pipeY, z: h.z }, 1.96, 2.4, "x");
  }
}

// ═══════════════════════════ 3 · WASH DRESSING ═══════════════════════════
// Gravel bars (IND06), sunk stones, a dumped tire and a barrel in the bed.
// Everything here is half-buried by design and declares it.

function dressWash(refs: WorldRefs) {
  const { unit } = makeWashBuilder(refs);
  const rng = makeRng(30911);
  const grav = matOf("IND06", 3);
  const rub = matOf("IND04", 2);
  const yawT = Math.PI / 4; // wash tangent yaw

  const bedPoint = (u: number, v: number) => {
    const c = washCenter(u);
    // step off the centreline along the normal
    const x = c.x + v * c.nx, z = c.z + v * c.nz;
    return { x, z, y: heightAt(x, z) };
  };
  // keep clear of the bridge footprint (u 8 ± 4) and the culvert (u -20 ± 10)
  const clear = (u: number) => Math.abs(u - U_BRIDGE) > 4 && Math.abs(u - U_CULVERT) > 10;

  // gravel bars: low elongated mounds mid-bed, drowned half their height
  for (const u0 of [-42, -35, -6, 2, 18, 33]) {
    const u = u0 + (rng() - 0.5) * 3;
    if (!clear(u)) continue;
    const p = bedPoint(u, (rng() - 0.5) * 2.6);
    const bar = new THREE.Group();
    const n = 2 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      bar.add(bev(2.0 + rng() * 2.2, 0.28 + rng() * 0.2, 1.0 + rng() * 0.9, grav, {
        pos: [(rng() - 0.5) * 1.6, 0.02 + rng() * 0.08, (rng() - 0.5) * 1.2],
        rot: [0, (rng() - 0.5) * 0.5, 0], radius: 0.12,
      }));
    }
    unit(bar, p.x, p.y - 0.15, p.z, "gravel bar", yawT + (rng() - 0.5) * 0.4, false,
      { belowGrade: true, interpenetrates: true });
  }

  // sunk stones and broken concrete in the bed
  for (let i = 0; i < 12; i++) {
    const u = -45 + rng() * 90;
    if (!clear(u)) continue;
    const p = bedPoint(u, (rng() - 0.5) * 5.2);
    const s = 0.2 + rng() * 0.45;
    const g = new THREE.Group();
    g.add(bev(s, s * (0.5 + rng() * 0.5), s * (0.7 + rng() * 0.6), rng() < 0.5 ? grav : rub, {
      pos: [0, s * 0.2, 0], rot: [rng() * 0.6, rng() * Math.PI, rng() * 0.6],
    }));
    unit(g, p.x, p.y - s * 0.18, p.z, "wash stone", rng() * Math.PI, false,
      { belowGrade: true, interpenetrates: true });
  }

  // a dumped tire near the bridge
  {
    const p = bedPoint(3.5, 1.8);
    const g = new THREE.Group();
    g.add(part(new THREE.TorusGeometry(0.38, 0.15, 10, 18), matOf("CRV03", 1), {
      pos: [0, 0.13, 0], rot: [Math.PI / 2 + 0.12, 0, rng() * Math.PI],
    }));
    unit(g, p.x, p.y, p.z, "tire", rng() * Math.PI, false, { belowGrade: true });
  }

  // a rusted barrel on its side upstream of the culvert
  {
    const p = bedPoint(-33, -1.2);
    const dk2 = dark();
    const g = new THREE.Group();
    const drum = new THREE.Group();
    drum.add(part(cyl(0.29, 0.29, 0.88, 14), matOf("CRV07", 1), { pos: [0, 0.44, 0] }));
    for (const hy of [0.28, 0.60]) drum.add(part(cyl(0.305, 0.305, 0.05, 14), matOf("CRV07", 1), { pos: [0, hy, 0] }));
    drum.add(part(cyl(0.30, 0.30, 0.03, 14), dk2, { pos: [0, 0.885, 0] }));
    drum.rotation.z = Math.PI / 2;
    drum.rotation.y = rng() * Math.PI;
    drum.position.y = 0.28;
    g.add(drum);
    unit(g, p.x, p.y - 0.06, p.z, "barrel", 0, false, { belowGrade: true });
  }
}

// ═══════════════════════════ entry point ═══════════════════════════

export function buildWash(refs: WorldRefs): void {
  buildBridge(refs);
  buildCulvert(refs);
  dressWash(refs);
}
