import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: [
    'better-sqlite3',
    'onnxruntime-node',
    'sqlite-vec',
    'pino',
    'pino-pretty',
  ],
  // VRM models can be up to 50MB — allow large uploads
  experimental: {
    serverActions: {
      bodySizeLimit: '50mb',
    },
  },
};

export default nextConfig;
