// Build mode: DayZ-style community construction with REAL assembly.
// - Structural pieces snap to the 4m module grid…
// - …and CONNECTOR-SNAP to neighboring pieces (walls continue walls, floors sit
//   on walls) with a visible snap effect — assembly is solved, not hand-placed.
// - Apertures (door openings) are real holes between colliders, never sealed.
// - Stairs are climbable because the player's step-up solves support.
import * as THREE from "three";
import { WORLD, registerAsset, MATERIALS } from "./constants";
import { matOf } from "./textures";

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

export const PIECES: PieceDef[] = [
  { key: "floor", label: "FLOOR SLAB", mat: "TER04", snap: M, rotateSteps: false, structural: true,
    subs: [{ w: M, h: T, d: M, x: 0, y: T / 2, z: 0 }], bounds: { w: M, h: T, d: M } },
  { key: "wall", label: "SCRAP WALL", mat: "STR05", snap: M, rotateSteps: true, structural: true,
    subs: [{ w: M, h: H, d: T, x: 0, y: H / 2, z: 0 }], bounds: { w: M, h: H, d: T } },
  { key: "doorway", label: "DOORWAY WALL", mat: "STR01", snap: M, rotateSteps: true, structural: true,
    subs: [
      { w: (M - DOOR_W) / 2, h: H, d: T, x: -(DOOR_W + (M - DOOR_W) / 2) / 2, y: H / 2, z: 0 },
      { w: (M - DOOR_W) / 2, h: H, d: T, x: (DOOR_W + (M - DOOR_W) / 2) / 2, y: H / 2, z: 0 },
      { w: DOOR_W, h: H - DOOR_H, d: T, x: 0, y: DOOR_H + (H - DOOR_H) / 2, z: 0 },
    ], bounds: { w: M, h: H, d: T } },
  { key: "stairs", label: "STAIRS ↑", mat: "STR01", snap: M, rotateSteps: true, structural: true,
    subs: stairsSubs(), bounds: { w: 1.6, h: H + T, d: M } },
  { key: "sandbag", label: "SANDBAG LINE", mat: "STR06", snap: 1, rotateSteps: true, structural: false,
    subs: [{ w: 2, h: 0.9, d: 0.7, x: 0, y: 0.45, z: 0 }], bounds: { w: 2, h: 0.9, d: 0.7 } },
  { key: "crate", label: "SUPPLY CRATE", mat: "STR08", snap: 0.5, rotateSteps: false, structural: false,
    subs: [{ w: 1.1, h: 1.1, d: 1.1, x: 0, y: 0.55, z: 0 }], bounds: { w: 1.1, h: 1.1, d: 1.1 } },
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
    // aim at placed pieces first (stacking: floors on walls), else the ground plane
    const placedMeshes: THREE.Object3D[] = [];
    for (const g of this.placed) for (const c of g.children) placedMeshes.push(c);
    const hits = ray.intersectObjects(placedMeshes, false);
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
    this.ghost.position.set(cx, supportY, cz);
    this.ghost.rotation.y = (this.yawSteps * Math.PI) / 2;
    const legal = this.checkLegal();
    const color = !legal ? 0xff5544 : this.snapped ? 0x33ddff : 0x44ff88;
    for (const c of this.ghost.children) ((c as THREE.Mesh).material as THREE.MeshBasicMaterial).color.set(color);
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
    g.position.copy(this.ghost.position);
    g.rotation.copy(this.ghost.rotation);
    this.scene.add(g);
    registerAsset(`built ${def.key}`, g, "BLD");
    g.updateMatrixWorld(true);
    for (const c of g.children) this.colliders.push(new THREE.Box3().setFromObject(c));
    this.placed.push(g);
    this.placedDefs.push({ obj: g, def, yaw: g.rotation.y });
    return { object: g, snapped: this.snapped, position: g.position.clone() };
  }
}
