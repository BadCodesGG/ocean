import * as THREE from "three";
import { SKY_LOOKUP_GLSL } from "./sky";
import { decodeTile, resample, TERRAIN_TILES, tilesFor, type GridSpec, type Tile } from "@/lib/terrain";

/**
 * The real coast around the buoy: land from elevation data, coloured by height, slope and climate,
 * dropped by the Earth's curvature like the sea (so low land far off sinks below the horizon and only
 * the mountains stand up), and fogged like everything else. The sea reads the same heights: it is not
 * drawn where the land stands above it, it turns pale over the shallows, and the swell breaks on them.
 */

/** A 20 km square in detail around the buoy, and 120 km coarsely for distant mountains. */
export const NEAR: GridSpec = { size: 512, extent: 20_000, zoom: 12 };
export const FAR: GridSpec = { size: 384, extent: 120_000, zoom: 9 };

export interface CoastData {
  near: Float32Array;
  far: Float32Array;
}

async function fetchTile(zoom: number, x: number, y: number, signal: AbortSignal): Promise<Tile | undefined> {
  try {
    const res = await fetch(`${TERRAIN_TILES}/${zoom}/${x}/${y}.png`, { signal });
    if (!res.ok) return undefined;
    // Heights are packed in the colour bytes: read them exactly, with no colour management or premultiplying.
    const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: "none", colorSpaceConversion: "none" });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return undefined;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return decodeTile(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  } catch {
    return undefined;
  }
}

async function grid(lat: number, lon: number, spec: GridSpec, signal: AbortSignal): Promise<Float32Array> {
  const tiles = new Map<string, Tile | undefined>();
  await Promise.all(
    tilesFor(lat, lon, spec).map(async ({ x, y }) => {
      tiles.set(`${x}/${y}`, await fetchTile(spec.zoom, x, y, signal));
    }),
  );
  return resample(lat, lon, spec, (x, y) => tiles.get(`${x}/${y}`));
}

/** The heights around a buoy, or null when there is no land in sight (or the tiles are unreachable). */
export async function loadCoast(lat: number, lon: number, signal: AbortSignal): Promise<CoastData | null> {
  const [near, far] = await Promise.all([grid(lat, lon, NEAR, signal), grid(lat, lon, FAR, signal)]);
  let highest = -Infinity;
  for (const h of far) highest = Math.max(highest, h);
  return highest > 1 ? { near, far } : null;
}

/** Height of the land (or sea floor) at a world point, for the sea's shader. coastSpan: near and far widths, and 1 when loaded. */
export const COAST_GLSL = /* glsl */ `
uniform sampler2D coastNear;
uniform sampler2D coastFar;
uniform vec3 coastSpan;
float landHeight(vec2 p) {
  if (coastSpan.z == 0.0) return -1000.0;
  vec2 un = p / coastSpan.x + 0.5;
  if (max(abs(un.x - 0.5), abs(un.y - 0.5)) < 0.498) return texture(coastNear, un).r;
  vec2 uf = p / coastSpan.y + 0.5;
  if (max(abs(uf.x - 0.5), abs(uf.y - 0.5)) < 0.5) return texture(coastFar, uf).r;
  return -1000.0;
}
`;

function heightTexture(heights: Float32Array, size: number): THREE.DataTexture {
  const half = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) half[i] = THREE.DataUtils.toHalfFloat(heights[i]);
  const t = new THREE.DataTexture(half, size, size, THREE.RedFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.needsUpdate = true;
  return t;
}

type Climate = "tropical" | "dry" | "conifer" | "temperate";

/** Which kind of land a station looks at, from where it is. */
export function climateAt(lat: number, lon: number): Climate {
  if (lon < -150) return "tropical";
  if (lon < -114) return lat < 40 ? "dry" : "conifer";
  return "temperate";
}

/** Low growth, forest, bare rock and earth, and sand, in sRGB. */
const PALETTES: Record<Climate, { low: string; forest: string; rock: string; sand: string }> = {
  tropical: { low: "#5f7b3a", forest: "#2c4722", rock: "#6f5644", sand: "#d8c8a0" },
  dry: { low: "#9a8a5c", forest: "#565c3a", rock: "#857562", sand: "#d4c7a4" },
  conifer: { low: "#58683f", forest: "#26372a", rock: "#6a655d", sand: "#bdb096" },
  temperate: { low: "#6c7b45", forest: "#3b522f", rock: "#78715f", sand: "#d3c6a1" },
};

function hash(x: number, y: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Smooth value noise, for patches of forest and scrub. */
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * u;
  const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * u;
  return a + (b - a) * v;
}

/**
 * Aerial perspective: the air between the eye and the land scatters in the light of the sky behind it,
 * so distant land fades into exactly the sky it stands against (clouds and all), never into a flat
 * fog colour that would leave its silhouette standing. The haze is densest near the sea and thins
 * with height (a scale height of 1.2 km), so mountain tops stay clear above a hazy coast; the sky
 * behind is itself fogged toward the horizon as the dome draws it.
 */
const HAZE_GLSL = /* glsl */ `
${SKY_LOOKUP_GLSL}
uniform sampler2D sky;
uniform float skyScale;
uniform float visibility;
uniform float flash;
vec3 hazed(vec3 color, vec3 world, float height, float extra) {
  vec3 ray = world - cameraPosition;
  float dist = length(ray);
  vec3 d = ray / dist;
  // Mean air density along a slant path from sea level to this height, relative to sea level's.
  float thin = (1200.0 / height) * (1.0 - exp(-height / 1200.0));
  // Weather models stop reporting visibility at about 24 km; that means clear air, which on the
  // islands shows mountains 50 km off. Below it, extinction is 3.9 over the visibility.
  float reach = mix(visibility / 3.9, 30000.0, smoothstep(12000.0, 24000.0, visibility));
  float haze = max(extra, 1.0 - exp(-dist * thin / reach));
  vec3 behind = textureLod(sky, skyUv(d), 0.0).rgb / skyScale;
  float path = min(1000.0 / max(d.y, 0.025), 40000.0);
  vec3 low = horizonAt(sky, d) / skyScale;
  behind = mix(behind, low, max(0.0, exp(-3.9 * path / 40000.0) - exp(-3.9 * path / visibility)));
  return mix(color, behind * (1.0 + flash * 6.0), haze);
}
`;

/** Uniforms every land mesh shares with the scene: the sky bake, and the weather. */
export interface CoastLook {
  sky: THREE.IUniform<THREE.Texture | null>;
  skyScale: THREE.IUniform<number>;
  visibility: THREE.IUniform<number>;
  flash: THREE.IUniform<number>;
}

/** A land mesh with a vertex per grid cell; `hole` (m) leaves the middle to a finer mesh. */
function landMesh(heights: Float32Array, spec: GridSpec, climate: Climate, hole: number, look: CoastLook): THREE.Mesh {
  const n = spec.size;
  const cell = spec.extent / n;
  const count = n;
  const positions = new Float32Array(count * count * 3);
  const normals = new Float32Array(count * count * 3);
  const colors = new Float32Array(count * count * 3);
  const elevation = new Float32Array(count * count);
  const p = PALETTES[climate];
  const low = new THREE.Color(p.low);
  const forest = new THREE.Color(p.forest);
  const rock = new THREE.Color(p.rock);
  const sand = new THREE.Color(p.sand);
  const c = new THREE.Color();
  const at = (col: number, row: number) => heights[Math.min(n - 1, Math.max(0, row)) * n + Math.min(n - 1, Math.max(0, col))];
  let v = 0;
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const col = i;
      const row = j;
      const h = at(col, row);
      const x = -spec.extent / 2 + (col + 0.5) * cell;
      const z = -spec.extent / 2 + (row + 0.5) * cell;
      // The sea floor is never seen; pull it well under the water so the shoreline is the sea's to draw.
      const y = h > 0 ? h : h - 4;
      positions.set([x, y, z], v * 3);
      elevation[v] = h;
      const dx = (Math.max(0, at(col + 1, row)) - Math.max(0, at(col - 1, row))) / (2 * cell);
      const dz = (Math.max(0, at(col, row + 1)) - Math.max(0, at(col, row - 1))) / (2 * cell);
      const len = Math.hypot(dx, 1, dz);
      normals.set([-dx / len, 1 / len, -dz / len], v * 3);
      const slope = Math.hypot(dx, dz);
      // Forest on the slopes and in patches; bare rock where it is too steep to hold soil; sand at the water.
      const patch = noise(x / 900, z / 900) * 0.6 + noise(x / 250, z / 250) * 0.4;
      // Valleys hold shade and trees; ridges catch the light and stay open.
      const around = (Math.max(0, at(col + 2, row)) + Math.max(0, at(col - 2, row)) + Math.max(0, at(col, row + 2)) + Math.max(0, at(col, row - 2))) / 4;
      const hollow = THREE.MathUtils.clamp((around - Math.max(0, h)) / (cell * 0.6), -1, 1);
      const wooded = THREE.MathUtils.smoothstep(patch + Math.min(h, 600) / 1500 + 0.35 * hollow, 0.45, 0.75);
      c.copy(low).lerp(forest, wooded);
      c.lerp(rock, THREE.MathUtils.smoothstep(slope, 0.7, 1.4));
      c.lerp(sand, (1 - THREE.MathUtils.smoothstep(h, 2, 6)) * (1 - THREE.MathUtils.smoothstep(slope, 0.08, 0.2)));
      // A little brightness variation so the land does not read as flat paint.
      c.multiplyScalar((0.85 + 0.3 * noise(x / 120, z / 120)) * (1 - 0.35 * Math.max(0, hollow)) * (1 + 0.15 * Math.max(0, -hollow)));
      colors.set([c.r, c.g, c.b], v * 3);
      v++;
    }
  }
  const index: number[] = [];
  for (let j = 0; j < count - 1; j++) {
    for (let i = 0; i < count - 1; i++) {
      const a = j * count + i;
      const b = a + 1;
      const d = a + count;
      const e = d + 1;
      // Skip quads entirely under water: most of the far grid is open sea.
      if (Math.max(elevation[a], elevation[b], elevation[d], elevation[e]) <= 0) continue;
      index.push(a, d, b, b, d, e);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute("elevation", new THREE.BufferAttribute(elevation, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  // Vertex colours are sRGB; three wants them linear.
  const col = geometry.getAttribute("color") as THREE.BufferAttribute;
  for (let i = 0; i < col.count; i++) {
    c.setRGB(col.getX(i), col.getY(i), col.getZ(i), THREE.SRGBColorSpace);
    col.setXYZ(i, c.r, c.g, c.b);
  }

  // Its own haze rather than the scene's fog: see HAZE_GLSL.
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, fog: false });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, look, { hole: { value: hole }, edge: { value: spec.extent / 2 } });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float elevation;\nvarying float vElevation;\nvarying vec3 vLand;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vElevation = elevation;
        // The Earth's curvature, as the sea has it: land far off drops below the horizon.
        vec2 fromEye = transformed.xz - cameraPosition.xz;
        transformed.y -= dot(fromEye, fromEye) / (2.0 * 6371e3);
        vLand = transformed;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform float hole;
        uniform float edge;
        varying float vElevation;
        varying vec3 vLand;
        ${HAZE_GLSL}
        float landHash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
        float landNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(landHash(i), landHash(i + vec2(1.0, 0.0)), f.x), mix(landHash(i + vec2(0.0, 1.0)), landHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }`,
      )
      .replace(
        "void main() {",
        `void main() {
        if (vElevation < 0.0) discard;
        if (max(abs(vLand.x), abs(vLand.z)) < hole) discard;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        // Tree crowns and clearings, finer than the elevation data: dark clumps with light between,
        // fading out with distance before they can shimmer.
        float fade = 1.0 - smoothstep(1500.0, 6000.0, length(vLand.xz - cameraPosition.xz));
        float crowns = landNoise(vLand.xz / 9.0) * 0.6 + landNoise(vLand.xz / 31.0) * 0.4;
        diffuseColor.rgb *= mix(1.0, 0.7 + 0.6 * crowns, fade * smoothstep(3.0, 8.0, vElevation));`,
      )
      .replace(
        "#include <fog_fragment>",
        `gl_FragColor.rgb *= 1.0 + flash * 2.0;
        // The grid's own edge fades out entirely, so the land never ends in a straight line.
        float rim = smoothstep(0.8, 1.0, max(abs(vLand.x), abs(vLand.z)) / edge);
        gl_FragColor.rgb = hazed(gl_FragColor.rgb, vLand, max(vElevation, 1.0), rim);`,
      );
  };
  const mesh = new THREE.Mesh(geometry, material);
  // Its bounds are static and it spans the whole view; culling it saves nothing.
  mesh.frustumCulled = false;
  return mesh;
}

export class Coast {
  readonly group = new THREE.Group();
  readonly nearTexture: THREE.DataTexture;
  readonly farTexture: THREE.DataTexture;
  readonly look: CoastLook;

  constructor(data: CoastData, lat: number, lon: number, sky: THREE.Texture) {
    this.look = { sky: { value: sky }, skyScale: { value: 1 }, visibility: { value: 24_000 }, flash: { value: 0 } };
    const climate = climateAt(lat, lon);
    this.nearTexture = heightTexture(data.near, NEAR.size);
    this.farTexture = heightTexture(data.far, FAR.size);
    this.group.add(landMesh(data.near, NEAR, climate, 0, this.look));
    // The far mesh leaves the near one's square to it, less a cell so the two overlap.
    this.group.add(landMesh(data.far, FAR, climate, NEAR.extent / 2 - NEAR.extent / NEAR.size, this.look));
  }

  dispose() {
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this.nearTexture.dispose();
    this.farTexture.dispose();
  }
}
