// Surface system — PBR materials with calibrated texel density.
//
// Why projection instead of mesh UVs: BoxGeometry hands every face UV 0..1, so a
// 4 m wall face and its 0.2 m return edge resolve at 20x different texel density.
// Beveled geometry makes that worse (corner strips get their own arbitrary UVs).
// Projecting from position along the dominant normal axis makes density a function
// of one number — metres-per-tile — so density is uniform across every face of
// every object that shares a material, by construction.
//
// The same injection buys three more things the eye actually reads:
//   · anti-tiling  — a second sample at an incommensurate scale modulates albedo,
//                    breaking the grid without a second texture
//   · dirt decals  — grime accumulates toward the ground, dust settles on up-faces
//   · edge wear    — roughness varies with the macro sample instead of being flat
import * as THREE from "three";
import { MATERIALS, type MaterialKey } from "./constants";
import { cardTexture } from "./textures";

export interface SurfaceOpts {
  /** Metres covered by one texture tile. Defaults to the card's realSize. */
  tile?: number;
  /** 0 = static world geometry (project in world space); 1 = movable object (project in object space). */
  local?: boolean;
  /** Strength of the anti-tiling macro breakup, 0..1. */
  macro?: number;
  /** Strength of ground-accumulated grime, 0..1. */
  grime?: number;
  /** World height in metres over which grime fades out. */
  grimeHeight?: number;
  /** Strength of settled dust on up-facing surfaces, 0..1. */
  dust?: number;
  /** Multiplier on the card's roughness. */
  roughness?: number;
  /** Multiplier on the card's metalness. */
  metalness?: number;
  /** Flat tint applied to albedo. Multiplicative, so it can only darken. */
  tint?: number;
  /**
   * Albedo gamma. Below 1 lifts shadows without blowing highlights — the way to
   * rescue a photographic atlas cell that crushes to black under a low sun.
   * `tint` cannot do this: multiplying by a colour only ever darkens.
   */
  gamma?: number;
  /** Linear albedo gain applied after gamma. */
  gain?: number;
}

const cache = new Map<string, THREE.MeshStandardMaterial>();

const PARS = /* glsl */ `
  varying vec3 vProjPos;
  varying vec3 vProjNrm;
  varying float vWorldY;
`;

const VERT_TAIL = /* glsl */ `
  #ifdef PROJ_LOCAL
    vProjPos = position;
    vProjNrm = normal;
  #else
    vProjPos = (modelMatrix * vec4(position, 1.0)).xyz;
    vProjNrm = mat3(modelMatrix) * normal;
  #endif
  vWorldY = (modelMatrix * vec4(position, 1.0)).y;
`;

// Replaces <map_fragment>: dominant-axis projection + macro breakup + grime.
const MAP_FRAG = /* glsl */ `
  vec3 pn = normalize(vProjNrm);
  vec3 an = abs(pn);
  vec2 puv;
  if (an.y >= an.x && an.y >= an.z)      puv = vProjPos.xz;
  else if (an.x >= an.z)                 puv = vProjPos.zy;
  else                                   puv = vProjPos.xy;
  puv /= uTile;

  vec4 sampledDiffuseColor = texture2D(map, puv);
  sampledDiffuseColor.rgb = pow(sampledDiffuseColor.rgb, vec3(uGamma)) * uGain;

  // Anti-tiling: 0.173 is deliberately incommensurate with 1.0, so the macro
  // pattern never lines up with the base tile grid.
  vec3 macro = texture2D(map, puv * 0.173 + vec2(0.37, 0.61)).rgb;
  float macroLum = dot(macro, vec3(0.299, 0.587, 0.114));
  sampledDiffuseColor.rgb *= mix(1.0, 0.68 + 0.72 * macroLum, uMacro);

  // Dirt accumulates from the ground up — strongest at the base of a wall.
  float grime = 1.0 - smoothstep(0.0, uGrimeH, max(vWorldY, 0.0));
  grime *= 0.65 + 0.35 * macroLum;
  sampledDiffuseColor.rgb *= mix(1.0, 0.55, grime * uGrime);

  // Dust settles on up-facing surfaces and desaturates them toward pale grey.
  float dustAmt = clamp(pn.y, 0.0, 1.0) * uDust * (0.55 + 0.45 * macroLum);
  sampledDiffuseColor.rgb = mix(sampledDiffuseColor.rgb, vec3(0.62, 0.56, 0.46), dustAmt * 0.5);

  diffuseColor *= sampledDiffuseColor;
`;

// Edge wear read from the macro sample. Computed once and stashed, because
// roughnessFactor and metalnessFactor are declared in separate chunks — the
// metalness one does not exist yet when the roughness chunk runs.
const WEAR_FRAG = /* glsl */ `
  vec3 pnW = normalize(vProjNrm);
  vec3 anW = abs(pnW);
  vec2 puvW;
  if (anW.y >= anW.x && anW.y >= anW.z)      puvW = vProjPos.xz;
  else if (anW.x >= anW.z)                   puvW = vProjPos.zy;
  else                                       puvW = vProjPos.xy;
  float wear = dot(texture2D(map, puvW / uTile * 0.173 + vec2(0.37, 0.61)).rgb, vec3(0.299, 0.587, 0.114));
`;

const ROUGH_FRAG = /* glsl */ `
  roughnessFactor *= mix(0.82, 1.18, wear);
  roughnessFactor = clamp(roughnessFactor, 0.04, 1.0);
`;

// Worn metal has its oxide scoured off, so it reads slightly more metallic.
const METAL_FRAG = /* glsl */ `
  metalnessFactor *= mix(1.08, 0.86, wear);
  metalnessFactor = clamp(metalnessFactor, 0.0, 1.0);
`;

export function surface(key: MaterialKey, opts: SurfaceOpts = {}): THREE.MeshStandardMaterial {
  const card = MATERIALS[key];
  const tile = opts.tile ?? card.realSize;
  const o = {
    tile,
    local: opts.local ?? false,
    macro: opts.macro ?? 0.55,
    grime: opts.grime ?? 0.5,
    grimeHeight: opts.grimeHeight ?? 1.6,
    dust: opts.dust ?? 0.35,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 1,
    tint: opts.tint ?? 0xffffff,
    gamma: opts.gamma ?? 1,
    gain: opts.gain ?? 1,
  };
  const cacheKey = `${card.id}|${o.tile}|${o.local}|${o.macro}|${o.grime}|${o.grimeHeight}|${o.dust}|${o.roughness}|${o.metalness}|${o.tint}|${o.gamma}|${o.gain}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;

  const mat = new THREE.MeshStandardMaterial({
    map: cardTexture(card, 1),
    color: o.tint,
    roughness: THREE.MathUtils.clamp(card.roughness * o.roughness, 0.04, 1),
    metalness: THREE.MathUtils.clamp(card.metalness * o.metalness, 0, 1),
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTile = { value: o.tile };
    shader.uniforms.uMacro = { value: o.macro };
    shader.uniforms.uGrime = { value: o.grime };
    shader.uniforms.uGrimeH = { value: o.grimeHeight };
    shader.uniforms.uDust = { value: o.dust };
    shader.uniforms.uGamma = { value: o.gamma };
    shader.uniforms.uGain = { value: o.gain };

    const decls = `uniform float uTile;\nuniform float uMacro;\nuniform float uGrime;\nuniform float uGrimeH;\nuniform float uDust;\nuniform float uGamma;\nuniform float uGain;\n${PARS}`;

    shader.vertexShader = `${o.local ? "#define PROJ_LOCAL\n" : ""}${PARS}\n${shader.vertexShader}`.replace(
      "#include <fog_vertex>",
      `#include <fog_vertex>\n${VERT_TAIL}`
    );

    shader.fragmentShader = `${o.local ? "#define PROJ_LOCAL\n" : ""}${decls}\n${shader.fragmentShader}`
      .replace("#include <map_fragment>", MAP_FRAG)
      .replace("#include <roughnessmap_fragment>", `${WEAR_FRAG}\n#include <roughnessmap_fragment>\n${ROUGH_FRAG}`)
      .replace("#include <metalnessmap_fragment>", `#include <metalnessmap_fragment>\n${METAL_FRAG}`);
  };
  // Distinct key so three compiles (and caches) one program per option set.
  mat.customProgramCacheKey = () => cacheKey;

  cache.set(cacheKey, mat);
  return mat;
}

/** Untextured PBR for painted metal, rubber, glass — still gets real roughness. */
export function plain(color: number, roughness = 0.7, metalness = 0.1, opts: { emissive?: number; emissiveIntensity?: number } = {}) {
  const key = `plain|${color}|${roughness}|${metalness}|${opts.emissive ?? -1}|${opts.emissiveIntensity ?? 0}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
  });
  cache.set(key, m);
  return m;
}
