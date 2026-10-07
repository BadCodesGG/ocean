import { describe, expect, it } from "vitest";
import { DEFAULT_STATION, slug, STATIONS, stationById, stationBySlug, stationPath, stationRedirects } from "./stations";

describe("station addresses", () => {
  it("names each page after its station, readably", () => {
    expect(slug(stationById("100p1")!)).toBe("torrey-pines-outer");
    expect(slug(stationById("188p1")!)).toBe("hilo");
    expect(STATIONS.every((s) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug(s)))).toBe(true);
  });

  it("gives every station its own address, and finds it again from it", () => {
    const slugs = STATIONS.map(slug);
    expect(new Set(slugs).size).toBe(STATIONS.length);
    for (const s of STATIONS) expect(stationBySlug(slug(s))).toBe(s);
    expect(stationBySlug("106p1")).toBeUndefined();
  });

  it("keeps the default station on the home page", () => {
    expect(stationPath(DEFAULT_STATION)).toBe("/");
    expect(stationPath(stationById("187p1")!)).toBe("/pauwela");
  });

  it("sends the old id addresses, and the default station's name, to the page now", () => {
    const to = Object.fromEntries(stationRedirects().map((r) => [r.source, r.destination]));
    expect(to["/106p1"]).toBe("/");
    expect(to["/waimea-bay"]).toBe("/");
    expect(to["/100p1"]).toBe("/torrey-pines-outer");
    expect(stationRedirects().every((r) => r.permanent)).toBe(true);
  });
});
