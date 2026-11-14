import type { NextConfig } from "next";
import { stationRedirects } from "./src/lib/stations";

const nextConfig: NextConfig = {
  // The badge sits where the scene's label goes.
  devIndicators: false,
  // Only badcodes.dev may frame the site (the portfolio embeds it, click to load, on its project
  // page); every other site is refused.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'self' https://badcodes.dev https://www.badcodes.dev" }],
      },
      {
        // The same deployment also answers on its *.vercel.app aliases. Those copies stay out of
        // search results, so the custom domain is the only one a crawler indexes.
        source: "/:path*",
        missing: [{ type: "host", value: "ocean.badcodes.dev" }],
        headers: [{ key: "X-Robots-Tag", value: "noindex" }],
      },
    ];
  },
  async redirects() {
    return stationRedirects();
  },
};

export default nextConfig;
