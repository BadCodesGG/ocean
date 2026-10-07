/**
 * Picture quality: how many pixels are drawn, how fine the sea's mesh is, and how much rain and spray
 * fill the air. "auto" picks a preset for the device and then holds the frame rate by drawing fewer
 * pixels when frames run slow, and more again when they catch up.
 */

export type QualityPreset = "low" | "medium" | "high" | "max";
export type Quality = "auto" | QualityPreset;

export const QUALITY_PRESETS: readonly QualityPreset[] = ["low", "medium", "high", "max"];
export const QUALITIES: readonly Quality[] = ["auto", ...QUALITY_PRESETS];

export interface QualitySettings {
  /** Most device pixels drawn per CSS pixel. */
  pixelRatio: number;
  /** Segments around the sea's polar mesh (its rings follow, so cells stay square). */
  grid: number;
  /** Raindrops in the air at the heaviest rain. */
  rain: number;
  /** Share of the full spray drawn. */
  spray: number;
  bloom: boolean;
}

export const QUALITY: Record<QualityPreset, QualitySettings> = {
  low: { pixelRatio: 0.75, grid: 224, rain: 8_000, spray: 0.35, bloom: false },
  medium: { pixelRatio: 1.25, grid: 320, rain: 16_000, spray: 0.6, bloom: true },
  high: { pixelRatio: 2, grid: 448, rain: 30_000, spray: 1, bloom: true },
  max: { pixelRatio: 3, grid: 576, rain: 45_000, spray: 1, bloom: true },
};

export interface Device {
  /** The WebGL renderer string, unmasked where the browser allows. */
  gpu: string;
  /** A touch screen is the main pointer: a phone or tablet. */
  coarse: boolean;
  cores: number;
  /** GiB, where the browser reports it. */
  memory?: number;
}

/** A preset this device should hold 60 frames a second at. Max is only ever chosen by hand. */
export function pickQuality(d: Device): QualityPreset {
  if (/swiftshader|llvmpipe|software|basic render/i.test(d.gpu)) return "low";
  const weak = d.cores <= 4 || (d.memory !== undefined && d.memory <= 4);
  if (d.coarse) return weak ? "low" : "medium";
  if (weak) return "medium";
  // Integrated and mobile graphics; Apple's own chips hold up.
  if (/intel|mali|adreno|powervr|videocore/i.test(d.gpu) && !/arc/i.test(d.gpu)) return "medium";
  return "high";
}

/** Frame time above which "auto" draws fewer pixels (45 fps), and below which it may draw more (57 fps). */
const SLOW = 1 / 45;
const FAST = 1 / 57;
const STEP = 0.85;
export const MIN_SCALE = 0.5;

/**
 * Scales the pixel ratio to hold the frame rate: down a step after a second and a half of slow frames,
 * back up a step after four seconds of fast ones. Frame times are smoothed, so a single hitch does
 * nothing. A step down that buys no frames is undone, and the governor stops trying: that is a display
 * or power mode holding the frame rate (30 Hz in iOS Low Power Mode), not the drawing.
 */
export class ResolutionGovernor {
  scale = 1;
  private smooth = 1 / 60;
  private slowFor = 0;
  private fastFor = 0;
  /** Frames in the slow stretch that led to a step down, to see afterwards whether it helped. */
  private slowFrames = 0;
  /** Mean frame time before the last step down, while its effect is being measured. */
  private before: number | null = null;
  private checkedFor = 0;
  private checkedFrames = 0;
  private capped = false;

  /** Feed one frame's duration (s); true when the scale changed. */
  sample(dt: number): boolean {
    // Ignore stalls (a hidden tab, a debugger) rather than read them as slow rendering.
    if (dt <= 0 || dt > 0.25) return false;
    this.smooth += (dt - this.smooth) * 0.1;
    if (this.before !== null) {
      this.checkedFor += dt;
      this.checkedFrames++;
      if (this.checkedFor < 1.5) return false;
      // Frames exactly as long as before, not shorter and not longer (the load changed), is a cap.
      const after = this.checkedFor / this.checkedFrames;
      const unchanged = Math.abs(after - this.before) < this.before * 0.03;
      this.before = null;
      if (unchanged) {
        this.capped = true;
        this.scale = Math.min(1, this.scale / STEP);
        return true;
      }
    }
    if (this.capped) return false;
    if (this.smooth > SLOW) {
      this.slowFor += dt;
      this.slowFrames++;
    } else {
      this.slowFor = 0;
      this.slowFrames = 0;
    }
    this.fastFor = this.smooth < FAST ? this.fastFor + dt : 0;
    if (this.slowFor > 1.5 && this.scale > MIN_SCALE) {
      this.before = this.slowFor / this.slowFrames;
      this.checkedFor = 0;
      this.checkedFrames = 0;
      this.scale = Math.max(MIN_SCALE, this.scale * STEP);
      this.slowFor = 0;
      this.slowFrames = 0;
      return true;
    }
    if (this.fastFor > 4 && this.scale < 1) {
      this.scale = Math.min(1, this.scale / STEP);
      this.fastFor = 0;
      return true;
    }
    return false;
  }

  reset() {
    this.scale = 1;
    this.slowFor = 0;
    this.slowFrames = 0;
    this.fastFor = 0;
    this.before = null;
    this.capped = false;
  }
}
