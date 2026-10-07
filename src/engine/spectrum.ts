import type { BuoySpectrum } from "@/lib/cdip";
import { G } from "./waves";

/**
 * The random-phase layer: waves too short or too far away for the phase-resolved swell, synthesised
 * from the buoy's measured directional spectrum (Tessendorf-style FFT ocean).
 *
 * Grid texel (m, n) is wave vector (kx, kz) = 2π/L · (m', n'), with m' = m for m < N/2 and m - N
 * above, on the world axes x = east and z = south (three.js). A cascade is a periodic patch of side L.
 * Deep water throughout: the shortest swell-band wave here is 20 m against 200 m of depth.
 */

export interface Band {
  /** Wavenumbers kept, rad/m. */
  minK: number;
  maxK: number;
}

export interface Cascade extends Band {
  /** Texels per side, a power of two. */
  size: number;
  /** Patch side, m. */
  length: number;
}

/** Spectral density E(f), m²/Hz: linear between CDIP's bands, f^-4 past the last (the equilibrium range). */
export function energyAt(s: BuoySpectrum, f: number): number {
  const fs = s.frequency;
  const last = fs.length - 1;
  if (f < fs[0]) return 0;
  if (f >= fs[last]) {
    // The top few bands of a buoy spectrum are noisy; anchor the tail on their mean.
    let e = 0;
    for (let i = last - 3; i <= last; i++) e += s.energy[i];
    return (e / 4) * (fs[last] / f) ** 4;
  }
  let i = 0;
  while (fs[i + 1] <= f) i++;
  const t = (f - fs[i]) / (fs[i + 1] - fs[i]);
  return s.energy[i] * (1 - t) + s.energy[i + 1] * t;
}

/** The band index whose moments describe frequency f (nearest band; the last band for the tail). */
function bandIndex(s: BuoySpectrum, f: number): number {
  let best = 0;
  for (let i = 1; i < s.frequency.length; i++) if (Math.abs(s.frequency[i] - f) < Math.abs(s.frequency[best] - f)) best = i;
  return best;
}

/**
 * Directional distribution D(θ), per radian, from the first four Fourier moments, θ the nautical "from"
 * direction (radians clockwise from north). The truncated series dips below zero for narrow seas; those
 * lobes are clipped and the rest rescaled so it still integrates to one.
 */
export function directionalDistribution(a1: number, b1: number, a2: number, b2: number): (theta: number) => number {
  const raw = (t: number) => Math.max(0, (1 + 2 * (a1 * Math.cos(t) + b1 * Math.sin(t) + a2 * Math.cos(2 * t) + b2 * Math.sin(2 * t))) / (2 * Math.PI));
  let total = 0;
  const steps = 360;
  for (let i = 0; i < steps; i++) total += raw((2 * Math.PI * i) / steps) * ((2 * Math.PI) / steps);
  return (t) => raw(t) / total;
}

/** Deterministic standard normals (mulberry32 + Box-Muller), so a spectrum always makes the same sea. */
export function gaussians(seed: number): () => number {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

export function waveVector(c: Cascade, m: number, n: number): [number, number] {
  const dk = (2 * Math.PI) / c.length;
  const half = c.size / 2;
  return [(m < half ? m : m - c.size) * dk, (n < half ? n : n - c.size) * dk];
}

/**
 * Wave-number-plane variance density F(k) Δk² for one texel: E(f) D(θ) (df/dk) / k, times the texel
 * area. Its sum over a cascade is that band's heave variance.
 */
export function texelVariance(s: BuoySpectrum, c: Cascade, kx: number, kz: number, spreads: ((t: number) => number)[]): number {
  const k = Math.hypot(kx, kz);
  if (k < c.minK || k >= c.maxK || k === 0) return 0;
  const omega = Math.sqrt(G * k);
  const f = omega / (2 * Math.PI);
  // Travelling toward bearing atan2(east, north); it comes from the opposite bearing.
  const from = Math.atan2(kx, -kz) + Math.PI;
  const dfdk = (0.5 * Math.sqrt(G / k)) / (2 * Math.PI);
  const dk = (2 * Math.PI) / c.length;
  return ((energyAt(s, f) * spreads[bandIndex(s, f)](from) * dfdk) / k) * dk * dk;
}

/**
 * The initial spectrum h0 for one cascade as RGBA floats: (h0(k), conj(h0(-k))). With
 * h(k, t) = h0(k) e^{-iωt} + conj(h0(-k)) e^{iωt}, the field is real, each h0(k) travels along +k,
 * and E|h0(k)|² = F Δk² / 2 makes the heave variance equal the band's variance.
 */
export function initialSpectrum(s: BuoySpectrum, c: Cascade, seed: number): Float32Array {
  const spreads = s.frequency.map((_, i) => directionalDistribution(s.a1[i], s.b1[i], s.a2[i], s.b2[i]));
  const n = c.size;
  const h0 = new Float32Array(n * n * 2);
  const normal = gaussians(seed);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const [kx, kz] = waveVector(c, col, row);
      const amp = Math.sqrt(texelVariance(s, c, kx, kz, spreads) / 4);
      const i = 2 * (row * n + col);
      h0[i] = amp * normal();
      h0[i + 1] = amp * normal();
    }
  }
  const out = new Float32Array(n * n * 4);
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = 2 * (row * n + col);
      const j = 2 * (((n - row) % n) * n + ((n - col) % n));
      const o = 2 * i;
      out[o] = h0[i];
      out[o + 1] = h0[i + 1];
      out[o + 2] = h0[j];
      out[o + 3] = -h0[j + 1];
    }
  }
  return out;
}

/** The band's heave variance on this grid: the expected variance of the synthesised field. */
export function cascadeVariance(s: BuoySpectrum, c: Cascade): number {
  const spreads = s.frequency.map((_, i) => directionalDistribution(s.a1[i], s.b1[i], s.a2[i], s.b2[i]));
  let v = 0;
  for (let row = 0; row < c.size; row++) {
    for (let col = 0; col < c.size; col++) {
      const [kx, kz] = waveVector(c, col, row);
      v += texelVariance(s, c, kx, kz, spreads);
    }
  }
  return v;
}

/** The same variance integrated straight from E(f) over the band's frequencies, for checking the grid. */
export function bandVariance(s: BuoySpectrum, band: Band): number {
  const f0 = Math.sqrt(G * band.minK) / (2 * Math.PI);
  const f1 = Math.sqrt(G * band.maxK) / (2 * Math.PI);
  const steps = 4000;
  let v = 0;
  for (let i = 0; i < steps; i++) {
    const f = f0 + ((f1 - f0) * (i + 0.5)) / steps;
    v += energyAt(s, f) * ((f1 - f0) / steps);
  }
  return v;
}
