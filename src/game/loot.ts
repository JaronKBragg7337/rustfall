// Loot — searchable containers and battlefield drops.
//
// Before this there was nothing to collect: scrap only trickled in from worker
// robots, so the crates, barrels and containers scattered across the map were
// scenery. The problem was discoverability as much as mechanics — a lootable
// object that looks identical to a prop is invisible.
//
// So every lootable carries a floating marker that pulses and rises, visible at
// range and unmistakable up close. Search radius is generous, the prompt names
// the object, and the yield is announced. Nothing here requires the player to
// guess that a key does something.
import * as THREE from "./three";
import { heightAt } from "./terrain";
import { plain } from "./surface";

export interface LootNode {
  pos: THREE.Vector3;
  label: string;
  scrap: number;
  taken: boolean;
  marker: THREE.Group;
  phase: number;
}

const SEARCH_RANGE = 3.2;

/** Roles from the asset registry that are worth searching, and what they hold. */
export const LOOTABLE: Record<string, { label: string; min: number; max: number }> = {
  crate: { label: "SUPPLY CRATE", min: 4, max: 9 },
  barrel: { label: "FUEL DRUM", min: 2, max: 6 },
  container: { label: "SHIPPING CONTAINER", min: 8, max: 16 },
  "scrap pile": { label: "SCRAP PILE", min: 6, max: 12 },
  debris: { label: "DEBRIS", min: 1, max: 4 },
  pallet: { label: "PALLET", min: 1, max: 3 },
  "armory crate": { label: "ARMORY CRATE", min: 12, max: 22 },
  workbench: { label: "WORKBENCH", min: 3, max: 7 },
};

function makeMarker(): THREE.Group {
  const g = new THREE.Group();
  // Amber diamond — reads as "interactive" at a glance and never occurs naturally
  // anywhere else in the world's vocabulary.
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.15, 0),
    plain(0xffc455, 0.35, 0.2, { emissive: 0xffa022, emissiveIntensity: 2.4 })
  );
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.26, 0.34, 16),
    new THREE.MeshBasicMaterial({ color: 0xffc455, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  g.add(core, halo);
  return g;
}

export class LootField {
  readonly nodes: LootNode[] = [];
  private scene: THREE.Scene;
  private root = new THREE.Group();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    scene.add(this.root);
  }

  add(pos: THREE.Vector3, label: string, scrap: number) {
    const marker = makeMarker();
    marker.position.set(pos.x, pos.y + 1.5, pos.z);
    this.root.add(marker);
    this.nodes.push({ pos: pos.clone(), label, scrap, taken: false, marker, phase: Math.random() * 6.28 });
  }

  /** Drop left behind by a destroyed machine. */
  addDrop(pos: THREE.Vector3, scrap: number) {
    this.add(new THREE.Vector3(pos.x, heightAt(pos.x, pos.z), pos.z), "SALVAGE", scrap);
  }

  nearest(p: THREE.Vector3): LootNode | null {
    let best: LootNode | null = null;
    let bd = SEARCH_RANGE;
    for (const n of this.nodes) {
      if (n.taken) continue;
      const d = Math.hypot(n.pos.x - p.x, n.pos.z - p.z);
      // vertical tolerance keeps upstairs loot from being grabbed from below
      if (Math.abs(n.pos.y - p.y) > 3) continue;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  take(n: LootNode): number {
    if (n.taken) return 0;
    n.taken = true;
    this.root.remove(n.marker);
    return n.scrap;
  }

  get remaining() { return this.nodes.reduce((a, n) => a + (n.taken ? 0 : 1), 0); }

  update(dt: number, playerPos: THREE.Vector3) {
    for (const n of this.nodes) {
      if (n.taken) continue;
      n.phase += dt * 2.2;
      const d = Math.hypot(n.pos.x - playerPos.x, n.pos.z - playerPos.z);
      const near = d < SEARCH_RANGE;
      n.marker.position.y = n.pos.y + 1.5 + Math.sin(n.phase) * 0.11;
      n.marker.rotation.y += dt * (near ? 2.4 : 0.9);
      const s = near ? 1.35 + Math.sin(n.phase * 3) * 0.12 : 1;
      n.marker.scale.setScalar(s);
    }
  }

  dispose() {
    this.scene.remove(this.root);
  }
}
