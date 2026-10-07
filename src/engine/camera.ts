import * as THREE from "three";

/**
 * How the viewer looks at the sea. Five modes, all driven by one pointer-and-keyboard input:
 *
 * - float: the default. Held in the water near the buoy, riding the swell; drag to look around.
 * - orbit: circle the buoy (or the boat) at any height; drag to turn, wheel or pinch to zoom.
 * - fly: free flight above the water; WASD or arrows to move, Q and E down and up, drag to look.
 * - helm: standing at the boat's wheel, moving with the hull; drag to look around.
 * - chase: behind the boat, swinging round with its heading; drag to look at it from another side.
 * - tour: a slow, unattended drone pass around the buoy or the boat.
 *
 * World axes: x east, y up, z south. Bearings are degrees clockwise from north.
 */

export type CameraMode = "float" | "orbit" | "fly" | "helm" | "chase" | "tour";
export const CAMERA_MODES: readonly CameraMode[] = ["float", "orbit", "fly", "helm", "chase", "tour"];

/** Height of the water at a point (x east, z south), including the swell's horizontal motion there. */
export type SurfaceProbe = (x: number, z: number) => { eta: number; east: number; north: number };

export interface RigContext {
  surface: SurfaceProbe;
  /** What orbit and tour circle: the buoy, or the boat when there is one. */
  focus: THREE.Vector3;
  /** Where the helm view stands, and which way the boat points; null without a boat. */
  helm: THREE.Object3D | null;
  /** The boat's heading (bearing, radians), for the chase view; null without a boat. */
  heading: number | null;
}

const DEG = Math.PI / 180;
/** The lowest a camera goes above the water under it. */
const CLEARANCE = 0.5;
const FLY_CEILING = 150;
const ORBIT_MIN = 3;
const ORBIT_MAX = 300;
const BLEND_SECONDS = 1.6;

/** Unit vector (x east, z south) toward a compass bearing in radians. */
export function bearingVector(bearing: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(bearing), 0, -Math.cos(bearing));
}

/** Bearing (radians, 0 to 2π) of a horizontal direction. */
export function bearingOf(x: number, z: number): number {
  const b = Math.atan2(x, -z);
  return b < 0 ? b + 2 * Math.PI : b;
}

/** Point `distance` from `focus` toward bearing `azimuth`, raised by `elevation` (radians). */
export function orbitPosition(focus: THREE.Vector3, azimuth: number, elevation: number, distance: number, out = new THREE.Vector3()) {
  bearingVector(azimuth, out).multiplyScalar(Math.cos(elevation) * distance);
  out.y = Math.sin(elevation) * distance;
  return out.add(focus);
}

/** Lift a camera position so it stays `clearance` above the sea under it. */
export function keepAbove(position: THREE.Vector3, surface: SurfaceProbe, clearance = CLEARANCE): THREE.Vector3 {
  const floor = surface(position.x, position.z).eta + clearance;
  if (position.y < floor) position.y = floor;
  return position;
}

/** Pointer, wheel, pinch and keyboard, accumulated between frames. */
export class RigInput {
  dx = 0;
  dy = 0;
  zoom = 0;
  readonly keys = new Set<string>();
  /** Set on any direct input, so the tour and the UI know the viewer took over. */
  touched = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch = 0;
  private readonly off: (() => void)[] = [];

  constructor(private readonly element: HTMLElement) {
    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.off.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };
    on(element, "pointerdown", (e) => {
      element.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinch = this.spread();
      this.touched = true;
    });
    on(element, "pointermove", (e) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      if (this.pointers.size === 1) {
        this.dx += e.clientX - p.x;
        this.dy += e.clientY - p.y;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 2) {
        const s = this.spread();
        if (this.pinch > 0) this.zoom += (this.pinch - s) * 4;
        this.pinch = s;
      }
    });
    const up = (e: PointerEvent) => {
      this.pointers.delete(e.pointerId);
      this.pinch = this.spread();
    };
    on(element, "pointerup", up);
    on(element, "pointercancel", up);
    on(
      element,
      "wheel",
      (e) => {
        e.preventDefault();
        this.zoom += e.deltaY * (e.deltaMode === 1 ? 30 : 1);
        this.touched = true;
      },
      { passive: false },
    );
    const typing = (e: KeyboardEvent) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    on(window, "keydown", (e) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      this.keys.add(e.code);
      this.touched = true;
    });
    on(window, "keyup", (e) => this.keys.delete(e.code));
    on(window, "blur", () => this.keys.clear());
  }

  private spread(): number {
    if (this.pointers.size !== 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  /** Is any of these keys held? */
  held(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Axis from two sets of keys: +1, -1 or 0. */
  axis(plus: string[], minus: string[]): number {
    return (this.held(...plus) ? 1 : 0) - (this.held(...minus) ? 1 : 0);
  }

  /** Take the drag and zoom gathered since the last frame. */
  consume(): { dx: number; dy: number; zoom: number } {
    const out = { dx: this.dx, dy: this.dy, zoom: this.zoom };
    this.dx = this.dy = this.zoom = 0;
    return out;
  }

  get dragging(): boolean {
    return this.pointers.size > 0;
  }

  dispose() {
    for (const f of this.off) f();
  }
}

const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const look = new THREE.Vector3();
const m = new THREE.Matrix4();

export class CameraRig {
  mode: CameraMode = "float";
  /** Look direction: yaw clockwise (to the right) and pitch up are positive. Float: offsets from the resting view; helm: relative to the hull; fly: absolute. */
  private yaw = 0;
  private pitch = 0;
  orbit = { azimuth: 0, elevation: 12 * DEG, distance: 24 };
  private readonly fly = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private tourTime = 0;
  private chase = { yaw: 0, elevation: 11 * DEG, distance: 17, heading: NaN };
  private blend = 1;
  private readonly fromPos = new THREE.Vector3();
  private readonly fromQuat = new THREE.Quaternion();
  private readonly fromTarget = new THREE.Vector3();
  private readonly tourFrom = { distance: 38, height: 8 };
  private focusReady = false;

  /**
   * @param rest where the float view is held (at mean sea level), and the bearing it faces.
   */
  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly rest: THREE.Vector3,
    private readonly facing: number,
  ) {}

  setMode(mode: CameraMode, ctx: RigContext) {
    if (mode === this.mode) return;
    this.fromPos.copy(this.camera.position);
    this.fromQuat.copy(this.camera.quaternion);
    this.blend = 0;
    const dir = this.camera.getWorldDirection(tmp);
    // Blend toward where the old view was looking, at the distance of what it was looking at.
    this.fromTarget.copy(this.camera.position).addScaledVector(dir, Math.max(8, this.camera.position.distanceTo(ctx.focus)));
    if (mode === "orbit") {
      // Start from where the camera is, seen from the focus.
      const rel = tmp2.copy(this.camera.position).sub(ctx.focus);
      const d = THREE.MathUtils.clamp(rel.length(), ORBIT_MIN, ORBIT_MAX);
      this.orbit = { azimuth: bearingOf(rel.x, rel.z), elevation: THREE.MathUtils.clamp(Math.asin(rel.y / Math.max(d, 1e-3)), 3 * DEG, 85 * DEG), distance: d };
    } else if (mode === "fly") {
      this.fly.copy(this.camera.position);
      this.yaw = bearingOf(dir.x, dir.z);
      this.pitch = Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1));
    } else if (mode === "chase") {
      this.chase = { yaw: 0, elevation: 11 * DEG, distance: 17, heading: ctx.heading ?? NaN };
    } else if (mode === "float" || mode === "helm") {
      // Float is home: back to the resting view with the buoy in frame (the glide makes it smooth).
      // The helm starts looking over the bow.
      this.yaw = 0;
      this.pitch = 0;
    } else if (mode === "tour") {
      // Start the drone from where the camera is and ease it onto its path.
      const rel = tmp2.copy(this.camera.position).sub(ctx.focus);
      this.tourTime = 0;
      this.orbit.azimuth = bearingOf(rel.x, rel.z);
      this.tourFrom.distance = Math.hypot(rel.x, rel.z);
      this.tourFrom.height = Math.max(1.5, rel.y);
    }
    this.mode = mode;
  }

  /** Back to the mode's starting view. */
  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.orbit = { azimuth: this.facing * DEG + Math.PI + 0.35, elevation: 12 * DEG, distance: 24 };
    this.chase = { ...this.chase, yaw: 0, elevation: 11 * DEG, distance: 17 };
  }

  update(dt: number, input: RigInput, ctx: RigContext) {
    const { dx, dy, zoom } = input.consume();
    const turn = 0.0042;
    // The focus follows the heave smoothly: a drone keeps station, it does not jerk with every wave.
    if (!this.focusReady) this.focus.copy(ctx.focus);
    this.focusReady = true;
    this.focus.x = ctx.focus.x;
    this.focus.z = ctx.focus.z;
    this.focus.y += (ctx.focus.y - this.focus.y) * (1 - Math.exp(-dt * 2));

    const cam = this.camera;
    const boatless = !ctx.helm && (this.mode === "helm" || this.mode === "chase");
    switch (boatless ? "float" : this.mode) {
      case "float": {
        this.yaw += dx * turn;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * turn, -70 * DEG, 70 * DEG);
        // Someone floating rides most of the swell where they are.
        const here = ctx.surface(this.rest.x, this.rest.z);
        cam.position.set(this.rest.x + here.east * 0.8, this.rest.y + here.eta * 0.85, this.rest.z - here.north * 0.8);
        this.lookFrom(cam.position, this.facing * DEG + this.yaw, this.pitch);
        break;
      }
      case "orbit": {
        const o = this.orbit;
        o.azimuth += dx * turn;
        o.elevation = THREE.MathUtils.clamp(o.elevation + dy * turn, 2 * DEG, 85 * DEG);
        o.distance = THREE.MathUtils.clamp(o.distance * Math.exp(zoom * 0.001), ORBIT_MIN, ORBIT_MAX);
        const target = tmp2.copy(this.focus).add(tmp.set(0, 0.6, 0));
        orbitPosition(target, o.azimuth, o.elevation, o.distance, cam.position);
        keepAbove(cam.position, ctx.surface);
        cam.lookAt(target);
        break;
      }
      case "fly": {
        this.yaw += dx * turn;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * turn, -85 * DEG, 85 * DEG);
        const fast = input.held("ShiftLeft", "ShiftRight") ? 4 : 1;
        const speed = 9 * fast * (1 + Math.max(0, this.fly.y) / 25);
        const forward = input.axis(["KeyW", "ArrowUp"], ["KeyS", "ArrowDown"]) - zoom * 0.01;
        const strafe = input.axis(["KeyD", "ArrowRight"], ["KeyA", "ArrowLeft"]);
        const rise = input.axis(["KeyE", "Space"], ["KeyQ", "KeyC"]);
        const f = bearingVector(this.yaw, tmp).multiplyScalar(Math.cos(this.pitch));
        f.y = Math.sin(this.pitch);
        const right = bearingVector(this.yaw + Math.PI / 2, tmp2);
        this.fly.addScaledVector(f, forward * speed * dt).addScaledVector(right, strafe * speed * dt);
        this.fly.y += rise * speed * dt;
        keepAbove(this.fly, ctx.surface);
        this.fly.y = Math.min(this.fly.y, FLY_CEILING);
        cam.position.copy(this.fly);
        this.lookFrom(cam.position, this.yaw, this.pitch);
        break;
      }
      case "helm": {
        this.yaw += dx * turn;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * turn, -60 * DEG, 60 * DEG);
        const helm = ctx.helm!;
        helm.updateMatrixWorld();
        cam.position.setFromMatrixPosition(helm.matrixWorld);
        // Look relative to the hull, so the horizon tilts as the boat rolls.
        const q = helm.getWorldQuaternion(new THREE.Quaternion());
        look.set(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
        const up = tmp2.set(0, 1, 0).applyQuaternion(q);
        look.applyQuaternion(q).add(cam.position);
        m.lookAt(cam.position, look, up);
        cam.quaternion.setFromRotationMatrix(m);
        break;
      }
      case "chase": {
        const c = this.chase;
        const heading = ctx.heading ?? 0;
        if (Number.isNaN(c.heading)) c.heading = heading;
        // Swing round after the boat, the short way, over a second or so.
        const delta = Math.atan2(Math.sin(heading - c.heading), Math.cos(heading - c.heading));
        c.heading += delta * (1 - Math.exp(-dt * 1.4));
        c.yaw += dx * turn;
        c.elevation = THREE.MathUtils.clamp(c.elevation + dy * turn, 2 * DEG, 80 * DEG);
        c.distance = THREE.MathUtils.clamp(c.distance * Math.exp(zoom * 0.001), 6, 120);
        const target = tmp2.copy(this.focus).add(tmp.set(0, 1.4, 0));
        orbitPosition(target, c.heading + Math.PI + c.yaw, c.elevation, c.distance, cam.position);
        keepAbove(cam.position, ctx.surface);
        cam.lookAt(target);
        break;
      }
      case "tour": {
        if (dx || dy || zoom) this.orbit.azimuth += dx * turn;
        this.tourTime += dt;
        const t = this.tourTime;
        const az = this.orbit.azimuth + t * 0.045;
        const settle = THREE.MathUtils.smootherstep(t, 0, 10);
        const distance = THREE.MathUtils.lerp(this.tourFrom.distance, 38 + 26 * Math.sin(t * 0.052), settle);
        const height = THREE.MathUtils.lerp(this.tourFrom.height, 3 + 16 * (0.5 + 0.5 * Math.sin(t * 0.037 + 1.3)), settle);
        const target = tmp2.copy(this.focus).add(tmp.set(0, 1, 0));
        orbitPosition(target, az, Math.atan2(height, distance), Math.hypot(height, distance), cam.position);
        keepAbove(cam.position, ctx.surface, 1.2);
        cam.lookAt(target);
        break;
      }
    }

    // Glide from the last mode's view into this one: move the eye and slide the point it looks at,
    // so the view pans across rather than swinging about. The helm tilts with the hull, so it turns.
    if (this.blend < 1) {
      this.blend = Math.min(1, this.blend + dt / BLEND_SECONDS);
      const s = THREE.MathUtils.smootherstep(this.blend, 0, 1);
      if (this.mode === "helm" && ctx.helm) {
        cam.position.lerpVectors(this.fromPos, cam.position, s);
        cam.quaternion.slerpQuaternions(this.fromQuat, cam.quaternion, s);
      } else {
        const dir = cam.getWorldDirection(tmp);
        const to = tmp2.copy(cam.position).addScaledVector(dir, this.fromTarget.distanceTo(this.fromPos));
        cam.position.lerpVectors(this.fromPos, cam.position, s);
        cam.lookAt(to.lerpVectors(this.fromTarget, to, s));
      }
      keepAbove(cam.position, ctx.surface, 0.3);
    }
    cam.updateMatrixWorld();
  }

  private lookFrom(position: THREE.Vector3, bearing: number, pitch: number) {
    bearingVector(bearing, look).multiplyScalar(Math.cos(pitch));
    look.y = Math.sin(pitch);
    this.camera.lookAt(look.add(position));
  }
}
