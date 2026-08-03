// Sky dome, sun, weather, and the shadow rig.
//
// Three things here decide whether the world reads as real:
//   1. The shadow camera FOLLOWS the viewer. A fixed 160m ortho frustum on a
//      2048 map is ~8cm per texel — coarser than a person is wide, so small
//      objects self-shadow into solid black. Tracking the viewer with a 90m
//      frustum gives ~4.4cm texels, and bias/normalBias kill the remaining acne.
//   2. Fog, horizon, and sun all come from ONE set of colors, so distant
//      geometry dissolves into the same air the sky is made of.
//   3. That coupling is what makes a day/night cycle cheap: move the sun and
//      every dependent value — sky gradient, fog, light colour and intensity,
//      exposure — is derived from the same number rather than tuned separately.
import * as THREE from "./three";

/** Peak sun elevation at local noon, degrees. */
const MAX_ELEV = 58;

export interface SkyPalette {
  zenith: THREE.Color;
  horizon: THREE.Color;
  sun: THREE.Color;
  fog: THREE.Color;
  sunIntensity: number;
  hemiIntensity: number;
  ambientIntensity: number;
  fogNear: number;
  fogFar: number;
  exposure: number;
}

const hex = (h: number) => new THREE.Color(h);

// Keyframes by sun height. Night is deliberately not black: a wasteland lit only
// by starlight is unplayable, so it bottoms out at a cold, low, readable moonlight
// with exposure lifted to compensate.
const NIGHT: SkyPalette = {
  zenith: hex(0x0b1224), horizon: hex(0x1d2740), sun: hex(0xb9cbe8), fog: hex(0x1b2436),
  // Moonlight, not darkness. Measured against the render: at 0.22/0.36/0.11 the
  // world was unplayably black, so these are set by what stays legible on screen
  // rather than by physical plausibility.
  sunIntensity: 0.55, hemiIntensity: 0.72, ambientIntensity: 0.22,
  fogNear: 30, fogFar: 165, exposure: 1.75,
};
const TWILIGHT: SkyPalette = {
  zenith: hex(0x3d5480), horizon: hex(0xd97a3a), sun: hex(0xff9a52), fog: hex(0xa8724a),
  sunIntensity: 1.5, hemiIntensity: 0.7, ambientIntensity: 0.15,
  fogNear: 36, fogFar: 185, exposure: 1.25,
};
const DAY: SkyPalette = {
  zenith: hex(0x5d7f9e), horizon: hex(0xd7b98d), sun: hex(0xffd9a0), fog: hex(0xc3ab88),
  sunIntensity: 3.1, hemiIntensity: 1.05, ambientIntensity: 0.18,
  fogNear: 48, fogFar: 215, exposure: 1.15,
};

export const SKY = DAY;

function lerpPalette(a: SkyPalette, b: SkyPalette, t: number): SkyPalette {
  return {
    zenith: a.zenith.clone().lerp(b.zenith, t),
    horizon: a.horizon.clone().lerp(b.horizon, t),
    sun: a.sun.clone().lerp(b.sun, t),
    fog: a.fog.clone().lerp(b.fog, t),
    sunIntensity: THREE.MathUtils.lerp(a.sunIntensity, b.sunIntensity, t),
    hemiIntensity: THREE.MathUtils.lerp(a.hemiIntensity, b.hemiIntensity, t),
    ambientIntensity: THREE.MathUtils.lerp(a.ambientIntensity, b.ambientIntensity, t),
    fogNear: THREE.MathUtils.lerp(a.fogNear, b.fogNear, t),
    fogFar: THREE.MathUtils.lerp(a.fogFar, b.fogFar, t),
    exposure: THREE.MathUtils.lerp(a.exposure, b.exposure, t),
  };
}

/** Sun direction for a normalised time of day (0 midnight · 0.25 sunrise · 0.5 noon). */
export function sunDirectionAt(t01: number): THREE.Vector3 {
  const elev = THREE.MathUtils.degToRad(Math.sin((t01 - 0.25) * Math.PI * 2) * MAX_ELEV);
  const azim = THREE.MathUtils.degToRad(90 + (t01 - 0.25) * 360);
  return new THREE.Vector3(
    Math.cos(elev) * Math.sin(azim),
    Math.sin(elev),
    Math.cos(elev) * Math.cos(azim)
  ).normalize();
}

export function sunDirection(): THREE.Vector3 {
  return sunDirectionAt(0.42);
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Analytic gradient + sun disc + stars. The tone-mapping and colorspace pars are
// already in three's ShaderMaterial prefix; only the apply chunks belong here.
const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uNight;
  uniform float uDust;
  varying vec3 vDir;

  float h21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec3 d = normalize(vDir);

    // Compressed gradient: haze piles up at the horizon, thins toward zenith.
    float t = pow(clamp(d.y, 0.0, 1.0), 0.42);
    vec3 col = mix(uHorizon, uZenith, t);
    col = mix(col, uHorizon * 0.7, smoothstep(0.0, -0.18, d.y));

    // Stars fade in with night and are washed out by dust.
    if (uNight > 0.01 && d.y > 0.02) {
      vec2 sp = floor(d.xz / max(d.y, 0.08) * 90.0);
      float star = smoothstep(0.988, 1.0, h21(sp)) * uNight * (1.0 - uDust) * smoothstep(0.02, 0.45, d.y);
      // faint twinkle so the field is not a static stipple
      star *= 0.75 + 0.25 * sin(h21(sp + 3.7) * 90.0);
      col += vec3(0.85, 0.9, 1.0) * star * 2.6;
    }

    // Sun: hard disc, tight bloom, wide forward scatter. Dust eats the disc.
    float sd = max(dot(d, uSunDir), 0.0);
    float clear = 1.0 - uDust * 0.85;
    col += uSunColor * pow(sd, 1400.0) * 8.0 * clear;
    col += uSunColor * pow(sd, 18.0) * 0.30 * clear;
    col += uSunColor * pow(sd, 3.0) * 0.10;

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  readonly sun: THREE.DirectionalLight;
  dir = sunDirectionAt(0.42);
  /** 0 midnight · 0.25 sunrise · 0.5 noon · 0.75 sunset */
  timeOfDay = 0.42;
  /** 0 clear · 1 full dust storm */
  dust = 0;
  private dome: THREE.Mesh;
  private shadowTarget = new THREE.Object3D();
  private hemi: THREE.HemisphereLight;
  private ambient: THREE.AmbientLight;
  private fogRef: THREE.Fog;
  private scene: THREE.Scene;
  private palette: SkyPalette = DAY;

  constructor(scene: THREE.Scene, opts: { shadowRadius?: number; shadowMapSize?: number } = {}) {
    this.scene = scene;
    const radius = opts.shadowRadius ?? 45;
    const mapSize = opts.shadowMapSize ?? 2048;

    this.fogRef = new THREE.Fog(DAY.fog.getHex(), DAY.fogNear, DAY.fogFar);
    scene.fog = this.fogRef;
    scene.background = DAY.fog.clone();

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: DAY.zenith.clone() },
          uHorizon: { value: DAY.horizon.clone() },
          uSunColor: { value: DAY.sun.clone() },
          uSunDir: { value: this.dir.clone() },
          uNight: { value: 0 },
          uDust: { value: 0 },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      })
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(DAY.sun.getHex(), DAY.sunIntensity);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(mapSize, mapSize);
    this.sun.shadow.camera.left = -radius;
    this.sun.shadow.camera.right = radius;
    this.sun.shadow.camera.top = radius;
    this.sun.shadow.camera.bottom = -radius;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    // Constant bias handles flat surfaces; normalBias pushes the sample along the
    // normal, which is what actually saves thin/small geometry from going black.
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.035;
    this.sun.target = this.shadowTarget;
    scene.add(this.sun, this.shadowTarget);

    this.hemi = new THREE.HemisphereLight(DAY.zenith.getHex(), 0x8a6a44, DAY.hemiIntensity);
    this.ambient = new THREE.AmbientLight(0xffffff, DAY.ambientIntensity);
    scene.add(this.hemi, this.ambient);

    this.applyTime();
  }

  /** Recompute every coupled value from time of day and weather. */
  applyTime() {
    this.dir = sunDirectionAt(this.timeOfDay);
    const h = this.dir.y; // -1 below horizon .. 1 overhead

    let p = h <= 0
      ? lerpPalette(NIGHT, TWILIGHT, THREE.MathUtils.smoothstep(h, -0.22, 0))
      : lerpPalette(TWILIGHT, DAY, THREE.MathUtils.smoothstep(h, 0, 0.34));

    // Dust thickens the air, mutes the sun and collapses draw distance.
    if (this.dust > 0) {
      const d = this.dust;
      const dustCol = hex(0xb08a5e);
      p = {
        ...p,
        fog: p.fog.clone().lerp(dustCol, d * 0.75),
        horizon: p.horizon.clone().lerp(dustCol, d * 0.6),
        zenith: p.zenith.clone().lerp(dustCol, d * 0.45),
        sunIntensity: p.sunIntensity * (1 - d * 0.62),
        hemiIntensity: p.hemiIntensity * (1 - d * 0.2),
        fogNear: THREE.MathUtils.lerp(p.fogNear, 8, d),
        fogFar: THREE.MathUtils.lerp(p.fogFar, 62, d),
      };
    }
    this.palette = p;

    const u = (this.dome.material as THREE.ShaderMaterial).uniforms;
    u.uZenith.value.copy(p.zenith);
    u.uHorizon.value.copy(p.horizon);
    u.uSunColor.value.copy(p.sun);
    u.uSunDir.value.copy(this.dir);
    u.uNight.value = this.nightness;
    u.uDust.value = this.dust;

    this.sun.color.copy(p.sun);
    this.sun.intensity = p.sunIntensity;
    this.hemi.color.copy(p.zenith);
    this.hemi.intensity = p.hemiIntensity;
    this.ambient.intensity = p.ambientIntensity;

    this.fogRef.color.copy(p.fog);
    this.fogRef.near = p.fogNear;
    this.fogRef.far = p.fogFar;
    (this.scene.background as THREE.Color).copy(p.fog);
  }

  get exposure() { return this.palette.exposure; }
  /** 0 by day, 1 deep night — lets callers boost emissive kit after dark. */
  get nightness() { return THREE.MathUtils.clamp(-this.dir.y * 4, 0, 1); }

  setTime(t01: number) {
    this.timeOfDay = ((t01 % 1) + 1) % 1;
    this.applyTime();
  }

  setDust(d: number) {
    this.dust = THREE.MathUtils.clamp(d, 0, 1);
    this.applyTime();
  }

  // Keep the shadow frustum centred on whoever the camera is following, snapped to
  // texel-sized steps so shadow edges don't crawl as the player walks.
  update(focus: THREE.Vector3) {
    const radius = this.sun.shadow.camera.right;
    const texel = (radius * 2) / this.sun.shadow.mapSize.x;
    const snap = (v: number) => Math.round(v / texel) * texel;
    const cx = snap(focus.x);
    const cz = snap(focus.z);
    this.shadowTarget.position.set(cx, 0, cz);
    this.shadowTarget.updateMatrixWorld();
    this.sun.position.set(cx, 0, cz).addScaledVector(this.dir, 120);
    this.sun.updateMatrixWorld();
    // Below the horizon it would light the world from underneath.
    this.sun.visible = this.dir.y > -0.03;
  }

  /** The dome rides with the camera so it never clips the far plane. */
  follow(cameraPos: THREE.Vector3) {
    this.dome.position.copy(cameraPos);
  }
}
