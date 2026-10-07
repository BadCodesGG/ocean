/**
 * Current weather at a point, from Open-Meteo's forecast model (free, no key). The buoy measures waves,
 * not weather; this is what sets the scene's clouds, rain, haze and the roughness of the surface.
 */

export interface Weather {
  /** UTC seconds of the model's current step. */
  time: number;
  /** 0 to 1. */
  cloudCover: number;
  /** m/s at 10 m, and the direction it blows from (degrees clockwise from north). */
  windSpeed: number;
  windDirection: number;
  /** Rain rate, mm per hour, from the model's last interval. */
  precipitation: number;
  /** Horizontal visibility, metres. */
  visibility: number;
  /** WMO weather code (95 to 99: thunderstorm). */
  code: number;
}

/** Visibility when the model gives none: a clear day at sea. */
export const CLEAR_VISIBILITY = 24_000;

export function weatherUrl(latitude: number, longitude: number): string {
  const q = new URLSearchParams({
    latitude: latitude.toFixed(3),
    longitude: longitude.toFixed(3),
    current: "cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,weather_code,visibility",
    wind_speed_unit: "ms",
    timezone: "GMT",
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

export function parseWeather(json: unknown): Weather {
  const current = (json as { current?: Record<string, unknown> })?.current;
  const num = (key: string) => {
    const v = current?.[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`weather: missing ${key}`);
    return v;
  };
  /** Rain, haze and code are garnish on garnish: missing ones fall back to fair weather. */
  const optional = (key: string, fallback: number) => {
    const v = current?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  const time = Date.parse(`${String(current?.time)}Z`) / 1000;
  if (!Number.isFinite(time)) throw new Error("weather: missing time");
  // Precipitation is the total over the model's interval (15 minutes); make it a rate.
  const hours = optional("interval", 900) / 3600;
  return {
    time,
    cloudCover: Math.min(1, Math.max(0, num("cloud_cover") / 100)),
    windSpeed: Math.max(0, num("wind_speed_10m")),
    windDirection: num("wind_direction_10m"),
    precipitation: Math.max(0, optional("precipitation", 0)) / Math.max(hours, 1 / 60),
    visibility: Math.min(50_000, Math.max(50, optional("visibility", CLEAR_VISIBILITY))),
    code: optional("weather_code", 0),
  };
}

/** Null rather than an error: weather is garnish on the buoy's data, never a reason to fail the page. */
export async function fetchWeather(latitude: number, longitude: number): Promise<Weather | null> {
  try {
    const res = await fetch(weatherUrl(latitude, longitude), { signal: AbortSignal.timeout(8_000), cache: "no-store" });
    if (!res.ok) return null;
    return parseWeather(await res.json());
  } catch {
    return null;
  }
}
