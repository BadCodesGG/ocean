import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkBuoy, fetchBuoy, parseRecord, parseSpectrum, parseSst, recordQuery, repair, spectrumQuery, sstQuery } from "./cdip";
import { parseDdsShapes } from "./opendap";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "__fixtures__", name), "utf8");

// The fixtures were saved from station 106p1 on 2026-09-30, when the displacement array held 14,466,986 samples.
const XY_COUNT = 14_466_986;
const FIRST = XY_COUNT - 2304;

describe("parseDdsShapes", () => {
  it("reads array lengths, ignoring the axis repeats inside grids", () => {
    const shapes = parseDdsShapes(fixture("106p1_rt.dds.txt"));
    expect(shapes.get("waveFrequency")).toEqual([64]);
    expect(shapes.get("waveEnergyDensity")?.[1]).toBe(64);
    expect(shapes.get("waveTime")?.[0]).toBeGreaterThan(6000);
    expect(parseDdsShapes(fixture("106p1_xy.dds.txt")).get("xyzZDisplacement")).toEqual([XY_COUNT]);
  });
});

describe("parseSpectrum", () => {
  const s = parseSpectrum(fixture("106p1_rt.ascii.txt"));

  it("reads the summary values and all 64 bands", () => {
    expect(s.name).toBe("WAIMEA BAY, HI BUOY - 106p1");
    expect(s.time).toBe(1790785800);
    expect(s.hs).toBeCloseTo(1.25);
    expect(s.dp).toBeCloseTo(276.19, 1);
    for (const band of [s.frequency, s.bandwidth, s.energy, s.a1, s.b1, s.a2, s.b2]) expect(band).toHaveLength(64);
    expect(s.frequency[0]).toBeCloseTo(0.025);
  });

  it("carries a spectrum whose energy agrees with the published Hs", () => {
    const m0 = s.energy.reduce((sum, e, i) => sum + e * s.bandwidth[i], 0);
    expect(4 * Math.sqrt(m0)).toBeCloseTo(s.hs, 1);
  });
});

/** The fixture's one spectrum as two rows: a copy of it first, then a newer one with the given changes. */
function twoRows(newer: { flag?: number; energy0?: number; a1?: number }): string {
  const lines = fixture("106p1_rt.ascii.txt").split(/\r?\n/);
  // The value line that follows a variable's header line in the ascii response.
  const after = (header: string) => lines[lines.indexOf(header) + 1].replace(/^\[0\], /, "");
  const out = [...lines.slice(0, lines.findIndex((l) => l.startsWith("---")) + 1), 'metaStationName, "WAIMEA BAY, HI BUOY - 106p1"', ""];
  const pair = (name: string, second: string) => out.push(`${name}[2]`, `${after(`${name}[1]`)}, ${second}`, "");
  pair("waveTime", "1790787600");
  pair("waveFlagPrimary", String(newer.flag ?? 1));
  pair("waveHs", "9.99");
  pair("waveTp", "8");
  pair("waveDp", "300");
  for (const name of ["waveFrequency", "waveBandwidth"]) out.push(`${name}[64]`, after(`${name}[64]`), "");
  for (const g of ["waveEnergyDensity", "waveA1Value", "waveB1Value", "waveA2Value", "waveB2Value"]) {
    const values = after(`${g}.${g}[1][64]`).split(", ");
    const changed = values.slice();
    if (g === "waveEnergyDensity" && newer.energy0 !== undefined) changed[0] = String(newer.energy0);
    if (g === "waveA1Value" && newer.a1 !== undefined) changed[5] = String(newer.a1);
    out.push(`${g}.${g}[2][64]`, `[0], ${values.join(", ")}`, `[1], ${changed.join(", ")}`, "");
  }
  return out.join("\n");
}

describe("parseSpectrum with several rows", () => {
  it("takes the newest spectrum when it is good", () => {
    expect(parseSpectrum(twoRows({})).hs).toBeCloseTo(9.99);
  });

  it.each([
    ["flagged bad", { flag: 4 }],
    ["carrying a fill value", { energy0: -999.99 }],
    ["with a moment out of range", { a1: -999.99 }],
  ])("falls back to the older one when the newest is %s", (_, newer) => {
    const s = parseSpectrum(twoRows(newer));
    expect(s.hs).toBeCloseTo(1.25);
    expect(s.time).toBe(1790785800);
  });

  it("refuses when none is usable", () => {
    const src = fixture("106p1_rt.ascii.txt").replace(/waveFlagPrimary\[1\]\r?\n1/, "waveFlagPrimary[1]\n4");
    expect(() => parseSpectrum(src)).toThrow(/usable/);
  });
});

describe("parseRecord", () => {
  const r = parseRecord(fixture("106p1_xy.ascii.txt"), FIRST);

  it("reads 30 minutes at 1.28 Hz and times sample 0 per CDIP's formula", () => {
    expect(r.rate).toBeCloseTo(1.28);
    expect(r.z).toHaveLength(2304);
    expect(r.start).toBeCloseTo(1779483600 + FIRST / 1.28 - 133.3, 3);
    expect(r.depth).toBe(200);
    expect(r.repaired).toBe(0);
  });

  it("turns CDIP's west axis into east", () => {
    const west = /xyzYDisplacement\[2304\]\n([^\n]+)/.exec(fixture("106p1_xy.ascii.txt"))![1].split(", ").map(Number);
    expect(r.east[10]).toBeCloseTo(-west[10]);
  });

  it("gives a significant wave height from the heave that matches the spectrum's", () => {
    const mean = r.z.reduce((a, b) => a + b, 0) / r.z.length;
    const variance = r.z.reduce((a, b) => a + (b - mean) ** 2, 0) / r.z.length;
    expect(4 * Math.sqrt(variance)).toBeGreaterThan(1.1);
    expect(4 * Math.sqrt(variance)).toBeLessThan(1.5);
  });
});

describe("repair", () => {
  it("interpolates interior gaps and copies the nearest value at the edges", () => {
    expect(repair([9, 1, 9, 9, 4, 9], [true, false, true, true, false, true])).toEqual([1, 1, 2, 3, 4, 4]);
  });
});

describe("queries", () => {
  it("asks for exactly the last 30 minutes and the last spectrum", () => {
    const { query, firstIndex } = recordQuery(XY_COUNT, 1.28);
    expect(firstIndex).toBe(FIRST);
    expect(query).toContain(`xyzZDisplacement[${FIRST}:1:${XY_COUNT - 1}]`);
    expect(spectrumQuery(6267, 64)).toContain("waveEnergyDensity[6263:1:6266][0:1:63]");
    expect(spectrumQuery(6267, 64)).toContain("waveFlagPrimary[6263:1:6266]");
    // A DWR4 (Barbers Point) reports 100 bands; asking for 64 of them left every row short.
    expect(spectrumQuery(6267, 100)).toContain("waveA2Value[6263:1:6266][0:1:99]");
  });
});

describe("fetchBuoy", () => {
  it("fetches the structure first, then the latest record and spectrum", async () => {
    const urls: string[] = [];
    const snapshot = await fetchBuoy("106p1", async (url) => {
      urls.push(url);
      if (url.endsWith("_xy.nc.dds")) return fixture("106p1_xy.dds.txt");
      if (url.endsWith("_rt.nc.dds")) return fixture("106p1_rt.dds.txt");
      if (url.includes("sstTime")) return fixture("106p1_sst.ascii.txt");
      return fixture(url.includes("_xy.nc.ascii") ? "106p1_xy.ascii.txt" : "106p1_rt.ascii.txt");
    });
    expect(urls).toHaveLength(6);
    expect(snapshot.name).toContain("WAIMEA");
    expect(snapshot.record.start).toBeCloseTo(1779483600 + FIRST / 1.28 - 133.3, 3);
    expect(snapshot.spectrum.energy).toHaveLength(64);
  });

  // The spectrum fixture is from May and the temperature fixture from September: months apart.
  const cdip = (sst: () => Promise<string>) => async (url: string) => {
    if (url.endsWith("_xy.nc.dds")) return fixture("106p1_xy.dds.txt");
    if (url.endsWith("_rt.nc.dds")) return fixture("106p1_rt.dds.txt");
    if (url.includes("sstTime")) return sst();
    return fixture(url.includes("_xy.nc.ascii") ? "106p1_xy.ascii.txt" : "106p1_rt.ascii.txt");
  };
  const measured = parseSpectrum(fixture("106p1_rt.ascii.txt")).time;

  it("carries the sea temperature read near the spectrum", async () => {
    const near = fixture("106p1_sst.ascii.txt").replace(/sstTime\[6\]\r?\n.*/, `sstTime[6]\n${[5, 4, 3, 2, 1, 0].map((k) => measured - k * 1800).join(", ")}`);
    const snapshot = await fetchBuoy("106p1", cdip(async () => near));
    expect(snapshot.sst).toEqual({ time: measured, celsius: expect.closeTo(27.15, 3) });
  });

  it("drops a sea temperature from hours away from the waves", async () => {
    const snapshot = await fetchBuoy("106p1", cdip(async () => fixture("106p1_sst.ascii.txt")));
    expect(snapshot.sst).toBeNull();
    expect(snapshot.spectrum.energy).toHaveLength(64);
  });

  it("still returns the waves when the temperature read fails or makes no sense", async () => {
    expect((await fetchBuoy("106p1", cdip(async () => { throw new Error("CDIP: 500"); }))).sst).toBeNull();
    expect((await fetchBuoy("106p1", cdip(async () => "garbage"))).sst).toBeNull();
  });

  it("sizes the half hour by the instrument's own sample rate", async () => {
    // A DWR4 (Barbers Point) samples at 2.56 Hz: the half hour is 4608 samples, not 2304.
    const urls: string[] = [];
    await fetchBuoy("238p1", async (url) => {
      urls.push(url);
      if (url.endsWith("?xyzSampleRate")) return "Dataset {\n    Float32 xyzSampleRate;\n} x;\n---\nxyzSampleRate, 2.56\n";
      return cdip(async () => "")(url);
    }).catch(() => {}); // the 1.28 Hz fixture cannot answer a 2.56 Hz query; only the ask matters here
    expect(urls.find((u) => u.includes("xyzZDisplacement["))).toContain(`xyzZDisplacement[${XY_COUNT - 4608}:1:${XY_COUNT - 1}]`);
  });

  it("refuses a station id that is not CDIP's shape", async () => {
    await expect(fetchBuoy("../etc", async () => "")).rejects.toThrow(/bad station/);
  });
});

describe("checkBuoy", () => {
  const measured = parseSpectrum(fixture("106p1_rt.ascii.txt")).time;
  const cdip = (rt: string) => async (url: string) => {
    if (url.endsWith("_xy.nc.dds")) return fixture("106p1_xy.dds.txt");
    if (url.endsWith("_rt.nc.dds")) return fixture("106p1_rt.dds.txt");
    if (url.includes("_xy.nc.ascii")) throw new Error("the check must not read the motion itself");
    return rt;
  };

  it("calls a station with a recent usable spectrum live", async () => {
    expect(await checkBuoy("106p1", cdip(fixture("106p1_rt.ascii.txt")), measured + 3600)).toBe("live");
  });

  it("calls it offline once the newest spectrum is hours old", async () => {
    expect(await checkBuoy("106p1", cdip(fixture("106p1_rt.ascii.txt")), measured + 7 * 3600)).toBe("offline");
  });

  it("calls it offline when every recent spectrum is flagged bad", async () => {
    const flagged = fixture("106p1_rt.ascii.txt").replace(/waveFlagPrimary\[1\]\r?\n1/, "waveFlagPrimary[1]\n4");
    expect(await checkBuoy("106p1", cdip(flagged), measured)).toBe("offline");
  });

  it("calls it offline when CDIP does not answer, and never asks for a malformed id", async () => {
    expect(await checkBuoy("106p1", async () => { throw new Error("down"); })).toBe("offline");
    let asked = false;
    expect(await checkBuoy("../etc", async () => { asked = true; return ""; })).toBe("offline");
    expect(asked).toBe(false);
  });
});

describe("parseSst", () => {
  const src = fixture("106p1_sst.ascii.txt");

  it("reads the latest good reading", () => {
    expect(parseSst(src)).toEqual({ time: 1790809100, celsius: expect.closeTo(27.15, 3) });
  });

  it("falls back past a flagged reading, and past one no sea could have", () => {
    const flagged = src.replace(/sstFlagPrimary\[6\]\r?\n1, 1, 1, 1, 1, 1/, "sstFlagPrimary[6]\n1, 1, 1, 1, 1, 4");
    expect(parseSst(flagged)?.time).toBe(1790807300);
    const absurd = src.replace("27.150002", "-999.0");
    expect(parseSst(absurd)?.celsius).toBeCloseTo(27.1, 3);
  });

  it("gives null when nothing is usable", () => {
    expect(parseSst(src.replace(/sstFlagPrimary\[6\]\r?\n.*/, "sstFlagPrimary[6]\n4, 4, 4, 4, 4, 4"))).toBeNull();
  });

  it("asks for the last few readings only", () => {
    expect(sstQuery(6279)).toBe("sstTime[6273:1:6278],sstFlagPrimary[6273:1:6278],sstSeaSurfaceTemperature[6273:1:6278]");
    expect(sstQuery(3)).toBe("sstTime[0:1:2],sstFlagPrimary[0:1:2],sstSeaSurfaceTemperature[0:1:2]");
  });
});

describe("a spectrum whose rows do not match its frequencies", () => {
  it("is never usable, so an empty or short row cannot reach the scene", () => {
    // The 64-band fixture read as if it had 100 bands: what the old query did to Barbers Point.
    const src = fixture("106p1_rt.ascii.txt");
    const freq = /waveFrequency\[64\]\r?\n([^\r\n]*)/.exec(src)!;
    const widened = src.replace(freq[0], `waveFrequency[100]\n${freq[1]}${", 0.6".repeat(36)}`);
    expect(() => parseSpectrum(widened)).toThrow(/usable/);
  });
});
