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
    ];
  },
  async redirects() {
    return stationRedirects();
  },
};

export default nextConfig;
