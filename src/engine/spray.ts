import * as THREE from "three";
import { halfBeamAt, type HullLines } from "./boat-model";

/**
 * Spray off a boat under way: the sheet a planing hull peels off either side of its bow where the
 * water meets it, bursts when the bow slams into a wave, and a little white water kicked up behind
 * the propeller. Each particle is a drop or a puff of mist flying ballistically with air drag, lit by
 * the sun (brightest looking toward it, as drops scatter forward) and the sky, and fogged like the rest.
 */

export interface SpraySource {
  /** The hull's world matrix (boat axes: x starboard, y up, z aft). */
  world: THREE.Matrix4;
  lines: HullLines;
  /** Forward speed through the water, m/s. */
  speed: number;
  /** How hard the bow is driving down into the water, m/s (0 when it is lifting). */
  slam: number;
  /** Height of the sea under the boat, m: drops that fall back below it are gone. */
  water: number;
}

const G = 9.81;
/** Drops lose speed to the air: drag per second on their velocity, spread per drop by size. */
const DRAG = 1.6;

export class Spray {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  /** Per particle: age (s), lifetime (s), size (m), floor (m). */
  private readonly state: Float32Array;
  private readonly attrs: { position: THREE.BufferAttribute; life: THREE.BufferAttribute };
  private readonly lifeOut: Float32Array;
  private next = 0;
  private owed = 0;
  private live = 0;
  /** Share of the full spray drawn, for the picture quality setting. */
  density = 1;

  constructor(private readonly capacity = 12000) {
    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.state = new Float32Array(capacity * 4);
    this.lifeOut = new Float32Array(capacity * 2);
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage);
    const life = new THREE.BufferAttribute(this.lifeOut, 2).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", position);
    geometry.setAttribute("life", life);
    this.attrs = { position, life };
    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          sunColor: { value: new THREE.Color() },
          ambient: { value: new THREE.Color() },
          pixelScale: { value: 1 },
        },
      ]),
      vertexShader: /* glsl */ `
        attribute vec2 life;
        uniform float pixelScale;
        varying float vAlpha;
        varying float vMist;
        varying vec3 vView;
        #include <fog_pars_vertex>
        /** Sizes at or above this are mist puffs; below it, drops. */
        const float MIST = 0.3;
        void main() {
          // life.x: age over lifetime; life.y: size in metres (0 when the slot is empty).
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float t = life.x;
          vMist = step(MIST, life.y);
          // Mist billows as it drifts; a drop stays a drop.
          float size = life.y * (1.0 + 1.5 * t * vMist);
          float px = size * pixelScale / max(0.1, -mvPosition.z);
          // A drop close to the eye is a blur a few pixels across, not a disc: it moves too fast to see whole.
          float drawn = mix(clamp(px, 1.0, 3.5), max(1.0, px), vMist);
          gl_PointSize = life.y > 0.0 ? drawn : 0.0;
          // Drops smaller than a pixel still count, as fainter pixel-sized dots.
          float cover = min(1.0, px * px);
          vAlpha = (1.0 - t) * smoothstep(0.0, 0.05, t) * cover * mix(0.8, 0.07 * (1.0 - t), vMist);
          vView = normalize(cameraPosition - (modelMatrix * vec4(position, 1.0)).xyz);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 sunDir;
        uniform vec3 sunColor;
        uniform vec3 ambient;
        varying float vAlpha;
        varying float vMist;
        varying vec3 vView;
        #include <fog_pars_fragment>
        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(p, p);
          if (r2 > 1.0) discard;
          // Drops scatter light mostly onward: spray glows when the sun is behind it.
          float onward = pow(max(0.0, dot(-vView, sunDir)), 6.0);
          vec3 color = ambient * 0.9 + sunColor * (0.3 + 2.5 * onward) / 3.14159265 * step(0.0, sunDir.y);
          // A drop is a bright bead, not a puff: hard-ish edge.
          gl_FragColor = vec4(color, vAlpha * mix(smoothstep(1.0, 0.3, r2), (1.0 - r2) * (1.0 - r2), vMist));
          #include <fog_fragment>
        }`,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  private emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, floor: number) {
    const i = this.next;
    this.next = (this.next + 1) % this.capacity;
    this.position.set([x, y, z], i * 3);
    this.velocity.set([vx, vy, vz], i * 3);
    this.state.set([0, life, size, floor], i * 4);
  }

  update(dt: number, source: SpraySource | null) {
    const born = source ? this.spawn(dt, source) : 0;
    // Nothing in the air and nothing thrown: the buffers already hold only dead drops.
    if (this.live === 0 && born === 0) return;
    let live = 0;
    const s = this.state;
    for (let i = 0; i < this.capacity; i++) {
      const o = i * 4;
      if (s[o + 1] <= 0) {
        this.lifeOut[i * 2 + 1] = 0;
        continue;
      }
      s[o] += dt;
      const p = i * 3;
      // Small drops slow faster.
      const drag = Math.exp(-dt * DRAG / Math.max(0.3, s[o + 2] * 8));
      this.velocity[p] *= drag;
      this.velocity[p + 2] *= drag;
      this.velocity[p + 1] = this.velocity[p + 1] * drag - G * dt;
      this.position[p] += this.velocity[p] * dt;
      this.position[p + 1] += this.velocity[p + 1] * dt;
      this.position[p + 2] += this.velocity[p + 2] * dt;
      if (s[o] >= s[o + 1] || (this.position[p + 1] < s[o + 3] && this.velocity[p + 1] < 0)) {
        s[o + 1] = 0;
        this.lifeOut[i * 2 + 1] = 0;
        continue;
      }
      this.lifeOut[i * 2] = s[o] / s[o + 1];
      this.lifeOut[i * 2 + 1] = s[o + 2];
      live++;
    }
    this.live = live;
    this.attrs.position.needsUpdate = true;
    this.attrs.life.needsUpdate = true;
  }

  /** Particles in the air, for the smoke test. */
  get count(): number {
    return this.live;
  }

  private readonly local = new THREE.Vector3();
  private readonly axisX = new THREE.Vector3();
  private readonly axisZ = new THREE.Vector3();

  /** Throws this frame's drops; returns how many. */
  private spawn(dt: number, src: SpraySource): number {
    const { lines, speed } = src;
    const v = Math.max(0, speed);
    // Hull speed for its length: below it a displacement bow wave, above it the planing sheet.
    const planing = THREE.MathUtils.smoothstep(v, 5, 11);
    // Drops a second: the sheet grows with speed; a slam throws a burst on top.
    const rate = 700 * Math.max(0, v - 2.5) ** 1.1 * (lines.length / 7.6) + 1500 * src.slam * Math.min(1, v / 4);
    this.owed += rate * this.density * dt;
    if (this.owed < 1) return 0;
    const n = Math.min(Math.floor(this.owed), 1200);
    this.owed -= Math.floor(this.owed);
    this.axisX.setFromMatrixColumn(src.world, 0).setY(0).normalize();
    this.axisZ.setFromMatrixColumn(src.world, 2).setY(0).normalize();
    const fwdX = -this.axisZ.x;
    const fwdZ = -this.axisZ.z;
    // Where the water meets the hull: at the stem when slow, moving aft to the spray root on the plane.
    const root = THREE.MathUtils.lerp(0.93, 0.62, planing);
    const stern = Math.min(0.12, n * 0.08) * THREE.MathUtils.smoothstep(v, 3, 8);
    for (let k = 0; k < n; k++) {
      const side = k % 2 === 0 ? 1 : -1;
      const wash = Math.random() < stern;
      const s = wash ? 0.02 : root + (Math.random() - 0.3) * 0.1;
      const y = wash ? -0.05 : 0.02 + 0.08 * Math.random();
      const half = halfBeamAt(lines, THREE.MathUtils.clamp(s, 0, 1), Math.max(0, y) / lines.depth);
      this.local.set(side * (wash ? Math.random() * 0.4 : half * 1.03), y * lines.depth, lines.length / 2 - s * lines.length);
      this.local.applyMatrix4(src.world);
      const u = Math.random();
      let vx: number, vy: number, vz: number, life: number, size: number;
      if (wash) {
        // Thrown up and back from the propeller.
        const back = v * (0.1 + 0.2 * u);
        vx = -fwdX * back + this.axisX.x * side * Math.random();
        vz = -fwdZ * back + this.axisX.z * side * Math.random();
        vy = 1 + 2.5 * Math.random();
        life = 0.6 + 0.6 * Math.random();
        size = 0.12 + 0.2 * Math.random();
      } else {
        // The sheet leaves the hull outward and up, carried forward a little; a slam throws it higher.
        const out = v * (0.1 + 0.22 * u) + 1.5 * src.slam;
        const up = (1 + v * (0.1 + 0.16 * Math.random())) * (1 - 0.3 * planing) + 3 * src.slam * Math.random();
        const on = v * (0.15 + 0.3 * Math.random()) * (1 - 0.5 * planing);
        vx = this.axisX.x * side * out + fwdX * on;
        vz = this.axisX.z * side * out + fwdZ * on;
        vy = up;
        life = 0.35 + 0.6 * Math.random() + 0.5 * src.slam;
        // Mostly fine drops, a few big ones, and every so often a puff of mist.
        const mist = Math.random() < 0.08;
        size = mist ? 0.5 + 0.6 * Math.random() : 0.012 + 0.06 * Math.random() ** 3;
        if (mist) life *= 1.6;
      }
      this.emit(this.local.x, this.local.y, this.local.z, vx, vy, vz, life, size, src.water - 0.3);
    }
    return n;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
  }
}
