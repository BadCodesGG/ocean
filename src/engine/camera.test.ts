import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { bearingOf, CameraRig, type RigContext, type RigInput } from "./camera";

/** A stand-in for the pointer and keyboard: one drag, and whichever keys are held. */
function input(drag: { dx?: number; dy?: number; zoom?: number }, keys: string[] = []): RigInput {
  let pending = { dx: drag.dx ?? 0, dy: drag.dy ?? 0, zoom: drag.zoom ?? 0 };
  return {
    consume() {
      const out = pending;
      pending = { dx: 0, dy: 0, zoom: 0 };
      return out;
    },
    held: (...codes: string[]) => codes.some((c) => keys.includes(c)),
    axis: (plus: string[], minus: string[]) => (plus.some((c) => keys.includes(c)) ? 1 : 0) - (minus.some((c) => keys.includes(c)) ? 1 : 0),
  } as unknown as RigInput;
}

const flat: RigContext = { surface: () => ({ eta: 0, east: 0, north: 0 }), focus: new THREE.Vector3(), helm: null, heading: null };

function rig() {
  const camera = new THREE.PerspectiveCamera();
  const r = new CameraRig(camera, new THREE.Vector3(0, 1.2, 20), 0);
  r.update(1 / 60, input({}), flat);
  return { camera, r };
}

const dir = (c: THREE.Camera) => c.getWorldDirection(new THREE.Vector3());
/** Signed angle from bearing a to bearing b, radians, the short way. */
const turned = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

describe("CameraRig drag directions", () => {
  it("float: dragging right looks right, dragging down looks down", () => {
    const { camera, r } = rig();
    const before = dir(camera);
    r.update(1 / 60, input({ dx: 100 }), flat);
    expect(turned(bearingOf(before.x, before.z), bearingOf(dir(camera).x, dir(camera).z))).toBeGreaterThan(0.1);
    r.update(1 / 60, input({ dy: 100 }), flat);
    expect(dir(camera).y).toBeLessThan(-0.1);
  });

  it("fly: keeps the view on entering, and W goes where it looks", () => {
    const { camera, r } = rig();
    r.update(1 / 60, input({ dy: 150 }), flat);
    const lookingDown = dir(camera).y;
    r.setMode("fly", flat);
    // Past the mode blend, the view is the one it entered with.
    for (let i = 0; i < 90; i++) r.update(1 / 60, input({}), flat);
    expect(dir(camera).y).toBeCloseTo(lookingDown, 3);
    camera.position.y = 20;
    const y0 = camera.position.y;
    r.update(0.5, input({}, ["KeyW"]), flat);
    expect(camera.position.y).toBeLessThan(y0 - 1);
  });

  it("orbit: dragging right swings the camera the way the scene is pulled", () => {
    const { camera, r } = rig();
    r.setMode("orbit", flat);
    for (let i = 0; i < 90; i++) r.update(1 / 60, input({}), flat);
    const a = bearingOf(camera.position.x, camera.position.z);
    r.update(1 / 60, input({ dx: 100 }), flat);
    // The camera goes clockwise seen from above, so the scene turns with the cursor.
    expect(turned(a, bearingOf(camera.position.x, camera.position.z))).toBeGreaterThan(0.1);
  });

  it("float is home: coming back to it faces the resting view again, whatever the last view was", () => {
    const { camera, r } = rig();
    const home = dir(camera);
    r.update(1 / 60, input({ dx: 300, dy: 200 }), flat);
    r.setMode("orbit", flat);
    for (let i = 0; i < 120; i++) r.update(1 / 60, input({ dx: 5 }), flat);
    r.setMode("float", flat);
    for (let i = 0; i < 120; i++) r.update(1 / 60, input({}), flat);
    expect(dir(camera).angleTo(home)).toBeLessThan(0.01);
  });
});
