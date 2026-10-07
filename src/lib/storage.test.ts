import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyKeys } from "./storage";

describe("migrateLegacyKeys", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubStorage(initial: Record<string, string>) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    return store;
  }

  it("moves each old swell- setting to its ocean- key and removes the old one", () => {
    const store = stubStorage({
      "swell-camera": "orbit",
      "swell-boat": "skiff",
      "swell-quality": "high",
      "swell-volume": "0.3",
      "swell-look": '{"lightAt":1090}',
    });
    migrateLegacyKeys();
    expect(Object.fromEntries(store)).toEqual({
      "ocean-camera": "orbit",
      "ocean-boat": "skiff",
      "ocean-quality": "high",
      "ocean-volume": "0.3",
      "ocean-look": '{"lightAt":1090}',
    });
  });

  it("keeps a value already saved under the new key and still drops the old one", () => {
    const store = stubStorage({ "swell-camera": "orbit", "ocean-camera": "fly" });
    migrateLegacyKeys();
    expect(Object.fromEntries(store)).toEqual({ "ocean-camera": "fly" });
  });

  it("does nothing when there is nothing to move, and survives blocked storage", () => {
    const store = stubStorage({});
    migrateLegacyKeys();
    expect(store.size).toBe(0);
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); } } });
    expect(() => migrateLegacyKeys()).not.toThrow();
  });
});
