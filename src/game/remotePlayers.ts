// Remote players — one name-tagged humanoid per other session in the room.
//
// Reuses the figures.ts humanoid builder with a cyan co-op accent so a drifter
// reads as a PLAYER, not an NPC. Transforms arrive over broadcast at ~10 Hz;
// each drifter keeps a short snapshot buffer and renders 120 ms in the past,
// lerping between the two snapshots bracketing the render time. A drifter
// more than 15 m from its target is snapped — that's a teleport (respawn,
// vehicle exit), and lerping it would drag a rubber band across the map.
//
// Stubbed in v1 (documented in the multiplayer report): camera pitch does not
// move the head, and VEHICLE/MECH modes render the figure standing at the
// vehicle's position rather than posed in a seat. Crouch arrives as a slower
// gait, not a lowered stance.
import * as THREE from "./three";
import { Humanoid, type HumanoidStyle } from "./figures";
import type { RosterEntry, TransformMsg } from "./net";

/** Distinct tint for co-op drifters — cyan accent vs the player's orange. */
const COOP_STYLE: HumanoidStyle = {
  jacket: "CRV03",
  trousers: "CRV05",
  boots: "CRV06",
  skin: 0xa8896a,
  accent: 0x35c7e8,
  helmet: true,
  backpack: true,
};

const INTERP_DELAY = 0.12; // seconds in the past the render time rides
const SNAP_DIST = 15; // meters — beyond this, teleport instead of lerp
const TOP_SPEED = 7.4; // FEEL.run, for gait normalisation

interface Snap {
  at: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  gait: number;
}

/** Floating name plate: canvas text on a sprite, always screen-facing. */
function makeNameTag(name: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext("2d");
  if (!ctx) throw new Error("name tag: 2d context unavailable"); // 6B: fail loud
  ctx.fillStyle = "rgba(6, 10, 12, 0.55)";
  ctx.fillRect(28, 10, 200, 42);
  ctx.strokeStyle = "rgba(53, 199, 232, 0.8)";
  ctx.lineWidth = 2;
  ctx.strokeRect(28, 10, 200, 42);
  ctx.font = "bold 26px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#9fe8ff";
  ctx.fillText(name.slice(0, 12), 128, 32);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(1.9, 0.48, 1);
  return sp;
}

function dampAngle(cur: number, target: number, lambda: number, dt: number): number {
  let d = target - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return cur + d * (1 - Math.exp(-lambda * dt));
}

class RemotePlayer {
  readonly group = new THREE.Group();
  private body: Humanoid;
  private snaps: Snap[] = [];
  private gait = 0;

  constructor(name: string) {
    this.body = new Humanoid(COOP_STYLE);
    this.group.add(this.body.group);
    const tag = makeNameTag(name);
    tag.position.y = 2.3;
    this.group.add(tag);
  }

  push(s: Snap) {
    this.snaps.push(s);
    if (this.snaps.length > 4) this.snaps.shift();
    if (this.snaps.length === 1) {
      // first sighting: start exactly where the drifter is
      this.group.position.set(s.x, s.y, s.z);
      this.group.rotation.y = s.yaw;
    }
  }

  update(dt: number, now: number) {
    if (this.snaps.length === 0) return;
    const rt = now - INTERP_DELAY;
    let a = this.snaps[0];
    let b = this.snaps[this.snaps.length - 1];
    for (let i = 0; i < this.snaps.length - 1; i++) {
      if (this.snaps[i].at <= rt && this.snaps[i + 1].at >= rt) {
        a = this.snaps[i];
        b = this.snaps[i + 1];
        break;
      }
    }
    if (rt >= b.at) a = b; // stale buffer: hold the latest pose
    const span = Math.max(1e-3, b.at - a.at);
    const f = THREE.MathUtils.clamp((rt - a.at) / span, 0, 1);
    const tx = a.x + (b.x - a.x) * f;
    const ty = a.y + (b.y - a.y) * f;
    const tz = a.z + (b.z - a.z) * f;
    let dyaw = b.yaw - a.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    const tyaw = a.yaw + dyaw * f;

    const p = this.group.position;
    if (Math.hypot(tx - p.x, ty - p.y, tz - p.z) > SNAP_DIST) {
      p.set(tx, ty, tz);
      this.group.rotation.y = tyaw;
    } else {
      p.x = THREE.MathUtils.damp(p.x, tx, 14, dt);
      p.y = THREE.MathUtils.damp(p.y, ty, 14, dt);
      p.z = THREE.MathUtils.damp(p.z, tz, 14, dt);
      this.group.rotation.y = dampAngle(this.group.rotation.y, tyaw, 14, dt);
    }
    // gait comes from the sender's own speed — no derivation drift
    this.gait = THREE.MathUtils.damp(this.gait, Math.min(b.gait, TOP_SPEED), 8, dt);
    this.body.animate(dt, this.gait, TOP_SPEED);
  }
}

export class RemotePlayers {
  private players = new Map<string, RemotePlayer>();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  pushTransform(m: TransformMsg, at: number) {
    let rp = this.players.get(m.id);
    if (!rp) {
      rp = new RemotePlayer(m.n || "DRIFTER");
      this.players.set(m.id, rp);
      this.scene.add(rp.group);
    }
    rp.push({ at, x: m.p[0], y: m.p[1], z: m.p[2], yaw: m.y, gait: m.g });
  }

  /** Drop drifters whose session left the roster. */
  syncRoster(roster: RosterEntry[]) {
    const ids = new Set(roster.map((r) => r.id));
    for (const [id, rp] of this.players) {
      if (!ids.has(id)) {
        this.scene.remove(rp.group);
        this.players.delete(id);
      }
    }
  }

  /** Where a drifter's body currently is — used to draw their tracers. */
  positionOf(id: string): THREE.Vector3 | null {
    return this.players.get(id)?.group.position ?? null;
  }

  update(dt: number, now: number) {
    for (const rp of this.players.values()) rp.update(dt, now);
  }

  dispose() {
    for (const rp of this.players.values()) this.scene.remove(rp.group);
    this.players.clear();
  }
}
