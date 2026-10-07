import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { ShaderPass } from "three/examples/jsm/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { conditions, rainIntensity, type Conditions, type WeatherPreset } from "@/lib/conditions";
import type { BuoyResponse } from "@/lib/snapshot";
import type { Sea } from "@/lib/stations";
import { atLocalMinutes } from "@/lib/zone";
import { BoatMotion, HANDLING, type Helm } from "./boat";
import { createBoat, type BoatModel } from "./boat-model";
import { createBuoy, lightPosition, updateBuoy } from "./buoy";
import { bearingVector, CameraRig, RigInput, type CameraMode, type RigContext } from "./camera";
import { Lighting } from "./lighting";
import { Ocean } from "./ocean";
import { DOME_FRAGMENT, DOME_VERTEX } from "./sky";
import { blendedSurface, Timeline } from "./timeline";
import { fullscreenTriangle } from "./fullscreen";
import { Wake } from "./wake";
import { OceanAudio } from "./audio";
import { Coast, FAR, loadCoast, NEAR } from "./coast";
import { pickQuality, QUALITY, ResolutionGovernor, type Quality, type QualityPreset } from "./quality";
import { Spray } from "./spray";
import { createRain, LensShader, lightning } from "./weather-fx";
import { createWater, polarGrid } from "./water";

/**
 * The scene: the sea at a CDIP buoy, rebuilt from the buoy's own motion, under the sun and moon of
 * the moment the waves were measured. Plain three.js, WebGL 2 only; React mounts it and draws the UI.
 */

export interface Look {
  /** Minutes after the station's local midnight to light the scene at, or null to follow the scene's clock. */
  lightAt: number | null;
  /** Cloud cover 0 to 1, or null for the weather model's current cover. */
  cloudCover: number | null;
  /** A weather preset, or null for the weather model's current weather. */
  weather: WeatherPreset | null;
}

export const LIVE: Look = { lightAt: null, cloudCover: null, weather: null };

export interface Status {
  /** UTC seconds the waves on screen were measured at. */
  sceneTime: number;
  /** UTC seconds the light is drawn for. */
  lightTime: number;
  /** Seconds the scene runs behind real time. */
  lag: number;
  /** The newest record has played out and the next has not arrived: the scene is looping it. */
  waiting: boolean;
  /** UTC start of the record now playing, to match it to the snapshot it came in. */
  recordStart: number;
  sunElevation: number;
  moonIllumination: number;
  cloudCover: number;
  /** The weather being drawn, live or chosen. */
  conditions: Conditions;
  camera: CameraMode;
  boat: BoatStatus | null;
  quality: QualityStatus;
  /** The land around the buoy: still loading, none in sight (or unreachable), or drawn. */
  coast: "loading" | "none" | "ready";
}

export interface QualityStatus {
  setting: Quality;
  /** The preset in use: the chosen one, or the one "auto" picked for this device. */
  preset: QualityPreset;
  /** Device pixels drawn per CSS pixel right now. */
  pixelRatio: number;
}

export type BoatKind = "none" | "console" | "skiff";

export interface BoatStatus {
  kind: BoatKind;
  knots: number;
  /** Compass bearing, degrees. */
  heading: number;
  /** Throttle lever, -0.3 to 1. */
  throttle: number;
}

export interface Running {
  setLook(look: Look): void;
  setCamera(mode: CameraMode): void;
  /** Back to the current mode's starting view. */
  resetView(): void;
  setBoat(kind: BoatKind): void;
  /** On-screen helm for touch: held throttle and rudder, as the keyboard would give. */
  setTouchHelm(helm: Helm): void;
  setQuality(quality: Quality): void;
  /** Sound volume, 0 (off) to 1. Call first from a click or tap: browsers start audio only then. */
  setSound(volume: number): void;
  /** A newer snapshot from the route: queues its record and refreshes the weather. */
  addSnapshot(snapshot: BuoyResponse): void;
  status(): Status;
  dispose(): void;
  /** Frames drawn, for the smoke test. */
  readonly frames: number;
  /** Internals for the screenshot and smoke scripts. */
  readonly debug: { renderer: THREE.WebGLRenderer; ocean: Ocean; camera: THREE.PerspectiveCamera; lighting: Lighting; timeline: Timeline; rig: CameraRig; spray: Spray };
}

export class UnsupportedError extends Error {}


export interface Place {
  /** IANA zone local times are counted in. */
  timeZone: string;
  /** Compass bearing the resting view faces. */
  facing: number;
  /** What is in the water, which sets its colour. */
  sea: Sea;
}

/**
 * Night vision, applied in linear light before tone mapping: toward the dark, colour drains and what
 * is left shifts blue (the Purkinje shift), as a person sees a moonlit sea.
 */
const NightShader = {
  uniforms: { tDiffuse: { value: null }, night: { value: 0 }, grey: { value: 0 } },
  vertexShader: "varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float night;
    uniform float grey;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      // Rain light is flat and grey: drops scatter every colour alike, and they are everywhere.
      c.rgb = mix(c.rgb, l * vec3(0.93, 0.98, 1.05), grey);
      gl_FragColor = vec4(mix(c.rgb, l * vec3(0.55, 0.75, 1.15), night * 0.85), c.a);
    }`,
};

/** The same brightness with no colour. */
function greyOf(c: THREE.Color): THREE.Color {
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return new THREE.Color(l, l, l);
}

export function startScene(canvas: HTMLCanvasElement, first: BuoyResponse, place: Place, initialLook: Look = LIVE, initialCamera: CameraMode = "float", initialQuality: Quality = "auto"): Running {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  } catch {
    throw new UnsupportedError("This browser cannot draw the ocean: it needs WebGL 2.");
  }
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    renderer.dispose();
    throw new UnsupportedError("This device cannot render to float textures, which the ocean needs.");
  }
  const gl = renderer.getContext();
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const devicePreset = pickQuality({
    gpu: String(gl.getParameter(debugInfo ? debugInfo.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? ""),
    coarse: window.matchMedia("(pointer: coarse)").matches,
    cores: navigator.hardwareConcurrency || 4,
    memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  });
  let quality = initialQuality;
  const preset = () => (quality === "auto" ? devicePreset : quality);
  const governor = new ResolutionGovernor();
  renderer.toneMapping = THREE.AgXToneMapping;
  // Shader info logs cost a synchronous driver round trip per program, and on Windows they are full
  // of harmless Direct3D constant-folding notes (X4122). Development keeps them; production does not.
  renderer.debug.checkShaderErrors = process.env.NODE_ENV !== "production";

  let look = initialLook;
  let weather = first.weather;
  const timeline = new Timeline(first.record, first.depth, Date.now() / 1000);
  const lighting = new Lighting(renderer, first.latitude, first.longitude);
  const ocean = new Ocean(first.spectrum);

  const scene = new THREE.Scene();
  const dome = new THREE.Mesh(
    fullscreenTriangle,
    new THREE.ShaderMaterial({
      // No glslVersion: three then compiles GLSL ES 3.00 with gl_FragColor mapped, which its tone-mapping chunks need.
      vertexShader: DOME_VERTEX,
      fragmentShader: DOME_FRAGMENT,
      uniforms: {
        sky: { value: lighting.sky.texture },
        skyScale: { value: 1 },
        sunDir: { value: lighting.sunDir },
        sunColor: { value: lighting.sunDisk },
        moonDir: { value: lighting.moonDir },
        moonColor: { value: lighting.moonDisk },
        exposure: { value: 1 },
        visibility: { value: 24_000 },
        flash: { value: 0 },
        inverseProjection: { value: new THREE.Matrix4() },
        cameraWorld: { value: new THREE.Matrix4() },
      },
      depthTest: false,
      depthWrite: false,
    }),
  );
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  scene.add(dome);

  const wake = new Wake(renderer);
  const water = createWater(ocean, lighting.sky.texture, wake, QUALITY[preset()].grid, place.sea);
  const wu = water.material.uniforms;
  wu.sunDir.value = lighting.sunDir;
  wu.sunColor.value = lighting.sunColor;
  wu.moonDir.value = lighting.moonDir;
  wu.moonColor.value = lighting.moonColor;
  scene.add(water);

  const buoy = createBuoy();
  scene.add(buoy);
  const sunLight = new THREE.DirectionalLight(0xffffff, 1);
  const moonLight = new THREE.DirectionalLight(0xffffff, 1);
  scene.add(sunLight, moonLight);
  // The Waverider's lamp, lighting its own hull while it flashes.
  const lamp = new THREE.PointLight(0xffcc55, 0, 6, 2);
  scene.add(lamp);
  // Its intensity toward the water: tuned so the flash draws a clear streak on a night sea.
  const FLASH = new THREE.Color(1, 0.8, 0.35).multiplyScalar(1.5e-4);

  // Far enough for mountains 60 km off, past the corners of the coast's outer square.
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100_000);
  // Floating 16 m from the buoy with the eye 1.2 m above the water, facing the station's bearing with
  // the buoy a few degrees left of centre. At Waimea that faces WNW into the swell; at dusk the sun
  // sets off to the left, so the hull is side-lit and the glitter runs down the frame.
  const rest = bearingVector(THREE.MathUtils.degToRad(place.facing - 6)).multiplyScalar(-16);
  rest.y = 1.2;
  const rig = new CameraRig(camera, rest, place.facing);
  const input = new RigInput(canvas);

  // Scene in linear HDR, a bloom only the brightest things reach, night vision, then tone mapping and sRGB.
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.45, 4);
  composer.addPass(bloom);
  const nightPass = new ShaderPass(NightShader);
  composer.addPass(nightPass);
  // Rain on the lens refracts the finished picture, so it comes after everything but tone mapping.
  const lensPass = new ShaderPass(LensShader);
  composer.addPass(lensPass);
  composer.addPass(new OutputPass());
  const rain = createRain();
  scene.add(rain);
  const spray = new Spray();
  scene.add(spray.points);
  const sprayUniforms = spray.points.material.uniforms;
  scene.fog = new THREE.FogExp2(0x000000, 0);
  const fog = scene.fog as THREE.FogExp2;
  /** Rain on the glass and in the air, eased so a shower gathers and dries over several seconds; it starts as it is. */
  let wet = rainIntensity(conditions(first.weather, initialLook.weather, initialLook.cloudCover).rain);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const ratio = Math.min(window.devicePixelRatio, QUALITY[preset()].pixelRatio) * (quality === "auto" ? governor.scale : 1);
    renderer.setPixelRatio(ratio);
    composer.setPixelRatio(ratio);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / Math.max(1, h);
    lensPass.uniforms.aspect.value = camera.aspect;
    // At least 62° across, so a phone held upright still sees the sea around the buoy.
    const across = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(42) / 2) * camera.aspect);
    const minAcross = THREE.MathUtils.degToRad(62);
    camera.fov = across >= minAcross ? 42 : Math.min(80, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(minAcross / 2) / camera.aspect)));
    camera.updateProjectionMatrix();
    // Point sizes are in pixels: a metre at a metre's distance, for the field of view just set.
    sprayUniforms.pixelScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  };
  let grid = QUALITY[preset()].grid;
  const applyQuality = () => {
    const q = QUALITY[preset()];
    if (q.grid !== grid) {
      water.geometry.dispose();
      water.geometry = polarGrid(q.grid);
      grid = q.grid;
    }
    rain.geometry.setDrawRange(0, q.rain * 2);
    spray.density = q.spray;
    bloom.enabled = q.bloom;
    resize();
  };
  applyQuality();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  const current = () => conditions(weather, look.weather, look.cloudCover);
  const lightTime = (sceneTime: number) => (look.lightAt === null ? sceneTime : atLocalMinutes(sceneTime, look.lightAt, place.timeZone));
  let exposure = -1;
  let last = performance.now();
  let frames = 0;
  let raf = 0;
  const flashAt = new THREE.Vector3();
  let playing = timeline.latest.record.start;
  let sceneTime = timeline.sceneTime(Date.now() / 1000);
  let mix = timeline.at(sceneTime);
  const rigContext: RigContext = {
    surface: (x, z) => blendedSurface(mix, x, -z, sceneTime),
    focus: new THREE.Vector3(),
    helm: null,
    heading: null,
  };
  rig.setMode(initialCamera, rigContext);

  let coast: Coast | null = null;
  let coastState: Status["coast"] = "loading";
  const coastAbort = new AbortController();
  void loadCoast(first.latitude, first.longitude, coastAbort.signal).then((data) => {
    if (coastAbort.signal.aborted) return;
    if (!data) {
      coastState = "none";
      return;
    }
    coast = new Coast(data, first.latitude, first.longitude, lighting.sky.texture);
    scene.add(coast.group);
    wu.coastNear.value = coast.nearTexture;
    wu.coastFar.value = coast.farTexture;
    wu.coastSpan.value.set(NEAR.extent, FAR.extent, 1);
    coastState = "ready";
  });

  let audio: OceanAudio | null = null;
  let hs = first.spectrum.hs;
  /** What the sound heard last frame; null until it first listens, so switching on starts from rest. */
  let heard: { eta: number; flash: number } | null = null;

  let boat: { kind: BoatKind; model: BoatModel; motion: BoatMotion } | null = null;
  let touchHelm: Helm = { throttle: 0, rudder: 0 };
  const helm: Helm = { throttle: 0, rudder: 0 };
  const hullInverse = wu.hullInverse.value as THREE.Matrix4;
  const setBoat = (kind: BoatKind) => {
    if (boat) {
      scene.remove(boat.model.group);
      boat.model.dispose();
      boat = null;
      wu.hullLines.value.set(0, 0, 1);
    }
    if (kind === "none") return;
    const model = createBoat(kind);
    // Put her in the water off the buoy, crossing the swell, where the resting view can see her.
    const start = bearingVector(THREE.MathUtils.degToRad(place.facing + 35)).multiplyScalar(45);
    const motion = new BoatMotion(HANDLING[kind], start.x, start.z, THREE.MathUtils.degToRad(place.facing - 80));
    motion.heave.x = blendedSurface(mix, start.x, -start.z, sceneTime).eta;
    scene.add(model.group);
    wu.hullLines.value.set(model.lines.length, model.lines.beam, model.lines.depth);
    boat = { kind, model, motion };
  };

  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const frameTime = (now - last) / 1000;
    const dt = Math.min(0.1, frameTime);
    last = now;
    if (quality === "auto" && governor.sample(frameTime)) resize();
    sceneTime = timeline.sceneTime(Date.now() / 1000);
    mix = timeline.at(sceneTime);
    playing = mix.current.record.start;

    const c = current();
    if (lighting.update(lightTime(sceneTime), c.cloudCover, wet)) {
      scene.environment = lighting.environment;
      dome.material.uniforms.skyScale.value = lighting.skyScale;
      wu.skyScale.value = lighting.skyScale;
    }
    sunLight.color.copy(lighting.sunColor);
    sunLight.position.copy(lighting.sunDir);
    moonLight.color.copy(lighting.moonColor);
    moonLight.position.copy(lighting.moonDir);
    // Eyes adjust over a second or two, in stops.
    exposure = exposure < 0 ? lighting.targetExposure : Math.exp(THREE.MathUtils.lerp(Math.log(exposure), Math.log(lighting.targetExposure), 1 - Math.exp(-dt * 1.5)));
    renderer.toneMappingExposure = exposure;
    // Bloom works on linear light before exposure; hold its threshold at the same brightness on screen.
    bloom.threshold = (4 * 0.6) / exposure;
    nightPass.uniforms.night.value = lighting.night;
    wu.windSpeed.value = c.wind;
    wu.seaHeight.value = hs;
    wet += (rainIntensity(c.rain) - wet) * (1 - Math.exp(-dt / 5));
    const flash = c.thunder ? lightning(now / 1000) : 0;
    wu.rain.value = wet;
    wu.visibility.value = c.visibility;
    wu.flash.value = flash;
    wu.time.value = now / 1000;
    dome.material.uniforms.visibility.value = c.visibility;
    dome.material.uniforms.flash.value = flash;
    if (coast) {
      coast.look.skyScale.value = lighting.skyScale;
      coast.look.visibility.value = c.visibility;
      coast.look.flash.value = flash;
    }
    // Fog on the buoy and the boat: the horizon's colour, thinning to 2% at the visibility.
    fog.color.copy(lighting.horizon).lerp(greyOf(lighting.horizon), wet * 0.7).multiplyScalar(1 + flash * 3);
    nightPass.uniforms.grey.value = wet * 0.65;
    fog.density = 1.98 / c.visibility;
    // Rain in the air falls with the wind (it blows toward the opposite of where it comes from).
    const ru = rain.material.uniforms;
    const toward = THREE.MathUtils.degToRad((weather?.windDirection ?? 60) + 180);
    const drift = Math.min(c.wind, 18) * 0.45;
    ru.fall.value.set(Math.sin(toward) * drift, -(7 + 2 * wet), -Math.cos(toward) * drift);
    ru.amount.value = wet;
    ru.time.value = now / 1000;
    ru.color.value.copy(lighting.horizon).multiplyScalar(0.35 * (1 + flash * 4));
    lensPass.uniforms.rain.value = wet;
    lensPass.uniforms.time.value = now / 1000;

    const flashing = updateBuoy(buoy, mix, sceneTime);
    if (boat) {
      // The keys steer the boat, except in fly, where they fly the camera.
      const keys = rig.mode !== "fly";
      helm.throttle = THREE.MathUtils.clamp((keys ? input.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]) : 0) + touchHelm.throttle, -1, 1);
      helm.rudder = THREE.MathUtils.clamp((keys ? input.axis(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]) : 0) + touchHelm.rudder, -1, 1);
      helm.neutral = keys && input.held("KeyX");
      boat.motion.step(dt, helm, rigContext.surface);
      boat.motion.apply(boat.model.group);
      hullInverse.copy(boat.model.group.matrixWorld).invert();
      wake.update(dt, { toBoat: hullInverse, centre: boat.model.group.position, lines: boat.model.lines, speed: boat.motion.speed, throttle: boat.motion.throttle });
      spray.update(dt, { world: boat.model.group.matrixWorld, lines: boat.model.lines, speed: boat.motion.speed, slam: boat.motion.slam, water: boat.motion.water });
      rigContext.focus.copy(boat.model.group.position);
      rigContext.helm = boat.model.helm;
      rigContext.heading = boat.motion.heading;
    } else {
      wake.update(dt, null);
      spray.update(dt, null);
      rigContext.focus.copy(buoy.position);
      rigContext.helm = null;
      rigContext.heading = null;
    }
    wu.foamField.value = wake.foam;
    wu.foamOn.value = wake.active ? 1 : 0;
    rig.update(dt, input, rigContext);
    rain.material.uniforms.eye.value.copy(camera.position);
    sprayUniforms.sunDir.value.copy(lighting.sunDir);
    sprayUniforms.sunColor.value.copy(lighting.sunColor);
    sprayUniforms.ambient.value.copy(lighting.horizon);
    dome.material.uniforms.inverseProjection.value.copy(camera.projectionMatrixInverse);
    dome.material.uniforms.cameraWorld.value.copy(camera.matrixWorld);

    if (audio) {
      const eta = rigContext.surface(camera.position.x, camera.position.z).eta;
      audio.update(dt, {
        hs,
        heaveRate: heard && dt > 0 ? (eta - heard.eta) / dt : 0,
        height: camera.position.y - eta,
        wind: c.wind,
        rain: wet,
        strike: flash > 0 && heard !== null && heard.flash === 0,
        boat: boat ? { throttle: boat.motion.throttle, speed: boat.motion.speed, distance: camera.position.distanceTo(boat.model.group.position) } : null,
      });
      heard = { eta, flash };
    }

    ocean.update(renderer, mix, sceneTime, now / 1000, camera.position);
    wu.eye.value.copy(camera.position);
    lightPosition(buoy, flashAt);
    lamp.position.copy(flashAt);
    lamp.intensity = flashing ? 1e-5 : 0;
    wu.flashPos.value.copy(flashAt);
    if (flashing) wu.flashColor.value.copy(FLASH);
    else wu.flashColor.value.setRGB(0, 0, 0);
    composer.render();
    frames++;
  };
  raf = requestAnimationFrame(frame);

  return {
    debug: { renderer, ocean, camera, lighting, timeline, rig, spray },
    get frames() {
      return frames;
    },
    setLook(next) {
      look = next;
    },
    setCamera(mode) {
      rig.setMode(mode, rigContext);
    },
    resetView() {
      rig.reset();
    },
    setBoat,
    setTouchHelm(next) {
      touchHelm = next;
    },
    setSound(volume) {
      if (volume > 0 && !audio) audio = new OceanAudio();
      audio?.setVolume(volume);
    },
    setQuality(next) {
      quality = next;
      governor.reset();
      applyQuality();
    },
    addSnapshot(snapshot) {
      timeline.add(snapshot.record);
      hs = snapshot.spectrum.hs;
      if (snapshot.weather) weather = snapshot.weather;
    },
    status() {
      const sceneTime = timeline.sceneTime(Date.now() / 1000);
      return {
        sceneTime,
        lightTime: lightTime(sceneTime),
        lag: timeline.lag,
        waiting: timeline.waiting(sceneTime),
        recordStart: playing,
        sunElevation: lighting.sunElevation,
        moonIllumination: lighting.moonIllumination,
        cloudCover: current().cloudCover,
        conditions: current(),
        camera: rig.mode,
        boat: boat
          ? { kind: boat.kind, knots: boat.motion.knots, heading: THREE.MathUtils.radToDeg(boat.motion.heading), throttle: boat.motion.throttle }
          : null,
        quality: { setting: quality, preset: preset(), pixelRatio: renderer.getPixelRatio() },
        coast: coastState,
      };
    },
    dispose() {
      cancelAnimationFrame(raf);
      observer.disconnect();
      input.dispose();
      setBoat("none");
      audio?.dispose();
      coastAbort.abort();
      if (coast) {
        scene.remove(coast.group);
        coast.dispose();
      }
      scene.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        // The shared full-screen triangle outlives any one scene.
        if (o.geometry !== fullscreenTriangle) o.geometry.dispose();
        for (const m of [o.material].flat()) m.dispose();
      });
      lamp.dispose();
      nightPass.material.dispose();
      lensPass.material.dispose();
      spray.dispose();
      composer.dispose();
      ocean.dispose();
      wake.dispose();
      lighting.dispose();
      renderer.dispose();
      // Browsers cap live WebGL contexts; give this one back rather than wait for collection.
      renderer.forceContextLoss();
    },
  };
}
