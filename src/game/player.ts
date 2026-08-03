// Third-person player rig: articulated body, accelerated movement, sliding
// collision, gravity, and a damped camera.
//
// What changed from the box-man version, and why:
//   · Velocity, not teleporting. Input drives an acceleration; the body carries
//     momentum. Instant full-speed changes are what make a character feel weightless.
//   · Axis-separated collision. Testing the combined move and rejecting it wholesale
//     means walking into a wall at any angle stops you dead. Resolving X and Z
//     independently makes you slide along it, which is what players expect.
//   · Real gravity with coyote time and jump buffering. Both are small windows that
//     forgive imprecise timing; without them a jump-to-ledge feels broken even when
//     the physics are correct.
import * as THREE from "three";
import { WORLD, registerAsset } from "./constants";
import { Humanoid, STYLES } from "./figures";
import { heightAt } from "./terrain";

export const FEEL = {
  deadZone: 0.12,
  walk: 4.2,
  run: 7.4,
  crouch: 1.9,
  accel: 42,          // m/s² toward the desired velocity
  decel: 30,          // m/s² back to rest
  airControl: 0.28,   // fraction of accel that applies mid-air
  turnSpeed: 14,
  lookSens: 0.0024,
  touchLookSens: 0.0052,
  pitchMin: THREE.MathUtils.degToRad(-62),
  pitchMax: THREE.MathUtils.degToRad(72),
  camDist: 4.6,
  camHeight: 1.52,
  camShoulder: 0.55,  // lateral offset so the body doesn't block the crosshair
  camLag: 12,         // damping rate; higher = tighter
  fov: 68,
  sprintFov: 76,
  gravity: 22,
  jumpSpeed: 6.4,
  coyoteTime: 0.12,   // grace after walking off a ledge
  jumpBuffer: 0.14,   // grace for pressing jump just before landing
  stepUp: 0.52,
  headroom: 1.75,
  radius: 0.34,
} as const;

export interface MoveInput {
  x: number;
  y: number;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
}

export class Player {
  group = new THREE.Group();
  body: Humanoid;
  yaw = 0;
  camYaw = 0;
  camPitch = 0.22;
  hp = 100;
  maxHp = 100;

  velocity = new THREE.Vector3();
  grounded = true;
  crouching = false;
  private coyote = 0;
  private jumpQueued = 0;
  private camPos = new THREE.Vector3();
  private camInit = false;
  private curFov: number = FEEL.fov;

  constructor() {
    this.body = new Humanoid(STYLES.PLAYER);
    this.group.add(this.body.group);
    this.group.position.set(-6, heightAt(-6, -30), -30);
    registerAsset("player", this.group, "PLR");
  }

  get position() { return this.group.position; }
  get eyeHeight() { return this.body.eyeHeight * (this.crouching ? 0.68 : 1); }
  /** 0..1 planar speed relative to a full run — drives the walk cycle. */
  get gait() { return Math.hypot(this.velocity.x, this.velocity.z); }

  /** Highest surface at (x,z) the player could be standing on from height `fromY`. */
  private supportAt(x: number, z: number, fromY: number, colliders: THREE.Box3[]): number {
    let best = heightAt(x, z);
    const r = FEEL.radius;
    for (const b of colliders) {
      if (x + r <= b.min.x || x - r >= b.max.x) continue;
      if (z + r <= b.min.z || z - r >= b.max.z) continue;
      if (b.max.y <= fromY + FEEL.stepUp && b.max.y > best) best = b.max.y;
    }
    return best;
  }

  /** True if a solid occupies the capsule at (x,z) standing on `feet`. */
  private blocked(x: number, z: number, feet: number, colliders: THREE.Box3[]): boolean {
    const r = FEEL.radius;
    const head = feet + (this.crouching ? FEEL.headroom * 0.62 : FEEL.headroom);
    for (const b of colliders) {
      if (x + r <= b.min.x || x - r >= b.max.x) continue;
      if (z + r <= b.min.z || z - r >= b.max.z) continue;
      // Steppable ledges and overhead clearance are not obstructions.
      if (b.max.y <= feet + FEEL.stepUp) continue;
      if (b.min.y >= head) continue;
      return true;
    }
    return false;
  }

  move(dt: number, input: MoveInput, colliders: THREE.Box3[]) {
    const p = this.position;
    const mag = Math.hypot(input.x, input.y);
    const moving = mag >= FEEL.deadZone;
    this.crouching = input.crouch && this.grounded;

    // ── desired planar velocity in camera space ──
    const desired = new THREE.Vector3();
    if (moving) {
      const nx = mag > 1 ? input.x / mag : input.x;
      const ny = mag > 1 ? input.y / mag : input.y;
      const fwd = new THREE.Vector3(Math.sin(this.camYaw), 0, Math.cos(this.camYaw));
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd);
      desired.addScaledVector(fwd, ny).addScaledVector(right, nx);
      const analog = Math.min(1, mag); // gamepad/touch push depth scales speed
      const top = this.crouching ? FEEL.crouch : input.sprint ? FEEL.run : FEEL.walk;
      if (desired.lengthSq() > 1e-6) desired.normalize().multiplyScalar(top * analog);
    }

    // ── accelerate toward it ──
    const rate = (desired.lengthSq() > 1e-6 ? FEEL.accel : FEEL.decel) * (this.grounded ? 1 : FEEL.airControl);
    const dvx = desired.x - this.velocity.x;
    const dvz = desired.z - this.velocity.z;
    const dvLen = Math.hypot(dvx, dvz);
    if (dvLen > 1e-5) {
      const step = Math.min(dvLen, rate * dt);
      this.velocity.x += (dvx / dvLen) * step;
      this.velocity.z += (dvz / dvLen) * step;
    }

    // ── face the direction of travel ──
    if (this.gait > 0.4) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      let dy = targetYaw - this.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      this.yaw += THREE.MathUtils.clamp(dy, -FEEL.turnSpeed * dt, FEEL.turnSpeed * dt);
      this.group.rotation.y = this.yaw;
    }

    // ── jump: buffered press, coyote-time takeoff ──
    if (input.jump) this.jumpQueued = FEEL.jumpBuffer;
    else this.jumpQueued = Math.max(0, this.jumpQueued - dt);
    if (this.jumpQueued > 0 && (this.grounded || this.coyote > 0) && !this.crouching) {
      this.velocity.y = FEEL.jumpSpeed;
      this.grounded = false;
      this.coyote = 0;
      this.jumpQueued = 0;
    }

    // ── horizontal integration, one axis at a time so walls are slid along ──
    // If we somehow start inside a solid (spawned there, or geometry was built
    // around us), every target also tests as blocked and the player is stuck for
    // good. Detect that and let the move through so they can walk back out.
    const feet = p.y;
    const stuck = this.blocked(p.x, p.z, feet, colliders);
    const nx = p.x + this.velocity.x * dt;
    if (stuck || !this.blocked(nx, p.z, feet, colliders)) p.x = nx;
    else this.velocity.x = 0;
    const nz = p.z + this.velocity.z * dt;
    if (stuck || !this.blocked(p.x, nz, feet, colliders)) p.z = nz;
    else this.velocity.z = 0;

    const L = WORLD.SIZE / 2 - 2;
    p.x = THREE.MathUtils.clamp(p.x, -L, L);
    p.z = THREE.MathUtils.clamp(p.z, -L, L);

    // ── vertical ──
    const support = this.supportAt(p.x, p.z, p.y, colliders);
    if (this.velocity.y > 0) {
      // rising: ballistic
      p.y += this.velocity.y * dt;
      this.velocity.y -= FEEL.gravity * dt;
      this.grounded = false;
    } else {
      const fallTo = p.y + this.velocity.y * dt;
      if (fallTo <= support) {
        // landed
        p.y = support;
        this.velocity.y = 0;
        if (!this.grounded) this.grounded = true;
        this.coyote = FEEL.coyoteTime;
      } else if (support >= p.y - 0.001 && this.velocity.y === 0) {
        // stepping up onto a ledge or following rising terrain — ease, don't snap
        p.y = THREE.MathUtils.damp(p.y, support, 16, dt);
        this.grounded = true;
        this.coyote = FEEL.coyoteTime;
      } else {
        p.y = fallTo;
        this.velocity.y -= FEEL.gravity * dt;
        if (this.grounded) this.grounded = false;
        this.coyote = Math.max(0, this.coyote - dt);
      }
    }

    // ── animate ──
    this.body.animate(dt, this.gait, FEEL.run, !this.grounded);
    const crouchY = this.crouching ? -0.34 : 0;
    this.body.group.position.y = THREE.MathUtils.damp(this.body.group.position.y, crouchY, 12, dt);
  }

  /**
   * Damped orbit camera with a shoulder offset, obstruction pull-in, and a
   * speed-linked FOV nudge that reads as acceleration without moving the camera.
   */
  updateCameraRig(
    cam: THREE.PerspectiveCamera,
    colliderMeshes: THREE.Object3D[],
    anchor: THREE.Vector3,
    mode: "FOOT" | "VEHICLE" | "MECH",
    dt: number,
    speed01 = 0
  ) {
    const dist = mode === "MECH" ? 11.5 : mode === "VEHICLE" ? 8.5 : FEEL.camDist;
    const height = mode === "MECH" ? 4.2 : mode === "VEHICLE" ? 2.1 : FEEL.camHeight;
    const shoulder = mode === "FOOT" ? FEEL.camShoulder : 0;

    const pivot = anchor.clone();
    pivot.y += height;
    // shoulder offset is perpendicular to the view direction
    const rightVec = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    pivot.addScaledVector(rightVec, shoulder);

    const offset = new THREE.Vector3(
      -Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      -Math.cos(this.camYaw) * Math.cos(this.camPitch)
    ).multiplyScalar(dist);

    let target = pivot.clone().add(offset);
    const ray = new THREE.Raycaster(pivot, offset.clone().normalize(), 0, dist + 0.3);
    const hits = ray.intersectObjects(colliderMeshes, true);
    if (hits.length > 0) {
      const d = Math.max(0.7, hits[0].distance - 0.3);
      target = pivot.clone().add(offset.clone().normalize().multiplyScalar(d));
    }

    if (!this.camInit) { this.camPos.copy(target); this.camInit = true; }
    // Frame-rate independent damping — lerp(0.35) is only correct at one refresh rate.
    this.camPos.x = THREE.MathUtils.damp(this.camPos.x, target.x, FEEL.camLag, dt);
    this.camPos.y = THREE.MathUtils.damp(this.camPos.y, target.y, FEEL.camLag, dt);
    this.camPos.z = THREE.MathUtils.damp(this.camPos.z, target.z, FEEL.camLag, dt);
    cam.position.copy(this.camPos);
    cam.lookAt(pivot);

    const wantFov = THREE.MathUtils.lerp(FEEL.fov, FEEL.sprintFov, THREE.MathUtils.clamp(speed01, 0, 1));
    this.curFov = THREE.MathUtils.damp(this.curFov, wantFov, 6, dt);
    if (Math.abs(cam.fov - this.curFov) > 0.01) {
      cam.fov = this.curFov;
      cam.updateProjectionMatrix();
    }
  }
}
