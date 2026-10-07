import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpectrum, type BuoySpectrum } from "@/lib/cdip";
import { evolve, inverseFft } from "./fft";
import { bandVariance, cascadeVariance, directionalDistribution, energyAt, initialSpectrum, waveVector, type Cascade } from "./spectrum";
import { G } from "./waves";

const waimea = parseSpectrum(readFileSync(path.join(import.meta.dirname, "../lib/__fixtures__/106p1_rt.ascii.txt"), "utf8"));

/** A spectrum with one narrow band of waves from `from` degrees. */
function narrow(from: number, f = 0.6): BuoySpectrum {
  const t = (from * Math.PI) / 180;
  const frequency = Array.from({ length: 64 }, (_, i) => 0.025 + i * 0.01);
  const on = (x: number) => (Math.abs(x - f) < 0.05 ? 0.1 : 0);
  // Moments of a cos^8-like spread: a1 = r cos t, b1 = r sin t, a2 = r2 cos 2t, b2 = r2 sin 2t.
  const r = 0.9;
  const r2 = 0.7;
  return {
    time: 0, hs: 1, tp: 1 / f, dp: from, frequency,
    bandwidth: frequency.map(() => 0.01),
    energy: frequency.map(on),
    a1: frequency.map(() => r * Math.cos(t)),
    b1: frequency.map(() => r * Math.sin(t)),
    a2: frequency.map(() => r2 * Math.cos(2 * t)),
    b2: frequency.map(() => r2 * Math.sin(2 * t)),
  };
}

/** Naive inverse DFT of one field, for checking the GPU path's pieces. */
function synthesize(c: Cascade, spectrum: Float32Array, t: number): { re: Float64Array; im: Float64Array } {
  const n = c.size;
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  for (let m = 0; m < n; m++) {
    for (let q = 0; q < n; q++) {
      const [kx, kz] = waveVector(c, q, m);
      const k = Math.hypot(kx, kz);
      if (k === 0) continue;
      const [hr, hi] = evolve(spectrum, 4 * (m * n + q), Math.sqrt(G * k), t);
      if (hr === 0 && hi === 0) continue;
      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const phase = (2 * Math.PI * (q * col + m * row)) / n;
          re[row * n + col] += hr * Math.cos(phase) - hi * Math.sin(phase);
          im[row * n + col] += hr * Math.sin(phase) + hi * Math.cos(phase);
        }
      }
    }
  }
  return { re, im };
}

describe("inverseFft", () => {
  it("matches a plain inverse DFT", () => {
    const n = 16;
    const x = new Float64Array(2 * n).map((_, i) => Math.sin(i * 1.7) + (i % 3));
    const got = inverseFft(x, n);
    for (let j = 0; j < n; j++) {
      let re = 0;
      let im = 0;
      for (let m = 0; m < n; m++) {
        const a = (2 * Math.PI * m * j) / n;
        re += x[2 * m] * Math.cos(a) - x[2 * m + 1] * Math.sin(a);
        im += x[2 * m] * Math.sin(a) + x[2 * m + 1] * Math.cos(a);
      }
      expect(got[2 * j]).toBeCloseTo(re, 9);
      expect(got[2 * j + 1]).toBeCloseTo(im, 9);
    }
  });
});

describe("energyAt", () => {
  it("interpolates between bands and falls off as f^-4 past the last", () => {
    expect(energyAt(waimea, waimea.frequency[10])).toBeCloseTo(waimea.energy[10]);
    const last = waimea.frequency[63];
    expect(energyAt(waimea, 2 * last) / energyAt(waimea, last)).toBeCloseTo(1 / 16, 6);
    expect(energyAt(waimea, 0.01)).toBe(0);
  });
});

describe("directionalDistribution", () => {
  it("integrates to one and peaks at the mean direction", () => {
    const d = directionalDistribution(0.8 * Math.cos(1), 0.8 * Math.sin(1), 0.5 * Math.cos(2), 0.5 * Math.sin(2));
    let total = 0;
    for (let i = 0; i < 720; i++) total += d((2 * Math.PI * i) / 720) * ((2 * Math.PI) / 720);
    expect(total).toBeCloseTo(1, 3);
    expect(d(1)).toBeGreaterThan(d(1.5));
    expect(d(1)).toBeGreaterThan(d(0.5));
  });
});

describe("initialSpectrum", () => {
  const cascade: Cascade = { size: 256, length: 128, minK: 0.32, maxK: 3 };

  it("puts the band's measured variance on the grid", () => {
    expect(cascadeVariance(waimea, cascade) / bandVariance(waimea, cascade)).toBeCloseTo(1, 1);
  });

  it("makes a real field whose variance is the band's", () => {
    const small: Cascade = { size: 32, length: 64, minK: 0.4, maxK: 2.5 };
    const field = synthesize(small, initialSpectrum(waimea, small, 7), 3.3);
    let v = 0;
    let imag = 0;
    for (let i = 0; i < field.re.length; i++) {
      v += field.re[i] ** 2;
      imag = Math.max(imag, Math.abs(field.im[i]));
    }
    v /= field.re.length;
    expect(imag).toBeLessThan(1e-9);
    // One realisation of a few hundred random waves: its variance lands near the expectation.
    const ratio = v / cascadeVariance(waimea, small);
    expect(ratio).toBeGreaterThan(0.6);
    expect(ratio).toBeLessThan(1.5);
  });

  it("is the same sea for the same seed", () => {
    expect(initialSpectrum(waimea, cascade, 3)).toEqual(initialSpectrum(waimea, cascade, 3));
  });

  it.each([
    [270, [1, 0]],
    [0, [0, 1]],
  ])("sends waves from %i degrees the right way across the grid", (from, [dx, dz]) => {
    // x is east and z is south, so waves from the west travel +x and waves from the north travel +z.
    const c: Cascade = { size: 32, length: 32, minK: 1, maxK: 2.5 };
    const spectrum = initialSpectrum(narrow(from), c, 11);
    const a = synthesize(c, spectrum, 0).re;
    // Half a second later at 0.6 Hz a crest has moved about 1.3 m (phase speed g/omega ≈ 2.6 m/s).
    const b = synthesize(c, spectrum, 0.5).re;
    const n = c.size;
    const score = (sx: number, sz: number) => {
      let s = 0;
      for (let row = 0; row < n; row++)
        for (let col = 0; col < n; col++) s += a[row * n + col] * b[((row + sz + n) % n) * n + ((col + sx + n) % n)];
      return s;
    };
    expect(score(2 * dx, 2 * dz)).toBeGreaterThan(score(-2 * dx, -2 * dz));
  });
});
