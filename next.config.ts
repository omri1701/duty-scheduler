import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { configuredDevOrigin } from "./lib/supabase/environment.ts";

const devOrigin = configuredDevOrigin(process.env);

const nextConfig: NextConfig = {
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
  ...(devOrigin ? { allowedDevOrigins: [new URL(devOrigin).hostname] } : {}),
};

export default nextConfig;
