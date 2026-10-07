import * as THREE from "three";
import { CASCADES, SWELL_TEXEL, SWELL_TEXELS, type Ocean } from "./ocean";
import { HULL_GLSL } from "./boat-model";
import { FOAM_TEXEL, FOAM_TEXELS, KELVIN_GLSL, type Wake } from "./wake";
import { COAST_GLSL } from "./coast";
import { RIPPLES_GLSL } from "./weather-fx";
import { SKY_LOOKUP_GLSL } from "./sky";
import type { Sea } from "@/lib/stations";

/**
 * The colour of the water itself, linear RGB: what light scattering back out of the sea brings with
 * it. Plankton absorbs blue and scatters green, so the richer the water the greener it looks.
 *   deep: the body seen in the shade; scatter: sunlight through the thin crests; above: sunlight
 *   scattered back up to a view from above; shallow: light off the sand under a few metres of it.
 * clear is the sea the scene was built on (Waimea Bay) and its values are unchanged.
 */
export const SEA: Record<Sea, { deep: THREE.Vector3; scatter: THREE.Vector3; above: THREE.Vector3; shallow: THREE.Vector3 }> = {
  clear: {
    deep: new THREE.Vector3(0.0015, 0.006, 0.016),
    scatter: new THREE.Vector3(0.008, 0.05, 0.06),
    above: new THREE.Vector3(0.006, 0.026, 0.07),
    shallow: new THREE.Vector3(0.02, 0.13, 0.12),
  },
  coastal: {
    deep: new THREE.Vector3(0.0018, 0.0075, 0.012),
    scatter: new THREE.Vector3(0.009, 0.056, 0.05),
    above: new THREE.Vector3(0.006, 0.03, 0.048),
    shallow: new THREE.Vector3(0.03, 0.13, 0.1),
  },
  green: {
    deep: new THREE.Vector3(0.0026, 0.0095, 0.0065),
    scatter: new THREE.Vector3(0.013, 0.062, 0.03),
    above: new THREE.Vector3(0.01, 0.036, 0.022),
    shallow: new THREE.Vector3(0.035, 0.115, 0.085),
  },
};

/**
 * The sea surface: a polar grid centred under the camera (cells stay roughly square on screen from a
 * metre away to the horizon), displaced by every ocean layer, dropped by the Earth's curvature, and
 * shaded with sky reflection, sun glint, light through the backs of the crests, and haze.
 */

const INNER = 0.6;
const OUTER = 40_000;

/** The sea's mesh: rings around the eye, `segments` cells round, each ring a cell's width out from the last. */
export function polarGrid(segments: number): THREE.BufferGeometry {
  const SEGMENTS = segments;
  const step = (2 * Math.PI) / SEGMENTS;
  const rings: number[] = [];
  for (let r = INNER; r < OUTER; r *= 1 + step) rings.push(r);
  rings.push(OUTER);
  const positions = new Float32Array((rings.length * SEGMENTS + 1) * 3);
  // Vertex 0 is the centre; its w-ish "spacing" goes in y (unused by the shader for position).
  positions.set([0, INNER, 0], 0);
  let v = 3;
  for (const r of rings) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = s * step;
      positions.set([Math.cos(a) * r, r * step, Math.sin(a) * r], v);
      v += 3;
    }
  }
  const index: number[] = [];
  for (let s = 0; s < SEGMENTS; s++) index.push(0, 1 + ((s + 1) % SEGMENTS), 1 + s);
  for (let i = 0; i < rings.length - 1; i++) {
    for (let s = 0; s < SEGMENTS; s++) {
      const a = 1 + i * SEGMENTS + s;
      const b = 1 + i * SEGMENTS + ((s + 1) % SEGMENTS);
      const c = a + SEGMENTS;
      const d = b + SEGMENTS;
      index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), OUTER * 2);
  return g;
}

const COMMON = /* glsl */ `
uniform sampler2D c0a; uniform sampler2D c0b;
uniform sampler2D c1a; uniform sampler2D c1b;
uniform sampler2D c2a; uniform sampler2D c2b;
uniform sampler2D c3a; uniform sampler2D c3b;
uniform sampler2D swellA; uniform sampler2D swellB;
uniform vec4 cascadeLength;
uniform vec2 swellOrigin;
uniform vec3 eye;
${KELVIN_GLSL}
/** The boat's foam, on a grid whose texel (0, 0) centre is at foamOrigin; foamOn is 0 without a boat. */
uniform sampler2D foamField;
uniform vec2 foamOrigin;
uniform float foamOn;
vec2 foamUv(vec2 p) { return ((p - foamOrigin) / ${FOAM_TEXEL.toFixed(2)} + 0.5) / ${FOAM_TEXELS.toFixed(1)}; }

const float SWELL_TEXEL = ${SWELL_TEXEL.toFixed(1)};
const float SWELL_SIZE = ${SWELL_TEXELS.toFixed(1)};

vec2 swellUv(vec2 p) { return ((p - swellOrigin) / SWELL_TEXEL + 0.5) / SWELL_SIZE; }

/** 1 inside the swell window, fading to 0 over its outer quarter: past it, cascade 0 carries the swell band. */
float swellWeight(vec2 p) {
  vec2 d = abs(swellUv(p) - 0.5) * 2.0;
  return 1.0 - smoothstep(0.55, 0.95, max(d.x, d.y));
}
`;

const VERTEX = /* glsl */ `
${COMMON}
out vec2 vRest;
out vec3 vWorld;

void main() {
  vec2 rest = eye.xz + position.xz;
  float spacing = position.y;
  float w = swellWeight(rest);
  // Sample each layer at the mip whose texel matches the grid spacing here, so distant vertices do not alias.
  float l0 = max(0.0, log2(spacing / (cascadeLength.x / 256.0)));
  float l1 = max(0.0, log2(spacing / (cascadeLength.y / 256.0)));
  float l2 = max(0.0, log2(spacing / (cascadeLength.z / 256.0)));
  float ls = max(0.0, log2(spacing / SWELL_TEXEL));
  vec3 d = textureLod(swellA, swellUv(rest), ls).xyz * w
    + textureLod(c0a, rest / cascadeLength.x, l0).xyz * (1.0 - w)
    + textureLod(c1a, rest / cascadeLength.y, l1).xyz
    + textureLod(c2a, rest / cascadeLength.z, l2).xyz;
  vec3 world = vec3(rest.x, 0.0, rest.y) + d;
  world.y += kelvin(world.xz).x;
  // The Earth's curvature: the sea drops d²/2R below the tangent plane, which is what makes a horizon.
  vec2 fromEye = world.xz - eye.xz;
  world.y -= dot(fromEye, fromEye) / (2.0 * 6371e3);
  vRest = rest;
  vWorld = world;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

export const FRAGMENT = /* glsl */ `
${COMMON}
${SKY_LOOKUP_GLSL}
uniform sampler2D sky;
/** The sky is baked pre-multiplied by this, to keep night skies out of half-float's subnormal range. */
uniform float skyScale;
vec3 skyAt(vec3 dir, float lod) { return textureLod(sky, skyUv(dir), lod).rgb / skyScale; }
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 moonDir;
uniform vec3 moonColor;
/** The buoy's light: world position, and its radiant intensity while flashing (zero between). */
uniform vec3 flashPos;
uniform vec3 flashColor;
uniform float exposure;
uniform float windSpeed;
/** Rain on the sea, 0 to 1; horizontal visibility, m; lightning brightness; seconds, for the rain rings. */
uniform float rain;
uniform float visibility;
uniform float flash;
uniform float time;
/** Significant wave height, m: how big the surf is where the swell breaks on the shallows. */
uniform float seaHeight;
uniform vec3 seaDeep;
uniform vec3 seaScatter;
uniform vec3 seaAbove;
uniform vec3 seaShallow;
${RIPPLES_GLSL}
${COAST_GLSL}
/** The boat, if any: world to boat matrix, and its length, beam and depth scale (zero length: no boat). */
uniform mat4 hullInverse;
uniform vec3 hullLines;
${HULL_GLSL}
in vec2 vRest;
in vec3 vWorld;

// Slopes and Jacobian terms: (dη/dx, dη/dz, dDx/dx, dDz/dz), plus dDx/dz in the last slot of b.
void layer(sampler2D a, sampler2D b, vec2 uv, float weight, inout vec4 s, inout float jxz) {
  vec4 ta = texture(a, uv);
  vec4 tb = texture(b, uv);
  s += vec4(ta.w, tb.x, tb.y, tb.z) * weight;
  jxz += tb.w * weight;
}

/** Value noise and a few octaves of it, for breaking foam into lace. */
float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.7 + 7.1) + 0.2 * vnoise(p * 7.3 + 3.9); }

/** GGX specular reflection of a light of the given irradiance from direction l. */
vec3 specular(vec3 n, vec3 v, float nv, float alpha, vec3 l, vec3 irradiance) {
  vec3 h = normalize(l + v);
  float nl = max(dot(n, l), 0.0);
  float nh = max(dot(n, h), 0.0);
  float a2 = alpha * alpha;
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float ggx = a2 / (3.14159265 * dd * dd);
  float fh = 0.02 + 0.98 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return irradiance * ggx * fh * nl / max(4.0 * nv * max(nl, 0.05), 0.02);
}

void main() {
  // No sea inside the hull: from on deck or above, the cockpit would otherwise fill with water.
  if (hullLines.x > 0.0) {
    vec3 local = (hullInverse * vec4(vWorld, 1.0)).xyz;
    float s = (hullLines.x * 0.5 - local.z) / hullLines.x;
    if (s > 0.0 && s < 1.0 && abs(local.x) < hullHalfBeamAt(s, local.y / hullLines.z, hullLines.y) - 0.03) discard;
  }
  // No sea where the land stands above it; the depth of water everywhere else, for the shallows and surf.
  float level = vWorld.y + dot(vWorld.xz - eye.xz, vWorld.xz - eye.xz) / (2.0 * 6371e3);
  float depth = level - landHeight(vWorld.xz);
  if (depth < 0.0) discard;
  float w = swellWeight(vRest);
  vec4 s = vec4(0.0);
  float jxz = 0.0;
  layer(swellA, swellB, swellUv(vRest), w, s, jxz);
  layer(c0a, c0b, vRest / cascadeLength.x, 1.0 - w, s, jxz);
  // Each finer layer fades once its waves shrink below a pixel (the cascades are periodic, so a
  // too-fine layer aliases into dotted lines toward the horizon); the roughness below takes over.
  float eyeDist = distance(vRest, eye.xz);
  float w1 = 1.0 - smoothstep(1500.0, 9000.0, eyeDist);
  float w2 = 1.0 - smoothstep(60.0, 450.0, eyeDist);
  float w3 = 1.0 - smoothstep(12.0, 90.0, eyeDist);
  layer(c1a, c1b, vRest / cascadeLength.y, w1, s, jxz);
  layer(c2a, c2b, vRest / cascadeLength.z, w2, s, jxz);
  // The finest layer only tilts the surface; its centimetres of height are left out of the geometry.
  layer(c3a, c3b, vRest / cascadeLength.w, w3, s, jxz);
  vec2 slope = vec2(s.x / (1.0 + s.z), s.y / (1.0 + s.w));
  if (rain > 0.0) slope += rainRipples(vRest, time, rain) * (1.0 - smoothstep(15.0, 60.0, distance(vRest, eye.xz)));
  vec3 wakeWave = kelvin(vWorld.xz);
  slope += wakeWave.yz;
  float wakeFoam = 0.0;
  if (foamOn > 0.0) {
    vec2 uv = foamUv(vWorld.xz);
    if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) wakeFoam = texture(foamField, uv).x;
  }
  // Wake crests steep enough to spill.
  wakeFoam = max(wakeFoam, 0.6 * smoothstep(0.28, 0.5, length(wakeWave.yz)));
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));
  float jacobian = (1.0 + s.z) * (1.0 + s.w) - jxz * jxz;

  vec3 toEye = eye - vWorld;
  float dist = length(toEye);
  vec3 v = toEye / dist;
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(2000.0, 20000.0, dist) * 0.6));
  float nv = max(dot(n, v), 0.001);

  // Roughness from the slopes the grid does not resolve. Cox and Munk measured the sea's mean-square
  // slope as 0.003 + 0.00512 U for wind U (m/s). Close up the cascades draw most of it; with
  // distance a pixel covers more and more of the ripples, until all of it is microfacet roughness.
  // Rain pocks the surface too, spreading the glint.
  float mss = 0.003 + 0.00512 * windSpeed + 0.01 * rain;
  float unresolved = mix(0.08, 1.0, smoothstep(12.0, 3000.0, dist));
  float alpha = sqrt(2.0 * mss * unresolved);

  vec3 r = reflect(-v, n);
  // Facets steep enough to reflect below the horizon see the next wave, which at that grazing angle is
  // itself mostly a mirror of the low sky: dimmer than the sky, never black.
  float below = smoothstep(0.02, -0.06, r.y);
  r.y = abs(r.y);
  float skyLod = clamp(log2(alpha * 2048.0 / 6.2831853 + 1.0), 0.0, 9.0);
  vec3 reflected = skyAt(r, skyLod);
  float fresnel = 0.02 + 0.98 * pow(1.0 - nv, 5.0);

  float nl = max(dot(n, sunDir), 0.0);
  vec3 glint = specular(n, v, nv, alpha, sunDir, sunColor) + specular(n, v, nv, alpha, moonDir, moonColor);
  // The flashing light, a point source: its streak on the water is most of what a moonless night shows.
  vec3 toFlash = flashPos - vWorld;
  float flashDist2 = dot(toFlash, toFlash);
  glint += specular(n, v, nv, max(alpha, 0.12), toFlash * inversesqrt(flashDist2), flashColor / flashDist2);

  // Light that enters the sea and scatters back out: a deep navy body, plus the sun shining through
  // the thin tops of waves between the eye and the sun (after Atlas, GDC 2019).
  vec3 ambient = skyAt(vec3(0.0, 1.0, 0.0), 6.0);
  vec3 deep = seaDeep;
  vec3 scatterColor = seaScatter;
  float height = max(0.0, vWorld.y + dot(vWorld.xz - eye.xz, vWorld.xz - eye.xz) / (2.0 * 6371e3));
  float through = pow(max(dot(v, -sunDir), 0.0), 4.0) * pow(0.5 - 0.5 * dot(sunDir, n), 3.0) * (0.2 + height * 1.5);
  vec3 body = deep * ambient + scatterColor * sunColor * (through * 2.0 + 0.02 * nl) + scatterColor * ambient * pow(nv, 2.0) * 0.1;
  // Sunlight scattered back up out of clear deep water: small beside the sky's reflection at grazing
  // angles, but most of what a drone sees looking down, and what makes open ocean blue from above.
  body += seaAbove * sunColor * max(sunDir.y, 0.0) * 0.06;
  vec3 lowSky = skyAt(normalize(vec3(r.x, 0.03, r.z)), skyLod + 1.0);
  reflected = mix(reflected, lowSky * 0.55 + body, below);

  // Churned water full of bubbles scatters light back up: the pale turquoise of a prop wash.
  float aerated = smoothstep(0.03, 0.5, wakeFoam);
  body = mix(body, vec3(0.03, 0.16, 0.17) * (ambient + sunColor * nl * 0.25), aerated * 0.8);
  // Over the shallows sunlight reaches the sand and reef and comes back up: pale turquoise water.
  float shallow = 1.0 - smoothstep(1.5, 18.0, depth);
  body = mix(body, seaShallow * (ambient + sunColor * max(sunDir.y, 0.0) * 0.35), shallow * 0.85);
  vec3 color = mix(body, reflected, fresnel) + glint;

  // Whitecaps where the surface folds; a light touch, this sea is mostly swell.
  // Whitecaps where the surface folds; a strong wind breaks crests that a light one leaves whole.
  float cap = mix(0.35, 0.8, smoothstep(8.0, 20.0, windSpeed));
  float foam = smoothstep(cap, cap - 0.3, jacobian);
  // Wake foam as lace: dense where it is fresh, breaking into patches and threads as it thins.
  float laceNoise = fbm(vWorld.xz * 0.9);
  float lace = smoothstep(laceNoise * 0.85, laceNoise * 0.85 + 0.18, wakeFoam * (1.0 + 1.5 * (s.z + s.w)));
  foam = max(foam, lace * 0.92);
  // The surf: swell breaks once the water is not much deeper than the waves are high, in lines rolling
  // toward the beach, and the broken water runs white up to the sand.
  float surfZone = 1.0 - smoothstep(0.8 * seaHeight + 0.4, 1.4 * seaHeight + 1.5, depth);
  float surfNoise = fbm(vWorld.xz * 0.05);
  float lines = smoothstep(0.35, 0.9, sin(depth * 1.7 + time * 0.9 + surfNoise * 4.0) * 0.5 + 0.5);
  float broken = 1.0 - smoothstep(0.3, 1.2 + 0.3 * seaHeight, depth);
  float surf = surfZone * max(lines * smoothstep(0.25, 0.6, fbm(vWorld.xz * 0.12 + time * 0.05)), broken);
  foam = max(foam, surf * 0.9);
  color = mix(color, (ambient * 0.7 + sunColor * nl * 0.5 + moonColor * max(dot(n, moonDir), 0.0) * 0.5) * 0.9, foam * 0.8);

  // Haze: the air between the eye and the water, toward the horizon's own colour. On a clear day it
  // takes about 9 km to grey out by two thirds; fog and rain bring it close. The colour comes from a
  // blurred level, as the dome and the coast take theirs: the sky's top level carries the march's
  // per-pixel jitter, which one row of it, stretched down a fogged sea, draws as vertical streaks.
  float haze = 1.0 - exp(-dist / min(9000.0, visibility / 3.9));
  vec3 horizon = skyAt(normalize(vec3(-v.x, 0.01, -v.z)), 3.0);
  color = mix(color, horizon, haze);

  color *= 1.0 + flash * 3.0;
  gl_FragColor = vec4(color * exposure, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/** Stands in for the coast's height textures until they load (or where there is no land). */
const NO_COAST = new THREE.DataTexture(new Uint16Array([THREE.DataUtils.toHalfFloat(-1000)]), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
NO_COAST.needsUpdate = true;

export function createWater(ocean: Ocean, sky: THREE.Texture, wake: Wake, segments: number, sea: Sea) {
  // (sky is the Lighting's warped target texture; it is re-baked in place, so the reference holds.)
  const [c0, c1, c2, c3] = ocean.cascades.map((c) => c.field.textures);
  const material = new THREE.ShaderMaterial({
    // No glslVersion: three then compiles GLSL ES 3.00 with gl_FragColor mapped, which its tone-mapping chunks need.
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      c0a: { value: c0[0] }, c0b: { value: c0[1] },
      c1a: { value: c1[0] }, c1b: { value: c1[1] },
      c2a: { value: c2[0] }, c2b: { value: c2[1] },
      c3a: { value: c3[0] }, c3b: { value: c3[1] },
      swellA: { value: ocean.swell.textures[0] }, swellB: { value: ocean.swell.textures[1] },
      cascadeLength: { value: new THREE.Vector4(...CASCADES.map((c) => c.length)) },
      swellOrigin: { value: ocean.swellOrigin },
      eye: { value: new THREE.Vector3() },
      sky: { value: sky },
      skyScale: { value: 1 },
      sunDir: { value: new THREE.Vector3() },
      sunColor: { value: new THREE.Color() },
      moonDir: { value: new THREE.Vector3() },
      moonColor: { value: new THREE.Color() },
      flashPos: { value: new THREE.Vector3() },
      flashColor: { value: new THREE.Color() },
      exposure: { value: 1 },
      windSpeed: { value: 7 },
      rain: { value: 0 },
      visibility: { value: 24_000 },
      flash: { value: 0 },
      time: { value: 0 },
      seaHeight: { value: 1 },
      // Copies: the palette is shared, and a uniform's value is the scene's to change.
      seaDeep: { value: SEA[sea].deep.clone() },
      seaScatter: { value: SEA[sea].scatter.clone() },
      seaAbove: { value: SEA[sea].above.clone() },
      seaShallow: { value: SEA[sea].shallow.clone() },
      coastNear: { value: NO_COAST },
      coastFar: { value: NO_COAST },
      coastSpan: { value: new THREE.Vector3() },
      hullInverse: { value: new THREE.Matrix4() },
      trail: { value: wake.trail.texture },
      trailBounds: { value: wake.trail.bounds },
      foamField: { value: wake.foam },
      foamOrigin: { value: wake.origin },
      foamOn: { value: 0 },
      hullLines: { value: new THREE.Vector3() },
    },
  });
  const mesh = new THREE.Mesh(polarGrid(segments), material);
  mesh.frustumCulled = false;
  return mesh;
}
