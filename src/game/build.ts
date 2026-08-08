// Build mode: DayZ-style community construction with REAL assembly.
// - Structural pieces snap to the 4m module grid…
// - …and CONNECTOR-SNAP to neighboring pieces (walls continue walls, floors sit
//   on walls) with a visible snap effect — assembly is solved, not hand-placed.
// - Apertures (door openings) are real holes between colliders, never sealed.
// - Stairs are climbable because the player's step-up solves support.
import * as THREE from "./three";
import { WORLD, registerAsset, MATERIALS } from "./constants";
import { matOf } from "./textures";
import { plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, type Placement } from "./kit";

interface SubBox { w: number; h: number; d: number; x: number; y: number; z: number; }

export interface PieceDef {
  key: string;
  label: string;
  mat: keyof typeof MATERIALS;
  snap: number;
  rotateSteps: boolean;
  structural: boolean; // participates in connector snapping
  subs: SubBox[];
  bounds: { w: number; h: number; d: number }; // overall footprint for clash test
  /**
   * Scrap cost. The catalog owns the number; SPENDING lives in engine.ts
   * (`BuildMode.place()` callers): check `inv.count("scrap") >= def.cost`
   * before placing and `inv.remove("scrap", def.cost)` on success. The HUD
   * build bar reads PIECES directly, so costs show up wherever it renders them.
   */
  cost: number;
  /** Asset-registry role for the placed ROOT object (behaviour agents look
   *  these exact strings up in assetRegistry). Defaults to `built ${key}`. */
  role?: string;
  /** Assembled-piece builder (devices, not slabs) — used for BOTH the ghost
   *  (ghostly=true swaps every material for the preview tint) and the placed
   *  piece. Children tagged userData.noCollide never get colliders. */
  build?: (ghostly: boolean) => THREE.Group;
  /** Ground-only: never stacks on already-placed pieces (devices plant). */
  groundOnly?: boolean;
  /** Extra root lift at placement, metres — see SCRAP TURRET firing origin. */
  rootLift?: number;
  /** No colliders at all — walk-over devices (the spike trap). */
  noCollide?: boolean;
}

const M = WORLD.MODULE, H = WORLD.WALL_H, T = WORLD.THICK;
const DOOR_W = 1.2, DOOR_H = 2.2;

function stairsSubs(): SubBox[] {
  // 8 treads × 0.4 rise = full 3.2m storey; 0.5m tread depth, 4m run
  const subs: SubBox[] = [];
  for (let i = 1; i <= 8; i++) {
    const top = i * 0.4;
    subs.push({ w: 1.6, h: top, d: 0.5, x: 0, y: top / 2, z: M / 2 - (i - 0.5) * 0.5 });
  }
  return subs;
}

// ═══════════════════ assembled device pieces (turret / trap / floodlight) ═══════════════════
// Form hierarchy, same vocabulary as the site builders: primary → secondary →
// tertiary, instanced bolts, bevels on every exposed edge, real dimensions.
// Fully deterministic — identical geometry on every placement, no RNG.

/** Ghost preview: build the real assembly, then swap every mesh's material
 *  for a fresh preview tint (one material per mesh so updateGhost can recolour
 *  legal / snapped / clash states per mesh without touching shared mats). */
function ghostSwap(g: THREE.Group): THREE.Group {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.material = new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.45, depthWrite: false });
      m.castShadow = false;
      m.receiveShadow = false;
    }
  });
  return g;
}

/**
 * SCRAP TURRET — root local y=0 is the FIRING ORIGIN and the head pivot.
 * The placed root is lifted rootLift (1.2 m) off the ground, so:
 *   · firing origin  = root world position          (behaviour agent: aim from here)
 *   · head           = root child tagged userData.turretHead — a Group pivoted
 *     exactly at the root origin; set headGroup.rotation.y to aim. Barrels
 *     point down local +Z, muzzles at local z ≈ +0.86.
 * The head is tagged noCollide: it rotates at runtime, so any baked collider
 * would go stale in the first frame. Legs, feet and the mast collide per part.
 */
function buildTurretPiece(ghostly: boolean): THREE.Group {
  const rust = matOf("MET01", 2);   // heavy tripod steel
  const gun = matOf("MET03", 1.5);  // gunmetal receiver + barrels
  const tread = matOf("IND08", 1);  // ammo hopper tread plate
  const dk = plain(0x34322f, 0.58, 0.8);
  const g = new THREE.Group();

  // ── primary: mast + tripod (local y −1.2 … 0 — root is lifted 1.2 m) ──
  g.add(part(cyl(0.07, 0.09, 0.95, 10), rust, { pos: [0, -0.65, 0] }));        // mast
  g.add(part(cyl(0.16, 0.16, 0.08, 12), rust, { pos: [0, -0.2, 0] }));         // pivot collar
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + Math.PI / 6;
    const fx = Math.cos(a) * 0.62, fz = Math.sin(a) * 0.62;
    // leg: hub (0, −0.32) → foot (0.62, −1.18) — a real strut, not a tilted box guess
    const leg = part(flatBox(0.07, 0.07, 1.0), rust);
    leg.position.set(fx / 2, -0.75, fz / 2);
    leg.lookAt(new THREE.Vector3(fx, -1.18, fz));
    g.add(leg);
    g.add(part(flatBox(0.17, 0.05, 0.17), rust, { pos: [fx, -1.175, fz] }));   // foot pad
  }

  // ── secondary: the head (aimable child, pivoted at the root origin) ──
  const head = new THREE.Group();
  head.userData.noCollide = true;   // rotates at runtime — never bake a collider
  head.userData.turretHead = true;  // behaviour agent: this is the node to yaw
  // trunnion cheeks + pin
  for (const sx of [-1, 1]) head.add(part(flatBox(0.05, 0.26, 0.3), rust, { pos: [sx * 0.21, 0.1, 0] }));
  head.add(part(cyl(0.035, 0.035, 0.5, 8), dk, { pos: [0, 0.14, 0.05], rot: [0, 0, Math.PI / 2] }));
  // receiver
  head.add(bev(0.36, 0.22, 0.5, gun, { pos: [0, 0.16, 0.02] }));
  // twin barrels down +Z: tube, sleeve, muzzle brake each
  for (const sx of [-1, 1]) {
    head.add(part(cyl(0.028, 0.028, 0.62, 8), gun, { pos: [sx * 0.09, 0.17, 0.55], rot: [Math.PI / 2, 0, 0] }));
    head.add(part(cyl(0.04, 0.04, 0.16, 8), rust, { pos: [sx * 0.09, 0.17, 0.3], rot: [Math.PI / 2, 0, 0] }));
    head.add(part(cyl(0.045, 0.045, 0.07, 8), dk, { pos: [sx * 0.09, 0.17, 0.83], rot: [Math.PI / 2, 0, 0] }));
  }
  // ammo hopper (tread plate) with lid + feed chute into the receiver
  head.add(bev(0.3, 0.28, 0.32, tread, { pos: [0, 0.42, -0.18] }));
  head.add(part(flatBox(0.32, 0.03, 0.34), dk, { pos: [0, 0.575, -0.18] }));
  head.add(part(flatBox(0.1, 0.14, 0.08), tread, { pos: [0, 0.3, -0.02], rot: [0.5, 0, 0] }));
  // ── tertiary: instanced assembly bolts (cheeks, hopper, collar) ──
  const bl: Placement[] = [];
  for (const sx of [-0.235, 0.235]) for (const by of [0.02, 0.18]) for (const bz of [-0.1, 0.1]) {
    bl.push({ pos: [sx, by, bz], rot: [0, 0, Math.PI / 2] });
  }
  for (const bx of [-0.1, 0.1]) for (const bz of [-0.3, -0.06]) {
    bl.push({ pos: [bx, 0.575, bz], rot: [0, 0, 0] });
  }
  head.add(bolts(bl, dk, 0.012));
  g.add(head);
  return ghostly ? ghostSwap(g) : g;
}

/**
 * SPIKE TRAP — a 1×1 m tread-plate base with angled sharpened spikes.
 * Root local y=0 is the ground plane; the piece NEVER collides (def.noCollide)
 * so actors genuinely walk onto it — damage is the behaviour agent's job,
 * applied by proximity to the root position.
 */
function buildSpikeTrapPiece(ghostly: boolean): THREE.Group {
  const plate = matOf("IND08", 1.5);
  const gun = matOf("MET03", 1);
  const dk = plain(0x34322f, 0.58, 0.8);
  const g = new THREE.Group();

  // ── primary: the base plate, frame rails proud of the sheet ──
  g.add(bev(1.0, 0.05, 1.0, plate, { pos: [0, 0.025, 0], radius: 0.008 }));
  for (const s of [-1, 1]) {
    g.add(part(flatBox(1.02, 0.04, 0.05), dk, { pos: [0, 0.05, s * 0.485] }));
    g.add(part(flatBox(0.05, 0.04, 1.02), dk, { pos: [s * 0.485, 0.05, 0] }));
  }

  // ── secondary: nine spikes, alternating lean — forged, not perpendicular ──
  // spike k at grid (col,row), lean direction cycles through 4 diagonals
  const LEANS: Array<[number, number]> = [[0.32, 0.18], [-0.24, 0.3], [0.18, -0.3], [-0.3, -0.2]];
  for (let i = 0; i < 9; i++) {
    const col = (i % 3) - 1, row = Math.floor(i / 3) - 1;
    const [lx, lz] = LEANS[i % 4];
    const tall = i === 4 ? 0.5 : 0.38; // centre spike stands tallest
    const spike = part(cyl(0.004, 0.042, tall, 6), gun);
    spike.position.set(col * 0.28 + lx * 0.12, 0.05 + tall / 2 - 0.04, row * 0.28 + lz * 0.12);
    spike.rotation.set(lz, 0, -lx);
    g.add(spike);
    // weld collar where each spike leaves the plate
    g.add(part(cyl(0.05, 0.06, 0.03, 8), dk, { pos: [col * 0.28, 0.055, row * 0.28] }));
  }

  // ── tertiary: instanced hold-down bolts at the frame corners ──
  const bl: Placement[] = [];
  for (const bx of [-0.42, 0.42]) for (const bz of [-0.42, 0.42]) {
    bl.push({ pos: [bx, 0.06, bz], rot: [0, 0, 0] });
  }
  g.add(bolts(bl, dk, 0.013));
  return ghostly ? ghostSwap(g) : g;
}

/**
 * FLOODLIGHT POLE — 4 m mast, crossarm, twin lamp heads. Root local y=0 is
 * ground. The lamps are DARK as built: lenses use an emissive-off material
 * (0x20211f, emissive 0x000000) — the behaviour agent lights them when the
 * generator runs (swap lens material / add a SpotLight at the head).
 * Lamp-head world position for that agent:
 *   headWorld = root.position + root.rotationY applied to (±0.45, 3.72, 0.14)
 * i.e. localToWorld(new Vector3(±0.45, 3.72, 0.14)) on the placed root.
 * Both heads tilt down 0.42 rad and face local +Z.
 */
function buildFloodlightPiece(ghostly: boolean): THREE.Group {
  const rust = matOf("MET01", 2);
  const gun = matOf("MET03", 1);
  const lensOff = plain(0x20211f, 0.35, 0.1, { emissive: 0x000000, emissiveIntensity: 0 }); // unlit
  const dk = plain(0x34322f, 0.58, 0.8);
  const g = new THREE.Group();

  // ── primary: base flange + 4 m mast ──
  g.add(bev(0.42, 0.07, 0.42, rust, { pos: [0, 0.035, 0], radius: 0.01 }));
  g.add(part(cyl(0.045, 0.065, 3.9, 10), rust, { pos: [0, 2.0, 0] }));   // sunk into flange
  g.add(part(cyl(0.09, 0.09, 0.06, 10), dk, { pos: [0, 3.92, 0] }));      // mast cap

  // ── secondary: crossarm + twin lamp heads (high dressing: noCollide) ──
  const top = new THREE.Group();
  top.userData.noCollide = true; // 3.7 m up — a collider here is a snag, not a wall
  top.add(part(flatBox(1.1, 0.06, 0.06), rust, { pos: [0, 3.86, 0] }));
  for (const sx of [-1, 1]) {
    // U-bracket, then the head can + visor, lens on the tilted face
    top.add(part(flatBox(0.04, 0.14, 0.1), dk, { pos: [sx * 0.45, 3.78, 0] }));
    top.add(part(cyl(0.11, 0.13, 0.22, 10), gun, { pos: [sx * 0.45, 3.72, 0.12], rot: [Math.PI / 2 - 0.42, 0, 0] }));
    top.add(part(cyl(0.125, 0.125, 0.03, 10), dk, { pos: [sx * 0.45, 3.675, 0.225], rot: [Math.PI / 2 - 0.42, 0, 0] })); // visor rim
    top.add(part(cyl(0.105, 0.105, 0.015, 10), lensOff, { pos: [sx * 0.45, 3.672, 0.238], rot: [Math.PI / 2 - 0.42, 0, 0], shadow: false }));
  }
  // junction box + cable run down the mast
  top.add(bev(0.14, 0.2, 0.1, gun, { pos: [0, 3.6, -0.08] }));
  top.add(part(cyl(0.012, 0.012, 3.5, 5), dk, { pos: [0, 1.85, -0.075], shadow: false }));
  g.add(top);

  // ── tertiary: base-flange anchor bolts, instanced ──
  const bl: Placement[] = [];
  for (const bx of [-0.15, 0.15]) for (const bz of [-0.15, 0.15]) {
    bl.push({ pos: [bx, 0.075, bz], rot: [0, 0, 0] });
  }
  g.add(bolts(bl, dk, 0.014));
  return ghostly ? ghostSwap(g) : g;
}

export const PIECES: PieceDef[] = [
  // Existing six — order is load-bearing: the HUD build bar and the Digit1-9
  // handler both index PIECES by position. New pieces are APPENDED, never inserted.
  { key: "floor", label: "FLOOR SLAB", mat: "TER04", snap: M, rotateSteps: false, structural: true, cost: 10,
    subs: [{ w: M, h: T, d: M, x: 0, y: T / 2, z: 0 }], bounds: { w: M, h: T, d: M } },
  { key: "wall", label: "SCRAP WALL", mat: "STR05", snap: M, rotateSteps: true, structural: true, cost: 12,
    subs: [{ w: M, h: H, d: T, x: 0, y: H / 2, z: 0 }], bounds: { w: M, h: H, d: T } },
  { key: "doorway", label: "DOORWAY WALL", mat: "STR01", snap: M, rotateSteps: true, structural: true, cost: 14,
    subs: [
      { w: (M - DOOR_W) / 2, h: H, d: T, x: -(DOOR_W + (M - DOOR_W) / 2) / 2, y: H / 2, z: 0 },
      { w: (M - DOOR_W) / 2, h: H, d: T, x: (DOOR_W + (M - DOOR_W) / 2) / 2, y: H / 2, z: 0 },
      { w: DOOR_W, h: H - DOOR_H, d: T, x: 0, y: DOOR_H + (H - DOOR_H) / 2, z: 0 },
    ], bounds: { w: M, h: H, d: T } },
  { key: "stairs", label: "STAIRS ↑", mat: "STR01", snap: M, rotateSteps: true, structural: true, cost: 18,
    subs: stairsSubs(), bounds: { w: 1.6, h: H + T, d: M } },
  { key: "sandbag", label: "SANDBAG LINE", mat: "STR06", snap: 1, rotateSteps: true, structural: false, cost: 6,
    subs: [{ w: 2, h: 0.9, d: 0.7, x: 0, y: 0.45, z: 0 }], bounds: { w: 2, h: 0.9, d: 0.7 } },
  { key: "crate", label: "SUPPLY CRATE", mat: "STR08", snap: 0.5, rotateSteps: false, structural: false, cost: 8,
    subs: [{ w: 1.1, h: 1.1, d: 1.1, x: 0, y: 0.55, z: 0 }], bounds: { w: 1.1, h: 1.1, d: 1.1 } },
  // ── devices (7·8·9): free placement, ground-only, registry roles are the
  // cross-agent behaviour contract — keep the role strings EXACT. ──
  { key: "turret", label: "SCRAP TURRET", mat: "MET01", snap: 0.5, rotateSteps: true, structural: false, cost: 30,
    subs: [], bounds: { w: 1.3, h: 1.9, d: 1.3 }, role: "scrap_turret", build: buildTurretPiece,
    groundOnly: true, rootLift: 1.2 }, // root sits 1.2 m up: firing origin = root position
  { key: "spiketrap", label: "SPIKE TRAP", mat: "IND08", snap: 0.5, rotateSteps: true, structural: false, cost: 8,
    subs: [], bounds: { w: 1.0, h: 0.55, d: 1.0 }, role: "spike_trap", build: buildSpikeTrapPiece,
    groundOnly: true, noCollide: true }, // walk-over: damage by proximity, never a collider
  { key: "floodlight", label: "FLOODLIGHT POLE", mat: "MET01", snap: 0.5, rotateSteps: true, structural: false, cost: 15,
    subs: [], bounds: { w: 1.1, h: 4.0, d: 0.5 }, role: "floodlight_pole", build: buildFloodlightPiece,
    groundOnly: true },
];

export interface PlaceResult {
  object: THREE.Group;
  snapped: boolean;
  position: THREE.Vector3;
}

export class BuildMode {
  active = false;
  pieceIdx = 0;
  yawSteps = 0;
  snapped = false; // connector engaged this frame
  private ghost: THREE.Group | null = null;
  placed: THREE.Group[] = [];
  private placedDefs: Array<{ obj: THREE.Group; def: PieceDef; yaw: number }> = [];
  private scene: THREE.Scene;
  private colliders: THREE.Box3[];

  constructor(scene: THREE.Scene, colliders: THREE.Box3[]) {
    this.scene = scene;
    this.colliders = colliders;
  }

  get piece() { return PIECES[this.pieceIdx]; }

  enter() { this.active = true; this.spawnGhost(); }
  exit() { this.active = false; this.removeGhost(); }
  select(i: number) {
    this.pieceIdx = THREE.MathUtils.clamp(i, 0, PIECES.length - 1);
    this.yawSteps = 0;
    if (this.active) this.spawnGhost();
  }
  rotate() {
    if (!this.piece.rotateSteps) return;
    this.yawSteps = (this.yawSteps + 1) % 4; // 90° steps for structural pieces
  }

  private removeGhost() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; }
  }

  private buildPieceGroup(def: PieceDef, ghostly: boolean): THREE.Group {
    if (def.build) return def.build(ghostly); // assembled devices build themselves
    const g = new THREE.Group();
    for (const s of def.subs) {
      const mat = ghostly
        ? new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.45, depthWrite: false })
        : matOf(def.mat, Math.max(s.w, s.d));
      const m = new THREE.Mesh(new THREE.BoxGeometry(s.w, s.h, s.d), mat);
      m.position.set(s.x, s.y, s.z);
      if (!ghostly) { m.castShadow = true; m.receiveShadow = true; }
      g.add(m);
    }
    return g;
  }

  private spawnGhost() {
    this.removeGhost();
    this.ghost = this.buildPieceGroup(this.piece, true);
    this.scene.add(this.ghost);
  }

  // Find a structural neighbor and solve the mating position (connector solving):
  // candidate sockets = neighbor center ± one module along its own axes.
  private solveConnector(hit: THREE.Vector3): { pos: THREE.Vector3; yaw: number } | null {
    if (!this.piece.structural) return null;
    for (const p of this.placedDefs) {
      if (!p.def.structural) continue;
      const local = hit.clone().sub(p.obj.position);
      const yawInv = -p.yaw;
      const lx = local.x * Math.cos(yawInv) - local.z * Math.sin(yawInv);
      const lz = local.x * Math.sin(yawInv) + local.z * Math.cos(yawInv);
      // sockets one module away along the neighbor's frame
      const sockets: Array<[number, number]> = [[M, 0], [-M, 0], [0, M], [0, -M]];
      for (const [sx, sz] of sockets) {
        if (Math.abs(lx - sx) < 1.0 && Math.abs(lz - sz) < 1.0) {
          const wx = p.obj.position.x + sx * Math.cos(p.yaw) - sz * Math.sin(p.yaw);
          const wz = p.obj.position.z + sx * Math.sin(p.yaw) + sz * Math.cos(p.yaw);
          return { pos: new THREE.Vector3(wx, p.obj.position.y, wz), yaw: p.yaw };
        }
      }
    }
    return null;
  }

  // Snap the ghost to where the aim ray meets the world; connectors win over grid.
  updateGhost(ray: THREE.Raycaster): { legal: boolean; reason: string } {
    if (!this.ghost) return { legal: false, reason: "no ghost" };
    const p = this.piece;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    // aim at placed pieces first (stacking: floors on walls), else the ground
    // plane — groundOnly devices never stack, they plant on the ground plane
    const hits = p.groundOnly ? [] : ray.intersectObjects(this.placed, true);
    let supportY = 0;
    if (!ray.ray.intersectPlane(plane, hit)) return { legal: false, reason: "no ground" };
    if (hits.length && hits[0].point.y > 0.3) {
      supportY = hits[0].point.y;
      hit.copy(hits[0].point);
    }
    // connector solving beats raw grid snap
    const conn = this.solveConnector(hit);
    this.snapped = false;
    let cx: number, cz: number;
    if (conn) {
      cx = conn.pos.x; cz = conn.pos.z;
      this.yawSteps = Math.round(conn.yaw / (Math.PI / 2)) % 4;
      this.snapped = true;
    } else {
      const sx = Math.round(hit.x / p.snap) * p.snap;
      const sz = Math.round(hit.z / p.snap) * p.snap;
      const L = WORLD.SIZE / 2 - 1;
      cx = THREE.MathUtils.clamp(sx, -L, L);
      cz = THREE.MathUtils.clamp(sz, -L, L);
    }
    // rootLift raises the placed ROOT above the support (turret firing origin);
    // the ghost previews the true final height so the clash test sees it too
    this.ghost.position.set(cx, supportY + (p.rootLift ?? 0), cz);
    this.ghost.rotation.y = (this.yawSteps * Math.PI) / 2;
    const legal = this.checkLegal();
    const color = !legal ? 0xff5544 : this.snapped ? 0x33ddff : 0x44ff88;
    // device ghosts nest groups (turret head), so recolour every mesh, not just
    // direct children
    this.ghost.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) (m.material as THREE.MeshBasicMaterial).color.set(color);
    });
    if (!legal) return { legal: false, reason: "clash: occupancy volume occupied" };
    return { legal: true, reason: this.snapped ? "connector snapped" : "" };
  }

  private ghostBox(): THREE.Box3 {
    this.ghost!.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(this.ghost!);
  }

  private checkLegal(): boolean {
    const gb = this.ghostBox();
    gb.expandByScalar(-0.02);
    for (const b of this.colliders) {
      if (gb.intersectsBox(b)) {
        const inter = gb.clone().intersect(b);
        const s = inter.getSize(new THREE.Vector3());
        if (s.x > 0.1 && s.y > 0.1 && s.z > 0.1) {
          // resting ON a support is not a clash — contact within 0.25m of the top face
          if (Math.abs(gb.min.y - b.max.y) < 0.25) continue;
          return false; // fail with a reason
        }
      }
    }
    return true;
  }

  // Place the piece for real: registered, collidable, and part of the connector graph.
  place(): PlaceResult | null {
    if (!this.ghost || !this.checkLegal()) return null;
    const def = this.piece;
    const g = this.buildPieceGroup(def, false);
    g.position.copy(this.ghost.position); // includes rootLift (see updateGhost)
    g.rotation.copy(this.ghost.rotation);
    this.scene.add(g);
    // Registry role is the behaviour contract: devices register their exact
    // role string on the ROOT object; everything else keeps the legacy label.
    registerAsset(def.role ?? `built ${def.key}`, g, "BLD");
    g.updateMatrixWorld(true);
    if (!def.noCollide) {
      // per child, honouring noCollide tags (the turret head rotates at
      // runtime — a baked box on it would be stale in the first frame)
      for (const c of g.children) {
        if (c.userData.noCollide) continue;
        const b = new THREE.Box3().setFromObject(c);
        if (!b.isEmpty()) this.colliders.push(b);
      }
    }
    this.placed.push(g);
    this.placedDefs.push({ obj: g, def, yaw: g.rotation.y });
    return { object: g, snapped: this.snapped, position: g.position.clone() };
  }
}
