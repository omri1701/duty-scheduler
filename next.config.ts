import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { configuredDevOrigin } from "./lib/supabase/environment.ts";

const devOrigin = configuredDevOrigin(process.env);

const nextConfig: NextConfig = {
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Vercel restored pre-PR #22 CSS despite receiving the updated source.
  // Recompute production transforms; the emitted-CSS gate also rejects stale output.
  experimental: { turbopackFileSystemCacheForBuild: false },
  ...(devOrigin ? { allowedDevOrigins: [new URL(devOrigin).hostname] } : {}),
};

export default nextConfig;
