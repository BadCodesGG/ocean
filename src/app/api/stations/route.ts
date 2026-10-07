import { checkBuoy, type Availability } from "@/lib/cdip";
import { STATIONS } from "@/lib/stations";

/**
 * Which listed stations are reporting right now, as `{ [id]: "live" | "offline" }`, so the picker can
 * leave out the ones that would only show an error. One cheap read per station (the spectra, not the
 * motion), shared: the CDN holds the answer for five minutes, and a warm instance reuses its own.
 * When every station reads offline the fault is almost certainly ours or the network's, not fifteen
 * buoys at once, so that answers 502 and the picker offers them all.
 */

// Short staleness: a station misread as offline must not stay greyed out for long.
const CACHE = "public, s-maxage=300, stale-while-revalidate=60";
const MEMO_MS = 5 * 60_000;
let memo: { at: number; result: Promise<Record<string, Availability>> } | null = null;

function checkAll(): Promise<Record<string, Availability>> {
  return Promise.all(STATIONS.map(async (s) => [s.id, await checkBuoy(s.id)] as const)).then(Object.fromEntries);
}

export async function GET() {
  if (!memo || Date.now() - memo.at > MEMO_MS) memo = { at: Date.now(), result: checkAll() };
  const result = await memo.result;
  if (Object.values(result).every((a) => a === "offline")) {
    memo = null;
    return Response.json({ error: "station status unavailable" }, { status: 502, headers: { "Cache-Control": "public, s-maxage=60" } });
  }
  return Response.json(result, { headers: { "Cache-Control": CACHE } });
}
