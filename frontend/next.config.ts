import type { NextConfig } from "next";

const api = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  transpilePackages: ["@annotorious/react", "@annotorious/annotorious", "@annotorious/core"],
  async rewrites() {
    return [
      { source: "/auth/:path*", destination: `${api}/auth/:path*` },
      { source: "/me", destination: `${api}/me` },
      { source: "/jobs", destination: `${api}/jobs` },
      { source: "/jobs/:path*", destination: `${api}/jobs/:path*` },
      { source: "/patches/:path*", destination: `${api}/patches/:path*` },
      { source: "/health", destination: `${api}/health` },
    ];
  },
};

export default nextConfig;
