import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

/**
 * Small boats built from their lines: a lofted deep-V planing hull (hard chine, raked and flared bow,
 * flat transom) with a self-bailing deck, fitted out as a 25 ft centre console (console, T-top, twin
 * outboards) or a 17 ft open skiff (thwarts and a tiller outboard).
 *
 * Boat axes: x to starboard, y up, z aft; the design waterline is y = 0, the transom at z = +L/2 and the
 * stem at z = -L/2. Heights are drawn for the centre console and scaled by `depth` for other hulls. The
 * water shader clips the sea inside the hull with the same shape, mirrored in HULL_GLSL below.
 */

export interface HullLines {
  length: number;
  beam: number;
  /** Vertical scale on the drawn heights (freeboard, draft, deck). */
  depth: number;
}

export const CENTER_CONSOLE: HullLines = { length: 7.6, beam: 2.6, depth: 1 };
export const SKIFF: HullLines = { length: 5.2, beam: 2.0, depth: 0.7 };

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Half-beam at the sheer, s from 0 (transom) to 1 (stem). */
export function sheerHalfBeam(lines: HullLines, s: number): number {
  const half = lines.beam / 2;
  if (s <= 0.5) return half * (0.9 + 0.1 * Math.sin(Math.PI * s));
  const t = (s - 0.5) / 0.5;
  return half * Math.pow(Math.max(0, 1 - Math.pow(t, 2.3)), 0.62);
}

/** Height of the sheer (the top edge of the hull) above the waterline: low aft, sweeping up to the bow. */
export function sheerHeight(s: number): number {
  return 0.74 + 0.18 * s + 0.42 * s * s * s;
}

/** How far the bow sections lean forward per metre above the waterline: a raked, flared stem. */
export function rake(s: number): number {
  const t = smooth(0.55, 1, s);
  return 0.62 * t * t;
}

/** Height of the keel: a constant draft aft, sweeping up through the forefoot to the stem. */
export function keelHeight(s: number): number {
  return -0.42 + 0.56 * Math.pow(smooth(0.5, 1, s), 1.5);
}

/** Bottom deadrise angle: 21 degrees at the transom, sharpening to a fine entry forward. */
function deadrise(s: number): number {
  return THREE.MathUtils.degToRad(21 + 32 * smooth(0.35, 1, s));
}

/** Chine half-beam: most of the sheer's aft, pulling in forward so the bow flares out over it. */
function chineHalfBeam(lines: HullLines, s: number): number {
  return sheerHalfBeam(lines, s) * (0.84 - 0.18 * smooth(0.5, 1, s));
}

/**
 * Outside half-beam of the hull at height y (boat axes) at station s: zero below the keel, along the
 * V bottom to the chine, then up the flaring topsides. The sea is clipped inside this.
 */
export function halfBeamAt(lines: HullLines, s: number, yScaled: number): number {
  const y = yScaled / lines.depth;
  const k = keelHeight(s);
  const w = sheerHalfBeam(lines, s);
  const h = sheerHeight(s);
  const c = chineHalfBeam(lines, s);
  const ch = Math.min(k + c * Math.tan(deadrise(s)), h - 0.05);
  if (y <= k || y > h) return 0;
  if (y < ch) return (c * (y - k)) / Math.max(1e-4, ch - k);
  const u = (y - ch) / Math.max(1e-4, h - ch);
  return c + (w - c) * u + Math.sin(Math.PI * u) * 0.035;
}

/** Cockpit sole height; the bow deck steps up. */
export function deckHeight(s: number): number {
  return 0.3 + 0.2 * smooth(0.62, 0.7, s) + 0.18 * smooth(0.7, 1, s);
}

/** halfBeamAt in GLSL, for clipping the sea inside the hull. Change the two together. */
export const HULL_GLSL = /* glsl */ `
float hullSmooth(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float hullSheerHalfBeam(float s, float beam) {
  float half_ = beam * 0.5;
  if (s <= 0.5) return half_ * (0.9 + 0.1 * sin(3.14159265 * s));
  float t = (s - 0.5) / 0.5;
  return half_ * pow(max(0.0, 1.0 - pow(t, 2.3)), 0.62);
}
float hullHalfBeamAt(float s, float y, float beam) {
  float k = -0.42 + 0.56 * pow(hullSmooth(0.5, 1.0, s), 1.5);
  float w = hullSheerHalfBeam(s, beam);
  float h = 0.74 + 0.18 * s + 0.42 * s * s * s;
  float c = w * (0.84 - 0.18 * hullSmooth(0.5, 1.0, s));
  float ch = min(k + c * tan(radians(21.0 + 32.0 * hullSmooth(0.35, 1.0, s))), h - 0.05);
  if (y <= k || y > h) return 0.0;
  if (y < ch) return c * (y - k) / max(1e-4, ch - k);
  float u = (y - ch) / max(1e-4, h - ch);
  return c + (w - c) * u + sin(3.14159265 * u) * 0.035;
}
`;

const STATIONS = 72;

/** Station positions, packed toward the bow where the shape changes fastest. */
function stations(): number[] {
  const out: number[] = [];
  for (let i = 0; i <= STATIONS; i++) out.push(1 - Math.pow(1 - i / STATIONS, 1.25));
  return out;
}

interface Section {
  keel: THREE.Vector2;
  chine: THREE.Vector2;
  lip: THREE.Vector2;
  sheer: THREE.Vector2;
}

function section(lines: HullLines, s: number): Section {
  const w = sheerHalfBeam(lines, s);
  const h = sheerHeight(s);
  const k = keelHeight(s);
  const c = chineHalfBeam(lines, s);
  const ch = Math.min(k + c * Math.tan(deadrise(s)), h - 0.05);
  // The chine flat (a narrow lip that throws spray down) closes up where the bow fines out.
  const lip = 0.055 * (1 - smooth(0.75, 1, s));
  return {
    keel: new THREE.Vector2(0, k),
    chine: new THREE.Vector2(c, ch),
    lip: new THREE.Vector2(c + lip, ch + lip * 0.15),
    sheer: new THREE.Vector2(w, h),
  };
}

/** A lofted panel: `profile(s, u)` gives the section point (x, y) at station s, u across the panel. */
function panel(lines: HullLines, across: number, profile: (s: number, u: number) => THREE.Vector2, side: 1 | -1): THREE.BufferGeometry {
  const ss = stations();
  const pos: number[] = [];
  for (const s of ss) {
    const z = lines.length / 2 - s * lines.length;
    for (let j = 0; j <= across; j++) {
      const p = profile(s, j / across);
      pos.push(p.x * side, p.y, z - rake(s) * p.y);
    }
  }
  const index: number[] = [];
  const row = across + 1;
  for (let i = 0; i < ss.length - 1; i++) {
    for (let j = 0; j < across; j++) {
      const a = i * row + j;
      const b = a + 1;
      const c = a + row;
      const d = c + 1;
      // Wind outward on both sides.
      if (side > 0) index.push(a, c, b, b, c, d);
      else index.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function hullGeometry(lines: HullLines): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    // Bottom: keel to chine, a V with a little convexity.
    parts.push(
      panel(lines, 8, (s, u) => {
        const sec = section(lines, s);
        const p = sec.keel.clone().lerp(sec.chine, u);
        p.y -= Math.sin(Math.PI * u) * 0.025 * (1 - s);
        return p;
      }, side),
    );
    // The chine flat.
    parts.push(panel(lines, 1, (s, u) => section(lines, s).chine.clone().lerp(section(lines, s).lip, u), side));
    // Topsides, flaring out to the sheer.
    parts.push(
      panel(lines, 10, (s, u) => {
        const sec = section(lines, s);
        const p = sec.lip.clone().lerp(sec.sheer, u);
        p.x += Math.sin(Math.PI * u) * 0.035;
        return p;
      }, side),
    );
  }
  // The transom: the stern section, closed flat.
  const aft = section(lines, 0);
  const outline = [aft.sheer, aft.lip, aft.chine, aft.keel];
  const shape = new THREE.Shape([...outline.map((p) => new THREE.Vector2(p.x, p.y)), ...outline.slice(0, -1).reverse().map((p) => new THREE.Vector2(-p.x, p.y))]);
  const transom = new THREE.ShapeGeometry(shape);
  transom.translate(0, 0, lines.length / 2);
  transom.deleteAttribute("uv");
  parts.push(transom);
  return mergeGeometries(parts.map((g) => g.toNonIndexed()), false)!;
}

/** Inside of the hull: the cockpit sole and the bulwarks up to the gunwale. */
function interiorGeometry(lines: HullLines): { deck: THREE.BufferGeometry; walls: THREE.BufferGeometry; cap: THREE.BufferGeometry } {
  const inset = 0.07;
  /** Inner half-beam at a height: along the topside, less the hull thickness. */
  const innerAt = (s: number, y: number) => {
    const sec = section(lines, s);
    const u = THREE.MathUtils.clamp((y - sec.lip.y) / Math.max(1e-3, sec.sheer.y - sec.lip.y), 0, 1);
    return Math.max(0, THREE.MathUtils.lerp(sec.lip.x, sec.sheer.x, u) + Math.sin(Math.PI * u) * 0.035 - inset);
  };
  const deck = panel(lines, 1, (s, u) => {
    const y = deckHeight(s);
    const x = innerAt(s, y);
    return new THREE.Vector2(THREE.MathUtils.lerp(-x, x, u), y);
  }, 1);
  // The deck panel runs port to starboard; flip it to face up.
  const idx = deck.getIndex()!;
  for (let i = 0; i < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
  deck.computeVertexNormals();
  const walls: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  for (const side of [1, -1] as const) {
    // Inner faces point inboard, so wind them as the opposite side's outer faces.
    walls.push(
      panel(lines, 4, (s, u) => {
        const y = THREE.MathUtils.lerp(deckHeight(s), sheerHeight(s), u);
        return new THREE.Vector2(innerAt(s, y), y);
      }, side === 1 ? -1 : 1),
    );
    caps.push(
      panel(lines, 2, (s, u) => {
        const h = sheerHeight(s);
        const outer = sheerHalfBeam(lines, s);
        const inner = innerAt(s, h);
        return new THREE.Vector2(THREE.MathUtils.lerp(outer, inner, u), h + Math.sin(Math.PI * u) * 0.012);
      }, side),
    );
  }
  // The inboard walls were built mirrored; mirror their x back.
  for (const w of walls) {
    const p = w.getAttribute("position");
    for (let i = 0; i < p.count; i++) p.setX(i, -p.getX(i));
    w.computeVertexNormals();
  }
  return {
    deck,
    walls: mergeGeometries(walls.map((g) => g.toNonIndexed()), false)!,
    cap: mergeGeometries(caps.map((g) => g.toNonIndexed()), false)!,
  };
}

/** A tube along the sheer, offset outboard and down: the rub rail; or inboard and up: the bow rail. */
function sheerCurve(lines: HullLines, from: number, to: number, outboard: number, up: number, side: 1 | -1): THREE.CatmullRomCurve3 {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 40; i++) {
    const s = THREE.MathUtils.lerp(from, to, i / 40);
    const w = sheerHalfBeam(lines, s);
    const y = sheerHeight(s) + up;
    pts.push(new THREE.Vector3(side * Math.max(0, w + outboard), y, lines.length / 2 - s * lines.length - rake(s) * y));
  }
  return new THREE.CatmullRomCurve3(pts);
}

/** Gelcoat white topsides, a navy boot stripe at the waterline, antifouling below. */
function hullMaterial(length: number): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xf4f3ee, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.06, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHullY;\nvarying float vSheerGap;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vHullY = position.y;
        float sHull = clamp((${(length / 2).toFixed(3)} - position.z) / ${length.toFixed(3)}, 0.0, 1.0);
        vSheerGap = 0.74 + 0.18 * sHull + 0.42 * sHull * sHull * sHull - position.y;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vHullY;\nvarying float vSheerGap;")
      .replace(
        "vec4 diffuseColor = vec4( diffuse, opacity );",
        `vec4 diffuseColor = vec4( diffuse, opacity );
        float stripe = smoothstep(0.035, 0.045, vHullY) * (1.0 - smoothstep(0.155, 0.165, vHullY));
        float bottom = 1.0 - smoothstep(0.035, 0.045, vHullY);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.035, 0.09), stripe);
        // A broad accent band under the rub rail, following the sheer.
        float band = smoothstep(0.07, 0.08, vSheerGap) * (1.0 - smoothstep(0.25, 0.26, vSheerGap));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.018, 0.035, 0.09), band);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.035, 0.045), bottom);`,
      );
  };
  return m;
}

export type BoatKind = "console" | "skiff";

export interface BoatModel {
  group: THREE.Group;
  /** Where the helm view stands: at the wheel or the tiller, eye height, facing forward (-z). */
  helm: THREE.Object3D;
  lines: HullLines;
  dispose(): void;
}

/** A tapered, rounded outboard: cowling, midsection and leg, `scale` of a 250 hp. */
function outboard(black: THREE.Material, dark: THREE.Material, steel: THREE.Material, scale: number): THREE.Group {
  const engine = new THREE.Group();
  // Cowling: taller than wide, longest fore and aft, rounded hard, tapering to its top.
  const cowlGeometry = new RoundedBoxGeometry(0.44, 0.78, 0.74, 6, 0.19);
  const cp = cowlGeometry.getAttribute("position");
  for (let i = 0; i < cp.count; i++) {
    const t = (cp.getY(i) + 0.39) / 0.78;
    cp.setX(i, cp.getX(i) * (1 - 0.12 * t));
    cp.setZ(i, cp.getZ(i) * (1 - 0.08 * t) + 0.04 * t);
  }
  cowlGeometry.computeVertexNormals();
  const part = (geometry: THREE.BufferGeometry, material: THREE.Material, y: number, z: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(0, y, z);
    engine.add(mesh);
  };
  part(cowlGeometry, black, 0.4, 0.12);
  part(new RoundedBoxGeometry(0.26, 0.7, 0.42, 3, 0.08), black, -0.3, 0.02);
  part(new RoundedBoxGeometry(0.16, 0.62, 0.34, 2, 0.06), dark, -0.9, 0);
  part(new THREE.BoxGeometry(0.34, 0.02, 0.4), dark, -0.72, 0.02);
  part(new RoundedBoxGeometry(0.452, 0.045, 0.75, 2, 0.02), steel, 0.12, 0.12);
  engine.scale.setScalar(scale);
  return engine;
}

export function createBoat(kind: BoatKind): BoatModel {
  const lines = kind === "console" ? CENTER_CONSOLE : SKIFF;
  const group = new THREE.Group();
  const L = lines.length;
  const D = lines.depth;
  const gelcoat = hullMaterial(lines.length);
  const white = new THREE.MeshPhysicalMaterial({ color: 0xf1f0ea, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.1 });
  const nonSkid = new THREE.MeshStandardMaterial({ color: 0xd9d8d0, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.18, metalness: 1 });
  const black = new THREE.MeshPhysicalMaterial({ color: 0x0b0c0e, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c20, roughness: 0.6 });
  const canvas = new THREE.MeshStandardMaterial({ color: 0x1d2a3f, roughness: 0.9, side: THREE.DoubleSide });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x223040, roughness: 0.05, transparent: true, opacity: 0.35, clearcoat: 1, side: THREE.DoubleSide });
  const cushion = new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.75 });
  const teak = new THREE.MeshStandardMaterial({ color: 0x8a5a33, roughness: 0.6 });

  const add = (geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0, parent: THREE.Object3D = group) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  };

  // The shell is drawn at the centre console's heights and scaled to this hull's.
  const shell = new THREE.Group();
  shell.scale.y = D;
  group.add(shell);
  add(hullGeometry(lines), gelcoat, 0, 0, 0, shell);
  const inside = interiorGeometry(lines);
  add(inside.deck, nonSkid, 0, 0, 0, shell);
  add(inside.walls, white, 0, 0, 0, shell);
  add(inside.cap, white, 0, 0, 0, shell);
  for (const side of [1, -1] as const) {
    add(new THREE.TubeGeometry(sheerCurve(lines, 0, 0.995, 0.012, -0.035, side), 120, 0.03, 8), dark, 0, 0, 0, shell);
  }

  const deckAt = (z: number) => deckHeight((L / 2 - z) / L) * D;
  const sheerAft = sheerHeight(0) * D;
  const helm = new THREE.Object3D();

  if (kind === "console") {
    for (const side of [1, -1] as const) {
      // Bow rail on stanchions, from amidships forward.
      const rail = sheerCurve(lines, 0.5, 0.985, -0.1, 0.36, side);
      add(new THREE.TubeGeometry(rail, 80, 0.016, 8), steel);
      for (let i = 0; i <= 4; i++) {
        const p = rail.getPoint(i / 4.4);
        add(new THREE.CylinderGeometry(0.012, 0.012, 0.36, 8), steel, p.x, p.y - 0.18, p.z);
      }
    }
    // Console amidships, a little forward of centre.
    const cz = -0.35;
    const cy = deckAt(cz);
    add(new RoundedBoxGeometry(1.05, 1.1, 0.95, 4, 0.12), white, 0, cy + 0.55, cz);
    // Dash and windshield, raked aft.
    const dash = add(new THREE.PlaneGeometry(0.95, 0.42), black, 0, cy + 1.13, cz + 0.28);
    dash.rotation.x = -1.05;
    const shield = add(new THREE.PlaneGeometry(1.0, 0.5), glass, 0, cy + 1.32, cz - 0.08);
    shield.rotation.x = -0.35;
    const wheel = add(new THREE.TorusGeometry(0.19, 0.018, 10, 40), steel, 0.2, cy + 1.02, cz + 0.52);
    wheel.rotation.x = -0.6;
    // T-top: four posts and a hard top with a navy canvas underside.
    const postH = 2.15;
    for (const [x, z] of [[-0.62, cz - 0.55], [0.62, cz - 0.55], [-0.62, cz + 1.25], [0.62, cz + 1.25]]) {
      add(new THREE.CylinderGeometry(0.028, 0.028, postH, 10), steel, x, deckAt(z) + postH / 2, z);
    }
    const topY = cy + postH + 0.04;
    add(new RoundedBoxGeometry(1.7, 0.08, 2.2, 3, 0.035), white, 0, topY, cz + 0.35);
    const under = add(new THREE.PlaneGeometry(1.6, 2.1), canvas, 0, topY - 0.045, cz + 0.35);
    under.rotation.x = Math.PI / 2;
    // Leaning post aft of the console, and a cushion on the raised bow deck.
    add(new RoundedBoxGeometry(0.95, 0.72, 0.5, 3, 0.06), white, 0, deckAt(1.2) + 0.36, 1.2);
    add(new RoundedBoxGeometry(0.95, 0.12, 0.42, 3, 0.05), cushion, 0, deckAt(1.2) + 0.78, 1.2);
    add(new RoundedBoxGeometry(1.3, 0.1, 0.9, 3, 0.04), cushion, 0, deckAt(-2.4) + 0.05, -2.4);
    // Twin outboards on a bracket.
    for (const x of [-0.42, 0.42]) {
      const engine = outboard(black, dark, steel, 1);
      engine.position.set(x, sheerAft + 0.02, L / 2 + 0.34);
      group.add(engine);
    }
    add(new RoundedBoxGeometry(1.35, 0.5, 0.36, 2, 0.05), white, 0, sheerAft - 0.3, L / 2 + 0.17);
    helm.position.set(0.2, cy + 1.62, cz + 1.05);
  } else {
    // Two thwarts and a small casting deck forward.
    for (const z of [-0.2, 1.3]) {
      const half = halfBeamAt(lines, (L / 2 - z) / L, deckAt(z) + 0.4) - 0.1;
      add(new RoundedBoxGeometry(half * 2, 0.06, 0.34, 2, 0.02), teak, 0, deckAt(z) + 0.4, z);
    }
    add(new RoundedBoxGeometry(1.1, 0.08, 0.8, 2, 0.03), nonSkid, 0, deckAt(-1.6) + 0.22, -1.6);
    // A 60 hp tiller outboard on the transom, its arm reaching forward to port.
    const engine = outboard(black, dark, steel, 0.62);
    engine.position.set(0, sheerAft + 0.05, L / 2 + 0.2);
    group.add(engine);
    const tiller = add(new THREE.CylinderGeometry(0.025, 0.03, 0.75, 10), dark, -0.1, sheerAft + 0.22, L / 2 - 0.2);
    tiller.rotation.set(Math.PI / 2 - 0.25, 0, 0.35);
    // Sitting on the aft thwart, port side, hand on the tiller.
    helm.position.set(-0.4, deckAt(1.3) + 1.2, 1.35);
  }
  group.add(helm);

  return {
    group,
    helm,
    lines,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const m of [gelcoat, white, nonSkid, steel, black, dark, canvas, glass, cushion, teak]) m.dispose();
    },
  };
}
