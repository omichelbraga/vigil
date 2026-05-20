import type { NextConfig } from "next";

const devOrigins = process.env.NEXT_ALLOWED_DEV_ORIGINS
  ? process.env.NEXT_ALLOWED_DEV_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean)
  : [];

const nextConfig: NextConfig = {
  // Standalone output is incompatible with our custom server (server.ts) —
  // standalone bakes Next.js's own server.js entrypoint and only traces what
  // it imports, so libs that server.ts pulls in (ws-server, cert-monitor,
  // expiry-monitor, rollout-runner) get dropped. We run server.ts directly
  // via tsx in production instead, with the full project + node_modules
  // available at runtime.
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
