/**
 * The CDIP buoys the scene can be set at: live stations with a directional Waverider and a clean
 * displacement feed. The route answers only these, so a request can never reach CDIP for anything else.
 */

export interface Station {
  id: string;
  /** Short name for the picker; CDIP's own long name comes with the data. */
  name: string;
  region: string;
  /** IANA zone the local times are shown in. */
  timeZone: string;
  /**
   * Compass bearing the resting camera faces; by default the peak direction of the waves. Set only
   * where land stands clear of the horizon from the buoy, so the coast is in frame: chosen by eye
   * from the elevation tiles' land profile and a screenshot, keeping the highest land in the frame
   * with open sea beside it.
   */
  facing?: number;
  /** What is in the water, which sets its colour: see SEA in the water shader. */
  sea: Sea;
}

/**
 * clear: the blue of open, nutrient-poor ocean (Hawaiʻi).
 * coastal: shelf water with more plankton, blue-green (southern California, the Atlantic coast).
 * green: cold upwelling rich in plankton, grey-green (northern California to Washington).
 */
export type Sea = "clear" | "coastal" | "green";

export const STATIONS: readonly Station[] = [
  // Faces SW along the North Shore to the Waiʻanae range; the evening sun comes in from the right.
  { id: "106p1", name: "Waimea Bay", region: "Oʻahu", timeZone: "Pacific/Honolulu", facing: 225, sea: "clear" },
  { id: "238p1", name: "Barbers Point", region: "Oʻahu", timeZone: "Pacific/Honolulu", facing: 355, sea: "clear" },
  { id: "098p1", name: "Mokapu Point", region: "Oʻahu", timeZone: "Pacific/Honolulu", facing: 270, sea: "clear" },
  { id: "202p1", name: "Hanalei", region: "Kauaʻi", timeZone: "Pacific/Honolulu", facing: 225, sea: "clear" },
  { id: "187p1", name: "Pauwela", region: "Maui", timeZone: "Pacific/Honolulu", facing: 192, sea: "clear" },
  { id: "188p1", name: "Hilo", region: "Hawaiʻi Island", timeZone: "Pacific/Honolulu", facing: 296, sea: "clear" },
  // No facing where no land shows from the water (the coast too far, too low, or a sliver lost in
  // the haze): Point Reyes, San Nicolas Island, Torrey Pines, Umpqua, Grays Harbor, Oregon Inlet
  // and Fernandina Beach face the swell.
  { id: "029p1", name: "Point Reyes", region: "California", timeZone: "America/Los_Angeles", sea: "green" },
  { id: "071p1", name: "Harvest", region: "California", timeZone: "America/Los_Angeles", facing: 40, sea: "green" },
  { id: "067p1", name: "San Nicolas Island", region: "California", timeZone: "America/Los_Angeles", sea: "coastal" },
  { id: "028p1", name: "Santa Monica Bay", region: "California", timeZone: "America/Los_Angeles", facing: 335, sea: "coastal" },
  { id: "100p1", name: "Torrey Pines Outer", region: "California", timeZone: "America/Los_Angeles", sea: "coastal" },
  { id: "139p1", name: "Umpqua Offshore", region: "Oregon", timeZone: "America/Los_Angeles", sea: "green" },
  { id: "036p1", name: "Grays Harbor", region: "Washington", timeZone: "America/Los_Angeles", sea: "green" },
  { id: "192p1", name: "Oregon Inlet", region: "North Carolina", timeZone: "America/New_York", sea: "coastal" },
  { id: "132p1", name: "Fernandina Beach", region: "Florida", timeZone: "America/New_York", sea: "coastal" },
];

export const DEFAULT_STATION = STATIONS[0];

export function stationById(id: string): Station | undefined {
  return STATIONS.find((s) => s.id === id);
}

/** A station's name as a URL segment: "Torrey Pines Outer" is `torrey-pines-outer`. */
export function slug(station: Station): string {
  return station.name
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u02bb\u02bc']/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function stationBySlug(segment: string): Station | undefined {
  return STATIONS.find((s) => slug(s) === segment);
}

/** Where a station's page is: the default station is the home page, every other one is its name. */
export function stationPath(station: Station): string {
  return station.id === DEFAULT_STATION.id ? "/" : `/${slug(station)}`;
}

/**
 * Old and alternative addresses, sent on for good: each station's CDIP id (the pages were once
 * addressed by it), and the default station's own name, which is the home page.
 */
export function stationRedirects(): { source: string; destination: string; permanent: true }[] {
  return [
    ...STATIONS.map((s) => ({ source: `/${s.id}`, destination: stationPath(s), permanent: true as const })),
    { source: `/${slug(DEFAULT_STATION)}`, destination: "/", permanent: true as const },
  ];
}
