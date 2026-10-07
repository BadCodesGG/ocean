/** Where each of the viewer's saved settings lives in localStorage. The one place these names are spelled. */
export const SETTING_KEYS = {
  camera: "ocean-camera",
  boat: "ocean-boat",
  quality: "ocean-quality",
  volume: "ocean-volume",
  look: "ocean-look",
} as const;

/** Before the product became Ocean, the same settings were saved under "swell-" keys. */
const legacyKey = (name: keyof typeof SETTING_KEYS) => `swell-${name}`;

/**
 * Moves each "swell-<name>" setting to its key in SETTING_KEYS once, so a returning viewer keeps their
 * choices. A value already saved under the new key wins; the old key is removed either way. Run before
 * any setting is read.
 */
export function migrateLegacyKeys() {
  try {
    const storage = window.localStorage;
    for (const [name, key] of Object.entries(SETTING_KEYS) as [keyof typeof SETTING_KEYS, string][]) {
      const old = storage.getItem(legacyKey(name));
      if (old === null) continue;
      if (storage.getItem(key) === null) storage.setItem(key, old);
      storage.removeItem(legacyKey(name));
    }
  } catch {
    // Blocked storage: nothing was saved to carry over.
  }
}
