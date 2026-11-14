import type { MetadataRoute } from "next";
import { canonicalUrl } from "@/lib/site";

/**
 * Crawlers may read everything. The API routes stay open on purpose: the station pages draw from
 * /api/buoy and /api/stations in the browser, so a crawler that renders a page needs them too.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: canonicalUrl("/sitemap.xml"),
  };
}
