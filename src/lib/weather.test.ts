import { describe, expect, it } from "vitest";
import { parseWeather, weatherUrl } from "./weather";

// Saved from Open-Meteo for Waimea on 2026-09-30.
const SAMPLE = {
  latitude: 21.61687,
  longitude: -158.07574,
  current: { time: "2026-09-30T18:15", interval: 900, cloud_cover: 100, cloud_cover_low: 100, wind_speed_10m: 3.31, wind_direction_10m: 151 },
};

describe("parseWeather", () => {
  it("reads cover as a fraction, wind in m/s, and the time as UTC", () => {
    expect(parseWeather(SAMPLE)).toEqual({
      time: Date.UTC(2026, 8, 30, 18, 15) / 1000,
      cloudCover: 1,
      windSpeed: 3.31,
      windDirection: 151,
      precipitation: 0,
      visibility: 24_000,
      code: 0,
    });
  });

  it("turns the interval's rain into a rate and reads haze and thunder", () => {
    // Saved an hour later: drizzle, 0.1 mm in the 15-minute interval.
    const drizzle = { current: { time: "2026-09-30T19:15", interval: 900, cloud_cover: 55, wind_speed_10m: 3.32, wind_direction_10m: 168, precipitation: 0.1, weather_code: 51, visibility: 8220 } };
    const w = parseWeather(drizzle);
    expect(w.precipitation).toBeCloseTo(0.4);
    expect(w.visibility).toBe(8220);
    expect(w.code).toBe(51);
  });

  it("rejects a response without the fields", () => {
    expect(() => parseWeather({ current: { time: "2026-09-30T18:15" } })).toThrow(/cloud_cover/);
    expect(() => parseWeather(null)).toThrow();
  });
});

describe("weatherUrl", () => {
  it("asks for metres per second in GMT", () => {
    const url = new URL(weatherUrl(21.67041, -158.11789));
    expect(url.searchParams.get("wind_speed_unit")).toBe("ms");
    expect(url.searchParams.get("latitude")).toBe("21.670");
    expect(url.searchParams.get("timezone")).toBe("GMT");
  });
});
