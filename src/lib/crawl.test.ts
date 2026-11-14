import { describe, expect, it, vi } from "vitest";
// next/font only exists inside the Next build; the layout needs it to load.
vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) }));

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { metadata as homeMetadata } from "@/app/page";
import { generateMetadata as stationMetadata, generateStaticParams } from "@/app/[station]/page";
import { canonicalUrl } from "./site";

describe("robots.txt", () => {
  it("blocks nothing, so a rendering crawler can fetch the API routes the pages draw from", () => {
    const rules = [robots().rules].flat();
    expect(rules).toHaveLength(1);
    expect(rules[0].userAgent).toBe("*");
    expect(rules[0].disallow ?? []).toEqual([]);
  });

  it("points at the sitemap on the custom domain", () => {
    expect(robots().sitemap).toBe("https://ocean.badcodes.dev/sitemap.xml");
  });
});

describe("sitemap.xml", () => {
  it("lists exactly the routes the app builds: the home page and each station page", () => {
    const paths = sitemap().map((entry) => new URL(entry.url).pathname);
    const built = ["/", ...generateStaticParams().map((p) => `/${p.station}`)];
    expect([...paths].sort()).toEqual([...built].sort());
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("spells each URL as that page's rendered canonical link", async () => {
    const canonicals = [canonicalUrl(String(homeMetadata.alternates?.canonical))];
    for (const params of generateStaticParams()) {
      const m = await stationMetadata({ params: Promise.resolve(params) } as never);
      canonicals.push(canonicalUrl(String(m.alternates?.canonical)));
    }
    expect(sitemap().map((entry) => entry.url).sort()).toEqual(canonicals.sort());
    expect(canonicalUrl("/")).toBe("https://ocean.badcodes.dev");
    expect(canonicalUrl("/mokapu-point")).toBe("https://ocean.badcodes.dev/mokapu-point");
  });
});
