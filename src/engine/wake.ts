import * as THREE from "three";
import { HULL_GLSL } from "./boat-model";
import { fullscreenTriangle } from "./fullscreen";
import { FULLSCREEN_VERTEX } from "./shaders";

/**
 * The boat's own waves and foam.
 *
 * Waves: the hull is a moving pressure source, modelled as a trail of impulses it leaves behind it.
 * Each impulse spreads as a Cauchy-Poisson ring, whose deep-water solution far from the source is
 *
 *   η(r, t) ≈ A t² / r³ · cos(g t² / 4r)
 *
 * (Lamb, Hydrodynamics §255). Summing the rings of the whole trail gives the Kelvin wake exactly as
 * the sea makes it: the 19.5° V, the transverse and diverging crests, and a wake that curves when the
 * boat turns. It is evaluated wherever the water is drawn, so it has no grid, no resolution limit and
 * nothing to go unstable; the water shader includes KELVIN_GLSL and kelvinAt mirrors it for tests.
 *
 * Foam: a grid that travels with the boat, fed by the hull's contact line under way and the propeller
 * wash. It stays where it was made and fades over a few seconds.
 */

export const TRAIL_POINTS = 128;
/** Seconds between trail points: 128 of them hold the last 19 seconds. */
export const TRAIL_SPACING = 0.15;
const G = 9.81;
/** Core radius, metres: the rings are not resolved inside a boat length of their source. */
const CORE = 3;
/**
 * A hull is not a point: it cannot make waves much shorter than itself. Each ring's spectrum rolls off
 * as exp(-(k/K0)²), K0 about 4/L for a 7.6 m hull. This is also what narrows a fast boat's wake below
 * 19.5° (Rabaud and Moisy, 2013), as real planing-boat wakes are.
 */
const K0 = 0.5;
/** Metres of wave per unit of trail strength; set for a 25 ft boat at 20 to 30 knots. */
const WAKE_GAIN = 6;

export const KELVIN_GLSL = /* glsl */ `
uniform sampler2D trail;
/** The trail's centre and reach (x, z, radius), and 1 when there is a trail at all. */
uniform vec4 trailBounds;
/** Height of the wake at a point, and its slope (d/dx, d/dz). */
vec3 kelvin(vec2 p) {
  vec3 sum = vec3(0.0);
  if (trailBounds.w == 0.0 || distance(p, trailBounds.xy) > trailBounds.z) return sum;
  for (int j = 0; j < ${TRAIL_POINTS}; j++) {
    vec4 e = texelFetch(trail, ivec2(j, 0), 0);
    if (e.w <= 0.0) continue;
    vec2 d = p - e.xy;
    float r2 = dot(d, d) + ${(CORE * CORE).toFixed(1)};
    float r = sqrt(r2);
    float t = e.z;
    // Local wavenumber of the ring here: dφ/dr for φ = g t² / 4r.
    float k = ${G.toFixed(2)} * t * t / (4.0 * r2);
    float q = k / ${K0.toFixed(3)};
    if (q > 2.6) continue;
    float fade = exp(-q * q);
    float a = e.w * fade * t * t / (r2 * r);
    float phase = k * r;
    sum.x += a * cos(phase);
    // The phase changes far faster than the envelope: d/dr (a cos φ) ≈ a k sin φ.
    sum.yz += d / r * (a * k * sin(phase));
  }
  return sum;
}
`;

/** The same sum on the CPU: (height, d/dx, d/dz) at (x, z) for a trail packed as KELVIN_GLSL reads it. */
export function kelvinAt(trail: Float32Array, x: number, z: number): [number, number, number] {
  let h = 0;
  let gx = 0;
  let gz = 0;
  for (let j = 0; j < TRAIL_POINTS; j++) {
    const [ex, ez, t, w] = trail.subarray(j * 4, j * 4 + 4);
    if (w <= 0) continue;
    const dx = x - ex;
    const dz = z - ez;
    const r2 = dx * dx + dz * dz + CORE * CORE;
    const r = Math.sqrt(r2);
    const k = (G * t * t) / (4 * r2);
    const q = k / K0;
    if (q > 2.6) continue;
    const fade = Math.exp(-q * q);
    const a = (w * fade * t * t) / (r2 * r);
    h += a * Math.cos(k * r);
    gx += (dx / r) * a * k * Math.sin(k * r);
    gz += (dz / r) * a * k * Math.sin(k * r);
  }
  return [h, gx, gz];
}

/** How strongly a hull at this speed (m/s) disturbs the water per trail point. */
export function trailStrength(speed: number): number {
  const v = Math.abs(speed);
  return WAKE_GAIN * THREE.MathUtils.smoothstep(v, 1, 8) * (0.5 + 0.5 * Math.min(v / 12, 1.5));
}

/** Where the boat has been: a ring of the last TRAIL_POINTS positions, packed for the GPU each frame. */
export class Trail {
  readonly data = new Float32Array(TRAIL_POINTS * 4);
  readonly texture = new THREE.DataTexture(this.data, TRAIL_POINTS, 1, THREE.RGBAFormat, THREE.FloatType);
  readonly bounds = new THREE.Vector4();
  private readonly points: { x: number; z: number; time: number; strength: number }[] = [];
  private sinceLast = Infinity;

  constructor() {
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
  }

  /** Record the boat at `time` (seconds, any steady clock) and repack the ages. */
  update(time: number, dt: number, boat: { x: number; z: number; speed: number } | null) {
    this.sinceLast += dt;
    if (boat && this.sinceLast >= TRAIL_SPACING) {
      this.sinceLast = 0;
      this.points.push({ x: boat.x, z: boat.z, time, strength: trailStrength(boat.speed) });
      if (this.points.length > TRAIL_POINTS) this.points.shift();
    }
    if (!boat) this.points.length = 0;
    this.data.fill(0);
    let cx = 0;
    let cz = 0;
    for (const p of this.points) {
      cx += p.x / this.points.length;
      cz += p.z / this.points.length;
    }
    let reach = 0;
    const oldest = TRAIL_POINTS * TRAIL_SPACING;
    this.points.forEach((p, i) => {
      const age = time - p.time;
      // The oldest few ease out, so the end of the trail leaves no edge in the water.
      const w = p.strength * (1 - THREE.MathUtils.smoothstep(age, oldest - 4, oldest));
      this.data.set([p.x, p.z, age, w], i * 4);
      reach = Math.max(reach, Math.hypot(p.x - cx, p.z - cz));
    });
    // Rings travel on past the trail: the long transverse waves reach about 60 m beyond it.
    this.bounds.set(cx, cz, reach + 90, this.points.length ? 1 : 0);
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
  }
}

export const FOAM_TEXELS = 512;
/** Metres per texel: a 256 m square around the boat. */
export const FOAM_TEXEL = 0.5;
const STEP = 1 / 60;

const FOAM_FRAGMENT = /* glsl */ `
precision highp float;
uniform sampler2D state;
/** Texels the grid moved this step: read the old state that far over. */
uniform ivec2 shift;
/** World to boat; the hull's length and beam. */
uniform mat4 hull;
uniform vec3 hullLines;
/** World position of texel (0, 0)'s centre. */
uniform vec2 origin;
uniform float texel;
/** Forward speed (m/s) and throttle, for the contact line and the propeller wash. */
uniform float speed;
uniform float throttle;
uniform float fade;
out vec4 color;
${HULL_GLSL}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p + shift;
  float foam = 0.0;
  if (all(greaterThanEqual(q, ivec2(0))) && all(lessThan(q, ivec2(${FOAM_TEXELS})))) foam = texelFetch(state, q, 0).x * fade;
  vec2 world = origin + vec2(p) * texel;
  vec3 local = (hull * vec4(world.x, 0.0, world.y, 1.0)).xyz;
  float s = (hullLines.x * 0.5 - local.z) / hullLines.x;
  float v = clamp(abs(speed) / 9.0, 0.0, 1.0);
  // The contact line: white water peeling off the hull under way, strongest at the bow.
  if (s > 0.0 && s < 1.0) {
    float edge = hullHalfBeamAt(s, 0.0, hullLines.y) - abs(local.x);
    foam = max(foam, v * (0.3 + 0.7 * s) * (1.0 - smoothstep(0.0, 0.45, abs(edge + 0.1))));
  }
  // Propeller wash: a churned lane behind the transom, widening aft.
  float aft = local.z - hullLines.x * 0.5;
  if (aft > 0.0 && aft < 14.0) {
    float width = 0.8 + aft * 0.14;
    float wash = (1.0 - smoothstep(width * 0.45, width, abs(local.x))) * (1.0 - aft / 14.0);
    foam = max(foam, wash * clamp(abs(throttle) * 1.2, 0.0, 1.0) * (0.3 + 0.6 * v));
  }
  // Fade out at the grid's edge rather than cut off.
  vec2 border = min(vec2(p), vec2(${FOAM_TEXELS - 1}) - vec2(p));
  color = vec4(min(foam, 1.0) * smoothstep(0.0, 24.0, min(border.x, border.y)), 0.0, 0.0, 0.0);
}
`;

function foamTarget() {
  return new THREE.WebGLRenderTarget(FOAM_TEXELS, FOAM_TEXELS, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    generateMipmaps: false,
  });
}

export interface WakeSource {
  toBoat: THREE.Matrix4;
  centre: THREE.Vector3;
  lines: { length: number; beam: number; depth: number };
  speed: number;
  throttle: number;
}

export class Wake {
  readonly trail = new Trail();
  private targets = [foamTarget(), foamTarget()];
  private current = 0;
  private readonly material: THREE.RawShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera();
  /** World position of foam texel (0, 0)'s centre. */
  readonly origin = new THREE.Vector2();
  private started = false;
  private accumulator = 0;
  private clock = 0;
  /** False until a boat is on the water; the water skips the foam lookups. */
  active = false;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FOAM_FRAGMENT,
      uniforms: {
        state: { value: null },
        shift: { value: new THREE.Vector2() },
        hull: { value: new THREE.Matrix4() },
        hullLines: { value: new THREE.Vector3() },
        origin: { value: new THREE.Vector2() },
        texel: { value: FOAM_TEXEL },
        speed: { value: 0 },
        throttle: { value: 0 },
        fade: { value: Math.exp(-STEP / 3.5) },
      },
      depthTest: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(fullscreenTriangle, this.material);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.clear();
  }

  get foam(): THREE.Texture {
    return this.targets[this.current].texture;
  }

  private clear() {
    const previous = this.renderer.getRenderTarget();
    for (const t of this.targets) {
      this.renderer.setRenderTarget(t);
      this.renderer.clear(true, false, false);
    }
    this.renderer.setRenderTarget(previous);
    this.started = false;
    this.active = false;
  }

  /** Advance by `dt` seconds with the boat where it now is, or null when there is none. */
  update(dt: number, boat: WakeSource | null) {
    this.clock += dt;
    this.trail.update(this.clock, dt, boat ? { x: boat.centre.x, z: boat.centre.z, speed: boat.speed } : null);
    if (!boat) {
      if (this.active) this.clear();
      return;
    }
    this.active = true;
    const u = this.material.uniforms;
    const half = (FOAM_TEXELS / 2) * FOAM_TEXEL;
    const ox = Math.round((boat.centre.x - half) / FOAM_TEXEL) * FOAM_TEXEL;
    const oz = Math.round((boat.centre.z - half) / FOAM_TEXEL) * FOAM_TEXEL;
    if (!this.started) this.origin.set(ox, oz);
    this.started = true;
    u.hull.value.copy(boat.toBoat);
    u.hullLines.value.set(boat.lines.length, boat.lines.beam, boat.lines.depth);
    u.speed.value = boat.speed;
    u.throttle.value = boat.throttle;
    this.accumulator = Math.min(this.accumulator + dt, 4 * STEP);
    const steps = Math.floor(this.accumulator / STEP);
    if (steps === 0) return;
    this.accumulator -= steps * STEP;
    const previous = this.renderer.getRenderTarget();
    for (let i = 0; i < steps; i++) {
      // Keep the grid centred on the boat, moving it in whole texels so the foam stays put in the water.
      u.shift.value.set(Math.round((ox - this.origin.x) / FOAM_TEXEL), Math.round((oz - this.origin.y) / FOAM_TEXEL));
      this.origin.set(ox, oz);
      u.origin.value.copy(this.origin);
      u.state.value = this.targets[this.current].texture;
      const next = 1 - this.current;
      this.renderer.setRenderTarget(this.targets[next]);
      this.renderer.render(this.scene, this.camera);
      this.current = next;
    }
    this.renderer.setRenderTarget(previous);
  }

  dispose() {
    for (const t of this.targets) t.dispose();
    this.material.dispose();
    this.trail.dispose();
  }
}
