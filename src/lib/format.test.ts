import { describe, expect, it } from "vitest";
import { compass } from "./format";

describe("compass", () => {
  it.each([
    [0, "N"],
    [276, "W"],
    [292.5, "WNW"],
    [359, "N"],
    [-90, "W"],
  ])("%f is %s", (deg, name) => expect(compass(deg)).toBe(name));
});

