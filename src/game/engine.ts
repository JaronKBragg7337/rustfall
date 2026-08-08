// RUSTFALL engine — scene, loop, input, combat, interactions, layer switching.
import * as THREE from "./three";
import { makeRng, QUALITY, IS_TOUCH, SAFE_ZONE, safeZoneFactor, assetRegistry, qualitySettings, getQualityPreset, storeQualityPreset, type QualityPreset } from "./constants";
import { loadAtlases } from "./textures";
import { buildWorld } from "./world";
import { Robot, Shambler, RunnerShambler, StalkerBot, SporeBoar, Helper, Trader, Boss, Buggy, Truck, Vehicle, Mech, type Entity, type Job } from "./entities";
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
import { Inventory, type Slot } from "./inventory";
import { WEAPONS, RECIPES, makeRifleProp, makeShotgunProp, type WeaponId } from "./weapons";
import { TRADE_OFFERS, type TradeId } from "./trade";
import { plain } from "./surface";
import { SAVE_VERSION, loadSave, writeSave, clearSave, hasSave, type SaveData } from "./save";
import { NetClient, type EntEntry, type EntSnapshotMsg, type EventMsg, type NetRole, type RosterEntry, type TransformMsg } from "./net";
import { RemotePlayers } from "./remotePlayers";

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
  /** Backpack grid (Batch 2): fixed 12 slots, null = empty. */
  inventory: (Slot | null)[];
  inventoryOpen: boolean;
  /** Workbench crafting menu (Batch 2 item 14). */
  craftOpen: boolean;
  /** SAL's barter panel at the trading post. */
  tradeOpen: boolean;
  /** GORETUSK ALPHA health while engaged — drives the nameplate bar. */
  goretusk: { hp: number; max: number } | null;
  /** Contextual hint while standing near a scrap-starved turret. */
  turretHint: string | null;
  /** Equipped weapon, for the HUD badge. */
  weapon: { id: WeaponId; name: string; glyph: string };
  /** True once any craftable gun is owned — shows the mobile WPN button. */
  hasWeapons: boolean;
  /** Active graphics preset (Batch 3 item 17). */
  quality: QualityPreset;
  /** Multiplayer session (null = solo). Powers the players panel. */
  mp: { code: string; role: NetRole; selfId: string; players: RosterEntry[] } | null;
  playersOpen: boolean;
}

interface Ring { obj: THREE.Mesh; t: number; }
interface Pop { obj: THREE.Object3D; t: number; }

/** A sealed outer-ring supply cache: opened once, persists in the save. */
interface CacheState {
  id: string;
  obj: THREE.Object3D | null; // the registered asset, when the world shipped one
  pos: THREE.Vector3;
  opened: boolean;
  marker: THREE.Group;
  scrap: number;
  phase: number;
}

/** A player-placed scrap turret (build mode, role "scrap_turret"). */
interface TurretState {
  obj: THREE.Object3D;
  /** The yaw-able head group (userData.turretHead); falls back to obj if absent. */
  head: THREE.Object3D;
  cooldown: number;
  shots: number;
  /** True once it tried to burn scrap it didn't have — drives the HUD hint. */
  hungry: boolean;
}

/** A player-placed spike trap (build mode, role "spike_trap"). */
interface SpikeState {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  /** Per-target re-trigger cooldown, so a pack crossing gets bled one by one. */
  cooldowns: Map<Entity, number>;
}

/**
 * Cyan shard + halo above an unopened supply cache — the same "interactive"
 * vocabulary as the amber loot diamond, in a colour that reads "sealed supply"
 * rather than "searchable wreckage".
 */
function makeCacheMarker(): THREE.Group {
  const g = new THREE.Group();
  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.16, 0),
    plain(0x9fe8ff, 0.35, 0.2, { emissive: 0x55b6ff, emissiveIntensity: 2.4 })
  );
  const halo = new THREE.Mesh(
    new THREE.RingGeometry(0.28, 0.36, 16),
    new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false })
  );
  halo.rotation.x = -Math.PI / 2;
  g.add(core, halo);
  return g;
}

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
  // ── Backpack / weapons / crafting (items 14 + inventory) ──
  /** Equipped weapon; "pulse" is the always-carried sidearm. */
  private currentWeapon: WeaponId = "pulse";
  /** Gun prop riding the player model, swapped on equip. */
  private weaponProp: THREE.Group | null = null;
  private inventoryOpen = false;
  private craftOpen = false;
  // ── Trader & barter (trading post) ──
  private trader!: Trader;
  private tradeOpen = false;
  // ── Outer ring: mini-boss, sealed caches, player-built defenses ──
  private goretusk: SporeBoar | null = null;
  private caches: CacheState[] = [];
  private turrets: TurretState[] = [];
  private spikes: SpikeState[] = [];
  private defenseScanT = 0;
  private turretHint: string | null = null;
  // ── Save/load (item 16) ──
  /** Wall of the run: autosaves only tick while a run is actually in play. */
  private runStarted = false;
  private saveTimer = 0;
  private static readonly AUTOSAVE_EVERY = 30; // seconds
  // ── Quality preset (item 17) ──
  private quality: QualityPreset = getQualityPreset();
  // ── Multiplayer (wasteland-commons co-op; all inert in solo) ──
  private net: NetClient | null = null;
  private netRole: NetRole | null = null;
  private remotes: RemotePlayers | null = null;
  private playersOpen = false;
  private netSendT = 0;   // transform cadence (10 Hz)
  private netSnapT = 0;   // host entity-snapshot cadence (8 Hz)
  private puppetGraceUntil = 0;
  /** Inbound queues — net callbacks push, tick() drains. Never render off-callback. */
  private transformQueue: TransformMsg[] = [];
  private eventQueue: EventMsg[] = [];
  private latestSnapshot: EntSnapshotMsg | null = null;
  /** Deterministic per-hostile network ids, assigned in seeded spawn order. */
  private netIds = new Map<Entity, string>();
  private netEntities = new Map<string, Entity>();
  /** Latest host snapshot target per entity id (guest side). */
  private netTargets = new Map<string, { x: number; y: number; z: number; yaw: number; spd: number; dead: boolean; seen: number }>();
  /** Wave puppets the guest materialised from host snapshots. */
  private guestSpawned = new Set<Entity>();
  /** Previous roster, for join/leave toasts. */
  private prevRoster = new Map<string, string>();

  onHud: (h: HudState) => void = () => {};
  onTouch: (t: TouchState | null) => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
  }

  async init() {
    await loadAtlases();
    this.player = new Player();

    // Quality preset (item 17): AUTO defers to the device-tier QUALITY row;
    // the three manual presets override pixel ratio, shadow rig and the
    // population budgets used below.
    const qs = qualitySettings(this.quality);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: !QUALITY.mobile,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, qs.maxPixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = QUALITY.mobile ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    // Filmic response — without it the 3+ intensity sun clips every lit face to paper.
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.camera = new THREE.PerspectiveCamera(FEEL.fov, 1, 0.1, 1400);

    // ── Atmosphere: low amber sun, dust haze, viewer-tracked shadow rig ──
    this.sky = new Sky(this.scene, {
      shadowRadius: qs.shadowRadius,
      shadowMapSize: qs.shadowMapSize,
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
      const cans = qs.fuelCans;
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
    for (let i = 0; i < (QUALITY.mobile ? 3 : 4); i++) {
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
      r.onDeliver = () => { this.player.inventory.add("scrap", 1); };
      this.entities.push(r);
    }
    for (const e of this.entities) this.scene.add(e.group);
    // Runner shamblers REPLACE part of the pack rather than adding to it, so
    // mobile keeps its QUALITY.shamblers budget — one in four, rounded up.
    {
      const shamblerCount = qs.shamblers;
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
    // Mobile retires the inner patrol entirely: the outer-ring checkpoint
    // stalker below REPLACES it, so the device-tier budget stays flat while
    // the outer ring comes alive.
    for (let i = 0; i < (QUALITY.mobile ? 0 : 2); i++) {
      this.wireStalker(new StalkerBot(spawn(45, 80), 6100 + i * 97));
    }
    // Outer ring (2c): one stalker holds the military checkpoint at (0, 160).
    this.wireStalker(new StalkerBot(new THREE.Vector3(0, heightAt(0, 160), 160), 6300));
    // Feral spore-boars (item 15): 2–3 roaming the fields, none in the sanctuary.
    // Mobile trims the INNER ring first to make budget room for the outer herds.
    for (let i = 0; i < (QUALITY.mobile ? 1 : 3); i++) {
      let pos = spawn(30, 80);
      for (let tries = 0; tries < 12 && safeZoneFactor(pos.x, pos.z) > 0; tries++) pos = spawn(30, 80);
      this.addBoar(pos, 3300 + i * 71);
    }
    // ── Outer ring alive (2a): seeded boar herds out past the 105 m line ──
    {
      const herdRng = makeRng(8801);
      const herds = QUALITY.mobile ? 2 : 3;
      const perHerd = QUALITY.mobile ? 2 : 3;
      for (let h = 0; h < herds; h++) {
        let hx = 0, hz = 0;
        for (let t = 0; t < 12; t++) {
          hx = (herdRng() * 2 - 1) * 170;
          hz = (herdRng() * 2 - 1) * 170;
          if (Math.abs(hx) > 105 || Math.abs(hz) > 105) break;
        }
        for (let j = 0; j < perHerd; j++) {
          const x = hx + (herdRng() - 0.5) * 14;
          const z = hz + (herdRng() - 0.5) * 14;
          this.addBoar(new THREE.Vector3(x, heightAt(x, z), z), 9100 + h * 37 + j);
        }
      }
    }
    // ── Outer ring alive (2b): a pack infests the ruined suburb at (-150, 120) ──
    {
      const packRng = makeRng(7702);
      const pack = QUALITY.mobile ? 3 : 5;
      const runners = QUALITY.mobile ? 1 : 2;
      for (let i = 0; i < pack; i++) {
        const x = -150 + (packRng() - 0.5) * 28;
        const z = 120 + (packRng() - 0.5) * 28;
        const pos = new THREE.Vector3(x, heightAt(x, z), z);
        const zed = i < runners ? new RunnerShambler(pos, 500 + i) : new Shambler(pos);
        if (zed instanceof RunnerShambler) zed.onAggro = () => this.audio.runnerScreech();
        this.entities.push(zed);
        this.scene.add(zed.group);
      }
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
    // ── GORETUSK ALPHA (2e): mini-boss at the crashed-plane arena ──
    // The arena marker is registered by the world build; without it the fight
    // still happens at the contract fallback point.
    {
      const marker = assetRegistry.find((r) => r.role === "boss_arena_goretusk");
      const pos = new THREE.Vector3(-140, 0, -150);
      if (marker) marker.object.getWorldPosition(pos);
      pos.y = heightAt(pos.x, pos.z);
      const g = new SporeBoar(pos, 7777, {
        scale: 1.6, hp: 220, chargeSpeed: 14, aggroRange: 16, role: "BOSS: GORETUSK ALPHA",
      });
      g.onSnort = () => this.audio.boarSnort();
      g.onHit = (dir) => {
        // tusk hit like any boar, plus the spore crop bursts on the gore
        this.damagePlayer(16);
        this.player.velocity.x += dir.x * 10;
        this.player.velocity.z += dir.z * 10;
        if (this.player.velocity.y < 3.6) this.player.velocity.y = 3.6;
        this.player.grounded = false;
        this.audio.boarImpact();
        this.audio.hurt();
        const at = this.player.position.clone().add(new THREE.Vector3(0, 1.2, 0));
        this.fx.emit(at, { count: 30, speed: 3.2, life: 1.3, size: 0.5, color: 0x7a9a3a, gravity: -0.4, drag: 1.7 });
        this.fx.impact(at, dir.clone().negate());
      };
      this.entities.push(g);
      this.scene.add(g.group);
      this.goretusk = g;
    }
    // Multiplayer: deterministic network ids for every hostile, assigned in
    // seeded spawn order so host and guests name the same entities. Inert
    // unless a room is joined; solo play never reads the maps.
    this.assignNetIds();
    // ── SAL the Trader (1): holds the trading-post stall at (-31, 77.3) ──
    // He never leaves the counter — two stations inside the stall footprint.
    this.trader = new Trader(
      new THREE.Vector3(-31, 0, 78.4),
      [new THREE.Vector3(-31, 0, 78.4), new THREE.Vector3(-29.9, 0, 78.1)],
      "SAL"
    );
    this.scene.add(this.trader.group);
    // ── Sealed supply caches (2d): outer-ring, one-time, persisted ──
    // Registered "loot_cache" assets are the interact points; with none
    // registered, three seeded fallback sites keep the mechanic alive.
    {
      const cacheRng = makeRng(6600);
      const defs: Array<{ id: string; obj: THREE.Object3D | null; pos: THREE.Vector3 }> = [];
      for (const rec of assetRegistry) {
        if (rec.role !== "loot_cache") continue;
        const wp = new THREE.Vector3();
        rec.object.getWorldPosition(wp);
        defs.push({ id: rec.id, obj: rec.object, pos: wp });
      }
      if (defs.length === 0) {
        const spots: Array<[number, number]> = [[-128, 58], [96, -132], [142, 96]];
        spots.forEach(([x, z], i) => {
          defs.push({ id: `CACHE-FALLBACK-${i}`, obj: null, pos: new THREE.Vector3(x, heightAt(x, z), z) });
        });
      }
      for (const d of defs) {
        const marker = makeCacheMarker();
        marker.position.set(d.pos.x, d.pos.y + 1.3, d.pos.z);
        this.scene.add(marker);
        this.caches.push({
          id: d.id, obj: d.obj, pos: d.pos, opened: false, marker,
          scrap: 5 + Math.floor(cacheRng() * 6), phase: cacheRng() * 6.28,
        });
      }
    }
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
    // Panels own Escape/Tab while open — one owner per key, per state.
    if (e.code === "Escape" && (this.inventoryOpen || this.craftOpen || this.tradeOpen || this.playersOpen)) {
      this.closePanels();
      return;
    }
    if (e.code === "Tab" || e.code === "KeyI") {
      e.preventDefault(); // Tab would otherwise walk browser focus off the canvas
      this.toggleInventory();
      return;
    }
    this.keys.add(e.code);
    if (e.code === "KeyU") this.togglePlayers();
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
    // Weapon select on 7/8 (Q is seats, 1-6 belong to build mode while it is open).
    if (!this.buildMode.active && e.code === "Digit7") this.selectWeapon("pipe_rifle");
    if (!this.buildMode.active && e.code === "Digit8") this.selectWeapon("scrap_shotgun");
    if (!this.buildMode.active && e.code === "Digit0") this.selectWeapon("pulse");
    if (this.buildMode.active && e.code.startsWith("Digit")) {
      const n = parseInt(e.code.slice(5), 10) - 1;
      if (n >= 0 && n < PIECES.length) this.buildMode.select(n);
    }
  };
  /** Scroll wheel cycles OWNED weapons while on foot — never in build mode. */
  private onWheel = (e: WheelEvent) => {
    if (this.buildMode.active || this.inventoryOpen || this.craftOpen || this.tradeOpen || this.playersOpen || this.cinema.active) return;
    if (this.mode !== "FOOT") return;
    this.cycleWeapon(e.deltaY > 0 ? 1 : -1);
  };
  /** Item 16: a backgrounding tab gets one last save before the OS freezes it. */
  private onVisibility = () => {
    if (document.visibilityState === "hidden") this.saveNow();
  };
  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
  private onMouseMove = (e: MouseEvent) => {
    if (document.pointerLockElement !== this.canvas) return;
    this.look(e.movementX, e.movementY, FEEL.lookSens);
  };
  private onMouseDown = (e: MouseEvent) => {
    this.audio.resume(); // browsers refuse audio until a real gesture
    if (e.button !== 0) return;
    // While a panel is open its buttons own the clicks — re-locking the pointer
    // here would swallow the click that was meant for a backpack slot.
    if (this.inventoryOpen || this.craftOpen || this.tradeOpen || this.playersOpen) return;
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
    if (this.inventoryOpen || this.craftOpen || this.tradeOpen || this.playersOpen) return; // panels own the clicks while open
    if (this.buildMode.active) {
      // every piece costs scrap from the backpack (catalog: build.ts PIECES)
      const piece = this.buildMode.piece;
      const cost = piece.cost ?? 0;
      if (cost > 0) {
        const have = this.player.inventory.count("scrap");
        if (have < cost) { this.say(`NEED ${cost} SCRAP · HAVE ${have}`); this.audio.ui(); return; }
      }
      const res = this.buildMode.place();
      if (res) {
        if (cost > 0) this.player.inventory.remove("scrap", cost);
        this.spawnRing(res.position, res.snapped ? 0x33ddff : 0x44ff88); // THE snap effect
        this.audio.build();
        this.pops.push({ obj: res.object, t: 0.16 });
        this.lastIssueCount = this.inspection.mode === "inspection" ? this.inspection.validate().issues.length : this.lastIssueCount;
        // co-op: structures stay per-browser in v1, but the room hears about it
        this.net?.sendEvent({
          k: "build", n: this.net!.displayName, piece: piece.label,
          p: [+res.position.x.toFixed(1), +res.position.z.toFixed(1)],
        });
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
    window.addEventListener("wheel", this.onWheel, { passive: true });
    window.addEventListener("pointercancel", this.onPointerCancel);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
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

  // ── Spawn wiring: one place per creature type, shared by every ring ──

  /** Tusk-hit contract for every spore-boar: damage plus a real knockdown. */
  private addBoar(pos: THREE.Vector3, seed: number) {
    const b = new SporeBoar(pos, seed);
    b.onSnort = () => this.audio.boarSnort();
    b.onHit = (dir) => {
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

  /** Sniper contract: walls stop bolts, same as every other shot in the game. */
  private wireStalker(s: StalkerBot) {
    s.onCharge = () => this.audio.laserCharge();
    s.onFire = (from, to) => {
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

  // ── Sealed supply caches (outer ring) ──

  private nearestCache(p: THREE.Vector3, r = 3.2): CacheState | null {
    let best: CacheState | null = null;
    let bd = r;
    for (const c of this.caches) {
      if (c.opened) continue;
      if (Math.abs(c.pos.y - p.y) > 3) continue;
      const d = Math.hypot(c.pos.x - p.x, c.pos.z - p.z);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  private openCache(c: CacheState) {
    const inv = this.player.inventory;
    if (inv.spaceFor("fuel_can") < 1 && inv.spaceFor("scrap") < 1) {
      this.say("BACKPACK FULL — NO ROOM FOR THE CACHE");
      this.audio.ui();
      return;
    }
    c.opened = true;
    this.scene.remove(c.marker);
    if (c.obj) {
      // the lid pops: a small tilt plus the placement-pop bounce, so an opened
      // cache reads as opened from across the field
      c.obj.rotation.x -= 0.12;
      this.pops.push({ obj: c.obj, t: 0.16 });
    }
    const fuel = inv.add("fuel_can", 1);
    const scrap = inv.add("scrap", c.scrap);
    this.audio.cacheLid();
    this.audio.pickup();
    this.fx.salvageBurst(c.pos.clone().add(new THREE.Vector3(0, 1, 0)));
    this.spawnRing(c.pos.clone(), 0x9fe8ff);
    this.say(`CACHE OPENED · +${fuel} FUEL CAN · +${scrap} SCRAP`, 3);
    this.net?.sendEvent({ k: "cache", c: c.id, n: this.net!.displayName });
  }

  // ── SAL's barter counter ──

  private nearTrader(p: THREE.Vector3, r = 3.2): boolean {
    return Math.hypot(this.trader.group.position.x - p.x, this.trader.group.position.z - p.z) < r;
  }

  private openTrade() {
    this.tradeOpen = true;
    this.inventoryOpen = false;
    this.craftOpen = false;
    this.audio.panel(true);
    if (!IS_TOUCH) document.exitPointerLock?.();
  }

  /** One barter transaction. Scrap is the only currency SAL accepts. */
  trade(id: TradeId) {
    const offer = TRADE_OFFERS.find((o) => o.id === id);
    if (!offer) return;
    const inv = this.player.inventory;
    const fail = (msg: string) => { this.say(msg); this.audio.ui(); };
    switch (id) {
      case "sell_scrap": {
        if (inv.count("scrap") < 10) return fail("SAL BUYS IN TENS — NOT ENOUGH SCRAP");
        if (inv.spaceFor("fuel_can") < 1) return fail("NO ROOM FOR THE FUEL CAN");
        inv.remove("scrap", 10);
        inv.add("fuel_can", 1);
        this.say("SOLD 10 SCRAP · +1 FUEL CAN");
        break;
      }
      case "buy_medkit": {
        if (inv.count("scrap") < offer.cost) return fail(`NEED ${offer.cost} SCRAP`);
        if (inv.spaceFor("medkit") < 1) return fail("BACKPACK FULL — NO ROOM FOR THE MEDKIT");
        inv.remove("scrap", offer.cost);
        inv.add("medkit", 1);
        this.say("BOUGHT MEDKIT 🩹");
        break;
      }
      case "buy_fuel": {
        if (inv.count("scrap") < offer.cost) return fail(`NEED ${offer.cost} SCRAP`);
        if (inv.spaceFor("fuel_can") < 1) return fail("BACKPACK FULL — NO ROOM FOR THE CAN");
        inv.remove("scrap", offer.cost);
        inv.add("fuel_can", 1);
        this.say("BOUGHT FUEL CAN ⛽");
        break;
      }
      case "buy_rifle":
      case "buy_shotgun": {
        const item = id === "buy_rifle" ? "pipe_rifle" as const : "scrap_shotgun" as const;
        if (inv.has(item)) return fail("ALREADY IN YOUR PACK");
        if (inv.count("scrap") < offer.cost) return fail(`NEED ${offer.cost} SCRAP`);
        if (inv.spaceFor(item) < 1) return fail("BACKPACK FULL — MAKE ROOM FIRST");
        inv.remove("scrap", offer.cost);
        inv.add(item, 1);
        this.say(`BOUGHT ${WEAPONS[item].name}`);
        this.selectWeapon(item); // straight into the hands, like a fresh craft
        break;
      }
    }
    this.audio.tradeCoin();
  }

  // ── Player-built defenses (build mode roles) ──

  /** Adopt newly placed turrets and spike traps from the asset registry. */
  private scanDefenses() {
    for (const rec of assetRegistry) {
      if (rec.role === "scrap_turret" && !this.turrets.some((t) => t.obj === rec.object)) {
        // The build piece tags its aimable head group; yaw THAT, not the tripod.
        let head: THREE.Object3D = rec.object;
        rec.object.traverse((c) => { if (c.userData.turretHead) head = c; });
        this.turrets.push({ obj: rec.object, head, cooldown: 0.4, shots: 0, hungry: false });
      } else if (rec.role === "spike_trap" && !this.spikes.some((s) => s.obj === rec.object)) {
        const wp = new THREE.Vector3();
        rec.object.getWorldPosition(wp);
        this.spikes.push({ obj: rec.object, pos: wp, cooldowns: new Map() });
      }
    }
  }

  private updateDefenses(dt: number) {
    // scrap turrets: track the nearest hostile in range and crack away
    for (const t of this.turrets) {
      t.cooldown -= dt;
      const from = new THREE.Vector3();
      t.obj.getWorldPosition(from);
      let best: Entity | null = null;
      let bd = 18;
      for (const e of this.entities) {
        // puppets are the host's to damage — a guest turret just tracks them
        if (e.dead || !e.hostile || e.puppet) continue;
        const d = Math.hypot(e.group.position.x - from.x, e.group.position.z - from.z);
        if (d < bd) { bd = d; best = e; }
      }
      if (!best) continue;
      // the head slews toward the target even between shots — head yaw is local
      // to the (possibly R-rotated) root, so subtract the root's yaw
      const targetYaw = Math.atan2(best.group.position.x - from.x, best.group.position.z - from.z) - t.obj.rotation.y;
      let dy = targetYaw - t.head.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      t.head.rotation.y += THREE.MathUtils.clamp(dy, -3.5 * dt, 3.5 * dt);
      if (t.cooldown > 0) continue;
      // upkeep: one scrap from the backpack per 20 shots; dry turrets hold fire
      if (t.shots > 0 && t.shots % 20 === 0) {
        if (this.player.inventory.count("scrap") < 1) { t.hungry = true; continue; }
        this.player.inventory.remove("scrap", 1);
        t.hungry = false;
      }
      t.cooldown = 1.6;
      t.shots += 1;
      // muzzle: root world position is the firing origin (rootLift 1.2 m),
      // pushed slightly along the head's facing
      const worldYaw = t.obj.rotation.y + t.head.rotation.y;
      const facing = new THREE.Vector3(Math.sin(worldYaw), 0, Math.cos(worldYaw));
      const muzzle = from.clone().addScaledVector(facing, 0.7);
      const aim = best.group.position.clone().add(new THREE.Vector3(0, 0.9, 0));
      const clear = this.lineOfSight(muzzle, aim); // walls stop turret bolts too
      this.spawnTracer(muzzle, clear.point, 0xffd27a);
      this.audio.turretFire();
      this.fx.muzzleFlash(muzzle, new THREE.Vector3().subVectors(aim, muzzle).normalize());
      if (!clear.hit) {
        best.damage(6);
        if (best.dead) this.onHostileKilled(best);
      }
    }
    // spike traps: bleed anything hostile that steps on them, 1 s per target
    for (const s of this.spikes) {
      for (const [e, cd] of s.cooldowns) {
        const n = cd - dt;
        if (n <= 0) s.cooldowns.delete(e); else s.cooldowns.set(e, n);
      }
      for (const e of this.entities) {
        if (e.dead || !e.hostile || e.puppet || s.cooldowns.has(e)) continue;
        const d = Math.hypot(e.group.position.x - s.pos.x, e.group.position.z - s.pos.z);
        if (d > 1.2 || Math.abs(e.group.position.y - s.pos.y) > 2) continue;
        s.cooldowns.set(e, 1.0);
        e.damage(15);
        const at = e.group.position.clone().add(new THREE.Vector3(0, 0.4, 0));
        this.fx.emit(at, { count: 8, speed: 2.2, life: 0.5, size: 0.14, color: 0x7a1a12, gravity: -9, drag: 1.6 });
        this.fx.emit(at, { count: 5, speed: 1.2, life: 0.6, size: 0.3, color: 0x6b5a44, gravity: -1.2, drag: 2.2 });
        if (e.dead) this.onHostileKilled(e);
      }
    }
    // contextual HUD hint near a scrap-starved turret
    let hint: string | null = null;
    for (const t of this.turrets) {
      if (!t.hungry) continue;
      const wp = new THREE.Vector3();
      t.obj.getWorldPosition(wp);
      if (Math.hypot(wp.x - this.player.position.x, wp.z - this.player.position.z) < 8) {
        hint = "TURRET OUT OF SCRAP — IT EATS ⚙1 PER 20 SHOTS";
        break;
      }
    }
    this.turretHint = hint;
  }

  /** One funnel for hostile deaths: score, quest credit, salvage, gore. */
  private onHostileKilled(e: Entity) {
    this.kills += 1;
    // Guard's Night Watch errand counts shambler kills made after dark —
    // wave-night kills qualify, which is rather the point of the job.
    if (this.quest && this.quest.def.kind === "cull" && !questComplete(this.quest) &&
        this.sky.nightness > 0.4 &&
        (e instanceof Shambler || e instanceof RunnerShambler)) {
      this.quest.progress += 1;
      if (questComplete(this.quest)) this.say(`NIGHT WATCH DONE — REPORT TO ${this.quest.giverName}`);
    }
    if (e === this.goretusk) {
      // the mini-boss pays out properly: a heavy drop plus two medkits
      this.loot.addDrop(e.group.position, 30);
      const got = this.player.inventory.add("medkit", 2);
      this.say(got === 2 ? "GORETUSK DOWN · +30 SCRAP DROP · +2 MEDKITS" : "GORETUSK DOWN · +30 SCRAP DROP", 3.5);
      this.net?.sendEvent({ k: "tusk" });
    } else {
      // A kill should leave something behind, or fighting is pure cost.
      this.loot.addDrop(e.group.position, 5 + Math.floor(Math.random() * 9));
    }
    this.audio.robotDeath();
    this.fx.wreck(e.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
  }

  // ── Backpack, weapons & workbench (Batch 2 items 14 + inventory) ──

  /**
   * Where crafting happens. The bench prop is looked up by registry role at
   * runtime (same pattern as the watchtower spotlight), so if the world build
   * hasn't shipped one yet the Homestead centre itself counts as the bench —
   * a graceful fallback, not a world-file edit.
   */
  private workbenchPos(): { pos: THREE.Vector3; fallback: boolean } {
    const rec = assetRegistry.find((r) => r.role === "workbench");
    if (rec) {
      const v = new THREE.Vector3();
      rec.object.getWorldPosition(v);
      return { pos: v, fallback: false };
    }
    return { pos: new THREE.Vector3(SAFE_ZONE.x, 0, SAFE_ZONE.z), fallback: true };
  }

  private nearWorkbench(p: THREE.Vector3): boolean {
    const w = this.workbenchPos();
    const r = w.fallback ? 6 : 2.8; // the fallback is a place, the prop is a thing
    return Math.hypot(w.pos.x - p.x, w.pos.z - p.z) < r;
  }

  /** Backpack panel toggle (Tab / I on PC, 🎒 button on touch). */
  toggleInventory() {
    if (this.craftOpen) this.craftOpen = false; // one panel at a time
    if (this.tradeOpen) this.tradeOpen = false;
    if (this.playersOpen) this.playersOpen = false;
    this.inventoryOpen = !this.inventoryOpen;
    this.audio.panel(this.inventoryOpen);
    // The cursor must be free to click slots; re-lock happens on the next
    // canvas click, which is the existing pointer-lock contract.
    if (this.inventoryOpen && !IS_TOUCH) document.exitPointerLock?.();
  }

  closePanels() {
    if (this.inventoryOpen || this.craftOpen || this.tradeOpen || this.playersOpen) this.audio.panel(false);
    this.inventoryOpen = false;
    this.craftOpen = false;
    this.tradeOpen = false;
    this.playersOpen = false;
  }

  private openCraft() {
    this.craftOpen = true;
    this.inventoryOpen = false;
    this.tradeOpen = false;
    this.audio.panel(true);
    if (!IS_TOUCH) document.exitPointerLock?.();
  }

  /** Tap/click a backpack slot: fuel feeds a nearby generator, guns equip. */
  useInventoryItem(i: number) {
    const slot = this.player.inventory.slots[i];
    if (!slot) return;
    switch (slot.id) {
      case "fuel_can":
        if (this.generator.near(this.player.position)) {
          this.player.inventory.remove("fuel_can", 1);
          this.generator.feed();
          this.audio.build();
          this.say(`GENERATOR FUELED · ${this.generator.fuel.toFixed(1)} CANS`);
        } else {
          this.say("NO GENERATOR IN RANGE — CARRY IT HOME");
          this.audio.ui();
        }
        break;
      case "pipe_rifle":
      case "scrap_shotgun":
        this.selectWeapon(slot.id);
        break;
      case "medkit":
        if (this.player.hp >= this.player.maxHp) {
          this.say("INTEGRITY ALREADY FULL");
          this.audio.ui();
        } else {
          this.player.inventory.remove("medkit", 1);
          this.player.hp = Math.min(this.player.maxHp, this.player.hp + 40);
          this.audio.healChime();
          this.say("MEDKIT USED · +40 INTEGRITY");
        }
        break;
      case "scrap":
        this.say("RAW MATERIAL — CRAFT IT AT THE WORKBENCH");
        this.audio.ui();
        break;
    }
  }

  /** Craft at the workbench. Scrap is checked and spent from the backpack. */
  craft(item: (typeof RECIPES)[number]["item"]) {
    const r = RECIPES.find((x) => x.item === item);
    if (!r) return;
    const inv = this.player.inventory;
    if (inv.has(item)) { this.say(`${r.name} ALREADY IN YOUR PACK`); this.audio.ui(); return; }
    const have = inv.count("scrap");
    if (have < r.cost) { this.say(`NEED ${r.cost} SCRAP · HAVE ${have}`); this.audio.ui(); return; }
    if (inv.spaceFor(item) < 1) { this.say("BACKPACK FULL — MAKE ROOM FIRST"); this.audio.ui(); return; }
    inv.remove("scrap", r.cost);
    inv.add(item, 1);
    this.audio.craftClank();
    this.say(`CRAFTED ${r.name}`, 3);
    this.selectWeapon(r.weapon); // straight into the hands
  }

  /** Weapons the player actually owns, in cycle order. */
  private ownedWeapons(): WeaponId[] {
    const w: WeaponId[] = ["pulse"];
    if (this.player.inventory.has("pipe_rifle")) w.push("pipe_rifle");
    if (this.player.inventory.has("scrap_shotgun")) w.push("scrap_shotgun");
    return w;
  }

  selectWeapon(id: WeaponId) {
    if (id !== "pulse" && !this.player.inventory.has(id)) {
      this.say("NOT IN YOUR PACK — CRAFT IT AT THE WORKBENCH");
      this.audio.ui();
      return;
    }
    if (this.currentWeapon === id) return;
    this.currentWeapon = id;
    this.refreshWeaponProp();
    this.audio.ui();
    this.say(`${WEAPONS[id].name} READY`);
  }

  cycleWeapon(dir: number) {
    const owned = this.ownedWeapons();
    if (owned.length < 2) return;
    const i = owned.indexOf(this.currentWeapon);
    this.selectWeapon(owned[(i + dir + owned.length) % owned.length]);
  }

  /** The equipped gun rides the player model so the HUD badge isn't the only tell. */
  private refreshWeaponProp() {
    if (this.weaponProp) {
      this.player.group.remove(this.weaponProp);
      this.weaponProp = null;
    }
    if (this.currentWeapon === "pulse") return;
    const prop = this.currentWeapon === "pipe_rifle" ? makeRifleProp() : makeShotgunProp();
    // right-hand carry, muzzle forward along the body's facing (+Z)
    prop.position.set(0.38, 1.12, 0.22);
    this.player.group.add(prop);
    this.weaponProp = prop;
  }

  // ── Quality preset (Batch 3 item 17) ──

  /** Live-switch pixel ratio + shadow rig; population budgets apply on restart. */
  setQuality(p: QualityPreset) {
    if (p === this.quality) return;
    this.quality = p;
    storeQualityPreset(p);
    const qs = qualitySettings(p);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, qs.maxPixelRatio));
    this.resize();
    const sh = this.sky.sun.shadow;
    sh.mapSize.set(qs.shadowMapSize, qs.shadowMapSize);
    sh.camera.left = -qs.shadowRadius;
    sh.camera.right = qs.shadowRadius;
    sh.camera.top = qs.shadowRadius;
    sh.camera.bottom = -qs.shadowRadius;
    sh.camera.updateProjectionMatrix();
    if (sh.map) { sh.map.dispose(); sh.map = null; } // force re-allocation at the new size
    this.audio.ui();
    this.say(`QUALITY: ${p} · POPULATION APPLIES ON RELOAD`, 3);
  }

  // ── Multiplayer (wasteland-commons host-authoritative co-op) ──

  /** Deterministic network ids for every hostile, in seeded spawn order. */
  private assignNetIds() {
    const counts = new Map<string, number>();
    for (const e of this.entities) {
      if (!e.hostile) continue;
      const kind =
        e === this.goretusk ? "tusk" :
        e instanceof Boss ? "boss" :
        e instanceof StalkerBot ? "stalker" :
        e instanceof RunnerShambler ? "runner" :
        e instanceof Shambler ? "zed" :
        e instanceof SporeBoar ? "boar" :
        e instanceof Robot ? "robot" : null;
      if (!kind) continue;
      const n = counts.get(kind) ?? 0;
      counts.set(kind, n + 1);
      const id = `${kind}:${n}`;
      this.netIds.set(e, id);
      this.netEntities.set(id, e);
    }
  }

  /** True while connected to a room. */
  get inMultiplayer() { return this.net !== null; }

  /**
   * Join (or create) a room and go co-op. Resolves true on connect; on any
   * failure it toasts and resolves false so the caller can stay solo. The
   * game loop never awaits any of this — join happens before the run starts.
   */
  async startMultiplayer(code: string, displayName: string): Promise<boolean> {
    if (this.net) return true;
    const net = new NetClient();
    net.onTransform = (m) => { this.transformQueue.push(m); };
    net.onSnapshot = (m) => { this.latestSnapshot = m; };
    net.onEvent = (m) => { this.eventQueue.push(m); };
    net.onRoster = (r) => this.onNetRoster(r);
    net.onStatus = (msg) => this.say(msg, 3);
    net.onRoleChange = (role, reason) => this.onNetRole(role, reason);
    try {
      await net.join(code, displayName);
    } catch {
      await net.leave().catch(() => {});
      this.say("NO SIGNAL FROM THE COMMONS — PLAYING SOLO", 3.5);
      return false;
    }
    this.net = net;
    this.netRole = net.role;
    this.remotes = new RemotePlayers(this.scene);
    this.puppetGraceUntil = performance.now() / 1000 + 6;
    if (this.netRole === "GUEST") {
      // Host authority: hostiles become position-driven puppets. Anything the
      // host's snapshots never mention un-puppets itself after the grace
      // window (population budgets can differ across device tiers).
      for (const e of this.entities) if (e.hostile) e.puppet = true;
    }
    this.prevRoster.clear();
    this.onNetRoster(net.roster);
    this.say(`CONNECTED · ${net.worldId} · YOU ARE ${this.netRole}${this.netRole === "HOST" ? " 👑" : ""}`, 3.5);
    return true;
  }

  /** LEAVE button / panel close: back to a purely local wasteland. */
  leaveMultiplayer() {
    const net = this.net;
    if (!net) return;
    this.net = null;
    this.netRole = null;
    if (this.playersOpen) { this.playersOpen = false; this.audio.panel(false); }
    void net.leave();
    this.remotes?.dispose();
    this.remotes = null;
    this.transformQueue.length = 0;
    this.eventQueue.length = 0;
    this.latestSnapshot = null;
    this.netTargets.clear();
    // guest-materialised wave puppets leave with the session
    for (const e of this.guestSpawned) {
      this.scene.remove(e.group);
      const id = this.netIds.get(e);
      if (id) { this.netIds.delete(e); this.netEntities.delete(id); }
    }
    this.entities = this.entities.filter((e) => !this.guestSpawned.has(e));
    this.guestSpawned.clear();
    for (const e of this.entities) e.puppet = false;
    this.prevRoster.clear();
    this.say("LEFT THE COMMONS", 2.5);
  }

  /** Players panel (U on PC, 👥 in the thumb arc). */
  togglePlayers() {
    if (!this.net) return;
    this.playersOpen = !this.playersOpen;
    if (this.playersOpen) { // one panel at a time
      this.inventoryOpen = false;
      this.craftOpen = false;
      this.tradeOpen = false;
    }
    this.audio.panel(this.playersOpen);
    if (this.playersOpen && !IS_TOUCH) document.exitPointerLock?.();
  }

  /** 📡 one-shot ping to the room — the v1 "chat". */
  sendPing() {
    if (!this.net) return;
    this.net.sendEvent({ k: "ping", n: this.net.displayName });
    this.audio.ui();
    this.say("📡 PING SENT", 1.5);
  }

  private onNetRoster(r: RosterEntry[]) {
    if (!this.net) return;
    for (const p of r) {
      if (!this.prevRoster.has(p.id) && p.id !== this.net.playerId) this.say(`${p.name} JOINED THE COMMONS`, 2.5);
    }
    for (const [id, name] of this.prevRoster) {
      if (!r.some((p) => p.id === id)) this.say(`${name} LEFT THE COMMONS`, 2.5);
    }
    this.prevRoster = new Map(r.map((p) => [p.id, p.name]));
    this.remotes?.syncRoster(r);
  }

  private onNetRole(role: NetRole, reason: "claimed" | "failover" | "lost") {
    this.netRole = role;
    if (role === "HOST") {
      // local sim takes over from wherever the puppets stand
      for (const e of this.entities) e.puppet = false;
      this.netTargets.clear();
      this.say(reason === "failover" ? "HOST LOST — YOU NOW RUN THE WORLD 👑" : "YOU ARE HOST 👑", 3.5);
    } else if (reason === "lost") {
      for (const e of this.entities) if (e.hostile) e.puppet = true;
    }
  }

  /** Guest: apply one host entity snapshot (drained in tick, never async). */
  private applySnapshot(snap: EntSnapshotMsg, now: number) {
    for (const [id, x, y, z, yaw, hp, dead] of snap.e) {
      let ent = this.netEntities.get(id);
      if (!ent && (id.startsWith("wz:") || id.startsWith("wr:"))) {
        // A wave-night hostile the host spawned — materialise a local puppet.
        const pos = new THREE.Vector3(x, y, z);
        ent = id.startsWith("wr:") ? new RunnerShambler(pos, 900) : new Shambler(pos);
        ent.puppet = true;
        this.entities.push(ent);
        this.scene.add(ent.group);
        this.netIds.set(ent, id);
        this.netEntities.set(id, ent);
        this.guestSpawned.add(ent);
      }
      if (!ent) continue;
      const prev = this.netTargets.get(id);
      const spd = prev ? Math.min(15, Math.hypot(x - prev.x, z - prev.z) / Math.max(0.03, now - prev.seen)) : 0;
      if (dead === 1 && !ent.dead) {
        ent.hp = 0;
        ent.damage(0); // hp is 0 — this lands the class-specific death pose
        this.onRemoteKill(ent);
      } else if (dead !== 1) {
        ent.hp = hp;
      }
      this.netTargets.set(id, { x, y, z, yaw, spd, dead: dead === 1, seen: now });
    }
    // Sealed caches opened on the host side stay opened here (self-heal).
    for (const cid of snap.c) {
      const c = this.caches.find((x) => x.id === cid);
      if (c && !c.opened) {
        c.opened = true;
        this.scene.remove(c.marker);
      }
    }
  }

  /** A hostile died on the host: local kill feed, gore and score. */
  private onRemoteKill(e: Entity) {
    this.kills += 1;
    this.audio.robotDeath();
    this.fx.wreck(e.group.position.clone().add(new THREE.Vector3(0, 0.9, 0)));
  }

  /** Guest: drive one puppet toward its snapshot target. */
  private drivePuppet(e: Entity, dt: number) {
    const id = this.netIds.get(e);
    const t = id ? this.netTargets.get(id) : undefined;
    if (!t || e.dead) return;
    const p = e.group.position;
    if (Math.hypot(t.x - p.x, t.y - p.y, t.z - p.z) > 15) {
      p.set(t.x, t.y, t.z); // teleport — never rubber-band across the map
      e.group.rotation.y = t.yaw;
    } else {
      p.x = THREE.MathUtils.damp(p.x, t.x, 10, dt);
      p.y = THREE.MathUtils.damp(p.y, t.y, 10, dt);
      p.z = THREE.MathUtils.damp(p.z, t.z, 10, dt);
      let dy = t.yaw - e.group.rotation.y;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      e.group.rotation.y += THREE.MathUtils.clamp(dy, -6 * dt, 6 * dt);
    }
    e.puppetAnimate?.(dt, t.spd);
  }

  /** Inbound one-shot events (drained in tick). */
  private handleNetEvent(m: EventMsg) {
    switch (m.k) {
      case "shot": {
        // Host only (net.ts already filtered): a guest's hit lands here.
        if (this.netRole !== "HOST") break;
        const ent = typeof m.id === "string" ? this.netEntities.get(m.id) : undefined;
        const dmg = typeof m.d === "number" ? THREE.MathUtils.clamp(m.d, 1, 120) : 0;
        if (!ent || ent.dead || dmg <= 0) break;
        const from = typeof m.by === "string" ? this.remotes?.positionOf(m.by) : null;
        const at = ent.group.position.clone().add(new THREE.Vector3(0, 0.9, 0));
        if (from) this.spawnTracer(from.clone().add(new THREE.Vector3(0, 1.4, 0)), at, 0x9fe8ff);
        this.fx.impact(at, new THREE.Vector3(0, 1, 0));
        ent.damage(dmg);
        if (ent.dead) this.onHostileKilled(ent);
        break;
      }
      case "cache": {
        const c = typeof m.c === "string" ? this.caches.find((x) => x.id === m.c) : undefined;
        if (c && !c.opened) {
          c.opened = true;
          this.scene.remove(c.marker);
        }
        if (typeof m.n === "string") this.say(`${m.n} OPENED A SUPPLY CACHE 💠`, 2.5);
        break;
      }
      case "wave+":
        if (this.netRole === "GUEST") {
          this.waveActive = true; // banner; the horde itself arrives by snapshot
          this.audio.waveHorn();
          this.say("WAVE NIGHT — THE HORDE COMES FOR THE BASE", 4);
        }
        break;
      case "wave-":
        if (this.netRole === "GUEST") this.waveActive = false;
        break;
      case "tusk":
        this.say("GORETUSK ALPHA IS DOWN", 3.5);
        break;
      case "build": {
        if (typeof m.n === "string" && Array.isArray(m.p)) {
          const [x, z] = m.p as [number, number];
          this.spawnRing(new THREE.Vector3(x, heightAt(x, z), z), 0x9fe8ff);
          this.say(`${m.n} PLACED ${String(m.piece ?? "A PIECE")}`, 2.5);
        }
        break;
      }
      case "ping":
        this.audio.ui();
        if (typeof m.n === "string") this.say(`📡 PING — ${m.n}`, 2.5);
        break;
    }
  }

  /** Per-frame multiplayer pump — called from tick, never awaited. */
  private netTick(dt: number) {
    const net = this.net;
    if (!net) return;
    const now = performance.now() / 1000;

    // inbound: remote player transforms
    if (this.transformQueue.length) {
      for (const m of this.transformQueue) this.remotes?.pushTransform(m, now);
      this.transformQueue.length = 0;
    }
    this.remotes?.update(dt, now);

    // inbound: host entity snapshot (guests only; keep only the freshest)
    const snap = this.latestSnapshot;
    if (snap) {
      this.latestSnapshot = null;
      if (this.netRole === "GUEST") this.applySnapshot(snap, now);
    }

    // inbound: events
    if (this.eventQueue.length) {
      for (const m of this.eventQueue) this.handleNetEvent(m);
      this.eventQueue.length = 0;
    }

    // outbound: own transform at 10 Hz
    this.netSendT -= dt;
    if (this.netSendT <= 0) {
      this.netSendT = 0.1;
      const p = this.player.position;
      net.sendTransform({
        id: net.playerId,
        n: net.displayName,
        p: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2)],
        y: +this.player.group.rotation.y.toFixed(2),
        c: +this.player.camPitch.toFixed(2),
        m: this.mode,
        w: this.currentWeapon,
        g: +this.player.gait.toFixed(1),
      });
    }

    // outbound: host entity snapshot at 8 Hz
    if (this.netRole === "HOST") {
      this.netSnapT -= dt;
      if (this.netSnapT <= 0) {
        this.netSnapT = 0.125;
        const e: EntEntry[] = [];
        for (const [ent, id] of this.netIds) {
          const gp = ent.group.position;
          e.push([id, +gp.x.toFixed(1), +gp.y.toFixed(1), +gp.z.toFixed(1),
            +ent.group.rotation.y.toFixed(2), Math.round(ent.hp), ent.dead ? 1 : 0]);
        }
        net.sendSnapshot({ e, c: this.caches.filter((c) => c.opened).map((c) => c.id) });
      }
    }

    // once a second: housekeeping on the guest side
    if (this.netRole === "GUEST" && now % 1 < dt) {
      // puppets the host never mentions (tier population mismatch) resume local AI
      if (now > this.puppetGraceUntil) {
        for (const ent of this.entities) {
          if (!ent.puppet) continue;
          const id = this.netIds.get(ent);
          if (id && !this.netTargets.has(id)) ent.puppet = false;
        }
      }
      // wave puppets the host stopped reporting are struck from the field
      for (const ent of Array.from(this.guestSpawned)) {
        const id = this.netIds.get(ent);
        const t = id ? this.netTargets.get(id) : undefined;
        if (!id || !t || now - t.seen > 6) {
          this.scene.remove(ent.group);
          this.entities = this.entities.filter((x) => x !== ent);
          if (id) { this.netIds.delete(ent); this.netEntities.delete(id); }
          if (id) this.netTargets.delete(id);
          this.guestSpawned.delete(ent);
        }
      }
    }
  }

  // ── Save / load (Batch 2 item 16) ──

  hasSave(): boolean { return hasSave(); }

  /** Start screen: wipe the save and play from the seeded beginning. */
  startNewRun() {
    clearSave();
    this.runStarted = true;
    this.saveTimer = 0;
    this.say("THE WASTELAND WAITS", 2.5);
  }

  /** Start screen: restore the last autosave. */
  continueRun() {
    this.runStarted = true;
    this.saveTimer = 0;
    const data = loadSave();
    if (!data) {
      this.say("SAVE UNREADABLE — STARTING FRESH", 3);
      return;
    }
    this.applySave(data);
    this.say("RUN RESTORED — WELCOME BACK", 3);
  }

  /** Autosave target and tab-hide hook. Silent by design — it is a safety net. */
  saveNow() {
    if (!this.runStarted || this.disposed) return;
    writeSave(this.collectSave());
  }

  private collectSave(): SaveData {
    const lootTaken: number[] = [];
    this.loot.nodes.forEach((n, i) => { if (n.taken) lootTaken.push(i); });
    return {
      v: SAVE_VERSION,
      savedAt: Date.now(),
      player: {
        pos: [this.player.position.x, this.player.position.y, this.player.position.z],
        hp: Math.round(this.player.hp),
        mode: this.mode,
      },
      inventory: this.player.inventory.toJSON(),
      weapon: this.currentWeapon,
      quest: this.quest
        ? { job: this.quest.def.giver as Job, giverName: this.quest.giverName, progress: this.quest.progress }
        : null,
      genFuel: this.generator.fuel,
      timeOfDay: this.sky.timeOfDay,
      nightIndex: this.nightIndex,
      kills: this.kills,
      lootTaken,
      cacheIds: this.caches.filter((c) => c.opened).map((c) => c.id),
      goretuskDead: this.goretusk ? this.goretusk.dead : false,
    };
  }

  private applySave(d: SaveData) {
    // Vehicles and the mech re-dock at their seeded spots, so the mode always
    // restores as FOOT wherever the player was standing.
    this.player.position.set(d.player.pos[0], d.player.pos[1], d.player.pos[2]);
    this.player.velocity.set(0, 0, 0);
    this.player.hp = Math.min(this.player.maxHp, Math.max(1, d.player.hp));
    this.mode = "FOOT";
    this.currentVehicle = null;
    this.mechBayOpen = false;
    this.player.group.visible = !this.firstPerson;

    this.player.inventory.slots = Inventory.fromJSON(d.inventory).slots;
    const w = d.weapon;
    this.currentWeapon =
      (w === "pipe_rifle" || w === "scrap_shotgun") && this.player.inventory.has(w) ? w : "pulse";
    this.refreshWeaponProp();

    this.quest =
      d.quest && QUESTS[d.quest.job]
        ? { def: QUESTS[d.quest.job], giverName: d.quest.giverName, progress: Math.max(0, d.quest.progress) }
        : null;

    this.generator.fuel = THREE.MathUtils.clamp(d.genFuel ?? 0, 0, 3);
    this.sky.setTime(d.timeOfDay);
    this.nightIndex = Math.max(0, Math.floor(d.nightIndex ?? 0));
    // Sync the edge detector so restoring at night doesn't re-trigger the count.
    this.wasNight = this.sky.nightness > 0.5;
    this.kills = Math.max(0, Math.floor(d.kills ?? 0));

    // Loot nodes rebuild in the same seeded order every boot, so indexes are
    // stable marks of what was already searched.
    if (Array.isArray(d.lootTaken)) {
      for (const i of d.lootTaken) {
        const n = this.loot.nodes[i];
        if (n && !n.taken) this.loot.take(n);
      }
    }
    // Opened supply caches stay opened (v2; the field is absent on v1 saves,
    // which simply means nothing has been opened yet).
    if (Array.isArray(d.cacheIds)) {
      for (const id of d.cacheIds) {
        const c = this.caches.find((x) => x.id === id);
        if (c && !c.opened) {
          c.opened = true;
          this.scene.remove(c.marker);
        }
      }
    }
    // GORETUSK ALPHA does not respawn once killed (v2; absent → alive).
    if (d.goretuskDead && this.goretusk && !this.goretusk.dead) {
      this.goretusk.dead = true;
      this.goretusk.hp = 0;
      this.scene.remove(this.goretusk.group);
      this.entities = this.entities.filter((e) => e !== this.goretusk);
    }
  }

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
    if (this.craftOpen || this.inventoryOpen || this.tradeOpen) { this.closePanels(); return; } // E also closes panels
    if (this.mode === "FOOT") {
      const inv = this.player.inventory;
      const node = this.loot.nearest(p);
      if (node) {
        if (node.fuel) {
          if (inv.spaceFor("fuel_can") < 1) { this.say("BACKPACK FULL — NO ROOM FOR THE CAN"); return; }
          this.loot.take(node);
          inv.add("fuel_can", 1);
          this.say(`+1 FUEL CAN · ⛽ ${inv.count("fuel_can")}`);
        } else {
          const space = inv.spaceFor("scrap");
          if (space < 1) { this.say("BACKPACK FULL — NO ROOM FOR SCRAP"); return; }
          const got = this.loot.take(node);
          const kept = inv.add("scrap", got);
          this.say(kept < got
            ? `+${kept} SCRAP · PACK FULL, LEFT ${got - kept} BEHIND`
            : `+${got} SCRAP · ${node.label}`);
        }
        this.audio.pickup();
        this.fx.salvageBurst(new THREE.Vector3(node.pos.x, node.pos.y + 0.5, node.pos.z));
        this.spawnRing(new THREE.Vector3(node.pos.x, node.pos.y + 0.1, node.pos.z), node.fuel ? 0xff5040 : 0xffc455);
        return;
      }
      // Feeding the generator is an E-interaction like everything else — same
      // key, same range test, one owner.
      if (this.generator.near(p)) {
        if (inv.count("fuel_can") > 0) {
          inv.remove("fuel_can", 1);
          this.generator.feed();
          this.say(`GENERATOR FUELED · ${this.generator.fuel.toFixed(1)} CANS`);
          this.audio.build();
        } else {
          this.say("GENERATOR IS DRY — FIND FUEL CANS");
        }
        return;
      }
      // SAL the Trader: E opens the barter panel. Checked before the helpers —
      // he keeps shop far from the base, but the contract is identical.
      if (this.nearTrader(p)) {
        this.openTrade();
        return;
      }
      // Sealed supply caches: one-time outer-ring reward, persisted in the save.
      const cache = this.nearestCache(p);
      if (cache) {
        this.openCache(cache);
        return;
      }
      // Fetch quests (item 11): talk to a base NPC, same E-interaction contract.
      const nh = this.nearestHelper(p);
      if (nh) {
        this.questTalk(nh);
        return;
      }
      // Workbench (item 14): E opens the crafting menu. The prop is looked up
      // by registry role at runtime, so if the world hasn't shipped one yet the
      // Homestead centre itself counts as the bench — a fallback, not an edit.
      // Checked AFTER the helpers: their talk radius sits inside the fallback's.
      if (this.nearWorkbench(p)) {
        this.openCraft();
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
    const inv = this.player.inventory;
    if (!this.quest) return `${h.name}: ACCEPT "${def.title}"`;
    if (this.quest.def.giver !== h.job) return `${h.name} — FINISH ${this.quest.giverName}'S ERRAND FIRST`;
    if (questComplete(this.quest)) return `${h.name}: TURN IN "${def.title}"`;
    const q = this.quest;
    switch (def.kind) {
      case "fuel":
        return inv.count("fuel_can") > 0
          ? `${h.name}: DEPOSIT FUEL (${q.progress}/${def.target})`
          : `${h.name}: BRING FUEL CANS (${q.progress}/${def.target})`;
      case "scrap":
        return inv.count("scrap") > 0
          ? `${h.name}: DEPOSIT SCRAP (${q.progress}/${def.target})`
          : `${h.name}: BRING SCRAP (${q.progress}/${def.target})`;
      default:
        return `${h.name}: ${q.progress}/${def.target} SHAMBLERS DOWN`;
    }
  }

  /** E pressed next to a helper: accept → deposit → turn in. */
  private questTalk(h: Helper) {
    const def = QUESTS[h.job];
    const inv = this.player.inventory;
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
      if (def.reward.scrap) inv.add("scrap", def.reward.scrap);
      if (def.reward.fuel) inv.add("fuel_can", def.reward.fuel);
      this.say(`QUEST COMPLETE — ${def.rewardText}`);
      this.audio.pickup();
      this.quest = null;
      return;
    }
    // Deposits hand over as much as the player carries in one press; the quest
    // store is separate from the generator tank, so the two never fight.
    if (def.kind === "fuel") {
      const carried = inv.count("fuel_can");
      if (carried <= 0) { this.say("NO FUEL CANS TO GIVE"); return; }
      const n = Math.min(def.target - q.progress, carried);
      inv.remove("fuel_can", n);
      q.progress += n;
      this.say(`DEPOSITED ${n} FUEL · ${q.progress}/${def.target}`);
      this.audio.build();
    } else if (def.kind === "scrap") {
      const carried = inv.count("scrap");
      if (carried <= 0) { this.say("NO SCRAP TO GIVE"); return; }
      const n = Math.min(def.target - q.progress, carried);
      inv.remove("scrap", n);
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
      // network id is deterministic per night + slot, so guests materialise
      // the same horde member when the host's snapshot names it
      const wid = `${i < runners ? "wr" : "wz"}:${this.nightIndex}:${i}`;
      this.netIds.set(zed, wid);
      this.netEntities.set(wid, zed);
    }
    this.waveActive = true;
    this.audio.waveHorn();
    this.say("WAVE NIGHT — THE HORDE COMES FOR THE BASE", 4);
    if (this.netRole === "HOST") this.net?.sendEvent({ k: "wave+" });
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
    if (this.netRole === "HOST") this.net?.sendEvent({ k: "wave-" });
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
    const w = this.mode === "MECH" ? null : WEAPONS[this.currentWeapon];
    this.attackCooldown = this.mode === "MECH" ? 0.62 : w!.cooldown;
    const origin = this.mode === "MECH" ? this.mech.group.position.clone().add(new THREE.Vector3(0, 3, 0)) : this.camera.position.clone();
    const baseDir = this.mode === "MECH"
      ? new THREE.Vector3(Math.sin(this.player.camYaw), 0, Math.cos(this.player.camYaw))
      : this.camera.getWorldDirection(new THREE.Vector3());
    const range = this.mode === "MECH" ? 7 : w!.range;
    const dmg = this.mode === "MECH" ? this.mech.stats.power : w!.damage;
    const pellets = w ? w.pellets : 1;
    if (this.mode === "MECH") this.audio.mechPunch();
    else if (this.currentWeapon === "pipe_rifle") this.audio.rifleShot();
    else if (this.currentWeapon === "scrap_shotgun") this.audio.shotgunBlast();
    else this.audio.playerShot();
    this.fx.muzzleFlash(origin.clone().addScaledVector(baseDir, 0.9), baseDir);
    for (let pi = 0; pi < pellets; pi++) {
      // Per-pellet cone spread: each pellet gets its own ray inside `spread`.
      const dir = baseDir.clone();
      if (w && w.spread > 0) {
        dir.x += (Math.random() - 0.5) * 2 * w.spread;
        dir.y += (Math.random() - 0.5) * 2 * w.spread;
        dir.z += (Math.random() - 0.5) * 2 * w.spread;
        dir.normalize();
      }
      const ray = new THREE.Raycaster(origin, dir, 0, range);
      let best: { e: Entity; d: number } | null = null;
      for (const e of this.entities) {
        if (e.dead || !e.hostile) continue;
        const hits = ray.intersectObject(e.group, true);
        if (hits.length && (!best || hits[0].distance < best.d)) best = { e, d: hits[0].distance };
      }
      // One tracer per trigger pull is enough to read; every pellet still
      // splashes its own impact so the spread is visible where it lands.
      const end = origin.clone().addScaledVector(dir, best ? best.d : Math.min(30, range));
      if (pi === 0) this.spawnTracer(origin, end, this.mode === "MECH" ? 0xffaa33 : w!.tracer);
      if (best) {
        this.fx.impact(end, dir.clone().negate());
        if (this.net && this.netRole === "GUEST") {
          // Host authority: the hit is reported, not applied. The host damages
          // the entity and the result comes back in the next snapshot.
          const nid = this.netIds.get(best.e);
          if (nid) this.net.hitEntity(nid, dmg);
        } else {
          best.e.damage(dmg);
          if (best.e.dead) this.onHostileKilled(best.e);
        }
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
    // Multiplayer pump: drain inbound queues, drive puppets, send outbound
    // snapshots — all inside the loop, never from a network callback.
    this.netTick(dt);
    const pp = this.player.position;
    for (const e of this.entities) {
      if (e.puppet) this.drivePuppet(e, dt); // guest: host-driven, no local AI
      else e.update(dt, pp);
      if (!e.dead && e.hostile && e.group.position.distanceTo(pp) < e.radius + 0.6) {
        this.damagePlayer(dt * (e instanceof Boss ? 30 : 8));
      }
    }
    for (const h of this.helpers) h.update(dt);
    this.trader.update(dt);
    this.loot.update(dt, pp);
    // unopened caches keep their shard breathing
    for (const c of this.caches) {
      if (c.opened) continue;
      c.phase += dt * 2.2;
      c.marker.position.y = c.pos.y + 1.3 + Math.sin(c.phase) * 0.11;
      c.marker.rotation.y += dt * 0.9;
    }
    // player-built defenses: adopt new placements twice a second, run every frame
    this.defenseScanT -= dt;
    if (this.defenseScanT <= 0) {
      this.defenseScanT = 0.5;
      this.scanDefenses();
      this.generator.syncExternalPoles();
    }
    this.updateDefenses(dt);
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
    // Autosave (item 16): real elapsed seconds, only while a run is in play.
    if (this.runStarted) {
      this.saveTimer += dt;
      if (this.saveTimer >= Game.AUTOSAVE_EVERY) {
        this.saveTimer = 0;
        this.saveNow();
      }
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
        // guests never spawn their own horde — the host's waves arrive as
        // snapshot-materialised puppets, announced by the wave+ event
        if (this.netRole !== "GUEST" && this.nightIndex % 3 === 0) this.startWave();
      } else if (!night && this.wasNight && this.waveActive) {
        this.endWave();
      }
      this.wasNight = night;
      if (this.waveActive && this.netRole !== "GUEST") {
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
            const cans = this.player.inventory.count("fuel_can");
            if (this.generator.near(pp)) {
              return cans > 0 ? `FEED GENERATOR ⛽×${cans}` : "GENERATOR · NEEDS FUEL";
            }
            const nh = this.nearestHelper(pp);
            if (nh) return this.questPrompt(nh);
            if (this.nearTrader(pp)) return "TRADE WITH SAL 💰";
            if (this.nearestCache(pp)) return "OPEN SUPPLY CACHE 💠";
            if (this.nearWorkbench(pp)) return "OPEN WORKBENCH 🔨";
            return nearestV ? `BOARD ${nearestV.name}` : nearMech ? "PILOT MECH" : null;
          })(),
      kills: this.kills,
      scrap: this.player.inventory.count("scrap"),
      fuel: this.player.inventory.count("fuel_can"),
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
      inventory: this.player.inventory.toJSON(),
      inventoryOpen: this.inventoryOpen,
      craftOpen: this.craftOpen,
      tradeOpen: this.tradeOpen,
      goretusk: this.goretusk && !this.goretusk.dead &&
        (this.goretusk.hp < this.goretusk.maxHp || this.goretusk.group.position.distanceTo(pp) < 30)
        ? { hp: Math.round(this.goretusk.hp), max: this.goretusk.maxHp }
        : null,
      turretHint: this.turretHint,
      weapon: {
        id: this.currentWeapon,
        name: WEAPONS[this.currentWeapon].name,
        glyph: WEAPONS[this.currentWeapon].glyph,
      },
      hasWeapons: this.ownedWeapons().length > 1,
      quality: this.quality,
      mp: this.net && this.netRole
        ? { code: this.net.worldId, role: this.netRole, selfId: this.net.playerId, players: this.net.roster }
        : null,
      playersOpen: this.playersOpen,
    });
  };

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    void this.net?.leave();
    this.net = null;
    this.remotes?.dispose();
    this.remotes = null;
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("mousemove", this.onMouseMove);
    window.removeEventListener("mousedown", this.onMouseDown);
    window.removeEventListener("wheel", this.onWheel);
    window.removeEventListener("pointercancel", this.onPointerCancel);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.touch?.dispose();
    this.audio.dispose();
    document.exitPointerLock?.();
    this.renderer.dispose();
  }
}
