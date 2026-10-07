/**
 * The sea's sound, made on the spot from noise with Web Audio: no recordings. Every layer follows what
 * the scene is drawing:
 *   - the swell: a low wash that rises and falls with the water under the eye, louder for a bigger sea;
 *   - breaking crests: a hiss that grows once the wind is strong enough to make whitecaps;
 *   - wind: a gusting roar in the ears, stronger high up;
 *   - rain: a hiss on the water and a patter of drops, with the rain rate;
 *   - thunder: a crack and a long rumble a few seconds after each flash;
 *   - the boat: an outboard whose note climbs with the throttle, and water rushing along the hull.
 * Silent until switched on: browsers only start audio from a click or a tap.
 */

export interface SoundInput {
  /** Significant wave height, m. */
  hs: number;
  /** Rise or fall of the water under the eye, m/s. */
  heaveRate: number;
  /** Eye height above the water, m. */
  height: number;
  /** Wind speed, m/s. */
  wind: number;
  /** Rain, 0 to 1. */
  rain: number;
  /** A lightning flash began this frame. */
  strike: boolean;
  boat: { throttle: number; speed: number; distance: number } | null;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function noiseBuffer(ctx: AudioContext, seconds: number, shape: (white: number, last: number) => number, gain = 1): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = shape(Math.random() * 2 - 1, last);
      data[i] = last * gain;
    }
  }
  return buffer;
}

/** Sparse drops: each a short, bright, decaying tick, scattered at random through a loop. */
function patterBuffer(ctx: AudioContext, seconds: number, perSecond: number): AudioBuffer {
  const buffer = ctx.createBuffer(2, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const drops = Math.floor(seconds * perSecond);
    for (let d = 0; d < drops; d++) {
      const at = Math.floor(Math.random() * data.length);
      const size = 0.2 + Math.random() * 0.8;
      const freq = 2200 + Math.random() * 4000;
      const length = Math.floor(ctx.sampleRate * 0.012);
      for (let i = 0; i < length && at + i < data.length; i++) {
        const t = i / ctx.sampleRate;
        data[at + i] += size * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 400) * 0.5;
      }
    }
  }
  return buffer;
}

export class OceanAudio {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly swell: GainNode;
  private readonly swellFilter: BiquadFilterNode;
  private readonly crests: GainNode;
  private readonly wind: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly rainHiss: GainNode;
  private readonly patter: GainNode;
  private readonly engine: GainNode;
  private readonly engineFilter: BiquadFilterNode;
  private readonly engineOsc: OscillatorNode[];
  private readonly rush: GainNode;
  private readonly white: AudioBuffer;
  private readonly brown: AudioBuffer;
  private gust = 0;
  private gustTarget = 0;
  private volume = 0;
  private closed = false;

  constructor() {
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    // A gentle limiter so a thunderclap on a stormy sea cannot clip.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 8;
    this.master.connect(limiter).connect(ctx.destination);

    this.white = noiseBuffer(ctx, 4, (w) => w);
    // Brown noise: integrated white, leaking back to zero.
    this.brown = noiseBuffer(ctx, 4, (w, last) => (last + 0.02 * w) / 1.02, 3.5);
    const loop = (buffer: AudioBuffer, offset = 0) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.start(0, offset);
      return src;
    };

    // The swell's wash: deep noise, opened up as the water moves.
    this.swellFilter = ctx.createBiquadFilter();
    this.swellFilter.type = "lowpass";
    this.swellFilter.frequency.value = 300;
    this.swell = ctx.createGain();
    this.swell.gain.value = 0;
    loop(this.brown).connect(this.swellFilter).connect(this.swell).connect(this.master);

    // Crests breaking: a band of hiss.
    const crestBand = ctx.createBiquadFilter();
    crestBand.type = "bandpass";
    crestBand.frequency.value = 2500;
    crestBand.Q.value = 0.6;
    this.crests = ctx.createGain();
    this.crests.gain.value = 0;
    loop(this.white, 1.3).connect(crestBand).connect(this.crests).connect(this.master);

    // Wind: low, gusting.
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = "bandpass";
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.8;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    loop(this.white, 2.1).connect(this.windFilter).connect(this.wind).connect(this.master);

    // Rain: hiss on the water and a patter of near drops.
    const rainHigh = ctx.createBiquadFilter();
    rainHigh.type = "highpass";
    rainHigh.frequency.value = 3000;
    this.rainHiss = ctx.createGain();
    this.rainHiss.gain.value = 0;
    loop(this.white, 0.7).connect(rainHigh).connect(this.rainHiss).connect(this.master);
    this.patter = ctx.createGain();
    this.patter.gain.value = 0;
    loop(patterBuffer(ctx, 3, 180)).connect(this.patter).connect(this.master);

    // The outboard: a buzzy note an octave pair, through a filter that opens with the throttle.
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 400;
    this.engine = ctx.createGain();
    this.engine.gain.value = 0;
    this.engineOsc = (["sawtooth", "square"] as OscillatorType[]).map((type, i) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 40;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.6 : 0.3;
      osc.connect(g).connect(this.engineFilter);
      osc.start();
      return osc;
    });
    this.engineFilter.connect(this.engine).connect(this.master);
    // Water rushing past the hull.
    const rushBand = ctx.createBiquadFilter();
    rushBand.type = "bandpass";
    rushBand.frequency.value = 900;
    rushBand.Q.value = 0.5;
    this.rush = ctx.createGain();
    this.rush.gain.value = 0;
    loop(this.white, 3.3).connect(rushBand).connect(this.rush).connect(this.master);
  }

  /** 0 to 1; 0 suspends the audio device. */
  setVolume(volume: number) {
    if (this.closed) return;
    const v = clamp01(volume);
    this.volume = v;
    if (v > 0 && this.ctx.state === "suspended") void this.ctx.resume();
    this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.15);
    if (v === 0) setTimeout(() => this.volume === 0 && !this.closed && void this.ctx.suspend(), 600);
  }

  update(dt: number, s: SoundInput) {
    if (this.closed) return;
    if (this.ctx.state !== "running") {
      // Safari "interrupts" audio for a call or another app and does not resume it on its own.
      if (this.volume > 0 && (this.ctx.state as string) === "interrupted") void this.ctx.resume().catch(() => {});
      return;
    }
    const now = this.ctx.currentTime;
    const ease = (p: AudioParam, v: number, tau = 0.25) => p.setTargetAtTime(v, now, tau);
    const sea = clamp01(s.hs / 3);
    // Near the water the wash follows each rise and fall; high above it blends into a steady roar.
    const near = Math.exp(-Math.max(0, s.height - 1.5) / 25);
    const motion = clamp01(Math.abs(s.heaveRate) / 1.2);
    ease(this.swell.gain, (0.15 + 0.5 * sea) * (0.45 + 0.55 * near * motion) * (0.6 + 0.4 * near));
    ease(this.swellFilter.frequency, 180 + 520 * motion * near + 150 * sea);
    const caps = clamp01((s.wind - 5) / 12);
    ease(this.crests.gain, 0.05 * sea + 0.22 * caps, 0.6);

    // Gusts: a new target every so often, eased toward.
    if (Math.random() < dt / 2.5) this.gustTarget = Math.random();
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 1.2));
    const windy = clamp01(s.wind / 18) * (0.6 + 0.4 * this.gust) * (0.7 + 0.3 * clamp01(s.height / 30));
    ease(this.wind.gain, 0.02 + 0.35 * windy, 0.4);
    ease(this.windFilter.frequency, 320 + 500 * windy, 0.4);

    ease(this.rainHiss.gain, 0.18 * s.rain, 1);
    ease(this.patter.gain, 0.5 * s.rain * near, 1);

    if (s.boat) {
      const near = 1 / (1 + s.boat.distance / 10);
      const load = clamp01(Math.abs(s.boat.throttle));
      const rpm = 750 + 5000 * load;
      // Six cylinders fire three times a revolution; the square an octave down gives the rasp.
      const f = (rpm / 60) * 3;
      this.engineOsc[0].frequency.setTargetAtTime(f, now, 0.3);
      this.engineOsc[1].frequency.setTargetAtTime(f / 2, now, 0.3);
      ease(this.engineFilter.frequency, 300 + 1800 * load, 0.3);
      ease(this.engine.gain, near * (0.05 + 0.12 * load));
      ease(this.rush.gain, near * 0.25 * clamp01(Math.abs(s.boat.speed) / 15));
    } else {
      ease(this.engine.gain, 0);
      ease(this.rush.gain, 0);
    }

    if (s.strike) this.thunder();
  }

  /** A strike a few kilometres off: the rumble arrives seconds after the flash. */
  private thunder() {
    const ctx = this.ctx;
    const delay = 1.5 + Math.random() * 5;
    const at = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.brown;
    // Looped, so a late start in the buffer still lasts the whole rumble.
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(900 / (1 + delay / 3), at);
    filter.frequency.exponentialRampToValueAtTime(90, at + 5);
    const gain = ctx.createGain();
    const loud = 1.6 / (1 + delay / 4);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(loud, at + 0.08);
    gain.gain.setTargetAtTime(loud * 0.5, at + 0.1, 0.5);
    gain.gain.setTargetAtTime(0, at + 1.5, 1.6);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(at, Math.random() * 3);
    src.stop(at + 9);
  }

  dispose() {
    this.closed = true;
    void this.ctx.close();
  }
}
