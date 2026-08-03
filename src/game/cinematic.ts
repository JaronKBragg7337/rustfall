// Showcase camera — an unattended tour of the wasteland.
//
// The player is set aside and the camera runs a fixed shot list, orbiting each
// landmark while the world layer flips between the game view and the inspection
// view on its own timer. The point is to show the same place twice: once as the
// wasteland, once as the structure underneath it.
//
// Design notes:
//   · Shots are authored, not random. A random flythrough spends most of its time
//     looking at empty dirt; a shot list guarantees every second is on subject.
//   · Movement is a slow orbit with eased ends, so each shot settles rather than
//     stopping dead, and the transition between shots is a damped move rather
//     than a cut — a cut reads as a bug when nobody pressed anything.
//   · The layer flip is deliberately offset from the shot change, so viewers see
//     a layer switch happen mid-shot on the same framing and can read it as the
//     same world rather than a different place.
import * as THREE from "./three";
import { heightAt } from "./terrain";
import type { LayerMode } from "./inspection";

export interface Shot {
  name: string;
  caption: string;
  /** Point the camera looks at, in world XZ; Y is taken from the terrain. */
  at: [number, number];
  /** Height above local ground for the look target. */
  lookHeight: number;
  radius: number;
  height: number;
  /** Orbit start angle and total sweep, radians. */
  from: number;
  sweep: number;
  seconds: number;
}

export const SHOTS: Shot[] = [
  { name: "THE HOMESTEAD", caption: "Two storeys · rooms, stairs, roof assembly", at: [30, 44], lookHeight: 3.2, radius: 19, height: 8.5, from: -1.9, sweep: 1.5, seconds: 11 },
  { name: "HOME BASE", caption: "Walled compound · watchtower · farm plots", at: [-6, -44], lookHeight: 2.6, radius: 26, height: 12, from: 1.2, sweep: -1.7, seconds: 11 },
  { name: "IRON WARDEN", caption: "9.6 m siege walker · scorch arena", at: [62, 62], lookHeight: 5.5, radius: 21, height: 7, from: 2.6, sweep: 1.6, seconds: 10 },
  { name: "CONTAINER YARD", caption: "ISO 20 ft · corrugated, stacked, weathered", at: [31, -29], lookHeight: 1.8, radius: 17, height: 6.5, from: 0.3, sweep: 1.5, seconds: 9 },
  { name: "THE HIGHWAY", caption: "Graded corridor · Armco rail · lane wear", at: [14, 8], lookHeight: 1.2, radius: 15, height: 5, from: -0.6, sweep: 1.2, seconds: 9 },
  { name: "PRE-WAR RUINS", caption: "Collapsed block · exposed rebar", at: [-26, -18], lookHeight: 2.2, radius: 18, height: 7.5, from: 2.1, sweep: -1.4, seconds: 9 },
  { name: "RUST DUNES", caption: "Splat-blended terrain · four surfaces", at: [-58, -50], lookHeight: 1.0, radius: 30, height: 13, from: 0.8, sweep: 1.3, seconds: 9 },
];

const TRANSITION = 1.6;   // seconds of damped travel into each new shot
const LAYER_PERIOD = 6.5; // seconds between world-layer flips

export class Cinematic {
  active = false;
  private shotIdx = 0;
  private t = 0;          // seconds into the current shot
  private layerT = 0;
  private layer: LayerMode = "game";
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();
  private seeded = false;

  onLayer: (m: LayerMode) => void = () => {};

  get shot() { return SHOTS[this.shotIdx]; }
  /** 0..1 through the current shot — drives the HUD progress bar. */
  get progress() { return THREE.MathUtils.clamp(this.t / this.shot.seconds, 0, 1); }

  start(from: LayerMode) {
    this.active = true;
    this.shotIdx = 0;
    this.t = 0;
    this.layerT = 0;
    this.layer = from;
    this.seeded = false;
  }

  stop() {
    this.active = false;
  }

  next() {
    this.shotIdx = (this.shotIdx + 1) % SHOTS.length;
    this.t = 0;
  }

  private sample(shot: Shot, u: number): { pos: THREE.Vector3; look: THREE.Vector3 } {
    // ease the orbit so the shot decelerates into its end instead of stopping dead
    const eased = u * u * (3 - 2 * u);
    const a = shot.from + shot.sweep * eased;
    const groundAt = heightAt(shot.at[0], shot.at[1]);
    const look = new THREE.Vector3(shot.at[0], groundAt + shot.lookHeight, shot.at[1]);
    const px = shot.at[0] + Math.cos(a) * shot.radius;
    const pz = shot.at[1] + Math.sin(a) * shot.radius;
    // keep the camera above the terrain even when the orbit crosses a rise
    const py = Math.max(heightAt(px, pz) + 2.2, groundAt + shot.height);
    return { pos: new THREE.Vector3(px, py, pz), look };
  }

  update(dt: number, cam: THREE.PerspectiveCamera) {
    if (!this.active) return;

    this.t += dt;
    if (this.t >= this.shot.seconds) this.next();

    this.layerT += dt;
    if (this.layerT >= LAYER_PERIOD) {
      this.layerT = 0;
      this.layer = this.layer === "game" ? "inspection" : "game";
      this.onLayer(this.layer);
    }

    const target = this.sample(this.shot, this.progress);
    if (!this.seeded) {
      this.pos.copy(target.pos);
      this.look.copy(target.look);
      this.seeded = true;
    }
    // Damped follow: fast enough to track the orbit, slow enough that the jump to
    // a new shot reads as a deliberate move rather than a cut.
    const rate = this.t < TRANSITION ? 2.2 : 9;
    this.pos.x = THREE.MathUtils.damp(this.pos.x, target.pos.x, rate, dt);
    this.pos.y = THREE.MathUtils.damp(this.pos.y, target.pos.y, rate, dt);
    this.pos.z = THREE.MathUtils.damp(this.pos.z, target.pos.z, rate, dt);
    this.look.x = THREE.MathUtils.damp(this.look.x, target.look.x, rate * 1.4, dt);
    this.look.y = THREE.MathUtils.damp(this.look.y, target.look.y, rate * 1.4, dt);
    this.look.z = THREE.MathUtils.damp(this.look.z, target.look.z, rate * 1.4, dt);

    cam.position.copy(this.pos);
    cam.lookAt(this.look);
    if (Math.abs(cam.fov - 54) > 0.01) {
      cam.fov = THREE.MathUtils.damp(cam.fov, 54, 4, dt);
      cam.updateProjectionMatrix();
    }
  }
}
