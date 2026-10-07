import * as THREE from "three";
import type { SurfaceProbe } from "./camera";

/**
 * How a small planing boat moves on the measured sea. The helm sets throttle and rudder; the hull
 * feels the water at four probes (bow, stern, port, starboard) on the same swell the sea draws, and
 * heaves, pitches and rolls toward it through damped springs, with the trim and heel of a boat under
 * way on top. Positions are world metres (x east, z south); heading is a compass bearing in radians.
 */

export interface Handling {
  length: number;
  beam: number;
  /** Top speed at full throttle, m/s. */
  topSpeed: number;
  /** Acceleration at full throttle from rest, m/s². */
  thrust: number;
  /** Yaw rate at full rudder once moving, rad/s. */
  turnRate: number;
}

export const HANDLING = {
  console: { length: 7.6, beam: 2.6, topSpeed: 20, thrust: 3.2, turnRate: 0.42 },
  skiff: { length: 5.2, beam: 2.0, topSpeed: 13, thrust: 2.6, turnRate: 0.62 },
} satisfies Record<string, Handling>;

export interface Helm {
  /** Hold to open (+1) or close (-1) the throttle; it stays where it is left. */
  throttle: number;
  /** Rudder, -1 (port) to +1 (starboard); springs back to centre when let go. */
  rudder: number;
  /** Throttle to neutral at once. */
  neutral?: boolean;
}

interface Spring {
  x: number;
  v: number;
}

function spring(s: Spring, target: number, omega: number, zeta: number, dt: number) {
  const a = omega * omega * (target - s.x) - 2 * zeta * omega * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

const TAU = 2 * Math.PI;

export class BoatMotion {
  x: number;
  z: number;
  heading: number;
  /** Forward speed through the water, m/s (negative astern). */
  speed = 0;
  yawRate = 0;
  /** Throttle lever, -0.3 (astern) to 1. */
  throttle = 0;
  rudder = 0;
  readonly heave: Spring = { x: 0, v: 0 };
  readonly pitch: Spring = { x: 0, v: 0 };
  readonly roll: Spring = { x: 0, v: 0 };
  /** How fast the bow is driving down into the water, m/s, eased (0 while it lifts clear). */
  slam = 0;
  /** Height of the sea under the boat, m. */
  water = 0;
  private immersion: number | null = null;
  /** The swell's own horizontal motion at the boat, carried along with it. */
  private readonly drift = new THREE.Vector2();

  constructor(
    readonly handling: Handling,
    x: number,
    z: number,
    heading: number,
  ) {
    this.x = x;
    this.z = z;
    this.heading = heading;
  }

  step(dt: number, helm: Helm, surface: SurfaceProbe) {
    const h = this.handling;
    // Sub-step so the springs stay stable through a slow frame.
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const d = dt / steps;
    for (let i = 0; i < steps; i++) this.integrate(d, helm, surface, h);
  }

  private integrate(dt: number, helm: Helm, surface: SurfaceProbe, h: Handling) {
    if (helm.neutral) this.throttle = 0;
    this.throttle = THREE.MathUtils.clamp(this.throttle + helm.throttle * dt * 0.6, -0.3, 1);
    const rudderTarget = THREE.MathUtils.clamp(helm.rudder, -1, 1);
    this.rudder += (rudderTarget - this.rudder) * (1 - Math.exp(-dt * (rudderTarget === 0 ? 3 : 5)));

    // Thrust against a drag that balances it at top speed.
    const drag = h.thrust * (this.speed / h.topSpeed) * Math.abs(this.speed / h.topSpeed);
    this.speed += (h.thrust * this.throttle - drag - this.speed * 0.02) * dt;
    const grip = THREE.MathUtils.clamp(Math.abs(this.speed) / 4, 0.12, 1) * Math.sign(this.speed || 1);
    const yawTarget = this.rudder * h.turnRate * grip * (Math.abs(this.speed) < 0.05 ? 0.3 : 1);
    this.yawRate += (yawTarget - this.yawRate) * (1 - Math.exp(-dt / 0.55));
    this.heading = (((this.heading + this.yawRate * dt) % TAU) + TAU) % TAU;
    this.x += Math.sin(this.heading) * this.speed * dt;
    this.z -= Math.cos(this.heading) * this.speed * dt;

    // The water under the hull.
    const fx = Math.sin(this.heading);
    const fz = -Math.cos(this.heading);
    const rx = Math.cos(this.heading);
    const rz = Math.sin(this.heading);
    const ax = 0.4 * h.length;
    const bx = 0.4 * h.beam;
    const bow = surface(this.x + fx * ax, this.z + fz * ax).eta;
    const stern = surface(this.x - fx * ax, this.z - fz * ax).eta;
    const port = surface(this.x - rx * bx, this.z - rz * bx).eta;
    const star = surface(this.x + rx * bx, this.z + rz * bx).eta;
    const mid = surface(this.x, this.z);
    this.drift.set(mid.east, mid.north);

    // Under way a planing hull lifts and trims bow up over the hump, then flattens a little on the plane.
    const v = Math.max(0, this.speed);
    const trim = THREE.MathUtils.degToRad(4.5) * Math.exp(-(((v - 7) / 4) ** 2)) + THREE.MathUtils.degToRad(2.2) * THREE.MathUtils.smoothstep(v, 6, 14);
    const lift = 0.12 * THREE.MathUtils.smoothstep(v, 6, 14);
    // Outboard boats bank into a turn.
    const heel = -THREE.MathUtils.clamp(this.yawRate * v * 0.05, -0.25, 0.25);
    const heaveTarget = (bow + stern + port + star + 2 * mid.eta) / 6 + lift;
    const pitchTarget = Math.atan2(bow - stern, 2 * ax) + trim;
    const rollTarget = Math.atan2(star - port, 2 * bx) + heel;
    spring(this.heave, heaveTarget, TAU / 1.4, 0.55, dt);
    spring(this.pitch, pitchTarget, TAU / 1.9, 0.4, dt);
    spring(this.roll, rollTarget, TAU / 2.6, 0.3, dt);
    this.water = mid.eta;
    // The bow's depth below the water there; its rate of increase is the slam that throws spray.
    const immersion = bow - (this.heave.x + Math.sin(this.pitch.x) * ax);
    const rate = this.immersion === null ? 0 : (immersion - this.immersion) / dt;
    this.immersion = immersion;
    this.slam += (Math.max(0, rate - 0.3) - this.slam) * (1 - Math.exp(-dt / 0.08));
  }

  /** Place a model: position with the swell's drift, then heading, pitch (bow up) and roll (starboard up). */
  apply(object: THREE.Object3D) {
    object.position.set(this.x + this.drift.x * 0.9, this.heave.x, this.z - this.drift.y * 0.9);
    object.rotation.set(this.pitch.x, -this.heading, this.roll.x, "YXZ");
    object.updateMatrixWorld();
  }

  get knots(): number {
    return this.speed / (1852 / 3600);
  }
}
