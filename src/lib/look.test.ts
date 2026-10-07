import { afterEach, describe, expect, it, vi } from "vitest";
import { formatLag, formatMinutes, loadLook, presets, saveLook } from "./look";

const LAT = 21.67;
const LON = -158.118;

describe("presets", () => {
  const p = presets(Date.UTC(2026, 8, 30, 22) / 1000, LAT, LON, "Pacific/Honolulu");

  it("puts dusk a few minutes before sunset and dawn a few after sunrise", () => {
    // Sunset about 18:22 and sunrise about 06:24 at Waimea on 30 Sep.
    expect(p.dusk).toBeGreaterThan(18 * 60);
    expect(p.dusk).toBeLessThan(18 * 60 + 20);
    expect(p.dawn).toBeGreaterThan(6 * 60 + 10);
    expect(p.dawn).toBeLessThan(6 * 60 + 50);
    expect(Math.abs(p.noon - (12 * 60 + 22))).toBeLessThan(15);
  });

  it("uses the station's own zone, daylight saving included", () => {
    // Point Reyes on 30 Sep: PDT, sunset about 19:05.
    const q = presets(Date.UTC(2026, 8, 30, 20) / 1000, 37.94, -123.47, "America/Los_Angeles");
    expect(q.dusk).toBeGreaterThan(18 * 60 + 45);
    expect(q.dusk).toBeLessThan(19 * 60 + 10);
  });
});

describe("format", () => {
  it("writes clock times and lags", () => {
    expect(formatMinutes(18 * 60 + 5)).toBe("18:05");
    expect(formatLag(82 * 60)).toBe("1 h 22 min");
    expect(formatLag(40 * 60)).toBe("40 min");
  });
});

describe("loadLook and saveLook", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage() {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    return store;
  }

  it("round-trips a look and forgets it when reset to live", () => {
    const store = stubStorage();
    saveLook({ lightAt: 1090, cloudCover: 0.2, weather: "squall" });
    expect(loadLook()).toEqual({ lightAt: 1090, cloudCover: 0.2, weather: "squall" });
    saveLook({ lightAt: null, cloudCover: null, weather: null });
    expect(store.size).toBe(0);
  });

  it("ignores stored values out of range and storage that throws", () => {
    const store = stubStorage();
    store.set("ocean-look", JSON.stringify({ lightAt: 5000, cloudCover: 3, weather: "hurricane" }));
    expect(loadLook()).toEqual({ lightAt: null, cloudCover: null, weather: null });
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); } } });
    expect(loadLook()).toEqual({ lightAt: null, cloudCover: null, weather: null });
  });
});
