// Third-person player rig — doctrine Part 7 reference values.
import * as THREE from "three";
import { matOf } from "./textures";
import { WORLD, registerAsset } from "./constants";

export const FEEL = {
  deadZone: 0.12,
  walk: 4.2,
  run: 7.4,
  turnSpeed: 12,
  lookSens: 0.0042,
  pitchMin: THREE.MathUtils.degToRad(-55),
  pitchMax: THREE.MathUtils.degToRad(70),
  camDist: 6.2,
  camHeight: 1.45,
} as const;

export class Player {
  group = new THREE.Group();
  yaw = 0; // entity yaw — never faked with camera orbit
  camYaw = 0;
  camPitch = 0.25;
  hp = 100;
  maxHp = 100;

  constructor() {
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.32), matOf("CRV04", 1));
    torso.position.y = 1.12;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), matOf("CRV06", 0.5));
    head.position.y = 1.66;
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.75, 0.18), matOf("CRV05", 1));
    legL.position.set(-0.14, 0.38, 0);
    const legR = legL.clone(); legR.position.x = 0.14;
    const pack = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.2), matOf("CRV05", 0.8));
    pack.position.set(0, 1.15, -0.28);
    this.group.add(torso, head, legL, legR, pack);
    this.group.traverse((o) => { o.castShadow = true; });
    this.group.position.set(-6, 0, -30);
    registerAsset("player", this.group, "PLR");
  }

  get position() { return this.group.position; }

  // Camera-relative movement basis (movement plane never pitch-dependent).
  // Verticality is SOLVED: feet rest on the highest support under the body
  // (terrain, floor slabs, stair treads) — that's what makes rooms and levels real.
  static readonly STEP_UP = 0.5; // max ledge the player can walk onto (stair rise)
  static readonly HEADROOM = 1.7;

  move(dt: number, ix: number, iy: number, sprint: boolean, colliders: THREE.Box3[]) {
    const mag = Math.hypot(ix, iy);
    const moving = mag >= FEEL.deadZone;
    if (moving) {
      const nx = mag > 1 ? ix / mag : ix;
      const ny = mag > 1 ? iy / mag : iy;
      const fwd = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd); // right = normalize(cross(U, forward))
      const desired = new THREE.Vector3()
        .addScaledVector(fwd, ny)
        .addScaledVector(right, nx);
      if (desired.lengthSq() > 1e-6) {
        desired.normalize();
        const speed = sprint ? FEEL.run : FEEL.walk;
        const targetYaw = Math.atan2(desired.x, desired.z);
        let dy = targetYaw - this.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        this.yaw += THREE.MathUtils.clamp(dy, -FEEL.turnSpeed * dt, FEEL.turnSpeed * dt);
        this.group.rotation.y = this.yaw;
        const next = this.position.clone().addScaledVector(desired, speed * dt);
        const r = 0.4;
        const feet = this.position.y;
        // blocked only by solids too tall to step onto, within headroom
        const blocked = colliders.some((b) =>
          next.x + r > b.min.x && next.x - r < b.max.x &&
          next.z + r > b.min.z && next.z - r < b.max.z &&
          b.max.y > feet + Player.STEP_UP && b.min.y < feet + Player.HEADROOM
        );
        if (!blocked) { this.position.x = next.x; this.position.z = next.z; }
      }
    }
    // settle vertically onto support under current position
    let support = 0; // terrain is always support at y=0
    const p = this.position;
    for (const b of colliders) {
      if (p.x > b.min.x - 0.15 && p.x < b.max.x + 0.15 && p.z > b.min.z - 0.15 && p.z < b.max.z + 0.15) {
        if (b.max.y <= p.y + Player.STEP_UP && b.max.y > support) support = b.max.y;
      }
    }
    // damped settle — fast drop (gravity), gentle rise (stairs)
    const rate = support < p.y - 0.01 ? 10 : 16;
    p.y = THREE.MathUtils.damp(p.y, support, rate, dt);
    if (Math.abs(p.y - support) < 0.02) p.y = support;
    const L = WORLD.SIZE / 2 - 1.5;
    p.x = THREE.MathUtils.clamp(p.x, -L, L);
    p.z = THREE.MathUtils.clamp(p.z, -L, L);
  }

  updateCamera(cam: THREE.PerspectiveCamera, colliderMeshes: THREE.Object3D[]) {
    this.updateCameraRig(cam, colliderMeshes, this.position, "FOOT");
  }

  // Camera rig works for whatever body the player is wearing (foot / buggy / mech).
  updateCameraRig(cam: THREE.PerspectiveCamera, colliderMeshes: THREE.Object3D[], anchor: THREE.Vector3, mode: "FOOT" | "VEHICLE" | "MECH") {
    const dist = mode === "MECH" ? 11 : mode === "VEHICLE" ? 9 : FEEL.camDist;
    const height = mode === "MECH" ? 3.4 : FEEL.camHeight;
    const pivot = anchor.clone().add(new THREE.Vector3(0, height, 0));
    const offset = new THREE.Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch)
    ).multiplyScalar(dist);
    let target = pivot.clone().add(offset);
    const ray = new THREE.Raycaster(pivot, offset.clone().normalize(), 0, dist + 0.24);
    const hits = ray.intersectObjects(colliderMeshes, true);
    if (hits.length > 0) {
      const d = Math.max(0.65, hits[0].distance - 0.24);
      target = pivot.clone().add(offset.clone().normalize().multiplyScalar(d));
    }
    cam.position.lerp(target, 0.35); // damped — never jumps in one frame
    cam.lookAt(pivot);
  }
}
