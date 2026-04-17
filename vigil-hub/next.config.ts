import type { NextConfig } from "next";

const devOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS
  ? process.env.NEXT_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["argon2"],
  allowedDevOrigins: devOrigins,
  experimental: {
    // Next clamps cloneable request bodies (what middleware/route handlers
    // read from) to 10 MB by default. Agent binaries are 20-30 MB, so we
    // lift the cap to 250 MB. The agent-releases upload route enforces a
    // stricter 200 MB ceiling as it streams bytes to disk.
    proxyClientMaxBodySize: "250mb",
  },
};

export default nextConfig;
