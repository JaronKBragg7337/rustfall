// Humanoid rig — shared by the player and every NPC.
//
// Built from real proportions (1.78 m default, head ≈ 1/7.5 of height) on a
// pivot hierarchy, so the limbs actually articulate instead of being welded
// boxes. Everything hangs off `hips`; each joint is an empty Group at the
// rotation centre with the limb mesh offset below it, which is what lets the
// walk cycle bend a knee rather than shear a shin.
import * as THREE from "./three";
import type { MaterialKey } from "./constants";
import { surface } from "./surface";

export interface HumanoidStyle {
  jacket: MaterialKey;
  trousers: MaterialKey;
  boots: MaterialKey;
  skin: number;
  accent: number;
  height?: number;
  bulk?: number;
  helmet?: boolean;
  rifle?: boolean;
  backpack?: boolean;
}

export const STYLES: Record<string, HumanoidStyle> = {
  PLAYER: { jacket: "CRV04", trousers: "CRV05", boots: "CRV06", skin: 0xb08561, accent: 0xc25a2c, helmet: true, rifle: true, backpack: true },
  FARMER: { jacket: "CRV05", trousers: "CRV06", boots: "CRV06", skin: 0xc09a72, accent: 0x7fa04a, height: 1.72 },
  SCRAPPER: { jacket: "CRV06", trousers: "CRV05", boots: "CRV03", skin: 0x9d7448, accent: 0xd8a13a, height: 1.75, backpack: true },
  GUARD: { jacket: "CRV04", trousers: "CRV04", boots: "CRV06", skin: 0x8e6a45, accent: 0xb03a2e, height: 1.83, bulk: 1.12, helmet: true, rifle: true },
  SHAMBLER: { jacket: "CRV01", trousers: "CRV02", boots: "CRV06", skin: 0x7c8464, accent: 0x53341f, height: 1.74, bulk: 0.92 },
};

function box(w: number, h: number, d: number, mat: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

// Joint = empty pivot + limb mesh hanging below it, so rotation happens at the
// anatomical centre. Returns the pivot; the child end-pivot is where the next
// segment attaches.
function joint(parent: THREE.Object3D, x: number, y: number, z = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

export class Humanoid {
  readonly group = new THREE.Group();
  readonly hips: THREE.Group;
  readonly chest: THREE.Group;
  readonly head: THREE.Group;
  readonly shoulderL: THREE.Group;
  readonly shoulderR: THREE.Group;
  readonly elbowL: THREE.Group;
  readonly elbowR: THREE.Group;
  readonly hipL: THREE.Group;
  readonly hipR: THREE.Group;
  readonly kneeL: THREE.Group;
  readonly kneeR: THREE.Group;

  private hipRest: number;
  private phase = Math.random() * Math.PI * 2;
  private breathe = Math.random() * Math.PI * 2;
  private s: number; // uniform scale from nominal 1.78 m

  constructor(style: HumanoidStyle) {
    const height = style.height ?? 1.78;
    const bulk = style.bulk ?? 1;
    const s = (this.s = height / 1.78);

    // Garment fabrics tile at ~0.55 m so the weave reads at body scale. The atlas
    // cells are photographic darks (olive canvas, worn leather) that crush to solid
    // black on a figure lit from behind, so they get a gamma lift rather than a tint.
    const cloth = (k: MaterialKey, tile: number, gamma: number, gain = 1) =>
      surface(k, { local: true, tile, macro: 0.35, grime: 0.3, grimeHeight: 0.7, dust: 0.15, gamma, gain });
    const jacket = cloth(style.jacket, 0.55, 0.78, 1.06);
    const trousers = cloth(style.trousers, 0.5, 0.78, 1.04);
    const bootMat = cloth(style.boots, 0.34, 0.8, 1.02);
    const skin = new THREE.MeshStandardMaterial({ color: style.skin, roughness: 0.82, metalness: 0 });
    const accent = new THREE.MeshStandardMaterial({ color: style.accent, roughness: 0.7, metalness: 0.05 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x24211f, roughness: 0.9, metalness: 0.05 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x4a4844, roughness: 0.45, metalness: 0.75 });

    const W = bulk; // lateral scale only — bulk widens, never lengthens

    // ── Pelvis / hips ──
    this.hipRest = 0.92 * s;
    this.hips = joint(this.group, 0, this.hipRest);
    this.hips.add(box(0.32 * W * s, 0.26 * s, 0.21 * W * s, trousers, 0, 0.03 * s));

    // ── Chest + neck + head ──
    this.chest = joint(this.hips, 0, 0.28 * s);
    this.chest.add(box(0.40 * W * s, 0.40 * s, 0.23 * W * s, jacket, 0, 0.14 * s));
    // chest webbing reads as gear at a distance and breaks the slab silhouette
    this.chest.add(box(0.42 * W * s, 0.09 * s, 0.245 * W * s, accent, 0, 0.10 * s));
    this.chest.add(box(0.13 * s, 0.10 * s, 0.09 * s, steel, -0.11 * W * s, 0.22 * s, 0.12 * W * s));
    this.chest.add(box(0.11 * s, 0.11 * s, 0.10 * s, skin, 0, 0.37 * s)); // neck

    this.head = joint(this.chest, 0, 0.44 * s);
    this.head.add(box(0.20 * s, 0.24 * s, 0.21 * s, skin, 0, 0.10 * s));
    this.head.add(box(0.145 * s, 0.05 * s, 0.03 * s, new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.3, metalness: 0.2 }), 0, 0.11 * s, 0.108 * s)); // goggle band
    if (style.helmet) {
      const helm = box(0.235 * s, 0.13 * s, 0.245 * s, steel, 0, 0.20 * s);
      this.head.add(helm);
      this.head.add(box(0.25 * s, 0.03 * s, 0.10 * s, steel, 0, 0.155 * s, 0.10 * s)); // brim
    }

    // ── Arms ──
    const arm = (side: -1 | 1) => {
      const sh = joint(this.chest, side * 0.235 * W * s, 0.29 * s);
      sh.add(box(0.115 * s, 0.30 * s, 0.115 * s, jacket, 0, -0.15 * s)); // upper arm
      sh.add(box(0.14 * s, 0.10 * s, 0.15 * s, jacket, 0, 0.0)); // shoulder pad
      const el = joint(sh, 0, -0.30 * s);
      el.add(box(0.10 * s, 0.27 * s, 0.10 * s, skin, 0, -0.135 * s)); // forearm
      el.add(box(0.105 * s, 0.09 * s, 0.105 * s, accent, 0, -0.02 * s)); // elbow wrap
      el.add(box(0.085 * s, 0.11 * s, 0.07 * s, rubber, 0, -0.31 * s)); // glove
      return { sh, el };
    };
    const aL = arm(-1);
    const aR = arm(1);
    this.shoulderL = aL.sh; this.elbowL = aL.el;
    this.shoulderR = aR.sh; this.elbowR = aR.el;

    // ── Legs ──
    const leg = (side: -1 | 1) => {
      const hp = joint(this.hips, side * 0.105 * W * s, -0.06 * s);
      hp.add(box(0.155 * W * s, 0.40 * s, 0.165 * s, trousers, 0, -0.20 * s)); // thigh
      const kn = joint(hp, 0, -0.40 * s);
      kn.add(box(0.135 * s, 0.38 * s, 0.14 * s, trousers, 0, -0.19 * s)); // shin
      kn.add(box(0.15 * s, 0.06 * s, 0.15 * s, bootMat, 0, -0.03 * s)); // knee pad
      kn.add(box(0.15 * s, 0.11 * s, 0.27 * s, bootMat, 0, -0.43 * s, 0.045 * s)); // boot
      kn.add(box(0.155 * s, 0.035 * s, 0.28 * s, rubber, 0, -0.485 * s, 0.045 * s)); // sole
      return { hp, kn };
    };
    const lL = leg(-1);
    const lR = leg(1);
    this.hipL = lL.hp; this.kneeL = lL.kn;
    this.hipR = lR.hp; this.kneeR = lR.kn;

    // ── Kit ──
    if (style.backpack) {
      this.chest.add(box(0.33 * W * s, 0.38 * s, 0.17 * s, cloth(style.trousers, 0.42, 0.78, 1.04), 0, 0.14 * s, -0.20 * W * s));
      this.chest.add(box(0.10 * s, 0.13 * s, 0.10 * s, accent, 0.10 * s, 0.30 * s, -0.27 * W * s)); // bedroll strap
    }
    if (style.rifle) {
      const r = new THREE.Group();
      r.add(box(0.06 * s, 0.10 * s, 0.42 * s, steel, 0, 0, 0)); // receiver
      r.add(box(0.035 * s, 0.035 * s, 0.40 * s, steel, 0, 0.015 * s, 0.40 * s)); // barrel
      r.add(box(0.05 * s, 0.09 * s, 0.20 * s, rubber, 0, -0.02 * s, -0.28 * s)); // stock
      r.add(box(0.045 * s, 0.16 * s, 0.09 * s, rubber, 0, -0.12 * s, -0.02 * s)); // magazine
      r.add(box(0.045 * s, 0.055 * s, 0.16 * s, steel, 0, 0.075 * s, 0.02 * s)); // optic
      // slung muzzle-down across the back
      r.position.set(-0.19 * W * s, 0.10 * s, -0.20 * W * s);
      r.rotation.set(0.5, 0.35, 0.85);
      this.chest.add(r);
    }

    this.group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  }

  /** Nominal eye height in metres — used to aim cameras and zap bolts. */
  get eyeHeight() { return 1.66 * this.s; }

  /**
   * @param speed    planar speed in m/s
   * @param topSpeed speed that counts as a full-amplitude run
   * @param airborne suspends the stride and tucks the legs
   */
  animate(dt: number, speed: number, topSpeed: number, airborne = false) {
    const gait = THREE.MathUtils.clamp(speed / topSpeed, 0, 1);
    this.breathe += dt * 1.6;

    if (airborne) {
      // tuck: lead knee up, trailing leg extended, arms out for balance
      const k = 0.55;
      this.hipL.rotation.x = THREE.MathUtils.damp(this.hipL.rotation.x, -0.7 * k, 9, dt);
      this.hipR.rotation.x = THREE.MathUtils.damp(this.hipR.rotation.x, 0.35 * k, 9, dt);
      this.kneeL.rotation.x = THREE.MathUtils.damp(this.kneeL.rotation.x, 1.1 * k, 9, dt);
      this.kneeR.rotation.x = THREE.MathUtils.damp(this.kneeR.rotation.x, 0.25 * k, 9, dt);
      this.shoulderL.rotation.x = THREE.MathUtils.damp(this.shoulderL.rotation.x, -0.6, 9, dt);
      this.shoulderR.rotation.x = THREE.MathUtils.damp(this.shoulderR.rotation.x, -0.6, 9, dt);
      this.shoulderL.rotation.z = THREE.MathUtils.damp(this.shoulderL.rotation.z, 0.5, 9, dt);
      this.shoulderR.rotation.z = THREE.MathUtils.damp(this.shoulderR.rotation.z, -0.5, 9, dt);
      this.hips.position.y = THREE.MathUtils.damp(this.hips.position.y, this.hipRest * 1.02, 9, dt);
      return;
    }

    // Stride frequency rises with speed — a run is faster AND longer-strided.
    const freq = 2.1 + gait * 3.4;
    this.phase += dt * freq * Math.PI * (0.35 + gait * 0.65);

    const swing = 0.16 + gait * 0.72;      // hip amplitude
    const armSwing = 0.12 + gait * 0.66;
    const sin = Math.sin(this.phase);
    const cos = Math.cos(this.phase);

    // Legs: contralateral swing; knee only bends on the recovery half-stride.
    this.hipL.rotation.x = -sin * swing;
    this.hipR.rotation.x = sin * swing;
    this.kneeL.rotation.x = Math.max(0, sin) * (0.25 + gait * 1.15);
    this.kneeR.rotation.x = Math.max(0, -sin) * (0.25 + gait * 1.15);

    // Arms counter-swing the legs; elbows stay slightly flexed.
    this.shoulderL.rotation.x = sin * armSwing;
    this.shoulderR.rotation.x = -sin * armSwing;
    this.shoulderL.rotation.z = THREE.MathUtils.damp(this.shoulderL.rotation.z, 0.06, 10, dt);
    this.shoulderR.rotation.z = THREE.MathUtils.damp(this.shoulderR.rotation.z, -0.06, 10, dt);
    this.elbowL.rotation.x = -(0.18 + Math.max(0, sin) * 0.5 * gait);
    this.elbowR.rotation.x = -(0.18 + Math.max(0, -sin) * 0.5 * gait);

    // Body: two bobs per stride, counter-rotating shoulders, forward lean at speed.
    this.applyCarriage(sin, cos, gait);
  }

  private applyCarriage(sin: number, cos: number, gait: number) {
    this.hips.position.y = this.hipRest + Math.abs(sin) * 0.035 * this.s * (0.3 + gait) + Math.sin(this.breathe) * 0.004 * this.s;
    this.hips.rotation.y = cos * 0.10 * gait;
    this.chest.rotation.y = -cos * 0.16 * gait;
    this.chest.rotation.x = gait * 0.14 + Math.sin(this.breathe) * 0.012;
    this.head.rotation.y = cos * 0.05 * gait;
    this.head.rotation.x = -gait * 0.10;
  }

  /**
   * Lurching dead-weight gait: stiff knees, dragging trail leg, arms hanging
   * forward, head lolling. Deliberately arrhythmic — the half-frequency term on
   * the lean makes each pair of steps land differently.
   */
  shamble(dt: number, speed: number) {
    const gait = THREE.MathUtils.clamp(speed / 1.5, 0, 1);
    this.phase += dt * (1.5 + gait * 1.3);
    this.breathe += dt * 0.7;
    const sin = Math.sin(this.phase);
    const cos = Math.cos(this.phase);
    const half = Math.sin(this.phase * 0.5);

    // legs barely leave the ground; the trailing one drags
    this.hipL.rotation.x = -sin * 0.34 * gait - 0.05;
    this.hipR.rotation.x = sin * 0.30 * gait + 0.08;
    this.kneeL.rotation.x = Math.max(0, sin) * 0.28 * gait;
    this.kneeR.rotation.x = 0.14 + Math.max(0, -sin) * 0.16 * gait;

    // arms hang forward and swing loosely, out of phase with the legs
    this.shoulderL.rotation.x = -1.05 + sin * 0.16;
    this.shoulderR.rotation.x = -0.92 - sin * 0.14;
    this.shoulderL.rotation.z = 0.20 + half * 0.07;
    this.shoulderR.rotation.z = -0.24 - half * 0.06;
    this.elbowL.rotation.x = -0.55 + Math.sin(this.phase * 1.3) * 0.12;
    this.elbowR.rotation.x = -0.42 - Math.sin(this.phase * 1.1) * 0.12;

    // hunched carriage, uneven roll, head lolling to one side
    this.hips.position.y = this.hipRest - 0.05 * this.s + Math.abs(sin) * 0.02 * this.s;
    this.hips.rotation.z = half * 0.09;
    this.chest.rotation.x = 0.34 + Math.sin(this.breathe) * 0.03;
    this.chest.rotation.z = -half * 0.13;
    this.chest.rotation.y = cos * 0.10;
    this.head.rotation.z = 0.22 + half * 0.10;
    this.head.rotation.x = 0.18;
  }
}
