import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  serverExternalPackages: [],
};

// allow this host in development
if (process.env.NODE_ENV === 'development') {
  nextConfig.allowedDevOrigins = ['192.168.0.103'];
}

export default nextConfig;


