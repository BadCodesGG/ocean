import * as THREE from "three";
import type { BuoySpectrum } from "@/lib/cdip";
import { fullscreenTriangle } from "./fullscreen";
import { ASSEMBLE_FRAGMENT, EVOLVE_FRAGMENT, FFT_FRAGMENT, FULLSCREEN_VERTEX, SWELL_FRAGMENT } from "./shaders";
import { initialSpectrum, type Cascade } from "./spectrum";
import { recordTime, type Mix } from "./timeline";

/**
 * Runs the ocean's GPU passes each frame and exposes the resulting textures:
 *   - four random-phase FFT cascades from the buoy's spectrum (far swell, metre waves, ripples, and
 *     centimetre ripples that only tilt the surface);
 *   - the phase-resolved swell from the buoy's record, summed over a window that follows the camera.
 * The swell band sits below SWELL_MAX_K; cascade 0 carries the same band as random-phase waves, for
 * the distance beyond the swell window only.
 */

export const SWELL_MAX_K = 0.316; // 0.28 Hz in deep water: the top of the reconstructed band
export const CASCADES: Cascade[] = [
  { size: 256, length: 2000, minK: 0.004, maxK: SWELL_MAX_K },
  { size: 256, length: 160, minK: SWELL_MAX_K, maxK: 3 },
  { size: 256, length: 23, minK: 3, maxK: 22 },
  { size: 256, length: 3.7, minK: 22, maxK: 140 },
];

export const SWELL_TEXELS = 512;
export const SWELL_TEXEL = 3; // metres; the shortest swell wave (20 m) spans about seven texels

function pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>) {
  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(fullscreenTriangle, material);
  mesh.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(mesh);
  return { material, scene };
}

function fieldTarget(size: number, type: THREE.TextureDataType, filtered: boolean) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    count: 2,
    type,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    wrapS: filtered ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
    wrapT: filtered ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping,
    minFilter: filtered ? THREE.LinearMipmapLinearFilter : THREE.NearestFilter,
    magFilter: filtered ? THREE.LinearFilter : THREE.NearestFilter,
    generateMipmaps: filtered,
  });
  for (const t of rt.textures) {
    t.wrapS = rt.texture.wrapS;
    t.wrapT = rt.texture.wrapT;
    t.minFilter = rt.texture.minFilter;
    t.magFilter = rt.texture.magFilter;
    t.generateMipmaps = filtered;
    t.anisotropy = filtered ? 16 : 1;
  }
  return rt;
}

class FftCascade {
  readonly field: THREE.WebGLRenderTarget;
  private readonly ping: THREE.WebGLRenderTarget;
  private readonly pong: THREE.WebGLRenderTarget;
  private readonly h0: THREE.DataTexture;

  constructor(
    readonly cascade: Cascade,
    spectrum: BuoySpectrum,
    seed: number,
    private readonly passes: ReturnType<typeof makePasses>,
  ) {
    const n = cascade.size;
    this.h0 = new THREE.DataTexture(initialSpectrum(spectrum, cascade, seed), n, n, THREE.RGBAFormat, THREE.FloatType);
    this.h0.needsUpdate = true;
    this.ping = fieldTarget(n, THREE.FloatType, false);
    this.pong = fieldTarget(n, THREE.FloatType, false);
    this.field = fieldTarget(n, THREE.HalfFloatType, true);
  }

  update(renderer: THREE.WebGLRenderer, time: number) {
    const { evolve, fft, assemble } = this.passes;
    const n = this.cascade.size;
    evolve.material.uniforms.h0.value = this.h0;
    evolve.material.uniforms.size.value = n;
    evolve.material.uniforms.patchLength.value = this.cascade.length;
    evolve.material.uniforms.time.value = time;
    renderer.setRenderTarget(this.ping);
    renderer.render(evolve.scene, camera);
    let src = this.ping;
    let dst = this.pong;
    fft.material.uniforms.size.value = n;
    for (const horizontal of [true, false]) {
      fft.material.uniforms.horizontal.value = horizontal;
      for (let sub = 2; sub <= n; sub *= 2) {
        fft.material.uniforms.src0.value = src.textures[0];
        fft.material.uniforms.src1.value = src.textures[1];
        fft.material.uniforms.sub.value = sub;
        renderer.setRenderTarget(dst);
        renderer.render(fft.scene, camera);
        [src, dst] = [dst, src];
      }
    }
    assemble.material.uniforms.src0.value = src.textures[0];
    assemble.material.uniforms.src1.value = src.textures[1];
    renderer.setRenderTarget(this.field);
    renderer.render(assemble.scene, camera);
  }

  dispose() {
    this.h0.dispose();
    this.ping.dispose();
    this.pong.dispose();
    this.field.dispose();
  }
}

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

function makePasses() {
  return {
    evolve: pass(EVOLVE_FRAGMENT, { h0: { value: null }, size: { value: 0 }, patchLength: { value: 0 }, time: { value: 0 } }),
    fft: pass(FFT_FRAGMENT, { src0: { value: null }, src1: { value: null }, size: { value: 0 }, sub: { value: 0 }, horizontal: { value: true } }),
    assemble: pass(ASSEMBLE_FRAGMENT, { src0: { value: null }, src1: { value: null }, choppiness: { value: 1 } }),
  };
}

export class Ocean {
  readonly cascades: FftCascade[];
  readonly swell: THREE.WebGLRenderTarget;
  /** World x/z of the swell window's first texel centre. */
  readonly swellOrigin = new THREE.Vector2();
  private readonly swellPass;
  private waves: THREE.DataTexture | null = null;
  private wavesFor: { current?: Mix["current"]; previous?: Mix["previous"] } = {};
  private readonly passes = makePasses();

  constructor(spectrum: BuoySpectrum) {
    this.cascades = CASCADES.map((c, i) => new FftCascade(c, spectrum, 1000 + i, this.passes));
    this.swell = fieldTarget(SWELL_TEXELS, THREE.HalfFloatType, true);
    for (const t of this.swell.textures) {
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
    }
    this.swellPass = pass(SWELL_FRAGMENT, {
      waves: { value: null },
      count: { value: 0 },
      countA: { value: 0 },
      weightA: { value: 1 },
      weightB: { value: 0 },
      time: { value: 0 },
      origin: { value: this.swellOrigin },
      texel: { value: SWELL_TEXEL },
    });
  }

  /**
   * Point the swell pass at a mix of records. The outgoing record's amplitudes are turned by its start
   * offset so both sum against the incoming record's clock; every component is a harmonic of the
   * 30-minute record length, so that clock can wrap.
   */
  private setWaves(mix: Mix) {
    if (this.wavesFor.current === mix.current && this.wavesFor.previous === mix.previous) return;
    const a = mix.current.reconstruction.components;
    const b = mix.previous?.reconstruction.components ?? [];
    const offset = mix.previous ? mix.previous.record.start - mix.current.record.start : 0;
    const data = new Float32Array(Math.max(1, a.length + b.length) * 8);
    [...a, ...b].forEach((c, i) => {
      const turn = i < a.length ? 0 : -c.omega * offset;
      const re = c.re * Math.cos(turn) - c.im * Math.sin(turn);
      const im = c.re * Math.sin(turn) + c.im * Math.cos(turn);
      // World axes: x east, z south.
      data.set([c.k * c.ux, -c.k * c.uy, c.omega, c.orbit, re, im, 0, 0], i * 8);
    });
    this.waves?.dispose();
    this.waves = new THREE.DataTexture(data, Math.max(1, a.length + b.length) * 2, 1, THREE.RGBAFormat, THREE.FloatType);
    this.waves.needsUpdate = true;
    const u = this.swellPass.material.uniforms;
    u.waves.value = this.waves;
    u.count.value = a.length + b.length;
    u.countA.value = a.length;
    this.wavesFor = { current: mix.current, previous: mix.previous };
  }

  /**
   * Advance to scene time `sceneTime` for the swell and `time` (free-running) for the random layers.
   * The swell window re-centres on the camera in whole texels, so it never swims.
   */
  update(renderer: THREE.WebGLRenderer, mix: Mix, sceneTime: number, time: number, eye: THREE.Vector3) {
    this.setWaves(mix);
    const previous = renderer.getRenderTarget();
    for (const c of this.cascades) c.update(renderer, time);
    const half = (SWELL_TEXELS / 2) * SWELL_TEXEL;
    this.swellOrigin.set(Math.round((eye.x - half) / SWELL_TEXEL) * SWELL_TEXEL, Math.round((eye.z - half) / SWELL_TEXEL) * SWELL_TEXEL);
    const u = this.swellPass.material.uniforms;
    u.time.value = recordTime(mix.current, sceneTime);
    u.weightA.value = mix.weight;
    u.weightB.value = 1 - mix.weight;
    renderer.setRenderTarget(this.swell);
    renderer.render(this.swellPass.scene, camera);
    renderer.setRenderTarget(previous);
  }

  dispose() {
    for (const c of this.cascades) c.dispose();
    this.swell.dispose();
    this.waves?.dispose();
    this.swellPass.material.dispose();
    for (const p of Object.values(this.passes)) p.material.dispose();
  }
}
