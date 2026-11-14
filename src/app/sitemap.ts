import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { STATIONS, stationPath } from "@/lib/stations";

/**
 * One entry per station page: the default station is the home page, every other station has its own
 * route. The pages draw live data, so there is no meaningful last-modified date to give.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return STATIONS.map((station) => ({ url: `${SITE_URL}${stationPath(station)}` }));
}
