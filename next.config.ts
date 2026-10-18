import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { configuredDevOrigin } from "./lib/supabase/environment.ts";

const devOrigin = configuredDevOrigin(process.env);

const nextConfig: NextConfig = {
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Vercel restored pre-PR #22 CSS despite receiving the updated source.
  // Port 5173 also served old CSS beside current JSX. Do not persist transforms;
  // source fingerprints verify both the served development CSS and build output.
  experimental: { turbopackFileSystemCacheForBuild: false, turbopackFileSystemCacheForDev: false },
  ...(devOrigin ? { allowedDevOrigins: [new URL(devOrigin).hostname] } : {}),
};

export default nextConfig;
