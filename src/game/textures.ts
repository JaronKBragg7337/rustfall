// Atlas slicer: crops each labeled 3x3 atlas cell into its own tiling CanvasTexture.
// Crop excludes the dark gutters and the bottom label strip so the stencil ID
// stays on the atlas sheet (documentation) and off the wrapped surfaces.
import * as THREE from "./three";
import { MATERIALS, type AtlasName, type MaterialCard, makeRng } from "./constants";

// 1536px WebP (~2.4 MB total) rather than the 2048px PNG masters (~32 MB).
// Cells tile at 2-6 m of world space, so the extra source resolution was never
// visible — but 32 MB of blocking image load is fatal on a phone connection.
// The PNG masters stay in assets/atlases/ as the archival source.
const ATLAS_FILES: Record<AtlasName, string> = {
  terrain: "./textures/atlas_terrain.webp",
  metal: "./textures/atlas_metal.webp",
  structure: "./textures/atlas_structure.webp",
  industrial: "./textures/atlas_industrial.webp",
  creature: "./textures/atlas_creature.webp",
};

const images = new Map<AtlasName, HTMLImageElement>();
const cellCanvases = new Map<string, HTMLCanvasElement>();
const materialCache = new Map<string, THREE.MeshStandardMaterial>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

export async function loadAtlases(): Promise<void> {
  await Promise.all(
    (Object.keys(ATLAS_FILES) as AtlasName[]).map(async (name) => {
      images.set(name, await loadImage(ATLAS_FILES[name]));
    })
  );
  // Slice every registered material card cell into a canvas.
  for (const card of Object.values(MATERIALS)) {
    const img = images.get(card.atlas)!;
    const cw = img.width / 3;
    const ch = img.height / 3;
    const [row, col] = card.cell;
    const gutter = Math.round(cw * 0.018); // skip dark gutters
    const labelCut = Math.round(ch * 0.80); // keep top 80%: drops stenciled ID + watermark
    const sx = col * cw + gutter;
    const sy = row * ch + gutter;
    const sw = cw - gutter * 2;
    const sh = labelCut - gutter;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    cellCanvases.set(card.id, canvas);
  }
}

export function cardTexture(card: MaterialCard, repeat = 1): THREE.Texture {
  const canvas = cellCanvases.get(card.id);
  // Building a CanvasTexture from undefined silently yields a black texture, and
  // the resulting object just looks unlit — a very expensive thing to debug.
  // Fail loudly instead: it means something was constructed before loadAtlases().
  if (!canvas) {
    throw new Error(
      `cardTexture("${card.id}"): atlas not sliced yet. Construct scene objects after awaiting loadAtlases().`
    );
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Material factory: world-space-ish tiling — repeat derived from object size vs realSize.
export function matOf(cardKey: keyof typeof MATERIALS, sizeMeters = 2): THREE.MeshStandardMaterial {
  const card = MATERIALS[cardKey];
  const repeat = Math.max(0.5, sizeMeters / card.realSize);
  const cacheKey = `${card.id}@${repeat.toFixed(2)}`;
  if (materialCache.has(cacheKey)) return materialCache.get(cacheKey)!;
  const map = cardTexture(card, repeat);
  const m = new THREE.MeshStandardMaterial({
    map,
    roughness: card.roughness,
    metalness: card.metalness,
  });
  materialCache.set(cacheKey, m);
  return m;
}

// Deterministic macro-noise breakup layer (anti-tiling law, Part 4):
// seeded LCG, tiled ~1.4 x 1.1 over large areas, modulates the base color.
export function macroNoiseTexture(): THREE.CanvasTexture {
  const rng = makeRng(9137);
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(128, 128);
  for (let i = 0; i < 128 * 128; i++) {
    const v = 200 + Math.floor(rng() * 55); // 200..254, subtle brightening variance
    img.data[i * 4 + 0] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 38; // low alpha — modulation only
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1.4, 1.1);
  return tex;
}
