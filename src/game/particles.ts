// Particles — one recycled pool plus a wrapping dust field.
//
// Two separate problems, two solutions:
//
//   · Events (muzzle flash, impact sparks, footfall puffs, salvage bursts) are
//     bursty and short-lived, so they come from a fixed pool of points that is
//     never allocated from again at runtime. Dead particles are parked outside
//     the frustum rather than resized out of the buffer — resizing a
//     BufferAttribute every frame is what makes naive particle systems stutter.
//
//   · Airborne dust during a storm is continuous and must surround the viewer
//     wherever they go, so it is a fixed cloud in a box that WRAPS around the
//     camera. A particle that drifts out one face re-enters the opposite one.
//     Constant count, no spawning, and it can never be outrun.
import * as THREE from "./three";

/** Soft round sprite, generated once — no texture download. */
function dotTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const FAR_AWAY = 1e6; // park dead particles here instead of resizing buffers

export interface EmitOpts {
  count?: number;
  speed?: number;
  spread?: number;
  life?: number;
  size?: number;
  color?: THREE.Color | number;
  gravity?: number;
  drag?: number;
  /** Bias direction; omit for an even sphere. */
  dir?: THREE.Vector3;
  cone?: number;
}

export class Particles {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private col: Float32Array;
  private siz: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private maxLife: Float32Array;
  private grav: Float32Array;
  private drag: Float32Array;
  private baseSize: Float32Array;
  private baseCol: Float32Array;
  private cursor = 0;
  readonly points: THREE.Points;

  private capacity: number;

  constructor(scene: THREE.Scene, capacity = 600) {
    this.capacity = capacity;
    this.pos = new Float32Array(capacity * 3).fill(FAR_AWAY);
    this.col = new Float32Array(capacity * 3);
    this.siz = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.baseCol = new Float32Array(capacity * 3);

    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute("color", new THREE.BufferAttribute(this.col, 3));
    this.geo.setAttribute("aSize", new THREE.BufferAttribute(this.siz, 1));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);

    const mat = new THREE.PointsMaterial({
      map: dotTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      size: 0.3,
      sizeAttenuation: true,
    });
    // Per-particle size. PointsMaterial already declares `uniform float size`,
    // so the attribute must NOT share that name — a redefinition fails to
    // compile. Feed gl_PointSize from aSize instead; size attenuation still
    // applies because three multiplies it in afterwards.
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = "attribute float aSize;\n" +
        sh.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = aSize;");
    };
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
  }

  emit(origin: THREE.Vector3, o: EmitOpts = {}) {
    const n = o.count ?? 10;
    const colour = new THREE.Color(o.color ?? 0xffffff);
    const speed = o.speed ?? 2;
    const spread = o.spread ?? 0.1;
    const life = o.life ?? 0.6;
    const size = o.size ?? 0.18;
    const cone = o.cone ?? Math.PI;

    for (let k = 0; k < n; k++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
      const i3 = i * 3;

      this.pos[i3] = origin.x + (Math.random() - 0.5) * spread;
      this.pos[i3 + 1] = origin.y + (Math.random() - 0.5) * spread;
      this.pos[i3 + 2] = origin.z + (Math.random() - 0.5) * spread;

      let dx: number, dy: number, dz: number;
      if (o.dir) {
        // random direction inside a cone about `dir`
        const a = Math.random() * Math.PI * 2;
        const z = Math.cos(cone) + Math.random() * (1 - Math.cos(cone));
        const r = Math.sqrt(Math.max(0, 1 - z * z));
        const t = new THREE.Vector3(r * Math.cos(a), r * Math.sin(a), z);
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), o.dir.clone().normalize());
        t.applyQuaternion(q);
        dx = t.x; dy = t.y; dz = t.z;
      } else {
        const th = Math.random() * Math.PI * 2;
        const ph = Math.acos(2 * Math.random() - 1);
        dx = Math.sin(ph) * Math.cos(th);
        dy = Math.cos(ph);
        dz = Math.sin(ph) * Math.sin(th);
      }
      const sp = speed * (0.55 + Math.random() * 0.9);
      this.vel[i3] = dx * sp;
      this.vel[i3 + 1] = dy * sp;
      this.vel[i3 + 2] = dz * sp;

      this.col[i3] = this.baseCol[i3] = colour.r;
      this.col[i3 + 1] = this.baseCol[i3 + 1] = colour.g;
      this.col[i3 + 2] = this.baseCol[i3 + 2] = colour.b;

      const l = life * (0.7 + Math.random() * 0.6);
      this.life[i] = l;
      this.maxLife[i] = l;
      this.siz[i] = this.baseSize[i] = size * (0.7 + Math.random() * 0.7);
      this.grav[i] = o.gravity ?? -6;
      this.drag[i] = o.drag ?? 1.6;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.capacity; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const i3 = i * 3;
      if (this.life[i] <= 0) {
        this.pos[i3] = FAR_AWAY;
        this.siz[i] = 0;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= k;
      this.vel[i3 + 2] *= k;
      this.vel[i3 + 1] = this.vel[i3 + 1] * k + this.grav[i] * dt;
      this.pos[i3] += this.vel[i3] * dt;
      this.pos[i3 + 1] += this.vel[i3 + 1] * dt;
      this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      // Fade by shrinking AND dimming, both driven from the spawn values so the
      // curve is frame-rate independent, unlike a per-frame decay factor.
      const f = this.life[i] / this.maxLife[i];
      this.siz[i] = this.baseSize[i] * (0.25 + 0.75 * f);
      const dim = f * f;
      this.col[i3] = this.baseCol[i3] * dim;
      this.col[i3 + 1] = this.baseCol[i3 + 1] * dim;
      this.col[i3 + 2] = this.baseCol[i3 + 2] * dim;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // ─── convenience voices ───

  muzzleFlash(at: THREE.Vector3, dir: THREE.Vector3) {
    this.emit(at, { count: 12, dir, cone: 0.5, speed: 7, life: 0.16, size: 0.22, color: 0xffd08a, gravity: -1, drag: 5 });
  }

  impact(at: THREE.Vector3, normalish: THREE.Vector3) {
    this.emit(at, { count: 14, dir: normalish, cone: 1.1, speed: 5, life: 0.42, size: 0.1, color: 0xffb055, gravity: -12, drag: 1.4 });
    this.emit(at, { count: 6, speed: 1.4, life: 0.7, size: 0.3, color: 0x6b5a44, gravity: -1.2, drag: 2.4 });
  }

  footPuff(at: THREE.Vector3, tint = 0x8d7a5e) {
    this.emit(at, { count: 4, speed: 0.7, spread: 0.25, life: 0.55, size: 0.24, color: tint, gravity: -0.7, drag: 3 });
  }

  salvageBurst(at: THREE.Vector3) {
    this.emit(at, { count: 18, speed: 3.2, life: 0.7, size: 0.16, color: 0xffc455, gravity: -9, drag: 1.6 });
  }

  wreck(at: THREE.Vector3) {
    this.emit(at, { count: 26, speed: 4.5, life: 0.9, size: 0.22, color: 0xff8844, gravity: -8, drag: 1.5 });
    this.emit(at, { count: 16, speed: 1.6, life: 1.6, size: 0.5, color: 0x3a3430, gravity: 0.4, drag: 1.1 });
  }
}

/**
 * Wrapping dust cloud. Fixed count in a box centred on the camera; anything that
 * leaves one face re-enters the opposite one, so it costs the same whether the
 * player stands still or drives across the map, and can never be outrun.
 */
export class DustField {
  private geo = new THREE.BufferGeometry();
  private pos: Float32Array;
  private phase: Float32Array;
  readonly points: THREE.Points;
  private mat: THREE.PointsMaterial;
  private box = 46;
  private t = 0;
  intensity = 0;

  private count: number;

  constructor(scene: THREE.Scene, count = 900) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = (Math.random() - 0.5) * this.box;
      this.pos[i * 3 + 1] = Math.random() * 14;
      this.pos[i * 3 + 2] = (Math.random() - 0.5) * this.box;
      this.phase[i] = Math.random() * 6.28;
    }
    this.geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    this.geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
    this.mat = new THREE.PointsMaterial({
      map: dotTexture(),
      // Muted, large and soft. Small bright points read as snow; dust is a haze
      // you see THROUGH, so the grains must be dim and overlapping.
      color: 0x9c7f5c,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      size: 1.5,
      sizeAttenuation: true,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  update(dt: number, camera: THREE.Vector3, windDir: THREE.Vector3) {
    this.mat.opacity = this.intensity * 0.22;
    this.points.visible = this.intensity > 0.02;
    if (!this.points.visible) return;
    this.t += dt;

    const half = this.box / 2;
    const speed = 6 + this.intensity * 16;
    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      // drift with the wind plus a little turbulence
      this.pos[i3] += (windDir.x * speed + Math.sin(this.t * 1.3 + this.phase[i]) * 1.4) * dt;
      this.pos[i3 + 2] += (windDir.z * speed + Math.cos(this.t * 1.1 + this.phase[i]) * 1.4) * dt;
      this.pos[i3 + 1] += Math.sin(this.t * 0.9 + this.phase[i]) * 0.5 * dt;

      // wrap relative to the camera
      let dx = this.pos[i3] - camera.x;
      let dz = this.pos[i3 + 2] - camera.z;
      if (dx > half) dx -= this.box; else if (dx < -half) dx += this.box;
      if (dz > half) dz -= this.box; else if (dz < -half) dz += this.box;
      this.pos[i3] = camera.x + dx;
      this.pos[i3 + 2] = camera.z + dz;

      const dy = this.pos[i3 + 1] - camera.y;
      if (dy > 16) this.pos[i3 + 1] = camera.y - 2;
      else if (dy < -3) this.pos[i3 + 1] = camera.y + 14;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
