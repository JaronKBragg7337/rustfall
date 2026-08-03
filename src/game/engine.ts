// RUSTFALL engine — scene, loop, input, combat, interactions, layer switching.
import * as THREE from "three";
import { makeRng } from "./constants";
import { loadAtlases } from "./textures";
import { buildWorld } from "./world";
import { Robot, Shambler, Helper, Boss, Buggy, Truck, Vehicle, Mech, type Entity } from "./entities";
import { Player, FEEL } from "./player";
import { BuildMode, PIECES } from "./build";
import { InspectionLayer, type LayerMode } from "./inspection";

export interface HudState {
  hp: number;
  bossHp: number | null;
  mode: "FOOT" | "VEHICLE" | "MECH";
  layer: LayerMode;
  building: boolean;
  buildPiece: string;
  buildLegal: boolean;
  buildSnapped: boolean;
  buildReason: string;
  interact: string | null;
  kills: number;
  scrap: number;
  vehicleName: string | null;
  seatName: string | null;
  mechParts: { torso: string; arms: string; legs: string } | null;
  mechStats: { speed: number; armor: number; power: number } | null;
  mechBayOpen: boolean;
  issues: number;
  address: string;
}

interface Ring { obj: THREE.Mesh; t: number; }
interface Pop { obj: THREE.Object3D; t: number; }

export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  private player = new Player();
  private colliders: THREE.Box3[] = [];
  private colliderMeshes: THREE.Object3D[] = [];
  private entities: Entity[] = [];
  private helpers: Helper[] = [];
  private boss!: Boss;
  private vehicles: Vehicle[] = [];
  private currentVehicle: Vehicle | null = null;
  private mech!: Mech;
  private buildMode!: BuildMode;
  private inspection!: InspectionLayer;
  private keys = new Set<string>();
  private mode: "FOOT" | "VEHICLE" | "MECH" = "FOOT";
  private mechBayOpen = false;
  private kills = 0;
  private scrap = 0;
  private lastIssueCount = 0;
  private tracer: THREE.Line | null = null;
  private tracerTtl = 0;
  private rings: Ring[] = [];
  private pops: Pop[] = [];
  private disposed = false;
  private canvas: HTMLCanvasElement;

  onHud: (h: HudState) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init() {
    await loadAtlases();

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.camera = new THREE.PerspectiveCamera(66, 1, 0.1, 600);

    // ── Atmosphere: late amber wasteland light, dust haze ──
    this.scene.fog = new THREE.Fog(0xb89a72, 55, 240);
    this.scene.background = new THREE.Color(0xc7a87e);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(420, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { top: { value: new THREE.Color(0x7e94a6) }, bottom: { value: new THREE.Color(0xd9b98a) } },
        vertexShader: "varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }",
        fragmentShader: "uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h=normalize(vP).y*0.5+0.5; gl_FragColor=vec4(mix(bottom,top,pow(h,0.8)),1.0); }",
      })
    );
    this.scene.add(sky);
    const sun = new THREE.DirectionalLight(0xffe0b3, 2.6);
    sun.position.set(-60, 80, 40);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -80; sun.shadow.camera.right = 80;
    sun.shadow.camera.top = 80; sun.shadow.camera.bottom = -80;
    sun.shadow.camera.far = 260;
    this.scene.add(sun);
    this.scene.add(new THREE.HemisphereLight(0xc8d4e0, 0x8a6f4d, 0.85));

    // ── World ──
    buildWorld({ scene: this.scene, colliders: this.colliders });
    this.scene.add(this.player.group);
    this.colliderMeshes = this.scene.children.filter((o) => o instanceof THREE.Mesh);

    // ── Population: robots, shamblers, helpers, boss, vehicles, mech ──
    const rng = makeRng(4242);
    const spawn = (rMin: number, rMax: number) => {
      const a = rng() * Math.PI * 2;
      const r = rMin + rng() * (rMax - rMin);
      return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
    };
    for (let i = 0; i < 4; i++) {
      const r = new Robot(spawn(18, 70), true); // mean ones roam deep
      r.onFire = (from, to) => {
        this.spawnTracer(from, to, 0xff4422);
        this.player.hp = Math.max(0, this.player.hp - 4); // zap bolt hits home
      };
      this.entities.push(r);
    }
    for (let i = 0; i < 3; i++) {
      const r = new Robot(spawn(6, 16), false); // helpful ones WORK the salvage loop
      r.onDeliver = () => { this.scrap += 1; };
      this.entities.push(r);
    }
    for (const e of this.entities) this.scene.add(e.group);
    for (let i = 0; i < 8; i++) {
      const z = new Shambler(spawn(30, 85));
      this.entities.push(z);
      this.scene.add(z.group);
    }
    const bx = -6, bz = -44;
    this.helpers.push(
      new Helper(new THREE.Vector3(bx - 2, 0, bz + 2), "FARMER", [new THREE.Vector3(bx - 2, 0, bz + 2.5), new THREE.Vector3(bx + 5, 0, bz + 2.5), new THREE.Vector3(bx, 0, bz - 2)], "MARA"),
      new Helper(new THREE.Vector3(bx + 3, 0, bz - 2), "SCRAPPER", [new THREE.Vector3(bx + 3.5, 0, bz - 2.5), new THREE.Vector3(bx - 3, 0, bz - 4), new THREE.Vector3(bx + 1, 0, bz + 1)], "DEKE"),
      new Helper(new THREE.Vector3(bx - 8, 0, bz - 6), "GUARD", [new THREE.Vector3(bx - 8, 0, bz - 8), new THREE.Vector3(bx + 8, 0, bz), new THREE.Vector3(bx + 6, 0, bz + 6)], "ROOK")
    );
    for (const h of this.helpers) this.scene.add(h.group);
    this.boss = new Boss(new THREE.Vector3(62, 0, 62));
    this.scene.add(this.boss.group);
    this.entities.push(this.boss);
    this.vehicles.push(new Buggy(new THREE.Vector3(16, 0, -36)));
    this.vehicles.push(new Truck(new THREE.Vector3(-18, 0, -52)));
    for (const v of this.vehicles) this.scene.add(v.group);
    this.mech = new Mech(new THREE.Vector3(-14, 0, -40));
    this.scene.add(this.mech.group);

    this.buildMode = new BuildMode(this.scene, this.colliders);
    this.inspection = new InspectionLayer(this.scene);

    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.resize);
    this.renderer.setAnimationLoop(this.tick);
  }

  // ── Input: exactly one owner per pointer (doctrine failure law) ──
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code === "KeyL") this.setLayer(this.inspection.mode === "game" ? "inspection" : "game");
    if (e.code === "KeyB") { this.buildMode.active ? this.buildMode.exit() : this.buildMode.enter(); }
    if (e.code === "KeyR" && this.buildMode.active) this.buildMode.rotate();
    if (e.code === "KeyE") this.interact();
    if (e.code === "KeyQ" && this.mode === "VEHICLE" && this.currentVehicle) this.currentVehicle.cycleSeat();
    if (e.code === "KeyM" && this.mode === "MECH") this.mechBayOpen = !this.mechBayOpen;
    if (this.buildMode.active && e.code.startsWith("Digit")) {
      const n = parseInt(e.code.slice(5), 10) - 1;
      if (n >= 0 && n < PIECES.length) this.buildMode.select(n);
    }
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.player.camYaw -= e.movementX * FEEL.lookSens;
    this.player.camPitch = THREE.MathUtils.clamp(
      this.player.camPitch + e.movementY * FEEL.lookSens, FEEL.pitchMin, FEEL.pitchMax
    );
  };
  private onMouseDown = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock();
      return;
    }
    if (e.button !== 0) return;
    if (this.buildMode.active) {
      const res = this.buildMode.place();
      if (res) {
        this.spawnRing(res.position, res.snapped ? 0x33ddff : 0x44ff88); // THE snap effect
        this.pops.push({ obj: res.object, t: 0.16 });
        this.lastIssueCount = this.inspection.mode === "inspection" ? this.inspection.validate().issues.length : this.lastIssueCount;
      }
      return;
    }
    this.attack();
  };
  private onPointerCancel = () => this.keys.clear(); // movement must not survive input termination
  private onBlur = () => this.keys.clear();

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("blur", this.onBlur);
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  // ── Interactions: board a vehicle (driver seat), climb into the mech ──
  private interact() {
    const p = this.player.position;
    if (this.mode === "FOOT") {
      let nearest: Vehicle | null = null;
      let nd = 4.5;
      for (const v of this.vehicles) {
        const d = p.distanceTo(v.group.position);
        if (d < nd) { nd = d; nearest = v; }
      }
      if (nearest) {
        this.mode = "VEHICLE";
        this.currentVehicle = nearest;
        nearest.occupied = true;
        nearest.seatIdx = 0; // always board at the driver seat
        this.player.group.visible = false;
        return;
      }
      if (p.distanceTo(this.mech.group.position) < 4.0) { this.mode = "MECH"; this.mech.occupied = true; this.player.group.visible = false; this.mechBayOpen = true; return; }
    } else if (this.mode === "VEHICLE" && this.currentVehicle) {
      this.player.position.copy(this.currentVehicle.group.position).add(new THREE.Vector3(2.8, 0, 0));
      this.player.group.visible = true;
      this.currentVehicle.occupied = false;
      this.currentVehicle = null;
      this.mode = "FOOT";
    } else if (this.mode === "MECH") {
      this.player.position.copy(this.mech.group.position).add(new THREE.Vector3(2.8, 0, 0));
      this.player.group.visible = true;
      this.mech.occupied = false;
      this.mechBayOpen = false;
      this.mode = "FOOT";
    }
  }

  cycleMechPart(slot: "torso" | "arms" | "legs") {
    this.mech.cyclePart(slot);
  }

  setLayer(mode: LayerMode) {
    this.inspection.setMode(mode);
    if (mode === "inspection") this.lastIssueCount = this.inspection.validate().issues.length;
  }

  // ── Combat: pulse shot on foot, hydraulic punch in the mech ──
  private attack() {
    const origin = this.mode === "MECH" ? this.mech.group.position.clone().add(new THREE.Vector3(0, 3, 0)) : this.camera.position.clone();
    const dir = this.mode === "MECH"
      ? new THREE.Vector3(Math.sin(this.player.camYaw), 0, Math.cos(this.player.camYaw))
      : this.camera.getWorldDirection(new THREE.Vector3());
    const ray = new THREE.Raycaster(origin, dir, 0, this.mode === "MECH" ? 7 : 70);
    let best: { e: Entity; d: number } | null = null;
    for (const e of this.entities) {
      if (e.dead || !e.hostile) continue;
      const hits = ray.intersectObject(e.group, true);
      if (hits.length && (!best || hits[0].distance < best.d)) best = { e, d: hits[0].distance };
    }
    const dmg = this.mode === "MECH" ? this.mech.stats.power : 25;
    const end = origin.clone().addScaledVector(dir, best ? best.d : 30);
    this.spawnTracer(origin, end, this.mode === "MECH" ? 0xffaa33 : 0x9fe8ff);
    if (best) {
      best.e.damage(dmg);
      if (best.e.dead) this.kills += 1;
    }
  }

  private spawnTracer(a: THREE.Vector3, b: THREE.Vector3, color: number) {
    if (this.tracer) this.scene.remove(this.tracer);
    const geo = new THREE.BufferGeometry().setFromPoints([a, b]);
    this.tracer = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.scene.add(this.tracer);
    this.tracerTtl = 0.09;
  }

  // expanding shockwave ring — the visible "snap" when a connector seats
  private spawnRing(pos: THREE.Vector3, color: number) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.55, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(pos).add(new THREE.Vector3(0, 0.12, 0));
    this.scene.add(ring);
    this.rings.push({ obj: ring, t: 0.45 });
  }

  private tick = () => {
    if (this.disposed) return;
    const dt = Math.min(0.05, 1 / 60);
    const k = this.keys;
    const ix = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    const iy = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    const sprint = k.has("ShiftLeft") || k.has("ShiftRight");

    if (this.mode === "FOOT") {
      this.player.move(dt, ix, iy, sprint, this.colliders);
    } else if (this.mode === "VEHICLE" && this.currentVehicle) {
      const v = this.currentVehicle;
      if (v.isDriving) v.drive(dt, iy, -ix); // only the DRIVER seat has the wheel
      this.player.position.copy(v.group.position);
    } else if (this.mode === "MECH") {
      const stats = this.mech.stats;
      const fwd = new THREE.Vector3(Math.sin(this.player.camYaw), 0, Math.cos(this.player.camYaw));
      const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), fwd);
      const d = new THREE.Vector3().addScaledVector(fwd, iy).addScaledVector(right, ix);
      if (d.lengthSq() > 0.01) {
        d.normalize();
        this.mech.group.rotation.y = Math.atan2(d.x, d.z);
        this.mech.group.position.addScaledVector(d, stats.speed * dt);
        this.mech.group.position.y = Math.abs(Math.sin(performance.now() * 0.006)) * 0.18;
      }
      this.player.position.copy(this.mech.group.position);
    }

    // entities think, work, and hunt; contact hurts
    const pp = this.player.position;
    for (const e of this.entities) {
      e.update(dt, pp);
      if (!e.dead && e.hostile && e.group.position.distanceTo(pp) < e.radius + 0.6) {
        this.player.hp = Math.max(0, this.player.hp - dt * (e instanceof Boss ? 30 : 8));
      }
    }
    for (const h of this.helpers) h.update(dt);
    if (this.player.hp <= 0) { // wasteland triage: wake up at base
      this.player.hp = this.player.maxHp;
      this.player.position.set(-6, 0, -38);
    }

    // build ghost follows aim
    let buildLegal = false, buildReason = "", buildSnapped = false;
    if (this.buildMode.active) {
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(0, 0), this.camera);
      const r = this.buildMode.updateGhost(ray);
      buildLegal = r.legal; buildReason = r.reason; buildSnapped = this.buildMode.snapped;
    }

    if (this.tracer) {
      this.tracerTtl -= dt;
      if (this.tracerTtl <= 0) { this.scene.remove(this.tracer); this.tracer = null; }
    }
    // snap effects: rings expand & fade, placed pieces pop into their final scale
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t -= dt;
      const s = 1 + (0.45 - r.t) * 9;
      r.obj.scale.set(s, s, s);
      (r.obj.material as THREE.MeshBasicMaterial).opacity = Math.max(0, r.t / 0.45);
      if (r.t <= 0) { this.scene.remove(r.obj); this.rings.splice(i, 1); }
    }
    for (let i = this.pops.length - 1; i >= 0; i--) {
      const p = this.pops[i];
      p.t -= dt;
      const s = 1 + Math.max(0, p.t) * 0.9;
      p.obj.scale.set(s, s, s);
      if (p.t <= 0) { p.obj.scale.set(1, 1, 1); this.pops.splice(i, 1); }
    }

    // camera anchors to the current body — or the actual SEAT you're riding in
    let anchor: THREE.Vector3;
    if (this.mode === "VEHICLE" && this.currentVehicle) anchor = this.currentVehicle.seatWorld(this.currentVehicle.seatIdx);
    else if (this.mode === "MECH") anchor = this.mech.group.position;
    else anchor = this.player.position;
    this.player.updateCameraRig(this.camera, this.colliderMeshes, anchor, this.mode);

    this.inspection.update(anchor);
    this.renderer.render(this.scene, this.camera);

    // HUD sync
    const bossAlive = !this.boss.dead && (this.boss.engaged || this.boss.hp < this.boss.maxHp);
    let nearestV: Vehicle | null = null;
    let nd = 4.5;
    for (const v of this.vehicles) {
      const d = pp.distanceTo(v.group.position);
      if (d < nd) { nd = d; nearestV = v; }
    }
    const nearMech = this.mode === "FOOT" && pp.distanceTo(this.mech.group.position) < 4.0;
    this.onHud({
      hp: Math.round(this.player.hp),
      bossHp: bossAlive ? Math.round(this.boss.hp) : null,
      mode: this.mode,
      layer: this.inspection.mode,
      building: this.buildMode.active,
      buildPiece: this.buildMode.piece.label,
      buildLegal, buildSnapped, buildReason,
      interact: this.mode !== "FOOT" ? "EXIT" : nearestV ? `BOARD ${nearestV.name}` : nearMech ? "PILOT MECH" : null,
      kills: this.kills,
      scrap: this.scrap,
      vehicleName: this.mode === "VEHICLE" && this.currentVehicle ? this.currentVehicle.name : null,
      seatName: this.mode === "VEHICLE" && this.currentVehicle ? this.currentVehicle.seats[this.currentVehicle.seatIdx].name : null,
      mechParts: this.mode === "MECH" ? this.mech.partNames() : null,
      mechStats: this.mode === "MECH" ? this.mech.stats : null,
      mechBayOpen: this.mechBayOpen,
      issues: this.lastIssueCount,
      address: `${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)}, ${anchor.z.toFixed(1)}`,
    });
  };

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onBlur);
    document.exitPointerLock?.();
    this.renderer.dispose();
  }
}
