import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { toDirection } from "./ephemeris";
import { HORIZON_LOD, SKY_LOOKUP_GLSL, sunRadiance } from "./sky";

const sunDirection = (azimuth: number, elevation: number) => toDirection({ azimuth, elevation });

describe("sunRadiance", () => {
  it("is nearly white at noon and deep orange at dusk", () => {
    const noon = sunRadiance(sunDirection(180, 80));
    const dusk = sunRadiance(sunDirection(267, 2.5));
    expect(noon[2] / noon[0]).toBeGreaterThan(0.6);
    expect(dusk[2] / dusk[0]).toBeLessThan(0.15);
    expect(dusk[0]).toBeLessThan(noon[0]);
  });
});

describe("horizon colour", () => {
  // The bake's top level carries the march's per-pixel jitter. A lookup pinned to one elevation reads
  // a single row of it for a whole fogged sea or hillside, which draws as vertical streaks.
  it("comes from a blurred level of the bake", () => {
    const [, lod] = SKY_LOOKUP_GLSL.match(/vec3 horizonAt[\s\S]*?textureLod\(bake,[\s\S]*?\),\s*([\d.]+)\)\.rgb/) ?? [];
    expect(Number(lod)).toBe(HORIZON_LOD);
    expect(HORIZON_LOD).toBeGreaterThanOrEqual(3);
  });

  it("is never read from a pinned row of the sharp levels outside horizonAt", () => {
    const dir = dirname(fileURLToPath(import.meta.url));
    const pinned = /(?:skyAt|skyUv)\(normalize\(vec3\([^,()]+,\s*0\.\d+,[^)]*\)\)(?:,\s*([\d.]+)\))?/g;
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      for (const m of readFileSync(join(dir, file), "utf8").matchAll(pinned)) {
        // A level that follows the surface's roughness (skyAt(..., skyLod + 1.0)) varies per pixel.
        const literal = m[1] === undefined ? !m[0].startsWith("skyAt") : Number(m[1]) < HORIZON_LOD;
        if (literal) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
