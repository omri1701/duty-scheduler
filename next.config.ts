import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { LOCAL_PROXY_PATHS, configuredDevOrigin, configuredLocalTunnel } from "./lib/supabase/environment.ts";

const devOrigin = configuredDevOrigin(process.env);
// Exists only under `next dev` for the explicit LOCAL phone launcher; forwards
// Auth/REST paths to the loopback LOCAL API and nothing else.
const localTunnel = configuredLocalTunnel(process.env);
const tunnelOrigin = devOrigin ?? localTunnel?.origin;

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    '/api/solver-spike/asset/*': ['./node_modules/highs/build/highs.mjs', './node_modules/highs/build/highs.wasm', './node_modules/highs/LICENSE'],
    '/api/scheduling/asset/*': ['./node_modules/highs/build/highs.mjs', './node_modules/highs/build/highs.wasm', './node_modules/highs/LICENSE'],
  },
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  // Vercel restored pre-PR #22 CSS despite receiving the updated source.
  // Port 5173 also served old CSS beside current JSX. Do not persist transforms;
  // source fingerprints verify both the served development CSS and build output.
  experimental: { turbopackFileSystemCacheForBuild: false, turbopackFileSystemCacheForDev: false },
  ...(tunnelOrigin ? { allowedDevOrigins: [new URL(tunnelOrigin).hostname] } : {}),
  ...(localTunnel ? { rewrites: async () => LOCAL_PROXY_PATHS.map(path => ({ source: `${path}/:path*`, destination: `${localTunnel.api}${path}/:path*` })) } : {}),
};

export default nextConfig;
