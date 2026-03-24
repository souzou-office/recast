import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@anthropic-ai/sdk"],
  devIndicators: false,
};

export default nextConfig;
