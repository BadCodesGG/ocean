/**
 * Where the sun and moon are in the sky, from a time and a place. Low-precision formulas from the
 * Astronomical Almanac (sun, about 0.01°) and a truncated Meeus lunar theory (moon, about 0.3°): far
 * finer than a pixel of sky, and cheap enough to run every frame.
 */

const RAD = Math.PI / 180;

export interface SkyPosition {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Degrees above the horizon, as seen (refraction included). */
  elevation: number;
}

function julianDays(epochSeconds: number): number {
  return epochSeconds / 86400 + 2440587.5 - 2451545.0;
}

const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Ecliptic longitude/latitude (degrees) to horizontal coordinates for an observer. */
function horizontal(lambda: number, beta: number, d: number, latitude: number, longitude: number): { azimuth: number; altitude: number } {
  const eps = (23.439 - 0.0000004 * d) * RAD;
  const l = lambda * RAD;
  const b = beta * RAD;
  const ra = Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l));
  const gmst = wrap(280.46061837 + 360.98564736629 * d);
  const hourAngle = (gmst + longitude) * RAD - ra;
  const phi = latitude * RAD;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(hourAngle));
  const azimuth = Math.atan2(-Math.sin(hourAngle), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(hourAngle));
  return { azimuth: wrap(azimuth / RAD), altitude: altitude / RAD };
}

/** Atmospheric refraction (Bennett), degrees to add to a true altitude. */
export function refraction(altitude: number): number {
  if (altitude < -2) return 0;
  return 1.02 / Math.tan((altitude + 10.3 / (altitude + 5.11)) * RAD) / 60;
}

export function sunPosition(epochSeconds: number, latitude: number, longitude: number): SkyPosition {
  const d = julianDays(epochSeconds);
  const g = wrap(357.529 + 0.98560028 * d) * RAD;
  const q = wrap(280.459 + 0.98564736 * d);
  const lambda = q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g);
  const { azimuth, altitude } = horizontal(lambda, 0, d, latitude, longitude);
  return { azimuth, elevation: altitude + refraction(altitude) };
}

export interface MoonPosition extends SkyPosition {
  /** Fraction of the disk lit, 0 (new) to 1 (full). */
  illumination: number;
}

export function moonPosition(epochSeconds: number, latitude: number, longitude: number): MoonPosition {
  const d = julianDays(epochSeconds);
  const L = wrap(218.316 + 13.176396 * d);
  const Mm = wrap(134.963 + 13.064993 * d) * RAD;
  const Ms = wrap(357.529 + 0.98560028 * d) * RAD;
  const D = wrap(297.85 + 12.190749 * d) * RAD;
  const F = wrap(93.272 + 13.22935 * d) * RAD;
  const lambda =
    L +
    6.289 * Math.sin(Mm) +
    1.274 * Math.sin(2 * D - Mm) +
    0.658 * Math.sin(2 * D) +
    0.214 * Math.sin(2 * Mm) -
    0.186 * Math.sin(Ms) -
    0.114 * Math.sin(2 * F);
  const beta = 5.128 * Math.sin(F) + 0.281 * Math.sin(Mm + F) + 0.278 * Math.sin(Mm - F) + 0.173 * Math.sin(2 * D - F);
  const { azimuth, altitude } = horizontal(lambda, beta, d, latitude, longitude);
  // Parallax: seen from the surface rather than the Earth's centre, the moon sits up to a degree lower.
  const topocentric = altitude - 0.95 * Math.cos(altitude * RAD);
  // Illumination from the sun-moon elongation (the sun's own ecliptic longitude, latitude ~0).
  const sunLambda = wrap(280.459 + 0.98564736 * d) + 1.915 * Math.sin(Ms) + 0.02 * Math.sin(2 * Ms);
  const cosElongation = Math.cos(beta * RAD) * Math.cos((lambda - sunLambda) * RAD);
  return { azimuth, elevation: topocentric + refraction(topocentric), illumination: (1 - cosElongation) / 2 };
}

/** Unit vector toward a sky position on the world axes (x east, y up, z south). */
export function toDirection({ azimuth, elevation }: SkyPosition): [number, number, number] {
  const az = azimuth * RAD;
  const el = elevation * RAD;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}
