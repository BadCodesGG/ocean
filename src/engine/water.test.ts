import { describe, expect, it } from "vitest";
import { FRAGMENT } from "./water";

describe("water shader", () => {
  it("takes the haze colour along a fixed elevation from a blurred sky level", () => {
    // The sky bake's top level carries the march's per-pixel jitter; one row of it, stretched down
    // a fogged sea, draws vertical streaks. Every lookup pinned to one elevation must blur it out.
    const pinned = [...FRAGMENT.matchAll(/skyAt\(normalize\(vec3\([^,]+,\s*(0\.\d+),[^)]*\)\),\s*([\d.]+)\)/g)];
    expect(pinned.length).toBeGreaterThan(0);
    for (const [call, , lod] of pinned) expect(Number(lod), call).toBeGreaterThanOrEqual(3);
  });
});
