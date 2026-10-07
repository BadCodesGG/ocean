import { describe, expect, it } from "vitest";
import { MIN_SCALE, pickQuality, ResolutionGovernor } from "./quality";

describe("pickQuality", () => {
  it("draws little on a software renderer", () => {
    expect(pickQuality({ gpu: "Google SwiftShader", coarse: false, cores: 16 })).toBe("low");
  });

  it("gives a discrete desktop GPU high, never max", () => {
    expect(pickQuality({ gpu: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11)", coarse: false, cores: 16, memory: 8 })).toBe("high");
  });

  it("gives integrated graphics medium, but not Intel Arc", () => {
    expect(pickQuality({ gpu: "ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11)", coarse: false, cores: 8 })).toBe("medium");
    expect(pickQuality({ gpu: "ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics Direct3D11)", coarse: false, cores: 8 })).toBe("high");
  });

  it("gives phones medium, and weak phones low", () => {
    expect(pickQuality({ gpu: "Apple GPU", coarse: true, cores: 6, memory: 8 })).toBe("medium");
    expect(pickQuality({ gpu: "Adreno (TM) 610", coarse: true, cores: 4, memory: 3 })).toBe("low");
  });
});

describe("ResolutionGovernor", () => {
  /** Frames for `seconds`, each taking `frame(scale)`: the drawing's cost at the governor's current scale. */
  const run = (g: ResolutionGovernor, frame: (scale: number) => number, seconds: number) => {
    let changes = 0;
    for (let t = 0; t < seconds; ) {
      const dt = frame(g.scale);
      if (g.sample(dt)) changes++;
      t += dt;
    }
    return changes;
  };
  /** Fill-bound drawing: frame time follows the pixels drawn, the scale squared. */
  const gpu = (full: number) => (scale: number) => Math.max(1 / 60, full * scale * scale);
  const fixed = (dt: number) => () => dt;

  it("holds full resolution at 60 fps", () => {
    const g = new ResolutionGovernor();
    expect(run(g, fixed(1 / 60), 30)).toBe(0);
    expect(g.scale).toBe(1);
  });

  it("steps down under sustained slow frames, no lower than the floor", () => {
    const g = new ResolutionGovernor();
    run(g, gpu(1 / 30), 3);
    expect(g.scale).toBeLessThan(1);
    run(g, gpu(1 / 5), 120);
    expect(g.scale).toBe(MIN_SCALE);
  });

  it("settles where the frames come back up to speed", () => {
    const g = new ResolutionGovernor();
    run(g, gpu(1 / 30), 60);
    expect(g.scale).toBeLessThan(0.85);
    expect(gpu(1 / 30)(g.scale)).toBeLessThan(1 / 45);
  });

  it("gives back a step that buys no frames, and stops trying: a 30 Hz power mode, not slow drawing", () => {
    const g = new ResolutionGovernor();
    run(g, fixed(1 / 30), 60);
    expect(g.scale).toBe(1);
  });

  it("ignores a single hitch and stalls", () => {
    const g = new ResolutionGovernor();
    run(g, fixed(1 / 60), 2);
    g.sample(0.1);
    g.sample(2);
    run(g, fixed(1 / 60), 2);
    expect(g.scale).toBe(1);
  });

  it("climbs back once frames are fast again", () => {
    const g = new ResolutionGovernor();
    run(g, gpu(1 / 30), 5);
    const low = g.scale;
    run(g, fixed(1 / 60), 30);
    expect(low).toBeLessThan(1);
    expect(g.scale).toBe(1);
  });
});
