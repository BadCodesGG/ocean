import * as THREE from "three";
import { moonPosition, sunPosition, toDirection } from "./ephemeris";
import { fullscreenTriangle } from "./fullscreen";
import { SKY_BAKE_FRAGMENT, sunRadiance } from "./sky";

/**
 * Sun, moon, sky and exposure for a moment at a place. The sky is re-baked whenever the sun or moon
 * has moved enough to show (about every half minute in real time), or the clouds change.
 */

/** Full moonlight over sunlight, top of the atmosphere. */
const FULL_MOON = 2.5e-6;
/** The sky luminance the look was tuned at (dusk, sun 1.5° up), and the exposure that suited it. */
const REFERENCE_LUMINANCE = 0.195;
const REFERENCE_EXPOSURE = 0.6;
/**
 * Eyes and cameras only partly adapt to the dark: exposure follows the sky's brightness to this power,
 * so night stays night rather than being lifted to a grey day.
 */
const ADAPTATION = 0.88;
const MAX_EXPOSURE = 2.5e4;
const BAKE_INTERVAL_MS = 150;

function skyTarget(width: number, height: number, mipmaps: boolean) {
  return new THREE.WebGLRenderTarget(width, height, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    wrapS: THREE.RepeatWrapping,
    // Mipmaps are how the water blurs its reflection by roughness.
    minFilter: mipmaps ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: mipmaps,
  });
}

export class Lighting {
  /** Sky in the warped layout the dome and the water read. */
  readonly sky = skyTarget(2048, 1024, true);
  /** Image-based light for the buoy. */
  environment: THREE.Texture | null = null;
  readonly sunDir = new THREE.Vector3();
  /** Sunlight at the sea, after the atmosphere and any cloud in front of it. */
  readonly sunColor = new THREE.Color();
  /** The sun's disk colour: after the atmosphere only (the dome masks it by cloud per pixel). */
  readonly sunDisk = new THREE.Color();
  readonly moonDir = new THREE.Vector3();
  /** The moon's disk colour (sunlight scaled to moonlight, before phase). */
  readonly moonDisk = new THREE.Color();
  /** Moonlight arriving at the sea, phase included. */
  readonly moonColor = new THREE.Color();
  /** Exposure the scene is heading for, and how far toward night vision (0 day, 1 night). */
  targetExposure = REFERENCE_EXPOSURE;
  night = 0;
  sunElevation = 0;
  /** How much of the sun and moon the clouds let through, 0 to 1, read from the bake. */
  sunVisibility = 1;
  moonVisibility = 1;
  /** Mean sky colour a few degrees above the horizon, all round: the colour of haze, fog and rain. */
  readonly horizon = new THREE.Color();
  /** Bakes so far, for the smoke test and for spotting a bake-every-frame regression. */
  bakes = 0;
  /** What the warped sky was baked multiplied by: about 1 / its brightness, so any sky sits near 1. */
  skyScale = 1;
  private luminance = REFERENCE_LUMINANCE;
  moonElevation = 0;
  moonIllumination = 0;

  private readonly equirect = skyTarget(512, 256, false);
  private readonly material: THREE.RawShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  private readonly pmrem: THREE.PMREMGenerator;
  private baked = { sun: new THREE.Vector3(), moon: new THREE.Vector3(), clouds: -1, stormy: -1 };
  private readonly row = new Uint16Array(2048 * 4);
  /** A bake is a few full-resolution raymarches plus two readbacks: at most one every so often, so dragging a slider stays smooth. */
  private lastBake = -Infinity;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly latitude: number,
    private readonly longitude: number,
  ) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: "in vec3 position; void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }",
      fragmentShader: SKY_BAKE_FRAGMENT,
      uniforms: {
        sun: { value: this.sunDir },
        moon: { value: this.moonDir },
        moonScale: { value: 0 },
        resolution: { value: new THREE.Vector2() },
        cloudCover: { value: 0.4 },
        cloudSeed: { value: 3.7 },
        stormy: { value: 0 },
        warped: { value: 1 },
        skyScale: { value: 1 },
      },
    });
    const mesh = new THREE.Mesh(fullscreenTriangle, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
    this.pmrem = new THREE.PMREMGenerator(renderer);
  }

  /**
   * Move the sun and moon to `epochSeconds` under `cloudCover`, the deck `stormy` (0 to 1) of a rain
   * cloud; returns true if the sky was re-baked.
   */
  update(epochSeconds: number, cloudCover: number, stormy = 0): boolean {
    // Coarse steps, so a shower easing in re-bakes a handful of times rather than every frame.
    stormy = Math.round(stormy * 20) / 20;
    const sun = sunPosition(epochSeconds, this.latitude, this.longitude);
    const moon = moonPosition(epochSeconds, this.latitude, this.longitude);
    this.sunElevation = sun.elevation;
    this.moonElevation = moon.elevation;
    this.moonIllumination = moon.illumination;
    this.sunDir.set(...toDirection(sun));
    this.moonDir.set(...toDirection(moon));
    const moved = this.sunDir.angleTo(this.baked.sun) > 0.0015 || this.moonDir.angleTo(this.baked.moon) > 0.003;
    if (!moved && cloudCover === this.baked.clouds && stormy === this.baked.stormy) return false;
    const nowMs = performance.now();
    if (this.bakes > 0 && nowMs - this.lastBake < BAKE_INTERVAL_MS) return false;
    this.lastBake = nowMs;

    const dark: [number, number, number] = [0, 0, 0];
    this.sunDisk.setRGB(...(sun.elevation > -3 ? sunRadiance(this.sunDir.toArray() as [number, number, number]) : dark));
    this.sunColor.copy(this.sunDisk);
    const moonTransmitted = moon.elevation > -3 ? sunRadiance(this.moonDir.toArray() as [number, number, number]) : dark;
    this.moonDisk.setRGB(...moonTransmitted).multiplyScalar(FULL_MOON);
    // Moonlight falls off much faster than the lit fraction (the lunar phase law): about illumination^2.
    this.moonColor.copy(this.moonDisk).multiplyScalar(moon.illumination ** 2);

    const u = this.material.uniforms;
    u.moonScale.value = FULL_MOON * moon.illumination ** 2;
    u.cloudCover.value = cloudCover;
    u.stormy.value = stormy;
    const bake = (target: THREE.WebGLRenderTarget, warped: number) => {
      u.warped.value = warped;
      u.resolution.value.set(target.width, target.height);
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
    };
    const previous = this.renderer.getRenderTarget();
    // Scale from the last metering; if the sky turned out far brighter or darker (a jump in the
    // time of light), bake once more at the right scale.
    for (let pass = 0; pass < 2; pass++) {
      this.skyScale = 0.2 / this.luminance;
      u.skyScale.value = this.skyScale;
      bake(this.sky, 1);
      const before = this.luminance;
      this.meter(stormy);
      if (Math.abs(Math.log(this.luminance / before)) < Math.log(8)) break;
    }
    bake(this.equirect, 0);
    this.renderer.setRenderTarget(previous);
    this.environment?.dispose();
    this.environment = this.pmrem.fromEquirectangular(this.equirect.texture).texture;
    this.baked = { sun: this.sunDir.clone(), moon: this.moonDir.clone(), clouds: cloudCover, stormy };
    this.bakes++;
    // Direct light is what the clouds in front of the sun and moon let through.
    this.sunVisibility = this.cloudTransmission(this.sunDir);
    this.moonVisibility = this.cloudTransmission(this.moonDir);
    this.sunColor.multiplyScalar(this.sunVisibility);
    this.moonColor.multiplyScalar(this.moonVisibility);
    return true;
  }

  /** The bake's alpha (cloud transmission) toward a direction, averaged over a few texels. */
  private cloudTransmission(dir: THREE.Vector3): number {
    if (dir.y < 0) return 1;
    const phi = Math.atan2(dir.x, -dir.z);
    const elev = Math.asin(Math.min(1, dir.y));
    const u = phi / (2 * Math.PI) + 0.5;
    const v = 0.5 + 0.5 * Math.sqrt(elev / (Math.PI / 2));
    const x = Math.min(this.sky.width - 3, Math.max(0, Math.round(u * this.sky.width) - 1));
    const y = Math.min(this.sky.height - 3, Math.max(0, Math.round(v * this.sky.height) - 1));
    const px = new Uint16Array(3 * 3 * 4);
    this.renderer.readRenderTargetPixels(this.sky, x, y, 3, 3, px);
    let a = 0;
    for (let i = 3; i < px.length; i += 4) a += THREE.DataUtils.fromHalfFloat(px[i]);
    return Math.min(1, Math.max(0, a / 9));
  }

  /**
   * Meter like a camera: the mean luminance of the sky a few degrees above the horizon, all the way
   * round, read back from the bake (one small synchronous read per bake).
   */
  private meter(stormy: number) {
    // Row at 8° elevation in the warped layout: v = 0.5 + 0.5 sqrt(8/90).
    const y = Math.round((0.5 + 0.5 * Math.sqrt(8 / 90)) * this.sky.height);
    this.renderer.readRenderTargetPixels(this.sky, 0, y, this.sky.width, 1, this.row);
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < this.sky.width; i++) {
      const o = i * 4;
      r += THREE.DataUtils.fromHalfFloat(this.row[o]);
      g += THREE.DataUtils.fromHalfFloat(this.row[o + 1]);
      b += THREE.DataUtils.fromHalfFloat(this.row[o + 2]);
    }
    const n = this.sky.width * this.skyScale;
    this.horizon.setRGB(r / n, g / n, b / n);
    const luminance = Math.max(0.2126 * (r / n) + 0.7152 * (g / n) + 0.0722 * (b / n), 1e-12);
    this.luminance = luminance;
    const ratio = REFERENCE_LUMINANCE / luminance;
    // Under a storm the eye does not make up for the gloom: it is dark, and should look it.
    this.targetExposure = Math.min(MAX_EXPOSURE, REFERENCE_EXPOSURE * ratio ** (ADAPTATION * (1 - 0.45 * stormy)));
    // Night vision sets in over the last few stops toward darkness.
    this.night = THREE.MathUtils.smoothstep(Math.log10(ratio), 2.5, 5);
  }

  dispose() {
    this.sky.dispose();
    this.equirect.dispose();
    this.environment?.dispose();
    this.pmrem.dispose();
    this.material.dispose();
  }
}
