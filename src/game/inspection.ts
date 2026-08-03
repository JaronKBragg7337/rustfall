// Dual-mode layer system (doctrine Part 5): beauty mode <-> inspection mode.
// Inspection reveals the world's structure: module grid, grid addresses,
// per-asset ID labels, and bounding volumes — the same scene, another layer.
import * as THREE from "three";
import { WORLD, assetRegistry, gridAddress } from "./constants";
import { makeTag } from "./entities";

export type LayerMode = "game" | "inspection";

export class InspectionLayer {
  private group = new THREE.Group(); // everything inspection-only lives here
  private cellLabels = new Map<string, THREE.Sprite>();
  private assetLabels: THREE.Sprite[] = [];
  private assetBoxes: THREE.Box3Helper[] = [];
  private lastCellKey = "";
  mode: LayerMode = "game";

  constructor(scene: THREE.Scene) {
    // 4m module grid across the whole map
    const grid = new THREE.GridHelper(WORLD.SIZE, WORLD.CELLS, 0x58d6ff, 0x1d4e5e);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    grid.position.y = 0.06;
    this.group.add(grid);
    // world origin cross
    const origin = makeTag("ORIGIN · L0-H25-R25", "#58d6ff", 1.2);
    origin.position.set(0, 1.2, 0);
    this.group.add(origin);
    this.group.visible = false;
    scene.add(this.group);
  }

  setMode(mode: LayerMode) {
    this.mode = mode;
    this.group.visible = mode === "inspection";
    if (mode === "inspection") this.refreshAssetOverlays();
  }

  // Rebuild per-asset labels + bounds (called on entering inspection & after builds)
  refreshAssetOverlays() {
    for (const s of this.assetLabels) this.group.remove(s);
    for (const b of this.assetBoxes) this.group.remove(b);
    this.assetLabels = [];
    this.assetBoxes = [];
    for (const rec of assetRegistry) {
      if (rec.role === "terrain" || rec.role.endsWith("field") || rec.role === "road") continue;
      const box = new THREE.Box3().setFromObject(rec.object);
      if (box.isEmpty()) continue;
      const helper = new THREE.Box3Helper(box, new THREE.Color(0xffc455));
      this.group.add(helper);
      this.assetBoxes.push(helper);
      const center = box.getCenter(new THREE.Vector3());
      const label = makeTag(`${rec.id}\n${rec.role} · ${rec.address}`, "#ffc455", 0.9);
      label.position.set(center.x, box.max.y + 0.8, center.z);
      this.group.add(label);
      this.assetLabels.push(label);
    }
  }

  // Cell address labels only near the viewer (perf): L{level}-H{col}-R{row}
  update(playerPos: THREE.Vector3) {
    if (this.mode !== "inspection") return;
    const col = Math.floor((playerPos.x + WORLD.SIZE / 2) / WORLD.MODULE);
    const row = Math.floor((playerPos.z + WORLD.SIZE / 2) / WORLD.MODULE);
    const key = `${col},${row}`;
    if (key === this.lastCellKey) return;
    this.lastCellKey = key;
    const wanted = new Set<string>();
    const R = 4; // cells around viewer
    for (let dc = -R; dc <= R; dc++) {
      for (let dr = -R; dr <= R; dr++) {
        const c = col + dc, r = row + dr;
        if (c < 0 || r < 0 || c >= WORLD.CELLS || r >= WORLD.CELLS) continue;
        const cx = -WORLD.SIZE / 2 + c * WORLD.MODULE + WORLD.MODULE / 2;
        const cz = -WORLD.SIZE / 2 + r * WORLD.MODULE + WORLD.MODULE / 2;
        const addr = gridAddress(cx, cz);
        wanted.add(addr);
        if (!this.cellLabels.has(addr)) {
          const sp = makeTag(addr, "#58d6ff", 0.8);
          sp.position.set(cx, 0.45, cz);
          this.cellLabels.set(addr, sp);
          this.group.add(sp);
        }
      }
    }
    for (const [addr, sp] of this.cellLabels) {
      const on = wanted.has(addr);
      if (sp.visible !== on) sp.visible = on;
    }
  }

  // Validation sweep (Part 2): floating / buried / intersecting assets.
  // "Floating" is support-aware: an asset above 0.3m is legal if another asset
  // tops out within 0.35m beneath it (walls sit on slabs, slabs on walls…).
  validate(): { issues: string[] } {
    const issues: string[] = [];
    const boxes: Array<{ id: string; b: THREE.Box3 }> = [];
    const STATIC_SKIP = new Set(["terrain", "road", "scorch-field", "rust-dunes", "rubble-belt", "mud-flats"]);
    const DYNAMIC = ["player", "shambler", "hostile robot", "worker robot", "helper robot", "BOSS: IRON WARDEN", "vehicle buggy", "vehicle truck", "mech suit"];
    for (const rec of assetRegistry) {
      if (!rec.object.parent) continue;
      if (STATIC_SKIP.has(rec.role)) continue;
      if (DYNAMIC.includes(rec.role) || rec.role.startsWith("npc")) continue; // actors move; checked at spawn
      const b = new THREE.Box3().setFromObject(rec.object);
      if (b.isEmpty()) continue;
      boxes.push({ id: rec.id, b });
      if (b.min.y < -0.3) issues.push(`${rec.id}: buried (${b.min.y.toFixed(2)}m)`);
      if (Math.abs(b.min.x) > WORLD.SIZE / 2 + 5 || Math.abs(b.min.z) > WORLD.SIZE / 2 + 5) issues.push(`${rec.id}: outside scene bounds`);
    }
    for (const a of boxes) {
      if (a.b.min.y <= 0.3) continue; // ground-supported
      const supported = boxes.some((c) => {
        if (c.id === a.id) return false;
        const dy = a.b.min.y - c.b.max.y;
        if (dy < -0.05 || dy > 0.35) return false; // support top must be just beneath
        const ox = Math.min(a.b.max.x, c.b.max.x) - Math.max(a.b.min.x, c.b.min.x);
        const oz = Math.min(a.b.max.z, c.b.max.z) - Math.max(a.b.min.z, c.b.min.z);
        return ox > 0.05 && oz > 0.05; // real horizontal overlap
      });
      if (!supported) issues.push(`${a.id}: floating (${a.b.min.y.toFixed(2)}m above support)`);
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], c = boxes[j];
        if (a.b.intersectsBox(c.b)) {
          const inter = a.b.clone().intersect(c.b);
          const size = inter.getSize(new THREE.Vector3());
          // ignore trivial contact (< 0.4m deep on every axis = adjacency, not clash)
          if (size.x > 0.4 && size.y > 0.4 && size.z > 0.4) {
            issues.push(`${a.id} ∩ ${c.id}: solid intersection`);
          }
        }
      }
    }
    return { issues };
  }
}
