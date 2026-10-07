import { describe, expect, it } from "vitest";
import { conditions, PRESETS, rainIntensity } from "./conditions";
import type { Weather } from "./weather";

const drizzle: Weather = { time: 0, cloudCover: 0.55, windSpeed: 3.3, windDirection: 168, precipitation: 0.4, visibility: 8220, code: 51 };

describe("conditions", () => {
  it("follows the live weather, and reads thunder from the WMO code", () => {
    expect(conditions(drizzle, null, null)).toEqual({ cloudCover: 0.55, rain: 0.4, visibility: 8220, wind: 3.3, thunder: false });
    expect(conditions({ ...drizzle, code: 95 }, null, null).thunder).toBe(true);
  });

  it("uses a preset when one is chosen, and the clouds slider over either", () => {
    expect(conditions(drizzle, "storm", null)).toEqual(PRESETS.storm);
    expect(conditions(drizzle, "squall", 0.2).cloudCover).toBe(0.2);
    expect(conditions(null, null, null).rain).toBe(0);
  });
});

describe("rainIntensity", () => {
  it("registers drizzle and saturates in a downpour", () => {
    expect(rainIntensity(0)).toBe(0);
    expect(rainIntensity(0.4)).toBeGreaterThan(0.08);
    expect(rainIntensity(30)).toBe(1);
    expect(rainIntensity(100)).toBe(1);
  });
});
