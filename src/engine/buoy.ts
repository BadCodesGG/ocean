import * as THREE from "three";
import { blendedSurface, recordTime, type Mix } from "./timeline";

/**
 * A Datawell Waverider, the 0.9 m sphere CDIP moors at every station: yellow upper hull, a black
 * fender at the waterline, antifouled below, a whip antenna and a light that flashes five times every
 * twenty seconds.
 *
 * It moves as it measured. Horizontally it replays the record itself; vertically and in tilt it rides
 * the reconstructed swell at its own position, which is the record's heave within the swell band and
 * is the same surface the water draws, so the hull always sits in the water.
 */

const RADIUS = 0.45;
/** The lamp's radiance while on, in the scene's units (the sun at the sea is about 20). */
export const LAMP_RADIANCE = 4e-4;

export function createBuoy(): THREE.Group {
  const group = new THREE.Group();
  const hull = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2),
    // Datawell yellow, painted, and wet.
    new THREE.MeshPhysicalMaterial({ color: 0xf0a800, roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.2 }),
  );
  const bottom = new THREE.Mesh(
    new THREE.SphereGeometry(RADIUS * 0.99, 48, 16, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x1d1f22, roughness: 0.8 }),
  );
  const fender = new THREE.Mesh(
    new THREE.TorusGeometry(RADIUS + 0.02, 0.045, 12, 64),
    new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6 }),
  );
  fender.rotation.x = Math.PI / 2;
  fender.position.y = 0.05;
  const hatch = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.14, 0.06, 32),
    new THREE.MeshStandardMaterial({ color: 0xc9ccd1, roughness: 0.35, metalness: 0.8 }),
  );
  hatch.position.y = RADIUS - 0.01;
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.008, 0.012, 0.62, 8),
    new THREE.MeshStandardMaterial({ color: 0x0c0c0c, roughness: 0.5 }),
  );
  mast.position.y = RADIUS + 0.31;
  const light = new THREE.Mesh(
    new THREE.SphereGeometry(0.028, 16, 8),
    new THREE.MeshStandardMaterial({ color: 0x332a10, emissive: new THREE.Color(1, 0.8, 0.3), emissiveIntensity: 0 }),
  );
  light.name = "light";
  light.position.y = RADIUS + 0.64;
  group.add(hull, bottom, fender, hatch, mast, light);
  // The hull floats with its fender just under the mean surface.
  group.children.forEach((c) => (c.position.y -= 0.08));
  return group;
}

/** Catmull-Rom sample of a record channel at time t (seconds from its first sample), looping. */
export function sampleChannel(values: number[], rate: number, t: number): number {
  const n = values.length;
  const x = (((t * rate) % n) + n) % n;
  const i = Math.floor(x);
  const f = x - i;
  const p0 = values[(i - 1 + n) % n];
  const p1 = values[i];
  const p2 = values[(i + 1) % n];
  const p3 = values[(i + 2) % n];
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
}

/** Light pattern: five 0.4 s flashes a second apart, then dark until the twenty seconds are up. */
export function flashOn(t: number): boolean {
  const s = ((t % 20) + 20) % 20;
  return s < 5 && s % 1 < 0.4;
}

const up = new THREE.Vector3(0, 1, 0);
const normal = new THREE.Vector3();

/** The buoy's own recorded horizontal displacement at scene time, blended across a record change. */
function recorded(mix: Mix, sceneTime: number): [number, number] {
  const at = (e: Mix["current"]) => {
    const t = recordTime(e, sceneTime);
    return [sampleChannel(e.record.east, e.record.rate, t), sampleChannel(e.record.north, e.record.rate, t)];
  };
  const [e, n] = at(mix.current);
  if (!mix.previous || mix.weight >= 1) return [e, n];
  const [pe, pn] = at(mix.previous);
  return [e * mix.weight + pe * (1 - mix.weight), n * mix.weight + pn * (1 - mix.weight)];
}

/** Returns whether the light is on, for the scene to light the water with it. */
export function updateBuoy(buoy: THREE.Group, mix: Mix, sceneTime: number): boolean {
  const p = blendedSurface(mix, 0, 0, sceneTime);
  const [east, north] = recorded(mix, sceneTime);
  // World axes: x east, z south.
  buoy.position.set(east, p.eta, -north);
  normal.set(-p.slopeEast, 1, p.slopeNorth).normalize();
  buoy.quaternion.setFromUnitVectors(up, normal);
  const on = flashOn(sceneTime);
  const light = buoy.getObjectByName("light") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  // A small LED lantern: a few ten-thousandths of the sun-lit sky, so it is lost by day and a hard
  // point of light at night, as the real one is.
  light.material.emissiveIntensity = on ? LAMP_RADIANCE : 0;
  return on;
}

/** World position of the light on top of the mast. */
export function lightPosition(buoy: THREE.Group, out: THREE.Vector3): THREE.Vector3 {
  return (buoy.getObjectByName("light") as THREE.Object3D).getWorldPosition(out);
}
