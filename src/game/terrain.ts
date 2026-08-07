// Terrain — displaced heightfield with a 4-way splat blend.
//
// The old ground was a single 1x1-segment plane: perfectly flat to the horizon,
// one texture, tiling visibly all the way out. Real ground does none of that.
//
// This replaces it with a deterministic fBm heightfield, per-vertex splat weights
// blending four surface materials, and flat pads under every structure so the
// existing buildings still sit level (a building on rolling ground either floats
// at one corner or buries at another — real sites are graded flat first).
//
// heightAt() is the single source of truth: the mesh, the player's feet, entity
// grounding and prop placement all sample the same function.
import * as THREE from "./three";
import { WORLD, MATERIALS, QUALITY } from "./constants";
import { cardTexture } from "./textures";

// ─────────────────────────── deterministic noise ───────────────────────────

const SEED = 9137;

function hash(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(SEED, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const a = hash(xi, zi), b = hash(xi + 1, zi);
  const c = hash(xi, zi + 1), d = hash(xi + 1, zi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function fbm(x: number, z: number, octaves = 4): number {
  let sum = 0, amp = 0.5, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += vnoise(x * freq, z * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

// ─────────────────────────── graded pads ───────────────────────────

/** A graded building pad: flat inside, blended to natural ground across `fade`. */
export interface Pad {
  x: number;
  z: number;
  halfW: number;
  halfD: number;
  fade: number;
}

// Every structure in world.ts sits on one of these. Sizes are the footprint plus
// a working margin, matching how a real site is cut and levelled before building.
const PADS: Pad[] = [
  { x: -6, z: -44, halfW: 15, halfD: 15, fade: 9 },   // home base compound
  { x: 30, z: 44, halfW: 10, halfD: 8, fade: 7 },     // homestead
  { x: 31, z: -29, halfW: 9, halfD: 8, fade: 6 },     // container yard (east)
  { x: -45, z: 23, halfW: 8, halfD: 7, fade: 6 },     // container yard (west)
  { x: -26, z: -18, halfW: 8, halfD: 8, fade: 6 },    // ruins
  { x: -38, z: -6, halfW: 8, halfD: 8, fade: 6 },
  { x: 36, z: 20, halfW: 8, halfD: 8, fade: 6 },
  { x: 48, z: 6, halfW: 8, halfD: 8, fade: 6 },
  { x: -20, z: 34, halfW: 8, halfD: 8, fade: 6 },
  { x: 62, z: 62, halfW: 26, halfD: 26, fade: 14 },   // boss arena — graded flat to fight on
  { x: 14, z: 0, halfW: 6, halfD: WORLD.SIZE / 2, fade: 7 }, // highway corridor
];

/** Signed distance to a rectangle, negative inside. */
function rectDist(x: number, z: number, p: Pad): number {
  const dx = Math.abs(x - p.x) - p.halfW;
  const dz = Math.abs(z - p.z) - p.halfD;
  const ox = Math.max(dx, 0), oz = Math.max(dz, 0);
  return Math.hypot(ox, oz) + Math.min(Math.max(dx, dz), 0);
}

function naturalHeight(x: number, z: number): number {
  return (
    (fbm(x * 0.0095, z * 0.0095, 4) - 0.5) * 3.6 +
    (fbm(x * 0.042, z * 0.042, 3) - 0.5) * 0.9 +
    (fbm(x * 0.15, z * 0.15, 2) - 0.5) * 0.2
  );
}

/** Ground height in metres. The authority for terrain, feet and prop grounding. */
export function heightAt(x: number, z: number): number {
  const natural = naturalHeight(x, z);

  // Take only the pad with the strongest claim, never a chain of them.
  //
  // Blending pads sequentially compounds: the highway corridor's 7 m fade reaches
  // x=27, which is inside the homestead pad, so the ground under the west half of
  // the house was being dragged toward road level. The house is built off one
  // datum — heightAt at its centre — so its west wall and stairs ended up 0.4 m
  // into a ridge. Nearest pad wins, and a point fully inside any pad is exactly
  // that pad's level.
  let bestT = 1;
  let bestLevel = natural;
  for (const p of PADS) {
    const d = rectDist(x, z, p);
    if (d >= p.fade) continue;
    const t = THREE.MathUtils.smoothstep(d, 0, p.fade); // 0 on the pad, 1 natural
    if (t < bestT) {
      bestT = t;
      bestLevel = naturalHeight(p.x, p.z);
    }
  }
  // The wash carves last: nothing graded overlaps it (probe-verified), so the
  // subtraction never fights a pad, and every consumer of heightAt — mesh,
  // feet, grounding, prop placement — inherits the channel automatically.
  return THREE.MathUtils.lerp(bestLevel, natural, bestT) - washCarve(x, z);
}

// ─────────────────────────── dry wash ───────────────────────────
// Batch 2 (item 12): a shallow eroded channel crossing the empty south-east
// quadrant on a 45° diagonal. Analytic like the rest of the field: a signed
// across-line coordinate, a slow sinusoidal meander, and a smoothstep bank
// profile, so the mesh, feet, grounding and prop placement all inherit it from
// heightAt alone.
//
// 400 m map: the unbent line (z − x + 155 = 0) would leave the south edge at
// (−45,−200) — straight through the graded highway corridor pad at ≈(14,−141),
// carving a 1.6 m channel under the road. So past u ≈ −35 (just down-wash of
// the old map's south edge) the centreline bends south-east through the new,
// deliberately empty outer ring and exits the south edge near (119,−200). The
// drift is exactly 0 across u ∈ [−35, ∞), so the bridge (u=8), culvert (u=−20)
// and every core asset see an unchanged channel. North-east it runs unbent and
// exits the east edge at (200,45): the wash now genuinely crosses the bigger
// map edge-to-edge.
//
// Siting was re-probed against every known asset footprint and every graded pad
// after the bend: the carve is 0 at all of them (nearest approach to any pad's
// fade edge is ≈16 m, highway corridor vs the bend) — so no existing asset
// floats or buries. The bridge and culvert centres sit IN the channel by
// design; their abutments/headwalls ground through heightAt like everything.
const WASH = {
  halfW: 3.2,        // half the flat-ish channel bed — ~6.4 m wide
  bank: 6.0,         // sloped bank run beyond the bed → outer influence 9.2 m
  depth: 1.6,        // mid of the 1.2–2 m brief; breathes ±10% along its length
  meanderAmp: 3,
  meanderFreq: 0.0524, // ~120 m wavelength
  meanderPhase: 1.7,
  bendStart: -35,    // u where the southern bend begins (0 drift up-wash of this)
  bendEnd: -62,      // u where the bend has fully turned
  bendDrift: -124,   // total across-line offset once the bend completes
} as const;

/** Along-wash coordinate in metres (origin near map centre). */
export function washU(x: number, z: number): number { return (x + z) * Math.SQRT1_2; }
/** Across-wash signed coordinate: 0 on the unmeandered centreline. */
export function washV(x: number, z: number): number { return (z - x + 155) * Math.SQRT1_2; }
/** Centreline meander offset, in v. */
export function washMeander(u: number): number {
  return WASH.meanderAmp * Math.sin(WASH.meanderFreq * u + WASH.meanderPhase);
}

/**
 * Southern extension drift, in v: 0 across the whole inhabited map, ramping to
 * bendDrift through the new outer ring so the channel turns away from the
 * highway corridor and out the south edge. Smoothstepped, so the bend is a
 * curve, not a kink.
 */
function washDrift(u: number): number {
  if (u >= WASH.bendStart) return 0;
  const t = THREE.MathUtils.smoothstep(u, WASH.bendEnd, WASH.bendStart); // 1 at bendStart, 0 at bendEnd
  return (1 - t) * WASH.bendDrift;
}

/** Total centreline offset in v: meander everywhere, drift only in the new ring. */
function washOffset(u: number): number {
  return washMeander(u) + washDrift(u);
}

/** Distance from (x,z) to the meandering centreline. */
export function washDist(x: number, z: number): number {
  return Math.abs(washV(x, z) - washOffset(washU(x, z)));
}

/**
 * World-space centreline point and frame at along-coordinate u.
 * tangent t runs down-wash (+45°), normal n across it (+v side).
 */
export function washCenter(u: number): { x: number; z: number; tx: number; tz: number; nx: number; nz: number } {
  const w = washOffset(u);
  return {
    x: 77.5 + (u - w) * Math.SQRT1_2,
    z: -77.5 + (u + w) * Math.SQRT1_2,
    tx: Math.SQRT1_2, tz: Math.SQRT1_2,
    nx: -Math.SQRT1_2, nz: Math.SQRT1_2,
  };
}

export function washCarve(x: number, z: number): number {
  const d = washDist(x, z);
  if (d >= WASH.halfW + WASH.bank) return 0;
  const t = 1 - THREE.MathUtils.smoothstep(d, WASH.halfW, WASH.halfW + WASH.bank);
  // Depth breathes ±10% along the channel, and the bed keeps a fine gravel
  // roughness instead of being planed smooth.
  const depth = WASH.depth * (0.9 + 0.2 * fbm(washU(x, z) * 0.05 + 3.1, 8.7, 2));
  const rough = (fbm(x * 0.4 + 9, z * 0.4 + 5, 2) - 0.5) * 0.14;
  return depth * t - rough * t * t;
}

/** Surface normal by central difference — used to orient props to the slope. */
export function normalAt(x: number, z: number, eps = 0.6): THREE.Vector3 {
  const hL = heightAt(x - eps, z), hR = heightAt(x + eps, z);
  const hD = heightAt(x, z - eps), hU = heightAt(x, z + eps);
  return new THREE.Vector3(hL - hR, 2 * eps, hD - hU).normalize();
}

// ─────────────────────────── splat weighting ───────────────────────────

/** Noise-perturbed radial falloff so biome edges are ragged, never circular. */
function blob(x: number, z: number, cx: number, cz: number, r: number): number {
  const wobble = (fbm(x * 0.05 + 11, z * 0.05 + 7, 3) - 0.5) * r * 0.55;
  const d = Math.hypot(x - cx, z - cz) + wobble;
  return 1 - THREE.MathUtils.smoothstep(d, r * 0.55, r);
}

/** [dirt, scorch, rustSand, dryMud] weights, normalized. */
function splatAt(x: number, z: number): [number, number, number, number] {
  const scorch = blob(x, z, 62, 62, 30);
  const rust = blob(x, z, -58, -50, 33);
  const mud = blob(x, z, -52, 48, 22);
  // 400 m map: two more fields out in the new ring so the added ground isn't
  // one endless dirt substrate. Both centres sit >55 m past the old ±100 edge
  // (beyond their radius plus wobble), so the core map's blend is untouched
  // and the scorch arena stays exactly where it was.
  const rustOuter = blob(x, z, 152, 118, 40);
  const mudOuter = blob(x, z, -150, -130, 42);
  const rustAll = Math.max(rust, rustOuter);
  const mudAll = Math.max(mud, mudOuter);
  // Dirt is the substrate; it never fully disappears, which keeps the blend honest.
  const dirt = Math.max(0.12, 1 - Math.max(scorch, rustAll, mudAll));
  const sum = dirt + scorch + rustAll + mudAll;
  return [dirt / sum, scorch / sum, rustAll / sum, mudAll / sum];
}

// ─────────────────────────── material ───────────────────────────

const CHANNELS = ["TER01", "TER05", "TER06", "TER09"] as const;

function terrainMaterial(): THREE.MeshStandardMaterial {
  const maps = CHANNELS.map((k) => cardTexture(MATERIALS[k], 1));
  const tiles = CHANNELS.map((k) => MATERIALS[k].realSize);

  const mat = new THREE.MeshStandardMaterial({
    map: maps[0],
    roughness: 0.95,
    metalness: 0,
    vertexColors: true,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMap1 = { value: maps[1] };
    shader.uniforms.uMap2 = { value: maps[2] };
    shader.uniforms.uMap3 = { value: maps[3] };
    shader.uniforms.uTiles = { value: new THREE.Vector4(tiles[0], tiles[1], tiles[2], tiles[3]) };

    shader.vertexShader = `
      attribute vec4 aSplat;
      varying vec4 vSplat;
      varying vec3 vTerrPos;
    ${shader.vertexShader}`.replace(
      "#include <fog_vertex>",
      `#include <fog_vertex>
       vSplat = aSplat;
       vTerrPos = (modelMatrix * vec4(position, 1.0)).xyz;`
    );

    shader.fragmentShader = `
      uniform sampler2D uMap1;
      uniform sampler2D uMap2;
      uniform sampler2D uMap3;
      uniform vec4 uTiles;
      varying vec4 vSplat;
      varying vec3 vTerrPos;
    ${shader.fragmentShader}`.replace(
      "#include <map_fragment>",
      /* glsl */ `
        vec2 base = vTerrPos.xz;
        vec4 w = vSplat / max(dot(vSplat, vec4(1.0)), 1e-4);

        vec3 c0 = texture2D(map,   base / uTiles.x).rgb;
        vec3 c1 = texture2D(uMap1, base / uTiles.y).rgb;
        vec3 c2 = texture2D(uMap2, base / uTiles.z).rgb;
        vec3 c3 = texture2D(uMap3, base / uTiles.w).rgb;
        vec3 col = c0 * w.x + c1 * w.y + c2 * w.z + c3 * w.w;

        // Anti-tiling: two incommensurate low-frequency passes over the same
        // substrate break the 4 m grid. Kept subtle — pushed hard it stops reading
        // as ground variation and starts reading as huge dirty blotches.
        float ml = dot(texture2D(map, base * 0.0121 + vec2(0.23, 0.71)).rgb, vec3(0.299, 0.587, 0.114));
        col *= 0.90 + 0.21 * ml;

        float mid = texture2D(map, base * 0.037 + vec2(0.44, 0.19)).g;
        col *= 0.94 + 0.13 * mid;

        // Third, finer breakup so the near ground isn't uniformly mottled.
        float fine = texture2D(map, base * 0.081 + vec2(0.61, 0.13)).g;
        col *= 0.95 + 0.10 * fine;

        diffuseColor *= vec4(col, 1.0);
      `
    ).replace(
      "#include <roughnessmap_fragment>",
      /* glsl */ `
        #include <roughnessmap_fragment>
        // Scorched ground is matte; mud flats hold a damp sheen.
        roughnessFactor *= mix(1.0, 1.06, vSplat.y);
        roughnessFactor *= mix(1.0, 0.80, vSplat.w);
      `
    );
  };
  mat.customProgramCacheKey = () => "rustfall-terrain-splat";
  return mat;
}

// ─────────────────────────── mesh ───────────────────────────

export class Terrain {
  readonly mesh: THREE.Mesh;

  /**
   * `extent` deliberately overruns the 400 m playable area. Terminating the mesh
   * at the world bound leaves a hard silhouette against the sky at eye level;
   * running it out past the fog distance means the ground simply dissolves.
   *
   * `segments` arrives from engine.ts as a per-tier floor (220 desktop /
   * 140 mobile, tuned when the extent was 350 m). At the 700 m extent those
   * counts would give 3.2 m/vertex desktop — past the ~1.8 m budget — so the
   * constructor refines the floor up to the tier's target spacing:
   *   desktop: ceil(700 / 1.75) = 400 segments → 401² verts, 1.75 m/vertex
   *   mobile:  ceil(700 / 2.80) = 250 segments → 251² verts, 2.80 m/vertex
   */
  constructor(segments = 220, extent = WORLD.SIZE * 1.75) {
    const S = extent;
    const maxSpacing = QUALITY.mobile ? 2.8 : 1.75;
    const segs = Math.max(segments, Math.ceil(S / maxSpacing));
    const geo = new THREE.PlaneGeometry(S, S, segs, segs);
    geo.rotateX(-Math.PI / 2); // into XZ before displacing, so Y is world up

    const pos = geo.attributes.position as THREE.BufferAttribute;
    const n = pos.count;
    const splat = new Float32Array(n * 4);
    const colors = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      pos.setY(i, heightAt(x, z));

      const [a, b, c, d] = splatAt(x, z);
      splat[i * 4 + 0] = a;
      splat[i * 4 + 1] = b;
      splat[i * 4 + 2] = c;
      splat[i * 4 + 3] = d;

      // Large-scale tonal drift so even one material never reads as one colour.
      const t = 0.94 + fbm(x * 0.008 + 31, z * 0.008 + 17, 3) * 0.13;
      colors[i * 3 + 0] = t;
      colors[i * 3 + 1] = t * 0.985;
      colors[i * 3 + 2] = t * 0.95;
    }

    geo.setAttribute("aSplat", new THREE.BufferAttribute(splat, 4));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    this.mesh = new THREE.Mesh(geo, terrainMaterial());
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.name = "terrain";
  }

  heightAt(x: number, z: number) { return heightAt(x, z); }
}
