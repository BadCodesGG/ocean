import type { BuoyRecord } from "@/lib/cdip";
import { reconstruct, surfaceAt, type Reconstruction, type SurfacePoint } from "./waves";

/**
 * The scene's clock and the records it plays, kvbmap-style: the scene runs a fixed lag behind real
 * time, far enough back that the buoy's data for "now" has already arrived. CDIP publishes each
 * 30-minute record some 20 to 55 minutes after it ends, so starting the clock at the latest record's
 * first sample leaves the next record time to arrive before it is needed. If one is late, the current
 * record loops (its sum is periodic in its length) until it lands; each new record fades in from the
 * moment the scene switches to it, whether that is its own start or later.
 */

export const FADE_SECONDS = 20;

export interface Entry {
  record: BuoyRecord;
  reconstruction: Reconstruction;
}

export interface Mix {
  current: Entry;
  /** The record fading out, while `weight` < 1. */
  previous?: Entry;
  /** Share of `current` in the mix. */
  weight: number;
}

export class Timeline {
  private readonly entries: Entry[] = [];
  /** Seconds the scene runs behind real time. */
  readonly lag: number;
  private readonly depth: number;
  /** The entry the scene last played, the one it is fading out of, and when that fade began. */
  private playing: Entry;
  private fadingFrom: Entry | undefined;
  private fadeStart = 0;

  constructor(first: BuoyRecord, depth: number, nowSeconds: number) {
    this.playing = { record: first, reconstruction: reconstruct(first, depth) };
    this.entries.push(this.playing);
    this.lag = nowSeconds - first.start;
    this.depth = depth;
  }

  sceneTime(nowSeconds: number): number {
    return nowSeconds - this.lag;
  }

  /** Add a newer record. Older or duplicate records are ignored; returns whether it was added. */
  add(record: BuoyRecord): boolean {
    const last = this.entries[this.entries.length - 1].record;
    if (record.start <= last.start + 1) return false;
    this.entries.push({ record, reconstruction: reconstruct(record, this.depth) });
    // Keep three: the one fading out, the one playing, and the one about to.
    while (this.entries.length > 3) this.entries.shift();
    return true;
  }

  /**
   * The newest record the scene has reached, the one it was playing before, and how far the fade
   * between them has got. Call it with a clock that moves forward (once a frame).
   */
  at(sceneTime: number): Mix {
    let current = this.entries[0];
    for (const e of this.entries) if (e.record.start <= sceneTime) current = e;
    if (current !== this.playing && current.record.start > this.playing.record.start) {
      this.fadingFrom = this.playing;
      // On time, the fade runs from the record's own start; a record that arrived late fades in from now.
      this.fadeStart = sceneTime - current.record.start < FADE_SECONDS ? current.record.start : sceneTime;
      this.playing = current;
    }
    const since = sceneTime - this.fadeStart;
    if (this.fadingFrom && since < FADE_SECONDS) {
      const t = Math.max(0, since) / FADE_SECONDS;
      return { current: this.playing, previous: this.fadingFrom, weight: t * t * (3 - 2 * t) };
    }
    this.fadingFrom = undefined;
    return { current: this.playing, weight: 1 };
  }

  /** True once the scene has played past the end of the newest record it holds: it is looping. */
  waiting(sceneTime: number): boolean {
    const last = this.entries[this.entries.length - 1];
    return sceneTime > last.record.start + last.reconstruction.period;
  }

  get latest(): Entry {
    return this.entries[this.entries.length - 1];
  }
}

/** Seconds into an entry's own (periodic) record at scene time T. */
export function recordTime(entry: Entry, sceneTime: number): number {
  const p = entry.reconstruction.period;
  return (((sceneTime - entry.record.start) % p) + p) % p;
}

/** The swell surface at a point, blended across a fade exactly as the GPU blends it. */
export function blendedSurface(mix: Mix, x: number, y: number, sceneTime: number): SurfacePoint {
  const a = surfaceAt(mix.current.reconstruction.components, x, y, recordTime(mix.current, sceneTime));
  if (!mix.previous || mix.weight >= 1) return a;
  const b = surfaceAt(mix.previous.reconstruction.components, x, y, recordTime(mix.previous, sceneTime));
  const w = mix.weight;
  return {
    eta: a.eta * w + b.eta * (1 - w),
    east: a.east * w + b.east * (1 - w),
    north: a.north * w + b.north * (1 - w),
    slopeEast: a.slopeEast * w + b.slopeEast * (1 - w),
    slopeNorth: a.slopeNorth * w + b.slopeNorth * (1 - w),
  };
}
