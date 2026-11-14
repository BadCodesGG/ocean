import { describe, expect, it } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";
import { SITE_URL } from "@/lib/site";
import { STATIONS, stationPath } from "@/lib/stations";

describe("robots.txt", () => {
  it("allows the pages, keeps crawlers off the API proxies and points at the sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/api/" },
      sitemap: "https://ocean.badcodes.dev/sitemap.xml",
    });
  });
});

describe("sitemap.xml", () => {
  it("lists the home page and every station route once, on the custom domain", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toHaveLength(STATIONS.length);
    expect(new Set(urls).size).toBe(urls.length);
    expect(urls).toContain(`${SITE_URL}/`);
    for (const station of STATIONS) expect(urls).toContain(`${SITE_URL}${stationPath(station)}`);
    expect(urls.every((url) => url.startsWith("https://ocean.badcodes.dev/"))).toBe(true);
  });
});
