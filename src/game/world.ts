// World builder: terrain, road, ruins, home base, scattered props.
// Everything is deterministic (seeded), grounded (world_y = support_top + base_offset),
// and registered with a stable ID + grid address.
import * as THREE from "three";
import { WORLD, MATERIALS, makeRng, registerAsset } from "./constants";
import { matOf, macroNoiseTexture } from "./textures";

export interface WorldRefs {
  scene: THREE.Scene;
  colliders: THREE.Box3[]; // static occupancy volumes for movement clamping
}

function box(
  refs: WorldRefs,
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  z: number,
  role: string,
  opts: { ry?: number; collide?: boolean; yBase?: number } = {}
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  // Grounding is solved, never hand-set: rest on support top (terrain y=0 by default).
  mesh.position.set(x, (opts.yBase ?? 0) + h / 2, z);
  if (opts.ry) mesh.rotation.y = opts.ry;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  refs.scene.add(mesh);
  registerAsset(role, mesh);
  if (opts.collide !== false) {
    mesh.updateMatrixWorld(true);
    refs.colliders.push(new THREE.Box3().setFromObject(mesh));
  }
  return mesh;
}

export function buildWorld(refs: WorldRefs): void {
  const rng = makeRng(9137);
  const S = WORLD.SIZE;

  // ── Terrain: cracked-dirt plane, world-space tiling at material realSize ──
  const groundMat = matOf("TER01", S);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(S, S, 1, 1), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  refs.scene.add(ground);
  registerAsset("terrain", ground, "TER");

  // Anti-tiling macro-noise modulation layer (doctrine Part 4, seeded LCG)
  const noise = new THREE.Mesh(
    new THREE.PlaneGeometry(S, S),
    new THREE.MeshBasicMaterial({ map: macroNoiseTexture(), transparent: true, depthWrite: false })
  );
  noise.rotation.x = -Math.PI / 2;
  noise.position.y = 0.02;
  refs.scene.add(noise);

  // ── Biome patches: scorch field (boss arena), rust sand dune field, rubble belt ──
  const patch = (matKey: "TER05" | "TER06" | "TER07" | "TER09", cx: number, cz: number, size: number, role: string) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), matOf(matKey, size));
    m.rotation.x = -Math.PI / 2;
    m.position.set(cx, 0.03, cz);
    m.receiveShadow = true;
    refs.scene.add(m);
    registerAsset(role, m, "TER");
  };
  patch("TER05", 62, 62, 56, "scorch-field"); // boss arena
  patch("TER06", -58, -50, 60, "rust-dunes");
  patch("TER07", 30, -52, 44, "rubble-belt");
  patch("TER09", -52, 48, 40, "mud-flats");

  // ── Cracked highway crossing the map north-south (faded lane paint) ──
  const road = new THREE.Mesh(new THREE.PlaneGeometry(8, S), matOf("TER08", S / 2));
  road.rotation.x = -Math.PI / 2;
  road.position.set(14, 0.04, 0);
  road.receiveShadow = true;
  refs.scene.add(road);
  registerAsset("road", road, "TER");

  // ── Ruined pre-war block: concrete + brick shells (4m module, 3m walls) ──
  const M = WORLD.MODULE;
  const H = WORLD.WALL_H;
  const T = WORLD.THICK;
  const ruinAt = (ox: number, oz: number, matA: "STR03" | "STR04") => {
    // U-shaped ruin: 3 walls standing, one collapsed (rubble heap instead)
    box(refs, M * 2, H, T, matOf(matA, 6), ox, oz - M, "ruin wall", {});
    box(refs, T, H, M * 2, matOf(matA, 6), ox - M, oz, "ruin wall", {});
    box(refs, T, H * 0.55, M * 2, matOf(matA, 6), ox + M, oz, "ruin wall broken", {});
    // collapsed section → rubble mound (grounded)
    const rubble = new THREE.Mesh(new THREE.ConeGeometry(1.6, 1.1, 7), matOf("TER07", 3));
    rubble.position.set(ox, 0.55, oz + M);
    rubble.castShadow = true;
    refs.scene.add(rubble);
    registerAsset("rubble", rubble);
  };
  ruinAt(-26, -18, "STR04");
  ruinAt(-38, -6, "STR03");
  ruinAt(36, 20, "STR04");
  ruinAt(48, 6, "STR03");
  ruinAt(-20, 34, "STR04");

  // ── Home base (DayZ-style community core): shanty walls, watchtower, farm ──
  const bx = -6;
  const bz = -44;
  // perimeter scrap walls with a gate gap
  box(refs, M * 3, H, T, matOf("STR05", 8), bx, bz - M * 1.5, "base wall", {});
  box(refs, M * 3, H, T, matOf("STR02", 8), bx, bz + M * 1.5, "base wall", {});
  box(refs, T, H, M * 3, matOf("STR05", 8), bx - M * 1.5, bz, "base wall", {});
  box(refs, T, H, M, matOf("STR02", 4), bx + M * 1.5, bz - M, "base wall", {});
  box(refs, T, H, M, matOf("STR02", 4), bx + M * 1.5, bz + M, "base wall", {}); // gate gap at center
  // watchtower: legs + cabin
  for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    box(refs, 0.3, 5, 0.3, matOf("STR01", 2), bx - 8 + lx * 1.4, bz - 8 + lz * 1.4, "tower leg", {});
  }
  box(refs, 3.6, T, 3.6, matOf("STR01", 4), bx - 8, bz - 8, "tower deck", { yBase: 5 });
  box(refs, 3.6, 1.2, 3.6, matOf("STR08", 4), bx - 8, bz - 8, "tower cabin", { yBase: 5.2, collide: false });
  // farm plots (State of Decay ecosystem: food job)
  for (let i = 0; i < 3; i++) {
    const plot = box(refs, 3, 0.3, 2, matOf("TER09", 3), bx - 2 + i * 3.5, bz + 2.5, "farm plot", { collide: false });
    plot.receiveShadow = true;
    const crop = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.5, 1.6), new THREE.MeshStandardMaterial({ color: 0x5a7a2e, roughness: 0.9 }));
    crop.position.set(bx - 2 + i * 3.5, 0.55, bz + 2.5);
    refs.scene.add(crop);
    registerAsset("crops", crop);
  }
  // scrap pile (scrapper job)
  const scrap = new THREE.Mesh(new THREE.ConeGeometry(1.4, 1.6, 8), matOf("MET01", 2));
  scrap.position.set(bx + 3.5, 0.8, bz - 2.5);
  scrap.castShadow = true;
  refs.scene.add(scrap);
  registerAsset("scrap pile", scrap);

  // ── Shipping container yard ──
  const containers: Array<[number, number, number, keyof typeof MATERIALS]> = [
    [30, -30, 0.2, "STR09"], [33.2, -30.4, -0.15, "STR05"], [30.8, -27, 1.62, "STR09"],
    [-46, 22, 0.9, "STR09"], [-43.4, 23.6, 0.75, "STR02"],
  ];
  for (const [cx, cz, ry, mk] of containers) {
    box(refs, 6, 2.6, 2.5, matOf(mk, 6), cx, cz, "container", { ry });
  }

  // ── THE HOMESTEAD: a REAL two-storey building — rooms, doors, windows, stairs ──
  // Wall apertures are real holes between colliders (never sealed), so interiors
  // are walkable; storey height 3m + 0.2 slab, per module doctrine.
  const hx = 30, hz = 44; // homestead center
  const wallSeg = (cx: number, cz: number, len: number, h: number, horiz: boolean, mat: THREE.Material, yBase = 0, role = "house wall") =>
    box(refs, horiz ? len : T, h, horiz ? T : len, mat, cx, cz, role, { yBase });
  const DOOR_W = 1.2, DOOR_H = 2.2, WIN_W = 1.8, WIN_SILL = 1.0;
  // door wall: two jambs + lintel; the 1.2×2.2 opening stays traversable
  const doorWall = (cx: number, cz: number, len: number, horiz: boolean, mat: THREE.Material, yBase = 0, role = "house door wall") => {
    const jamb = (len - DOOR_W) / 2;
    const off = (len - jamb) / 2;
    if (horiz) {
      wallSeg(cx - off, cz, jamb, H, true, mat, yBase, role);
      wallSeg(cx + off, cz, jamb, H, true, mat, yBase, role);
      box(refs, DOOR_W, H - DOOR_H, T, mat, cx, cz, "door lintel", { yBase: yBase + DOOR_H });
    } else {
      wallSeg(cx, cz - off, jamb, H, false, mat, yBase, role);
      wallSeg(cx, cz + off, jamb, H, false, mat, yBase, role);
      box(refs, T, H - DOOR_H, DOOR_W, mat, cx, cz, "door lintel", { yBase: yBase + DOOR_H });
    }
  };
  // window wall: sill + jambs + header; 1.8×1.2 opening with sill at 1.0m
  const windowWall = (cx: number, cz: number, len: number, horiz: boolean, mat: THREE.Material, yBase = 0, role = "house window wall") => {
    const jamb = (len - WIN_W) / 2;
    const off = (len - jamb) / 2;
    if (horiz) {
      wallSeg(cx - off, cz, jamb, H, true, mat, yBase, role);
      wallSeg(cx + off, cz, jamb, H, true, mat, yBase, role);
      box(refs, WIN_W, WIN_SILL, T, mat, cx, cz, "window sill", { yBase });
      box(refs, WIN_W, H - DOOR_H, T, mat, cx, cz, "window header", { yBase: yBase + DOOR_H });
    } else {
      wallSeg(cx, cz - off, jamb, H, false, mat, yBase, role);
      wallSeg(cx, cz + off, jamb, H, false, mat, yBase, role);
      box(refs, T, WIN_SILL, WIN_W, mat, cx, cz, "window sill", { yBase });
      box(refs, T, H - DOOR_H, WIN_W, mat, cx, cz, "window header", { yBase: yBase + DOOR_H });
    }
  };
  const brick = matOf("STR03", 8);
  const wood = matOf("STR01", 4);
  const HW = 12, HD = 8; // footprint 12×8 (3×2 modules)
  // GROUND FLOOR — exterior
  doorWall(hx - 3, hz - HD / 2, 6, true, brick);          // front (south) left: door into living room
  windowWall(hx + 3, hz - HD / 2, 6, true, brick);        // front right: workshop window
  windowWall(hx - 3, hz + HD / 2, 6, true, brick);        // back (north) windows
  windowWall(hx + 3, hz + HD / 2, 6, true, brick);
  windowWall(hx - HW / 2, hz, HD, false, brick);          // west wall
  wallSeg(hx + HW / 2, hz, HD, H, false, brick, 0);       // east wall, solid
  // GROUND FLOOR — interior: living room (west) | workshop + bedroom (east)
  doorWall(hx, hz, HD, false, wood, 0, "interior wall");  // divider with doorway
  doorWall(hx + 3, hz, 6, true, wood, 0, "interior wall"); // workshop | bedroom divider
  // STAIRS to level 2 — 12 treads, rise 0.267 (walkable: under the 0.5m step limit)
  const ST_RISE = (H + T) / 12, ST_DEPTH = 0.46;
  for (let i = 1; i <= 12; i++) {
    const top = i * ST_RISE;
    box(refs, 1.8, top, ST_DEPTH, wood, hx - HW / 2 + 0.9, hz + 2.99 - (i - 0.5) * ST_DEPTH, "stair tread", {});
  }
  // LEVEL 2 — slab (walk surface 3.2), stair well kept open, landing at stair top
  const SLAB_T = WORLD.THICK, L2 = H; // level-2 floor base = 3.0, walk surface 3.2
  box(refs, 10.2, SLAB_T, HD, wood, hx + 0.9, hz, "floor slab L2", { yBase: L2 });
  box(refs, 1.8, SLAB_T, 1.4, wood, hx - HW / 2 + 0.9, hz - HD / 2 + 0.7, "stair landing", { yBase: L2 });
  // LEVEL 2 — rooms: bunkroom (east) + armory (west of divider), terrace over living room
  doorWall(hx + 0.9, hz + 1, HD - 2, false, wood, L2 + SLAB_T, "L2 interior wall");
  wallSeg(hx + 0.9, hz - HD / 2, 10.2, H - 0.4, true, brick, L2 + SLAB_T, "L2 wall");
  wallSeg(hx + 0.9, hz + HD / 2, 10.2, H - 0.4, true, brick, L2 + SLAB_T, "L2 wall");
  wallSeg(hx + HW / 2, hz, HD, H - 0.4, false, brick, L2 + SLAB_T, "L2 wall");
  wallSeg(hx - 4.2 + 0, hz - HD / 2, 1.8, H - 0.4, true, brick, L2 + SLAB_T, "L2 wall");
  wallSeg(hx - HW / 2, hz - HD / 2 + 0.7, 1.4, H - 0.4, false, brick, L2 + SLAB_T, "L2 wall");
  // roof over the east half; west half stays an open terrace
  box(refs, 10.2, SLAB_T, HD, matOf("STR05", 8), hx + 0.9, hz, "roof slab", { yBase: L2 + SLAB_T + H - 0.4 });
  // railings: stair well edge + terrace edge (keep falls honest)
  box(refs, 0.08, 1.0, 5.4, wood, hx - 4.2 + 0.04, hz + 1.3, "railing", { yBase: L2 + SLAB_T });
  box(refs, 0.08, 1.0, 5.4, wood, hx - HW / 2 + 0.04, hz + 1.3, "terrace railing", { yBase: L2 + SLAB_T });
  box(refs, 1.8, 1.0, 0.08, wood, hx - HW / 2 + 0.9, hz + HD / 2 - 0.04, "terrace railing", { yBase: L2 + SLAB_T });
  // FURNITURE — every room gets a job
  box(refs, 1.9, 0.9, 0.8, matOf("STR01", 2), hx + 3, hz - 3.2, "workbench", {});       // workshop
  box(refs, 2.0, 0.45, 1.1, matOf("CRV05", 2), hx + 4.4, hz + 3.2, "bed", {});           // bedroom
  box(refs, 1.2, 0.75, 1.2, matOf("STR08", 1.5), hx - 3, hz + 1.5, "table", {});         // living room
  box(refs, 1.1, 1.1, 1.1, matOf("STR01", 1.2), hx + 3.5, hz + 2.5, "armory crate", { yBase: L2 + SLAB_T }); // upstairs
  box(refs, 2.0, 0.45, 1.1, matOf("CRV05", 2), hx + 4.6, hz - 2.8, "bunk", { yBase: L2 + SLAB_T });          // bunkroom

  // ── Scattered props: barrels, crates, tires — free grounding, seeded ──
  for (let i = 0; i < 26; i++) {
    const px = (rng() - 0.5) * (S - 20);
    const pz = (rng() - 0.5) * (S - 20);
    const kind = rng();
    if (kind < 0.4) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.0, 12), matOf("CRV07", 1));
      b.position.set(px, 0.5, pz);
      b.castShadow = true;
      refs.scene.add(b);
      registerAsset("barrel", b);
    } else if (kind < 0.75) {
      box(refs, 1.1, 1.1, 1.1, matOf("STR01", 1.2), px, pz, "crate", { ry: rng() * Math.PI });
    } else {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.18, 8, 16), matOf("CRV03", 1));
      t.position.set(px, 0.2, pz);
      t.rotation.x = Math.PI / 2;
      t.rotation.z = rng() * Math.PI;
      t.castShadow = true;
      refs.scene.add(t);
      registerAsset("tire", t);
    }
  }

  // ── Sandbag lines near the base gate ──
  for (let i = 0; i < 4; i++) {
    box(refs, 2, 0.9, 0.7, matOf("STR06", 2), bx + 7.5, bz - 4 + i * 2.2, "sandbags", { ry: 0.12 * (i % 2 ? 1 : -1) });
  }
}
