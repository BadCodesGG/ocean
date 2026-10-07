/**
 * Phase-resolved swell from one buoy record.
 *
 * A spectrum says how much energy each frequency carries but nothing about phase, so a sea built from
 * one is only statistically right. The buoy's raw motion carries the phases. Each frequency bin of the
 * 30-minute record becomes one linear plane wave, with its amplitude and phase from the heave and its
 * direction from how the buoy moved horizontally at that frequency. Summed, the waves reproduce the
 * buoy's measured heave exactly at the buoy, and propagate by the real dispersion relation around it.
 * The sum is periodic in the record length, so the record loops without a seam.
 *
 * Coordinates: x east, y north (metres, buoy at the origin), t seconds from the record's first sample.
 * Wave j: eta = Re(Z_j e^{i(omega_j t - k_j u_j . x)}), travelling toward unit vector u_j.
 */

export const G = 9.81;

export interface WaveComponent {
  frequency: number;
  omega: number;
  /** Wavenumber from the finite-depth dispersion relation. */
  k: number;
  /** Unit direction of travel, east and north. */
  ux: number;
  uy: number;
  /** Complex heave amplitude at the buoy. */
  re: number;
  im: number;
  /** Horizontal orbit over vertical at the surface: coth(kh). */
  orbit: number;
}

export interface Reconstruction {
  components: WaveComponent[];
  /** Seconds after which the sum repeats: the record's length. */
  period: number;
  /** Heave variance of the band, and the part the kept components carry. */
  bandVariance: number;
  keptVariance: number;
}

/** omega² = g k tanh(k h), solved for k by Newton's method from the deep-water guess. */
export function wavenumber(omega: number, depth: number): number {
  let k = (omega * omega) / G;
  for (let i = 0; i < 30; i++) {
    const t = Math.tanh(k * depth);
    const f = G * k * t - omega * omega;
    const df = G * t + G * k * depth * (1 - t * t);
    const next = k - f / df;
    if (Math.abs(next - k) < 1e-12) return next;
    k = next;
  }
  return k;
}

/** Group velocity from the same dispersion relation, m/s. */
export function groupVelocity(k: number, depth: number): number {
  const omega = Math.sqrt(G * k * Math.tanh(k * depth));
  const kh = Math.min(k * depth, 350);
  return (omega / k) * 0.5 * (1 + (2 * kh) / Math.sinh(2 * kh));
}

/** One-sided DFT coefficient of a real series at bin j, scaled so x(t) = mean + sum Re(C_j e^{i omega_j t}). */
function coefficient(x: number[], j: number): [number, number] {
  const n = x.length;
  let re = 0;
  let im = 0;
  const w = (-2 * Math.PI * j) / n;
  for (let i = 0; i < n; i++) {
    re += x[i] * Math.cos(w * i);
    im += x[i] * Math.sin(w * i);
  }
  return [(2 * re) / n, (2 * im) / n];
}

export interface ReconstructOptions {
  /** Band kept, Hz. */
  minFrequency?: number;
  maxFrequency?: number;
  /** Stop adding components once this share of the band's variance is carried. */
  variance?: number;
  /** Upper bound on components, to bound the per-texel cost on the GPU. */
  maxComponents?: number;
}

export function reconstruct(
  record: { rate: number; z: number[]; north: number[]; east: number[] },
  depth: number,
  { minFrequency = 0.03, maxFrequency = 0.28, variance = 0.99, maxComponents = 384 }: ReconstructOptions = {},
): Reconstruction {
  const n = record.z.length;
  const period = n / record.rate;
  const first = Math.max(1, Math.ceil(minFrequency * period));
  const last = Math.min(Math.floor(n / 2) - 1, Math.floor(maxFrequency * period));
  const all: WaveComponent[] = [];
  let bandVariance = 0;
  for (let j = first; j <= last; j++) {
    const [zr, zi] = coefficient(record.z, j);
    const [er, ei] = coefficient(record.east, j);
    const [nr, ni] = coefficient(record.north, j);
    // For a plane wave toward u, horizontal = -i u coth(kh) Z, so Re(i conj(Z) H) = |Z|² u coth(kh):
    // the in-phase part of each horizontal axis against the heave, turned a quarter cycle.
    const cx = zi * er - zr * ei;
    const cy = zi * nr - zr * ni;
    const len = Math.hypot(cx, cy);
    const frequency = j / period;
    const omega = 2 * Math.PI * frequency;
    const k = wavenumber(omega, depth);
    const power = (zr * zr + zi * zi) / 2;
    bandVariance += power;
    all.push({
      frequency,
      omega,
      k,
      ux: len > 0 ? cx / len : 1,
      uy: len > 0 ? cy / len : 0,
      re: zr,
      im: zi,
      orbit: 1 / Math.tanh(Math.min(k * depth, 350)),
    });
  }
  all.sort((a, b) => b.re * b.re + b.im * b.im - (a.re * a.re + a.im * a.im));
  const components: WaveComponent[] = [];
  let keptVariance = 0;
  for (const c of all) {
    if (components.length >= maxComponents || keptVariance >= variance * bandVariance) break;
    components.push(c);
    keptVariance += (c.re * c.re + c.im * c.im) / 2;
  }
  components.sort((a, b) => a.frequency - b.frequency);
  return { components, period, bandVariance, keptVariance };
}

export interface SurfacePoint {
  /** Heave, m. */
  eta: number;
  /** Horizontal displacement of the surface particle, m. */
  east: number;
  north: number;
  /** Surface slope d(eta)/dx, d(eta)/dy at the undisplaced point. */
  slopeEast: number;
  slopeNorth: number;
}

/** The surface particle whose rest position is (x, y), at record time t. The GPU pass evaluates the same sum. */
export function surfaceAt(waves: readonly WaveComponent[], x: number, y: number, t: number): SurfacePoint {
  const p: SurfacePoint = { eta: 0, east: 0, north: 0, slopeEast: 0, slopeNorth: 0 };
  for (const w of waves) {
    const phase = w.omega * t - w.k * (w.ux * x + w.uy * y);
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    // Z e^{i phase}: real part is the heave; -i times it, real part, is the horizontal orbit.
    const real = w.re * c - w.im * s;
    const imag = w.re * s + w.im * c;
    p.eta += real;
    p.east += w.ux * w.orbit * imag;
    p.north += w.uy * w.orbit * imag;
    // d/dx of Re(Z e^{i(omega t - k u.x)}) = Re(-i k ux Z e^{...}) = k ux Im(...).
    p.slopeEast += w.k * w.ux * imag;
    p.slopeNorth += w.k * w.uy * imag;
  }
  return p;
}
