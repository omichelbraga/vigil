import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["argon2"],
  allowedDevOrigins: ["192.168.9.113"],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },

};

export default nextConfig;
