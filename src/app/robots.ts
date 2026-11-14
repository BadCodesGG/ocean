import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** Crawlers may read every page; the API routes only proxy the live buoy and weather feeds. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/api/" },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
