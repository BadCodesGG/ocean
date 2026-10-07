import { describe, expect, it, vi } from "vitest";
// next/font only exists inside the Next build; the layout needs it to load.
vi.mock("next/font/google", () => ({ Geist: () => ({ variable: "" }), Geist_Mono: () => ({ variable: "" }) }));

import { metadata as layoutMetadata } from "@/app/layout";
import { metadata as homeMetadata } from "@/app/page";
import { generateMetadata as stationMetadata } from "@/app/[station]/page";
import { OG_IMAGE, pageMetadata, SITE_URL } from "./site";
import { DEFAULT_STATION, slug, STATIONS, stationPath } from "./stations";

function expectShareImage(m: Awaited<ReturnType<typeof stationMetadata>>) {
  expect(m.openGraph?.images).toEqual([OG_IMAGE]);
  expect(m.twitter?.images).toEqual([OG_IMAGE.url]);
  expect(OG_IMAGE.url).toBe("/og.jpg");
}

describe("share metadata", () => {
  it("is anchored to the https custom domain", () => {
    expect(SITE_URL).toBe("https://ocean.badcodes.dev");
    expect(String(layoutMetadata.metadataBase)).toBe("https://ocean.badcodes.dev/");
  });

  it("gives the root layout and the home route the share image", () => {
    expectShareImage(layoutMetadata);
    expectShareImage(homeMetadata);
    expect(homeMetadata.openGraph).toMatchObject({ title: "Ocean", url: "/" });
  });

  it("gives every station route the share image, its own title, description and address", async () => {
    for (const station of STATIONS.filter((s) => s !== DEFAULT_STATION)) {
      const m = await stationMetadata({ params: Promise.resolve({ station: slug(station) }) } as never);
      expectShareImage(m);
      expect(m.openGraph).toMatchObject({
        title: `Ocean · ${station.name}`,
        url: stationPath(station),
        description: `The sea at ${station.name}, rebuilt live from what its wave buoy measured.`,
      });
      expect(m.twitter).toMatchObject({ card: "summary_large_image", title: `Ocean · ${station.name}` });
      expect(m.alternates?.canonical).toBe(stationPath(station));
    }
  });

  it("pageMetadata carries the image and its own title, never the layout's", () => {
    const m = pageMetadata({ title: "T", description: "D", path: "/p" });
    expect(m.openGraph).toMatchObject({ type: "website", siteName: "Ocean", title: "T", description: "D", url: "/p" });
    expectShareImage(m);
  });
});
