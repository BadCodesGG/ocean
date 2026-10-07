import { fetchBuoy } from "@/lib/cdip";
import type { BuoyResponse } from "@/lib/snapshot";
import { stationById } from "@/lib/stations";
import { fetchWeather } from "@/lib/weather";

/**
 * A listed CDIP station's latest spectrum and 30 minutes of buoy motion, with the weather model's
 * current cloud and wind at the buoy, as JSON. CDIP publishes a new record every half hour, so the
 * CDN keeps a response for five minutes and serves it stale for up to half an hour while it
 * refreshes; every visitor then shares one upstream read.
 */

const CACHE = "public, s-maxage=300, stale-while-revalidate=1800";
// Per instance, so a warm function does not re-read CDIP for each CDN miss. The read itself is kept,
// so requests that arrive while it is under way share it rather than starting their own.
const memo = new Map<string, { at: number; snapshot: Promise<BuoyResponse | null> }>();
const MEMO_MS = 60_000;
/** Where each station was last seen, so its weather can be fetched alongside CDIP rather than after. */
const coordinates = new Map<string, [number, number]>();
// Only listed stations reach CDIP. When one of them is down, remember the failure briefly and let the
// CDN hold it too, so a busy page does not become a stream of requests to CDIP.
const FAILED = { error: "buoy data unavailable" };
const FAILED_CACHE = "public, s-maxage=60";

export async function GET(_req: Request, ctx: RouteContext<"/api/buoy/[station]">) {
  const { station } = await ctx.params;
  if (!stationById(station)) return Response.json({ error: "unknown station" }, { status: 404 });
  let hit = memo.get(station);
  if (!hit || Date.now() - hit.at >= MEMO_MS) {
    hit = { at: Date.now(), snapshot: read(station) };
    memo.set(station, hit);
  }
  const snapshot = await hit.snapshot;
  return snapshot
    ? Response.json(snapshot, { headers: { "Cache-Control": CACHE } })
    : Response.json(FAILED, { status: 502, headers: { "Cache-Control": FAILED_CACHE } });
}

async function read(station: string): Promise<BuoyResponse | null> {
  const known = coordinates.get(station);
  const early = known ? fetchWeather(...known) : null;
  try {
    const buoy = await fetchBuoy(station);
    coordinates.set(station, [buoy.latitude, buoy.longitude]);
    return { ...buoy, weather: await (early ?? fetchWeather(buoy.latitude, buoy.longitude)) };
  } catch (error) {
    console.error("buoy", station, error);
    return null;
  }
}
