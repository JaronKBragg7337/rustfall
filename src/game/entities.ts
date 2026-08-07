// Entities: tracked robots (worker & hostile), shamblers, NPC helpers with jobs,
// the IRON WARDEN boss, drivable vehicles, and a modular pilotable mech.
//
// Everything here is assembled the same way a real object is: a primary form,
// secondary components bolted to it, and tertiary detail (bolts, seams, welds,
// vents, hinges) that proves the components were fitted rather than booleaned.
// Moving bodies use object-space surface projection so their materials don't
// swim across the geometry as they drive around.
import * as THREE from "./three";
import { WORLD, makeRng, registerAsset, MATERIALS, SAFE_ZONE, safeZoneFactor } from "./constants";
import { surface, plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, rivets, along, perimeter, seam, weld, vent, bevelBox } from "./kit";
import { Humanoid, STYLES, type HumanoidStyle } from "./figures";
import { heightAt } from "./terrain";

export interface Entity {
  group: THREE.Group;
  hp: number;
  maxHp: number;
  hostile: boolean;
  dead: boolean;
  radius: number;
  update(dt: number, playerPos: THREE.Vector3): void;
  damage(n: number): void;
}

function clampToWorld(v: THREE.Vector3) {
  const L = WORLD.SIZE / 2 - 3;
  v.x = THREE.MathUtils.clamp(v.x, -L, L);
  v.z = THREE.MathUtils.clamp(v.z, -L, L);
}

/**
 * Push a hostile back out of the home base. Applied after movement rather than
 * as a pathing constraint: it is one line, it cannot fail to hold, and the
 * feather band means they slide along the perimeter instead of jittering on it.
 */
function keepOutOfSafeZone(v: THREE.Vector3) {
  const f = safeZoneFactor(v.x, v.z);
  if (f <= 0) return;
  const dx = v.x - SAFE_ZONE.x;
  const dz = v.z - SAFE_ZONE.z;
  const d = Math.hypot(dx, dz) || 1e-4;
  v.x = SAFE_ZONE.x + (dx / d) * SAFE_ZONE.radius;
  v.z = SAFE_ZONE.z + (dz / d) * SAFE_ZONE.radius;
}

// Shared shop materials — object-space projected so they ride with the body.
const M = {
  hullWorn: () => surface("MET01", { local: true, tile: 1.6, grime: 0.5, grimeHeight: 0.9, dust: 0.5 }),
  hullOlive: () => surface("MET02", { local: true, tile: 1.5, grime: 0.4, grimeHeight: 0.9, dust: 0.45 }),
  gunmetal: () => surface("MET03", { local: true, tile: 1.2, grime: 0.3, grimeHeight: 0.8, dust: 0.3 }),
  corrugated: () => surface("MET04", { local: true, tile: 1.4 }),
  tread: () => surface("MET05", { local: true, tile: 1.1, grime: 0.6, grimeHeight: 0.7 }),
  battle: () => surface("MET06", { local: true, tile: 1.8, grime: 0.45, grimeHeight: 1.0 }),
  pipes: () => surface("MET07", { local: true, tile: 1.0 }),
  hazard: () => surface("MET08", { local: true, tile: 1.2, grime: 0.55, grimeHeight: 0.8 }),
  panel: () => surface("MET09", { local: true, tile: 0.8, grime: 0.2 }),
  rubber: () => plain(0x1d1b1a, 0.94, 0.02),
  steel: () => plain(0x53504b, 0.42, 0.85),
  darkSteel: () => plain(0x33312e, 0.55, 0.8),
  glass: () => plain(0x2a3a3c, 0.12, 0.35),
  chrome: () => plain(0x9aa0a4, 0.22, 0.95),
};

function emissive(color: number, intensity = 2.2) {
  return new THREE.MeshStandardMaterial({ color: 0x0a0a0a, emissive: color, emissiveIntensity: intensity, roughness: 0.4, metalness: 0.1 });
}

/** Cast/receive flags for a whole subtree, skipping instanced detail already set. */
function shadowed(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
  });
}

// ─────────────────────────────── ROBOT ───────────────────────────────
// A 1.6 m tracked utility chassis. Worker units carry a manipulator arm and run
// a salvage loop; hostile units carry a weapon pod and hunt.

/** Track unit: sprocket, idler, road wheels, and a band that actually wraps them. */
function trackUnit(mats: { band: THREE.Material; wheel: THREE.Material; steel: THREE.Material }): { group: THREE.Group; wheels: THREE.Mesh[] } {
  const g = new THREE.Group();
  const wheels: THREE.Mesh[] = [];
  const R = 0.20, r = 0.125, len = 1.32, w = 0.28;

  // band: top and bottom runs plus rounded ends
  g.add(part(flatBox(len - R * 2, 0.055, w), mats.band, { pos: [0, R, 0] }));
  g.add(part(flatBox(len - R * 2, 0.055, w), mats.band, { pos: [0, -R, 0] }));
  for (const sx of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.CylinderGeometry(R, R, w, 14, 1, true), mats.band);
    end.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    end.position.set((sx * (len - R * 2)) / 2, 0, 0);
    end.castShadow = true;
    (end.material as THREE.Material).side = THREE.DoubleSide;
    g.add(end);
    // drive sprocket / idler
    const s = part(cyl(R * 0.72, R * 0.72, w * 0.82, 10), mats.wheel, {
      pos: [(sx * (len - R * 2)) / 2, 0, 0], rot: [0, 0, Math.PI / 2],
    });
    wheels.push(s);
    g.add(s);
  }
  // three road wheels between them
  for (const t of [-0.32, 0, 0.32]) {
    const rw = part(cyl(r, r, w * 0.62, 9), mats.wheel, { pos: [t, -0.045, 0], rot: [0, 0, Math.PI / 2] });
    wheels.push(rw);
    g.add(rw);
  }
  // sprung suspension arms — tertiary detail that reads as a mechanism
  for (const t of [-0.32, 0, 0.32]) {
    g.add(part(flatBox(0.05, 0.14, 0.03), mats.steel, { pos: [t, 0.06, w / 2 - 0.02], shadow: false }));
  }
  // side skirt with bolt row
  g.add(part(flatBox(len * 0.86, 0.16, 0.02), mats.steel, { pos: [0, 0.12, w / 2 + 0.005] }));
  g.add(bolts(along([-len * 0.38, 0.12, w / 2 + 0.022], [len * 0.38, 0.12, w / 2 + 0.022], 6), mats.steel, 0.011));
  return { group: g, wheels };
}

export class Robot implements Entity {
  group = new THREE.Group();
  hp = 60; maxHp = 60;
  dead = false;
  radius = 1.1;
  hostile: boolean;
  onFire: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;
  onDeliver: (() => void) | null = null;
  private rng = makeRng(1000 + Math.floor(performance.now()) % 100000);
  private target = new THREE.Vector3();
  private speed: number;
  private eye: THREE.Mesh;
  private turret: THREE.Group;
  private wheels: THREE.Mesh[] = [];
  private armUpper: THREE.Group | null = null;
  private armLower: THREE.Group | null = null;
  private job: "toPile" | "picking" | "toBase" | "dropping" = "toPile";
  private jobTimer = 0;
  private carry: THREE.Mesh;
  private pilePos: THREE.Vector3;
  private basePos: THREE.Vector3;
  private fireCooldown = 0;
  private travelled = 0;
  private bobPhase = Math.random() * 6.28;

  constructor(pos: THREE.Vector3, hostile: boolean, pilePos?: THREE.Vector3, basePos?: THREE.Vector3) {
    this.hostile = hostile;
    this.speed = hostile ? 3.1 : 2.6;
    this.pilePos = pilePos ?? new THREE.Vector3(-2.5, 0, -46.5);
    this.basePos = basePos ?? new THREE.Vector3(-9, 0, -42);

    const hull = hostile ? M.battle() : M.hullOlive();
    const steel = M.steel();
    const dark = M.darkSteel();
    const chassis = new THREE.Group();

    // ── primary: lower hull + upper hull ──
    const lower = bev(1.02, 0.40, 1.30, hull, { pos: [0, 0.50, 0] });
    const upper = bev(0.90, 0.44, 1.02, hull, { pos: [0, 0.92, -0.04] });
    chassis.add(lower, upper);

    // ── secondary: sloped glacis, deck plate, rear vent block ──
    chassis.add(part(bevelBox(0.94, 0.34, 0.05), hull, { pos: [0, 0.66, 0.60], rot: [-0.52, 0, 0] }));
    chassis.add(part(flatBox(0.80, 0.02, 0.86), M.tread(), { pos: [0, 1.145, -0.04] }));
    chassis.add(vent(0.44, 0.24, steel, dark, { pos: [0, 0.92, -0.56], rot: [0, Math.PI, 0] }));
    chassis.add(part(flatBox(0.30, 0.10, 0.06), M.hazard(), { pos: [0, 0.30, 0.655] }));

    // ── tertiary: panel seams, bolt flanges, welds ──
    chassis.add(seam(0.98, dark, { pos: [0, 0.70, 0.652] }));
    chassis.add(seam(0.86, dark, { pos: [0, 1.135, -0.04], rot: [Math.PI / 2, 0, 0] }));
    chassis.add(seam(0.38, dark, { pos: [0, 0.92, 0.512], vertical: true }));
    chassis.add(bolts(perimeter(0.94, 0.34, 0.028, 0.05, 5), steel, 0.013));
    chassis.add(rivets(along([-0.44, 0.50, 0.652], [0.44, 0.50, 0.652], 9), steel));
    chassis.add(weld(1.00, dark, { pos: [0, 0.70, 0.60], rot: [0, 0, Math.PI / 2] }));
    for (const sx of [-1, 1]) {
      chassis.add(part(flatBox(0.03, 0.22, 0.42), steel, { pos: [sx * 0.46, 0.92, -0.10] }));
      chassis.add(bolts(along([sx * 0.478, 1.00, -0.26], [sx * 0.478, 1.00, 0.06], 3, [0, sx * Math.PI / 2, 0]), steel, 0.012));
    }
    // lifting eyes + grab handles
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.011, 6, 10), steel);
      eye.position.set(sx * 0.28, 1.175, -0.30);
      eye.rotation.x = Math.PI / 2;
      chassis.add(eye);
    }

    // ── tracks ──
    for (const sx of [-1, 1]) {
      const t = trackUnit({ band: M.tread(), wheel: dark, steel });
      t.group.position.set(sx * 0.63, 0.30, 0);
      if (sx === 1) t.group.rotation.y = Math.PI;
      this.wheels.push(...t.wheels);
      chassis.add(t.group);
    }

    // ── sensor turret ──
    this.turret = new THREE.Group();
    this.turret.position.set(0, 1.16, 0);
    this.turret.add(part(cyl(0.20, 0.23, 0.10, 12), steel, { pos: [0, 0.05, 0] }));
    this.turret.add(bev(0.34, 0.24, 0.30, M.gunmetal(), { pos: [0, 0.22, 0.02] }));
    this.turret.add(part(cyl(0.055, 0.055, 0.06, 10), dark, { pos: [0, 0.22, 0.16], rot: [Math.PI / 2, 0, 0] }));
    this.eye = part(cyl(0.042, 0.042, 0.02, 10), emissive(hostile ? 0xff2a12 : 0x2bff92, 2.6), {
      pos: [0, 0.22, 0.192], rot: [Math.PI / 2, 0, 0], shadow: false,
    });
    this.turret.add(this.eye);
    this.turret.add(bolts(along([-0.13, 0.345, 0.10], [0.13, 0.345, 0.10], 3, [0, 0, 0]), steel, 0.011));
    // antenna whip with a base insulator
    this.turret.add(part(cyl(0.022, 0.026, 0.05, 8), dark, { pos: [0.13, 0.35, -0.10] }));
    this.turret.add(part(cyl(0.008, 0.011, 0.62, 5), steel, { pos: [0.13, 0.66, -0.10], rot: [0.06, 0, 0.05] }));
    chassis.add(this.turret);

    // ── role kit ──
    if (hostile) {
      // weapon pod: barrel shroud, muzzle, ammo can, cabling
      const pod = new THREE.Group();
      pod.position.set(0.40, 1.02, 0.10);
      pod.add(bev(0.20, 0.20, 0.44, M.gunmetal(), { pos: [0, 0, 0] }));
      pod.add(part(cyl(0.048, 0.048, 0.46, 10), dark, { pos: [0, 0.02, 0.42], rot: [Math.PI / 2, 0, 0] }));
      pod.add(part(cyl(0.062, 0.062, 0.09, 10), steel, { pos: [0, 0.02, 0.63], rot: [Math.PI / 2, 0, 0] }));
      pod.add(part(flatBox(0.16, 0.14, 0.20), M.hazard(), { pos: [0, -0.16, -0.10] }));
      pod.add(bolts(along([-0.07, 0.10, 0.222], [0.07, 0.10, 0.222], 3), steel, 0.011));
      chassis.add(pod);
    } else {
      // manipulator: shoulder yoke, two articulated segments, gripper
      this.armUpper = new THREE.Group();
      this.armUpper.position.set(0.42, 1.02, 0.30);
      this.armUpper.add(part(cyl(0.075, 0.075, 0.14, 10), steel, { pos: [0, 0, 0], rot: [0, 0, Math.PI / 2] }));
      this.armUpper.add(part(flatBox(0.09, 0.09, 0.42), M.pipes(), { pos: [0, 0, 0.21] }));
      this.armLower = new THREE.Group();
      this.armLower.position.set(0, 0, 0.42);
      this.armLower.add(part(cyl(0.058, 0.058, 0.11, 8), steel, { pos: [0, 0, 0], rot: [0, 0, Math.PI / 2] }));
      this.armLower.add(part(flatBox(0.07, 0.07, 0.34), M.pipes(), { pos: [0, 0, 0.17] }));
      for (const sx of [-1, 1]) {
        this.armLower.add(part(flatBox(0.025, 0.06, 0.14), dark, { pos: [sx * 0.045, 0, 0.40] }));
      }
      this.armUpper.add(this.armLower);
      chassis.add(this.armUpper);
    }

    // salvage chunk it hauls
    this.carry = bev(0.42, 0.30, 0.42, M.hullWorn(), { pos: [0, 1.42, -0.04] });
    this.carry.visible = false;
    chassis.add(this.carry);

    this.group.add(chassis);
    this.group.position.copy(pos);
    shadowed(this.group);
    this.pickTarget(pos);
    registerAsset(hostile ? "hostile robot" : "worker robot", this.group, "BOT");
  }

  private pickTarget(from: THREE.Vector3) {
    this.target.set(from.x + (this.rng() - 0.5) * 60, 0, from.z + (this.rng() - 0.5) * 60);
    clampToWorld(this.target);
  }

  private moveToward(dest: THREE.Vector3, dt: number, sp: number): boolean {
    const p = this.group.position;
    const dir = new THREE.Vector3(dest.x - p.x, 0, dest.z - p.z);
    if (dir.length() < 1.1) return true;
    dir.normalize();
    const targetYaw = Math.atan2(dir.x, dir.z);
    let dy = targetYaw - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += THREE.MathUtils.clamp(dy, -2.6 * dt, 2.6 * dt);
    p.addScaledVector(dir, sp * dt);
    this.travelled += sp * dt;
    clampToWorld(p);
    return false;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const distPlayer = p.distanceTo(playerPos);

    if (this.hostile) {
      this.fireCooldown -= dt;
      if (distPlayer < 12) {
        const yaw = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
        this.group.rotation.y = yaw;
        if (this.fireCooldown <= 0 && this.onFire) {
          this.fireCooldown = 1.7;
          this.onFire(p.clone().add(new THREE.Vector3(0, 1.34, 0)), playerPos.clone().add(new THREE.Vector3(0, 1.2, 0)));
        }
      } else if (distPlayer < 26) {
        this.moveToward(playerPos, dt, this.speed * 1.5);
      } else if (this.moveToward(this.target, dt, this.speed)) {
        this.pickTarget(p);
      }
    } else {
      switch (this.job) {
        case "toPile":
          if (this.moveToward(this.pilePos, dt, this.speed)) { this.job = "picking"; this.jobTimer = 1.4; }
          break;
        case "picking":
          this.jobTimer -= dt;
          if (this.jobTimer <= 0) { this.carry.visible = true; this.job = "toBase"; }
          break;
        case "toBase":
          if (this.moveToward(this.basePos, dt, this.speed * 0.85)) { this.job = "dropping"; this.jobTimer = 1.0; }
          break;
        case "dropping":
          this.jobTimer -= dt;
          if (this.jobTimer <= 0) { this.carry.visible = false; this.job = "toPile"; this.onDeliver?.(); }
          break;
      }
      // the arm reaches down while picking and tucks while hauling
      if (this.armUpper && this.armLower) {
        const reach = this.job === "picking" ? 0.95 : this.job === "dropping" ? 0.75 : 0.15;
        this.armUpper.rotation.x = THREE.MathUtils.damp(this.armUpper.rotation.x, reach, 5, dt);
        this.armLower.rotation.x = THREE.MathUtils.damp(this.armLower.rotation.x, reach * 0.7, 5, dt);
      }
    }

    if (this.hostile) keepOutOfSafeZone(p);
    // road wheels turn with distance covered, not wall-clock time
    for (const w of this.wheels) w.rotation.y = -this.travelled * 5.4;
    // sensor head scans when idle
    this.bobPhase += dt;
    this.turret.rotation.y = this.hostile && distPlayer < 12 ? 0 : Math.sin(this.bobPhase * 0.7) * 0.5;
    p.y = heightAt(p.x, p.z) + Math.sin(this.bobPhase * 3.1) * 0.012;
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.z = Math.PI / 2.2;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 0.2;
      (this.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    }
  }
}

// ─────────────────────────────── STALKER ROBOT ───────────────────────────────
// Sniper variant of the patrol chassis. It will not close in: it holds a
// 25–40 m standoff, paints the player with a visible laser for a breath, fires
// one hard bolt, then displaces to a fresh vantage before doing it again.
// Slower than the patrol units and it never stages inside the sanctuary.
export class StalkerBot implements Entity {
  group = new THREE.Group();
  hp = 45; maxHp = 45;
  hostile = true;
  dead = false;
  radius = 1.0;
  onFire: ((from: THREE.Vector3, to: THREE.Vector3) => void) | null = null;
  onCharge: (() => void) | null = null;
  private rng: () => number;
  /** Deliberately slower than the 3.1 m/s patrol robots — it wins by range. */
  private speed = 2.3;
  private state: "hunt" | "aim" | "displace" = "hunt";
  private aimT = 0;
  private vantage = new THREE.Vector3();
  private laserMat: THREE.LineBasicMaterial;
  private laser: THREE.Line;
  private muzzleMat: THREE.MeshStandardMaterial;
  private muzzleLocal = new THREE.Vector3(0, 1.28, 1.43);
  private eye: THREE.Mesh;
  private turret: THREE.Group;
  private wheels: THREE.Mesh[] = [];
  private travelled = 0;
  private bobPhase = Math.random() * 6.28;

  constructor(pos: THREE.Vector3, seed = 6100) {
    this.rng = makeRng(seed);
    const hull = M.gunmetal();
    const worn = M.hullWorn();
    const steel = M.steel();
    const dark = M.darkSteel();

    // ── primary: low slab hull on tracks ──
    this.group.add(bev(0.92, 0.36, 1.18, hull, { pos: [0, 0.46, 0] }));
    this.group.add(bev(0.72, 0.34, 0.82, worn, { pos: [0, 0.82, -0.08] }));
    this.group.add(part(bevelBox(0.86, 0.28, 0.05), hull, { pos: [0, 0.60, 0.56], rot: [-0.5, 0, 0] }));
    for (const sx of [-1, 1]) {
      const t = trackUnit({ band: M.tread(), wheel: dark, steel });
      t.group.position.set(sx * 0.56, 0.28, 0);
      if (sx === 1) t.group.rotation.y = Math.PI;
      this.wheels.push(...t.wheels);
      this.group.add(t.group);
    }
    this.group.add(bolts(perimeter(0.84, 0.30, 0.028, 0.05, 4), steel, 0.012));
    this.group.add(rivets(along([-0.40, 0.46, 0.592], [0.40, 0.46, 0.592], 8), steel));

    // ── secondary: stabilised turret with a full-length precision barrel ──
    this.turret = new THREE.Group();
    this.turret.position.set(0, 1.02, -0.05);
    this.turret.add(part(cyl(0.19, 0.22, 0.09, 12), steel, { pos: [0, 0.045, 0] }));
    this.turret.add(bev(0.30, 0.24, 0.34, hull, { pos: [0, 0.24, 0] }));
    // barrel: receiver, long tube, muzzle brake
    this.turret.add(part(cyl(0.075, 0.085, 0.30, 10), dark, { pos: [0, 0.26, 0.26], rot: [Math.PI / 2, 0, 0] }));
    this.turret.add(part(cyl(0.034, 0.042, 1.05, 10), steel, { pos: [0, 0.26, 0.86], rot: [Math.PI / 2, 0, 0] }));
    this.turret.add(part(cyl(0.055, 0.055, 0.12, 10), dark, { pos: [0, 0.26, 1.42], rot: [Math.PI / 2, 0, 0] }));
    // scope on a riser + the glowing emitter that advertises the shot
    this.turret.add(part(flatBox(0.06, 0.06, 0.24), dark, { pos: [0, 0.42, 0.05] }));
    this.turret.add(part(cyl(0.035, 0.035, 0.03, 8), M.glass(), { pos: [0, 0.42, 0.18], rot: [Math.PI / 2, 0, 0] }));
    this.muzzleMat = new THREE.MeshStandardMaterial({ color: 0x140505, emissive: 0xff2a1a, emissiveIntensity: 0.4, roughness: 0.3, metalness: 0.2 });
    this.turret.add(part(cyl(0.03, 0.03, 0.02, 8), this.muzzleMat, { pos: [0, 0.26, 1.485], rot: [Math.PI / 2, 0, 0], shadow: false }));
    this.eye = part(cyl(0.04, 0.04, 0.02, 10), emissive(0xff8812, 2.6), { pos: [0, 0.24, 0.175], rot: [Math.PI / 2, 0, 0], shadow: false });
    this.turret.add(this.eye);
    this.group.add(this.turret);

    // The telegraph laser: a child line whose endpoints are rewritten in local
    // space every aim frame, so it tracks the player without scene plumbing.
    this.laserMat = new THREE.LineBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0 });
    this.laser = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      this.laserMat
    );
    this.laser.frustumCulled = false;
    this.group.add(this.laser);

    this.group.position.copy(pos);
    shadowed(this.group);
    registerAsset("stalker robot", this.group, "BOT");
  }

  /** New firing position on the 25–40 m ring around the player, never in the base. */
  private pickVantage(playerPos: THREE.Vector3) {
    const a = this.rng() * Math.PI * 2;
    const r = 25 + this.rng() * 15;
    this.vantage.set(playerPos.x + Math.cos(a) * r, 0, playerPos.z + Math.sin(a) * r);
    clampToWorld(this.vantage);
    if (safeZoneFactor(this.vantage.x, this.vantage.z) > 0) {
      const dx = this.vantage.x - SAFE_ZONE.x;
      const dz = this.vantage.z - SAFE_ZONE.z;
      const d = Math.hypot(dx, dz) || 1e-4;
      this.vantage.x = SAFE_ZONE.x + (dx / d) * (SAFE_ZONE.radius + 3);
      this.vantage.z = SAFE_ZONE.z + (dz / d) * (SAFE_ZONE.radius + 3);
    }
  }

  private moveToward(dest: THREE.Vector3, dt: number, sp: number): boolean {
    const p = this.group.position;
    const dir = new THREE.Vector3(dest.x - p.x, 0, dest.z - p.z);
    if (dir.length() < 1.2) return true;
    dir.normalize();
    const targetYaw = Math.atan2(dir.x, dir.z);
    let dy = targetYaw - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += THREE.MathUtils.clamp(dy, -2.2 * dt, 2.2 * dt);
    p.addScaledVector(dir, sp * dt);
    this.travelled += sp * dt;
    clampToWorld(p);
    return false;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const dist = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    this.bobPhase += dt;

    if (this.state === "aim") {
      this.aimT -= dt;
      // hull and turret both track — the laser never lies about where the bolt goes
      const yaw = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
      this.group.rotation.y = yaw;
      this.turret.rotation.y = 0;
      // charge-up: glow rises, beam tightens from a flicker to a hard line
      const charge = 1 - Math.max(0, this.aimT) / 1.2;
      this.muzzleMat.emissiveIntensity = 0.4 + charge * 3.2;
      this.laserMat.opacity = 0.18 + charge * 0.6 + Math.sin(this.bobPhase * 31) * 0.06 * (1 - charge);
      const from = this.group.localToWorld(this.muzzleLocal.clone());
      const to = new THREE.Vector3(playerPos.x, playerPos.y + 1.2, playerPos.z);
      const pts = [this.group.worldToLocal(from.clone()), this.group.worldToLocal(to.clone())];
      this.laser.geometry.setFromPoints(pts);
      if (dist > 55) {
        // player broke contact — stand down rather than waste the shot
        this.state = "hunt";
        this.laserMat.opacity = 0;
        this.muzzleMat.emissiveIntensity = 0.4;
      } else if (this.aimT <= 0) {
        this.onFire?.(from, to);
        this.laserMat.opacity = 0;
        this.muzzleMat.emissiveIntensity = 0.4;
        this.pickVantage(playerPos);
        this.state = "displace";
      }
    } else if (this.state === "displace") {
      if (this.moveToward(this.vantage, dt, this.speed * 1.35)) this.state = "hunt";
    } else {
      // hunt: hold the standoff band; only settle into the shot inside it
      if (dist > 40) this.moveToward(playerPos, dt, this.speed);
      else if (dist < 25) {
        const away = new THREE.Vector3(p.x * 2 - playerPos.x, 0, p.z * 2 - playerPos.z);
        this.moveToward(away, dt, this.speed);
      } else {
        this.state = "aim";
        this.aimT = 1.2;
        this.onCharge?.();
      }
    }

    keepOutOfSafeZone(p);
    for (const w of this.wheels) w.rotation.y = -this.travelled * 5.4;
    p.y = heightAt(p.x, p.z) + Math.sin(this.bobPhase * 3.1) * 0.012;
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.z = Math.PI / 2.2;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 0.2;
      (this.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
      this.laserMat.opacity = 0;
      this.muzzleMat.emissiveIntensity = 0;
    }
  }
}

// ─────────────────────────────── SHAMBLER ───────────────────────────────
export class Shambler implements Entity {
  group = new THREE.Group();
  hp = 40; maxHp = 40;
  hostile = true;
  dead = false;
  radius = 0.8;
  /**
   * Wave-night assault state (item 13). While `assault` is on, the shambler
   * marches on `waveGoal` instead of the player and ignores the sanctuary
   * repulsion — wave shamblers are the one hostile allowed to reach the base.
   * `slowMul`/`veer` are written by the wave manager each frame: lit floodlights
   * slow the horde and push it sideways.
   */
  assault = false;
  waveGoal = new THREE.Vector3();
  slowMul = 1;
  veer = new THREE.Vector3();
  private speed = 1.35;
  private body: Humanoid;
  private moving = 0;

  constructor(pos: THREE.Vector3) {
    this.body = new Humanoid(STYLES.SHAMBLER);
    this.group.add(this.body.group);
    this.group.position.copy(pos);
    shadowed(this.group);
    registerAsset("shambler", this.group, "ZOM");
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const goal = this.assault ? this.waveGoal : playerPos;
    const dir = new THREE.Vector3(goal.x - p.x, 0, goal.z - p.z);
    const d = dir.length();
    if (d < (this.assault ? Infinity : 42) && d > 0.6) {
      dir.normalize();
      const targetYaw = Math.atan2(dir.x, dir.z);
      let dy = targetYaw - this.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.group.rotation.y += THREE.MathUtils.clamp(dy, -1.8 * dt, 1.8 * dt);
      p.addScaledVector(dir, this.speed * this.slowMul * dt);
      this.moving = this.speed * this.slowMul;
    } else {
      this.moving = THREE.MathUtils.damp(this.moving, 0, 4, dt);
    }
    // floodlight veer: a sideways push, independent of the pursuit vector
    p.x += this.veer.x * dt;
    p.z += this.veer.z * dt;
    this.body.shamble(dt, this.moving);
    clampToWorld(p);
    if (!this.assault) keepOutOfSafeZone(p);
    p.y = heightAt(p.x, p.z);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.x = -Math.PI / 2;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 0.25;
    }
  }
}

// ─────────────────────────────── RUNNER SHAMBLER ───────────────────────────────
// The fast one. Where the shambler is a wall of dead weight, the runner is a
// sprung trap: taller, leaner, hunched low, and quick enough that standing
// still to aim is a mistake. It pays for the speed with tissue-paper health.
const RUNNER_STYLE: HumanoidStyle = {
  jacket: "CRV02", trousers: "CRV01", boots: "CRV03",
  skin: 0x9aa57c, accent: 0x7e2a1e, height: 1.84, bulk: 0.72,
};

export class RunnerShambler implements Entity {
  group = new THREE.Group();
  hp = 18; maxHp = 18;
  hostile = true;
  dead = false;
  radius = 0.7;
  onAggro: (() => void) | null = null;
  /** Wave-night assault state — see Shambler. Same contract, faster legs. */
  assault = false;
  waveGoal = new THREE.Vector3();
  slowMul = 1;
  veer = new THREE.Vector3();
  /** ~1.6× the player's 7.4 m/s sprint — you cannot simply outrun it. */
  private speed = 11.8;
  private body: Humanoid;
  private moving = 0;
  private zigPhase: number;
  private aggroed = false;

  constructor(pos: THREE.Vector3, seed = 0) {
    this.body = new Humanoid(RUNNER_STYLE);
    this.group.add(this.body.group);
    this.group.position.copy(pos);
    this.zigPhase = seed * 1.618;
    shadowed(this.group);
    registerAsset("runner shambler", this.group, "ZOM");
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const goal = this.assault ? this.waveGoal : playerPos;
    const dir = new THREE.Vector3(goal.x - p.x, 0, goal.z - p.z);
    const d = dir.length();
    if (d < (this.assault ? Infinity : 46) && d > 0.7) {
      if (!this.aggroed) { this.aggroed = true; this.onAggro?.(); }
      dir.normalize();
      // Zig-zag approach: a perpendicular sine sway on top of the pursuit
      // vector, so leading the target keeps missing by a body's width.
      this.zigPhase += dt * 2.6;
      const sway = Math.sin(this.zigPhase) * 0.9;
      const mx = dir.x - dir.z * sway;
      const mz = dir.z + dir.x * sway;
      const ml = Math.hypot(mx, mz) || 1e-4;
      const targetYaw = Math.atan2(mx / ml, mz / ml);
      let dy = targetYaw - this.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.group.rotation.y += THREE.MathUtils.clamp(dy, -4.5 * dt, 4.5 * dt);
      const spd = this.speed * this.slowMul;
      p.x += (mx / ml) * spd * dt;
      p.z += (mz / ml) * spd * dt;
      this.moving = spd;
    } else {
      this.moving = THREE.MathUtils.damp(this.moving, 0, 4, dt);
    }
    // floodlight veer (wave nights)
    p.x += this.veer.x * dt;
    p.z += this.veer.z * dt;
    this.body.animate(dt, this.moving, this.speed);
    // deeper hunch than the run cycle gives on its own — the runner's signature
    this.body.chest.rotation.x += 0.28;
    clampToWorld(p);
    if (!this.assault) keepOutOfSafeZone(p);
    p.y = heightAt(p.x, p.z);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.x = -Math.PI / 2;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 0.25;
    }
  }
}

// ─────────────────────────────── FERAL SPORE-BOAR ───────────────────────────────
// Batch 2, item 15. A 1.9 m quadruped gone septic: flesh (CRV01) over bone
// (CRV02), a tattered canvas patch (CRV05) fused to one flank, and a crop of
// spore pustules that throb when the animal is worked up.
//
// Form hierarchy: PRIMARY barrel body with shoulder hump · SECONDARY head,
// tusks, legs · TERTIARY instanced pustules and spine bristles.
//
// Behavior: roams the fields on seeded waypoints; a player inside 12 m gets a
// snort and a full second of ground-pawing (the honest telegraph), then a
// straight-line 12 m/s charge. A hit damages and knocks the player down; a
// miss runs past, wheels around, and tries again — up to 3 charges before it
// loses interest. Like every non-wave hostile it will not enter the sanctuary.
export class SporeBoar implements Entity {
  group = new THREE.Group();
  hp = 70; maxHp = 70;
  hostile = true;
  dead = false;
  radius = 1.2;
  onSnort: (() => void) | null = null;
  /** Fired once per charge when the tusks connect; dir is the charge direction. */
  onHit: ((dir: THREE.Vector3) => void) | null = null;
  private rng: () => number;
  private state: "roam" | "paw" | "charge" | "stagger" = "roam";
  private stateT = 0;
  private waypoint = new THREE.Vector3();
  private chargeDir = new THREE.Vector3(0, 0, 1);
  private chargeLeft = 0;
  private chargeTravel = 0;
  private hitThisCharge = false;
  private cooldown = 0;
  private moving = 0;
  private gaitPhase = 0;
  private bodyPhase: number;
  private head: THREE.Group;
  private torso: THREE.Group;
  private legs: THREE.Group[] = [];
  private pustuleMat: THREE.MeshStandardMaterial;

  constructor(pos: THREE.Vector3, seed = 3300) {
    this.rng = makeRng(seed);
    this.bodyPhase = this.rng() * 6.28;

    const flesh = surface("CRV01", { local: true, tile: 1.1, grime: 0.4, grimeHeight: 0.6 });
    const bone = surface("CRV02", { local: true, tile: 0.9 });
    const canvasPatch = surface("CRV05", { local: true, tile: 0.9, grime: 0.3, gamma: 0.8, gain: 1.04 });
    const hoofMat = M.rubber();
    const bristleMat = plain(0x2e2a24, 0.9, 0.05);

    // ── primary: barrel body, shoulder hump, rump ──
    this.torso = new THREE.Group();
    this.torso.position.y = 0.92;
    this.torso.add(bev(1.05, 0.78, 1.90, flesh, { pos: [0, 0, 0] }));
    this.torso.add(bev(1.00, 0.50, 0.80, flesh, { pos: [0, 0.45, 0.45] })); // hump
    this.torso.add(bev(0.90, 0.40, 0.60, flesh, { pos: [0, 0.30, -0.70] })); // rump
    // tattered canvas patch fused to the flank — scavenger-camp origin
    this.torso.add(part(flatBox(0.02, 0.52, 0.72), canvasPatch, { pos: [0.53, 0.02, -0.20], rot: [0, 0, 0.06], shadow: false }));
    this.torso.add(part(cyl(0.04, 0.07, 0.30, 6), flesh, { pos: [0, 0.10, -1.02], rot: [0.7, 0, 0] })); // tail stub
    this.group.add(this.torso);

    // ── secondary: head with snout, tusks, ears, ember eyes ──
    this.head = new THREE.Group();
    this.head.position.set(0, 0.98, 1.05);
    this.head.add(bev(0.55, 0.50, 0.62, flesh, { pos: [0, 0, 0.10] }));
    this.head.add(bev(0.34, 0.30, 0.34, flesh, { pos: [0, -0.10, 0.50] })); // snout
    this.head.add(part(cyl(0.09, 0.11, 0.10, 8), hoofMat, { pos: [0, -0.08, 0.68] })); // wet nose
    for (const sx of [-1, 1]) {
      // tusks: two angled bone segments per side, curving up and out
      this.head.add(part(cyl(0.020, 0.050, 0.30, 7), bone, { pos: [sx * 0.20, -0.16, 0.50], rot: [1.1, 0, sx * 0.4] }));
      this.head.add(part(cyl(0.010, 0.020, 0.18, 6), bone, { pos: [sx * 0.28, -0.02, 0.62], rot: [0.6, 0, sx * 0.6] }));
      this.head.add(part(cyl(0.03, 0.03, 0.02, 8), emissive(0xff4418, 2.2), { pos: [sx * 0.20, 0.08, 0.42], rot: [Math.PI / 2, 0, sx * 0.5], shadow: false }));
      this.head.add(part(flatBox(0.05, 0.16, 0.10), flesh, { pos: [sx * 0.24, 0.30, -0.05], rot: [0.2, 0, sx * 0.4] }));
    }
    this.group.add(this.head);

    // ── secondary: four legs, flesh upper over a bare bone shin ──
    for (const [sx, sz] of [[-0.36, 0.60], [0.36, 0.60], [-0.36, -0.62], [0.36, -0.62]] as Array<[number, number]>) {
      const leg = new THREE.Group();
      leg.position.set(sx, 0.82, sz);
      leg.add(bev(0.22, 0.50, 0.26, flesh, { pos: [0, -0.22, 0] }));
      const knee = new THREE.Group();
      knee.position.set(0, -0.44, 0);
      leg.add(knee);
      knee.add(part(cyl(0.07, 0.10, 0.32, 8), bone, { pos: [0, -0.16, 0] }));
      knee.add(part(cyl(0.09, 0.10, 0.09, 8), hoofMat, { pos: [0, -0.34, 0] }));
      this.legs.push(leg);
      this.group.add(leg);
    }

    // ── tertiary: instanced pustules on the flanks, bristles along the spine ──
    this.pustuleMat = new THREE.MeshStandardMaterial({
      color: 0x8fa04a, emissive: 0x5a7a2a, emissiveIntensity: 0.9, roughness: 0.55, metalness: 0,
    });
    const pustuleGeo = new THREE.SphereGeometry(0.06, 8, 6);
    const pustules = new THREE.InstancedMesh(pustuleGeo, this.pustuleMat, 14);
    {
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      const v = new THREE.Vector3();
      for (let i = 0; i < 14; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        v.set(
          side * (0.50 + this.rng() * 0.06),
          0.15 + this.rng() * 0.35,
          -0.75 + this.rng() * 1.35
        );
        const k = 0.6 + this.rng() * 0.9;
        s.set(k, k * (0.7 + this.rng() * 0.4), k);
        m4.compose(v, q, s);
        pustules.setMatrixAt(i, m4);
      }
      pustules.instanceMatrix.needsUpdate = true;
      pustules.castShadow = true;
      this.torso.add(pustules);
    }
    const bristleGeo = flatBox(0.035, 0.20, 0.06);
    const bristles = new THREE.InstancedMesh(bristleGeo, bristleMat, 9);
    {
      const m4 = new THREE.Matrix4();
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const s = new THREE.Vector3(1, 1, 1);
      const v = new THREE.Vector3();
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        v.set(0, 0.62 + Math.sin(t * Math.PI) * 0.14, 0.75 - t * 1.45);
        e.set(-0.45, 0, (this.rng() - 0.5) * 0.3);
        q.setFromEuler(e);
        m4.compose(v, q, s);
        bristles.setMatrixAt(i, m4);
      }
      bristles.instanceMatrix.needsUpdate = true;
      bristles.castShadow = true;
      this.torso.add(bristles);
    }

    this.group.position.copy(pos);
    shadowed(this.group);
    this.pickWaypoint();
    registerAsset("feral spore-boar", this.group, "BST");
  }

  private pickWaypoint() {
    const p = this.group.position;
    for (let i = 0; i < 8; i++) {
      const x = p.x + (this.rng() - 0.5) * 50;
      const z = p.z + (this.rng() - 0.5) * 50;
      if (safeZoneFactor(x, z) > 0) continue;
      const L = WORLD.SIZE / 2 - 6;
      this.waypoint.set(THREE.MathUtils.clamp(x, -L, L), 0, THREE.MathUtils.clamp(z, -L, L));
      return;
    }
    this.waypoint.set(p.x, 0, p.z);
  }

  private faceToward(dir: THREE.Vector3, turn: number, dt: number) {
    const targetYaw = Math.atan2(dir.x, dir.z);
    let dy = targetYaw - this.group.rotation.y;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.group.rotation.y += THREE.MathUtils.clamp(dy, -turn * dt, turn * dt);
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const distP = Math.hypot(playerPos.x - p.x, playerPos.z - p.z);
    this.bodyPhase += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    switch (this.state) {
      case "roam": {
        if (distP < 12 && this.cooldown <= 0) {
          // snort + paw: the warning before the violence
          this.state = "paw";
          this.stateT = 1.0;
          this.chargeLeft = 3;
          this.onSnort?.();
          break;
        }
        const dir = new THREE.Vector3(this.waypoint.x - p.x, 0, this.waypoint.z - p.z);
        if (dir.length() < 1.5) {
          this.pickWaypoint();
        } else {
          dir.normalize();
          this.faceToward(dir, 3.2, dt);
          p.addScaledVector(dir, 2.2 * dt);
          this.moving = 2.2;
        }
        break;
      }
      case "paw": {
        // square up to the player and scrape — ~1 s of readable telegraph
        const dir = new THREE.Vector3(playerPos.x - p.x, 0, playerPos.z - p.z);
        if (dir.lengthSq() > 1e-6) this.faceToward(dir.normalize(), 6, dt);
        this.stateT -= dt;
        this.moving = THREE.MathUtils.damp(this.moving, 0, 8, dt);
        if (this.stateT <= 0) {
          this.state = "charge";
          this.chargeDir.set(playerPos.x - p.x, 0, playerPos.z - p.z).normalize();
          this.chargeTravel = 0;
          this.hitThisCharge = false;
          this.chargeLeft -= 1;
        }
        break;
      }
      case "charge": {
        this.group.rotation.y = Math.atan2(this.chargeDir.x, this.chargeDir.z);
        p.addScaledVector(this.chargeDir, 12 * dt);
        this.chargeTravel += 12 * dt;
        this.moving = 12;
        if (!this.hitThisCharge && distP < 1.4) {
          this.hitThisCharge = true;
          this.onHit?.(this.chargeDir.clone());
          // got its gore — shakes it off, then loses interest for a while
          this.state = "stagger";
          this.stateT = 1.2;
          this.cooldown = 5;
        } else if (this.chargeTravel > 22) {
          // ran past — wheel around for another attempt
          this.state = "stagger";
          this.stateT = 0.8;
        }
        break;
      }
      case "stagger": {
        this.stateT -= dt;
        this.moving = THREE.MathUtils.damp(this.moving, 0, 6, dt);
        if (this.stateT <= 0) {
          if (this.chargeLeft > 0 && distP < 20 && this.cooldown <= 0) {
            this.state = "paw";
            this.stateT = 0.7; // shorter telegraph on the follow-up charges
          } else {
            this.state = "roam";
            this.cooldown = Math.max(this.cooldown, 4);
            this.pickWaypoint();
          }
        }
        break;
      }
    }

    // ── gait ──
    const gait = Math.min(1, this.moving / 12);
    this.gaitPhase += dt * (2.4 + this.moving * 1.7);
    const swing = (0.30 + gait * 0.40) * (this.moving > 0.1 ? 1 : 0);
    if (this.state === "paw") {
      // one front hoof rakes the dirt, head drops — the whole silhouette warns
      this.legs[1].rotation.x = -0.9 + Math.sin(this.bodyPhase * 14) * 0.5;
      this.legs[0].rotation.x = THREE.MathUtils.damp(this.legs[0].rotation.x, 0.15, 8, dt);
      this.legs[2].rotation.x = THREE.MathUtils.damp(this.legs[2].rotation.x, 0, 8, dt);
      this.legs[3].rotation.x = THREE.MathUtils.damp(this.legs[3].rotation.x, 0, 8, dt);
      this.head.rotation.x = THREE.MathUtils.damp(this.head.rotation.x, 0.55, 8, dt);
    } else {
      // diagonal pairs, like a real trot
      const s = Math.sin(this.gaitPhase);
      this.legs[0].rotation.x = s * swing;
      this.legs[3].rotation.x = s * swing;
      this.legs[1].rotation.x = -s * swing;
      this.legs[2].rotation.x = -s * swing;
      const headTarget = this.state === "charge" ? 0.5 : 0.06 + Math.sin(this.bodyPhase * 1.7) * 0.05;
      this.head.rotation.x = THREE.MathUtils.damp(this.head.rotation.x, headTarget, 8, dt);
    }
    // pustules throb harder while the animal is winding up
    this.pustuleMat.emissiveIntensity =
      0.75 + Math.sin(this.bodyPhase * 2.6) * 0.45 + (this.state === "paw" ? 0.6 : 0);

    clampToWorld(p);
    keepOutOfSafeZone(p); // not a wave hostile — the sanctuary holds
    p.y = heightAt(p.x, p.z);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.z = Math.PI / 2.1;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 0.3;
      this.pustuleMat.emissiveIntensity = 0.1;
    }
  }
}

// ─────────────────────────────── NPC HELPER ───────────────────────────────
export type Job = "FARMER" | "SCRAPPER" | "GUARD";

export class Helper {
  group = new THREE.Group();
  job: Job;
  readonly name: string;
  private stations: THREE.Vector3[];
  private idx = 0;
  private wait = 0;
  private body: Humanoid;
  private moving = 0;

  constructor(pos: THREE.Vector3, job: Job, stations: THREE.Vector3[], name: string) {
    this.job = job;
    this.name = name;
    this.stations = stations;
    this.body = new Humanoid(STYLES[job]);
    this.group.add(this.body.group);
    this.group.position.copy(pos);
    this.group.position.y = heightAt(pos.x, pos.z);
    shadowed(this.group);
    const tag = makeTag(`${name} · ${job}`, "#9fd08a");
    tag.position.y = 2.15;
    this.group.add(tag);
    registerAsset(`npc ${job.toLowerCase()}`, this.group, "NPC");
  }

  update(dt: number) {
    const p = this.group.position;
    if (this.wait > 0) {
      this.wait -= dt;
      this.moving = THREE.MathUtils.damp(this.moving, 0, 6, dt);
    } else {
      const dest = this.stations[this.idx];
      const dir = new THREE.Vector3(dest.x - p.x, 0, dest.z - p.z);
      if (dir.length() < 0.5) {
        this.wait = 2.5 + Math.random() * 3;
        this.idx = (this.idx + 1) % this.stations.length;
      } else {
        dir.normalize();
        const targetYaw = Math.atan2(dir.x, dir.z);
        let dy = targetYaw - this.group.rotation.y;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.group.rotation.y += THREE.MathUtils.clamp(dy, -6 * dt, 6 * dt);
        p.addScaledVector(dir, 1.9 * dt);
        this.moving = 1.9;
      }
    }
    this.body.animate(dt, this.moving, 7.4);
    p.y = heightAt(p.x, p.z);
  }
}

/**
 * World-space text label.
 *
 * `onTop` disables depth testing so the label draws over geometry instead of
 * being sliced in half by it. Inspection labels must be readable through walls —
 * a half-occluded asset ID is worse than none, because you cannot tell whether
 * you are reading 0043 or 0048. NPC name tags keep depth testing so they still
 * behave like objects in the world.
 */
export function makeTag(text: string, color = "#ffffff", scale = 1, onTop = false): THREE.Sprite {
  const lines = text.split("\n");
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  ctx.font = "600 26px 'Courier New', monospace";
  const w = Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + 24;
  const h = 16 + lines.length * 32;
  c.width = w; c.height = h;
  const ctx2 = c.getContext("2d")!;
  ctx2.fillStyle = "rgba(10,12,10,0.72)";
  ctx2.fillRect(0, 0, w, h);
  ctx2.strokeStyle = color; ctx2.lineWidth = 2;
  ctx2.strokeRect(1, 1, w - 2, h - 2);
  ctx2.font = "600 26px 'Courier New', monospace";
  ctx2.fillStyle = color;
  ctx2.textBaseline = "middle";
  lines.forEach((l, i) => ctx2.fillText(l, 12, 24 + i * 32));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex,
    depthTest: !onTop,
    depthWrite: !onTop,
    transparent: true,
  }));
  if (onTop) sp.renderOrder = 900;
  sp.scale.set((w / h) * 0.5 * scale, 0.5 * scale, 1);
  return sp;
}

// ─────────────────────────────── BOSS ───────────────────────────────
// 9.6 m bipedal siege walker. Built as armour plates bolted over a visible
// frame, with hydraulics at every joint — the mechanism is the silhouette.
export class Boss implements Entity {
  group = new THREE.Group();
  hp = 500; maxHp = 500;
  hostile = true;
  dead = false;
  radius = 4.2;
  engaged = false;
  onStomp: (() => void) | null = null;
  private phase = 0;
  private lastStompBeat = 0;
  private core: THREE.Mesh;
  private hipL: THREE.Group;
  private hipR: THREE.Group;
  private stride = 0;

  constructor(pos: THREE.Vector3) {
    const armour = M.battle();
    const worn = M.hullWorn();
    const steel = M.steel();
    const dark = M.darkSteel();
    const hazard = M.hazard();
    const pipe = M.pipes();

    // ── legs: thigh, shin, foot, with hydraulic rams and armour shins ──
    const buildLeg = (sx: -1 | 1) => {
      const hip = new THREE.Group();
      hip.position.set(sx * 1.5, 4.4, 0);
      hip.add(part(cyl(0.52, 0.52, 0.78, 12), dark, { pos: [0, 0, 0], rot: [0, 0, Math.PI / 2] }));
      hip.add(bev(1.16, 2.30, 1.34, armour, { pos: [0, -1.25, 0] }));
      hip.add(part(flatBox(0.24, 1.9, 0.24), pipe, { pos: [sx * 0.66, -1.2, 0.42] })); // ram cylinder
      hip.add(part(cyl(0.075, 0.075, 1.1, 8), M.chrome(), { pos: [sx * 0.66, -2.2, 0.42] })); // ram rod
      hip.add(bolts(perimeter(1.0, 2.0, 0.68, 0.16, 4), steel, 0.028));

      const knee = new THREE.Group();
      knee.position.set(0, -2.45, 0);
      hip.add(knee);
      knee.add(part(cyl(0.40, 0.40, 0.90, 10), dark, { pos: [0, 0, 0], rot: [0, 0, Math.PI / 2] }));
      knee.add(bev(0.98, 2.10, 1.10, worn, { pos: [0, -1.15, 0] }));
      knee.add(part(bevelBox(1.06, 1.30, 0.22), armour, { pos: [0, -0.95, 0.58] })); // shin plate
      knee.add(bolts(perimeter(0.9, 1.1, 0.12, 0.14, 3), steel, 0.026));
      knee.add(seam(1.0, dark, { pos: [0, -1.6, 0.565] }));
      // ankle + foot
      knee.add(part(cyl(0.28, 0.28, 0.66, 8), dark, { pos: [0, -2.24, 0], rot: [0, 0, Math.PI / 2] }));
      knee.add(bev(1.36, 0.34, 2.10, worn, { pos: [0, -2.48, 0.26] }));
      for (const tz of [-0.5, 0.2, 0.9]) {
        knee.add(part(flatBox(1.30, 0.10, 0.16), M.tread(), { pos: [0, -2.66, tz] })); // grousers
      }
      knee.add(part(flatBox(1.20, 0.16, 0.10), hazard, { pos: [0, -2.36, 1.28] }));
      return hip;
    };
    this.hipL = buildLeg(-1);
    this.hipR = buildLeg(1);
    this.group.add(this.hipL, this.hipR);

    // ── pelvis + torso ──
    this.group.add(bev(3.10, 1.50, 2.10, worn, { pos: [0, 4.60, 0] }));
    this.group.add(part(flatBox(3.20, 0.30, 2.16), hazard, { pos: [0, 3.95, 0] }));
    this.group.add(bolts(perimeter(2.9, 1.2, 1.09, 0.2, 5), steel, 0.03));

    this.group.add(bev(4.30, 2.90, 2.70, armour, { pos: [0, 7.00, 0] }));
    this.group.add(part(bevelBox(4.36, 0.66, 2.76), hazard, { pos: [0, 8.00, 0] }));
    this.group.add(seam(4.2, dark, { pos: [0, 6.20, 1.36] }));
    this.group.add(seam(2.7, dark, { pos: [0, 7.00, 1.36], vertical: true }));
    this.group.add(bolts(perimeter(4.0, 2.6, 1.36, 0.22, 6), steel, 0.032));
    this.group.add(rivets(along([-1.9, 5.65, 1.362], [1.9, 5.65, 1.362], 14), steel, 0.026));
    // chest vents + intake grilles
    this.group.add(vent(0.9, 0.7, steel, dark, { pos: [-1.35, 6.55, 1.37] }));
    this.group.add(vent(0.9, 0.7, steel, dark, { pos: [1.35, 6.55, 1.37] }));
    // reactor core in a cage
    this.core = part(new THREE.SphereGeometry(0.62, 18, 14), new THREE.MeshStandardMaterial({
      map: surface("CRV09", { local: true, tile: 1.4 }).map, emissive: 0xffa022, emissiveIntensity: 1.7, roughness: 0.35, metalness: 0.6,
    }), { pos: [0, 6.60, 1.46] });
    this.group.add(this.core);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      this.group.add(part(flatBox(0.08, 0.08, 0.42), steel, {
        pos: [Math.cos(a) * 0.62, 6.60 + Math.sin(a) * 0.62, 1.52], rot: [0, 0, a],
      }));
    }
    // exhaust stacks
    for (const sx of [-1, 1]) {
      this.group.add(part(cyl(0.20, 0.24, 1.5, 10), pipe, { pos: [sx * 1.55, 9.00, -1.20] }));
      this.group.add(part(cyl(0.25, 0.22, 0.22, 10), dark, { pos: [sx * 1.55, 9.82, -1.20] }));
    }
    // back cabling
    for (const sx of [-0.6, 0, 0.6]) {
      this.group.add(part(cyl(0.07, 0.07, 2.4, 6), M.rubber(), { pos: [sx, 6.6, -1.42], rot: [0.16, 0, 0] }));
    }

    // ── shoulders + arms ──
    for (const sx of [-1, 1] as const) {
      this.group.add(part(cyl(0.62, 0.62, 0.9, 12), dark, { pos: [sx * 2.30, 7.60, 0], rot: [0, 0, Math.PI / 2] }));
      // pauldron
      this.group.add(part(bevelBox(1.50, 1.10, 1.90), armour, { pos: [sx * 2.62, 7.85, 0], rot: [0, 0, sx * 0.14] }));
      this.group.add(bolts(perimeter(1.3, 1.7, 0.96, 0.18, 4, [Math.PI / 2, 0, 0]).map((p) => ({
        ...p, pos: [sx * 2.62 + p.pos[1] * 0, p.pos[1] + 7.85, p.pos[0]] as [number, number, number],
      })), steel, 0.028));
      this.group.add(bev(1.00, 3.50, 1.20, worn, { pos: [sx * 2.90, 6.60, 0] }));
      this.group.add(part(flatBox(0.18, 2.2, 0.18), pipe, { pos: [sx * 3.48, 6.7, 0.28] }));
      this.group.add(seam(3.3, dark, { pos: [sx * 3.41, 6.60, 0], rot: [0, 0, Math.PI / 2] }));
      // fist / breaker
      this.group.add(bev(1.30, 1.30, 1.30, M.tread(), { pos: [sx * 2.90, 4.45, 0] }));
      this.group.add(part(flatBox(1.34, 0.20, 1.34), hazard, { pos: [sx * 2.90, 5.10, 0] }));
      for (const kz of [-0.42, 0, 0.42]) {
        this.group.add(part(bevelBox(0.22, 0.30, 0.22), steel, { pos: [sx * 2.90, 3.78, kz] })); // knuckle spikes
      }
    }

    // ── head ──
    this.group.add(part(cyl(0.34, 0.34, 0.5, 10), dark, { pos: [0, 8.62, 0] }));
    this.group.add(bev(1.56, 1.16, 1.56, M.gunmetal(), { pos: [0, 9.20, 0] }));
    this.group.add(part(bevelBox(1.62, 0.24, 0.9), armour, { pos: [0, 9.72, 0.20] })); // brow
    this.group.add(part(flatBox(1.28, 0.26, 0.08), emissive(0xff3010, 3.0), { pos: [0, 9.22, 0.80], shadow: false }));
    this.group.add(bolts(along([-0.62, 9.60, 0.79], [0.62, 9.60, 0.79], 5), steel, 0.024));
    // sensor array
    for (const sx of [-1, 1]) {
      this.group.add(part(cyl(0.05, 0.05, 0.5, 6), steel, { pos: [sx * 0.7, 9.95, -0.2], rot: [0.2, 0, sx * 0.24] }));
      this.group.add(part(cyl(0.10, 0.06, 0.12, 8), dark, { pos: [sx * 0.78, 10.22, -0.26] }));
    }
    this.group.add(vent(0.7, 0.4, steel, dark, { pos: [0, 9.05, -0.79], rot: [0, Math.PI, 0] }));

    this.group.position.copy(pos);
    shadowed(this.group);
    registerAsset("BOSS: IRON WARDEN", this.group, "BOS");
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const d = p.distanceTo(playerPos);
    this.engaged = d < 34;
    this.phase += dt * 2.2;

    let moving = 0;
    if (this.engaged && d > 5.5) {
      const dir = new THREE.Vector3(playerPos.x - p.x, 0, playerPos.z - p.z).normalize();
      const targetYaw = Math.atan2(dir.x, dir.z);
      let dy = targetYaw - this.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.group.rotation.y += THREE.MathUtils.clamp(dy, -0.9 * dt, 0.9 * dt);
      p.addScaledVector(dir, 1.7 * dt);
      this.stride += 1.7 * dt;
      moving = 1;
    }
    // heavy two-beat stomp; the whole mass rises on the loaded leg
    const s = Math.sin(this.stride * 1.5);
    // one stomp per half-cycle of the gait, fired as the foot plants
    const beat = Math.floor(this.stride * 1.5 / Math.PI);
    if (moving && beat !== this.lastStompBeat) {
      this.lastStompBeat = beat;
      this.onStomp?.();
    }
    this.hipL.rotation.x = -s * 0.42 * moving;
    this.hipR.rotation.x = s * 0.42 * moving;
    p.y = heightAt(p.x, p.z) + Math.abs(s) * 0.30 * moving;

    (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.3 + Math.sin(this.phase * 3) * 0.6;
    clampToWorld(p);
    keepOutOfSafeZone(p);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.x = -Math.PI / 3;
      this.group.position.y = heightAt(this.group.position.x, this.group.position.z) + 1.2;
      (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2;
    }
  }
}

// ─────────────────────────────── VEHICLES ───────────────────────────────
export interface Seat {
  name: string;
  offset: THREE.Vector3;
  driver?: boolean;
}

export class Vehicle {
  group = new THREE.Group();
  seats: Seat[] = [];
  seatIdx = 0;
  occupied = false;
  speed = 0;
  name = "VEHICLE";
  topSpeed = 16;
  protected wheels: THREE.Mesh[] = [];
  protected rollDistance = 0;
  protected rideHeight = 0;

  seatWorld(i: number): THREE.Vector3 {
    const s = this.seats[i];
    return s.offset.clone().applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  cycleSeat() { this.seatIdx = (this.seatIdx + 1) % this.seats.length; }

  get isDriving() { return this.seats[this.seatIdx]?.driver === true; }

  drive(dt: number, throttle: number, steer: number) {
    this.speed = THREE.MathUtils.damp(this.speed, throttle * this.topSpeed, 3, dt);
    // steering authority falls off at low speed, like a real steered axle
    this.group.rotation.y += steer * dt * 1.8 * Math.sign(this.speed) * Math.min(1, Math.abs(this.speed) / 4);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.group.position.addScaledVector(fwd, this.speed * dt);
    clampToWorld(this.group.position);
    this.rollDistance += this.speed * dt;
    for (const w of this.wheels) w.rotation.x = this.rollDistance / 0.42;
    this.settle(dt);
  }

  /** Rest on the terrain and pitch/roll to its slope. */
  settle(dt: number) {
    const p = this.group.position;
    const y = heightAt(p.x, p.z) + this.rideHeight;
    p.y = THREE.MathUtils.damp(p.y, y, 9, dt);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
    const ahead = heightAt(p.x + fwd.x * 1.6, p.z + fwd.z * 1.6);
    const behind = heightAt(p.x - fwd.x * 1.6, p.z - fwd.z * 1.6);
    const pitch = Math.atan2(behind - ahead, 3.2);
    this.group.rotation.x = THREE.MathUtils.damp(this.group.rotation.x, pitch, 7, dt);
  }

  /** Wheel with a real tyre, rim, hub and lug nuts. */
  protected addWheels(positions: Array<[number, number, number]>, radius = 0.42, width = 0.30) {
    const tyre = surface("CRV03", { local: true, tile: 0.7, grime: 0.6, grimeHeight: 0.5 });
    const rim = M.steel();
    const hub = M.darkSteel();
    for (const [sx, sy, sz] of positions) {
      const g = new THREE.Group();
      g.position.set(sx, sy, sz);
      const t = part(cyl(radius, radius, width, 18), tyre, { rot: [0, 0, Math.PI / 2] });
      g.add(t);
      // sidewall shoulders so the tyre isn't a flat cylinder in silhouette
      g.add(part(cyl(radius * 0.94, radius * 0.94, width * 1.06, 18), tyre, { rot: [0, 0, Math.PI / 2] }));
      for (const side of [-1, 1]) {
        g.add(part(cyl(radius * 0.62, radius * 0.62, 0.03, 14), rim, { pos: [(side * width) / 2, 0, 0], rot: [0, 0, Math.PI / 2] }));
        g.add(part(cyl(radius * 0.22, radius * 0.22, 0.05, 10), hub, { pos: [(side * width) / 2 + side * 0.015, 0, 0], rot: [0, 0, Math.PI / 2] }));
        const lugs: Array<{ pos: [number, number, number]; rot: [number, number, number] }> = [];
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          lugs.push({ pos: [(side * width) / 2 + side * 0.03, Math.sin(a) * radius * 0.34, Math.cos(a) * radius * 0.34], rot: [0, side * Math.PI / 2, 0] });
        }
        g.add(bolts(lugs, rim, 0.012));
      }
      // treads across the crown
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        g.add(part(flatBox(width * 1.02, 0.035, 0.10), M.rubber(), {
          pos: [0, Math.sin(a) * radius, Math.cos(a) * radius], rot: [-a, 0, 0], shadow: false,
        }));
      }
      this.wheels.push(g as unknown as THREE.Mesh);
      this.group.add(g);
    }
  }
}

export class Buggy extends Vehicle {
  constructor(pos: THREE.Vector3) {
    super();
    this.name = "DUNE BUGGY";
    this.topSpeed = 16;
    this.rideHeight = 0.06;
    const body = surface("CRV04", { local: true, tile: 2.0, grime: 0.5, grimeHeight: 0.7 });
    const steel = M.steel();
    const dark = M.darkSteel();

    // ── primary: tube chassis + floor pan ──
    this.group.add(bev(1.70, 0.34, 3.10, body, { pos: [0, 0.62, 0] }));
    this.group.add(part(flatBox(1.62, 0.04, 2.90), M.tread(), { pos: [0, 0.80, 0] }));

    // ── secondary: roll cage (real tubes), cowl, seats, engine ──
    const tube = (len: number, p: [number, number, number], r: [number, number, number]) =>
      this.group.add(part(cyl(0.045, 0.045, len, 8), steel, { pos: p, rot: r }));
    for (const sx of [-0.78, 0.78]) {
      tube(1.15, [sx, 1.38, -0.55], [0, 0, 0]);            // rear hoop uprights
      tube(1.05, [sx, 1.33, 0.72], [0.30, 0, 0]);          // front uprights
      tube(1.30, [sx, 1.93, 0.10], [Math.PI / 2, 0, 0]);   // roof rails
      tube(0.90, [sx, 1.00, 0.10], [Math.PI / 2, 0, 0]);   // side intrusion bar
    }
    tube(1.56, [0, 1.95, -0.55], [0, 0, Math.PI / 2]);      // rear hoop top
    tube(1.56, [0, 1.86, 0.62], [0, 0, Math.PI / 2]);       // windscreen header
    tube(1.56, [0, 0.96, -0.55], [0, 0, Math.PI / 2]);
    // cage gussets + bolts at every node
    for (const sx of [-0.78, 0.78]) {
      this.group.add(part(flatBox(0.10, 0.10, 0.02), steel, { pos: [sx, 1.93, -0.55] }));
      this.group.add(bolts([{ pos: [sx, 1.93, -0.53], rot: [Math.PI / 2, 0, 0] }], steel, 0.013));
    }

    this.group.add(part(bevelBox(1.58, 0.44, 0.10), body, { pos: [0, 1.10, 1.42], rot: [0.34, 0, 0] })); // cowl
    this.group.add(part(flatBox(1.42, 0.52, 0.02), M.glass(), { pos: [0, 1.44, 0.68], rot: [0.30, 0, 0], shadow: false }));
    for (const sx of [-0.42, 0.42]) {
      this.group.add(bev(0.50, 0.16, 0.48, surface("CRV06", { local: true, tile: 0.8 }), { pos: [sx, 0.90, -0.24] })); // seat pan
      this.group.add(part(bevelBox(0.50, 0.62, 0.12), surface("CRV06", { local: true, tile: 0.8 }), { pos: [sx, 1.20, -0.48], rot: [0.16, 0, 0] })); // seat back
      this.group.add(part(flatBox(0.06, 0.60, 0.02), M.hazard(), { pos: [sx, 1.16, -0.40], rot: [0.16, 0, 0], shadow: false })); // harness
    }
    // steering wheel + column
    this.group.add(part(cyl(0.035, 0.035, 0.34, 6), dark, { pos: [0.42, 1.16, 0.28], rot: [1.05, 0, 0] }));
    const sw = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.019, 6, 16), dark);
    sw.position.set(0.42, 1.30, 0.42); sw.rotation.x = 1.05;
    this.group.add(sw);
    // rear engine + exhaust
    this.group.add(bev(0.90, 0.52, 0.66, M.pipes(), { pos: [0, 0.94, -1.24] }));
    this.group.add(vent(0.62, 0.30, steel, dark, { pos: [0, 0.96, -1.58], rot: [0, Math.PI, 0] }));
    for (const sx of [-0.3, 0.3]) {
      this.group.add(part(cyl(0.045, 0.05, 0.62, 8), M.chrome(), { pos: [sx, 1.28, -1.42], rot: [0.5, 0, 0] }));
    }
    // bumpers, lights, mirrors, spare
    this.group.add(part(cyl(0.05, 0.05, 1.60, 8), steel, { pos: [0, 0.70, 1.62], rot: [0, 0, Math.PI / 2] }));
    this.group.add(part(cyl(0.05, 0.05, 1.60, 8), steel, { pos: [0, 0.70, -1.62], rot: [0, 0, Math.PI / 2] }));
    for (const sx of [-0.52, 0.52]) {
      this.group.add(part(cyl(0.13, 0.13, 0.09, 12), steel, { pos: [sx, 1.02, 1.58], rot: [Math.PI / 2, 0, 0] }));
      this.group.add(part(cyl(0.11, 0.11, 0.02, 12), emissive(0xffeec2, 0.9), { pos: [sx, 1.02, 1.635], rot: [Math.PI / 2, 0, 0], shadow: false }));
      this.group.add(part(flatBox(0.10, 0.05, 0.02), emissive(0xcc2211, 0.7), { pos: [sx, 1.02, -1.66], shadow: false }));
    }
    this.group.add(part(cyl(0.42, 0.42, 0.22, 14), surface("CRV03", { local: true, tile: 0.7 }), { pos: [0, 1.20, -1.72], rot: [Math.PI / 2, 0, 0] }));
    this.group.add(seam(3.0, dark, { pos: [0, 0.79, 0.86], rot: [0, Math.PI / 2, 0] }));
    this.group.add(rivets(along([-0.80, 0.62, 1.53], [0.80, 0.62, 1.53], 9), steel));

    this.addWheels([[-0.92, 0.44, 1.08], [0.92, 0.44, 1.08], [-0.92, 0.44, -1.08], [0.92, 0.44, -1.08]], 0.44, 0.32);

    this.seats = [
      { name: "DRIVER", offset: new THREE.Vector3(0.42, 1.22, -0.30), driver: true },
      { name: "PASSENGER", offset: new THREE.Vector3(-0.42, 1.22, -0.30) },
    ];
    this.group.position.copy(pos);
    shadowed(this.group);
    registerAsset("vehicle buggy", this.group, "VEH");
  }
}

export class Truck extends Vehicle {
  constructor(pos: THREE.Vector3) {
    super();
    this.name = "FLATBED TRUCK";
    this.topSpeed = 11;
    this.rideHeight = 0.08;
    const cabMat = surface("STR09", { local: true, tile: 2.2, grime: 0.5, grimeHeight: 1.2 });
    const deck = surface("STR01", { local: true, tile: 1.6, grime: 0.5, grimeHeight: 0.9 });
    const steel = M.steel();
    const dark = M.darkSteel();

    // ── primary: ladder frame + cab + bed ──
    for (const sx of [-0.78, 0.78]) {
      this.group.add(part(flatBox(0.14, 0.22, 5.40), dark, { pos: [sx, 0.66, 0] })); // chassis rails
    }
    for (const tz of [2.0, 0.6, -1.0, -2.3]) {
      this.group.add(part(flatBox(1.64, 0.10, 0.12), dark, { pos: [0, 0.66, tz] })); // cross members
    }
    this.group.add(bev(2.10, 1.24, 1.70, cabMat, { pos: [0, 1.64, 1.86] }));
    this.group.add(bev(2.14, 0.10, 3.40, deck, { pos: [0, 1.02, -1.00] }));

    // ── secondary: bonnet, glass, doors, bed sides, fuel tank, spare ──
    this.group.add(bev(2.00, 0.52, 1.10, cabMat, { pos: [0, 1.34, 3.02] }));           // bonnet
    this.group.add(vent(0.9, 0.28, steel, dark, { pos: [0, 1.30, 3.58] }));            // grille
    this.group.add(part(flatBox(1.86, 0.62, 0.02), M.glass(), { pos: [0, 1.92, 2.70], rot: [0.22, 0, 0], shadow: false }));
    for (const sx of [-1.06, 1.06]) {
      this.group.add(part(flatBox(0.02, 0.60, 0.66), M.glass(), { pos: [sx, 1.90, 1.94], shadow: false })); // side glass
      this.group.add(part(flatBox(0.03, 0.62, 0.80), cabMat, { pos: [sx, 1.34, 1.82] }));                   // door skin
      this.group.add(part(flatBox(0.05, 0.05, 0.20), steel, { pos: [sx * 1.02, 1.52, 1.52] }));             // handle
      this.group.add(seam(0.80, dark, { pos: [sx * 1.03, 1.62, 2.22], vertical: true }));                   // door shut line
      // mirror on an arm
      this.group.add(part(cyl(0.02, 0.02, 0.26, 6), steel, { pos: [sx * 1.12, 1.98, 2.42], rot: [0, 0, sx * 0.5] }));
      this.group.add(part(flatBox(0.04, 0.24, 0.14), dark, { pos: [sx * 1.22, 2.06, 2.42] }));
    }
    // bed sides + tailgate with hinges
    for (const sx of [-1.05, 1.05]) {
      this.group.add(part(bevelBox(0.08, 0.56, 3.36), surface("STR02", { local: true, tile: 1.8 }), { pos: [sx, 1.34, -1.00] }));
      this.group.add(rivets(along([sx * 1.045, 1.34, -2.60], [sx * 1.045, 1.34, 0.58], 12), steel));
      for (const tz of [-2.3, -1.0, 0.3]) {
        this.group.add(part(flatBox(0.10, 0.60, 0.06), steel, { pos: [sx, 1.34, tz] })); // stake posts
      }
    }
    this.group.add(part(bevelBox(2.12, 0.54, 0.08), surface("STR02", { local: true, tile: 1.8 }), { pos: [0, 1.33, -2.68] }));
    this.group.add(bolts(along([-0.90, 1.33, -2.73], [0.90, 1.33, -2.73], 7), steel, 0.014));
    // benches in the bed
    for (const tz of [-0.4, -1.7]) {
      this.group.add(bev(1.70, 0.12, 0.42, deck, { pos: [0, 1.30, tz] }));
      for (const sx of [-0.7, 0.7]) this.group.add(part(flatBox(0.07, 0.24, 0.07), steel, { pos: [sx, 1.16, tz] }));
    }
    // fuel tank, battery box, exhaust stack
    this.group.add(part(cyl(0.26, 0.26, 0.86, 12), M.chrome(), { pos: [-0.98, 0.72, -0.20], rot: [Math.PI / 2, 0, Math.PI / 2] }));
    this.group.add(bev(0.34, 0.28, 0.42, dark, { pos: [0.98, 0.78, 0.30] }));
    this.group.add(part(cyl(0.07, 0.07, 1.90, 8), M.chrome(), { pos: [1.02, 2.20, 1.30] }));
    this.group.add(part(cyl(0.09, 0.075, 0.14, 8), dark, { pos: [1.02, 3.20, 1.30] }));
    // bumpers, lights, seats
    this.group.add(bev(2.20, 0.24, 0.16, steel, { pos: [0, 0.84, 3.66] }));
    this.group.add(bev(2.20, 0.20, 0.14, steel, { pos: [0, 0.80, -2.82] }));
    for (const sx of [-0.76, 0.76]) {
      this.group.add(part(cyl(0.15, 0.15, 0.10, 12), steel, { pos: [sx, 1.30, 3.60], rot: [Math.PI / 2, 0, 0] }));
      this.group.add(part(cyl(0.13, 0.13, 0.02, 12), emissive(0xffeec2, 0.9), { pos: [sx, 1.30, 3.655], rot: [Math.PI / 2, 0, 0], shadow: false }));
      this.group.add(part(flatBox(0.16, 0.09, 0.03), emissive(0xcc2211, 0.7), { pos: [sx, 1.10, -2.90], shadow: false }));
      this.group.add(bev(0.52, 0.16, 0.50, surface("CRV06", { local: true, tile: 0.8 }), { pos: [sx * 0.66, 1.44, 1.90] }));
      this.group.add(part(bevelBox(0.52, 0.60, 0.12), surface("CRV06", { local: true, tile: 0.8 }), { pos: [sx * 0.66, 1.76, 1.62], rot: [0.18, 0, 0] }));
    }
    this.group.add(part(flatBox(0.30, 0.12, 0.02), M.hazard(), { pos: [0, 0.96, -2.87], shadow: false }));

    this.addWheels([[-1.12, 0.52, 2.10], [1.12, 0.52, 2.10], [-1.12, 0.52, -1.86], [1.12, 0.52, -1.86]], 0.52, 0.36);

    this.seats = [
      { name: "DRIVER", offset: new THREE.Vector3(0.66, 1.78, 1.90), driver: true },
      { name: "CAB PASSENGER", offset: new THREE.Vector3(-0.66, 1.78, 1.90) },
      { name: "BED RIDER A", offset: new THREE.Vector3(0, 1.62, -0.40) },
      { name: "BED RIDER B", offset: new THREE.Vector3(0, 1.62, -1.70) },
    ];
    this.group.position.copy(pos);
    this.group.rotation.y = -0.5;
    shadowed(this.group);
    registerAsset("vehicle truck", this.group, "VEH");
  }
}

// ─────────────────────────────── MECH SUIT ───────────────────────────────
export interface MechPart {
  name: string;
  mat: keyof typeof MATERIALS;
  speed: number;
  armor: number;
  power: number;
}
export const MECH_PARTS = {
  torso: [
    { name: "ASSAULT CORE", mat: "MET02", speed: 0, armor: 20, power: 10 },
    { name: "WARDEN PLATE", mat: "MET01", speed: -1, armor: 45, power: 0 },
    { name: "SAPPER FRAME", mat: "MET03", speed: 1, armor: 5, power: 20 },
  ] as MechPart[],
  arms: [
    { name: "PILEBUNKER FISTS", mat: "MET05", speed: 0, armor: 10, power: 40 },
    { name: "CANNON ARMS", mat: "MET06", speed: 0, armor: 15, power: 60 },
    { name: "RIPPER DRILLS", mat: "MET07", speed: 0, armor: 5, power: 50 },
  ] as MechPart[],
  legs: [
    { name: "WALKER LEGS", mat: "MET01", speed: 0, armor: 20, power: 0 },
    { name: "SPRINTER LEGS", mat: "MET03", speed: 2.5, armor: 5, power: 0 },
    { name: "SIEGE TREADS", mat: "MET05", speed: -1.5, armor: 35, power: 10 },
  ] as MechPart[],
};

export class Mech {
  group = new THREE.Group();
  occupied = false;
  stride = 0;
  parts = { torso: 0, arms: 0, legs: 0 };
  private torsoSkins: THREE.Mesh[] = [];
  private armSkins: THREE.Mesh[] = [];
  private legSkins: THREE.Mesh[] = [];

  constructor(pos: THREE.Vector3) {
    const steel = M.steel();
    const dark = M.darkSteel();
    const pipe = M.pipes();
    const hazard = M.hazard();

    // ── legs: hip yoke, thigh, hydraulic ram, shin, foot ──
    for (const sx of [-1, 1] as const) {
      const g = new THREE.Group();
      g.position.set(sx * 0.76, 0, 0);
      g.add(part(cyl(0.24, 0.24, 0.42, 10), dark, { pos: [0, 2.16, 0], rot: [0, 0, Math.PI / 2] }));
      const thigh = bev(0.62, 1.10, 0.80, surface("MET01", { local: true, tile: 1.4 }), { pos: [0, 1.60, 0] });
      this.legSkins.push(thigh);
      g.add(thigh);
      g.add(part(flatBox(0.11, 0.86, 0.11), pipe, { pos: [sx * 0.36, 1.58, 0.30] }));
      g.add(part(cyl(0.038, 0.038, 0.60, 6), M.chrome(), { pos: [sx * 0.36, 1.02, 0.30] }));
      g.add(part(cyl(0.19, 0.19, 0.50, 10), dark, { pos: [0, 1.00, 0], rot: [0, 0, Math.PI / 2] }));
      const shin = bev(0.56, 0.92, 0.68, surface("MET01", { local: true, tile: 1.4 }), { pos: [0, 0.56, 0] });
      this.legSkins.push(shin);
      g.add(shin);
      g.add(part(bevelBox(0.60, 0.56, 0.12), steel, { pos: [0, 0.62, 0.36] }));
      g.add(bolts(perimeter(0.48, 0.44, 0.07, 0.08, 3), steel, 0.014));
      g.add(bev(0.72, 0.20, 1.16, M.tread(), { pos: [0, 0.10, 0.14] }));
      for (const tz of [-0.22, 0.18, 0.56]) g.add(part(flatBox(0.68, 0.06, 0.10), dark, { pos: [0, 0.01, tz], shadow: false }));
      g.add(seam(0.9, dark, { pos: [0, 1.60, 0.401], vertical: true }));
      this.group.add(g);
    }

    // ── torso: core, cockpit canopy, shoulders, back pack ──
    const torso = bev(2.10, 1.70, 1.42, surface("MET02", { local: true, tile: 1.6 }), { pos: [0, 3.20, 0] });
    this.torsoSkins.push(torso);
    this.group.add(torso);
    this.group.add(part(bevelBox(2.16, 0.30, 1.48), hazard, { pos: [0, 3.86, 0] }));
    this.group.add(part(cyl(0.30, 0.30, 0.42, 10), dark, { pos: [0, 2.42, 0] })); // waist
    this.group.add(seam(2.0, dark, { pos: [0, 3.00, 0.712] }));
    this.group.add(bolts(perimeter(1.9, 1.5, 0.712, 0.12, 5), steel, 0.017));
    // canopy: frame, glass, hinge, grab handle
    this.group.add(part(bevelBox(1.14, 0.78, 0.10), steel, { pos: [0, 3.46, 0.72] }));
    this.group.add(part(flatBox(0.98, 0.62, 0.03), M.glass(), { pos: [0, 3.46, 0.782], shadow: false }));
    this.group.add(part(cyl(0.03, 0.03, 1.10, 6), steel, { pos: [0, 3.86, 0.74], rot: [0, 0, Math.PI / 2] }));
    this.group.add(part(flatBox(0.28, 0.04, 0.06), steel, { pos: [0.44, 3.10, 0.80] }));
    this.group.add(part(cyl(0.055, 0.055, 0.05, 10), emissive(0x55b6ff, 2.6), { pos: [0, 4.10, 0.42], rot: [Math.PI / 2, 0, 0], shadow: false }));
    // back pack with radiator vents and exhaust
    this.group.add(bev(1.50, 1.10, 0.50, pipe, { pos: [0, 3.30, -0.86] }));
    this.group.add(vent(0.52, 0.62, steel, dark, { pos: [-0.36, 3.30, -1.12], rot: [0, Math.PI, 0] }));
    this.group.add(vent(0.52, 0.62, steel, dark, { pos: [0.36, 3.30, -1.12], rot: [0, Math.PI, 0] }));
    for (const sx of [-0.5, 0.5]) this.group.add(part(cyl(0.09, 0.11, 0.60, 8), dark, { pos: [sx, 4.10, -0.90], rot: [-0.2, 0, 0] }));

    // ── arms: shoulder ball, pauldron, upper, elbow, forearm, fist ──
    for (const sx of [-1, 1] as const) {
      this.group.add(part(cyl(0.28, 0.28, 0.46, 10), dark, { pos: [sx * 1.14, 3.62, 0], rot: [0, 0, Math.PI / 2] }));
      const pauld = part(bevelBox(0.72, 0.56, 0.92), surface("MET05", { local: true, tile: 1.3 }), { pos: [sx * 1.42, 3.74, 0], rot: [0, 0, sx * 0.12] });
      this.armSkins.push(pauld);
      this.group.add(pauld);
      const upper = bev(0.50, 1.10, 0.62, surface("MET05", { local: true, tile: 1.3 }), { pos: [sx * 1.52, 3.00, 0] });
      this.armSkins.push(upper);
      this.group.add(upper);
      this.group.add(part(cyl(0.17, 0.17, 0.44, 8), dark, { pos: [sx * 1.52, 2.42, 0], rot: [0, 0, Math.PI / 2] }));
      const fore = bev(0.46, 0.86, 0.56, surface("MET05", { local: true, tile: 1.3 }), { pos: [sx * 1.52, 2.00, 0] });
      this.armSkins.push(fore);
      this.group.add(fore);
      this.group.add(part(flatBox(0.10, 0.70, 0.10), pipe, { pos: [sx * 1.78, 2.90, 0.22] }));
      this.group.add(bev(0.56, 0.50, 0.60, M.tread(), { pos: [sx * 1.52, 1.50, 0.04] }));
      this.group.add(bolts(perimeter(0.4, 0.7, 0.29, 0.08, 3), steel, 0.015));
    }

    this.group.position.copy(pos);
    shadowed(this.group);
    registerAsset("mech suit", this.group, "MCH");
  }

  get stats() {
    const t = MECH_PARTS.torso[this.parts.torso];
    const a = MECH_PARTS.arms[this.parts.arms];
    const l = MECH_PARTS.legs[this.parts.legs];
    return {
      speed: 5 + t.speed + l.speed,
      armor: t.armor + a.armor + l.armor,
      power: 60 + t.power + a.power + l.power,
    };
  }

  cyclePart(slot: "torso" | "arms" | "legs") {
    this.parts[slot] = (this.parts[slot] + 1) % MECH_PARTS[slot].length;
    const mat = surface(MECH_PARTS[slot][this.parts[slot]].mat, { local: true, tile: 1.5 });
    const target = slot === "torso" ? this.torsoSkins : slot === "arms" ? this.armSkins : this.legSkins;
    for (const m of target) m.material = mat;
  }

  partNames() {
    return {
      torso: MECH_PARTS.torso[this.parts.torso].name,
      arms: MECH_PARTS.arms[this.parts.arms].name,
      legs: MECH_PARTS.legs[this.parts.legs].name,
    };
  }
}
