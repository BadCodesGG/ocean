import { sunPosition } from "@/engine/ephemeris";
import { WEATHER_PRESETS, type WeatherPreset } from "./conditions";
import { SETTING_KEYS } from "./storage";
import { localMidnight } from "./zone";

/** What the viewer has changed about the scene; null fields follow the live data. */
export interface LookSettings {
  lightAt: number | null;
  cloudCover: number | null;
  weather: WeatherPreset | null;
}

export const LIVE_LOOK: LookSettings = { lightAt: null, cloudCover: null, weather: null };
const KEY = SETTING_KEYS.look;

export function loadLook(): LookSettings {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return LIVE_LOOK;
    const v = JSON.parse(raw) as Partial<LookSettings>;
    const minutes = typeof v.lightAt === "number" && v.lightAt >= 0 && v.lightAt < 1440 ? v.lightAt : null;
    const cover = typeof v.cloudCover === "number" && v.cloudCover >= 0 && v.cloudCover <= 1 ? v.cloudCover : null;
    const weather = WEATHER_PRESETS.includes(v.weather as WeatherPreset) ? (v.weather as WeatherPreset) : null;
    return { lightAt: minutes, cloudCover: cover, weather };
  } catch {
    return LIVE_LOOK;
  }
}

export function saveLook(look: LookSettings) {
  try {
    if (look.lightAt === null && look.cloudCover === null && look.weather === null) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, JSON.stringify(look));
  } catch {
    // Private windows and blocked storage: the look simply is not remembered.
  }
}

export interface Presets {
  dawn: number;
  noon: number;
  dusk: number;
  night: number;
}

/**
 * Named moments on the local day containing `utc`, from the sun at the buoy: a little after sunrise,
 * solar noon, a little before sunset (the sun about a degree and a half up, as in the hero shot), and
 * late evening.
 */
export function presets(utc: number, latitude: number, longitude: number, timeZone: string): Presets {
  const midnight = localMidnight(utc, timeZone);
  let rise = 360;
  let set = 1080;
  let noon = 720;
  let best = -90;
  let prev = sunPosition(midnight, latitude, longitude).elevation;
  for (let m = 1; m < 1440; m++) {
    const e = sunPosition(midnight + m * 60, latitude, longitude).elevation;
    if (prev < 0 && e >= 0) rise = m;
    if (prev >= 0 && e < 0) set = m;
    if (e > best) {
      best = e;
      noon = m;
    }
    prev = e;
  }
  return { dawn: rise + 12, noon, dusk: set - 9, night: 22 * 60 };
}

export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;
}

/** "1 h 22 min" */
export function formatLag(seconds: number): string {
  const m = Math.round(seconds / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}
