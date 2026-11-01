import type { NextConfig } from "next";

const api = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  typescript: { tsconfigPath: process.env.NEXT_TSCONFIG_PATH || "tsconfig.json" },
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: `${api}/auth/:path*` },
      { source: "/me", destination: `${api}/me` },
      { source: "/folders", destination: `${api}/folders` },
      { source: "/folders/:path*", destination: `${api}/folders/:path*` },
      // /projects itself is the projects page, so the project API lives under /api.
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/images/:path*", destination: `${api}/images/:path*` },
      { source: "/annotations/:path*", destination: `${api}/annotations/:path*` },
      { source: "/jobs", destination: `${api}/jobs` },
      { source: "/jobs/:path*", destination: `${api}/jobs/:path*` },
      { source: "/patches/:path*", destination: `${api}/patches/:path*` },
      { source: "/health", destination: `${api}/health` },
    ];
  },
};

export default nextConfig;
