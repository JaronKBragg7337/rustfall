// RUSTFALL — world constants & material cards
// Conventions: 1 unit = 1 meter, right-handed, +Y up, forward +Z, right +X.
export const WORLD = {
  SIZE: 200, // meters, square
  MODULE: 4.0, // structural module
  WALL_H: 3.0, // wall height
  THICK: 0.2, // wall/floor thickness
  SNAP: 1.0, // general snap
  SNAP_TRIM: 0.5,
  CELLS: 50, // SIZE / MODULE
} as const;

// Device tier. Phones get a smaller shadow frustum, fewer texels, and a hard
// pixel-ratio cap — a 3x-DPR phone rendering at native res is ~9x the fill rate
// of a laptop for no visible gain at that screen size.
const COARSE_POINTER = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
const NARROW = typeof window !== "undefined" && Math.min(window.innerWidth, window.innerHeight) < 820;
export const IS_TOUCH = COARSE_POINTER || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0);
export const IS_MOBILE = IS_TOUCH && NARROW;

export const QUALITY = {
  mobile: IS_MOBILE,
  maxPixelRatio: IS_MOBILE ? 2 : 1.75,
  shadowMapSize: IS_MOBILE ? 1024 : 2048,
  shadowRadius: IS_MOBILE ? 34 : 45,
  shamblers: IS_MOBILE ? 5 : 8,
  props: IS_MOBILE ? 34 : 64,
} as const;

// ── Quality presets (Batch 3, item 17) ──
// The Settings panel can override the AUTO (device-tier) defaults. Doctrine
// Part 5's two mobile columns become the bookends: HIGH is the "modern"
// preset (≤2 DPR, 2048 tracked shadows), BATTERY the "conservative" one
// (≤1 DPR, 512 map). Entity/prop counts follow the preset on the next boot —
// respawning the population mid-run would be chaos.
export type QualityPreset = "AUTO" | "HIGH" | "BALANCED" | "BATTERY";

export const QUALITY_KEY = "rustfall.quality";

export interface QualitySettings {
  maxPixelRatio: number;
  shadowMapSize: number;
  shadowRadius: number;
  /** Population budgets; applied at world build time (next boot). */
  shamblers: number;
  props: number;
  fuelCans: number;
}

export function qualitySettings(p: QualityPreset): QualitySettings {
  switch (p) {
    case "HIGH":
      return { maxPixelRatio: 2, shadowMapSize: 2048, shadowRadius: 45, shamblers: 8, props: 64, fuelCans: 8 };
    case "BALANCED":
      return { maxPixelRatio: 1.5, shadowMapSize: 1024, shadowRadius: 40, shamblers: 6, props: 48, fuelCans: 6 };
    case "BATTERY":
      return { maxPixelRatio: 1, shadowMapSize: 512, shadowRadius: 34, shamblers: 4, props: 28, fuelCans: 5 };
    default:
      return {
        maxPixelRatio: QUALITY.maxPixelRatio,
        shadowMapSize: QUALITY.shadowMapSize,
        shadowRadius: QUALITY.shadowRadius,
        shamblers: QUALITY.shamblers,
        props: QUALITY.props,
        fuelCans: QUALITY.mobile ? 5 : 8,
      };
  }
}

export function getQualityPreset(): QualityPreset {
  try {
    const raw = localStorage.getItem(QUALITY_KEY);
    if (raw === "HIGH" || raw === "BALANCED" || raw === "BATTERY") return raw;
  } catch {
    /* no storage — AUTO */
  }
  return "AUTO";
}

export function storeQualityPreset(p: QualityPreset) {
  try {
    localStorage.setItem(QUALITY_KEY, p);
  } catch {
    /* private mode: session-only */
  }
}

// The home base is a sanctuary: hostiles will not path inside it and the player
// recovers there. `feather` is the band over which the repulsion ramps up, so
// robots veer away from the perimeter instead of pinballing off an invisible wall.
export const SAFE_ZONE = { x: -6, z: -44, radius: 18, feather: 5 } as const;

/** 0 outside the zone, ramping to 1 well inside it. */
export function safeZoneFactor(x: number, z: number): number {
  const d = Math.hypot(x - SAFE_ZONE.x, z - SAFE_ZONE.z);
  if (d >= SAFE_ZONE.radius) return 0;
  return Math.min(1, (SAFE_ZONE.radius - d) / SAFE_ZONE.feather);
}

// Deterministic RNG — seeded LCG so the whole wasteland is reproducible.
export function makeRng(seed = 9137) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Grid address scheme: every world position maps to a stable label L{level}-H{col}-R{row}
export function gridAddress(x: number, z: number, level = 0): string {
  const col = Math.floor((x + WORLD.SIZE / 2) / WORLD.MODULE);
  const row = Math.floor((z + WORLD.SIZE / 2) / WORLD.MODULE);
  return `L${level}-H${String(col).padStart(2, "0")}-R${String(row).padStart(2, "0")}`;
}

export type AtlasName = "terrain" | "metal" | "structure" | "creature" | "industrial";
export type MaterialKey = keyof typeof MATERIALS;

export interface MaterialCard {
  id: string;
  atlas: AtlasName;
  cell: [number, number]; // [row, col] in the 3x3 atlas, row 0 = top
  roughness: number;
  metalness: number;
  realSize: number; // meters the cropped tile covers at repeat 1
  seamless: boolean;
  label: string;
}

// Material cards (Part 4 doctrine): every surface is data, not a vibe.
export const MATERIALS: Record<string, MaterialCard> = {
  TER01: { id: "TEX-TER-01", atlas: "terrain", cell: [0, 0], roughness: 0.95, metalness: 0, realSize: 4, seamless: true, label: "Cracked dirt" },
  TER02: { id: "TEX-TER-02", atlas: "terrain", cell: [0, 1], roughness: 0.96, metalness: 0, realSize: 3, seamless: true, label: "Rocky soil" },
  TER03: { id: "TEX-TER-03", atlas: "terrain", cell: [0, 2], roughness: 0.88, metalness: 0, realSize: 4, seamless: true, label: "Weathered asphalt" },
  TER04: { id: "TEX-TER-04", atlas: "terrain", cell: [1, 0], roughness: 0.94, metalness: 0, realSize: 3, seamless: true, label: "Aggregate concrete" },
  TER05: { id: "TEX-TER-05", atlas: "terrain", cell: [1, 1], roughness: 0.97, metalness: 0, realSize: 4, seamless: true, label: "Scorched earth" },
  TER06: { id: "TEX-TER-06", atlas: "terrain", cell: [1, 2], roughness: 0.93, metalness: 0, realSize: 4, seamless: true, label: "Rust sand" },
  TER07: { id: "TEX-TER-07", atlas: "terrain", cell: [2, 0], roughness: 0.95, metalness: 0, realSize: 3, seamless: true, label: "Rubble" },
  TER08: { id: "TEX-TER-08", atlas: "terrain", cell: [2, 1], roughness: 0.86, metalness: 0, realSize: 6, seamless: false, label: "Road + lane paint" },
  TER09: { id: "TEX-TER-09", atlas: "terrain", cell: [2, 2], roughness: 0.94, metalness: 0, realSize: 4, seamless: true, label: "Dry mud" },

  MET01: { id: "TEX-MET-01", atlas: "metal", cell: [0, 0], roughness: 0.78, metalness: 0.7, realSize: 2, seamless: true, label: "Rusted rivet plate" },
  MET02: { id: "TEX-MET-02", atlas: "metal", cell: [0, 1], roughness: 0.62, metalness: 0.55, realSize: 2, seamless: true, label: "Olive armor" },
  MET03: { id: "TEX-MET-03", atlas: "metal", cell: [0, 2], roughness: 0.42, metalness: 0.85, realSize: 2, seamless: true, label: "Brushed gunmetal" },
  MET04: { id: "TEX-MET-04", atlas: "metal", cell: [1, 0], roughness: 0.55, metalness: 0.8, realSize: 2, seamless: true, label: "Corrugated metal" },
  MET05: { id: "TEX-MET-05", atlas: "metal", cell: [1, 1], roughness: 0.6, metalness: 0.75, realSize: 1.5, seamless: true, label: "Diamond tread" },
  MET06: { id: "TEX-MET-06", atlas: "metal", cell: [1, 2], roughness: 0.7, metalness: 0.65, realSize: 2, seamless: true, label: "Battle plating" },
  MET07: { id: "TEX-MET-07", atlas: "metal", cell: [2, 0], roughness: 0.5, metalness: 0.8, realSize: 2, seamless: false, label: "Copper pipework" },
  MET08: { id: "TEX-MET-08", atlas: "metal", cell: [2, 1], roughness: 0.66, metalness: 0.4, realSize: 2, seamless: true, label: "Hazard stripes" },
  MET09: { id: "TEX-MET-09", atlas: "metal", cell: [2, 2], roughness: 0.45, metalness: 0.6, realSize: 2, seamless: false, label: "Control panel" },

  STR01: { id: "TEX-STR-01", atlas: "structure", cell: [0, 0], roughness: 0.9, metalness: 0, realSize: 3, seamless: true, label: "Weathered planks" },
  STR02: { id: "TEX-STR-02", atlas: "structure", cell: [0, 1], roughness: 0.72, metalness: 0.6, realSize: 3, seamless: true, label: "Shanty metal" },
  STR03: { id: "TEX-STR-03", atlas: "structure", cell: [0, 2], roughness: 0.88, metalness: 0, realSize: 3, seamless: true, label: "Old brick" },
  STR04: { id: "TEX-STR-04", atlas: "structure", cell: [1, 0], roughness: 0.92, metalness: 0, realSize: 4, seamless: true, label: "Graffiti concrete" },
  STR05: { id: "TEX-STR-05", atlas: "structure", cell: [1, 1], roughness: 0.74, metalness: 0.5, realSize: 3, seamless: true, label: "Scrap patchwork" },
  STR06: { id: "TEX-STR-06", atlas: "structure", cell: [1, 2], roughness: 0.96, metalness: 0, realSize: 2, seamless: true, label: "Sandbags" },
  STR07: { id: "TEX-STR-07", atlas: "structure", cell: [2, 0], roughness: 0.6, metalness: 0.7, realSize: 2, seamless: true, label: "Chain-link" },
  STR08: { id: "TEX-STR-08", atlas: "structure", cell: [2, 1], roughness: 0.9, metalness: 0, realSize: 2, seamless: false, label: "Plywood barricade" },
  STR09: { id: "TEX-STR-09", atlas: "structure", cell: [2, 2], roughness: 0.68, metalness: 0.6, realSize: 2.5, seamless: false, label: "Container blue" },

  CRV01: { id: "TEX-CRV-01", atlas: "creature", cell: [0, 0], roughness: 0.85, metalness: 0, realSize: 1, seamless: true, label: "Decayed flesh" },
  CRV02: { id: "TEX-CRV-02", atlas: "creature", cell: [0, 1], roughness: 0.9, metalness: 0, realSize: 1, seamless: true, label: "Bone & sinew" },
  CRV03: { id: "TEX-CRV-03", atlas: "creature", cell: [0, 2], roughness: 0.95, metalness: 0, realSize: 1, seamless: true, label: "Tire rubber" },
  CRV04: { id: "TEX-CRV-04", atlas: "creature", cell: [1, 0], roughness: 0.7, metalness: 0.3, realSize: 2, seamless: true, label: "Camo paint" },
  CRV05: { id: "TEX-CRV-05", atlas: "creature", cell: [1, 1], roughness: 0.94, metalness: 0, realSize: 1.5, seamless: true, label: "Olive canvas" },
  CRV06: { id: "TEX-CRV-06", atlas: "creature", cell: [1, 2], roughness: 0.88, metalness: 0, realSize: 1.5, seamless: false, label: "Worn leather" },
  CRV07: { id: "TEX-CRV-07", atlas: "creature", cell: [2, 0], roughness: 0.75, metalness: 0.5, realSize: 1, seamless: false, label: "Hazard barrel" },
  CRV08: { id: "TEX-CRV-08", atlas: "creature", cell: [2, 1], roughness: 0.3, metalness: 0.1, realSize: 1.5, seamless: true, label: "Cracked glass" },
  CRV09: { id: "TEX-CRV-09", atlas: "creature", cell: [2, 2], roughness: 0.4, metalness: 0.5, realSize: 2, seamless: true, label: "Energy cells" },

  // Industrial set — CC0 photographs (ambientCG), see assets/atlases/ATLAS_INDUSTRIAL_SOURCES.json.
  // Values follow doctrine Part 4 reference data (metalness 0 for dielectrics).
  IND01: { id: "TEX-IND-01", atlas: "industrial", cell: [0, 0], roughness: 0.6, metalness: 0.6, realSize: 2, seamless: true, label: "Corrugated steel" },
  IND02: { id: "TEX-IND-02", atlas: "industrial", cell: [0, 1], roughness: 0.55, metalness: 0.5, realSize: 2, seamless: true, label: "Painted metal" },
  IND03: { id: "TEX-IND-03", atlas: "industrial", cell: [0, 2], roughness: 0.9, metalness: 0, realSize: 2, seamless: true, label: "Weathered wood" },
  IND04: { id: "TEX-IND-04", atlas: "industrial", cell: [1, 0], roughness: 0.94, metalness: 0, realSize: 3, seamless: true, label: "Cast concrete" },
  IND05: { id: "TEX-IND-05", atlas: "industrial", cell: [1, 1], roughness: 0.88, metalness: 0, realSize: 3, seamless: true, label: "Damaged brick" },
  IND06: { id: "TEX-IND-06", atlas: "industrial", cell: [1, 2], roughness: 0.96, metalness: 0, realSize: 3, seamless: true, label: "Gravel ballast" },
  IND07: { id: "TEX-IND-07", atlas: "industrial", cell: [2, 0], roughness: 0.88, metalness: 0, realSize: 4, seamless: true, label: "Patched asphalt" },
  IND08: { id: "TEX-IND-08", atlas: "industrial", cell: [2, 1], roughness: 0.55, metalness: 0.75, realSize: 1.5, seamless: true, label: "Tread plate" },
  IND09: { id: "TEX-IND-09", atlas: "industrial", cell: [2, 2], roughness: 0.85, metalness: 0, realSize: 1.5, seamless: true, label: "Worn tarp fabric" },
};

// Asset registry entry — every placed thing is locatable & inspectable by address.
/**
 * Declared intent, so the validator can tell "wrong" from "deliberate".
 *
 * This matters more than it looks. A report that lists 67 problems of which 60
 * are intentional trains you to ignore it, and then it misses the one that is
 * real. Every exemption here is a promise that the author considered the case —
 * so anything the report *does* flag is worth looking at.
 */
export interface AssetFlags {
  /** Sits below grade by design: footings, sunk rubble, buried foundations. */
  belowGrade?: boolean;
  /** Supported by geometry that is not itself registered (decor on decor). */
  unsupported?: boolean;
  /** Overlaps neighbours by design: interlocking rubble, stacked scrap. */
  interpenetrates?: boolean;
  /** Moves at runtime; static placement checks do not apply. */
  dynamic?: boolean;
  /** Deliberately outside the playable bound (distant set dressing). */
  outOfBounds?: boolean;
}

export interface AssetRecord {
  id: string; // stable id, e.g. AST-WALL-0017
  role: string; // semantic role
  address: string; // grid address
  object: THREE.Object3D;
  flags: AssetFlags;
}

import type * as THREE from "./three";
/**
 * Apertures — doorways and windows that must stay traversable.
 *
 * Doctrine Part 2 requires a "blocked apertures" check and Part 6 warns that
 * auto-generated collision seals doorways. Both were specified and neither was
 * implemented, which is exactly how a wall ended up standing in a doorway with
 * nothing to catch it. Registering the hole itself makes the check possible.
 */
export interface ApertureRecord {
  id: string;
  ownerId: string;
  /** World-space centre of the clear opening. */
  center: { x: number; y: number; z: number };
  /** Clear width and height in metres. */
  width: number;
  height: number;
  /** Axis the opening is cut through: "x" or "z". */
  axis: "x" | "z";
}

export const apertureRegistry: ApertureRecord[] = [];
let apertureCounter = 0;

export function registerAperture(
  ownerId: string,
  center: { x: number; y: number; z: number },
  width: number,
  height: number,
  axis: "x" | "z"
): ApertureRecord {
  apertureCounter += 1;
  const rec: ApertureRecord = {
    id: `APT-${String(apertureCounter).padStart(4, "0")}`,
    ownerId, center, width, height, axis,
  };
  apertureRegistry.push(rec);
  return rec;
}

export const assetRegistry: AssetRecord[] = [];
let assetCounter = 0;
export function registerAsset(
  role: string,
  object: THREE.Object3D,
  prefix = "AST",
  flags: AssetFlags = {}
): AssetRecord {
  assetCounter += 1;
  const id = `${prefix}-${role.toUpperCase().replace(/\s+/g, "_")}-${String(assetCounter).padStart(4, "0")}`;
  const rec: AssetRecord = {
    id,
    role,
    address: gridAddress(object.position.x, object.position.z),
    object,
    flags,
  };
  assetRegistry.push(rec);
  return rec;
}

/** Reset between rebuilds so ids stay stable and the registry doesn't accumulate. */
export function clearAssetRegistry() {
  assetRegistry.length = 0;
  apertureRegistry.length = 0;
  assetCounter = 0;
  apertureCounter = 0;
}
