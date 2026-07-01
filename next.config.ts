import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  // Указываем workspace root явно — иначе Next.js warns:
  // "We detected multiple lockfiles and selected the directory of /Users/ruslan/bun.lock as the root directory"
  // Это происходит, когда у пользователя в родительских директориях лежат чужие bun.lock
  // (например ~/bun.lock). Указывая __dirname, говорим Next: "наш проект — здесь".
  outputFileTracingRoot: path.resolve(__dirname),
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
    // Next.js 16 proxy (formerly middleware) clones the request body for
    // potential re-reading. Default limit is 10MB — anything bigger gets
    // truncated, which breaks `req.formData()` in the upload-vrm route
    // (TypeError: Failed to parse body as FormData).
    // `middlewareClientMaxBodySize` is the deprecated old name; the runtime
    // reads `proxyClientMaxBodySize` (see next-server.js / resolve-routes.js).
    proxyClientMaxBodySize: '50mb',
  },
};

export default nextConfig;
