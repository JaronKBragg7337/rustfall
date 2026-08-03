// Entities: roaming robots (helpful & mean), dead-creature shamblers, NPC helpers
// with jobs, a giant boss robot, a drivable buggy, and a modular pilotable mech.
import * as THREE from "three";
import { WORLD, makeRng, registerAsset, MATERIALS } from "./constants";
import { matOf } from "./textures";

export interface Entity {
  group: THREE.Group;
  hp: number;
  maxHp: number;
  hostile: boolean;
  dead: boolean;
  radius: number; // contact / hit radius
  update(dt: number, playerPos: THREE.Vector3): void;
  damage(n: number): void;
}

function clampToWorld(v: THREE.Vector3) {
  const L = WORLD.SIZE / 2 - 3;
  v.x = THREE.MathUtils.clamp(v.x, -L, L);
  v.z = THREE.MathUtils.clamp(v.z, -L, L);
}

// ─────────────────────────────── ROBOT ───────────────────────────────
// Robots are REAL: helpful ones work a salvage loop (haul scrap to the base
// stockpile); mean ones patrol, hunt, and fire zap bolts — not just props.
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
  private treadL: THREE.Mesh;
  private treadR: THREE.Mesh;
  // worker state machine
  private job: "toPile" | "picking" | "toBase" | "dropping" = "toPile";
  private jobTimer = 0;
  private carry: THREE.Mesh;
  private pilePos: THREE.Vector3;
  private basePos: THREE.Vector3;
  private fireCooldown = 0;

  constructor(pos: THREE.Vector3, hostile: boolean, pilePos?: THREE.Vector3, basePos?: THREE.Vector3) {
    this.hostile = hostile;
    this.speed = hostile ? 3.1 : 2.6;
    this.pilePos = pilePos ?? new THREE.Vector3(-2.5, 0, -46.5); // scrap pile at base
    this.basePos = basePos ?? new THREE.Vector3(-9, 0, -42);      // stockpile corner
    const bodyMat = matOf(hostile ? "MET06" : "MET02", 2);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.9, 1.4), bodyMat);
    body.position.y = 0.75;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 12, 10), matOf("MET03", 1));
    dome.position.set(0, 1.32, 0.25);
    this.eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: new THREE.Color(hostile ? 0xff2211 : 0x22ff88), emissiveIntensity: 2.2 })
    );
    this.eye.position.set(0, 1.34, 0.58);
    this.treadL = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 1.5), matOf("MET05", 1.5));
    this.treadL.position.set(-0.62, 0.28, 0);
    this.treadR = this.treadL.clone();
    this.treadR.position.x = 0.62;
    const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.7), matOf("MET03", 0.5));
    antenna.position.set(0.3, 1.75, -0.3);
    // the salvage chunk it hauls when working
    this.carry = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.5), matOf("MET01", 0.6));
    this.carry.position.set(0, 1.45, -0.2);
    this.carry.visible = false;
    this.group.add(body, dome, this.eye, this.treadL, this.treadR, antenna, this.carry);
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
    this.pickTarget(pos);
    registerAsset(hostile ? "hostile robot" : "worker robot", this.group, "BOT");
  }

  private pickTarget(from: THREE.Vector3) {
    this.target.set(
      from.x + (this.rng() - 0.5) * 60,
      0,
      from.z + (this.rng() - 0.5) * 60
    );
    clampToWorld(this.target);
  }

  private moveToward(dest: THREE.Vector3, dt: number, sp: number): boolean {
    const p = this.group.position;
    const dir = new THREE.Vector3().subVectors(dest, p);
    dir.y = 0;
    if (dir.length() < 1.1) return true;
    dir.normalize();
    this.group.rotation.y = Math.atan2(dir.x, dir.z);
    p.addScaledVector(dir, sp * dt);
    clampToWorld(p);
    return false;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const distPlayer = p.distanceTo(playerPos);

    if (this.hostile) {
      // patrol → hunt → stop-and-zap
      this.fireCooldown -= dt;
      if (distPlayer < 12) {
        this.group.rotation.y = Math.atan2(playerPos.x - p.x, playerPos.z - p.z);
        if (this.fireCooldown <= 0 && this.onFire) {
          this.fireCooldown = 1.7;
          const from = p.clone().add(new THREE.Vector3(0, 1.34, 0));
          this.onFire(from, playerPos.clone().add(new THREE.Vector3(0, 1.2, 0)));
        }
      } else if (distPlayer < 26) {
        this.moveToward(playerPos, dt, this.speed * 1.5);
      } else if (this.moveToward(this.target, dt, this.speed)) {
        this.pickTarget(p);
      }
    } else {
      // WORK LOOP: haul salvage from the pile to the base stockpile
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
          if (this.jobTimer <= 0) {
            this.carry.visible = false;
            this.job = "toPile";
            this.onDeliver?.();
          }
          break;
      }
    }
    this.treadL.rotation.x += this.speed * dt * 2;
    this.treadR.rotation.x += this.speed * dt * 2;
    this.group.position.y = Math.abs(Math.sin(performance.now() * 0.012 + p.x)) * 0.02;
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.z = Math.PI / 2.2; // tips over, wreck stays as cover
      this.group.position.y = 0.2;
      (this.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = 0;
    }
  }
}

// ─────────────────────────────── ZOMBIE ───────────────────────────────
export class Shambler implements Entity {
  group = new THREE.Group();
  hp = 40; maxHp = 40;
  hostile = true;
  dead = false;
  radius = 0.8;
  private speed = 1.35;
  private phase = Math.random() * 10;

  constructor(pos: THREE.Vector3) {
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.85, 0.4), matOf("CRV01", 1));
    torso.position.y = 1.05;
    torso.rotation.x = 0.28; // dead-weight hunch
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.36, 0.36), matOf("CRV02", 0.5));
    head.position.set(0, 1.62, 0.14);
    const armL = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.7, 0.16), matOf("CRV01", 0.6));
    armL.position.set(-0.42, 1.1, 0.3);
    armL.rotation.x = -1.2; // reaching forward
    const armR = armL.clone(); armR.position.x = 0.42;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.65, 0.2), matOf("CRV06", 1));
    legL.position.set(-0.18, 0.32, 0);
    const legR = legL.clone(); legR.position.x = 0.18;
    this.group.add(torso, head, armL, armR, legL, legR);
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
    registerAsset("shambler", this.group, "ZOM");
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const dir = new THREE.Vector3().subVectors(playerPos, p);
    dir.y = 0;
    const d = dir.length();
    if (d < 42 && d > 0.6) {
      dir.normalize();
      this.group.rotation.y = Math.atan2(dir.x, dir.z);
      p.addScaledVector(dir, this.speed * dt);
    }
    // shamble sway
    this.phase += dt * 4;
    this.group.rotation.z = Math.sin(this.phase) * 0.08;
    clampToWorld(p);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.x = -Math.PI / 2; // collapses
      this.group.position.y = 0.25;
    }
  }
}

// ─────────────────────────────── NPC HELPER ───────────────────────────────
export type Job = "FARMER" | "SCRAPPER" | "GUARD";

export class Helper {
  group = new THREE.Group();
  job: Job;
  private stations: THREE.Vector3[];
  private idx = 0;
  private wait = 0;
  private tag: THREE.Sprite;

  constructor(pos: THREE.Vector3, job: Job, stations: THREE.Vector3[], name: string) {
    this.job = job;
    this.stations = stations;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.32), matOf("CRV05", 1));
    torso.position.y = 1.12;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), matOf("CRV06", 0.5));
    head.position.y = 1.66;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.18), matOf("CRV06", 1));
    legL.position.set(-0.14, 0.38, 0);
    const legR = legL.clone(); legR.position.x = 0.14;
    this.group.add(torso, head, legL, legR);
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
    // name+job tag — the community roster is always visible in game mode
    this.tag = makeTag(`${name} · ${job}`, "#9fd08a");
    this.tag.position.y = 2.15;
    this.group.add(this.tag);
    registerAsset(`npc ${job.toLowerCase()}`, this.group, "NPC");
  }

  update(dt: number) {
    const p = this.group.position;
    if (this.wait > 0) { this.wait -= dt; return; } // working at station
    const dest = this.stations[this.idx];
    const dir = new THREE.Vector3().subVectors(dest, p);
    dir.y = 0;
    if (dir.length() < 0.5) {
      this.wait = 2.5 + Math.random() * 3; // do the job
      this.idx = (this.idx + 1) % this.stations.length;
      return;
    }
    dir.normalize();
    this.group.rotation.y = Math.atan2(dir.x, dir.z);
    p.addScaledVector(dir, 2.0 * dt);
  }
}

export function makeTag(text: string, color = "#ffffff", scale = 1): THREE.Sprite {
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
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true }));
  sp.scale.set((w / h) * 0.5 * scale, 0.5 * scale, 1);
  return sp;
}

// ─────────────────────────────── BOSS ───────────────────────────────
export class Boss implements Entity {
  group = new THREE.Group();
  hp = 500; maxHp = 500;
  hostile = true;
  dead = false;
  radius = 4.2;
  engaged = false;
  private phase = 0;
  private core: THREE.Mesh;

  constructor(pos: THREE.Vector3) {
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.6, 2.2), matOf("MET06", 3));
    pelvis.position.y = 4.6;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(4.4, 3.0, 2.8), matOf("MET06", 4));
    torso.position.y = 7.0;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(4.5, 0.7, 2.85), matOf("MET08", 4));
    stripe.position.y = 8.0;
    const head = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.2, 1.6), matOf("MET03", 2));
    head.position.y = 9.2;
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.28, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff3010, emissiveIntensity: 3 })
    );
    visor.position.set(0, 9.25, 0.82);
    this.core = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 14, 12),
      new THREE.MeshStandardMaterial({ map: matOf("CRV09", 2).map, emissive: 0xffaa22, emissiveIntensity: 1.6 })
    );
    this.core.position.set(0, 6.6, 1.5);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4.4, 1.5), matOf("MET01", 4));
      leg.position.set(sx * 1.5, 2.2, 0);
      const foot = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 2.2), matOf("MET05", 2));
      foot.position.set(sx * 1.5, 0.25, 0.3);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(1.0, 3.6, 1.2), matOf("MET01", 3));
      arm.position.set(sx * 2.9, 6.6, 0);
      const fist = new THREE.Mesh(new THREE.BoxGeometry(1.3, 1.3, 1.3), matOf("MET05", 1.5));
      fist.position.set(sx * 2.9, 4.5, 0);
      this.group.add(leg, foot, arm, fist);
    }
    this.group.add(pelvis, torso, stripe, head, visor, this.core);
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
    registerAsset("BOSS: IRON WARDEN", this.group, "BOS");
  }

  update(dt: number, playerPos: THREE.Vector3) {
    if (this.dead) return;
    const p = this.group.position;
    const d = p.distanceTo(playerPos);
    this.engaged = d < 34;
    this.phase += dt * 2.2;
    if (this.engaged && d > 5.5) {
      const dir = new THREE.Vector3().subVectors(playerPos, p);
      dir.y = 0; dir.normalize();
      this.group.rotation.y = Math.atan2(dir.x, dir.z);
      p.addScaledVector(dir, 1.7 * dt); // heavy stomp approach
      p.y = Math.abs(Math.sin(this.phase)) * 0.35; // ground-shaking gait
    }
    (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.3 + Math.sin(this.phase * 3) * 0.6;
    clampToWorld(p);
  }

  damage(n: number) {
    if (this.dead) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.dead = true;
      this.group.rotation.x = -Math.PI / 3;
      this.group.position.y = 1.2;
      (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.2;
    }
  }
}

// ─────────────────────────────── VEHICLES ───────────────────────────────
// Vehicles are REAL: named seats, driver controls, rideable in any seat.
// Root forward +Z, up +Y, wheel axle +X, steering yaw +Y (doctrine Part 7).
export interface Seat {
  name: string;
  offset: THREE.Vector3; // local position of the seat
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

  seatWorld(i: number): THREE.Vector3 {
    const s = this.seats[i];
    return s.offset.clone().applyQuaternion(this.group.quaternion).add(this.group.position);
  }

  cycleSeat() {
    this.seatIdx = (this.seatIdx + 1) % this.seats.length;
  }

  get isDriving() { return this.seats[this.seatIdx]?.driver === true; }

  drive(dt: number, throttle: number, steer: number) {
    this.speed = THREE.MathUtils.damp(this.speed, throttle * this.topSpeed, 3, dt);
    this.group.rotation.y += steer * dt * 1.8 * Math.sign(this.speed);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.group.quaternion);
    this.group.position.addScaledVector(fwd, this.speed * dt);
    clampToWorld(this.group.position);
    for (const w of this.wheels) w.rotation.x += this.speed * dt * 2.2;
  }

  protected addWheels(positions: Array<[number, number, number]>, radius = 0.42) {
    for (const [sx, sy, sz] of positions) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 0.3, 14), matOf("CRV03", 0.8));
      w.rotation.z = Math.PI / 2;
      w.position.set(sx, sy, sz);
      this.wheels.push(w);
      this.group.add(w);
    }
  }
}

export class Buggy extends Vehicle {
  constructor(pos: THREE.Vector3) {
    super();
    this.name = "DUNE BUGGY";
    this.topSpeed = 16;
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.6, 3.2), matOf("CRV04", 3));
    chassis.position.y = 0.75;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.6, 1.4), matOf("MET02", 2));
    cab.position.set(0, 1.3, -0.3);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 0.1), matOf("CRV08", 1));
    glass.position.set(0, 1.32, 0.45);
    const seatL = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), matOf("CRV06", 0.6));
    seatL.position.set(-0.42, 1.05, -0.3);
    const seatR = seatL.clone(); seatR.position.x = 0.42;
    this.group.add(chassis, cab, glass, seatL, seatR);
    this.addWheels([[-0.95, 0.42, 1.05], [0.95, 0.42, 1.05], [-0.95, 0.42, -1.05], [0.95, 0.42, -1.05]]);
    // two REAL seats: driver right, passenger left
    this.seats = [
      { name: "DRIVER", offset: new THREE.Vector3(0.42, 1.15, -0.3), driver: true },
      { name: "PASSENGER", offset: new THREE.Vector3(-0.42, 1.15, -0.3) },
    ];
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
    registerAsset("vehicle buggy", this.group, "VEH");
  }
}

export class Truck extends Vehicle {
  constructor(pos: THREE.Vector3) {
    super();
    this.name = "FLATBED TRUCK";
    this.topSpeed = 11; // heavier, slower, hauls the crew
    const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 5.6), matOf("MET01", 4));
    chassis.position.y = 0.85;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(2.1, 1.1, 1.6), matOf("STR09", 2));
    cab.position.set(0, 1.65, 1.9);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 0.1), matOf("CRV08", 1));
    glass.position.set(0, 1.8, 2.72);
    const bed = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.5, 3.4), matOf("STR01", 3));
    bed.position.set(0, 1.25, -1.0);
    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 3.4), matOf("STR02", 3));
    railL.position.set(-1.05, 1.6, -1.0);
    const railR = railL.clone(); railR.position.x = 1.05;
    const seatD = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), matOf("CRV06", 0.6));
    seatD.position.set(0.5, 1.45, 1.9);
    const seatP = seatD.clone(); seatP.position.x = -0.5;
    const bench1 = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.3, 0.5), matOf("STR01", 1.5));
    bench1.position.set(0, 1.55, -0.4);
    const bench2 = bench1.clone(); bench2.position.z = -1.7;
    this.group.add(chassis, cab, glass, bed, railL, railR, seatD, seatP, bench1, bench2);
    this.addWheels([[-1.15, 0.5, 2.0], [1.15, 0.5, 2.0], [-1.15, 0.5, -1.9], [1.15, 0.5, -1.9]], 0.5);
    // FOUR real seats: driver, cab passenger, two bed riders
    this.seats = [
      { name: "DRIVER", offset: new THREE.Vector3(0.5, 1.6, 1.9), driver: true },
      { name: "CAB PASSENGER", offset: new THREE.Vector3(-0.5, 1.6, 1.9) },
      { name: "BED RIDER A", offset: new THREE.Vector3(0, 1.8, -0.4) },
      { name: "BED RIDER B", offset: new THREE.Vector3(0, 1.8, -1.7) },
    ];
    this.group.position.copy(pos);
    this.group.rotation.y = -0.5;
    this.group.traverse((o) => { o.castShadow = true; });
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
  parts = { torso: 0, arms: 0, legs: 0 };
  private torsoMesh: THREE.Mesh;
  private armL: THREE.Mesh; private armR: THREE.Mesh;
  private legL: THREE.Mesh; private legR: THREE.Mesh;

  constructor(pos: THREE.Vector3) {
    this.legL = new THREE.Mesh(new THREE.BoxGeometry(0.7, 2.2, 0.9), matOf("MET01", 2));
    this.legL.position.set(-0.75, 1.1, 0);
    this.legR = this.legL.clone(); this.legR.position.x = 0.75;
    this.torsoMesh = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.8, 1.5), matOf("MET02", 2));
    this.torsoMesh.position.y = 3.2;
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.7, 0.2), matOf("CRV08", 1));
    canopy.position.set(0, 3.5, 0.78);
    const lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 8, 8),
      new THREE.MeshStandardMaterial({ color: 0x111111, emissive: 0x44aaff, emissiveIntensity: 2.5 })
    );
    lamp.position.set(0, 4.2, 0.4);
    this.armL = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.9, 0.7), matOf("MET05", 2));
    this.armL.position.set(-1.55, 3.0, 0);
    this.armR = this.armL.clone(); this.armR.position.x = 1.55;
    this.group.add(this.legL, this.legR, this.torsoMesh, canopy, lamp, this.armL, this.armR);
    this.group.position.copy(pos);
    this.group.traverse((o) => { o.castShadow = true; });
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

  // Every part is swappable — the bar re-forges in a new configuration.
  cyclePart(slot: "torso" | "arms" | "legs") {
    this.parts[slot] = (this.parts[slot] + 1) % MECH_PARTS[slot].length;
    const mat = MECH_PARTS[slot][this.parts[slot]].mat;
    if (slot === "torso") this.torsoMesh.material = matOf(mat, 2);
    if (slot === "arms") { this.armL.material = matOf(mat, 2); this.armR.material = matOf(mat, 2); }
    if (slot === "legs") { this.legL.material = matOf(mat, 2); this.legR.material = matOf(mat, 2); }
  }

  partNames() {
    return {
      torso: MECH_PARTS.torso[this.parts.torso].name,
      arms: MECH_PARTS.arms[this.parts.arms].name,
      legs: MECH_PARTS.legs[this.parts.legs].name,
    };
  }
}
