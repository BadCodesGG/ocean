import { describe, expect, it } from "vitest";
import { moonPosition, sunPosition, toDirection } from "./ephemeris";

// Waimea Bay buoy 106.
const LAT = 21.67;
const LON = -158.118;
const hst = (y: number, m: number, d: number, h: number, min = 0) => Date.UTC(y, m - 1, d, h + 10, min) / 1000;

/** First minute on the given local day at which the sun's upper limb crosses the horizon going down. */
function sunset(y: number, m: number, d: number): number {
  for (let min = 12 * 60; min < 24 * 60; min++) {
    if (sunPosition(hst(y, m, d, 0, min), LAT, LON).elevation < -0.27) return min;
  }
  throw new Error("no sunset");
}

describe("sunPosition", () => {
  it("sets over the sea a little south of west at the end of September", () => {
    // Almanac sunset for Honolulu on 30 Sep is 18:21; Waimea is a quarter degree further west.
    const min = sunset(2026, 9, 30);
    expect(min).toBeGreaterThanOrEqual(18 * 60 + 17);
    expect(min).toBeLessThanOrEqual(18 * 60 + 27);
    const az = sunPosition(hst(2026, 9, 30, 0, min), LAT, LON).azimuth;
    expect(az).toBeGreaterThan(265.5);
    expect(az).toBeLessThan(268.5);
  });

  it("stands high in the south at noon a week after the equinox", () => {
    // Declination about -2.7°: noon altitude 90 - (21.67 + 2.7).
    let best = { elevation: -90, azimuth: 0 };
    for (let min = 11 * 60; min < 13 * 60 + 30; min++) {
      const p = sunPosition(hst(2026, 9, 30, 0, min), LAT, LON);
      if (p.elevation > best.elevation) best = p;
    }
    expect(best.elevation).toBeGreaterThan(64.8);
    expect(best.elevation).toBeLessThan(66.3);
    expect(Math.abs(best.azimuth - 180)).toBeLessThan(3);
  });

  it("peaks near the zenith when it passes overhead in late May", () => {
    // Waimea lies inside the tropics; the sun's declination reaches 21.67° around 26 May.
    let best = -90;
    for (let min = 11 * 60; min < 13 * 60 + 30; min++) best = Math.max(best, sunPosition(hst(2026, 5, 26, 0, min), LAT, LON).elevation);
    expect(best).toBeGreaterThan(89);
  });
});

describe("moonPosition", () => {
  it("is full on 26 Sep 2026 and new on 10 Oct 2026", () => {
    expect(moonPosition(Date.UTC(2026, 8, 26, 17) / 1000, LAT, LON).illumination).toBeGreaterThan(0.99);
    expect(moonPosition(Date.UTC(2026, 9, 10, 16) / 1000, LAT, LON).illumination).toBeLessThan(0.01);
  });

  it("rises opposite a setting sun when full", () => {
    // Around full moon the moon is near the horizon in the east as the sun sets in the west.
    const t = hst(2026, 9, 26, 18, 20);
    const moon = moonPosition(t, LAT, LON);
    const sun = sunPosition(t, LAT, LON);
    expect(Math.abs(moon.elevation)).toBeLessThan(12);
    expect(Math.abs(((moon.azimuth - sun.azimuth + 540) % 360) - 180)).toBeGreaterThan(160);
  });
});

describe("toDirection", () => {
  it("points x east, y up, z south", () => {
    const [x, y, z] = toDirection({ azimuth: 90, elevation: 0 });
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(z).toBeCloseTo(0);
    expect(toDirection({ azimuth: 0, elevation: 0 })[2]).toBeCloseTo(-1);
    expect(toDirection({ azimuth: 0, elevation: 90 })[1]).toBeCloseTo(1);
  });
});
