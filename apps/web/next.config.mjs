import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the monorepo root so Next doesn't guess from a stray parent lockfile.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  // Workspace packages ship TypeScript source; Next compiles them.
  transpilePackages: ["@vlogbuddy/shared", "@vlogbuddy/db"],
  experimental: {
    serverActions: {
      // Only metadata flows through server actions — media goes straight to S3.
      bodySizeLimit: "4mb",
    },
  },
  images: {
    // Thumbnails come from the storage endpoint via presigned URLs.
    remotePatterns: [{ protocol: "https", hostname: "**" }, { protocol: "http", hostname: "**" }],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
