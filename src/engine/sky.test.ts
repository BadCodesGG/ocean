import { describe, expect, it } from "vitest";
import { toDirection } from "./ephemeris";
import { sunRadiance } from "./sky";

const sunDirection = (azimuth: number, elevation: number) => toDirection({ azimuth, elevation });

describe("sunRadiance", () => {
  it("is nearly white at noon and deep orange at dusk", () => {
    const noon = sunRadiance(sunDirection(180, 80));
    const dusk = sunRadiance(sunDirection(267, 2.5));
    expect(noon[2] / noon[0]).toBeGreaterThan(0.6);
    expect(dusk[2] / dusk[0]).toBeLessThan(0.15);
    expect(dusk[0]).toBeLessThan(noon[0]);
  });
});
