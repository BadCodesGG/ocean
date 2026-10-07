import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRecord, parseSpectrum } from "@/lib/cdip";
import { G, groupVelocity, reconstruct, surfaceAt, wavenumber } from "./waves";

const RATE = 1.28;
const N = 2304;
const PERIOD = N / RATE;

/** A record of one linear wave of the given amplitude and bin, travelling toward bearing `toward` (degrees clockwise from north). */
function planeWaveRecord(amplitude: number, bin: number, toward: number, phase = 0.7, depth = 200) {
  const omega = (2 * Math.PI * bin) / PERIOD;
  const orbit = 1 / Math.tanh(wavenumber(omega, depth) * depth);
  const ux = Math.sin((toward * Math.PI) / 180);
  const uy = Math.cos((toward * Math.PI) / 180);
  const z: number[] = [];
  const east: number[] = [];
  const north: number[] = [];
  for (let i = 0; i < N; i++) {
    const theta = omega * (i / RATE) + phase;
    z.push(amplitude * Math.cos(theta));
    // Particles move forward under the crest: horizontal = u A coth(kh) sin(theta).
    east.push(ux * amplitude * orbit * Math.sin(theta));
    north.push(uy * amplitude * orbit * Math.sin(theta));
  }
  return { rate: RATE, z, east, north };
}

describe("wavenumber", () => {
  it("is the deep-water k = omega²/g for short waves", () => {
    const omega = 2 * Math.PI * 0.2;
    expect(wavenumber(omega, 200)).toBeCloseTo((omega * omega) / G, 8);
  });

  it("solves the finite-depth relation for long waves", () => {
    const omega = 2 * Math.PI * 0.04;
    const k = wavenumber(omega, 200);
    expect(G * k * Math.tanh(k * 200)).toBeCloseTo(omega * omega, 10);
    expect(k).toBeGreaterThan((omega * omega) / G);
  });

  it("gives half the phase speed as group speed in deep water", () => {
    const k = wavenumber(2 * Math.PI * 0.2, 200);
    expect(groupVelocity(k, 200)).toBeCloseTo(0.5 * Math.sqrt(G / k), 6);
  });
});

describe("reconstruct", () => {
  it.each([90, 0, 225, 300])("recovers a wave travelling toward %i degrees", (toward) => {
    const { components } = reconstruct(planeWaveRecord(0.6, 180, toward), 200);
    expect(components).toHaveLength(1);
    const [c] = components;
    expect(c.frequency).toBeCloseTo(180 / PERIOD, 10);
    expect(Math.hypot(c.re, c.im)).toBeCloseTo(0.6, 6);
    const bearing = ((Math.atan2(c.ux, c.uy) * 180) / Math.PI + 360) % 360;
    expect(bearing).toBeCloseTo(toward, 4);
  });

  it("reproduces the buoy's own horizontal motion for a single wave", () => {
    const record = planeWaveRecord(0.5, 150, 80);
    const { components } = reconstruct(record, 200);
    for (const i of [0, 333, 1200]) {
      const p = surfaceAt(components, 0, 0, i / RATE);
      expect(p.eta).toBeCloseTo(record.z[i], 6);
      expect(p.east).toBeCloseTo(record.east[i], 6);
      expect(p.north).toBeCloseTo(record.north[i], 6);
    }
  });

  it("moves crests along the direction of travel at the phase speed", () => {
    const { components } = reconstruct(planeWaveRecord(0.5, 180, 90, 0), 200);
    const [c] = components;
    const speed = c.omega / c.k;
    // What passes the buoy at t = 0 arrives 50 m further east 50/speed seconds later.
    expect(surfaceAt(components, 50, 0, 50 / speed).eta).toBeCloseTo(surfaceAt(components, 0, 0, 0).eta, 6);
    expect(surfaceAt(components, 0, 50, 50 / speed).eta).not.toBeCloseTo(surfaceAt(components, 0, 0, 0).eta, 2);
  });

  it("gives slopes that match a finite difference of the heave", () => {
    const { components } = reconstruct(planeWaveRecord(0.5, 200, 300), 200);
    const h = 1e-3;
    const p = surfaceAt(components, 3, -7, 11);
    const dx = (surfaceAt(components, 3 + h, -7, 11).eta - surfaceAt(components, 3 - h, -7, 11).eta) / (2 * h);
    const dy = (surfaceAt(components, 3, -7 + h, 11).eta - surfaceAt(components, 3, -7 - h, 11).eta) / (2 * h);
    expect(p.slopeEast).toBeCloseTo(dx, 6);
    expect(p.slopeNorth).toBeCloseTo(dy, 6);
  });

  it("repeats after the record length, so the record loops without a seam", () => {
    const { components, period } = reconstruct(planeWaveRecord(0.5, 173, 45), 200);
    expect(surfaceAt(components, 20, 30, 5 + period).eta).toBeCloseTo(surfaceAt(components, 20, 30, 5).eta, 6);
  });

  describe("on the real Waimea record", () => {
    const dir = path.join(import.meta.dirname, "../lib/__fixtures__");
    const record = parseRecord(readFileSync(path.join(dir, "106p1_xy.ascii.txt"), "utf8"), 0);
    const spectrum = parseSpectrum(readFileSync(path.join(dir, "106p1_rt.ascii.txt"), "utf8"));
    const recon = reconstruct(record, 200);

    it("keeps at least 99% of the band's variance within the component budget", () => {
      expect(recon.components.length).toBeLessThanOrEqual(384);
      expect(recon.keptVariance / recon.bandVariance).toBeGreaterThanOrEqual(0.99);
    });

    it("is exact at the buoy when every bin is kept", () => {
      const all = reconstruct(record, 200, { minFrequency: 0, maxFrequency: 1, variance: 1, maxComponents: Infinity });
      const mean = record.z.reduce((a, b) => a + b, 0) / record.z.length;
      // Everything but the mean and the Nyquist bin, which carries almost nothing.
      for (const i of [0, 500, 1777]) expect(surfaceAt(all.components, 0, 0, i / record.rate).eta + mean).toBeCloseTo(record.z[i], 1);
    });

    it("tracks the measured heave closely with the default band and budget", () => {
      const mean = record.z.reduce((a, b) => a + b, 0) / record.z.length;
      let err = 0;
      let power = 0;
      for (let i = 0; i < record.z.length; i++) {
        const d = surfaceAt(recon.components, 0, 0, i / record.rate).eta - (record.z[i] - mean);
        err += d * d;
        power += (record.z[i] - mean) ** 2;
      }
      // The residual is exactly the variance the kept components leave out (the waves shorter than
      // the band, which the random-phase detail layer carries, and the dropped 1%): Parseval.
      expect(err / power).toBeCloseTo(1 - recon.keptVariance / (power / record.z.length), 3);
      expect(err / power).toBeLessThan(0.1);
    });

    // Waimea that day: a WNW groundswell and a NNE trade-wind sea. Per band, the direction from the
    // buoy's motion must agree with CDIP's own published mean direction for that band.
    it.each([
      [0.075, 0.125],
      [0.16, 0.26],
    ])("agrees with CDIP's mean direction between %f and %f Hz", (lo, hi) => {
      let ex = 0;
      let ey = 0;
      for (const c of recon.components) {
        if (c.frequency < lo || c.frequency >= hi) continue;
        const e = c.re * c.re + c.im * c.im;
        ex += e * c.ux;
        ey += e * c.uy;
      }
      let a = 0;
      let b = 0;
      spectrum.frequency.forEach((f, i) => {
        if (f < lo || f >= hi) return;
        const e = spectrum.energy[i] * spectrum.bandwidth[i];
        a += e * spectrum.a1[i];
        b += e * spectrum.b1[i];
      });
      const toward = (Math.atan2(ex, ey) * 180) / Math.PI;
      const from = (Math.atan2(b, a) * 180) / Math.PI;
      expect(Math.abs(((toward - (from + 180) + 540) % 360) - 180)).toBeLessThan(20);
    });
  });
});
