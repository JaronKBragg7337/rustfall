// Generator & floodlights — the base's night economy.
//
// A fuel-fed engine block sitting inside the compound walls. Feeding it a can
// (E, one can at a time) keeps it running; while it runs AND the sun is down it
// drives a ring of floodlight poles around the perimeter. One can burns over
// roughly one full night, so the daily loop is: scavenge cans by day, stay lit
// by night.
//
// Construction follows the same contract as everything else placed in the
// world: real dimensions, terrain-solved grounding, instanced tertiary bolts,
// and every placed piece registered with a role so the report can find it.
// Built in init() after loadAtlases() — constructing against an empty texture
// cache is how you get black slabs (doctrine Part 6B).
import * as THREE from "./three";
// Narrow barrel bypass, same pattern as ./three — SpotLight/PointLight are not
// part of the game-facing namespace yet.
import { SpotLight } from "three/src/lights/SpotLight.js";
import { PointLight } from "three/src/lights/PointLight.js";
import { registerAsset, assetRegistry, QUALITY } from "./constants";
import { surface, plain } from "./surface";
import { bev, part, flatBox, cyl, bolts, along, perimeter, seam, vent } from "./kit";
import { heightAt } from "./terrain";

/** Candela for a flood lamp at ~5 m throw — comparable to the low night sun. */
const SPOT_INTENSITY = 90;
const POINT_INTENSITY = 60;
/** Night-ness above which the lamps are worth their fuel. */
const DUSK = 0.45;

export class Generator {
  readonly group = new THREE.Group();
  /** Fuel remaining, in fractional cans. Burns down while running. */
  fuel = 0;
  /** Lamps are on: running and past dusk. */
  lit = false;
  private nightSeconds: number;
  private spots: SpotLight[] = [];
  private points: PointLight[] = [];
  private lampMat: THREE.MeshStandardMaterial;
  private pilotMat: THREE.MeshStandardMaterial;
  private phase = 0;

  /**
   * @param pos          where the unit sits (ground solved from terrain)
   * @param nightSeconds burn time per can — one can ≈ one full night
   * @param poleSpots    [x,z] sites for floodlight poles (already culled for device tier)
   */
  constructor(pos: THREE.Vector3, nightSeconds: number, poleSpots: Array<[number, number]>) {
    this.nightSeconds = nightSeconds;
    const px = pos.x, pz = pos.z;
    const py = heightAt(px, pz);
    this.group.position.set(px, py, pz);

    const paint = surface("IND02", { local: true, tile: 1.2, grime: 0.5, grimeHeight: 0.7 });
    const steel = plain(0x53504b, 0.42, 0.85);
    const dark = plain(0x33312e, 0.55, 0.8);
    const chrome = plain(0x9aa0a4, 0.22, 0.95);
    const panel = surface("MET09", { local: true, tile: 0.8, grime: 0.2 });
    const tankMat = surface("CRV07", { local: true, tile: 1.0, grime: 0.4, grimeHeight: 0.5 });

    // ── primary: skid frame + engine block ──
    for (const sx of [-0.32, 0.32]) {
      this.group.add(part(flatBox(0.12, 0.09, 1.06), dark, { pos: [sx, 0.045, 0] }));
    }
    for (const sz of [-0.42, 0.42]) {
      this.group.add(part(flatBox(0.86, 0.06, 0.12), dark, { pos: [0, 0.10, sz] }));
    }
    this.group.add(bev(0.78, 0.52, 0.90, paint, { pos: [0, 0.40, 0] }));
    // cylinder head + valve cover
    this.group.add(bev(0.46, 0.16, 0.52, surface("MET03", { local: true, tile: 1.1 }), { pos: [0, 0.74, 0.12] }));
    this.group.add(part(cyl(0.10, 0.10, 0.05, 10), dark, { pos: [0, 0.84, 0.12] })); // oil filler

    // ── secondary: fuel tank, exhaust, control box, cooling fan ──
    this.group.add(part(cyl(0.22, 0.22, 0.56, 14), tankMat, { pos: [0, 0.86, -0.30], rot: [0, 0, Math.PI / 2] }));
    this.group.add(part(cyl(0.045, 0.045, 0.06, 8), dark, { pos: [0.18, 1.09, -0.30] })); // filler neck
    this.group.add(part(cyl(0.065, 0.065, 0.03, 8), steel, { pos: [0.18, 1.13, -0.30] })); // cap
    // exhaust: muffler pot + stack + rain cap
    this.group.add(part(cyl(0.09, 0.09, 0.3, 10), dark, { pos: [0.30, 0.52, -0.28], rot: [0, 0, Math.PI / 2] }));
    this.group.add(part(cyl(0.04, 0.045, 0.62, 8), chrome, { pos: [0.34, 0.92, -0.28], rot: [0, 0, 0.08] }));
    this.group.add(part(cyl(0.07, 0.05, 0.06, 8), dark, { pos: [0.36, 1.24, -0.28] }));
    // control box with a live pilot lamp
    this.group.add(part(flatBox(0.30, 0.24, 0.10), panel, { pos: [0, 0.48, 0.47] }));
    this.pilotMat = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: 0x39ff7a, emissiveIntensity: 0, roughness: 0.4, metalness: 0.1 });
    this.group.add(part(flatBox(0.06, 0.06, 0.02), this.pilotMat, { pos: [0.08, 0.53, 0.525], shadow: false }));
    // pull-start housing + fan grille on the side
    this.group.add(part(cyl(0.16, 0.16, 0.08, 14), dark, { pos: [0.41, 0.42, 0.10], rot: [0, 0, Math.PI / 2] }));
    this.group.add(part(cyl(0.12, 0.12, 0.02, 14), steel, { pos: [0.455, 0.42, 0.10], rot: [0, 0, Math.PI / 2] }));
    this.group.add(vent(0.3, 0.2, steel, dark, { pos: [-0.40, 0.42, -0.10], rot: [0, -Math.PI / 2, 0] }));

    // ── tertiary: instanced bolt flanges, panel seams ──
    this.group.add(bolts(perimeter(0.70, 0.44, 0.452, 0.06, 4), steel, 0.013));
    this.group.add(bolts(along([-0.32, 0.11, -0.42], [-0.32, 0.11, 0.42], 4, [0, -Math.PI / 2, 0]), steel, 0.012));
    this.group.add(bolts(along([0.32, 0.11, -0.42], [0.32, 0.11, 0.42], 4, [0, Math.PI / 2, 0]), steel, 0.012));
    this.group.add(seam(0.84, dark, { pos: [0, 0.66, 0.452] }));

    this.group.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    registerAsset("generator", this.group, "GEN");

    // shared lamp lens material so every head flips with one assignment
    this.lampMat = new THREE.MeshStandardMaterial({ color: 0x2a2622, emissive: 0xffdf9e, emissiveIntensity: 0, roughness: 0.35, metalness: 0.2 });
    for (const [fx, fz] of poleSpots) this.buildPole(fx, fz, px, pz);

    // Optional: if the world shipped a watchtower spotlight fixture, power it too.
    // It is looked up by role at runtime, so its absence is a no-op, not an error.
    const fixture = assetRegistry.find((r) => r.role === "watchtower_spotlight_fixture");
    if (fixture) {
      const wp = new THREE.Vector3();
      fixture.object.getWorldPosition(wp);
      const spot = new SpotLight(0xffe6b8, 0, 55, 0.32, 0.5, 1.6);
      spot.position.copy(wp);
      const target = new THREE.Object3D();
      // aimed outward from the base centre, slightly downward
      const ox = wp.x - px, oz = wp.z - pz;
      const ol = Math.hypot(ox, oz) || 1e-4;
      target.position.set(wp.x + (ox / ol) * 26, heightAt(wp.x + (ox / ol) * 26, wp.z + (oz / ol) * 26), wp.z + (oz / ol) * 26);
      this.group.parent?.add(target);
      spot.target = target;
      this.group.parent?.add(spot);
      this.spots.push(spot);
    }
  }

  /** A perimeter floodlight: post, base flange, arm, lamp head, and its light. */
  private buildPole(x: number, z: number, baseX: number, baseZ: number) {
    const y = heightAt(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    // face outward from the compound so the lamps throw away from the walls
    g.rotation.y = Math.atan2(x - baseX, z - baseZ);

    const steel = plain(0x53504b, 0.42, 0.85);
    const dark = plain(0x33312e, 0.55, 0.8);
    g.add(part(cyl(0.24, 0.28, 0.12, 12), dark, { pos: [0, 0.06, 0] }));           // base flange
    g.add(bolts(along([-0.16, 0.13, 0], [0.16, 0.13, 0], 3, [0, 0, 0]), steel, 0.014));
    g.add(part(cyl(0.055, 0.075, 4.3, 10), steel, { pos: [0, 2.21, 0] }));          // post
    g.add(part(flatBox(0.1, 0.08, 0.9), steel, { pos: [0, 4.32, 0.28] }));          // arm
    // gimbal + lamp head, tilted down onto the ground it guards
    g.add(part(cyl(0.05, 0.05, 0.14, 8), dark, { pos: [0, 4.28, 0.66], rot: [Math.PI / 2, 0, 0] }));
    const head = bev(0.34, 0.22, 0.26, dark, { pos: [0, 4.16, 0.74], rot: [0.5, 0, 0] });
    g.add(head);
    g.add(part(flatBox(0.28, 0.16, 0.02), this.lampMat, { pos: [0, 4.07, 0.83], rot: [0.5, 0, 0], shadow: false }));

    if (QUALITY.mobile) {
      // phones: unshadowed point light, shorter throw — cheap and enough at arm's length
      const pt = new PointLight(0xffd9a0, 0, 22, 1.8);
      pt.position.set(0, 4.1, 0.7);
      g.add(pt);
      this.points.push(pt);
    } else {
      const spot = new SpotLight(0xffe0b0, 0, 34, 0.62, 0.5, 1.5);
      spot.position.set(0, 4.12, 0.7);
      const target = new THREE.Object3D();
      target.position.set(0, 0, 5.0);
      g.add(target);
      spot.target = target;
      g.add(spot);
      this.spots.push(spot);
    }
    registerAsset("floodlight", g, "AST");
    this.group.parent?.add(g); // parented when added to the scene; see addToScene
    this.poles.push(g);
  }

  private poles: THREE.Group[] = [];

  /** The scene attaches the group and its poles together. */
  addToScene(scene: THREE.Scene) {
    scene.add(this.group);
    for (const p of this.poles) if (!p.parent) scene.add(p);
    for (const s of this.spots) {
      if (!s.parent) scene.add(s);
      if (s.target && !s.target.parent) scene.add(s.target);
    }
  }

  get running() { return this.fuel > 0; }

  /** Player hands over one can. Storage is capped at three. */
  feed() { this.fuel = Math.min(3, this.fuel + 1); }

  /** Interaction range test, same spirit as the loot search radius. */
  near(p: THREE.Vector3, r = 3.0) {
    return Math.hypot(this.group.position.x - p.x, this.group.position.z - p.z) < r;
  }

  update(dt: number, nightness: number) {
    // one can over one night of run time; the tank visibly drains as it burns
    if (this.fuel > 0) this.fuel = Math.max(0, this.fuel - dt / this.nightSeconds);

    const wantLit = this.fuel > 0 && nightness > DUSK;
    if (wantLit !== this.lit) {
      this.lit = wantLit;
      for (const s of this.spots) s.intensity = wantLit ? SPOT_INTENSITY : 0;
      for (const p of this.points) p.intensity = wantLit ? POINT_INTENSITY : 0;
      this.lampMat.emissiveIntensity = wantLit ? 3.2 : 0;
    }

    // pilot lamp flickers with the engine so "running" reads at a glance
    this.phase += dt;
    this.pilotMat.emissiveIntensity = this.fuel > 0 ? 1.5 + Math.sin(this.phase * 9.3) * 0.55 : 0;
  }
}
