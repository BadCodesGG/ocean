import { describe, expect, it } from "vitest";
import { cellCentre, decodeTile, fillSea, offsetLatLon, resample, terrarium, TILE_SIZE, tileOf, tilesFor, type GridSpec } from "./terrain";

describe("terrarium", () => {
  it("decodes sea level, land and sea floor", () => {
    expect(terrarium(128, 0, 0)).toBe(0);
    expect(terrarium(128, 100, 128)).toBe(100.5);
    expect(terrarium(127, 156, 0)).toBe(-100);
  });
});

describe("tileOf", () => {
  it("puts null island at the middle of the world", () => {
    expect(tileOf(0, 0, 1)).toEqual({ x: 1, y: 1 });
  });

  it("finds Waimea Bay's buoy in the tile the dataset has it in", () => {
    const t = tileOf(21.671, -158.118, 12);
    expect(Math.floor(t.x)).toBe(248);
    expect(Math.floor(t.y)).toBe(1795);
  });
});

describe("offsetLatLon", () => {
  it("moves a kilometre north and east by the right angles", () => {
    const p = offsetLatLon(21.671, -158.118, 1000, -1000);
    expect(p.lat - 21.671).toBeCloseTo(0.008993, 5);
    expect(p.lon + 158.118).toBeCloseTo(0.008993 / Math.cos((21.671 * Math.PI) / 180), 5);
  });
});

describe("resample", () => {
  const spec: GridSpec = { size: 8, extent: 2000, zoom: 12 };

  it("covers the grid with the tiles it asks for", () => {
    const tiles = tilesFor(21.671, -158.118, spec);
    const keys = new Set(tiles.map((t) => `${t.x}/${t.y}`));
    for (const i of [0, spec.size - 1]) {
      for (const j of [0, spec.size - 1]) {
        const p = offsetLatLon(21.671, -158.118, cellCentre(spec, i), cellCentre(spec, j));
        const t = tileOf(p.lat, p.lon, spec.zoom);
        expect(keys.has(`${Math.floor(t.x)}/${Math.floor(t.y)}`)).toBe(true);
      }
    }
  });

  it("reads a sloping tile back as the same slope, east up and south down", () => {
    // Height rises 1 m per pixel east across the whole world at this zoom.
    const tile = (x: number) => {
      const t = new Float32Array(TILE_SIZE * TILE_SIZE);
      for (let i = 0; i < t.length; i++) t[i] = x * TILE_SIZE + (i % TILE_SIZE);
      return t;
    };
    const h = resample(21.671, -158.118, spec, (x) => tile(x));
    const metresPerPixel = (2 * Math.PI * 6_371_000 * Math.cos((21.671 * Math.PI) / 180)) / (TILE_SIZE * 2 ** spec.zoom);
    const step = spec.extent / spec.size / metresPerPixel;
    expect(h[1] - h[0]).toBeCloseTo(step, 2);
    expect(h[spec.size] - h[0]).toBeCloseTo(0, 5);
  });

  it("reads a missing tile as deep water", () => {
    const h = resample(21.671, -158.118, spec, () => undefined);
    expect(h.every((v) => v === -100)).toBe(true);
  });
});

describe("sea of unknown depth", () => {
  it("decodes the land-only sources' exact 0 m fill as unknown, and real heights as heights", () => {
    const px = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    px.set([128, 0, 0, 255, 128, 0, 1, 255, 128, 3, 0, 255], 0);
    const t = decodeTile(px);
    expect(Number.isNaN(t[0])).toBe(true);
    expect(t[1]).toBeCloseTo(1 / 256, 6);
    expect(t[2]).toBe(3);
  });

  it("deepens away from the shore and stays deep with no land in sight", () => {
    const spec: GridSpec = { size: 6, extent: 600, zoom: 12 };
    const h = new Float32Array(36).fill(NaN);
    for (let r = 0; r < 6; r++) h[r * 6] = 5;
    fillSea(h, spec);
    expect(h[0]).toBe(5);
    expect(h[1]).toBeCloseTo(-3, 5);
    expect(h[5]).toBeCloseTo(-11, 5);
    expect(h[2]).toBeLessThan(h[1]);
    const empty = fillSea(new Float32Array(36).fill(NaN), spec);
    expect(empty.every((v) => v === -150)).toBe(true);
  });

  it("keeps real bathymetry", () => {
    const spec: GridSpec = { size: 2, extent: 200, zoom: 12 };
    const h = fillSea(new Float32Array([4, -30, NaN, -30]), spec);
    expect(Array.from(h.slice(0, 2))).toEqual([4, -30]);
    expect(h[2]).toBeCloseTo(-3, 5);
  });
});
