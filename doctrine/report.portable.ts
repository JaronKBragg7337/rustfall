// Scene report — the asset registry as data rather than as pixels.
//
// The inspection layer draws IDs, addresses and bounding volumes into the world,
// which is the right answer for a human standing in the scene. It is the wrong
// answer for a tool: labels get occluded, they have to be OCR'd off a
// screenshot, and you cannot diff two pictures.
//
// This is the same information as a structured object. It is the highest-value
// channel in the whole system, because it does three things the visual layer
// cannot:
//
//   1. MEASURES. Screenshots show what looks wrong. This shows what IS wrong —
//      including faults that look perfectly fine, which is how the terrain-pad
//      bug (a house sitting 0.4 m into a ridge, visually flawless) was caught.
//   2. NAMES. "AST-CONTAINER-0043" is unambiguous where "the container" is not,
//      and that only matters more as the world grows.
//   3. DIFFS. Snapshot before a change, snapshot after, compare. A regression
//      like a wall sealing a doorway shows up the moment it is introduced
//      instead of days later.
import * as THREE from "./three";
import { assetRegistry, apertureRegistry, WORLD, type AssetFlags } from "./constants";
import { heightAt } from "./terrain";

export type IssueKind =
  | "buried"
  | "floating"
  | "intersecting"
  | "out-of-bounds"
  | "blocked-aperture"
  | "detached";

export interface Issue {
  /** Deterministic, so two runs are comparable and a fix can be verified. */
  key: string;
  kind: IssueKind;
  id: string;
  role: string;
  address: string;
  /** Metres of error, where the check has a magnitude. */
  amount?: number;
  with?: string;
  message: string;
  /** Machine-applicable correction, where one can be computed. */
  fix?: { translate: [number, number, number] };
}

/** Stable id for an issue so runs diff cleanly (doctrine Part 2). */
function issueKey(kind: string, id: string, other = ""): string {
  const s = `${kind}|${id}|${other}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface AssetSnapshot {
  id: string;
  role: string;
  address: string;
  pos: [number, number, number];
  size: [number, number, number];
  /** Base height relative to the terrain under the asset's centre. */
  clearance: number;
  flags: AssetFlags;
}

export interface SceneReport {
  generatedAt: string;
  world: { size: number; module: number };
  counts: { assets: number; issues: number; apertures: number; byRole: Record<string, number> };
  issues: Issue[];
  assets: AssetSnapshot[];
}

const SKIP_ROLES = new Set(["terrain", "road", "scorch-field", "rust-dunes", "rubble-belt", "mud-flats"]);
const DYNAMIC_ROLES = new Set([
  "player", "shambler", "hostile robot", "worker robot", "helper robot",
  "BOSS: IRON WARDEN", "vehicle buggy", "vehicle truck", "mech suit",
]);

/**
 * Solid extent of an asset, ignoring subtrees tagged noCollide.
 *
 * A door leaf hangs open across empty space. Including it in the AABB makes the
 * wall's box bulge a metre into the next room and reports a solid intersection
 * that does not exist. The report should measure what is solid, not what is drawn.
 */
function solidBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  root.traverse((o) => {
    if (o === root) return;
    if (o.userData?.noCollide) return;
    let p: THREE.Object3D | null = o.parent;
    while (p && p !== root) { if (p.userData?.noCollide) return; p = p.parent; }
    const m = o as THREE.Mesh;
    if (m.isMesh) box.expandByObject(m);
  });
  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
}

/**
 * Solid extent in the asset's OWN frame, plus its yaw.
 *
 * World-space AABBs are useless for intersection once things are rotated: a
 * 6.06 x 2.44 m container turned 0.9 rad has a 5.7 x 6.3 m axis-aligned box, so
 * two of them sitting 0.46 m apart "overlap" by 2.6 m. Keeping the local box and
 * the yaw lets the clash test compare the actual boxes.
 */
function localSolidBox(root: THREE.Object3D): { box: THREE.Box3; yaw: number } {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.traverse((o) => {
    if (o === root || o.userData?.noCollide) return;
    let p: THREE.Object3D | null = o.parent;
    while (p && p !== root) { if (p.userData?.noCollide) return; p = p.parent; }
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
    tmp.copy(m.geometry.boundingBox!).applyMatrix4(
      new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)
    );
    box.union(tmp);
  });
  return { box, yaw: root.rotation.y };
}

/**
 * Do two yaw-rotated boxes actually overlap, and by how much?
 * Separating-axis test in plan, plus a vertical range test.
 *
 * Axis convention matters here: three rotates local +X to (cos y, -sin y) and
 * local +Z to (sin y, cos y). Getting that sign wrong makes the projections
 * nonsense and clean geometry reports as clashing.
 */
function obbOverlap(
  a: { c: THREE.Vector3; h: THREE.Vector3; yaw: number },
  b: { c: THREE.Vector3; h: THREE.Vector3; yaw: number }
): number {
  const dy = Math.min(a.c.y + a.h.y, b.c.y + b.h.y) - Math.max(a.c.y - a.h.y, b.c.y - b.h.y);
  if (dy <= 0) return 0;

  const ax = (yaw: number) => ({ x: Math.cos(yaw), z: -Math.sin(yaw) });
  const az = (yaw: number) => ({ x: Math.sin(yaw), z: Math.cos(yaw) });
  const axes = [ax(a.yaw), az(a.yaw), ax(b.yaw), az(b.yaw)];

  const radius = (bx: { h: THREE.Vector3; yaw: number }, L: { x: number; z: number }) =>
    Math.abs(bx.h.x * (Math.cos(bx.yaw) * L.x - Math.sin(bx.yaw) * L.z)) +
    Math.abs(bx.h.z * (Math.sin(bx.yaw) * L.x + Math.cos(bx.yaw) * L.z));

  const dx = b.c.x - a.c.x, dz = b.c.z - a.c.z;
  let minPen = Infinity;
  for (const L of axes) {
    const overlap = radius(a, L) + radius(b, L) - Math.abs(dx * L.x + dz * L.z);
    if (overlap <= 0) return 0;   // separating axis found: no contact
    minPen = Math.min(minPen, overlap);
  }
  return Math.min(minPen, dy);
}

function isStatic(role: string, flags: AssetFlags): boolean {
  if (flags.dynamic) return false;
  if (SKIP_ROLES.has(role)) return false;
  if (DYNAMIC_ROLES.has(role)) return false;
  if (role.startsWith("npc")) return false;
  return true;
}

/** Full structured snapshot of the world's placed assets and their faults. */
export function sceneReport(): SceneReport {
  const issues: Issue[] = [];
  const assets: AssetSnapshot[] = [];
  const byRole: Record<string, number> = {};
  const boxes: Array<{ id: string; role: string; address: string; b: THREE.Box3; ground: number; flags: AssetFlags;
                       obb: { c: THREE.Vector3; h: THREE.Vector3; yaw: number } }> = [];

  for (const rec of assetRegistry) {
    if (!rec.object.parent) continue;
    byRole[rec.role] = (byRole[rec.role] ?? 0) + 1;
    if (!isStatic(rec.role, rec.flags)) continue;

    const b = solidBox(rec.object);
    if (b.isEmpty()) continue;
    const c = b.getCenter(new THREE.Vector3());
    const s = b.getSize(new THREE.Vector3());
    // Ground is a heightfield, not y=0. Measuring against 0 reports every asset
    // on high ground as floating and every one in a dip as buried.
    const ground = heightAt(c.x, c.z);
    const clearance = b.min.y - ground;

    assets.push({
      id: rec.id, role: rec.role, address: rec.address,
      pos: [+c.x.toFixed(2), +c.y.toFixed(2), +c.z.toFixed(2)],
      size: [+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)],
      clearance: +clearance.toFixed(2),
      flags: rec.flags,
    });
    const lb = localSolidBox(rec.object);
    const lc = lb.box.getCenter(new THREE.Vector3());
    const lh = lb.box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
    const cy = Math.cos(lb.yaw), sy = Math.sin(lb.yaw);
    const obb = {
      c: new THREE.Vector3(
        rec.object.position.x + lc.x * cy + lc.z * sy,
        rec.object.position.y + lc.y,
        rec.object.position.z - lc.x * sy + lc.z * cy
      ),
      h: lh,
      yaw: lb.yaw,
    };
    boxes.push({ id: rec.id, role: rec.role, address: rec.address, b, ground, flags: rec.flags, obb });

    if (clearance < -0.3 && !rec.flags.belowGrade) {
      issues.push({
        key: issueKey("buried", rec.id), kind: "buried", id: rec.id, role: rec.role,
        address: rec.address, amount: +clearance.toFixed(2),
        message: `${rec.id} (${rec.role}) at ${rec.address} is ${Math.abs(clearance).toFixed(2)}m below grade`,
        fix: { translate: [0, +(-clearance).toFixed(3), 0] },
      });
    }
    const L = WORLD.SIZE / 2 + 5;
    if ((Math.abs(c.x) > L || Math.abs(c.z) > L) && !rec.flags.outOfBounds) {
      issues.push({
        key: issueKey("out-of-bounds", rec.id), kind: "out-of-bounds", id: rec.id,
        role: rec.role, address: rec.address,
        message: `${rec.id} (${rec.role}) sits outside the world bound`,
      });
    }
  }

  // Floating: above grade with nothing registered beneath it. A support may top
  // out slightly ABOVE the base — a chimney beds into the roof slab, a railing
  // into the floor — so embedment is allowed.
  for (const a of boxes) {
    if (a.b.min.y <= a.ground + 0.3) continue;
    if (a.flags.unsupported) continue;
    const supported = boxes.some((c) => {
      if (c.id === a.id) return false;
      const dy = a.b.min.y - c.b.max.y;
      if (dy < -0.45 || dy > 0.35) return false;
      const ox = Math.min(a.b.max.x, c.b.max.x) - Math.max(a.b.min.x, c.b.min.x);
      const oz = Math.min(a.b.max.z, c.b.max.z) - Math.max(a.b.min.z, c.b.min.z);
      return ox > 0.05 && oz > 0.05;
    });
    if (!supported) {
      issues.push({
        key: issueKey("floating", a.id), kind: "floating", id: a.id, role: a.role, address: a.address,
        amount: +(a.b.min.y - a.ground).toFixed(2),
        message: `${a.id} (${a.role}) at ${a.address} floats ${(a.b.min.y - a.ground).toFixed(2)}m above support`,
        fix: { translate: [0, +(a.ground - a.b.min.y).toFixed(3), 0] },
      });
    }
  }

  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j];
      if (a.flags.interpenetrates || c.flags.interpenetrates) continue;
      if (!a.b.intersectsBox(c.b)) continue;   // cheap reject before the real test
      const pen = obbOverlap(a.obb, c.obb);
      // under 0.4 m of true penetration is adjacency, not a clash
      if (pen > 0.4) {
        issues.push({
          key: issueKey("intersecting", a.id, c.id),
          kind: "intersecting", id: a.id, role: a.role, address: a.address, with: c.id,
          amount: +pen.toFixed(2),
          message: `${a.id} (${a.role}) intersects ${c.id} (${c.role}) by ${pen.toFixed(2)}m`,
        });
      }
    }
  }

  // ── Blocked apertures (doctrine Part 2) ──
  //
  // The check that would have caught a wall standing in a doorway the moment it
  // appeared, instead of days later by walking into it. A doorway is only a
  // doorway if the clear volume is actually clear.
  for (const ap of apertureRegistry) {
    const halfW = ap.width / 2 - 0.05;
    const clear = new THREE.Box3(
      new THREE.Vector3(
        ap.center.x - (ap.axis === "z" ? halfW : 0.12),
        ap.center.y - ap.height / 2 + 0.15,
        ap.center.z - (ap.axis === "x" ? halfW : 0.12)
      ),
      new THREE.Vector3(
        ap.center.x + (ap.axis === "z" ? halfW : 0.12),
        ap.center.y + ap.height / 2 - 0.15,
        ap.center.z + (ap.axis === "x" ? halfW : 0.12)
      )
    );
    for (const o of boxes) {
      if (o.id === ap.ownerId) continue;      // the wall's own jambs frame the hole
      if (!o.b.intersectsBox(clear)) continue;
      const overlap = o.b.clone().intersect(clear).getSize(new THREE.Vector3());
      // a genuine obstruction fills a real share of the opening
      if (overlap.x > 0.2 && overlap.y > 0.5 && overlap.z > 0.2) {
        issues.push({
          key: issueKey("blocked-aperture", ap.id, o.id),
          kind: "blocked-aperture", id: ap.id, role: "aperture",
          address: `${ap.center.x.toFixed(1)}, ${ap.center.z.toFixed(1)}`,
          with: o.id,
          amount: +Math.min(overlap.x, overlap.z).toFixed(2),
          message: `${ap.id} (opening of ${ap.ownerId}) is blocked by ${o.id} (${o.role}) — you cannot walk through it`,
        });
        break;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    world: { size: WORLD.SIZE, module: WORLD.MODULE },
    counts: { assets: assets.length, issues: issues.length, apertures: apertureRegistry.length, byRole },
    issues,
    assets,
  };
}

/** Assets near a point, nearest first — what the on-screen panel lists. */
export function assetsNear(p: THREE.Vector3, radius = 14, limit = 8): AssetSnapshot[] {
  const r = sceneReport();
  return r.assets
    .map((a) => ({ a, d: Math.hypot(a.pos[0] - p.x, a.pos[2] - p.z) }))
    .filter((e) => e.d <= radius)
    .sort((x, y) => x.d - y.d)
    .slice(0, limit)
    .map((e) => e.a);
}

export interface ReportDiff {
  added: string[];
  removed: string[];
  moved: Array<{ id: string; by: number }>;
  newIssues: Issue[];
  fixedIssues: Issue[];
}

/**
 * Compare two snapshots. This is the regression check: take one before a change
 * and one after, and anything that silently moved, vanished or broke shows up
 * immediately rather than being discovered by playing the game days later.
 */
export function diffReports(before: SceneReport, after: SceneReport): ReportDiff {
  const b = new Map(before.assets.map((a) => [a.id, a]));
  const a2 = new Map(after.assets.map((a) => [a.id, a]));

  const added = [...a2.keys()].filter((id) => !b.has(id));
  const removed = [...b.keys()].filter((id) => !a2.has(id));
  const moved: Array<{ id: string; by: number }> = [];
  for (const [id, av] of a2) {
    const bv = b.get(id);
    if (!bv) continue;
    const d = Math.hypot(av.pos[0] - bv.pos[0], av.pos[1] - bv.pos[1], av.pos[2] - bv.pos[2]);
    if (d > 0.05) moved.push({ id, by: +d.toFixed(2) });
  }

  const key = (i: Issue) => i.key;
  const beforeKeys = new Set(before.issues.map(key));
  const afterKeys = new Set(after.issues.map(key));
  return {
    added,
    removed,
    moved,
    newIssues: after.issues.filter((i) => !beforeKeys.has(key(i))),
    fixedIssues: before.issues.filter((i) => !afterKeys.has(key(i))),
  };
}

/** Compact human/AI-readable text form, for pasting into a conversation. */
export function formatReport(r: SceneReport): string {
  const lines: string[] = [];
  lines.push(`RUSTFALL scene report · ${r.counts.assets} assets · ${r.counts.issues} issues`);
  if (r.issues.length === 0) {
    lines.push("No placement issues.");
  } else {
    const byKind: Record<string, Issue[]> = {};
    for (const i of r.issues) (byKind[i.kind] ??= []).push(i);
    for (const [kind, list] of Object.entries(byKind)) {
      lines.push(`\n[${kind}] ${list.length}`);
      for (const i of list.slice(0, 25)) lines.push(`  ${i.message}`);
      if (list.length > 25) lines.push(`  …and ${list.length - 25} more`);
    }
  }
  return lines.join("\n");
}
