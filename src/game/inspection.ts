// Dual-mode layer system (doctrine Part 5): beauty mode <-> inspection mode.
// Inspection reveals the world's structure: module grid, grid addresses,
// per-asset ID labels, and bounding volumes — the same scene, another layer.
import * as THREE from "./three";
import { WORLD, assetRegistry, gridAddress } from "./constants";
import { heightAt } from "./terrain";
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
    // 4 m module grid across the whole map.
    //
    // A flat GridHelper is no use now that the ground undulates: it sits at one
    // height and the terrain swallows it wherever the ground rises above that.
    // This grid samples heightAt() along every line and rides a fixed clearance
    // above the surface, so it stays visible over the whole map.
    this.group.add(this.buildTerrainGrid());
    // world origin cross
    const origin = makeTag("ORIGIN · L0-H25-R25", "#58d6ff", 1.2);
    origin.position.set(0, heightAt(0, 0) + 1.2, 0);
    this.group.add(origin);
    this.group.visible = false;
    scene.add(this.group);
  }

  /** Module grid draped over the terrain, held a fixed clearance above it. */
  private buildTerrainGrid(): THREE.LineSegments {
    const S = WORLD.SIZE;
    const half = S / 2;
    const step = WORLD.MODULE;
    const sub = 2;          // sample every 2 m so lines follow the slope
    const lift = 0.18;      // clearance above the surface
    const pts: number[] = [];
    const cols: number[] = [];
    const major = new THREE.Color(0x58d6ff);
    const minor = new THREE.Color(0x1d4e5e);

    const push = (x: number, z: number, c: THREE.Color) => {
      pts.push(x, heightAt(x, z) + lift, z);
      cols.push(c.r, c.g, c.b);
    };

    for (let i = 0; i <= WORLD.CELLS; i++) {
      const t = -half + i * step;
      // every 5th line is a major axis, so the grid stays readable at distance
      const c = i % 5 === 0 ? major : minor;
      for (let s = -half; s < half; s += sub) {
        push(t, s, c); push(t, s + sub, c);   // line along Z
        push(s, t, c); push(s + sub, t, c);   // line along X
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    return new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false })
    );
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
          sp.position.set(cx, heightAt(cx, cz) + 0.55, cz);
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
    const boxes: Array<{ id: string; b: THREE.Box3; ground: number }> = [];
    const STATIC_SKIP = new Set(["terrain", "road", "scorch-field", "rust-dunes", "rubble-belt", "mud-flats"]);
    const DYNAMIC = ["player", "shambler", "hostile robot", "worker robot", "helper robot", "BOSS: IRON WARDEN", "vehicle buggy", "vehicle truck", "mech suit"];
    for (const rec of assetRegistry) {
      if (!rec.object.parent) continue;
      if (STATIC_SKIP.has(rec.role)) continue;
      if (DYNAMIC.includes(rec.role) || rec.role.startsWith("npc")) continue; // actors move; checked at spawn
      const b = new THREE.Box3().setFromObject(rec.object);
      if (b.isEmpty()) continue;
      // Ground is a heightfield, not y=0. Measuring against 0 flags every asset
      // standing on high ground as floating and every one in a dip as buried.
      const c0 = b.getCenter(new THREE.Vector3());
      const ground = heightAt(c0.x, c0.z);
      boxes.push({ id: rec.id, b, ground });
      if (b.min.y < ground - 0.3) issues.push(`${rec.id}: buried (${(b.min.y - ground).toFixed(2)}m below grade)`);
      if (Math.abs(b.min.x) > WORLD.SIZE / 2 + 5 || Math.abs(b.min.z) > WORLD.SIZE / 2 + 5) issues.push(`${rec.id}: outside scene bounds`);
    }
    for (const a of boxes) {
      if (a.b.min.y <= a.ground + 0.3) continue; // resting on grade
      const supported = boxes.some((c) => {
        if (c.id === a.id) return false;
        // A support may top out slightly ABOVE the asset's base — a chimney is
        // bedded into the roof slab, a railing into the floor. Only requiring the
        // support to sit just under the base reported all of those as floating.
        const dy = a.b.min.y - c.b.max.y;
        if (dy < -0.45 || dy > 0.35) return false;
        const ox = Math.min(a.b.max.x, c.b.max.x) - Math.max(a.b.min.x, c.b.min.x);
        const oz = Math.min(a.b.max.z, c.b.max.z) - Math.max(a.b.min.z, c.b.min.z);
        return ox > 0.05 && oz > 0.05; // real horizontal overlap
      });
      if (!supported) issues.push(`${a.id}: floating (${(a.b.min.y - a.ground).toFixed(2)}m above support)`);
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
