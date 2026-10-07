import { describe, expect, it } from "vitest";
import { atLocalMinutes, localMidnight, localMinutes, offsetSeconds, zoneName } from "./zone";

const HONOLULU = "Pacific/Honolulu";
const LA = "America/Los_Angeles";

describe("zone", () => {
  it("is Hawaii time in Hawaii", () => {
    expect(offsetSeconds(Date.UTC(2026, 8, 30) / 1000, HONOLULU)).toBe(-36000);
    expect(localMinutes(Date.UTC(2026, 8, 30, 4, 30) / 1000, HONOLULU)).toBe(18 * 60 + 30);
    expect(localMinutes(Date.UTC(2026, 8, 30, 10, 0) / 1000, HONOLULU)).toBe(0);
    expect(zoneName(Date.UTC(2026, 8, 30) / 1000, HONOLULU)).toBe("HST");
  });

  it("follows daylight saving on the mainland", () => {
    expect(offsetSeconds(Date.UTC(2026, 6, 1) / 1000, LA)).toBe(-7 * 3600);
    expect(offsetSeconds(Date.UTC(2026, 11, 1) / 1000, LA)).toBe(-8 * 3600);
    expect(zoneName(Date.UTC(2026, 6, 1) / 1000, LA)).toBe("PDT");
  });

  it("finds the local day's midnight and a clock time on it", () => {
    // 02:00 UTC on 1 Oct is 19:00 PDT on 30 Sep.
    const t = Date.UTC(2026, 9, 1, 2) / 1000;
    expect(localMidnight(t, LA)).toBe(Date.UTC(2026, 8, 30, 7) / 1000);
    expect(atLocalMinutes(t, 18 * 60, LA)).toBe(Date.UTC(2026, 9, 1, 1) / 1000);
  });
});
