import type { Metadata } from "next";

/** The production custom domain, a literal: a relative or deployment URL makes Slack and Facebook drop the image. */
export const SITE_URL = "https://ocean.badcodes.dev";
export const SITE_NAME = "Ocean";
export const SITE_DESCRIPTION = "The sea off Waimea Bay, rebuilt live from what buoy 106 measured.";

export const OG_IMAGE = {
  url: "/og.jpg",
  width: 1200,
  height: 630,
  alt: "A live 3D ocean at golden hour, rebuilt from real wave-buoy measurements.",
};

/**
 * Metadata for one route. Next replaces a layout's `openGraph` and `twitter` wholesale when a route
 * declares its own, so a route that set only its title would otherwise lose the image or carry the
 * layout's title. `path` is relative to `SITE_URL` (the root layout sets `metadataBase`).
 */
export function pageMetadata({ title, description, path }: { title: string; description: string; path: string }): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { type: "website", siteName: SITE_NAME, title, description, url: path, images: [OG_IMAGE] },
    twitter: { card: "summary_large_image", title, description, images: [OG_IMAGE.url] },
  };
}
