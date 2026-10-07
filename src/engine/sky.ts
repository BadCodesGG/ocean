/**
 * A physically based sky: single scattering through a Rayleigh + Mie + ozone atmosphere, with a thin
 * cloud deck, baked once per sun position into an equirectangular texture that both the background
 * and the water's reflections read. Elevation is stored with a square-root warp so the horizon, where
 * every interesting colour at dusk lives, gets most of the texels.
 */

export const ATMOSPHERE_GLSL = /* glsl */ `
const float EARTH_R = 6360e3;
const float ATMOS_R = 6420e3;
const vec3 RAYLEIGH = vec3(5.802e-6, 13.558e-6, 33.1e-6);
const float MIE = 3.996e-6;
const float MIE_EXT = 4.44e-6;
const vec3 OZONE = vec3(0.650e-6, 1.881e-6, 0.085e-6);
const float SUN_ILLUMINANCE = 20.0;

float raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  float c = dot(o, o) - r * r;
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  float t0 = -b - h;
  float t1 = -b + h;
  return t0 > 0.0 ? t0 : t1;
}

vec3 densities(float height) {
  float ozone = max(0.0, 1.0 - abs(height - 25e3) / 15e3);
  return vec3(exp(-height / 8e3), exp(-height / 1.2e3), ozone);
}

vec3 extinction(vec3 d) { return RAYLEIGH * d.x + MIE_EXT * d.y + OZONE * d.z; }

/**
 * Transmittance from point p toward the sun. The planet's shadow has a soft edge a few kilometres
 * wide: a hard one turns the few samples of a night sky into visible arcs.
 */
vec3 sunTransmittance(vec3 p, vec3 sun) {
  float along = dot(p, sun);
  float closest = along < 0.0 ? sqrt(max(0.0, dot(p, p) - along * along)) : length(p);
  float shadow = smoothstep(EARTH_R - 2e3, EARTH_R + 6e3, closest);
  if (shadow <= 0.0) return vec3(0.0);
  float len = raySphere(p, sun, ATMOS_R);
  const int STEPS = 12;
  float dt = len / float(STEPS);
  vec3 depth = vec3(0.0);
  for (int i = 0; i < STEPS; i++) {
    vec3 q = p + sun * (float(i) + 0.5) * dt;
    depth += densities(max(0.0, length(q) - EARTH_R)) * dt;
  }
  return exp(-extinction(depth)) * shadow;
}

float phaseRayleigh(float mu) { return 3.0 / (16.0 * 3.14159265) * (1.0 + mu * mu); }
float phaseMie(float mu) {
  const float g = 0.8;
  float g2 = g * g;
  return 3.0 / (8.0 * 3.14159265) * (1.0 - g2) * (1.0 + mu * mu) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5));
}

uniform vec3 moon;
/** Moonlight over sunlight at the top of the atmosphere: about 2.5e-6 at full moon, less as it wanes. */
uniform float moonScale;

/**
 * In-scattered radiance and transmittance along a ray from the eye (metres above the sea) for up to
 * maxDist metres, lit by the sun and, when it is up and bright enough to matter, the moon.
 */
/** Per-pixel offset for the march, so what steps remain become fine noise rather than bands. */
float marchJitter() { return fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453); }

vec3 scatter(float eyeHeight, vec3 dir, vec3 sun, float maxDist, out vec3 transmittance) {
  vec3 o = vec3(0.0, EARTH_R + eyeHeight, 0.0);
  float len = raySphere(o, dir, ATMOS_R);
  float ground = raySphere(o, dir, EARTH_R);
  if (ground > 0.0) len = min(len, ground);
  len = min(len, maxDist);
  const int STEPS = 32;
  float dt = len / float(STEPS);
  float mu = dot(dir, sun);
  float pr = phaseRayleigh(mu);
  float pm = phaseMie(mu);
  float muM = dot(dir, moon);
  float prM = phaseRayleigh(muM);
  float pmM = phaseMie(muM);
  bool lunar = moonScale > 0.0 && moon.y > -0.15;
  vec3 depth = vec3(0.0);
  vec3 sum = vec3(0.0);
  float jitter = marchJitter();
  for (int i = 0; i < STEPS; i++) {
    vec3 p = o + dir * (float(i) + jitter) * dt;
    vec3 d = densities(length(p) - EARTH_R);
    depth += d * dt;
    vec3 view = exp(-extinction(depth));
    sum += view * sunTransmittance(p, sun) * (RAYLEIGH * d.x * pr + MIE * d.y * pm) * dt;
    if (lunar) sum += view * sunTransmittance(p, moon) * moonScale * (RAYLEIGH * d.x * prM + MIE * d.y * pmM) * dt;
  }
  transmittance = exp(-extinction(depth));
  // Airglow and starlight: the night sky's own faint floor, so a moonless night is not pure black.
  return sum * SUN_ILLUMINANCE + vec3(0.6, 0.75, 1.0) * 2e-7;
}
`;

export const SKY_BAKE_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 sun;
uniform vec2 resolution;
uniform float cloudCover;
uniform float cloudSeed;
/** 0 to 1: how much of a rain cloud the deck is, deep and dark underneath rather than a lit veil. */
uniform float stormy;
/** 1: the warped layout the water and dome read. 0: three.js equirect layout, for PMREM (the buoy's lighting). */
uniform float warped;
/** Multiplies the warped bake (see skyScale in the readers); the equirect bake stays absolute. */
uniform float skyScale;
out vec4 color;
${ATMOSPHERE_GLSL}

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  mat2 r = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 7; i++) { v += a * noise(p); p = r * p * 2.03 + 17.1; a *= 0.5; }
  return v;
}

vec3 directionFromUv(vec2 uv) {
  float phi = (uv.x - 0.5) * 2.0 * 3.14159265;
  float s = uv.y * 2.0 - 1.0;
  if (warped < 0.5) {
    float e = s * 1.5707963;
    return vec3(cos(e) * cos(phi), sin(e), cos(e) * sin(phi));
  }
  float elev = sign(s) * s * s * 1.5707963;
  return vec3(cos(elev) * sin(phi), sin(elev), -cos(elev) * cos(phi));
}

void main() {
  vec2 uv = gl_FragCoord.xy / resolution;
  vec3 dir = directionFromUv(uv);
  vec3 t;
  // Below the horizon only reflections ever look; give them the horizon's colour, not the ground's.
  vec3 d = normalize(vec3(dir.x, max(dir.y, 0.0005), dir.z));
  vec3 sky = scatter(2.0, d, sun, 1e9, t);

  // A cloud deck at 1.6 km: fBm coverage, lit by the sun through the atmosphere, forward scattering toward it.
  const float CLOUD_Y = 1600.0;
  float cover = 0.0;
  if (dir.y > 0.002) {
    float dist = CLOUD_Y / dir.y;
    vec2 p = d.xz * dist;
    float base = fbm(p / 5200.0 + cloudSeed);
    float detail = fbm(p / 900.0 - cloudSeed * 1.7);
    float density = smoothstep(1.0 - cloudCover, 1.0 - cloudCover + 0.28, base * 0.75 + detail * 0.35);
    vec3 cloudPoint = vec3(0.0, EARTH_R + CLOUD_Y, 0.0) + vec3(p.x, 0.0, p.y);
    float mu = dot(d, sun);
    float muM = dot(d, moon);
    float silver = 0.08 + 1.4 * pow(max(mu, 0.0), 24.0) + 0.25 * pow(max(mu, 0.0), 3.0);
    float silverM = 0.08 + 1.4 * pow(max(muM, 0.0), 24.0) + 0.25 * pow(max(muM, 0.0), 3.0);
    vec3 lit = sunTransmittance(cloudPoint, sun) * SUN_ILLUMINANCE * silver
      + sunTransmittance(cloudPoint, moon) * SUN_ILLUMINANCE * moonScale * silverM;
    // Thicker cloud is darker underneath; the sun reaches a low deck only side-on at dusk.
    float thickness = density * (0.5 + 0.5 * detail) * (1.0 + 2.5 * stormy);
    vec3 ambient = scatter(CLOUD_Y, vec3(0.0, 1.0, 0.0), sun, 1e9, t) * 0.9;
    vec3 cloud = lit * exp(-2.2 * thickness) * 0.35 + ambient * max(0.08, 1.0 - 0.6 * thickness);
    // Rain cloud is grey: thick enough that light leaves it after many scatterings, colour washed out.
    cloud = mix(cloud, vec3(dot(cloud, vec3(0.2126, 0.7152, 0.0722))), 0.6 * stormy) * (1.0 - 0.5 * stormy);
    // Air between the eye and the cloud.
    vec3 tr;
    vec3 inscatter = scatter(2.0, d, sun, dist, tr);
    cloud = cloud * tr + inscatter;
    float fade = smoothstep(0.002, 0.05, dir.y);
    cover = density * fade * mix(0.92, 0.995, stormy);
    sky = mix(sky, cloud, cover);
  }
  // Alpha is how much of the sun a cloud lets through, for the disk drawn on the dome.
  color = vec4(warped > 0.5 ? sky * skyScale : sky, 1.0 - cover);
}
`;

/** Shared lookup into the baked sky: direction to texture coordinate, inverse of `directionFromUv`. */
export const SKY_LOOKUP_GLSL = /* glsl */ `
vec2 skyUv(vec3 dir) {
  float phi = atan(dir.x, -dir.z);
  float elev = asin(clamp(dir.y, -1.0, 1.0));
  float s = sign(elev) * sqrt(abs(elev) / 1.5707963);
  return vec2(phi / (2.0 * 3.14159265) + 0.5, s * 0.5 + 0.5);
}
`;

/** Background: the baked sky along each view ray, and the sun's disk where the clouds let it through. */
export const DOME_VERTEX = /* glsl */ `
uniform mat4 inverseProjection;
uniform mat4 cameraWorld;
out vec3 vDir;
void main() {
  vec4 view = inverseProjection * vec4(position.xy, 1.0, 1.0);
  vDir = (cameraWorld * vec4(view.xyz / view.w, 0.0)).xyz;
  gl_Position = vec4(position.xy, 1.0, 1.0);
}
`;

export const DOME_FRAGMENT = /* glsl */ `
${SKY_LOOKUP_GLSL}
uniform sampler2D sky;
uniform float skyScale;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 moonDir;
uniform vec3 moonColor;
uniform float exposure;
/** Horizontal visibility (m), and lightning brightness (0 most of the time). */
uniform float visibility;
uniform float flash;
in vec3 vDir;

float hash3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }

/** A few thousand stars: one candidate per cell of a grid over the sky, most cells empty. */
vec3 stars(vec3 d) {
  vec3 p = d * 260.0;
  vec3 cell = floor(p);
  float h = hash3(cell);
  if (h < 0.985) return vec3(0.0);
  vec3 centre = cell + 0.5 + (vec3(hash3(cell + 3.1), hash3(cell + 5.7), hash3(cell + 9.2)) - 0.5) * 0.7;
  float r = length(p - centre);
  float bright = pow(hash3(cell + 1.3), 6.0) * 6.0 + 0.15;
  float temp = hash3(cell + 7.7);
  vec3 tint = mix(vec3(1.0, 0.82, 0.65), vec3(0.75, 0.85, 1.0), temp);
  return tint * bright * exp(-r * r * 40.0) * 3e-6;
}

void main() {
  vec3 d = normalize(vDir);
  // An explicit level: the texture's u wraps due south, and automatic mip selection there sees a
  // jump of a whole turn between neighbouring pixels and draws a blurred seam down the sky.
  vec4 s = textureLod(sky, skyUv(d), 0.0);
  s.rgb /= skyScale;
  // The sun: 0.27 degrees in radius, darker toward its limb.
  float r = acos(clamp(dot(d, sunDir), -1.0, 1.0)) / 0.0047;
  float limb = r < 1.0 ? 0.4 + 0.6 * sqrt(1.0 - r * r) : 0.0;
  vec3 color = s.rgb + sunColor * limb * 900.0 * s.a;
  // The moon: a sphere lit from the sun's direction, which draws its phase and tilt without a table.
  vec3 toMoon = d - moonDir;
  float rm = length(toMoon) / 0.0045;
  if (rm < 1.0) {
    vec3 right = normalize(cross(moonDir, vec3(0.0, 1.0, 0.0)));
    vec3 up = cross(right, moonDir);
    vec2 q = vec2(dot(toMoon, right), dot(toMoon, up)) / 0.0045;
    vec3 normal = normalize(q.x * right + q.y * up - sqrt(max(0.0, 1.0 - dot(q, q))) * moonDir);
    float lit = max(dot(normal, sunDir), 0.0);
    float maria = 0.82 + 0.18 * hash3(floor(vec3(q * 5.0, 1.0)));
    // Same angular size as the sun and 2.5e-6 of its light at full: the same 900x disk factor applies.
    color += moonColor * (lit * maria + 0.002) * 900.0 * s.a * smoothstep(1.0, 0.97, rm);
  }
  // Stars fade with the air in front of them and behind any cloud.
  color += stars(d) * s.a * smoothstep(0.0, 0.15, d.y);
  // Fog or rain: a line of sight through the bottom kilometre of air, which low sight lines cross for tens
  // of kilometres; it greys out toward the horizon's own colour.
  float path = min(1000.0 / max(d.y, 0.025), 40000.0);
  vec3 horizonColor = textureLod(sky, skyUv(normalize(vec3(d.x, 0.02, d.z))), 3.0).rgb / skyScale;
  color = mix(color, horizonColor, max(0.0, exp(-3.9 * path / 40000.0) - exp(-3.9 * path / visibility)));
  // Lightning lights the cloud from inside.
  color *= 1.0 + flash * 6.0 * (1.0 - s.a);
  gl_FragColor = vec4(color * exposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const EARTH_R = 6360e3;
const ATMOS_R = 6420e3;
const RAYLEIGH = [5.802e-6, 13.558e-6, 33.1e-6];
const MIE_EXT = 4.44e-6;
const OZONE = [0.65e-6, 1.881e-6, 0.085e-6];
export const SUN_ILLUMINANCE = 20;

/**
 * The sun's colour at the sea surface: SUN_ILLUMINANCE through the atmosphere, the same model the bake
 * uses (`sunTransmittance` in ATMOSPHERE_GLSL), for lighting the water's sun glint and the buoy.
 */
export function sunRadiance(sun: [number, number, number]): [number, number, number] {
  const o = [0, EARTH_R + 2, 0];
  const b = o[1] * sun[1];
  const c = o[1] * o[1] - ATMOS_R * ATMOS_R;
  const len = -b + Math.sqrt(b * b - c);
  const steps = 64;
  const dt = len / steps;
  let r = 0;
  let m = 0;
  let oz = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * dt;
    const h = Math.hypot(sun[0] * s, o[1] + sun[1] * s, sun[2] * s) - EARTH_R;
    r += Math.exp(-h / 8e3) * dt;
    m += Math.exp(-h / 1.2e3) * dt;
    oz += Math.max(0, 1 - Math.abs(h - 25e3) / 15e3) * dt;
  }
  return [0, 1, 2].map((i) => SUN_ILLUMINANCE * Math.exp(-(RAYLEIGH[i] * r + MIE_EXT * m + OZONE[i] * oz))) as [number, number, number];
}
