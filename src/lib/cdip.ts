import { numbers, parseAscii, parseDdsShapes, scalar, text } from "./opendap";

/**
 * CDIP (Coastal Data Information Program, Scripps) realtime buoy data, read from its public THREDDS
 * OPeNDAP server. Two files per station: `_rt.nc` holds the half-hourly spectra, `_xy.nc` the raw
 * buoy displacement since deployment (1.28 Hz on a DWR-G4, 2.56 Hz on a DWR4).
 */

export const CDIP_BASE = "https://thredds.cdip.ucsd.edu/thredds/dodsC/cdip/realtime";

/** A CDIP station id with its deployment suffix, e.g. `106p1`. */
export const STATION_ID = /^\d{3}p\d$/;

/** Seconds of displacement the snapshot carries: one CDIP record (30 min), which is also the chunk it arrives in. */
export const RECORD_SECONDS = 1800;

export interface BuoyRecord {
  /** UTC seconds of sample 0. */
  start: number;
  /** Samples per second. */
  rate: number;
  /** Metres, positive up / north / east. */
  z: number[];
  north: number[];
  east: number[];
  /** Samples flagged bad or missing, filled by linear interpolation. */
  repaired: number;
}

export interface BuoySpectrum {
  /** UTC seconds the spectrum's sample starts. */
  time: number;
  hs: number;
  tp: number;
  /** Peak direction, degrees clockwise from true north, the direction waves come from. */
  dp: number;
  frequency: number[];
  bandwidth: number[];
  /** m²/Hz. */
  energy: number[];
  /** Directional Fourier moments, nautical "from" convention (mean direction = atan2(b1, a1)). */
  a1: number[];
  b1: number[];
  a2: number[];
  b2: number[];
}

export interface BuoySnapshot {
  station: string;
  name: string;
  latitude: number;
  longitude: number;
  depth: number;
  record: BuoyRecord;
  spectrum: BuoySpectrum;
  /** The buoy's own sea-surface temperature, or null when it has none from near the spectrum's time. */
  sst: SeaTemperature | null;
}

export interface SeaTemperature {
  /** UTC seconds of the reading. */
  time: number;
  celsius: number;
}

const FILL = -999;
const BAD_FLAGS = new Set([3, 4, 9]);

/** Replace bad samples by linear interpolation between their good neighbours (edge gaps copy the nearest). */
export function repair(values: number[], bad: boolean[]): number[] {
  const out = values.slice();
  let last = -1;
  for (let i = 0; i <= out.length; i++) {
    if (i < out.length && bad[i]) continue;
    if (i - last > 1) {
      const from = last >= 0 ? out[last] : i < out.length ? out[i] : 0;
      const to = i < out.length ? out[i] : from;
      for (let j = last + 1; j < i; j++) out[j] = from + ((to - from) * (j - last)) / (i - last);
    }
    last = i;
  }
  return out;
}

export function parseRecord(ascii: string, firstIndex: number): BuoyRecord & { depth: number; latitude: number; longitude: number } {
  const v = parseAscii(ascii);
  const rate = scalar(v, "xyzSampleRate");
  const flags = numbers(v, "xyzFlagPrimary");
  const z = numbers(v, "xyzZDisplacement");
  const north = numbers(v, "xyzXDisplacement");
  // CDIP's Y axis points west.
  const west = numbers(v, "xyzYDisplacement");
  const bad = z.map((_, i) => BAD_FLAGS.has(flags[i]) || z[i] < FILL || north[i] < FILL || west[i] < FILL);
  const repaired = bad.filter(Boolean).length;
  if (repaired > z.length / 10) throw new Error(`CDIP: ${repaired} of ${z.length} displacement samples are bad`);
  return {
    // Per the file's own comment: time = xyzStartTime + index / rate - xyzFilterDelay.
    start: scalar(v, "xyzStartTime") + firstIndex / rate - scalar(v, "xyzFilterDelay"),
    rate,
    z: repair(z, bad),
    north: repair(north, bad),
    east: repair(west, bad).map((w) => (w === 0 ? 0 : -w)),
    repaired,
    depth: scalar(v, "metaWaterDepth"),
    latitude: scalar(v, "metaDeployLatitude"),
    longitude: scalar(v, "metaDeployLongitude"),
  };
}

/** Spectra fetched per request: the newest good one of these is used. */
export const SPECTRA_BACK = 4;

/** A spectrum CDIP has not flagged bad, with no fill values and moments inside their range. */
function usable(s: BuoySpectrum, flag: number): boolean {
  if (BAD_FLAGS.has(flag)) return false;
  // Every row the same length as the frequencies: a short row is a query that asked for the wrong
  // number of bands, and an empty one would pass every check below and leave the sea NaN.
  const bands = s.frequency.length;
  if (bands === 0 || ![s.energy, s.a1, s.b1, s.a2, s.b2].every((row) => row.length === bands)) return false;
  if (![s.hs, s.tp, s.dp, s.time].every(Number.isFinite) || s.hs < 0) return false;
  if (!s.energy.every((e) => Number.isFinite(e) && e >= 0)) return false;
  return [s.a1, s.b1, s.a2, s.b2].every((m) => m.every((x) => Number.isFinite(x) && Math.abs(x) <= 1));
}

/**
 * The newest usable spectrum among the rows of a spectra response (one row per time, oldest first).
 * A bad or partly missing spectrum would otherwise go straight into the ocean's initial spectrum.
 */
export function parseSpectrum(ascii: string): BuoySpectrum & { name: string } {
  const v = parseAscii(ascii);
  const frequency = numbers(v, "waveFrequency");
  const bands = frequency.length;
  const times = numbers(v, "waveTime");
  const flags = numbers(v, "waveFlagPrimary");
  const row = (name: string, i: number) => numbers(v, name).slice(i * bands, (i + 1) * bands);
  for (let i = times.length - 1; i >= 0; i--) {
    const spectrum: BuoySpectrum = {
      time: times[i],
      hs: numbers(v, "waveHs")[i],
      tp: numbers(v, "waveTp")[i],
      dp: numbers(v, "waveDp")[i],
      frequency,
      bandwidth: numbers(v, "waveBandwidth"),
      energy: row("waveEnergyDensity", i),
      a1: row("waveA1Value", i),
      b1: row("waveB1Value", i),
      a2: row("waveA2Value", i),
      b2: row("waveB2Value", i),
    };
    if (usable(spectrum, flags[i])) return { name: text(v, "metaStationName"), ...spectrum };
  }
  throw new Error(`CDIP: none of the last ${times.length} spectra is usable`);
}

export function recordQuery(count: number, rate: number): { query: string; firstIndex: number } {
  const n = Math.round(RECORD_SECONDS * rate);
  const first = count - n;
  const last = count - 1;
  const r = `[${first}:1:${last}]`;
  const vars = ["xyzStartTime", "xyzSampleRate", "xyzFilterDelay", "metaWaterDepth", "metaDeployLatitude", "metaDeployLongitude"];
  for (const name of ["xyzFlagPrimary", "xyzZDisplacement", "xyzXDisplacement", "xyzYDisplacement"]) vars.push(name + r);
  return { query: vars.join(","), firstIndex: first };
}

/** Sea temperature readings read back from the end, so a flagged latest one falls back to the one before. */
const SST_BACK = 6;

export function sstQuery(count: number): string {
  const t = `[${Math.max(0, count - SST_BACK)}:1:${count - 1}]`;
  return ["sstTime", "sstFlagPrimary", "sstSeaSurfaceTemperature"].map((name) => name + t).join(",");
}

/** The latest good sea temperature, or null if none of the readings is usable. */
export function parseSst(ascii: string): SeaTemperature | null {
  const v = parseAscii(ascii);
  const times = numbers(v, "sstTime");
  const flags = numbers(v, "sstFlagPrimary");
  const temps = numbers(v, "sstSeaSurfaceTemperature");
  for (let i = times.length - 1; i >= 0; i--) {
    const celsius = temps[i];
    // -5 to 40 °C: anything outside is a sensor fault, whatever the flag says.
    if (!BAD_FLAGS.has(flags[i]) && Number.isFinite(celsius) && celsius > -5 && celsius < 40) return { time: times[i], celsius };
  }
  return null;
}

/** `bands` is the dataset's own frequency count: 64 on most Waveriders, 100 on the newer DWR4. */
export function spectrumQuery(count: number, bands: number): string {
  const t = `[${Math.max(0, count - SPECTRA_BACK)}:1:${count - 1}]`;
  const vars = ["metaStationName", "waveFrequency", "waveBandwidth"];
  for (const name of ["waveTime", "waveFlagPrimary", "waveHs", "waveTp", "waveDp"]) vars.push(name + t);
  for (const name of ["waveEnergyDensity", "waveA1Value", "waveB1Value", "waveA2Value", "waveB2Value"]) vars.push(`${name}${t}[0:1:${bands - 1}]`);
  return vars.join(",");
}

type Fetcher = (url: string) => Promise<string>;

const defaultFetcher: Fetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (!res.ok) throw new Error(`CDIP: ${res.status} for ${url.split("?")[0]}`);
  return res.text();
};

/** A station whose newest usable spectrum is older than this has stopped reporting. */
export const STALE_SECONDS = 6 * 3600;

export type Availability = "live" | "offline";

/**
 * Whether a station is serving what the scene needs: a motion feed, and a usable spectrum from the
 * last few hours. Reads the spectra and the feed's shape only, not the motion itself, so it is cheap
 * enough to ask of every station at once.
 */
export async function checkBuoy(station: string, get: Fetcher = defaultFetcher, now = Date.now() / 1000): Promise<Availability> {
  if (!STATION_ID.test(station)) return "offline";
  try {
    const xy = `${CDIP_BASE}/${station}_xy.nc`;
    const rt = `${CDIP_BASE}/${station}_rt.nc`;
    const [xyDds, rtDds] = await Promise.all([get(`${xy}.dds`), get(`${rt}.dds`)]);
    const xyCount = parseDdsShapes(xyDds).get("xyzZDisplacement")?.[0];
    const rtShapes = parseDdsShapes(rtDds);
    const rtCount = rtShapes.get("waveTime")?.[0];
    const bands = rtShapes.get("waveFrequency")?.[0];
    if (!xyCount || !rtCount || !bands) return "offline";
    const spectrum = parseSpectrum(await get(`${rt}.ascii?${spectrumQuery(rtCount, bands)}`));
    return now - spectrum.time < STALE_SECONDS ? "live" : "offline";
  } catch {
    return "offline";
  }
}

/** The latest spectrum and the latest 30 minutes of buoy motion for one station. */
export async function fetchBuoy(station: string, get: Fetcher = defaultFetcher): Promise<BuoySnapshot> {
  if (!STATION_ID.test(station)) throw new Error(`CDIP: bad station id ${station}`);
  const xy = `${CDIP_BASE}/${station}_xy.nc`;
  const rt = `${CDIP_BASE}/${station}_rt.nc`;
  // The sample rate is the instrument's: 1.28 Hz on a DWR-G4, 2.56 Hz on a DWR4. It sets how many
  // samples make the half hour, so it is read with the structure rather than assumed.
  const [xyDds, rtDds, rateAscii] = await Promise.all([get(`${xy}.dds`), get(`${rt}.dds`), get(`${xy}.ascii?xyzSampleRate`)]);
  const xyCount = parseDdsShapes(xyDds).get("xyzZDisplacement")?.[0];
  const rtShapes = parseDdsShapes(rtDds);
  const rtCount = rtShapes.get("waveTime")?.[0];
  const bands = rtShapes.get("waveFrequency")?.[0];
  const sstCount = rtShapes.get("sstTime")?.[0];
  const rate = scalar(parseAscii(rateAscii), "xyzSampleRate");
  if (!xyCount || !rtCount || !bands) throw new Error("CDIP: dataset has no displacement or spectra");
  if (!(rate > 0)) throw new Error("CDIP: dataset has no sample rate");
  const { query, firstIndex } = recordQuery(xyCount, rate);
  // The temperature is a nicety: a buoy without it, or a failed read, still shows its waves.
  const sstRead = sstCount ? get(`${rt}.ascii?${sstQuery(sstCount)}`).then(parseSst).catch(() => null) : Promise.resolve(null);
  const [xyAscii, rtAscii, latestSst] = await Promise.all([get(`${xy}.ascii?${query}`), get(`${rt}.ascii?${spectrumQuery(rtCount, bands)}`), sstRead]);
  const { depth, latitude, longitude, ...record } = parseRecord(xyAscii, firstIndex);
  const { name, ...spectrum } = parseSpectrum(rtAscii);
  const sst = latestSst && Math.abs(latestSst.time - spectrum.time) < STALE_SECONDS ? latestSst : null;
  return { station, name, latitude, longitude, depth, record, spectrum, sst };
}
