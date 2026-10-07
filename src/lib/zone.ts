/**
 * Local clock time at a station, from its IANA zone (daylight saving included), via the platform's
 * own time zone data.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Seconds the zone's clock is ahead of UTC at the UTC moment `utc` (Hawaii: -36000). */
export function offsetSeconds(utc: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(Math.floor(utc) * 1000))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) / 1000;
  return wall - Math.floor(utc);
}

/** Minutes past local midnight of a UTC time. */
export function localMinutes(utc: number, timeZone: string): number {
  const local = utc + offsetSeconds(utc, timeZone);
  return Math.floor((((local % 86400) + 86400) % 86400) / 60);
}

/** UTC seconds of local midnight starting the local day that contains `utc`. */
export function localMidnight(utc: number, timeZone: string): number {
  const offset = offsetSeconds(utc, timeZone);
  return Math.floor((utc + offset) / 86400) * 86400 - offset;
}

/** UTC seconds of `minutes` past local midnight on the local day that contains `utc`. */
export function atLocalMinutes(utc: number, minutes: number, timeZone: string): number {
  return localMidnight(utc, timeZone) + minutes * 60;
}

const names = new Map<string, Intl.DateTimeFormat>();

/** The zone's short name at that moment: "HST", "PDT", "EST". */
export function zoneName(utc: number, timeZone: string): string {
  let f = names.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" });
    names.set(timeZone, f);
  }
  return f.formatToParts(new Date(utc * 1000)).find((p) => p.type === "timeZoneName")?.value ?? timeZone;
}
