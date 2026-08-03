// Detailing kit — the vocabulary every asset is assembled from.
//
// Rules this enforces:
//   · Exposed edges are broken. A perfectly sharp 90° edge is a rendering
//     artifact, not a manufactured object; a 6–20 mm break catches a specular
//     highlight and is most of what makes a form read as built.
//   · Tertiary detail is instanced. Bolts, rivets and seams are the difference
//     between "a box" and "a fabricated panel", but there are hundreds of them,
//     so they go through InstancedMesh rather than becoming hundreds of draws.
//   · Geometry is cached by dimension. The world reuses a few dozen distinct
//     sizes; building each one once keeps the buffer count sane.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Edge break in metres, scaled to the part: small parts get proportionally smaller bevels. */
export function bevelRadius(w: number, h: number, d: number): number {
  const min = Math.min(w, h, d);
  return THREE.MathUtils.clamp(min * 0.14, 0.004, 0.022);
}

/**
 * Beveled box. Segments default to 1 (108 tris) — enough for a highlight to run
 * along the edge, cheap enough to use everywhere.
 */
export function bevelBox(w: number, h: number, d: number, radius?: number, segments = 1): THREE.BufferGeometry {
  const r = radius ?? bevelRadius(w, h, d);
  const key = `bb|${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(4)}|${segments}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const g = new RoundedBoxGeometry(w, h, d, segments, r);
  geoCache.set(key, g);
  return g;
}

/** Sharp box, cached — for surfaces that are genuinely sheet-thin (glass, decals, paint). */
export function flatBox(w: number, h: number, d: number): THREE.BufferGeometry {
  const key = `fb|${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const g = new THREE.BoxGeometry(w, h, d);
  geoCache.set(key, g);
  return g;
}

export function cyl(rTop: number, rBot: number, h: number, seg = 12): THREE.BufferGeometry {
  const key = `cy|${rTop.toFixed(3)}|${rBot.toFixed(3)}|${h.toFixed(3)}|${seg}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  geoCache.set(key, g);
  return g;
}

export interface MeshOpts {
  pos?: [number, number, number];
  rot?: [number, number, number];
  shadow?: boolean;
  receive?: boolean;
}

export function part(geo: THREE.BufferGeometry, mat: THREE.Material, opts: MeshOpts = {}): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  if (opts.pos) m.position.set(...opts.pos);
  if (opts.rot) m.rotation.set(...opts.rot);
  m.castShadow = opts.shadow ?? true;
  m.receiveShadow = opts.receive ?? true;
  return m;
}

/** Beveled box mesh in one call — the workhorse. */
export function bev(w: number, h: number, d: number, mat: THREE.Material, opts: MeshOpts & { radius?: number; segments?: number } = {}): THREE.Mesh {
  return part(bevelBox(w, h, d, opts.radius, opts.segments), mat, opts);
}

// ─────────────────────────── tertiary detail ───────────────────────────

export type Placement = { pos: [number, number, number]; rot?: [number, number, number]; scale?: number };

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, places: Placement[]): THREE.InstancedMesh {
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

/** Hex-head bolts. Default 14 mm across the flats — an M10 structural bolt. */
export function bolts(places: Placement[], mat: THREE.Material, size = 0.014): THREE.InstancedMesh {
  const g = cyl(size, size * 1.05, size * 0.85, 6);
  // cylinder axis is +Y; rotate so the head faces +Z by default
  const rotated = places.map((p) => ({ ...p, rot: p.rot ?? [Math.PI / 2, 0, 0] as [number, number, number] }));
  return instanced(g, mat, rotated);
}

/** Domed rivets — smaller, rounder, closer-spaced than bolts. */
export function rivets(places: Placement[], mat: THREE.Material, size = 0.011): THREE.InstancedMesh {
  const key = `rv|${size.toFixed(4)}`;
  let g = geoCache.get(key);
  if (!g) {
    g = new THREE.SphereGeometry(size, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2);
    geoCache.set(key, g);
  }
  return instanced(g, mat, places);
}

/** Evenly spaced placements along a line — for bolt rows and rivet seams. */
export function along(
  from: [number, number, number],
  to: [number, number, number],
  count: number,
  rot?: [number, number, number]
): Placement[] {
  const out: Placement[] = [];
  if (count < 1) return out;
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    out.push({
      pos: [
        from[0] + (to[0] - from[0]) * t,
        from[1] + (to[1] - from[1]) * t,
        from[2] + (to[2] - from[2]) * t,
      ],
      rot,
    });
  }
  return out;
}

/** Placements around a rectangle's perimeter, inset from the edge — flange bolt pattern. */
export function perimeter(w: number, h: number, z: number, inset: number, perSide: number, rot?: [number, number, number]): Placement[] {
  const x = w / 2 - inset;
  const y = h / 2 - inset;
  return [
    ...along([-x, y, z], [x, y, z], perSide, rot),
    ...along([-x, -y, z], [x, -y, z], perSide, rot),
    ...along([-x, y, z], [-x, -y, z], Math.max(2, perSide - 1), rot).slice(1, -1),
    ...along([x, y, z], [x, -y, z], Math.max(2, perSide - 1), rot).slice(1, -1),
  ];
}

/**
 * Recessed panel seam — a thin dark strip sunk just below the surface. Reads as a
 * joint between two fabricated plates rather than a painted line.
 */
export function seam(length: number, mat: THREE.Material, opts: MeshOpts & { vertical?: boolean; width?: number } = {}): THREE.Mesh {
  const t = opts.width ?? 0.012;
  const g = opts.vertical ? flatBox(t, length, t) : flatBox(length, t, t);
  return part(g, mat, { ...opts, shadow: false });
}

/**
 * Weld bead — a slightly lumpy cylinder run along a joint. Catches light
 * differently from the plates it joins, which is what sells the join.
 */
export function weld(length: number, mat: THREE.Material, opts: MeshOpts & { thickness?: number } = {}): THREE.Mesh {
  const r = opts.thickness ?? 0.013;
  const g = cyl(r, r, length, 6);
  const m = part(g, mat, opts);
  m.castShadow = false;
  return m;
}

/** Barrel hinge — knuckle + pin, for doors, hatches and panels. */
export function hinge(height: number, mat: THREE.Material, pinMat: THREE.Material, opts: MeshOpts = {}): THREE.Group {
  const g = new THREE.Group();
  const kn = 0.026;
  for (const y of [-height / 2 + kn, 0, height / 2 - kn]) {
    g.add(part(cyl(kn, kn, kn * 1.6, 8), mat, { pos: [0, y, 0] }));
  }
  g.add(part(cyl(kn * 0.42, kn * 0.42, height, 6), pinMat, { pos: [0, 0, 0] }));
  if (opts.pos) g.position.set(...opts.pos);
  if (opts.rot) g.rotation.set(...opts.rot);
  return g;
}

/**
 * Louvred vent — frame plus angled slats. Real slats, not a texture, so the
 * silhouette breaks and the interior self-shadows.
 */
export function vent(w: number, h: number, mat: THREE.Material, slatMat: THREE.Material, opts: MeshOpts = {}): THREE.Group {
  const g = new THREE.Group();
  const t = 0.03;
  g.add(bev(w, t, 0.06, mat, { pos: [0, h / 2, 0] }));
  g.add(bev(w, t, 0.06, mat, { pos: [0, -h / 2, 0] }));
  g.add(bev(t, h, 0.06, mat, { pos: [-w / 2, 0, 0] }));
  g.add(bev(t, h, 0.06, mat, { pos: [w / 2, 0, 0] }));
  const n = Math.max(2, Math.floor(h / 0.055));
  for (let i = 0; i < n; i++) {
    const y = -h / 2 + ((i + 0.7) * h) / n;
    g.add(part(flatBox(w - t * 2, 0.028, 0.05), slatMat, { pos: [0, y, 0.004], rot: [-0.62, 0, 0] }));
  }
  if (opts.pos) g.position.set(...opts.pos);
  if (opts.rot) g.rotation.set(...opts.rot);
  return g;
}

/**
 * Half-round gutter with end caps, plus optional downpipe. Sits proud of the
 * fascia on brackets — one of the strongest "this is a real building" cues.
 */
export function gutter(length: number, mat: THREE.Material, opts: MeshOpts & { downpipe?: number } = {}): THREE.Group {
  const g = new THREE.Group();
  const r = 0.055;
  const trough = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, length, 10, 1, true, 0, Math.PI),
    mat
  );
  trough.rotation.set(0, 0, Math.PI / 2);
  trough.castShadow = true;
  trough.receiveShadow = true;
  (trough.material as THREE.Material).side = THREE.DoubleSide;
  g.add(trough);
  for (const x of [-length / 2, length / 2]) {
    g.add(part(cyl(r, r, 0.012, 10), mat, { pos: [x, 0, 0], rot: [0, 0, Math.PI / 2] }));
  }
  // brackets every ~1.2 m
  const n = Math.max(2, Math.round(length / 1.2));
  for (let i = 0; i < n; i++) {
    const x = -length / 2 + ((i + 0.5) * length) / n;
    g.add(part(flatBox(0.02, 0.09, r * 2.3), mat, { pos: [x, 0.01, -r * 0.5], shadow: false }));
  }
  if (opts.downpipe) {
    const dp = part(cyl(0.038, 0.038, opts.downpipe, 8), mat, { pos: [length / 2 - 0.1, -opts.downpipe / 2 - r, 0] });
    g.add(dp);
    for (let i = 1; i < Math.max(2, Math.round(opts.downpipe / 1.5)); i++) {
      g.add(part(flatBox(0.09, 0.02, 0.09), mat, {
        pos: [length / 2 - 0.1, -r - (i * opts.downpipe) / Math.round(opts.downpipe / 1.5), 0],
        shadow: false,
      }));
    }
  }
  if (opts.pos) g.position.set(...opts.pos);
  if (opts.rot) g.rotation.set(...opts.rot);
  return g;
}

/**
 * Window assembly: reveal, frame, mullions, glass, sill with a drip edge.
 * The sill projects and is sloped — that projection is what casts the shadow
 * line that makes a window read as set into a wall rather than printed on it.
 */
export function window(
  w: number,
  h: number,
  wallThickness: number,
  frameMat: THREE.Material,
  glassMat: THREE.Material,
  sillMat: THREE.Material,
  opts: MeshOpts & { mullions?: number } = {}
): THREE.Group {
  const g = new THREE.Group();
  const f = 0.055;
  const t = wallThickness;
  g.add(bev(w + f, f, t * 0.9, frameMat, { pos: [0, h / 2, 0] }));
  g.add(bev(w + f, f, t * 0.9, frameMat, { pos: [0, -h / 2, 0] }));
  g.add(bev(f, h, t * 0.9, frameMat, { pos: [-w / 2, 0, 0] }));
  g.add(bev(f, h, t * 0.9, frameMat, { pos: [w / 2, 0, 0] }));
  const mull = opts.mullions ?? 1;
  for (let i = 1; i <= mull; i++) {
    g.add(bev(0.035, h - f, t * 0.5, frameMat, { pos: [-w / 2 + (i * w) / (mull + 1), 0, 0] }));
  }
  const glass = part(flatBox(w - f * 0.5, h - f * 0.5, 0.012), glassMat, { pos: [0, 0, 0], shadow: false });
  g.add(glass);
  // sill: projects 40 mm past the wall face, sloped to shed water
  const sill = part(flatBox(w + 0.18, 0.05, t + 0.09), sillMat, { pos: [0, -h / 2 - 0.05, 0.02], rot: [-0.06, 0, 0] });
  g.add(sill);
  if (opts.pos) g.position.set(...opts.pos);
  if (opts.rot) g.rotation.set(...opts.rot);
  return g;
}
