import { describe, expect, it } from "vitest";
import { kelvinAt, Trail, TRAIL_POINTS, TRAIL_SPACING, trailStrength } from "./wake";

/** A boat that has run due north (toward -z) at `speed` m/s for as long as the trail holds, now at the origin. */
function straightRun(speed: number): Trail {
  const trail = new Trail();
  const steps = TRAIL_POINTS + 2;
  for (let i = 0; i <= steps; i++) {
    const t = i * TRAIL_SPACING;
    trail.update(t, TRAIL_SPACING, { x: 0, z: (steps - i) * TRAIL_SPACING * speed, speed });
  }
  return trail;
}

describe("Kelvin wake", () => {
  /** Angle off the track, degrees, where the wake is tallest `behind` metres astern. */
  function armAngle(trail: Trail, behind: number): number {
    let best = 0;
    let at = 0;
    for (let y = 0; y <= behind * 0.6; y += behind / 60) {
      let peak = 0;
      for (let dz = -10; dz <= 10; dz += 0.5) peak = Math.max(peak, Math.abs(kelvinAt(trail.data, y, behind + dz)[0]));
      if (peak > best) {
        best = peak;
        at = y;
      }
    }
    return (Math.atan2(at, behind) * 180) / Math.PI;
  }

  it("opens a V near the Kelvin angle at low speed, narrowing as a fast hull's does", () => {
    const slow = armAngle(straightRun(6), 60);
    const fast = armAngle(straightRun(12), 120);
    expect(slow).toBeGreaterThan(13);
    expect(slow).toBeLessThan(21);
    expect(fast).toBeGreaterThan(8);
    expect(fast).toBeLessThan(slow);
  });

  it("is mirror-symmetric about the track", () => {
    const trail = straightRun(10);
    expect(kelvinAt(trail.data, 17, 90)[0]).toBeCloseTo(kelvinAt(trail.data, -17, 90)[0], 6);
  });

  it("is a few tens of centimetres high at speed and nothing at rest", () => {
    const fast = straightRun(12);
    let max = 0;
    for (let y = -40; y <= 40; y += 2) for (let z = 20; z <= 120; z += 2) max = Math.max(max, Math.abs(kelvinAt(fast.data, y, z)[0]));
    expect(max).toBeGreaterThan(0.1);
    expect(max).toBeLessThan(1);
    expect(trailStrength(0)).toBe(0);
  });

  it("forgets the trail when the boat is taken away", () => {
    const trail = straightRun(10);
    trail.update(100, 0.016, null);
    expect(trail.bounds.w).toBe(0);
    expect(kelvinAt(trail.data, 0, 50)[0]).toBe(0);
  });
});
