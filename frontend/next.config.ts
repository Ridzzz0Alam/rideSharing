import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produces a minimal server bundle for the Docker image.
  output: "standalone",
  typedRoutes: true,
};

export default nextConfig;
