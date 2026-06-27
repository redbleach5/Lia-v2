import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: [
    'better-sqlite3',
    'onnxruntime-node',
    'sqlite-vec',
  ],
};

export default nextConfig;
