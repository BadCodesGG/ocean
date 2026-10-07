import { CLEAR_VISIBILITY, type Weather } from "./weather";

/**
 * What the scene's weather is: the model's current weather at the buoy, or a preset the viewer chose.
 * Only the sky, the air and the surface texture change; the waves are always the buoy's own.
 */

export type WeatherPreset = "clear" | "showers" | "squall" | "storm";
export const WEATHER_PRESETS: readonly WeatherPreset[] = ["clear", "showers", "squall", "storm"];

export interface Conditions {
  /** 0 to 1. */
  cloudCover: number;
  /** Rain rate, mm per hour. */
  rain: number;
  /** Horizontal visibility, metres. */
  visibility: number;
  /** Wind at 10 m, m/s: sets the surface's roughness and whitecaps. */
  wind: number;
  thunder: boolean;
}

export const PRESETS: Record<WeatherPreset, Conditions> = {
  clear: { cloudCover: 0.12, rain: 0, visibility: 40_000, wind: 5, thunder: false },
  // Passing trade-wind showers: broken cloud, light rain, good visibility between them.
  showers: { cloudCover: 0.7, rain: 2.5, visibility: 12_000, wind: 8, thunder: false },
  // A squall line: overcast, a downpour, a few kilometres of visibility, a strong gusty wind.
  squall: { cloudCover: 0.97, rain: 14, visibility: 3_500, wind: 14, thunder: false },
  storm: { cloudCover: 1, rain: 30, visibility: 1_500, wind: 20, thunder: true },
};

const FAIR: Conditions = { cloudCover: 0.35, rain: 0, visibility: CLEAR_VISIBILITY, wind: 7, thunder: false };

/** The conditions to draw: a preset if chosen, else the live weather (or fair weather without it); the clouds slider wins either way. */
export function conditions(weather: Weather | null, preset: WeatherPreset | null, cloudOverride: number | null): Conditions {
  const base: Conditions = preset
    ? PRESETS[preset]
    : weather
      ? { cloudCover: weather.cloudCover, rain: weather.precipitation, visibility: weather.visibility, wind: weather.windSpeed, thunder: weather.code >= 95 }
      : FAIR;
  return cloudOverride === null ? base : { ...base, cloudCover: cloudOverride };
}

/** Rain rate on a 0 to 1 scale that looks even: drizzle registers, a downpour saturates. */
export function rainIntensity(mmPerHour: number): number {
  return Math.min(1, Math.log1p(Math.max(0, mmPerHour)) / Math.log1p(30));
}
