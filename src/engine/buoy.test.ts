import { describe, expect, it } from "vitest";
import { flashOn, sampleChannel } from "./buoy";

describe("sampleChannel", () => {
  it("passes through the samples and loops", () => {
    const v = [0, 1, 4, 9, 16];
    expect(sampleChannel(v, 1, 2)).toBeCloseTo(4);
    expect(sampleChannel(v, 1, 7)).toBeCloseTo(4);
    expect(sampleChannel(v, 2, 1.5)).toBeCloseTo(9);
  });
});

describe("flashOn", () => {
  it("flashes five times at the start of every twenty seconds", () => {
    const on = Array.from({ length: 200 }, (_, i) => flashOn(i / 10));
    let flashes = 0;
    for (let i = 1; i < on.length; i++) if (on[i] && !on[i - 1]) flashes++;
    expect(on[0]).toBe(true);
    expect(flashes).toBe(4);
    expect(flashOn(20.1)).toBe(true);
    expect(flashOn(12)).toBe(false);
  });
});
