// RUSTFALL engine — scene, loop, input, combat, interactions, layer switching.
import * as THREE from "./three";
import { makeRng, QUALITY, IS_TOUCH, SAFE_ZONE, safeZoneFactor, assetRegistry } from "./constants";
import { loadAtlases } from "./textures";
import { buildWorld } from "./world";
import { Robot, Shambler, RunnerShambler, StalkerBot, SporeBoar, Helper, Boss, Buggy, Truck, Vehicle, Mech, type Entity } from "./entities";
import { QUESTS, questComplete, type ActiveQuest } from "./quests";
import { Generator } from "./generator";
import { Player, FEEL, type MoveInput } from "./player";
import { BuildMode, PIECES } from "./build";
import { InspectionLayer, type LayerMode } from "./inspection";
import { Sky } from "./sky";
import { Terrain, heightAt } from "./terrain";
import { TouchControls, type TouchState } from "./touch";
import { Cinematic } from "./cinematic";
import { LootField, LOOTABLE } from "./loot";
import { sceneReport, assetsNear, diffReports, formatReport, type SceneReport, type AssetSnapshot } from "./report";
import { Audio } from "./audio";
import { Particles, DustField } from "./particles";

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
  fuel: number;
  genFuel: number;
  genRunning: boolean;
  genLit: boolean;
  vehicleName: string | null;
  seatName: string | null;
  mechParts: { torso: string; arms: string; legs: string } | null;
  mechStats: { speed: number; armor: number; power: number } | null;
  mechBayOpen: boolean;
  issues: number;
  address: string;
  nearby: Array<{ id: string; role: string; address: string; clearance: number; dist: number }>;
  muted: boolean;
  timeOfDay: number;
  clock: string;
  dust: number;
  timeFrozen: boolean;
  toast: string;
  lootLeft: number;
  firstPerson: boolean;
  devMode: boolean;
  safe: boolean;
  cinematic: boolean;
  shotName: string;
  shotCaption: string;
  shotProgress: number;
  /** Batch 2 item 13: true while a wave-night assault is marching on the base. */
  waveNight: boolean;
  /** Batch 2 item 11: the one active fetch quest, for the HUD card. */
  quest: {
    giver: string;
    job: string;
    title: string;
    objective: string;
    progress: number;
    target: number;
    rewardText: string;
  } | null;
}

interface Ring { obj: THREE.Mesh; t: number; }
interface Pop { obj: THREE.Object3D; t: number; }

export class Game {
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera!: THREE.PerspectiveCamera;
  // Built in init(), never as a field initializer: field initializers run inside
  // `new Game()`, which is before init() awaits loadAtlases(). A Player built then
  // slices its materials from an empty atlas cache and renders solid black.
  private player!: Player;
  private colliders: THREE.Box3[] = [];
  private climbZones: THREE.Box3[] = [];
  private colliderMeshes: THREE.Object3D[] = [];
  private occluders: THREE.Object3D[] = [];
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
  private nearbyPanel: Array<{ id: string; role: string; address: string; clearance: number; dist: number }> = [];
  private nearbyTimer = 0;
  private tracer: THREE.Line | null = null;
  private tracerTtl = 0;
  private rings: Ring[] = [];
  private pops: Pop[] = [];
  private disposed = false;
  private canvas: HTMLCanvasElement;
  private sky!: Sky;
  private terrain!: Terrain;
  private clock = new THREE.Clock();
  private touch: TouchControls | null = null;
  private actions = { fire: false, jump: false, crouch: false };
  private attackCooldown = 0;
  private firstPerson = false;
  private devMode = false;
  private devManual = false;
  private inSafeZone = false;
  private baseline: SceneReport | null = null;
  private dayLength = 300;   // seconds for a full cycle
  private timeFrozen = false;
  private weatherTimer = 40;
  private dustTarget = 0;
  private cinema = new Cinematic();
  private loot!: LootField;
  private generator!: Generator;
  private toast = "";
  private toastTtl = 0;
  private audio = new Audio();
  private fx!: Particles;
  private dustField!: DustField;
  private stepPhase = 0;
  private wasGrounded = true;
  // ── Batch 2 state ──
  /** Nights elapsed; a wave assaults the base every 3rd night (item 13). */
  private nightIndex = 0;
  private wasNight = false;
  private waveActive = false;
  private waveSet = new Set<Shambler | RunnerShambler>();
  /** The one active fetch quest (item 11). */
  private quest: ActiveQuest | null = null;

  onHud: (h: HudState) => void = () => {};
  onTouch: (t: TouchState | null) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init() {
    await loadAtlases();
    this.player = new Player();

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !QUALITY.mobile,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.maxPixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = QUALITY.mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    // Filmic response — without it the 3+ intensity sun clips every lit face to paper.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.camera = new THREE.PerspectiveCamera(FEEL.fov, 1, 0.1, 1400);

    // ── Atmosphere: low amber sun, dust haze, viewer-tracked shadow rig ──
    this.sky = new Sky(this.scene, {
      shadowRadius: QUALITY.shadowRadius,
      shadowMapSize: QUALITY.shadowMapSize,
    });

    this.fx = new Particles(this.scene, QUALITY.mobile ? 320 : 700);
    this.dustField = new DustField(this.scene, QUALITY.mobile ? 380 : 900);

    // ── World ──
    this.terrain = new Terrain(QUALITY.mobile ? 140 : 220);
    this.scene.add(this.terrain.mesh);
    buildWorld({ scene: this.scene, colliders: this.colliders, climbZones: this.climbZones });

    // Static world geometry, captured BEFORE the player and any actors exist, so
    // line-of-sight tests are not blocked by the shooter or the target themselves.
    this.occluders = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.terrain.mesh) this.occluders.push(o);
    });
    this.occluders.push(this.terrain.mesh); // a hill is cover too

    // ── Loot: promote scenery the registry already knows about ──
    this.loot = new LootField(this.scene);
    {
      const lootRng = makeRng(7717);
      for (const rec of assetRegistry) {
        const spec = LOOTABLE[rec.role];
        if (!spec) continue;
        const b = new THREE.Box3().setFromObject(rec.object);
        if (b.isEmpty()) continue;
        const c = b.getCenter(new THREE.Vector3());
        const amount = Math.round(spec.min + lootRng() * (spec.max - spec.min));
        this.loot.add(new THREE.Vector3(c.x, b.max.y, c.z), spec.label, amount);
      }
    }

    // ── Fuel cans: the generator's diet, scattered with their own seed ──
    {
      const fuelRng = makeRng(9917);
      const cans = QUALITY.mobile ? 5 : 8;
      for (let i = 0; i < cans; i++) {
        const a = fuelRng() * Math.PI * 2;
        const r = 15 + fuelRng() * 65;
        const x = Math.cos(a) * r;
        const z = Math.sin(a) * r;
        this.loot.addFuelCan(new THREE.Vector3(x, heightAt(x, z), z));
      }
      // two cans just outside the base gate, so the fuel loop is discoverable
      // on the first walk out rather than after an hour of scavenging
      this.loot.addFuelCan(new THREE.Vector3(4.5, heightAt(4.5, -40), -40));
      this.loot.addFuelCan(new THREE.Vector3(5.5, heightAt(5.5, -49), -49));
    }

    this.scene.add(this.player.group);
    // Every mesh in the scene, not just top-level ones — the old filter missed
    // everything nested in a Group, so the camera clipped through most of the world.
    this.colliderMeshes = [];
    this.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && o !== this.terrain.mesh) this.colliderMeshes.push(o);
    });

    // ── Population: robots, shamblers, helpers, boss, vehicles, mech ──
    const rng = makeRng(4242);
    const spawn = (rMin: number, rMax: number) => {
      const a = rng() * Math.PI * 2;
      const r = rMin + rng() * (rMax - rMin);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      return new THREE.Vector3(x, heightAt(x, z), z);
    };
    for (let i = 0; i < 4; i++) {
      const r = new Robot(spawn(18, 70), true); // mean ones roam deep
      r.onFire = (from, to) => {
        // Cover has to actually work. Without this the bolt ignored geometry and
        // hit you through walls, so hiding indoors did nothing.
        const clear = this.lineOfSight(from, to);
        this.spawnTracer(from, clear.point, clear.hit ? 0x996655 : 0xff4422);
        this.audio.enemyShot();
        this.fx.muzzleFlash(from, new THREE.Vector3().subVectors(to, from).normalize());
        if (clear.hit) { this.audio.shotBlocked(); this.fx.impact(clear.point, new THREE.Vector3().subVectors(from, to).normalize()); }
        else { this.damagePlayer(4); this.audio.hurt(); }
      };
      this.entities.push(r);
    }
    for (let i = 0; i < 3; i++) {
      const r = new Robot(spawn(6, 16), false); // helpful ones WORK the salvage loop
      r.onDeliver = () => { this.scrap += 1; };
      this.entities.push(r);
    }
    for (const e of this.entities) this.scene.add(e.group);
    // Runner shamblers REPLACE part of the pack rather than adding to it, so
    // mobile keeps its QUALITY.shamblers budget — one in four, rounded up.
    {
      const shamblerCount = QUALITY.shamblers;
      const runnerCount = Math.max(1, Math.round(shamblerCount / 4));
      for (let i = 0; i < shamblerCount; i++) {
        const pos = spawn(30, 85);
        const z = i < runnerCount ? new RunnerShambler(pos, i + 1) : new Shambler(pos);
        if (z instanceof RunnerShambler) z.onAggro = () => this.audio.runnerScreech();
        this.entities.push(z);
        this.scene.add(z.group);
      }
    }
    // Stalkers: long-range snipers working the open ground. Capped at 1–2.
    for (let i = 0; i < (QUALITY.mobile ? 1 : 2); i++) {
      const s = new StalkerBot(spawn(45, 80), 6100 + i * 97);
      s.onCharge = () => this.audio.laserCharge();
      s.onFire = (from, to) => {
        // same cover contract as every other shot: walls stop bolts
        const clear = this.lineOfSight(from, to);
        const dir = new THREE.Vector3().subVectors(to, from).normalize();
        this.spawnTracer(from, clear.point, clear.hit ? 0x885544 : 0xff2222);
        this.audio.laserDischarge();
        this.fx.muzzleFlash(from, dir);
        if (clear.hit) { this.audio.shotBlocked(); this.fx.impact(clear.point, dir.clone().negate()); }
        else { this.damagePlayer(28); this.audio.hurt(); }
      };
      this.entities.push(s);
      this.scene.add(s.group);
    }
    // Feral spore-boars (item 15): 2–3 roaming the fields, none in the sanctuary.
    for (let i = 0; i < (QUALITY.mobile ? 2 : 3); i++) {
      let pos = spawn(30, 80);
      for (let tries = 0; tries < 12 && safeZoneFactor(pos.x, pos.z) > 0; tries++) pos = spawn(30, 80);
      const b = new SporeBoar(pos, 3300 + i * 71);
      b.onSnort = () => this.audio.boarSnort();
      b.onHit = (dir) => {
        // tusk hit: damage plus a real knockdown — the player is thrown
        this.damagePlayer(16);
        this.player.velocity.x += dir.x * 9;
        this.player.velocity.z += dir.z * 9;
        if (this.player.velocity.y < 3.2) this.player.velocity.y = 3.2;
        this.player.grounded = false;
        this.audio.boarImpact();
        this.audio.hurt();
        this.fx.impact(this.player.position.clone().add(new THREE.Vector3(0, 1, 0)), dir.clone().negate());
      };
      this.entities.push(b);
      this.scene.add(b.group);
    }
    const bx = -6, bz = -44;
    this.helpers.push(
      new Helper(new THREE.Vector3(bx - 2, 0, bz + 2), "FARMER", [new THREE.Vector3(bx - 2, 0, bz + 2.5), new THREE.Vector3(bx + 5, 0, bz + 2.5), new THREE.Vector3(bx, 0, bz - 2)], "MARA"),
      new Helper(new THREE.Vector3(bx + 3, 0, bz - 2), "SCRAPPER", [new THREE.Vector3(bx + 3.5, 0, bz - 2.5), new THREE.Vector3(bx - 3, 0, bz - 4), new THREE.Vector3(bx + 1, 0, bz + 1)], "DEKE"),
      new Helper(new THREE.Vector3(bx - 8, 0, bz - 6), "GUARD", [new THREE.Vector3(bx - 8, 0, bz - 8), new THREE.Vector3(bx + 8, 0, bz), new THREE.Vector3(bx + 6, 0, bz + 6)], "ROOK")
    );
    for (const h of this.helpers) this.scene.add(h.group);
    this.boss = new Boss(new THREE.Vector3(62, heightAt(62, 62), 62));
    // only audible when it is actually near you; a 9.6 m walker heard from
    // across the map is noise rather than menace
    this.boss.onStomp = () => {
      if (this.boss.group.position.distanceTo(this.player.position) < 46) this.audio.bossStomp();
    };
    this.scene.add(this.boss.group);
    this.entities.push(this.boss);
    this.vehicles.push(new Buggy(new THREE.Vector3(16, heightAt(16, -36), -36)));
    this.vehicles.push(new Truck(new THREE.Vector3(-18, heightAt(-18, -52), -52)));
    for (const v of this.vehicles) this.scene.add(v.group);
    this.mech = new Mech(new THREE.Vector3(-14, heightAt(-14, -40), -40));
    this.scene.add(this.mech.group);

    // ── Base generator + perimeter floodlights ──
    // One can burns over half a day-cycle — the full night. Poles hug the four
    // inside corners of the scrap wall; phones get two of them, unshadowed.
    {
      const poles: Array<[number, number]> = QUALITY.mobile
        ? [[-11, -49], [-1, -39]]
        : [[-11, -49], [-1, -49], [-11, -39], [-1, -39]];
      this.generator = new Generator(
        new THREE.Vector3(-10.5, heightAt(-10.5, -38.5), -38.5),
        this.dayLength * 0.5,
        poles
      );
      this.generator.addToScene(this.scene);
    }

    this.buildMode = new BuildMode(this.scene, this.colliders);
    this.inspection = new InspectionLayer(this.scene);
    this.cinema.onLayer = (m) => this.setLayer(m);

    // Dev-only handle for the screenshot/inspection harness.
    if (import.meta.env.DEV) {
      (window as unknown as { __rustfall?: unknown }).__rustfall = {
        scene: this.scene, renderer: this.renderer, camera: this.camera,
        player: this.player, game: this, colliders: this.colliders,
      };
    }

    this.bindInput();
    this.resize();
    window.addEventListener("resize", this.resize);
    this.renderer.setAnimationLoop(this.tick);
  }

  // ── Input: exactly one owner per pointer (doctrine failure law) ──
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.audio.resume();
    this.keys.add(e.code);
    if (e.code === "KeyL") this.setLayer(this.inspection.mode === "game" ? "inspection" : "game");
    if (e.code === "KeyV") this.toggleFirstPerson();
    if (e.code === "KeyG") this.toggleDevMode();
    if (e.code === "KeyP") this.toggleCinematic();
    if (e.code === "Escape" && this.cinema.active) this.toggleCinematic();
    if (e.code === "KeyB") this.toggleBuild();
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
    this.look(e.movementX, e.movementY, FEEL.lookSens);
  };
  private onMouseDown = (e: MouseEvent) => {
    this.audio.resume(); // browsers refuse audio until a real gesture
    if (e.button !== 0) return;
    if (!IS_TOUCH && document.pointerLockElement !== this.canvas) {
      this.canvas.requestPointerLock();
      return;
    }
    this.primary();
  };
  private onPointerCancel = () => { this.keys.clear(); this.actions.fire = false; };
  private onBlur = () => { this.keys.clear(); this.actions.fire = false; };

  private look(dx: number, dy: number, sens: number) {
    this.player.camYaw -= dx * sens;
    this.player.camPitch = THREE.MathUtils.clamp(
      this.player.camPitch + dy * sens, FEEL.pitchMin, FEEL.pitchMax
    );
  }

  /** Left click / fire button: place a piece in build mode, otherwise shoot. */
  private primary() {
    if (this.buildMode.active) {
      const res = this.buildMode.place();
      if (res) {
        this.spawnRing(res.position, res.snapped ? 0x33ddff : 0x44ff88); // THE snap effect
        this.audio.build();
        this.pops.push({ obj: res.object, t: 0.16 });
        this.lastIssueCount = this.inspection.mode === "inspection" ? this.inspection.validate().issues.length : this.lastIssueCount;
      }
      return;
    }
    this.attack();
  }

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("mousemove", this.onMouseMove);
    window.addEventListener("mousedown", this.onMouseDown);
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("blur", this.onBlur);
    if (IS_TOUCH) {
      this.touch = new TouchControls(this.canvas);
      this.canvas.addEventListener("pointerdown", () => this.audio.resume(), { passive: true });
      this.touch.onChange = () => this.onTouch(this.touch!.state);
    }
  }

  // ── Public control surface for the on-screen (touch) buttons ──
  setAction(name: "fire" | "jump" | "crouch", down: boolean) {
    if (name === "fire" && down) this.primary();
    this.actions[name] = down;
  }

  /** Brief on-screen confirmation, so an action never happens silently. */
  private say(msg: string, seconds = 2.2) {
    this.toast = msg;
    this.toastTtl = seconds;
  }

  setTimeOfDay(t: number) { this.sky.setTime(t); }
  toggleTimeFrozen() { this.timeFrozen = !this.timeFrozen; }
  setDustStorm(on: boolean) { this.dustTarget = on ? 0.85 : 0; this.weatherTimer = on ? 45 : 90; }

  toggleMute() { this.audio.resume(); this.audio.setMuted(!this.audio.muted); this.audio.ui(); }

  // ── Scene reporting: the machine-readable half of the inspection layer ──

  /** Full structured snapshot: every placed asset plus every detected fault. */
  report(): SceneReport { return sceneReport(); }

  /** Same thing as pasteable text. */
  reportText(): string { return formatReport(sceneReport()); }

  /** Assets around the player, nearest first — what the on-screen panel shows. */
  nearbyAssets(radius = 14, limit = 8): AssetSnapshot[] {
    return assetsNear(this.player.position, radius, limit);
  }

  /**
   * Snapshot now, keep it, and diff a later snapshot against it. This is the
   * regression check: anything that silently moves, disappears or breaks between
   * two points in time shows up instead of being found by playing days later.
   */
  snapshot(): SceneReport { this.baseline = sceneReport(); return this.baseline; }
  diffSinceSnapshot() {
    if (!this.baseline) return null;
    return diffReports(this.baseline, sceneReport());
  }

  pressInteract() { this.interact(); }

  /** Manual dev-mode latch, independent of the inspection layer. */
  toggleDevMode() {
    this.devManual = !this.devManual;
    this.devMode = this.devManual || this.inspection.mode === "inspection";
  }

  toggleFirstPerson() {
    this.firstPerson = !this.firstPerson;
    // The body keeps simulating and casting shadows; it is only hidden from view.
    this.player.group.visible = !this.firstPerson && this.mode === "FOOT";
  }

  /** Hands the camera to the showcase tour, or takes it back. */
  toggleCinematic() {
    if (this.cinema.active) {
      this.cinema.stop();
      this.setLayer("game");
      this.player.group.visible = !this.firstPerson && this.mode === "FOOT";
    } else {
      this.cinema.start(this.inspection.mode);
      this.player.group.visible = true; // the tour should show the figure in frame
      document.exitPointerLock?.();
    }
  }

  nextShot() { if (this.cinema.active) this.cinema.next(); }
  toggleBuild() { if (this.buildMode.active) this.buildMode.exit(); else this.buildMode.enter(); }
  rotatePiece() { if (this.buildMode.active) this.buildMode.rotate(); }
  selectPiece(i: number) { if (this.buildMode.active) this.buildMode.select(i); }
  cycleSeat() { if (this.mode === "VEHICLE" && this.currentVehicle) this.currentVehicle.cycleSeat(); }
  toggleMechBay() { if (this.mode === "MECH") this.mechBayOpen = !this.mechBayOpen; }

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
      const node = this.loot.nearest(p);
      if (node) {
        const got = this.loot.take(node);
        if (node.fuel) {
          this.player.fuel += 1;
          this.say(`+1 FUEL CAN · ⛽ ${this.player.fuel}`);
        } else {
          this.scrap += got;
          this.say(`+${got} SCRAP · ${node.label}`);
        }
        this.audio.pickup();
        this.fx.salvageBurst(new THREE.Vector3(node.pos.x, node.pos.y + 0.5, node.pos.z));
        this.spawnRing(new THREE.Vector3(node.pos.x, node.pos.y + 0.1, node.pos.z), node.fuel ? 0xff5040 : 0xffc455);
        return;
      }
      // Feeding the generator is an E-interaction like everything else — same
      // key, same range test, one owner.
      if (this.generator.near(p)) {
        if (this.player.fuel > 0) {
          this.player.fuel -= 1;
          this.generator.feed();
          this.say(`GENERATOR FUELED · ${this.generator.fuel.toFixed(1)} CANS`);
          this.audio.build();
        } else {
          this.say("GENERATOR IS DRY — FIND FUEL CANS");
        }
        return;
      }
      // Fetch quests (item 11): talk to a base NPC, same E-interaction contract.
      const nh = this.nearestHelper(p);
      if (nh) {
        this.questTalk(nh);
        return;
      }
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

  // ── Fetch quests (item 11): accept, deposit, turn in — all through E ──

  /** Closest base NPC within talking range. */
  private nearestHelper(p: THREE.Vector3, r = 3.2): Helper | null {
    let best: Helper | null = null;
    let bd = r;
    for (const h of this.helpers) {
      const d = Math.hypot(h.group.position.x - p.x, h.group.position.z - p.z);
      if (d < bd) { bd = d; best = h; }
    }
    return best;
  }

  /** What the interact prompt says while standing next to a quest NPC. */
  private questPrompt(h: Helper): string {
    const def = QUESTS[h.job];
    if (!this.quest) return `${h.name}: ACCEPT "${def.title}"`;
    if (this.quest.def.giver !== h.job) return `${h.name} — FINISH ${this.quest.giverName}'S ERRAND FIRST`;
    if (questComplete(this.quest)) return `${h.name}: TURN IN "${def.title}"`;
    const q = this.quest;
    switch (def.kind) {
      case "fuel":
        return this.player.fuel > 0
          ? `${h.name}: DEPOSIT FUEL (${q.progress}/${def.target})`
          : `${h.name}: BRING FUEL CANS (${q.progress}/${def.target})`;
      case "scrap":
        return this.scrap > 0
          ? `${h.name}: DEPOSIT SCRAP (${q.progress}/${def.target})`
          : `${h.name}: BRING SCRAP (${q.progress}/${def.target})`;
      default:
        return `${h.name}: ${q.progress}/${def.target} SHAMBLERS DOWN`;
    }
  }

  /** E pressed next to a helper: accept → deposit → turn in. */
  private questTalk(h: Helper) {
    const def = QUESTS[h.job];
    if (!this.quest) {
      this.quest = { def, giverName: h.name, progress: 0 };
      this.say(`QUEST — ${def.title}: ${def.objective.toUpperCase()} 0/${def.target}`, 3.2);
      this.audio.ui();
      return;
    }
    if (this.quest.def.giver !== h.job) {
      this.say(`FINISH ${this.quest.giverName}'S ERRAND FIRST`);
      return;
    }
    const q = this.quest;
    if (questComplete(q)) {
      if (def.reward.scrap) this.scrap += def.reward.scrap;
      if (def.reward.fuel) this.player.fuel += def.reward.fuel;
      this.say(`QUEST COMPLETE — ${def.rewardText}`);
      this.audio.pickup();
      this.quest = null;
      return;
    }
    // Deposits hand over as much as the player carries in one press; the quest
    // store is separate from the generator tank, so the two never fight.
    if (def.kind === "fuel") {
      if (this.player.fuel <= 0) { this.say("NO FUEL CANS TO GIVE"); return; }
      const n = Math.min(def.target - q.progress, this.player.fuel);
      this.player.fuel -= n;
      q.progress += n;
      this.say(`DEPOSITED ${n} FUEL · ${q.progress}/${def.target}`);
      this.audio.build();
    } else if (def.kind === "scrap") {
      if (this.scrap <= 0) { this.say("NO SCRAP TO GIVE"); return; }
      const n = Math.min(def.target - q.progress, this.scrap);
      this.scrap -= n;
      q.progress += n;
      this.say(`DEPOSITED ${n} SCRAP · ${q.progress}/${def.target}`);
      this.audio.build();
    } else {
      this.say(`${q.progress}/${def.target} — THE NIGHT ISN'T SAFE YET`);
    }
  }

  // ── Wave night (item 13): every 3rd night the horde marches on the base ──

  /**
   * Spawn the wave at the map edge, aimed at the compound. Deterministic: the
   * size, mix and approach bearing all come from an RNG seeded by the night
   * number, so the same save-clock always produces the same assault.
   */
  private startWave() {
    const rng = makeRng(5500 + this.nightIndex * 131);
    const total = QUALITY.mobile ? 4 + Math.floor(rng() * 3) : 6 + Math.floor(rng() * 5);
    const runners = Math.max(1, Math.round(total / 3));
    const baseAng = rng() * Math.PI * 2;
    for (let i = 0; i < total; i++) {
      const a = baseAng + (rng() - 0.5) * 1.1; // a loose arc, not a ring
      const r = 86 + rng() * 8;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const pos = new THREE.Vector3(x, heightAt(x, z), z);
      const zed = i < runners ? new RunnerShambler(pos, 200 + i) : new Shambler(pos);
      zed.assault = true;
      zed.waveGoal.set(
        SAFE_ZONE.x + (rng() - 0.5) * 9, 0,
        SAFE_ZONE.z + (rng() - 0.5) * 9
      );
      if (zed instanceof RunnerShambler) zed.onAggro = () => this.audio.runnerScreech();
      this.entities.push(zed);
      this.scene.add(zed.group);
      this.waveSet.add(zed);
    }
    this.waveActive = true;
    this.audio.waveHorn();
    this.say("WAVE NIGHT — THE HORDE COMES FOR THE BASE", 4);
  }

  /** Dawn or a wiped wave: survivors revert to ordinary shamblers. */
  private endWave() {
    for (const e of this.waveSet) {
      e.assault = false;
      e.slowMul = 1;
      e.veer.set(0, 0, 0);
    }
    this.waveSet.clear();
    this.waveActive = false;
  }

  /**
   * Lit floodlights repel the wave: inside a lamp's pool the horde slows to a
   * creep and is pushed sideways. Written BEFORE the entities move so the same
   * frame's positions respond to the light.
   */
  private applyWaveRepulsion() {
    const lamps = this.generator.lamps();
    const R = 7.5; // repulsion radius, a shade under a pole's useful throw
    for (const s of this.waveSet) {
      let slow = 1, vx = 0, vz = 0;
      if (!s.dead) {
        for (const l of lamps) {
          const dx = s.group.position.x - l.x;
          const dz = s.group.position.z - l.z;
          const d = Math.hypot(dx, dz);
          if (d < R) {
            slow = Math.min(slow, 0.45);
            const w = (1 - d / R) * 6;
            vx += (dx / (d || 1e-4)) * w;
            vz += (dz / (d || 1e-4)) * w;
          }
        }
      }
      s.slowMul = slow;
      s.veer.set(vx, 0, vz);
    }
  }

  setLayer(mode: LayerMode) {
    this.inspection.setMode(mode);
    // Inspecting means standing still reading labels, which is exactly when a
    // shambler kills you. Dev mode rides along with the layer automatically.
    this.devMode = this.devManual || mode === "inspection";
    this.audio.layerFlip();
    if (mode === "inspection") this.lastIssueCount = this.inspection.validate().issues.length;
  }

  // ── Combat: pulse shot on foot, hydraulic punch in the mech ──
  /**
   * Is the straight line from `a` to `b` clear of static world geometry?
   * Returns the impact point so a blocked shot can still draw a tracer that
   * stops at the wall — a bolt that visibly splashes on cover teaches the
   * player that cover works far better than one that simply misses.
   */
  private lineOfSight(a: THREE.Vector3, b: THREE.Vector3): { hit: boolean; point: THREE.Vector3 } {
    const dir = new THREE.Vector3().subVectors(b, a);
    const dist = dir.length();
    if (dist < 1e-4) return { hit: false, point: b.clone() };
    dir.divideScalar(dist);
    const ray = new THREE.Raycaster(a, dir, 0.1, dist - 0.15);
    const hits = ray.intersectObjects(this.occluders, false);
    if (hits.length === 0) return { hit: false, point: b.clone() };
    return { hit: true, point: hits[0].point.clone() };
  }

  /**
   * What the player is standing on, for footstep timbre. Derived from position
   * rather than a raycast: standing clear of grade means a built surface, and
   * the road corridor and rubble belt are known regions.
   */
  private surfaceUnder(p: THREE.Vector3): "dirt" | "metal" | "wood" | "gravel" {
    if (p.y > heightAt(p.x, p.z) + 0.4) return "wood";      // a floor, deck or stair
    if (Math.abs(p.x - 14) < 5.2) return "gravel";           // highway
    if (Math.hypot(p.x - 30, p.z + 52) < 22) return "gravel"; // rubble belt
    return "dirt";
  }

  /** Single funnel for incoming damage, so dev mode and the safe zone hold everywhere. */
  private damagePlayer(amount: number) {
    if (this.devMode) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
  }

  private attack() {
    // Rate limit: without it a click-spam or a held fire button fires every frame,
    // which scales damage with refresh rate.
    if (this.attackCooldown > 0) return;
    this.attackCooldown = this.mode === "MECH" ? 0.62 : 0.17;
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
    if (this.mode === "MECH") this.audio.mechPunch(); else this.audio.playerShot();
    this.fx.muzzleFlash(origin.clone().addScaledVector(dir, 0.9), dir);
    const end = origin.clone().addScaledVector(dir, best ? best.d : 30);
    this.spawnTracer(origin, end, this.mode === "MECH" ? 0xffaa33 : 0x9fe8ff);
    if (best) {
      this.fx.impact(end, dir.clone().negate());
      best.e.damage(dmg);
      if (best.e.dead) {
        this.kills += 1;
        // Guard's Night Watch errand counts shambler kills made after dark —
        // wave-night kills qualify, which is rather the point of the job.
        if (this.quest && this.quest.def.kind === "cull" && !questComplete(this.quest) &&
            this.sky.nightness > 0.4 &&
            (best.e instanceof Shambler || best.e instanceof RunnerShambler)) {
          this.quest.progress += 1;
          if (questComplete(this.quest)) this.say(`NIGHT WATCH DONE — REPORT TO ${this.quest.giverName}`);
        }
        // A kill should leave something behind, or fighting is pure cost.
        this.loot.addDrop(best.e.group.position, 5 + Math.floor(Math.random() * 9));
        this.audio.robotDeath();
        this.fx.wreck(best.e.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
      }
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
    // Real elapsed time, clamped so a tab-switch stall can't teleport anyone
    // through a wall. The old fixed 1/60 made the whole game run at 2.4x on a
    // 144 Hz display.
    const dt = Math.min(0.05, this.clock.getDelta());
    const k = this.keys;

    // Keyboard and touch are summed, so either works and neither is special-cased.
    const t = this.touch?.state;
    let ix = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
    let iy = (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
    let sprint = k.has("ShiftLeft") || k.has("ShiftRight");
    if (t) {
      ix += t.moveX;
      iy += t.moveY;
      sprint = sprint || t.sprint;
    }
    if (this.touch) {
      const look = this.touch.consumeLook();
      if (look.dx || look.dy) this.look(look.dx, look.dy, FEEL.touchLookSens);
    }
    // The showcase tour owns the camera; the player stops taking input so the
    // world keeps living (robots work, shamblers roam) without anyone driving.
    const touring = this.cinema.active;
    const input: MoveInput = {
      x: touring ? 0 : THREE.MathUtils.clamp(ix, -1, 1),
      y: touring ? 0 : THREE.MathUtils.clamp(iy, -1, 1),
      sprint,
      crouch: k.has("ControlLeft") || k.has("KeyC") || this.actions.crouch,
      jump: k.has("Space") || this.actions.jump,
    };
    this.actions.jump = false; // edge-triggered: one press, one jump

    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    if (this.actions.fire && this.mode !== "FOOT") this.attack();

    if (this.mode === "FOOT") {
      this.player.move(dt, input, this.colliders, this.climbZones);
    } else if (this.mode === "VEHICLE" && this.currentVehicle) {
      const v = this.currentVehicle;
      if (v.isDriving) v.drive(dt, iy, -ix); // only the DRIVER seat has the wheel
      this.player.position.copy(v.group.position);
    } else if (this.mode === "MECH") {
      const stats = this.mech.stats;
      const fwd = new THREE.Vector3(Math.sin(this.player.camYaw), 0, Math.cos(this.player.camYaw));
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
      const d = new THREE.Vector3().addScaledVector(fwd, input.y).addScaledVector(right, input.x);
      const mp = this.mech.group.position;
      if (d.lengthSq() > 0.01) {
        d.normalize();
        this.mech.group.rotation.y = Math.atan2(d.x, d.z);
        mp.addScaledVector(d, stats.speed * dt);
        this.mech.stride += stats.speed * dt;
      }
      // the gait bob rides on top of the terrain, not instead of it
      mp.y = heightAt(mp.x, mp.z) + Math.abs(Math.sin(this.mech.stride * 1.9)) * 0.18;
      this.player.position.copy(mp);
    }

    // entities think, work, and hunt; contact hurts
    if (this.waveActive) this.applyWaveRepulsion();
    const pp = this.player.position;
    for (const e of this.entities) {
      e.update(dt, pp);
      if (!e.dead && e.hostile && e.group.position.distanceTo(pp) < e.radius + 0.6) {
        this.damagePlayer(dt * (e instanceof Boss ? 30 : 8));
      }
    }
    for (const h of this.helpers) h.update(dt);
    this.loot.update(dt, pp);
    // The generator burns, lights at dusk, and chugs only within earshot.
    this.generator.update(dt, this.sky.nightness);
    {
      const gd = this.generator.group.position.distanceTo(pp);
      this.audio.setGenerator(this.generator.running, Math.max(0, 1 - gd / 30));
    }

    // Footsteps: advance a phase by distance covered, not by time, so cadence
    // follows speed for free and never drifts out of sync with the walk cycle.
    if (this.mode === "FOOT" && this.player.grounded) {
      const speed = this.player.gait;
      if (speed > 0.6) {
        this.stepPhase += speed * dt;
        const stride = speed > FEEL.walk * 1.15 ? 1.55 : 1.15;
        if (this.stepPhase >= stride) {
          this.stepPhase = 0;
          const surf = this.surfaceUnder(pp);
          this.audio.footstep(surf, speed > FEEL.walk * 1.15);
          if (surf === "dirt" || surf === "gravel") this.fx.footPuff(pp.clone());
        }
      } else {
        this.stepPhase = 0;
      }
      if (!this.wasGrounded) this.audio.footstep(this.surfaceUnder(pp), true); // landing
    }
    this.wasGrounded = this.player.grounded;
    if (this.toastTtl > 0) {
      this.toastTtl -= dt;
      if (this.toastTtl <= 0) this.toast = "";
    }
    // Sanctuary: the compound patches you up, slowly enough that it is a place to
    // retreat to rather than a reason never to leave.
    this.inSafeZone = safeZoneFactor(pp.x, pp.z) > 0;
    if (this.inSafeZone && this.player.hp < this.player.maxHp) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + dt * 6);
    }
    if (this.player.hp <= 0) { // wasteland triage: wake up at base
      this.player.hp = this.player.maxHp;
      this.player.position.set(-6, heightAt(-6, -38), -38);
      this.player.velocity.set(0, 0, 0);
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
    const speed01 = this.mode === "FOOT" ? this.player.gait / FEEL.run : 0;
    if (this.cinema.active) {
      this.cinema.update(dt, this.camera);
    } else if (this.firstPerson && this.mode === "FOOT") {
      this.player.updateFirstPerson(this.camera, anchor, dt, speed01);
    } else {
      this.player.updateCameraRig(this.camera, this.colliderMeshes, anchor, this.mode, dt, speed01);
    }

    // ── time of day & weather ──
    if (!this.timeFrozen) {
      this.sky.setTime(this.sky.timeOfDay + dt / this.dayLength);
    }
    // Wave-night scheduling rides the in-game clock (the same `nightness` the
    // generator reads), never wall time: every 3rd nightfall starts a wave,
    // dawn or a wiped horde ends it.
    {
      const night = this.sky.nightness > 0.5;
      if (night && !this.wasNight) {
        this.nightIndex += 1;
        if (this.nightIndex % 3 === 0) this.startWave();
      } else if (!night && this.wasNight && this.waveActive) {
        this.endWave();
      }
      this.wasNight = night;
      if (this.waveActive) {
        let alive = 0;
        for (const e of this.waveSet) if (!e.dead) alive++;
        if (alive === 0) this.endWave();
      }
    }
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      // Storms are occasional and short relative to clear weather, so they read
      // as an event rather than as the normal state of the world.
      this.dustTarget = Math.random() < 0.32 ? 0.45 + Math.random() * 0.5 : 0;
      this.weatherTimer = this.dustTarget > 0 ? 25 + Math.random() * 25 : 60 + Math.random() * 90;
    }
    if (Math.abs(this.sky.dust - this.dustTarget) > 0.002) {
      this.sky.setDust(THREE.MathUtils.damp(this.sky.dust, this.dustTarget, 0.35, dt));
      this.audio.setWind(this.sky.dust);
    }
    this.renderer.toneMappingExposure = THREE.MathUtils.damp(
      this.renderer.toneMappingExposure, this.sky.exposure, 2, dt);

    this.fx.update(dt);
    this.dustField.intensity = this.sky.dust;
    this.dustField.update(dt, this.camera.position, new THREE.Vector3(0.82, 0, -0.44));

    this.sky.update(anchor);
    this.sky.follow(this.camera.position);
    // The panel is the cheap way to read IDs off a screenshot: text in screen
    // space, never occluded, never needing OCR of a world-space sprite.
    if (this.inspection.mode === "inspection") {
      this.nearbyTimer -= dt;
      if (this.nearbyTimer <= 0) {
        this.nearbyTimer = 0.4;
        this.nearbyPanel = assetsNear(pp, 16, 7).map((a) => ({
          id: a.id, role: a.role, address: a.address, clearance: a.clearance,
          dist: +Math.hypot(a.pos[0] - pp.x, a.pos[2] - pp.z).toFixed(1),
        }));
      }
    } else if (this.nearbyPanel.length) {
      this.nearbyPanel = [];
    }

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
      interact: this.mode !== "FOOT"
        ? "EXIT"
        : (() => {
            const n = this.loot.nearest(pp);
            if (n) return n.fuel ? "TAKE FUEL CAN" : `SEARCH ${n.label}`;
            if (this.generator.near(pp)) {
              return this.player.fuel > 0 ? `FEED GENERATOR ⛽×${this.player.fuel}` : "GENERATOR · NEEDS FUEL";
            }
            const nh = this.nearestHelper(pp);
            if (nh) return this.questPrompt(nh);
            return nearestV ? `BOARD ${nearestV.name}` : nearMech ? "PILOT MECH" : null;
          })(),
      kills: this.kills,
      scrap: this.scrap,
      fuel: this.player.fuel,
      genFuel: Math.round(this.generator.fuel * 10) / 10,
      genRunning: this.generator.running,
      genLit: this.generator.lit,
      vehicleName: this.mode === "VEHICLE" && this.currentVehicle ? this.currentVehicle.name : null,
      seatName: this.mode === "VEHICLE" && this.currentVehicle ? this.currentVehicle.seats[this.currentVehicle.seatIdx].name : null,
      mechParts: this.mode === "MECH" ? this.mech.partNames() : null,
      mechStats: this.mode === "MECH" ? this.mech.stats : null,
      mechBayOpen: this.mechBayOpen,
      issues: this.lastIssueCount,
      nearby: this.inspection.mode === "inspection" ? this.nearbyPanel : [],
      muted: this.audio.muted,
      timeOfDay: this.sky.timeOfDay,
      clock: (() => {
        const mins = Math.round(this.sky.timeOfDay * 1440) % 1440;
        return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
      })(),
      dust: this.sky.dust,
      timeFrozen: this.timeFrozen,
      toast: this.toast,
      lootLeft: this.loot.remaining,
      address: `${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)}, ${anchor.z.toFixed(1)}`,
      firstPerson: this.firstPerson,
      devMode: this.devMode,
      safe: this.inSafeZone,
      cinematic: this.cinema.active,
      shotName: this.cinema.active ? this.cinema.shot.name : "",
      shotCaption: this.cinema.active ? this.cinema.shot.caption : "",
      shotProgress: this.cinema.active ? this.cinema.progress : 0,
      waveNight: this.waveActive,
      quest: this.quest
        ? {
            giver: this.quest.giverName,
            job: this.quest.def.giver,
            title: this.quest.def.title,
            objective: this.quest.def.objective,
            progress: this.quest.progress,
            target: this.quest.def.target,
            rewardText: this.quest.def.rewardText,
          }
        : null,
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
    this.touch?.dispose();
    this.audio.dispose();
    document.exitPointerLock?.();
    this.renderer.dispose();
  }
}
