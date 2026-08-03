// Sky dome, sun, and the shadow rig.
//
// Two things here decide whether the world reads as real:
//   1. The shadow camera FOLLOWS the viewer. A fixed 160m ortho frustum on a
//      2048 map is ~8cm per texel — coarser than a person is wide, so small
//      objects self-shadow into solid black. Tracking the viewer with a 90m
//      frustum gives ~4.4cm texels, and bias/normalBias kill the remaining acne.
//   2. Fog, horizon, and sun all come from ONE set of colors, so distant
//      geometry dissolves into the same air the sky is made of.
import * as THREE from "three";

// Sun elevation/azimuth in degrees — low and to the side for long raking shadows.
const SUN_ELEV = 19;
const SUN_AZIM = 118;

export const SKY = {
  zenith: new THREE.Color(0x5d7f9e),
  horizon: new THREE.Color(0xd7b98d),
  sun: new THREE.Color(0xffd9a0),
  fog: new THREE.Color(0xc3ab88),
  // Far plane sits inside the terrain overrun, so the ground fades into the same
  // air the horizon is made of instead of ending at a visible edge.
  fogNear: 48,
  fogFar: 215,
} as const;

export function sunDirection(): THREE.Vector3 {
  const e = THREE.MathUtils.degToRad(SUN_ELEV);
  const a = THREE.MathUtils.degToRad(SUN_AZIM);
  return new THREE.Vector3(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a)).normalize();
}

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Analytic gradient + sun disc. The includes give us the renderer's tone mapping
// and output color space, so the sky lands in the same response curve as the scene.
const SKY_FRAG = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  varying vec3 vDir;

  // The tone-mapping and colorspace *pars* are already in three's ShaderMaterial
  // prefix; only the apply chunks belong in the body.
  void main() {
    vec3 d = normalize(vDir);

    // Compressed gradient: haze piles up at the horizon, thins toward zenith.
    float t = pow(clamp(d.y, 0.0, 1.0), 0.42);
    vec3 col = mix(uHorizon, uZenith, t);

    // Below the horizon line the air picks up dust off the ground.
    col = mix(col, uHorizon * 0.7, smoothstep(0.0, -0.18, d.y));

    // Sun: hard disc, tight bloom, wide forward scatter.
    float sd = max(dot(d, uSunDir), 0.0);
    col += uSunColor * pow(sd, 1400.0) * 8.0;
    col += uSunColor * pow(sd, 18.0) * 0.30;
    col += uSunColor * pow(sd, 3.0) * 0.10;

    gl_FragColor = vec4(col, 1.0);

    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class Sky {
  readonly sun: THREE.DirectionalLight;
  readonly dir = sunDirection();
  private dome: THREE.Mesh;
  private shadowTarget = new THREE.Object3D();

  constructor(scene: THREE.Scene, opts: { shadowRadius?: number; shadowMapSize?: number } = {}) {
    const radius = opts.shadowRadius ?? 45;
    const mapSize = opts.shadowMapSize ?? 2048;

    scene.fog = new THREE.Fog(SKY.fog.getHex(), SKY.fogNear, SKY.fogFar);
    scene.background = SKY.fog.clone();

    this.dome = new THREE.Mesh(
      new THREE.SphereGeometry(1000, 32, 20),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          uZenith: { value: SKY.zenith.clone() },
          uHorizon: { value: SKY.horizon.clone() },
          uSunColor: { value: SKY.sun.clone() },
          uSunDir: { value: this.dir.clone() },
        },
        vertexShader: SKY_VERT,
        fragmentShader: SKY_FRAG,
      })
    );
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -1000;
    scene.add(this.dome);

    this.sun = new THREE.DirectionalLight(SKY.sun.getHex(), 3.1);
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

    // Sky bounce: cool from above, warm dust bounce from the ground.
    scene.add(new THREE.HemisphereLight(SKY.zenith.getHex(), 0x8a6a44, 1.05));
    // Flat fill so shadowed faces keep readable material detail.
    scene.add(new THREE.AmbientLight(0xffffff, 0.18));
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
  }

  // The dome rides with the camera so it never clips the far plane.
  follow(cameraPos: THREE.Vector3) {
    this.dome.position.copy(cameraPos);
  }
}
