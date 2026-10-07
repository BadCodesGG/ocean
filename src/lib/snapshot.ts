import type { BuoySnapshot } from "./cdip";
import type { Weather } from "./weather";

/** What `/api/buoy/[station]` returns. */
export type BuoyResponse = BuoySnapshot & { weather: Weather | null };
