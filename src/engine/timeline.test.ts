import { describe, expect, it } from "vitest";
import type { BuoyRecord } from "@/lib/cdip";
import { blendedSurface, FADE_SECONDS, recordTime, Timeline } from "./timeline";

const RATE = 1.28;
const N = 2304;

/** A record of one wave whose amplitude tags which record it is. */
function record(start: number, amplitude: number): BuoyRecord {
  const z: number[] = [];
  const east: number[] = [];
  for (let i = 0; i < N; i++) {
    const theta = (2 * Math.PI * 180 * i) / N;
    z.push(amplitude * Math.cos(theta));
    east.push(amplitude * Math.sin(theta));
  }
  return { start, rate: RATE, z, east, north: new Array(N).fill(0), repaired: 0 };
}

const T0 = 1_790_000_000;

describe("Timeline", () => {
  it("starts the scene at the first sample of the latest record, and keeps that lag", () => {
    const now = T0 + 5000;
    const t = new Timeline(record(T0, 1), 200, now);
    expect(t.sceneTime(now)).toBe(T0);
    expect(t.sceneTime(now + 60)).toBe(T0 + 60);
  });

  it("plays the next record once the scene reaches it, fading over the first seconds", () => {
    const t = new Timeline(record(T0, 1), 200, T0);
    expect(t.add(record(T0 + 1800, 2))).toBe(true);
    expect(t.at(T0 + 1799).current.record.start).toBe(T0);
    expect(t.at(T0 + 1800).weight).toBe(0);
    const fading = t.at(T0 + 1800 + FADE_SECONDS / 2);
    expect(fading.current.record.start).toBe(T0 + 1800);
    expect(fading.previous?.record.start).toBe(T0);
    expect(fading.weight).toBeCloseTo(0.5);
    expect(t.at(T0 + 1800 + FADE_SECONDS).weight).toBe(1);
  });

  it("fades a record that arrives after the scene has passed its start in from that moment", () => {
    const t = new Timeline(record(T0, 1), 200, T0);
    expect(t.at(T0 + 2000).current.record.start).toBe(T0);
    expect(t.waiting(T0 + 2000)).toBe(true);
    t.add(record(T0 + 1800, 2));
    const switched = t.at(T0 + 2000.5);
    expect(switched.current.record.start).toBe(T0 + 1800);
    expect(switched.previous?.record.start).toBe(T0);
    expect(switched.weight).toBe(0);
    expect(t.at(T0 + 2000.5 + FADE_SECONDS / 2).weight).toBeCloseTo(0.5);
    expect(t.at(T0 + 2000.5 + FADE_SECONDS).weight).toBe(1);
  });

  it("ignores records it already has or older ones", () => {
    const t = new Timeline(record(T0, 1), 200, T0);
    expect(t.add(record(T0, 1))).toBe(false);
    expect(t.add(record(T0 - 1800, 1))).toBe(false);
  });

  it("loops the newest record and says it is waiting when the next is late", () => {
    const t = new Timeline(record(T0, 1), 200, T0);
    expect(t.waiting(T0 + 1000)).toBe(false);
    expect(t.waiting(T0 + 1900)).toBe(true);
    expect(recordTime(t.latest, T0 + 1900)).toBeCloseTo(100);
  });

  it("blends the surface continuously across a record change", () => {
    const t = new Timeline(record(T0, 1), 200, T0);
    t.add(record(T0 + 1800, 2));
    const before = blendedSurface(t.at(T0 + 1799.9), 0, 0, T0 + 1799.9).eta;
    const at = blendedSurface(t.at(T0 + 1800), 0, 0, T0 + 1800).eta;
    // Continuous at the switch: the new record enters with zero weight.
    expect(at).toBeCloseTo(before, 1);
    // And fully the new record after the fade: amplitude 2 at a crest (bin 180 at t = 0 mod period).
    expect(blendedSurface(t.at(T0 + 3600), 0, 0, T0 + 3600).eta).toBeCloseTo(2, 3);
  });
});
