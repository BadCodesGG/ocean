/**
 * The land and sea floor around a buoy, from the open Terrain Tiles dataset on AWS (Terrarium PNGs:
 * USGS 10 m elevation on US land, SRTM elsewhere, ETOPO1 bathymetry). Tiles are Web Mercator; the
 * scene is metres east (x) and south (z) of the buoy, so each grid cell is found in the tiles by its
 * latitude and longitude and sampled bilinearly.
 */

export const TERRAIN_TILES = "https://elevation-tiles-prod.s3.amazonaws.com/terrarium";
export const TILE_SIZE = 256;
const EARTH_RADIUS = 6_371_000;

/** Height in metres from a Terrarium pixel. */
export function terrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional tile coordinates of a point at a zoom level. */
export function tileOf(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const phi = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n,
  };
}

/** Latitude and longitude of a point `east` and `south` metres from an origin (fine over tens of kilometres). */
export function offsetLatLon(lat: number, lon: number, east: number, south: number): { lat: number; lon: number } {
  return {
    lat: lat - (south / EARTH_RADIUS) * (180 / Math.PI),
    lon: lon + (east / (EARTH_RADIUS * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
  };
}

export interface GridSpec {
  /** Cells along each side. */
  size: number;
  /** Width of the square, metres, centred on the buoy. */
  extent: number;
  zoom: number;
}

/** Centre of cell i along a side, metres from the buoy. */
export function cellCentre(spec: GridSpec, i: number): number {
  return -spec.extent / 2 + ((i + 0.5) * spec.extent) / spec.size;
}

/** Every tile the grid touches, as "x/y" keys. */
export function tilesFor(lat: number, lon: number, spec: GridSpec): { x: number; y: number }[] {
  const half = spec.extent / 2;
  const nw = offsetLatLon(lat, lon, -half, -half);
  const se = offsetLatLon(lat, lon, half, half);
  const a = tileOf(nw.lat, nw.lon, spec.zoom);
  const b = tileOf(se.lat, se.lon, spec.zoom);
  const tiles: { x: number; y: number }[] = [];
  // One tile of margin for bilinear sampling across an edge.
  for (let y = Math.floor(a.y - 0.01); y <= Math.floor(b.y + 0.01); y++) {
    for (let x = Math.floor(a.x - 0.01); x <= Math.floor(b.x + 0.01); x++) tiles.push({ x, y });
  }
  return tiles;
}

/** A decoded tile: heights in metres, TILE_SIZE squared, row-major from its north-west corner. */
export type Tile = Float32Array;

/**
 * Heights from a tile's pixels. Where a tile's only source is land-only (GMTED, as off California),
 * the sea is filled with exactly 0 m, pixel (128, 0, 0): that reads as NaN, sea of unknown depth.
 */
export function decodeTile(rgba: Uint8ClampedArray | Uint8Array): Tile {
  const out = new Float32Array(TILE_SIZE * TILE_SIZE);
  for (let i = 0; i < out.length; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    out[i] = r === 128 && g === 0 && b === 0 ? NaN : terrarium(r, g, b);
  }
  return out;
}

/** Nearshore sea floor falls about a metre in fifty; open water past it is simply deep. */
const SHORE_SLOPE = 0.02;
const DEEP = -150;

/**
 * Give sea of unknown depth (NaN) a depth from its distance to the nearest land, so a coast without
 * bathymetry still has shallows and a surf line. Distances are chamfered over the grid in two passes.
 */
export function fillSea(heights: Float32Array, spec: GridSpec): Float32Array {
  const n = spec.size;
  const cell = spec.extent / n;
  const far = 1e9;
  const dist = new Float32Array(n * n);
  for (let i = 0; i < dist.length; i++) dist[i] = heights[i] > 0 ? 0 : far;
  const D = Math.SQRT2;
  const relax = (i: number, j: number, cost: number) => {
    if (j >= 0 && j < n * n && dist[j] + cost < dist[i]) dist[i] = dist[j] + cost;
  };
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + c;
      if (c > 0) relax(i, i - 1, 1);
      if (r > 0) {
        relax(i, i - n, 1);
        if (c > 0) relax(i, i - n - 1, D);
        if (c < n - 1) relax(i, i - n + 1, D);
      }
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    for (let c = n - 1; c >= 0; c--) {
      const i = r * n + c;
      if (c < n - 1) relax(i, i + 1, 1);
      if (r < n - 1) {
        relax(i, i + n, 1);
        if (c < n - 1) relax(i, i + n + 1, D);
        if (c > 0) relax(i, i + n - 1, D);
      }
    }
  }
  for (let i = 0; i < heights.length; i++) {
    if (Number.isNaN(heights[i])) heights[i] = dist[i] >= far ? DEEP : Math.max(DEEP, -(1 + dist[i] * cell * SHORE_SLOPE));
  }
  return heights;
}

/**
 * Heights on the grid, row-major with rows running south and columns east. Where a tile is missing
 * (it failed to load), the cell reads as deep water, so the sea simply carries on; sea of unknown
 * depth is given one by fillSea.
 */
export function resample(lat: number, lon: number, spec: GridSpec, tile: (x: number, y: number) => Tile | undefined): Float32Array {
  const out = new Float32Array(spec.size * spec.size);
  const pixel = (px: number, py: number) => {
    const tx = Math.floor(px / TILE_SIZE);
    const ty = Math.floor(py / TILE_SIZE);
    const t = tile(tx, ty);
    if (!t) return -100;
    return t[(py - ty * TILE_SIZE) * TILE_SIZE + (px - tx * TILE_SIZE)];
  };
  for (let row = 0; row < spec.size; row++) {
    for (let col = 0; col < spec.size; col++) {
      const p = offsetLatLon(lat, lon, cellCentre(spec, col), cellCentre(spec, row));
      const t = tileOf(p.lat, p.lon, spec.zoom);
      // Pixel centres sit at half-integers.
      const fx = t.x * TILE_SIZE - 0.5;
      const fy = t.y * TILE_SIZE - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const u = fx - x0;
      const v = fy - y0;
      // Bilinear over the known pixels; mostly unknown sea stays unknown.
      let sum = 0;
      let weight = 0;
      const tap = (h: number, w: number) => {
        if (Number.isNaN(h)) return;
        sum += h * w;
        weight += w;
      };
      tap(pixel(x0, y0), (1 - u) * (1 - v));
      tap(pixel(x0 + 1, y0), u * (1 - v));
      tap(pixel(x0, y0 + 1), (1 - u) * v);
      tap(pixel(x0 + 1, y0 + 1), u * v);
      out[row * spec.size + col] = weight >= 0.5 ? sum / weight : NaN;
    }
  }
  return fillSea(out, spec);
}
